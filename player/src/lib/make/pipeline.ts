// Song file → karaoke package, entirely in the browser. Mirrors maker/src/jojos_karaoke/pipeline.py.

import type { Lyrics } from '$shared/lyrics';
import { api } from '../api';
import { assemble, fromLrcTimings, fromVoiceActivity, splitIntoLines, voicedRegions, type TimedWord } from './align';
import { decodeFile, encodeOpus, toMono16k } from './encode';
import { type LyricLine, parseLrc, parseLyrics, parseText } from './lyricsInput';
import { INST_HQ_3, type MdxConfig } from './mdx';
import type { FromWorker, ToWorker } from './protocol';

export const SEPARATION_MODEL = { name: 'UVR-MDX-NET-Inst_HQ_3.onnx', sizeMb: 67, config: INST_HQ_3 };
export const ASR_MODELS = { en: 'Xenova/whisper-tiny.en', multi: 'Xenova/whisper-small' };

export interface MakeOptions {
  title: string;
  artist: string;
  lyricsText?: string;
  language?: string;           // 'en', 'de', … or undefined = auto
  separate?: boolean;          // default true
  asr?: boolean;               // use speech recognition for word timing (default true)
  lookup?: boolean;            // LRCLIB via the server (default true)
  token?: string | null;       // library token (optional; lookup works without one)
  duets?: boolean;
  modelUrl?: string;           // override the separation model (tests, experiments)
  modelConfig?: MdxConfig;
  asrModel?: string;
  onProgress?: (stage: string, pct: number, detail?: string) => void;
  signal?: AbortSignal;
}

export interface MadeSong {
  manifest: any;
  lyrics: Lyrics;
  files: Record<string, Uint8Array>;   // instrumental.opus, vocals.opus?
  warnings: string[];
  backend: string;
}

const WEIGHTS: Record<string, [number, number]> = {
  decode: [0, 3], download: [3, 10], load: [3, 10], separate: [10, 70], lyrics: [70, 72], transcribe: [72, 90], encode: [90, 100],
};

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

class WorkerClient {
  private w: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, { res: (m: FromWorker) => void; rej: (e: Error) => void; onProgress?: (m: FromWorker) => void }>();

  private worker() {
    if (!this.w) {
      this.w = new Worker(new URL('./make.worker.ts', import.meta.url), { type: 'module' });
      this.w.onmessage = (e: MessageEvent<FromWorker>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        if (e.data.type === 'progress') return p.onProgress?.(e.data);
        this.pending.delete(e.data.id);
        if (e.data.type === 'error') p.rej(new Error(e.data.message));
        else p.res(e.data);
      };
      this.w.onerror = (e) => { for (const p of this.pending.values()) p.rej(new Error(e.message || 'worker crashed')); this.pending.clear(); this.w = null; };
    }
    return this.w;
  }

  /** Rejects if the worker goes quiet for `idleMs` (no result and no progress). */
  call(msg: WithoutId<ToWorker>, transfer: Transferable[], onProgress?: (m: FromWorker) => void, signal?: AbortSignal,
    idleMs = 180_000): Promise<FromWorker> {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      let timer = 0;
      const arm = () => {
        clearTimeout(timer);
        timer = window.setTimeout(() => {
          this.terminate();
          rej(new Error('The AI worker stopped responding. Reload the page and try again.'));
        }, idleMs);
      };
      arm();
      this.pending.set(id, {
        res: (m) => { clearTimeout(timer); res(m); },
        rej: (e) => { clearTimeout(timer); rej(e); },
        onProgress: (m) => { arm(); onProgress?.(m); },
      });
      signal?.addEventListener('abort', () => { this.terminate(); rej(new DOMException('cancelled', 'AbortError')); });
      this.worker().postMessage({ ...msg, id }, transfer);
    });
  }

  terminate() {
    this.w?.terminate();
    this.w = null;
    for (const p of this.pending.values()) p.rej(new Error('stopped'));
    this.pending.clear();
  }
}

export const makerWorker = new WorkerClient();

