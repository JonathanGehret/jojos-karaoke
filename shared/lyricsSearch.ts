// Choosing lyrics from LRCLIB results. Used by the server's /api/lyrics endpoints; the same
// rules live in maker/src/jojos_karaoke/lyrics.py (keep in step).

/** One LRCLIB record (only the fields we use). */
export interface LrclibRecord {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

export interface LyricsCandidate {
  id: number;
  title: string;
  artist: string;
  album: string;
  /** seconds, 0 when unknown */
  duration: number;
  synced: string | null;
  plain: string | null;
  /** title/artist differ from what was asked for (a loose search hit): never picked automatically */
  weak?: boolean;
}

/** Durations further apart than this are probably a different recording. */
export const DURATION_TOLERANCE_S = 8;

/** Drop the noise file names and video titles carry: "(Official Video)", "[Remastered 2011]",
 *  "- Radio Edit", "feat. X". Keeps the title itself even if everything looks like noise. */
export function cleanTitle(title: string): string {
  const t = title
    .replace(/\s*[([][^)\]]*\b(official|video|audio|lyrics?|visuali[sz]er|remaster(ed)?|hd|hq|4k|live|explicit|clean|edit|version|mono|stereo|feat\.?|ft\.?|with)\b[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+(\d{4}\s+)?(remaster(ed)?|radio edit|single version|mono|stereo|live)\b.*$/i, '')
    .replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return t || title.trim();
}

/** First credited artist: "A feat. B", "A & B", "A, B" → "A" (search works best with one name). */
export function mainArtist(artist: string): string {
  return artist.split(/\s+(?:feat\.?|ft\.?|featuring|&|and|x|vs\.?)\s+|,\s*/i)[0].trim() || artist.trim();
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Usable, de-duplicated candidates, best first: duration within tolerance, then synced, then
 *  closest duration, then how well title/artist match what was asked for. */
export function rankLyrics(records: LrclibRecord[], want: { title?: string; artist?: string; duration?: number } = {}): LyricsCandidate[] {
  const dur = want.duration || 0;
  const wt = norm(cleanTitle(want.title ?? ''));
  const wa = norm(mainArtist(want.artist ?? ''));
  const seen = new Set<string>();
  const out: (LyricsCandidate & { score: number[] })[] = [];
  for (const r of records) {
    if (!r || r.instrumental || !(r.syncedLyrics || r.plainLyrics)) continue;
    const c: LyricsCandidate = {
      id: Number(r.id) || 0, title: r.trackName ?? '', artist: r.artistName ?? '', album: r.albumName ?? '',
      duration: Number(r.duration) || 0, synced: r.syncedLyrics || null, plain: r.plainLyrics || null,
    };
    // the same song is often uploaded several times with identical text
    const key = `${norm(c.artist)}|${norm(c.title)}|${Math.round(c.duration)}|${c.synced ?? c.plain}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const dd = dur && c.duration ? Math.abs(c.duration - dur) : 0;
    const t = norm(cleanTitle(c.title)), a = norm(c.artist);
    const titleMiss = wt ? (t === wt ? 0 : t.includes(wt) || wt.includes(t) ? 1 : 2) : 0;
    const artistMiss = wa ? (a.includes(wa) || wa.includes(a) ? 0 : 1) : 0;
    const weak = titleMiss + artistMiss > 1;
    out.push({ ...c, ...(weak ? { weak } : {}), score: [dd > DURATION_TOLERANCE_S ? 1 : 0, weak ? 1 : 0, c.synced ? 0 : 1, Math.round(dd), titleMiss + artistMiss] });
  }
  out.sort((x, y) => {
    for (let i = 0; i < x.score.length; i++) if (x.score[i] !== y.score[i]) return x.score[i] - y.score[i];
    return 0;
  });
  return out.map(({ score: _s, ...c }) => c);
}

/** The candidate to use without asking: only one whose duration fits (when known). */
export function bestLyrics(ranked: LyricsCandidate[], duration?: number): LyricsCandidate | null {
  const ok = ranked.filter((c) => !c.weak && (!duration || !c.duration || Math.abs(c.duration - duration) <= DURATION_TOLERANCE_S));
  return ok[0] ?? null;
}
