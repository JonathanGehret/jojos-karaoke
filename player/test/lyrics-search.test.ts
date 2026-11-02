import { describe, expect, it } from 'vitest';
import { bestLyrics, cleanTitle, mainArtist, rankLyrics } from '$shared/lyricsSearch';

describe('lyrics search', () => {
  it('cleans titles and artists like the Python maker', () => {
    expect(cleanTitle('Some Song (Official Video)')).toBe('Some Song');
    expect(cleanTitle('Some Song [Remastered 2011]')).toBe('Some Song');
    expect(cleanTitle('Some Song - 2009 Remaster')).toBe('Some Song');
    expect(cleanTitle('Some Song feat. Somebody')).toBe('Some Song');
    expect(cleanTitle('(Live)')).toBe('(Live)');
    expect(mainArtist('Band A feat. Band B')).toBe('Band A');
    expect(mainArtist('Duo One & Duo Two')).toBe('Duo One');
  });

  it('ranks fitting duration, then synced, and drops duplicates and instrumentals', () => {
    const r = rankLyrics([
      { id: 1, trackName: 'Placeholder Song', artistName: 'Test Band', duration: 200, plainLyrics: 'a' },
      { id: 2, trackName: 'Placeholder Song', artistName: 'Test Band', duration: 260, syncedLyrics: '[00:01.00]b' },
      { id: 3, trackName: 'Placeholder Song', artistName: 'Test Band', duration: 203, syncedLyrics: '[00:01.00]c' },
      { id: 4, trackName: 'Placeholder Song', artistName: 'Test Band', duration: 203, syncedLyrics: '[00:01.00]c' },
      { id: 5, trackName: 'Placeholder Song', artistName: 'Test Band', duration: 201, instrumental: true },
    ], { title: 'Placeholder Song', artist: 'Test Band', duration: 201 });
    expect(r.map((c) => c.id)).toEqual([3, 1, 2]);
    expect(bestLyrics(r, 201)?.id).toBe(3);
    expect(bestLyrics(r.filter((c) => c.id === 2), 201)).toBeNull();
  });

  it('never picks a different song automatically', () => {
    const r = rankLyrics([
      { id: 1, trackName: 'Different Thing', artistName: 'Someone Else', syncedLyrics: '[00:01.00]x' },
      { id: 2, trackName: 'Placeholder Song (Live)', artistName: 'Test Band', plainLyrics: 'y' },
    ], { title: 'Placeholder Song (Official Video)', artist: 'Test Band' });
    expect(r[0].id).toBe(2);
    expect(r[1].weak).toBe(true);
    expect(bestLyrics(r.slice(1))).toBeNull();
  });
});
