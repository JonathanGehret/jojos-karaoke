import { describe, expect, it } from 'vitest';
import { estimateOffset, positionAt, sampleFrom } from '$shared/clock';
import { fairInsertIndex, moveEntry } from '$shared/rotation';

describe('clock sync', () => {
  it('estimates the offset and ignores slow round trips', () => {
    // true offset +1000; fast pings are symmetric, one slow ping is skewed
    const samples = [
      sampleFrom(0, 1010, 20), sampleFrom(100, 1110, 120), sampleFrom(200, 1212, 222),
      sampleFrom(300, 1600, 900), sampleFrom(400, 1409, 418),
    ];
    expect(Math.abs(estimateOffset(samples)! - 1000)).toBeLessThan(2);
    expect(estimateOffset([])).toBeNull();
  });

  it('extrapolates playback position', () => {
    const p = { state: 'playing' as const, positionMs: 1000, atServerMs: 5000, rate: 1.1 };
    expect(positionAt(p, 6000)).toBe(2100);
    expect(positionAt({ ...p, state: 'paused' }, 6000)).toBe(1000);
  });
});

describe('fair rotation', () => {
  const q = (ms: string) => ms.split('').map((m, i) => ({ id: String(i), memberId: m }));
  const insert = (queue: { id: string; memberId: string }[], m: string) => {
    const out = [...queue];
    out.splice(fairInsertIndex(out, m), 0, { id: 'new', memberId: m });
    return out.map((x) => x.memberId).join('');
  };
  it('round-robins singers', () => {
    expect(insert(q(''), 'A')).toBe('A');
    expect(insert(q('A'), 'A')).toBe('AA');
    expect(insert(q('AA'), 'B')).toBe('ABA');
    expect(insert(q('ABA'), 'C')).toBe('ABCA');
    expect(insert(q('ABCA'), 'B')).toBe('ABCAB');
    expect(insert(q('ABCAB'), 'A')).toBe('ABCABA');
  });
  it('appends when fairness is off', () => {
    expect(fairInsertIndex(q('AAB'), 'C', false)).toBe(3);
  });
  it('moves entries', () => {
    expect(moveEntry(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveEntry(['a', 'b', 'c'], 0, 9)).toEqual(['b', 'c', 'a']);
  });
});
