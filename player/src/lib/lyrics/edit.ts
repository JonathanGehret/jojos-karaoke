// Pure edit operations for the timing editor. Every op returns a new Lyrics, normalised so
// times stay in order (the schema and the server reject anything else).

import type { Line, Lyrics, Word } from '$shared/lyrics';

export const MIN_WORD_MS = 60;

const clone = (l: Lyrics): Lyrics => JSON.parse(JSON.stringify(l));

/** Ensure integer, non-decreasing times; recompute line start/end; drop empty lines. */
export function normalize(l: Lyrics): Lyrics {
  const out = clone(l);
  let prev = 0;
  out.lines = out.lines.filter((ln) => ln.words.length);
  for (const ln of out.lines) {
    for (const w of ln.words) {
      w.s = Math.max(prev, Math.round(w.s));
      w.e = Math.max(w.s + 1, Math.round(w.e));
      prev = w.s;
    }
    ln.start = ln.words[0].s;
    ln.end = ln.words[ln.words.length - 1].e;
  }
  return out;
}

export function nudgeLine(l: Lyrics, li: number, ms: number): Lyrics {
  const out = clone(l);
  for (const w of out.lines[li].words) { w.s = Math.max(0, w.s + ms); w.e = Math.max(0, w.e + ms); }
  return normalize(out);
}

export function nudgeAll(l: Lyrics, ms: number): Lyrics {
  const out = clone(l);
  for (const ln of out.lines) for (const w of ln.words) { w.s = Math.max(0, w.s + ms); w.e = Math.max(0, w.e + ms); }
  return normalize(out);
}

/** Tap: word (li, wi) starts at t; the previous word ends there if it ran over. Clears lowConfidence. */
export function tapWord(l: Lyrics, li: number, wi: number, t: number): Lyrics {
  const out = clone(l);
  const w = out.lines[li].words[wi];
  const len = Math.max(MIN_WORD_MS, w.e - w.s);
  w.s = Math.round(t);
  w.e = w.s + len;
  delete w.lowConfidence;
  const prev = wi > 0 ? out.lines[li].words[wi - 1] : li > 0 ? out.lines[li - 1].words.at(-1)! : null;
  if (prev && prev.e > w.s) prev.e = Math.max(prev.s + 1, w.s);
  // keep following words from starting before this one
  const next = out.lines[li].words[wi + 1];
  if (next && next.s < w.s) { const d = w.s + len - next.s; shiftFrom(out, li, wi + 1, d); }
  return normalize(out);
}

function shiftFrom(l: Lyrics, li: number, wi: number, d: number) {
  for (let i = li; i < l.lines.length; i++) {
    const ws = l.lines[i].words;
    for (let k = i === li ? wi : 0; k < ws.length; k++) { ws[k].s += d; ws[k].e += d; }
  }
}

/** Word (li, wi) ends at t. */
export function tapEnd(l: Lyrics, li: number, wi: number, t: number): Lyrics {
  const out = clone(l);
  const w = out.lines[li].words[wi];
  w.e = Math.max(w.s + 1, Math.round(t));
  return normalize(out);
}

export function setWordTimes(l: Lyrics, li: number, wi: number, s: number, e: number): Lyrics {
  const out = clone(l);
  const w = out.lines[li].words[wi];
  const ws = out.lines[li].words;
  const lo = wi > 0 ? ws[wi - 1].s : li > 0 ? out.lines[li - 1].words.at(-1)!.s : 0;
  const hi = wi + 1 < ws.length ? ws[wi + 1].s : li + 1 < out.lines.length ? out.lines[li + 1].words[0].s : Infinity;
  w.s = Math.round(Math.max(lo, Math.min(s, hi)));
  w.e = Math.round(Math.max(w.s + 1, e));
  delete w.lowConfidence;
  return normalize(out);
}

export function splitLine(l: Lyrics, li: number, wi: number): Lyrics {
  if (wi <= 0 || wi >= l.lines[li].words.length) return l;
  const out = clone(l);
  const ln = out.lines[li];
  const second: Line = { start: 0, end: 0, words: ln.words.splice(wi), singer: ln.singer };
  out.lines.splice(li + 1, 0, second);
  return normalize(out);
}

export function mergeWithNext(l: Lyrics, li: number): Lyrics {
  if (li + 1 >= l.lines.length) return l;
  const out = clone(l);
  out.lines[li].words.push(...out.lines[li + 1].words);
  out.lines.splice(li + 1, 1);
  return normalize(out);
}

export function deleteLine(l: Lyrics, li: number): Lyrics {
  const out = clone(l);
  out.lines.splice(li, 1);
  return normalize(out);
}

export function setSinger(l: Lyrics, li: number, singer: string | null): Lyrics {
  const out = clone(l);
  if (singer) out.lines[li].singer = singer; else delete out.lines[li].singer;
  return out;
}

/** Replace a line's text; words keep their times by position, new words are spread over the line. */
export function retextLine(l: Lyrics, li: number, text: string): Lyrics {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length) return deleteLine(l, li);
  const out = clone(l);
  const ln = out.lines[li];
  const start = ln.start, end = Math.max(ln.end, start + MIN_WORD_MS * tokens.length);
  if (tokens.length === ln.words.length) {
    tokens.forEach((t, i) => (ln.words[i].t = t));
  } else {
    const step = (end - start) / tokens.length;
    ln.words = tokens.map((t, i): Word => ({ t, s: Math.round(start + i * step), e: Math.round(start + (i + 1) * step), lowConfidence: true }));
  }
  return normalize(out);
}

/** Insert a new line (placeholder text) after li, in the gap before the next line. */
export function insertLineAfter(l: Lyrics, li: number, text: string): Lyrics {
  const out = clone(l);
  const after = li >= 0 ? out.lines[li].end : 0;
  const before = li + 1 < out.lines.length ? out.lines[li + 1].start : after + 3000;
  const tokens = text.split(/\s+/).filter(Boolean);
  const span = Math.max(MIN_WORD_MS * tokens.length, before - after);
  const step = span / tokens.length;
  out.lines.splice(li + 1, 0, { start: 0, end: 0,
    words: tokens.map((t, i) => ({ t, s: Math.round(after + i * step), e: Math.round(after + (i + 1) * step), lowConfidence: true })) });
  return normalize(out);
}

/** Find the word at time t (or the next one). */
export function wordAt(l: Lyrics, t: number): [number, number] | null {
  for (let li = 0; li < l.lines.length; li++) {
    const ws = l.lines[li].words;
    for (let wi = 0; wi < ws.length; wi++) if (ws[wi].e > t) return [li, wi];
  }
  return null;
}
