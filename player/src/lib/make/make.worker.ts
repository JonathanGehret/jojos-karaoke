/// <reference lib="webworker" />
// Heavy lifting off the main thread: vocal separation (ONNX Runtime Web) and speech
// recognition with word timestamps (transformers.js Whisper). WebGPU when the browser has
// it, otherwise WebAssembly on the CPU.

import * as ort from 'onnxruntime-web/webgpu';
import { separate } from './mdx';
import type { FromWorker, ToWorker } from './protocol';
import type { TimedWord } from './align';

declare const self: DedicatedWorkerGlobalScope;

const RUNTIME = `/api/runtime/${ort.env.versions.web}/`;
ort.env.wasm.wasmPaths = RUNTIME;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;

const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, transfer);

async function hasWebGpu(): Promise<boolean> {
  try { return !!(await (navigator as any).gpu?.requestAdapter()); } catch { return false; }
}

const MODEL_CACHE = 'jojo-models-v1';

/** The model from this device's cache if it's there, otherwise downloaded with progress and
 *  kept (Cache Storage, not the HTTP cache, so we know whether it's already here). */
async function download(url: string, id: number): Promise<Uint8Array> {
  const cache = await caches.open(MODEL_CACHE).catch(() => null);
  const hit = await cache?.match(url).catch(() => undefined);
  if (hit) {
    post({ id, type: 'progress', stage: 'load', frac: 0.5 });
    return new Uint8Array(await hit.arrayBuffer());
  }
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`could not download the model (${r.status})`);
  const total = Number(r.headers.get('content-length')) || 0;
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0, lastPost = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (total && Date.now() - lastPost > 200) {
      lastPost = Date.now();
      post({ id, type: 'progress', stage: 'download', frac: got / total, detail: `${Math.round(got / 1e6)} / ${Math.round(total / 1e6)} MB` });
    }
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  // storage full or private mode: still works, just downloads again next time
  await cache?.put(url, new Response(out.slice(), { headers: { 'content-type': 'application/octet-stream' } })).catch(() => {});
  return out;
}

let session: { url: string; s: ort.InferenceSession; backend: string } | null = null;

async function getSession(url: string, id: number) {
  if (session?.url === url) return session;
  const bytes = await download(url, id);
  const gpu = await hasWebGpu();
  const providers = gpu ? ['webgpu', 'wasm'] : ['wasm'];
  const s = await ort.InferenceSession.create(bytes, { executionProviders: providers, graphOptimizationLevel: 'all' });
  session = { url, s, backend: gpu ? 'webgpu' : 'wasm' };
  return session;
}

async function doSeparate(m: Extract<ToWorker, { type: 'separate' }>) {
  const { s, backend } = await getSession(m.modelUrl, m.id);
  const { dimF, dimT } = m.config;
  const input = s.inputNames[0], output = s.outputNames[0];
  let sent = 0;
  const res = await separate(m.left, m.right, async (spec) => {
    const out = await s.run({ [input]: new ort.Tensor('float32', spec, [1, 4, dimF, dimT]) });
    return out[output].data as Float32Array;
  }, m.config, (frac) => post({ id: m.id, type: 'progress', stage: 'separate', frac }), 0.25,
  m.parts ? (done, out) => {
    // finished audio while separating, so a song can start playing before it is done
    const from = sent;
    const sl = (a: Float32Array) => a.slice(from, done);
    const p = { instL: sl(out.instL), instR: sl(out.instR), vocL: sl(out.vocL), vocR: sl(out.vocR) };
    sent = done;
    post({ id: m.id, type: 'part', from, ...p }, [p.instL.buffer, p.instR.buffer, p.vocL.buffer, p.vocR.buffer]);
  } : undefined);
  post({ id: m.id, type: 'separated', ...res, backend },
    [res.instL.buffer, res.instR.buffer, res.vocL.buffer, res.vocR.buffer]);
}

/** Is this Hugging Face model already in transformers.js' browser cache? (It reports
 *  "download" even when it reads from there, so the page would say "Downloading" every time.) */
async function hfCached(model: string): Promise<boolean> {
  try {
    const keys = await (await caches.open('transformers-cache')).keys();
    return keys.some((r) => r.url.includes(`/${model}/`) && r.url.endsWith('.onnx'));
  } catch { return false; }
}

let asr: { model: string; p: any; backend: string } | null = null;