export function slugify(s: string): string {
  return s.normalize('NFKD').replace(/[^\x00-\x7f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'song';
}

async function songId(title: string, artist: string, data: ArrayBuffer) {
  const head = new Uint8Array(data, 0, Math.min(data.byteLength, 1 << 20));
  const key = new TextEncoder().encode(`${artist}\0${title}\0`);
  const all = new Uint8Array(key.length + head.length);
  all.set(key); all.set(head, key.length);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-1', all));
  const hex = [...h.slice(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${slugify(artist ? `${artist} ${title}` : title)}-${hex}`;
}

/** Guess artist/title from "Artist - Title.mp3". */
export function guessFromFilename(name: string): { title: string; artist: string } {
  const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const m = base.match(/^(.+?)\s+-\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: base };
}

export async function makeSong(file: Blob, o: MakeOptions): Promise<MadeSong> {
  const warnings: string[] = [];
  const prog = (stage: string, frac: number, detail?: string) => {
    const [a, b] = WEIGHTS[stage] ?? [0, 100];
    o.onProgress?.(stage, Math.round(a + (b - a) * Math.min(1, frac)), detail);
  };
  let backend = 'none';
  prog('decode', 0);
  const data = await file.arrayBuffer();
  const { left, right, sampleRate } = await decodeFile(data.slice(0));
  const durationMs = Math.round((left.length / sampleRate) * 1000);
  if (durationMs < 1000) throw new Error('That file is too short to be a song.');
  prog('decode', 1);
  o.signal?.throwIfAborted();

  // 1. vocal separation
  let inst: [Float32Array, Float32Array] = [left, right];
  let voc: [Float32Array, Float32Array] | null = null;
  if (o.separate !== false) {
    const m = await makerWorker.call({ type: 'separate', left: left.slice(), right: right.slice(),
      modelUrl: o.modelUrl ?? `/api/models/${SEPARATION_MODEL.name}`, config: o.modelConfig ?? SEPARATION_MODEL.config },
    [], (p) => p.type === 'progress' && prog(p.stage, p.frac, p.detail), o.signal);
    if (m.type !== 'separated') throw new Error('separation failed');
    inst = [m.instL, m.instR];
    voc = [m.vocL, m.vocR];
    backend = m.backend;
  }
  o.signal?.throwIfAborted();

  // 2. lyrics
  prog('lyrics', 0);
  let lines: LyricLine[] = [];
  let source: 'user' | 'lrclib' | 'transcribed' | 'none' = 'none';
  if (o.lyricsText?.trim()) {
    lines = parseLyrics(o.lyricsText, o.duets);
    source = 'user';
  } else if (o.lookup !== false && o.title) {
    try {
      const q = new URLSearchParams({ title: o.title, artist: o.artist, duration: String(Math.round(durationMs / 1000)) });
      const r = await api<{ synced: string | null; plain: string | null }>(`/api/lyrics?${q}`, { token: o.token, timeout: 15000 });
      if (r.synced) { lines = parseLrc(r.synced); source = 'lrclib'; }
      else if (r.plain) { lines = parseText(r.plain); source = 'lrclib'; }
      else warnings.push('No lyrics found online.');
    } catch { warnings.push('Lyrics lookup failed.'); }
  }
  prog('lyrics', 1);

  // 3. timing
  const vocalsMono16 = await toMono16k(...(voc ?? inst), sampleRate);
  let lyrics: Lyrics = { version: 1, lines: [] };
  let words: TimedWord[] | null = null;
  if (o.asr !== false && (lines.length || source === 'none')) {
    try {
      const model = o.asrModel ?? (o.language && o.language !== 'en' ? ASR_MODELS.multi : ASR_MODELS.en);
      const m = await makerWorker.call({ type: 'transcribe', audio: vocalsMono16.slice(), model, language: o.language }, [],
        (p) => p.type === 'progress' && prog(p.stage, p.frac, p.detail), o.signal);
      if (m.type === 'transcribed') words = m.words;
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      warnings.push(`Speech recognition failed (${(e as Error).message}); using simpler timing.`);
    }
  }
  if (lines.length && words?.length) {
    lyrics = assemble(lines, words, durationMs);
  } else if (!lines.length && words?.length) {
    const groups = splitIntoLines(words);
    lyrics = assemble(groups.map((g) => ({ text: g.map((w) => w.text).join(' ') })), words, durationMs);
    source = 'transcribed';
  } else if (lines.length && lines.every((l) => l.start != null)) {
    lyrics = fromLrcTimings(lines, durationMs);
    warnings.push('Word timing estimated from line timestamps.');
  } else if (lines.length) {
    lyrics = fromVoiceActivity(lines, voicedRegions(vocalsMono16, 16000), durationMs);
    warnings.push('Timing guessed from where vocals are audible. Check it in the editor.');
  } else {
    warnings.push('No lyrics: the song plays without words.');
  }
  prog('transcribe', 1);
  o.signal?.throwIfAborted();

  // 4. encode
  prog('encode', 0);
  const files: Record<string, Uint8Array> = { 'instrumental.opus': await encodeOpus(inst[0], inst[1], sampleRate, 128000) };
  prog('encode', 0.6);
  if (voc) files['vocals.opus'] = await encodeOpus(voc[0], voc[1], sampleRate, 96000);
  prog('encode', 1);

  const id = await songId(o.title, o.artist, data);
  const manifest: any = {
    formatVersion: 1, id, title: o.title.slice(0, 200), artist: (o.artist ?? '').slice(0, 200), durationMs,
    lyricsSource: source, createdAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    maker: `jojos-karaoke web; ${voc ? SEPARATION_MODEL.name : 'none'}; ${backend}`,
    files: { instrumental: 'instrumental.opus', lyrics: 'lyrics.json', ...(voc ? { vocals: 'vocals.opus' } : {}) },
  };
  if (o.language) manifest.language = o.language;
  return { manifest, lyrics, files, warnings, backend };
}

/** Upload to the online library (same endpoints as `jojo make --upload`). */
export async function uploadSong(token: string, song: MadeSong): Promise<string> {
  const id = song.manifest.id;
  for (const [name, data] of Object.entries(song.files)) {
    await api(`/api/library/songs/${id}/files/${name}`, { method: 'PUT', token, body: data as BodyInit,
      headers: { 'content-type': 'audio/ogg' }, timeout: 300_000 });
  }
  await api(`/api/library/songs/${id}/files/lyrics.json`, { method: 'PUT', token, body: JSON.stringify(song.lyrics) });
  await api(`/api/library/songs/${id}/commit`, { method: 'POST', token, body: JSON.stringify(song.manifest) });
  return id;
}
