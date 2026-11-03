// Song file → karaoke package, entirely in the browser. Mirrors maker/src/jojos_karaoke/pipeline.py.

import type { Lyrics } from '$shared/lyrics';
import { api } from '../api';
import { assemble, fromLrcTimings, fromVoiceActivity, splitIntoLines, tokenize, voicedRegions, type TimedWord } from './align';
import { decodeFile, encodeOpus, resample, toMono16k } from './encode';
import { ProgressiveAligner } from './progressive';
import { type LyricLine, parseLrc, parseLyrics, parseText } from './lyricsInput';
import { INST_HQ_3, type MdxConfig } from './mdx';
import type { FromWorker, ToWorker } from './protocol';

export const SEPARATION_MODEL = { name: 'UVR-MDX-NET-Inst_HQ_3.onnx', sizeMb: 67, config: INST_HQ_3 };
export const ASR_MODELS = { en: 'Xenova/whisper-tiny.en', multi: 'Xenova/whisper-small' };
/** Forced alignment of known lyrics (English letters; other languages use speech recognition). */
export const ALIGN_MODEL = 'Xenova/wav2vec2-base-960h';

/** Can the English character model align these lyrics? (mostly Latin letters, English or unset) */
export function alignable(lines: LyricLine[], language?: string): boolean {
  if (language && language !== 'en') return false;
  const toks = lines.flatMap((l) => tokenize(l.text));
  const latin = toks.filter((t) => /[a-z]/i.test(t.normalize('NFKD'))).length;
  return toks.length > 0 && latin / toks.length >= 0.8;
}

export interface MakeOptions {
  title: string;
  artist: string;
  lyricsText?: string;
  lyricsSource?: 'user' | 'lrclib'; // where lyricsText came from (the lyrics finder fills it from LRCLIB)
  language?: string;           // 'en', 'de', … or undefined = auto
  separate?: boolean;          // default true
  asr?: boolean;               // use speech recognition for word timing (default true)
  lookup?: boolean;            // LRCLIB via the server (default true)
  token?: string | null;       // library token (optional; lookup works without one)
  duets?: boolean;
  modelUrl?: string;           // override the separation model (tests, experiments)
  modelConfig?: MdxConfig;
  asrModel?: string;
  alignModel?: string;          // forced-alignment model (Hugging Face id)
  onProgress?: (stage: string, pct: number, detail?: string) => void;
  /** Audio (and line-timed lyrics, when synced lyrics were given) while the song is still being
   *  made, so it can start playing early. Not called when vocals aren't removed. */
  onEarly?: (e: EarlySong) => void;
  signal?: AbortSignal;
}

/** A song that is still being made: `ready` frames of the full-length arrays are final. */
export interface EarlySong {
  sampleRate: number;
  durationMs: number;
  /** frames that are final (grows; equals the length when separation is done) */
  ready: number;
  /** performance.now() when separation started (to measure its speed) */
  startedAt: number;
  inst: [Float32Array, Float32Array];
  voc: [Float32Array, Float32Array];
  /** word-timed lyrics for the lines whose timing is final, or null (none yet / none possible) */
  lyrics: Lyrics | null;
  /** word timing is final up to here (ms): playback must stay behind it */
  alignedMs: number;
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
        if (e.data.type === 'progress' || e.data.type === 'part') return p.onProgress?.(e.data);
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
export { guessFromFilename } from '../audioTags';

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

  // lyrics lookup (online); started right away when the song may play early, so the timing
  // can start while vocals are still being removed
  type Found = { lines: LyricLine[]; source: 'lrclib' | 'none'; warning?: string };
  const lookup = async (): Promise<Found> => {
    try {
      const q = new URLSearchParams({ title: o.title, artist: o.artist, duration: String(Math.round(durationMs / 1000)) });
      const r = await api<{ synced: string | null; plain: string | null }>(`/api/lyrics?${q}`, { token: o.token, timeout: 30000 });
      if (r.synced) return { lines: parseLrc(r.synced), source: 'lrclib' };
      if (r.plain) return { lines: parseText(r.plain), source: 'lrclib' };
      return { lines: [], source: 'none', warning: 'No lyrics found online.' };
    } catch { return { lines: [], source: 'none', warning: 'Lyrics lookup failed.' }; }
  };
  const given = o.lyricsText?.trim() ? parseLyrics(o.lyricsText, o.duets) : null;
  const canLookup = !given && o.lookup !== false && !!o.title;
  const lookupEarly = o.onEarly && o.separate !== false && canLookup ? lookup() : null;

