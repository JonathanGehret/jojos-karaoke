import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { readPackage, writePackage } from '../src/lib/jkp';

const manifest = { formatVersion: 1, id: 'nobody-x-abcdef', title: 'X', artist: 'Nobody', durationMs: 1000,
  files: { instrumental: 'instrumental.opus', lyrics: 'lyrics.json' } };
const lyrics = { version: 1, lines: [{ start: 0, end: 10, words: [{ t: 'la', s: 0, e: 10 }] }] };

describe('jkp', () => {
  it('round-trips and keeps audio stored', () => {
    const z = zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'lyrics.json': strToU8(JSON.stringify(lyrics)),
      'instrumental.opus': new Uint8Array([1, 2, 3]) });
    const p = readPackage(z);
    expect(p.manifest.title).toBe('X');
    p.lyrics.lines[0].words[0].t = 'lo';
    const again = readPackage(writePackage(p));
    expect(again.lyrics.lines[0].words[0].t).toBe('lo');
    expect([...again.files['instrumental.opus']]).toEqual([1, 2, 3]);
  });
  it('rejects zips that are not packages', () => {
    expect(() => readPackage(zipSync({ 'a.txt': strToU8('x') }))).toThrow(/manifest.json/);
  });
});
