import { describe, expect, it } from 'vitest';
import { type Logits, ProgressiveAligner } from '../src/lib/make/progressive';
import { logSoftmax } from '../src/lib/make/ctc';

// A fake "song": the vocal samples hold their own sample index, so the fake model can tell
// which moment of the song it is looking at and "hear" the scripted letters there.
const SR = 44100;
const VOCAB: Record<string, number> = { '<pad>': 0, '|': 1, L: 2, A: 3, B: 4, O: 5, N: 6 };
const V = 7;
const DUR_S = 70;
const N = DUR_S * SR;
const FR = (ms: number) => Math.round(ms / 20);

/** [startMs, word] sung; one frame per letter, starting there */
const SUNG: [number, string][] = [[2000, 'LA'], [2600, 'BOB'], [12000, 'NO'], [12500, 'LA'], [33000, 'BOB'], [33600, 'NO'], [61000, 'LA'], [61400, 'LOL']];
const script = new Int8Array(Math.floor((N * 16000) / SR / 320)); // 0 = blank
for (const [ms, w] of SUNG) [...w].forEach((c, k) => { script[FR(ms) + k] = VOCAB[c]; });

const vocL = new Float32Array(N).map((_, i) => i);
const resample = async (mono: Float32Array) => {
  const out = new Float32Array(Math.floor((mono.length * 16000) / SR));
  for (let i = 0; i < out.length; i++) out[i] = mono[Math.min(mono.length - 1, Math.round((i * SR) / 16000))];
  return out;
};
let calls = 0;
const logits = async (a: Float32Array): Promise<Logits> => {
  calls++;
  const frames = Math.floor(a.length / 320);
  const x = new Float32Array(frames * V);
  for (let f = 0; f < frames; f++) {
    const abs = Math.round((a[f * 320] * 16000) / SR / 320);
    x[f * V + (script[abs] ?? 0)] = 10;
  }
  return { logits: x, frames, V, vocab: VOCAB };
};

const startOf = (ly: any, word: string, nth = 0) => ly.lines.flatMap((l: any) => l.words).filter((w: any) => w.t === word)[nth]?.s;

describe('progressive word timing', () => {
  const lines = [
    { text: 'la bob', start: 1900 }, { text: 'no la', start: 11800 },
    { text: 'bob no', start: 32800 }, { text: 'la lol', start: 60800 },
  ];
  const exact = (ly: any) => {
    for (const [ms, w] of SUNG) {
      const nth = SUNG.filter(([m, x]) => x === w && m < ms).length;
      const s = startOf(ly, w.toLowerCase(), nth);
      if (s !== undefined) expect(Math.abs(s - ms)).toBeLessThanOrEqual(20);
    }
  };

  it('aligns line by line as the audio arrives, exactly, and only moves forward', async () => {
    const al = new ProgressiveAligner(lines, SR, N, DUR_S * 1000, logits, resample);
    let prevLines = 0, prevMs = 0;
    for (const sec of [10, 20, 40, 55, 65]) {
      await al.feed(vocL, vocL, sec * SR);
      const ly = al.lyrics();
      const n = ly?.lines.length ?? 0;
      expect(n).toBeGreaterThanOrEqual(prevLines);
      expect(al.alignedMs).toBeGreaterThanOrEqual(prevMs);
      expect(al.alignedMs).toBeLessThanOrEqual(sec * 1000);   // never ahead of the audio
      if (ly) exact(ly);
      prevLines = n; prevMs = al.alignedMs;
    }
    expect(prevLines).toBeGreaterThanOrEqual(2);
    await al.feed(vocL, vocL, N);
    expect(al.complete).toBe(true);
    expect(al.lyrics()!.lines).toHaveLength(4);
    exact(al.lyrics());
    expect(al.alignedMs).toBe(DUR_S * 1000);
  });

  it('a line before a long break is done 20 s after its start, not at the next line', async () => {
    const gap = [{ text: 'la bob', start: 1900 }, { text: 'la lol', start: 60800 }];
    const al = new ProgressiveAligner(gap, SR, N, DUR_S * 1000, logits, resample);
    await al.feed(vocL, vocL, 40 * SR);
    expect(al.lyrics()!.lines).toHaveLength(1);
    expect(al.alignedMs).toBe(60800 - 500);
  });

  it('needs synced lyrics (plain lyrics wait for the finished song)', () => {
    expect(ProgressiveAligner.supports([{ text: 'la' }])).toBe(false);
    expect(ProgressiveAligner.supports(lines)).toBe(true);
    expect(() => new ProgressiveAligner([{ text: 'la' }], SR, N, 70000, logits, resample)).toThrow();
  });

  it('a failing model call stops it (the song then waits for the normal timing)', async () => {
    const al = new ProgressiveAligner([{ text: 'la', start: 1900 }], SR, N, DUR_S * 1000, async () => { throw new Error('boom'); }, resample);
    await al.feed(vocL, vocL, N);
    expect(al.failed?.message).toBe('boom');
    expect(al.complete).toBe(false);
  });
});
void logSoftmax; void calls;