  // 1. vocal separation
  let inst: [Float32Array, Float32Array] = [left, right];
  let voc: [Float32Array, Float32Array] | null = null;
  // early playback: the audio arrives in parts, and the word timing is worked out alongside
  let early: EarlySong | null = null;
  let aligner: ProgressiveAligner | null = null;
  let alignerLines: LyricLine[] | null = null;
  if (o.separate !== false) {
    const emit = () => {
      if (!early) return;
      early.lyrics = aligner && !aligner.failed ? aligner.lyrics() : null;
      early.alignedMs = aligner && !aligner.failed ? aligner.alignedMs : 0;
      try { o.onEarly?.(early); } catch { /* early playback must never break making the song */ }
    };
    const feed = () => {
      if (!early || !aligner) return;
      aligner.feed(early.voc[0], early.voc[1], early.ready).then(emit);
    };
    const startAligner = (ls: LyricLine[]) => {
      // exact word timing while making needs synced lyrics; otherwise the song waits until done
      if (!early || o.asr === false || !ProgressiveAligner.supports(ls) || !alignable(ls, o.language)) return;
      alignerLines = ls;
      aligner = new ProgressiveAligner(ls, sampleRate, left.length, durationMs, async (audio) => {
        const r = await makerWorker.call({ type: 'logits', audio, model: o.alignModel ?? ALIGN_MODEL }, [audio.buffer], undefined, o.signal);
        if (r.type !== 'logits') throw new Error('alignment failed');
        return r;
      }, async (mono, from) => (await resample([mono], from, 16000))[0]);
      feed();
    };
    if (o.onEarly) {
      const n = left.length;
      early = { sampleRate, durationMs, ready: 0, startedAt: performance.now(),
        inst: [new Float32Array(n), new Float32Array(n)], voc: [new Float32Array(n), new Float32Array(n)],
        lyrics: null, alignedMs: 0 };
      if (given) startAligner(given);
      else lookupEarly?.then((f) => { if (!aligner) startAligner(f.lines); });
    }
    const m = await makerWorker.call({ type: 'separate', left: left.slice(), right: right.slice(),
      modelUrl: o.modelUrl ?? `/api/models/${SEPARATION_MODEL.name}`, config: o.modelConfig ?? SEPARATION_MODEL.config,
      parts: !!early },
    [], (p) => {
      if (p.type === 'progress') prog(p.stage, p.frac, p.detail);
      else if (p.type === 'part' && early) {
        early.inst[0].set(p.instL, p.from); early.inst[1].set(p.instR, p.from);
        early.voc[0].set(p.vocL, p.from); early.voc[1].set(p.vocR, p.from);
        early.ready = p.from + p.instL.length;
        emit();
        feed();
      }
    }, o.signal);
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
  if (given) {
    lines = given;
    source = o.lyricsSource ?? 'user';
  } else if (canLookup) {
    const f = await (lookupEarly ?? lookup());
    lines = f.lines;
    if (f.source === 'lrclib') source = 'lrclib';
    if (f.warning) warnings.push(f.warning);
  }
  prog('lyrics', 1);

  // 3. timing
  const vocalsMono16 = await toMono16k(...(voc ?? inst), sampleRate);
  let lyrics: Lyrics = { version: 1, lines: [] };
  let words: TimedWord[] | null = null;
  // early playback already worked the timing out piece by piece: that is the timing
  // (set in callbacks: TypeScript can't see that)
  const al = aligner as ProgressiveAligner | null;
  const alLines = alignerLines as LyricLine[] | null;
  const ear = early as EarlySong | null;
  if (al && ear && alLines === lines) {
    await al.feed(ear.voc[0], ear.voc[1], left.length);
    const placed = al.words();
    const tokens = lines.flatMap((l) => tokenize(l.text)).length;
    if (al.complete && placed.length >= tokens * 0.5) {
      words = placed;
      backend = `${backend}; ctc-progressive`;
    }
  }
  // known lyrics: forced alignment finds where each word is sung (much tighter than ASR timestamps)
  if (!words && o.asr !== false && lines.length && alignable(lines, o.language)) {
    try {
      const tokens = lines.flatMap((l) => tokenize(l.text));
      const m = await makerWorker.call({ type: 'align', audio: vocalsMono16.slice(), model: o.alignModel ?? ALIGN_MODEL, tokens }, [],
        (p) => p.type === 'progress' && prog(p.stage, p.frac, p.detail), o.signal);
      if (m.type === 'aligned') {
        const found = m.words.filter(Boolean).length;
        if (found >= tokens.length * 0.5) {
          words = m.words.flatMap((w, i) => (w ? [{ text: tokens[i], ...w }] : []));
          backend = `${backend}; ctc:${m.backend}`;
        } else warnings.push(`Word alignment placed only ${found} of ${tokens.length} words; trying speech recognition.`);
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      warnings.push(`Word alignment failed (${(e as Error).message}); trying speech recognition.`);
    }
  }
  if (!words && o.asr !== false && (lines.length || source === 'none')) {
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
