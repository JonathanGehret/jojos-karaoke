import { describe, expect, it } from 'vitest';
import { charIds, forcedAlign, logSoftmax } from '../src/lib/make/ctc';

// tiny vocabulary: blank, separator, and a few letters
const VOCAB: Record<string, number> = { '<pad>': 0, '|': 1, A: 2, B: 3, L: 4, O: 5, "'": 6 };
const V = 7;

/** Frames that strongly emit the given symbols (one symbol per frame; '_' = blank). */
function frames(seq: string): { logp: Float32Array; T: number } {
  const sym = (c: string) => (c === '_' ? 0 : c === ' ' ? 1 : VOCAB[c]);
  const T = seq.length;
  const x = new Float32Array(T * V);
  [...seq].forEach((c, t) => { x[t * V + sym(c)] = 8; });
  return { logp: logSoftmax(x, T, V), T };
}

describe('CTC forced alignment', () => {
  it('maps lyric tokens to model characters', () => {
    expect(charIds('Lá!', VOCAB)).toEqual([4, 2]);
    expect(charIds("lo'", VOCAB)).toEqual([4, 5, 6]);
    expect(charIds('—', VOCAB)).toEqual([]);
    expect(charIds("'", VOCAB)).toEqual([]);
  });

  it('finds each word where it is sung, across silence', () => {
    // "LA" at frames 3-4, long pause, "BOB" at 12-16 (held O)
    const { logp, T } = frames('___LA______ BOOOB___');
    const r = forcedAlign(logp, T, V, [charIds('la', VOCAB), charIds('bob', VOCAB)], 0, 1);
    expect(r[0]).toMatchObject({ start: 3, end: 5 });
    expect(r[1]).toMatchObject({ start: 12, end: 17 });
    expect(r[0]!.score).toBeGreaterThan(0.9);
  });

  it('handles repeated letters (needs a blank between them)', () => {
    const { logp, T } = frames('_LO_O__');
    const r = forcedAlign(logp, T, V, [[4, 5, 5]], 0, 1);
    expect(r[0]).toMatchObject({ start: 1, end: 5 });
  });

  it('skips empty words and gives up when there are too few frames', () => {
    const { logp, T } = frames('_LA_');
    const r = forcedAlign(logp, T, V, [[], charIds('la', VOCAB)], 0, 1);
    expect(r[0]).toBeNull();
    expect(r[1]).toMatchObject({ start: 1, end: 3 });
    expect(forcedAlign(logp, T, V, [charIds('lalala', VOCAB)], 0, 1)).toEqual([null]);
  });

  it('scores words the audio does not support lower', () => {
    const { logp, T } = frames('__LA__ ____');
    const r = forcedAlign(logp, T, V, [charIds('la', VOCAB), charIds('bob', VOCAB)], 0, 1);
    expect(r[0]!.score).toBeGreaterThan(0.9);
    expect(r[1]!.score).toBeLessThan(0.1);
  });
});
