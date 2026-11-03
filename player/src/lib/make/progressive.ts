// Word timing while a song is still being made (to play it early with exact word timing):
// the vocals arrive in parts; each 30 s piece gets its character scores from the alignment
// model, and words are aligned as soon as the audio around them is there.
// Synced lyrics (LRC) only: each line is aligned on its own, in a window from just before its
// start time to the next line (at most 20 s), so the timing is final piece by piece and exactly
// what aligning the whole song gives. (Plain lyrics can't do this reliably: CTC models give
// "nothing sung" a high score almost everywhere, so "as many words as fit so far" is badly
// placed. Plain lyrics wait for the finished song.)
// The finished alignment is the song's word timing (no second pass).

import type { Lyrics } from '$shared/lyrics';
import { type TimedWord, assemble, tokenize } from './align';
import { charIds, forcedAlign, logSoftmax } from './ctc';
import type { LyricLine } from './lyricsInput';

export const FRAME_MS = 20;               // one model frame = 320 samples at 16 kHz
const FPS = 1000 / FRAME_MS;
const CHUNK_S = 30;                       // audio per model call (shorter pieces give worse timing) …
const CONTEXT_S = 1;                      // … plus context on both sides (cut off again)
const LINE_PAD_BEFORE_MS = 500;           // LRC line times are approximate
const LINE_PAD_AFTER_MS = 1000;
const MAX_LINE_MS = 20_000;               // a line's window ends at the next line, or after this

export interface Logits { logits: Float32Array; frames: number; V: number; vocab: Record<string, number> }
/** character scores [frames, V] for a piece of 16 kHz mono audio */
export type LogitsFn = (audio16k: Float32Array) => Promise<Logits>;
/** mono audio at `from` Hz → 16 kHz */
export type ResampleFn = (mono: Float32Array, from: number) => Promise<Float32Array>;

export class ProgressiveAligner {
  /** synced lyrics (every line has a start time) */
  static supports(lines: LyricLine[]): boolean {
    return lines.length > 0 && lines.every((l) => l.start != null);
  }

  readonly totalFrames: number;
  failed: Error | null = null;
  private tokens: string[] = [];
  private tokLine: number[] = [];
  private lineToks: [number, number][] = [];
  private timed: (TimedWord | null)[];
  private lineDone: boolean[];
  private logp: Float32Array | null = null;
  private V = 0;
  private vocab: Record<string, number> = {};
  private framesDone = 0;
  private nextChunk = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly durS: number;

  constructor(private lines: LyricLine[], private sampleRate: number, private length: number,
    private durationMs: number, private logitsFn: LogitsFn, private resampleFn: ResampleFn) {
    if (!ProgressiveAligner.supports(lines)) throw new Error('word timing while making needs synced lyrics');
    lines.forEach((l, i) => {
      const t = tokenize(l.text);
      this.lineToks.push([this.tokens.length, this.tokens.length + t.length]);
      for (const w of t) { this.tokens.push(w); this.tokLine.push(i); }
    });
    this.timed = this.tokens.map(() => null);
    this.lineDone = this.lineToks.map(([a, b]) => a === b);
    this.durS = length / sampleRate;
    this.totalFrames = Math.floor((length * 16000) / sampleRate / 320);
  }

  /** The vocals [0, ready) are final. Resolves when everything that can be aligned with them is. */
  feed(vocL: Float32Array, vocR: Float32Array, ready: number): Promise<void> {
    this.queue = this.queue.then(() => this.work(vocL, vocR, ready)).catch((e) => { this.failed ??= e as Error; });
    return this.queue;
  }

