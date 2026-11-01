// Word timing: map recognised (timed) words back onto the lyric lines, with model-free
// fallbacks. Port of maker/src/jojos_karaoke/align.py; keep the two in step.

import type { Line, Lyrics, Word } from '$shared/lyrics';
import type { LyricLine } from './lyricsInput';

export const MIN_WORD_MS = 80;
export const LOW_CONFIDENCE = 0.35;
const ALNUM = /[\p{L}\p{N}]/u;

export interface TimedWord { text: string; start: number; end: number; score: number }

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const tok of text.split(/\s+/).filter(Boolean)) {
    if (!ALNUM.test(tok)) { if (out.length) out[out.length - 1] += ` ${tok}`; }
    else out.push(tok);
  }
  return out;
}

export function norm(w: string): string {
  return w.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]/gu, '');
}

type Op = { tag: 'equal' | 'replace' | 'delete' | 'insert'; i1: number; i2: number; j1: number; j2: number };

/** Opcodes from a longest-common-subsequence alignment of a and b. */
export function opcodes(a: string[], b: string[]): Op[] {
  const n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) i++;
    else j++;
  }
  const ops: Op[] = [];
  let pi = 0, pj = 0;
  const gap = (i: number, j: number) => {
    if (i > pi || j > pj) ops.push({ tag: i > pi && j > pj ? 'replace' : i > pi ? 'delete' : 'insert', i1: pi, i2: i, j1: pj, j2: j });
  };
  for (const [i, j] of pairs) {
    gap(i, j);
    const last = ops[ops.length - 1];
    if (last?.tag === 'equal' && last.i2 === i && last.j2 === j) { last.i2++; last.j2++; }
    else ops.push({ tag: 'equal', i1: i, i2: i + 1, j1: j, j2: j + 1 });
    pi = i + 1; pj = j + 1;
  }
  gap(n, m);
  return ops;
}

export function matchWords(tokens: string[], aligned: TimedWord[]): (TimedWord | null)[] {
  if (tokens.length === aligned.length) return [...aligned];
  const out: (TimedWord | null)[] = new Array(tokens.length).fill(null);
  for (const { tag, i1, i2, j1, j2 } of opcodes(tokens.map(norm), aligned.map((w) => norm(w.text)))) {
    if (tag === 'equal' || (tag === 'replace' && i2 - i1 === j2 - j1)) {
      for (let k = 0; k < i2 - i1; k++) out[i1 + k] = aligned[j1 + k];
    } else if (tag === 'replace') {
      const s = aligned[j1].start, e = aligned[j2 - 1].end;
      const sc = Math.min(...aligned.slice(j1, j2).map((w) => w.score)) * 0.5;
      const n = i2 - i1;
      for (let k = 0; k < n; k++) {
        out[i1 + k] = { text: tokens[i1 + k], start: s + Math.floor(((e - s) * k) / n), end: s + Math.floor(((e - s) * (k + 1)) / n), score: sc };
      }
    }
  }
  return out;
}

export function distribute(tokens: string[], start: number, end: number, low = false): Word[] {
  if (!tokens.length) return [];
  end = Math.max(end, start + MIN_WORD_MS * tokens.length);
  const weights = tokens.map((t) => Math.max(1, norm(t).length) + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  return tokens.map((t, i) => {
    const s = start + Math.floor(((end - start) * acc) / total);
    acc += weights[i];
    const e = start + Math.floor(((end - start) * acc) / total);
    return low ? { t, s, e, lowConfidence: true } : { t, s, e };
  });
}

function fillGaps(tokens: string[], timed: (TimedWord | null)[], lo: number, hi: number): Word[] {
  const words: Word[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tw = timed[i];
    if (tw) {
      words.push(tw.score < LOW_CONFIDENCE ? { t: tokens[i], s: tw.start, e: tw.end, lowConfidence: true } : { t: tokens[i], s: tw.start, e: tw.end });
      i++;
      continue;
    }
    let j = i;
    while (j < tokens.length && !timed[j]) j++;
    const s = words.length ? words[words.length - 1].e : lo;
    let e = j < tokens.length ? timed[j]!.start : hi;
    if (e - s < MIN_WORD_MS * (j - i)) e = s + MIN_WORD_MS * (j - i);
    words.push(...distribute(tokens.slice(i, j), s, e, true));
    i = j;
  }
  return words;
}

export function fixMonotonic(words: Word[], durationMs?: number): Word[] {
  let prev = 0;
  for (const w of words) {
    w.s = Math.round(Math.max(w.s, prev));
    w.e = Math.round(Math.max(w.e, w.s + MIN_WORD_MS));
    prev = w.e;
  }
  if (durationMs) for (const w of words) {
    w.s = Math.min(w.s, durationMs - 1);
    w.e = Math.min(w.e, durationMs);
    if (w.e <= w.s) w.e = w.s + 1;
  }
  return words;
}

function toLyrics(lines: Line[]): Lyrics {
  for (const ln of lines) { ln.start = ln.words[0].s; ln.end = ln.words[ln.words.length - 1].e; }
  return { version: 1, lines: lines.filter((l) => l.words.length) };
}

export function assemble(lines: LyricLine[], aligned: TimedWord[], durationMs: number): Lyrics {
  const per = lines.map((l) => tokenize(l.text));
  const flat = per.flat();
  const words = fixMonotonic(fillGaps(flat, matchWords(flat, aligned), 0, durationMs), durationMs);
  const out: Line[] = [];
  let k = 0;
  per.forEach((toks, i) => {
    if (toks.length) out.push({ start: 0, end: 0, words: words.slice(k, k + toks.length), ...(lines[i].singer ? { singer: lines[i].singer } : {}) });
    k += toks.length;
  });
  return toLyrics(out);
}

export function fromLrcTimings(lines: LyricLine[], durationMs: number): Lyrics {
  const out: Line[] = [];
  lines.forEach((ln, i) => {
    const toks = tokenize(ln.text);
    if (!toks.length || ln.start == null) return;
    const nxt = lines.slice(i + 1).find((x) => x.start != null && x.start > ln.start!)?.start ?? durationMs;
    const end = Math.min(nxt, ln.start + 1000 + 500 * toks.length);
    let words: Word[];
    if (ln.wordTimes && ln.wordTimes.length === toks.length && ln.wordTimes.every((t) => t >= 0)) {
      const wt = [...ln.wordTimes, end];
      words = toks.map((t, k) => ({ t, s: wt[k], e: Math.max(wt[k + 1], wt[k] + MIN_WORD_MS) }));
    } else words = distribute(toks, ln.start, end);
    out.push({ start: 0, end: 0, words, ...(ln.singer ? { singer: ln.singer } : {}) });
  });
  fixMonotonic(out.flatMap((l) => l.words), durationMs);
  return toLyrics(out);
}

function percentile(sorted: Float64Array, p: number) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))];
}

