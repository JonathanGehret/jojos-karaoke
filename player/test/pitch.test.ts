import { describe, expect, it } from 'vitest';
import { ScoreKeeper, frameScore, pitchClassDistance, refAt } from '../src/lib/pitch/score';
import { hzToMidi, yin } from '../src/lib/pitch/yin';

describe('yin', () => {
  it('detects sine pitches', () => {
    const sr = 48000;
    for (const f of [110, 220, 440, 660]) {
      const buf = new Float32Array(2048).map((_, i) => Math.sin((2 * Math.PI * f * i) / sr));
      expect(Math.abs(yin(buf, sr)! - f) / f).toBeLessThan(0.01);
    }
  });
  it('noise is unvoiced', () => {
    let s = 1;
    const buf = new Float32Array(2048).map(() => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1);
    expect(yin(buf, 48000)).toBeNull();
  });
});

describe('scoring', () => {
  it('is octave-agnostic', () => {
    expect(pitchClassDistance(60, 72)).toBe(0);
    expect(pitchClassDistance(60, 61)).toBe(1);
    expect(pitchClassDistance(60, 66)).toBe(6);
    expect(frameScore(hzToMidi(220), hzToMidi(440))).toBe(1);
    expect(frameScore(60, 63)).toBe(0);
  });
  it('reads the contour with key shift', () => {
    const c = { hopMs: 20, midi: [null, 60, 62] };
    expect(refAt(c, 20)).toBe(60);
    expect(refAt(c, 41, 2)).toBe(64);
    expect(refAt(c, 0)).toBeNull();
  });
  it('silence during sung parts costs points; unvoiced reference is ignored', () => {
    const k = new ScoreKeeper();
    k.add(null, 60); k.add(60, 60); k.add(60, null); k.add(62, 74);
    expect(k.frames).toBe(3);
    expect(k.value).toBe(67);
  });
});
