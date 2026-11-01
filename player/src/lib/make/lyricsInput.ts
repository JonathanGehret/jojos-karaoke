// Lyrics input: plain text and (enhanced) LRC. Same rules as maker/src/jojos_karaoke/lyrics.py.

export interface LyricLine { text: string; start?: number; wordTimes?: number[]; singer?: string }

const TS = /^\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/;
const WORD_TS = /<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>/g;
const META = /^\[([a-zA-Z#]+):(.*)\]\s*$/;
const SECTION = /^\s*(\[[^\]]*\]|\([^)]*\))\s*$/;
const SINGER = /^\s*([A-Za-z0-9]{1,16})\s*:\s+(.+)$/;

const ms = (m: string, s: string) => Math.round((parseInt(m, 10) * 60 + parseFloat(s.replace(':', '.'))) * 1000);

export function parseText(text: string, singerPrefixes = false): LyricLine[] {
  const out: LyricLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || SECTION.test(line)) continue;
    let singer: string | undefined;
    const m = singerPrefixes ? line.match(SINGER) : null;
    if (m) { singer = m[1]; line = m[2].trim(); }
    out.push({ text: line, singer });
  }
  return out;
}

export function looksLikeLrc(text: string): boolean {
  return text.split(/\r?\n/).filter((l) => TS.test(l.trim())).length >= 2;
}

export function parseLrc(text: string): LyricLine[] {
  let offset = 0;
  const out: LyricLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    const meta = line.match(META);
    if (meta && !TS.test(line)) {
      if (meta[1].toLowerCase() === 'offset') offset = parseInt(meta[2].trim(), 10) || 0;
      continue;
    }
    const stamps: number[] = [];
    let m: RegExpMatchArray | null;
    while ((m = line.match(TS))) { stamps.push(ms(m[1], m[2])); line = line.slice(m[0].length); }
    if (!stamps.length) continue;
    let wordTimes: number[] | undefined;
    const tags = [...line.matchAll(WORD_TS)];
    if (tags.length) {
      wordTimes = [];
      const words: string[] = [];
      tags.forEach((t, k) => {
        const chunk = line.slice(t.index! + t[0].length, k + 1 < tags.length ? tags[k + 1].index : line.length).trim();
        chunk.split(/\s+/).filter(Boolean).forEach((w, i) => { wordTimes!.push(i === 0 ? ms(t[1], t[2]) : -1); words.push(w); });
      });
      line = words.join(' ');
      if (!words.length) continue;
    }
    const t = line.trim();
    if (!t || SECTION.test(t)) continue;
    for (const st of stamps) {
      const d = st - stamps[0];
      out.push({ text: t, start: Math.max(0, st - offset), wordTimes: wordTimes?.map((x) => (x >= 0 ? x - offset + d : -1)) });
    }
  }
  return out.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
}

export function parseLyrics(text: string, singerPrefixes = false): LyricLine[] {
  return looksLikeLrc(text) ? parseLrc(text) : parseText(text, singerPrefixes);
}
