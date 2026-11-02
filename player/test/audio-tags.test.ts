import { describe, expect, it } from 'vitest';
import { parseTags } from '../src/lib/audioTags';

const enc = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: (Uint8Array | number[])[]) => {
  const out: number[] = [];
  for (const p of parts) out.push(...p);
  return new Uint8Array(out);
};
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const syncsafe = (n: number) => [(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127];

function id3(ver: 3 | 4, frames: [string, number, Uint8Array][]) {
  const body = cat(...frames.map(([id, e, data]) => cat(enc(id), ver === 4 ? syncsafe(data.length + 1) : be32(data.length + 1), [0, 0, e], data)));
  return cat(enc('ID3'), [ver, 0, 0], syncsafe(body.length + 20), body, new Uint8Array(20));
}
function box(type: string, ...kids: Uint8Array[]) {
  const body = cat(...kids);
  return cat(be32(body.length + 8), [...type].map((c) => c.charCodeAt(0)), body); // box types are latin1
}

describe('audio tags', () => {
  it('reads ID3v2.3 (UTF-16) and ID3v2.4 (UTF-8)', () => {
    const utf16 = cat([0xff, 0xfe], ...[...'Tést Song'].map((c) => [c.charCodeAt(0), 0]));
    expect(parseTags(id3(3, [['TIT2', 1, utf16], ['TPE1', 0, enc('Test Band')]]))).toEqual({ title: 'Tést Song', artist: 'Test Band' });
    expect(parseTags(id3(4, [['TPE1', 3, enc('Bänd')], ['TIT2', 3, enc('Song\0')]]))).toEqual({ title: 'Song', artist: 'Bänd' });
  });

  it('reads MP4 ilst', () => {
    const data = (s: string) => box('data', new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0]), enc(s));
    const meta = box('meta', new Uint8Array(4), box('ilst', box('©nam', data('M4A Song')), box('©ART', data('M4A Band'))));
    const file = cat(box('ftyp', enc('M4A '), new Uint8Array(4)), box('moov', box('udta', meta)));
    expect(parseTags(file)).toEqual({ title: 'M4A Song', artist: 'M4A Band' });
  });

  it('reads FLAC Vorbis comments', () => {
    const c = (s: string) => cat(le32(enc(s).length), enc(s));
    const vc = cat(c('vendor'), le32(2), c('ARTIST=Flac Band'), c('title=Flac Song'));
    const file = cat(enc('fLaC'), [0, 0, 0, 2], [1, 2], [0x84, ...be32(vc.length).slice(1)], vc);
    expect(parseTags(file)).toEqual({ title: 'Flac Song', artist: 'Flac Band' });
  });

  it('ignores unknown data', () => {
    expect(parseTags(new Uint8Array(64))).toEqual({});
  });
});

describe('file names', async () => {
  const { guessFromFilename } = await import('../src/lib/audioTags');
  it('splits artist and title and drops track numbers', () => {
    expect(guessFromFilename('03 - Test Band - Some Song.mp3')).toEqual({ artist: 'Test Band', title: 'Some Song' });
    expect(guessFromFilename('07. Some Song.flac')).toEqual({ artist: '', title: 'Some Song' });
    expect(guessFromFilename('Test_Band - Some_Song.m4a')).toEqual({ artist: 'Test Band', title: 'Some Song' });
    expect(guessFromFilename('1999.mp3')).toEqual({ artist: '', title: '1999' });
  });
});