export function voicedRegions(x: Float32Array, sr: number, hopMs = 20, minGapMs = 600, minLenMs = 300): [number, number][] {
  const hop = Math.max(1, Math.floor((sr * hopMs) / 1000));
  const n = Math.floor(x.length / hop);
  if (!n) return [];
  const db = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = i * hop; k < (i + 1) * hop; k++) s += x[k] * x[k];
    db[i] = 20 * Math.log10(Math.sqrt(s / hop + 1e-12));
  }
  const sorted = Float64Array.from(db).sort();
  const thr = Math.max(percentile(sorted, 95) - 30, percentile(sorted, 30) + 6);
  const regions: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= n; i++) {
    const on = i < n && db[i] > thr;
    if (on && start < 0) start = i;
    else if (!on && start >= 0) { regions.push([start * hopMs, i * hopMs]); start = -1; }
  }
  const merged: [number, number][] = [];
  for (const r of regions) {
    if (merged.length && r[0] - merged[merged.length - 1][1] < minGapMs) merged[merged.length - 1][1] = r[1];
    else merged.push([r[0], r[1]]);
  }
  return merged.filter(([a, b]) => b - a >= minLenMs);
}

export function fromVoiceActivity(lines: LyricLine[], regions: [number, number][], durationMs: number): Lyrics {
  const keep = lines.map((l) => ({ l, t: tokenize(l.text) })).filter((x) => x.t.length);
  if (!keep.length) return { version: 1, lines: [] };
  if (!regions.length) regions = [[0, durationMs]];
  const totalVoice = regions.reduce((a, [s, e]) => a + e - s, 0);
  const chars = (t: string[]) => t.reduce((a, w) => a + norm(w).length + 1, 0);
  const totalChars = keep.reduce((a, x) => a + chars(x.t), 0);
  const toSong = (v: number) => {
    for (const [a, b] of regions) { if (v <= b - a) return Math.floor(a + v); v -= b - a; }
    return regions[regions.length - 1][1];
  };
  let acc = 0;
  const out: Line[] = keep.map(({ l, t }) => {
    const s = toSong((acc / totalChars) * totalVoice);
    acc += chars(t);
    const e = toSong((acc / totalChars) * totalVoice);
    return { start: 0, end: 0, words: distribute(t, s, Math.max(e, s + MIN_WORD_MS * t.length), true), ...(l.singer ? { singer: l.singer } : {}) };
  });
  fixMonotonic(out.flatMap((l) => l.words), durationMs);
  return toLyrics(out);
}

/** Group transcribed words into display lines (pauses, sentence ends, max length). */
export function splitIntoLines(words: TimedWord[], gapMs = 700, maxWords = 10): TimedWord[][] {
  const lines: TimedWord[][] = [];
  let cur: TimedWord[] = [];
  for (const w of words) {
    const last = cur[cur.length - 1];
    if (last && (w.start - last.end > gapMs || cur.length >= maxWords || /[.!?]$/.test(last.text.trim()))) {
      lines.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) lines.push(cur);
  return lines;
}
