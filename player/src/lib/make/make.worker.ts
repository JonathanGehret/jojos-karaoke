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
  const res = await separate(m.left, m.right, async (spec) => {
    const out = await s.run({ [input]: new ort.Tensor('float32', spec, [1, 4, dimF, dimT]) });
    return out[output].data as Float32Array;
  }, m.config, (frac) => post({ id: m.id, type: 'progress', stage: 'separate', frac }));
  post({ id: m.id, type: 'separated', ...res, backend },
    [res.instL.buffer, res.instR.buffer, res.vocL.buffer, res.vocR.buffer]);
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
    let fromNetwork = false; // transformers.js reports 'download' only for files not in its cache
    const p = await tf.pipeline('automatic-speech-recognition', m.model, {
      device: gpu ? 'webgpu' : 'wasm',
      dtype: gpu ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } as any : 'q8',
      progress_callback: (e: any) => {
        if (e.status === 'download') fromNetwork = true;
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

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    if (m.type === 'separate') await doSeparate(m);
    else if (m.type === 'transcribe') await doTranscribe(m);
  } catch (err) {
    post({ id: m.id, type: 'error', message: (err as Error)?.message ?? String(err) });
  }
};
