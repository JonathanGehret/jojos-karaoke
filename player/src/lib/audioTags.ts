// Title and artist from an audio file's own tags, so lyrics search starts from good data
// instead of the file name. Reads only the head (and tail, for M4A) of the file.
// Formats: ID3v2 (MP3), MP4/M4A (iTunes ilst), FLAC and Ogg Vorbis/Opus comments.

export interface AudioTags { title?: string; artist?: string }

const HEAD = 512 * 1024;
const TAIL = 512 * 1024;

export async function readTags(file: Blob): Promise<AudioTags> {
  try {
    const head = new Uint8Array(await file.slice(0, HEAD).arrayBuffer());
    let t = parseTags(head);
    if (!t.title && file.size > HEAD) {
      // M4A files often keep their metadata ("moov") at the end
      t = parseMp4(new Uint8Array(await file.slice(Math.max(HEAD, file.size - TAIL)).arrayBuffer()), true);
    }
    return t;
  } catch {
    return {};
  }
}

export function parseTags(b: Uint8Array): AudioTags {
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return parseId3(b);
  if (ascii(b, 4, 4) === 'ftyp') return parseMp4(b, false);
  if (ascii(b, 0, 4) === 'fLaC' || ascii(b, 0, 4) === 'OggS') return parseVorbisComments(b);
  return {};
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const clean = (s: string | undefined) => s?.replace(/\0+$/, '').split('\0')[0].trim() || undefined;

// ---- ID3v2.2/2.3/2.4
function parseId3(b: Uint8Array): AudioTags {
  const ver = b[3];
  const syncsafe = (at: number) => (b[at] << 21) | (b[at + 1] << 14) | (b[at + 2] << 7) | b[at + 3];
  const size = Math.min(syncsafe(6) + 10, b.length);
  let p = 10;
  if (b[5] & 0x40 && ver >= 3) p += ver === 4 ? syncsafe(10) : u32(b, 10) + 4; // extended header
  const idLen = ver === 2 ? 3 : 4;
  const hdrLen = ver === 2 ? 6 : 10;
  const out: AudioTags = {};
  while (p + hdrLen <= size) {
    const id = ascii(b, p, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break; // padding
    const len = ver === 2 ? (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5] : ver === 4 ? syncsafe(p + 4) : u32(b, p + 4);
    const body = b.subarray(p + hdrLen, Math.min(p + hdrLen + len, size));
    if ((id === 'TIT2' || id === 'TT2') && !out.title) out.title = clean(id3Text(body));
    if ((id === 'TPE1' || id === 'TP1') && !out.artist) out.artist = clean(id3Text(body));
    if (out.title && out.artist) break;
    p += hdrLen + len;
  }
  return out;
}

function id3Text(body: Uint8Array): string {
  const enc = body[0];
  const data = body.subarray(1);
  if (enc === 0) return new TextDecoder('latin1').decode(data);
  if (enc === 3) return new TextDecoder('utf-8').decode(data);
  // UTF-16 with BOM (1) or big-endian without (2)
  const le = enc === 1 && data[0] === 0xff && data[1] === 0xfe;
  const start = enc === 1 ? 2 : 0;
  return new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(data.subarray(start));
}

// ---- MP4 / M4A: moov > udta > meta > ilst > (©nam | ©ART) > data
function parseMp4(b: Uint8Array, scan: boolean): AudioTags {
  const out: AudioTags = {};
  const walk = (from: number, to: number, depth: number) => {
    let p = from;
    while (p + 8 <= to && depth < 8) {
      let size = u32(b, p);
      const type = ascii(b, p + 4, 4);
      let hdr = 8;
      if (size === 1) { size = Number((BigInt(u32(b, p + 8)) << 32n) | BigInt(u32(b, p + 12))); hdr = 16; }
      if (size === 0) size = to - p;
      if (size < hdr) return;
      const end = Math.min(p + size, to);
      if (type === 'moov' || type === 'udta' || type === 'ilst') walk(p + hdr, end, depth + 1);
      else if (type === 'meta') walk(p + hdr + 4, end, depth + 1); // full box: version + flags
      else if (type === '©nam' || type === '©ART') {
        // first child "data": size, "data", type(4), locale(4), value
        if (ascii(b, p + hdr + 4, 4) === 'data') {
          const v = clean(new TextDecoder().decode(b.subarray(p + hdr + 16, end)));
          if (type === '©nam') out.title ??= v; else out.artist ??= v;
        }
      }
      p = p + size;
    }
  };
  if (!scan) { walk(0, b.length, 0); return out; }
  // tail of the file: find the "moov" box header first
  for (let i = 4; i + 4 <= b.length; i++) {
    if (b[i] === 0x6d && ascii(b, i, 4) === 'moov') { walk(i - 4, b.length, 0); break; }
  }
  return out;
}

// ---- FLAC / Ogg (Vorbis, Opus): vendor string, then "KEY=value" comments (little-endian lengths)
function parseVorbisComments(b: Uint8Array): AudioTags {
  const le32 = (at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
  let p = -1;
  if (ascii(b, 0, 4) === 'fLaC') {
    let q = 4;
    while (q + 4 <= b.length) {
      const type = b[q] & 0x7f, len = (b[q + 1] << 16) | (b[q + 2] << 8) | b[q + 3];
      if (type === 4) { p = q + 4; break; }
      if (b[q] & 0x80) break; // last block
      q += 4 + len;
    }
  } else {
    // Ogg: the comment header follows "\x03vorbis" or "OpusTags" (assumes it is not split across pages)
    for (let i = 0; i + 8 <= b.length && p < 0; i++) {
      if (b[i] === 0x4f && ascii(b, i, 8) === 'OpusTags') p = i + 8;
      else if (b[i] === 0x03 && ascii(b, i + 1, 6) === 'vorbis') p = i + 7;
    }
  }
  if (p < 0) return {};
  const out: AudioTags = {};
  const dec = new TextDecoder();
  p += 4 + le32(p);
  let n = le32(p);
  p += 4;
  while (n-- > 0 && p + 4 <= b.length) {
    const len = le32(p);
    const kv = dec.decode(b.subarray(p + 4, Math.min(p + 4 + len, b.length)));
    p += 4 + len;
    const eq = kv.indexOf('=');
    const k = kv.slice(0, eq).toUpperCase(), v = clean(kv.slice(eq + 1));
    if (k === 'TITLE') out.title ??= v;
    if (k === 'ARTIST') out.artist ??= v;
  }
  return out;
}

/** Song length in seconds from the browser's own metadata reader (no full decode); 0 if unknown. */
export function audioDuration(file: Blob, timeoutMs = 8000): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = new Audio();
    const done = (d: number) => { clearTimeout(t); URL.revokeObjectURL(url); a.removeAttribute('src'); resolve(Number.isFinite(d) ? d : 0); };
    const t = setTimeout(() => done(0), timeoutMs);
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    a.src = url;
  });
}

/** "03 - Artist - Title (Official Video).mp3" → artist and title. */
export function guessFromFilename(name: string): { title: string; artist: string } {
  const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').replace(/^\d{1,3}\s*(?:[.\-)]\s*|\s+)(?=\S)/, '').trim();
  const m = base.match(/^(.+?)\s+-\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: base };
}

/** Title and artist for a picked file: its tags, else its name. */
export async function songInfo(file: File): Promise<{ title: string; artist: string }> {
  const tags = await readTags(file);
  const guess = guessFromFilename(file.name);
  return tags.title ? { title: tags.title, artist: tags.artist ?? guess.artist } : { title: guess.title, artist: tags.artist ?? guess.artist };
}