async function doTranscribe(m: Extract<ToWorker, { type: 'transcribe' }>) {
  const tf = await import('@huggingface/transformers');
  tf.env.allowLocalModels = false;
  // speech models come through our server (cached in R2), not straight from huggingface.co
  tf.env.remoteHost = `${self.location.origin}/api/hf/`;
  (tf.env.backends.onnx as any).wasm.wasmPaths = RUNTIME;
  if (asr?.model !== m.model) {
    const gpu = await hasWebGpu();
    const files = new Map<string, number>();
    const fromNetwork = !(await hfCached(m.model));
    const p = await tf.pipeline('automatic-speech-recognition', m.model, {
      device: gpu ? 'webgpu' : 'wasm',
      dtype: gpu ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } as any : 'q8',
      progress_callback: (e: any) => {
        if (e.status === 'progress' && e.file) {
          files.set(e.file, e.progress ?? 0);
          const avg = [...files.values()].reduce((a, b) => a + b, 0) / (files.size * 100);
          post({ id: m.id, type: 'progress', stage: fromNetwork ? 'download' : 'load', frac: avg, detail: 'speech model' });
        }
      },
    });
    asr = { model: m.model, p, backend: gpu ? 'webgpu' : 'wasm' };
  }
  post({ id: m.id, type: 'progress', stage: 'transcribe', frac: 0.05 });
  const opts: any = { chunk_length_s: 30, stride_length_s: 5, return_timestamps: 'word' };
  if (m.language && !m.model.endsWith('.en')) { opts.language = m.language; opts.task = 'transcribe'; }
  let out: any;
  let wordLevel = true;
  try {
    out = await asr.p(m.audio, opts);
  } catch (e) {
    // models without alignment heads can't do word timestamps; fall back to segments
    if (!String(e).includes('alignment_heads')) throw e;
    wordLevel = false;
    out = await asr.p(m.audio, { ...opts, return_timestamps: true });
  }
  const words: TimedWord[] = [];
  for (const c of out.chunks ?? []) {
    const [s, e] = c.timestamp as [number, number | null];
    const text = String(c.text).trim();
    if (!text) continue;
    if (wordLevel) { words.push({ text, start: Math.round(s * 1000), end: Math.round((e ?? s + 0.3) * 1000), score: 0.8 }); continue; }
    const toks = text.split(/\s+/);
    const span = ((e ?? s + toks.length * 0.4) - s) * 1000;
    toks.forEach((t, i) => words.push({ text: t, start: Math.round(s * 1000 + (span * i) / toks.length),
      end: Math.round(s * 1000 + (span * (i + 1)) / toks.length), score: 0.3 }));
  }
  post({ id: m.id, type: 'transcribed', words, backend: asr.backend });
}

// ---- forced alignment (wav2vec2 CTC): where each word of known lyrics is sung
interface Ctc { model: string; m: any; vocab: Record<string, number>; backend: string }
let ctc: Ctc | null = null;
const CTC_FRAME_MS = 20; // wav2vec2 emits one frame per 320 samples at 16 kHz
const CHUNK_S = 30, CONTEXT_S = 1;

let ctcLoading: Promise<Ctc> | null = null;

/** The forced-alignment model (loaded once; several calls may ask at the same time). */
async function getCtc(model: string, id: number): Promise<Ctc> {
  if (ctc?.model === model) return ctc;
  if (!ctcLoading) ctcLoading = (async () => {
    const tf = await import('@huggingface/transformers');
    tf.env.allowLocalModels = false;
    tf.env.remoteHost = `${self.location.origin}/api/hf/`;
    (tf.env.backends.onnx as any).wasm.wasmPaths = RUNTIME;
    // GPU only with half precision (189 MB); otherwise the 8-bit model on the CPU (95 MB):
    // the full-precision GPU model would be a 378 MB download
    const adapter = await (navigator as any).gpu?.requestAdapter().catch(() => null);
    const f16 = !!adapter?.features?.has('shader-f16');
    const files = new Map<string, number>();
    const fromNetwork = !(await hfCached(model));
    const m = await tf.AutoModelForCTC.from_pretrained(model, {
      device: f16 ? 'webgpu' : 'wasm', dtype: f16 ? 'fp16' : 'q8',
      progress_callback: (e: any) => {
        if (e.status === 'progress' && e.file) {
          files.set(e.file, e.progress ?? 0);
          const avg = [...files.values()].reduce((a, b) => a + b, 0) / (files.size * 100);
          post({ id, type: 'progress', stage: fromNetwork ? 'download' : 'load', frac: avg, detail: 'timing model' });
        }
      },
    } as any);
    const vocab = await (await fetch(`${tf.env.remoteHost}${model}/resolve/main/vocab.json`)).json();
    ctc = { model, m, vocab, backend: f16 ? 'webgpu' : 'wasm' };
    return ctc;
  })().finally(() => { ctcLoading = null; });
  return ctcLoading;
}

