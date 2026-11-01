// Same cases as maker/tests/test_align.py and test_lyrics.py, so the two ports stay in step.
import { describe, expect, it } from 'vitest';
import {
  type TimedWord, assemble, distribute, fromLrcTimings, fromVoiceActivity, matchWords, opcodes, splitIntoLines,
  tokenize, voicedRegions,
} from '../src/lib/make/align';
import { looksLikeLrc, parseLrc, parseText } from '../src/lib/make/lyricsInput';

const tw = (text: string, start: number, end: number, score = 1): TimedWord => ({ text, start, end, score });

describe('lyrics input', () => {
  it('plain text drops blanks and sections', () => {
    expect(parseText('[Chorus]\nla la la\n\n(x2)\ndo re mi\n').map((l) => l.text)).toEqual(['la la la', 'do re mi']);
  });
  it('singer prefixes only when enabled', () => {
    expect(parseText('A: la la')[0].text).toBe('A: la la');
    expect(parseText('A: la la\nB: do re', true).map((l) => [l.singer, l.text])).toEqual([['A', 'la la'], ['B', 'do re']]);
  });
  it('lrc offset and repeats', () => {
    const t = '[ti:x]\n[offset:+500]\n[00:01.00]la la\n[00:03.50][00:10.00]do re\n';
    expect(looksLikeLrc(t)).toBe(true);
    expect(parseLrc(t).map((l) => [l.start, l.text])).toEqual([[500, 'la la'], [3000, 'do re'], [9500, 'do re']]);
  });
  it('enhanced lrc word times', () => {
    const l = parseLrc('[00:01.00]<00:01.00>la <00:01.50>lu lo <00:02.40>li\n[00:05.00]x y');
    expect(l[0].text).toBe('la lu lo li');
    expect(l[0].wordTimes).toEqual([1000, 1500, -1, 2400]);
    expect(l[1].wordTimes).toBeUndefined();
  });
});

describe('align', () => {
  it('tokenize glues punctuation-only tokens', () => {
    expect(tokenize('la - la … lu!')).toEqual(['la -', 'la …', 'lu!']);
  });
  it('opcodes', () => {
    expect(opcodes(['a', 'b', 'c'], ['a', 'c']).map((o) => o.tag)).toEqual(['equal', 'delete', 'equal']);
  });
  it('match survives a dropped word', () => {
    const m = matchWords(['la', 'lo', 'li', 'lu'], [tw('la', 0, 100), tw('li', 200, 300), tw('lu', 300, 400)]);
    expect([m[0]?.start, m[1], m[2]?.start, m[3]?.start]).toEqual([0, null, 200, 300]);
  });
  it('assemble maps back and interpolates', () => {
    const out = assemble([{ text: 'la lo' }, { text: 'li lu' }], [tw('la', 1000, 1200), tw('li', 2000, 2200), tw('lu', 2300, 2600)], 10000);
    const [l0, l1] = out.lines;
    expect(l0.words.map((w) => w.t)).toEqual(['la', 'lo']);
    expect(l0.words[1].lowConfidence).toBe(true);
    expect(l0.words[1].s).toBeGreaterThanOrEqual(1200);
    expect(l0.words[1].e).toBeLessThanOrEqual(2000);
    expect([l1.start, l1.end]).toEqual([2000, 2600]);
  });
  it('flags low scores', () => {
    const out = assemble([{ text: 'la lo' }], [tw('la', 0, 100, 0.9), tw('lo', 100, 200, 0.1)], 1000);
    expect(out.lines[0].words.map((w) => !!w.lowConfidence)).toEqual([false, true]);
  });
  it('distribute weights by length', () => {
    const w = distribute(['a', 'loooooong'], 0, 1000);
    expect(w[0].s).toBe(0);
    expect(w[1].e).toBe(1000);
    expect(w[0].e - w[0].s).toBeLessThan(w[1].e - w[1].s);
  });
  it('lrc timings use enhanced words and cap the line end', () => {
    const out = fromLrcTimings([{ text: 'la lo', start: 1000, wordTimes: [1000, 1400] }, { text: 'li', start: 60000 }], 70000);
    expect(out.lines[0].words[1].s).toBe(1400);
    expect(out.lines[0].end).toBeLessThanOrEqual(3000);
  });
  it('voice activity fallback', () => {
    const sr = 16000;
    const x = Float32Array.from({ length: sr * 8 }, (_, i) => {
      const t = i / sr;
      return (t >= 1 && t < 3) || (t >= 5 && t < 7) ? 0.5 * Math.sin(2 * Math.PI * 220 * t) : 0;
    });
    const regions = voicedRegions(x, sr);
    expect(regions.length).toBe(2);
    expect(Math.abs(regions[0][0] - 1000)).toBeLessThan(100);
    const out = fromVoiceActivity([{ text: 'la la' }, { text: 'lo lo' }], regions, 8000);
    expect(out.lines[0].start).toBeGreaterThanOrEqual(900);
    expect(out.lines[1].end).toBeLessThanOrEqual(7100);
  });
  it('splits transcribed words into lines', () => {
    const ws = [tw('la', 0, 100), tw('lo.', 100, 200), tw('li', 250, 300), tw('lu', 2000, 2100)];
    expect(splitIntoLines(ws).map((l) => l.map((w) => w.text).join(' '))).toEqual(['la lo.', 'li', 'lu']);
  });
});
