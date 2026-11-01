import { describe, expect, it } from 'vitest';
import type { Lyrics } from '$shared/lyrics';
import * as E from '../src/lib/lyrics/edit';

const L = (): Lyrics => ({ version: 1, lines: [
  { start: 1000, end: 2000, words: [{ t: 'la', s: 1000, e: 1400, lowConfidence: true }, { t: 'lo', s: 1500, e: 2000 }] },
  { start: 3000, end: 4000, words: [{ t: 'li', s: 3000, e: 3500 }, { t: 'lu', s: 3500, e: 4000 }] },
] });

const ordered = (l: Lyrics) => {
  let prev = 0;
  for (const ln of l.lines) {
    expect(ln.start).toBe(ln.words[0].s);
    expect(ln.end).toBe(ln.words.at(-1)!.e);
    for (const w of ln.words) { expect(w.s).toBeGreaterThanOrEqual(prev); expect(w.e).toBeGreaterThan(w.s); prev = w.s; }
  }
};

describe('editor ops', () => {
  it('tap sets a start, trims the previous word and clears low confidence', () => {
    const out = E.tapWord(L(), 0, 1, 1300);
    expect(out.lines[0].words[1].s).toBe(1300);
    expect(out.lines[0].words[0].e).toBe(1300);
    const out2 = E.tapWord(L(), 0, 0, 900);
    expect(out2.lines[0].words[0].lowConfidence).toBeUndefined();
    ordered(out);
  });

  it('tap later than the next word pushes the rest along', () => {
    const out = E.tapWord(L(), 0, 0, 1800);
    ordered(out);
    expect(out.lines[0].words[1].s).toBeGreaterThanOrEqual(1800);
  });

  it('nudge, split, merge, delete keep order', () => {
    ordered(E.nudgeLine(L(), 1, -2500));
    const sp = E.splitLine(L(), 1, 1);
    expect(sp.lines.map((l) => l.words.length)).toEqual([2, 1, 1]);
    const mg = E.mergeWithNext(L(), 0);
    expect(mg.lines).toHaveLength(1);
    expect(mg.lines[0].end).toBe(4000);
    expect(E.deleteLine(L(), 0).lines).toHaveLength(1);
    expect(E.splitLine(L(), 0, 0)).toEqual(L());
  });

  it('dragging a word is clamped between its neighbours', () => {
    const out = E.setWordTimes(L(), 0, 1, 500, 900);
    expect(out.lines[0].words[1].s).toBe(1000);
    ordered(out);
  });

  it('retext keeps times when the word count matches, spreads otherwise', () => {
    expect(E.retextLine(L(), 0, 'da do').lines[0].words.map((w) => [w.t, w.s])).toEqual([['da', 1000], ['do', 1500]]);
    const r = E.retextLine(L(), 0, 'a b c d');
    expect(r.lines[0].words).toHaveLength(4);
    ordered(r);
  });

  it('insert lines into the gap and from scratch', () => {
    const ins = E.insertLineAfter(L(), 0, 'na na');
    expect(ins.lines).toHaveLength(3);
    expect(ins.lines[1].start).toBe(2000);
    ordered(ins);
    let empty: Lyrics = { version: 1, lines: [] };
    empty = E.insertLineAfter(empty, -1, 'one');
    empty = E.insertLineAfter(empty, 0, 'two');
    expect(empty.lines.map((l) => l.words[0].t)).toEqual(['one', 'two']);
    ordered(empty);
  });

  it('wordAt', () => {
    expect(E.wordAt(L(), 0)).toEqual([0, 0]);
    expect(E.wordAt(L(), 2500)).toEqual([1, 0]);
    expect(E.wordAt(L(), 9999)).toBeNull();
  });
});