/** Character probabilities for one piece of audio (16 kHz mono), for aligning while a song is
 *  still being made. Normalised per piece, like the model's own feature extractor does. */
async function doLogits(m: Extract<ToWorker, { type: 'logits' }>) {
  const c = await getCtc(m.model, m.id);
  const tf = await import('@huggingface/transformers');
  const x = m.audio;
  let mean = 0;
  for (let i = 0; i < x.length; i++) mean += x[i];
  mean /= x.length || 1;
  let v = 0;
  for (let i = 0; i < x.length; i++) v += (x[i] - mean) ** 2;
  const sd = Math.sqrt(v / (x.length || 1) + 1e-7);
  const seg = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) seg[i] = (x[i] - mean) / sd;
  const out = await c.m({ input_values: new tf.Tensor('float32', seg, [1, seg.length]) });
  const lg = out.logits;
  const logits = (lg.data as Float32Array).slice();
  const frames = lg.dims[1], V = lg.dims[2];
  lg.dispose?.();
  post({ id: m.id, type: 'logits', logits, frames, V, vocab: c.vocab, backend: c.backend }, [logits.buffer]);
}

async function doAlign(m: Extract<ToWorker, { type: 'align' }>) {
  const tf = await import('@huggingface/transformers');
  const ctc = await getCtc(m.model, m.id);
  const { charIds, forcedAlign, logSoftmax } = await import('./ctc');
  // zero mean, unit variance over the whole track (the model's feature extractor does this)
  const x = m.audio;
  let mean = 0;
  for (let i = 0; i < x.length; i++) mean += x[i];
  mean /= x.length || 1;
  let v = 0;
  for (let i = 0; i < x.length; i++) v += (x[i] - mean) ** 2;
  const sd = Math.sqrt(v / (x.length || 1) + 1e-7);
  // run the model in chunks with a little context on both sides, keep the middle frames
  const sr = 16000, step = CHUNK_S * sr, ctxS = CONTEXT_S * sr;
  const totalFrames = Math.floor(x.length / 320);
  const V = Object.keys(ctc.vocab).length;
  const logits = new Float32Array(totalFrames * V);
  for (let a = 0; a < x.length; a += step) {
    const from = Math.max(0, a - ctxS), to = Math.min(x.length, a + step + ctxS);
    const seg = new Float32Array(to - from);
    for (let i = 0; i < seg.length; i++) seg[i] = (x[from + i] - mean) / sd;
    const out = await ctc.m({ input_values: new tf.Tensor('float32', seg, [1, seg.length]) });
    const lg = out.logits; // [1, frames, V]
    const data = lg.data as Float32Array;
    const n = lg.dims[1];
    const skip = Math.round((a - from) / 320);
    const keep = Math.min(Math.round(step / 320), totalFrames - Math.round(a / 320), n - skip);
    const dst = Math.round(a / 320);
    for (let f = 0; f < keep; f++) logits.set(data.subarray((skip + f) * V, (skip + f + 1) * V), (dst + f) * V);
    lg.dispose?.();
    post({ id: m.id, type: 'progress', stage: 'transcribe', frac: 0.1 + 0.8 * Math.min(1, (a + step) / x.length) });
  }
  logSoftmax(logits, totalFrames, V);
  const words = forcedAlign(logits, totalFrames, V, m.tokens.map((t) => charIds(t, ctc!.vocab)), ctc.vocab['<pad>'] ?? 0, ctc.vocab['|'] ?? -1)
    .map((w) => w && { start: w.start * CTC_FRAME_MS, end: w.end * CTC_FRAME_MS, score: w.score });
  post({ id: m.id, type: 'aligned', words, backend: ctc.backend });
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    if (m.type === 'separate') await doSeparate(m);
    else if (m.type === 'transcribe') await doTranscribe(m);
    else if (m.type === 'align') await doAlign(m);
    else if (m.type === 'logits') await doLogits(m);
  } catch (err) {
    post({ id: m.id, type: 'error', message: (err as Error)?.message ?? String(err) });
  }
};