  private async work(vocL: Float32Array, vocR: Float32Array, ready: number) {
    if (this.failed) return;
    const done = ready >= this.length;
    for (;;) {
      const a = this.nextChunk * CHUNK_S;
      if (a >= this.durS) break;
      const from = Math.max(0, a - CONTEXT_S), to = Math.min(this.durS, a + CHUNK_S + CONTEXT_S);
      const s0 = Math.floor(from * this.sampleRate), s1 = Math.min(this.length, Math.ceil(to * this.sampleRate));
      if (s1 > ready && !done) break;
      const mono = new Float32Array(s1 - s0);
      for (let i = 0; i < mono.length; i++) mono[i] = 0.5 * (vocL[s0 + i] + vocR[s0 + i]);
      const r = await this.logitsFn(await this.resampleFn(mono, this.sampleRate));
      if (!this.logp) { this.V = r.V; this.vocab = r.vocab; this.logp = new Float32Array(this.totalFrames * r.V); }
      const V = this.V;
      const skip = Math.round((a - from) * FPS), dst = Math.round(a * FPS);
      const keep = Math.max(0, Math.min(CHUNK_S * FPS, this.totalFrames - dst, r.frames - skip));
      this.logp.set(r.logits.subarray(skip * V, (skip + keep) * V), dst * V);
      logSoftmax(this.logp.subarray(dst * V, (dst + keep) * V), keep, V);
      this.framesDone = dst + keep;
      this.nextChunk++;
      this.align(this.nextChunk * CHUNK_S >= this.durS);
    }
  }

  private ids(tok: string) { return charIds(tok, this.vocab); }

  private place(tokIndex: number, startF: number, endF: number, score: number) {
    this.timed[tokIndex] = { text: this.tokens[tokIndex], start: startF * FRAME_MS, end: endF * FRAME_MS, score };
  }

  private align(final: boolean) {
    if (!this.logp) return;
    const V = this.V, blank = this.vocab['<pad>'] ?? 0, sep = this.vocab['|'] ?? -1;
    this.lines.forEach((ln, i) => {
      if (this.lineDone[i]) return;
      const next = this.lines.slice(i + 1).find((x) => x.start! > ln.start!)?.start;
      const endMs = Math.min(next == null ? Infinity : next + LINE_PAD_AFTER_MS, ln.start! + MAX_LINE_MS);
      const f0 = Math.max(0, Math.floor((ln.start! - LINE_PAD_BEFORE_MS) / FRAME_MS));
      const f1 = Math.min(this.totalFrames, Math.ceil(endMs / FRAME_MS));
      if (f1 > this.framesDone && !final) return;
      const [a, b] = this.lineToks[i];
      if (f1 > f0) {
        const r = forcedAlign(this.logp!.subarray(f0 * V, f1 * V), f1 - f0, V, this.tokens.slice(a, b).map((t) => this.ids(t)), blank, sep);
        r.forEach((w, k) => { if (w) this.place(a + k, f0 + w.start, f0 + w.end, w.score); });
      }
      this.lineDone[i] = true;
    });
  }

  /** Lines [0, n) have their word timing for good. */
  private linesReady(): number {
    let n = 0;
    while (n < this.lines.length && this.lineDone[n]) n++;
    return n;
  }

  /** Word timing is known up to here (ms): the singer must not get past it. */
  get alignedMs(): number {
    const n = this.linesReady();
    if (n >= this.lines.length) return this.durationMs;
    return Math.max(0, (this.lines[n].start ?? 0) - LINE_PAD_BEFORE_MS);
  }

  get complete(): boolean { return !this.failed && this.linesReady() >= this.lines.length; }

  /** Word-timed lyrics for the lines that are ready (all of them once complete). */
  lyrics(): Lyrics | null {
    const n = this.linesReady();
    if (!n) return null;
    const [, tokEnd] = this.lineToks[n - 1];
    const words = this.timed.slice(0, tokEnd).filter((w): w is TimedWord => !!w);
    const upTo = n >= this.lines.length ? this.durationMs : Math.max(this.alignedMs, words.at(-1)?.end ?? 0);
    return assemble(this.lines.slice(0, n), words, upTo);
  }

  /** All placed words (for the finished song). */
  words(): TimedWord[] { return this.timed.filter((w): w is TimedWord => !!w); }
}
