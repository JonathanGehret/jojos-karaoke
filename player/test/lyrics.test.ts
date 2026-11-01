import { describe, expect, it } from 'vitest';
import {
  type Lyrics, countdownDots, currentLineIndex, displayPair, inInstrumentalBreak, shiftLyrics, wordProgress,
} from '$shared/lyrics';

// Placeholder syllables only; never real song lyrics in tests.
const L: Lyrics = { version: 1, lines: [
  { start: 1000, end: 2000, words: [{ t: 'la', s: 1000, e: 1500 }, { t: 'lo', s: 1500, e: 2000 }] },
  { start: 2500, end: 3000, words: [{ t: 'li', s: 2500, e: 3000 }] },
  { start: 10000, end: 11000, words: [{ t: 'lu', s: 10000, e: 11000 }] },
] };

describe('timeline', () => {
  it('finds the current line by binary search', () => {
    expect(currentLineIndex(L.lines, 0)).toBe(0);
    expect(currentLineIndex(L.lines, 1999)).toBe(0);
    expect(currentLineIndex(L.lines, 2000)).toBe(1);
    expect(currentLineIndex(L.lines, 5000)).toBe(2);
    expect(currentLineIndex(L.lines, 12000)).toBe(3);
  });

  it('word progress', () => {
    const w = L.lines[0].words[0];
    expect(wordProgress(w, 900)).toBe(0);
    expect(wordProgress(w, 1250)).toBe(0.5);
    expect(wordProgress(w, 2000)).toBe(1);
  });

  it('alternates slots so the sung line never jumps', () => {
    expect(displayPair(L.lines, 1500)).toEqual([0, 1]);
    expect(displayPair(L.lines, 2600)).toEqual([2, 1]);
    expect(displayPair(L.lines, 10500)).toEqual([2, null]);
    expect(displayPair(L.lines, 20000)).toEqual([null, null]);
  });

  it('countdown dots only after a long gap', () => {
    expect(countdownDots(L.lines, 1, 2400)).toBe(0);       // short gap
    expect(countdownDots(L.lines, 2, 6000)).toBe(0);       // too early
    expect(countdownDots(L.lines, 2, 7100)).toBe(3);
    expect(countdownDots(L.lines, 2, 9100)).toBe(1);
    expect(countdownDots(L.lines, 2, 10000)).toBe(0);
  });

  it('instrumental break note', () => {
    expect(inInstrumentalBreak(L.lines, 5000)).toBe(true);
    expect(inInstrumentalBreak(L.lines, 8000)).toBe(false); // countdown takes over
    expect(inInstrumentalBreak(L.lines, 1500)).toBe(false);
  });

  it('shift clamps at zero', () => {
    const s = shiftLyrics(L, -1200);
    expect(s.lines[0].words[0].s).toBe(0);
    expect(s.lines[2].start).toBe(8800);
  });
});
