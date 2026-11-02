// Large browser-maker assets served same-origin from R2:
// - ONNX Runtime WebAssembly files (too big for Workers static assets), uploaded at deploy
//   time by scripts/upload-runtime.mjs
// - AI models, fetched once from their upstream and cached in R2

import { type LrclibRecord, bestLyrics, cleanTitle, mainArtist, rankLyrics } from '../../shared/lyricsSearch';
import { type Env, HttpError } from './util';

const RUNTIME_FILE = /^ort-wasm-simd-threaded(\.(jsep|asyncify|jspi))?\.(wasm|mjs)$/;
const VERSION = /^[0-9A-Za-z.-]{1,60}$/;

export const MODELS: Record<string, string> = {
  'UVR-MDX-NET-Inst_HQ_3.onnx':
    'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Inst_HQ_3.onnx',
};

const immutable = 'public, max-age=31536000, immutable';

// Speech models for transformers.js, proxied from Hugging Face and cached in R2: fetching them
// straight from huggingface.co in the browser failed with CORS errors when HF had a bad moment.
export const HF_REPOS = new Set(['Xenova/whisper-tiny.en', 'Xenova/whisper-small', 'Xenova/wav2vec2-base-960h']);
const HF_FILE = /^(onnx\/)?[\w.-]{1,100}\.(json|onnx|txt|model)$/;

export async function serveRuntime(env: Env, version: string, file: string, head = false): Promise<Response> {
  if (!VERSION.test(version) || !RUNTIME_FILE.test(file)) throw new HttpError(404, 'not found');
  const key = `runtime/${version}/${file}`;
  const obj = head ? await env.LIBRARY.head(key) : await env.LIBRARY.get(key);
  if (!obj) throw new HttpError(404, `runtime ${version}/${file} is not uploaded (run npm run upload-runtime)`);
  return new Response(head ? null : (obj as R2ObjectBody).body, { headers: {
    'content-type': file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
    'cache-control': immutable, 'content-length': String(obj.size), 'cross-origin-resource-policy': 'same-origin',
    // ONNX Runtime starts its threads as workers from this script; inside a cross-origin
    // isolated page a worker script must carry the same isolation headers or it is blocked
    'cross-origin-embedder-policy': 'credentialless', 'cross-origin-opener-policy': 'same-origin',
  } });
}

export async function serveModel(env: Env, ctx: ExecutionContext, name: string): Promise<Response> {
  const upstream = MODELS[name];
  if (!upstream) throw new HttpError(404, 'unknown model');
  return cached(env, ctx, `models/${name}`, upstream, 'application/octet-stream');
}

/** /api/hf/<org>/<repo>/resolve/main/<file>: an allow-listed Hugging Face file, cached in R2. */
export async function serveHf(env: Env, ctx: ExecutionContext, parts: string[]): Promise<Response> {
  const [org, repo, resolve, rev, ...rest] = parts;
  const file = rest.join('/');
  if (!HF_REPOS.has(`${org}/${repo}`) || resolve !== 'resolve' || rev !== 'main' || !HF_FILE.test(file)) {
    throw new HttpError(404, 'not found');
  }
  const type = file.endsWith('.json') ? 'application/json' : 'application/octet-stream';
  return cached(env, ctx, `models/hf/${org}/${repo}/${file}`, `https://huggingface.co/${org}/${repo}/resolve/main/${file}`, type);
}

async function cached(env: Env, ctx: ExecutionContext, key: string, upstream: string, type: string): Promise<Response> {
  const headers = { 'content-type': type, 'cache-control': immutable };
  const obj = await env.LIBRARY.get(key);
  if (obj) return new Response(obj.body, { headers: { ...headers, 'content-length': String(obj.size) } });

  let r = await fetch(upstream, { redirect: 'follow' });
  if (r.status === 429 || r.status >= 500) r = await fetch(upstream, { redirect: 'follow' }); // one retry
  // optional files (e.g. a missing tokenizer file) must stay a plain 404 so the library skips them
  if (r.status === 404) return new Response('not found', { status: 404, headers: { 'cache-control': 'public, max-age=3600' } });
  if (!r.ok || !r.body) throw new HttpError(502, `could not fetch the model (${r.status})`);
  const len = Number(r.headers.get('content-length'));
  if (!len) {
    // small files may come compressed without a length: buffer them
    const buf = await r.arrayBuffer();
    ctx.waitUntil(env.LIBRARY.put(key, buf).catch((e) => console.error('model cache', e)));
    return new Response(buf, { headers: { ...headers, 'content-length': String(buf.byteLength) } });
  }
  const [toClient, toCache] = r.body.tee();
  const fixed = new FixedLengthStream(len);
  ctx.waitUntil(Promise.all([toCache.pipeTo(fixed.writable), env.LIBRARY.put(key, fixed.readable)]).catch((e) => console.error('model cache', e)));
  return new Response(toClient, { headers: { ...headers, 'content-length': String(len) } });
}

const LRCLIB_UA = { 'user-agent': 'jojos-karaoke (https://github.com/JonathanGehret/jojos-karaoke)' };

async function lrclib(path: string): Promise<any> {
  const url = `https://lrclib.net/api/${path}`;
  let r = await fetch(url, { headers: LRCLIB_UA, signal: AbortSignal.timeout(8000) });
  if (r.status === 503 || r.status === 429) { // LRCLIB answers "server busy" at times
    await new Promise((ok) => setTimeout(ok, 1500));
    r = await fetch(url, { headers: LRCLIB_UA, signal: AbortSignal.timeout(8000) });
  }
  return r.ok ? r.json() : r.status === 404 ? null : Promise.reject(new Error(String(r.status)));
}

/** LRCLIB records for a song: exact match by duration, then a structured search with the
 *  cleaned title, then a free-text search (catches "Artist - Title" mix-ups and typos). */
async function findLyrics(title: string, artist: string, duration: number, q: string, enough: number): Promise<LrclibRecord[]> {
  const out: LrclibRecord[] = [];
  const have = () => out.filter((r) => r && !r.instrumental && (r.syncedLyrics || r.plainLyrics)).length;
  const tryGet = async (path: string) => {
    try {
      const d = await lrclib(path);
      if (Array.isArray(d)) out.push(...d.slice(0, 20)); else if (d) out.push(d);
    } catch { /* one source failing must not hide the others */ }
  };
  const t = title && cleanTitle(title);
  const a = artist && mainArtist(artist);
  if (t && duration) await tryGet(`get?${new URLSearchParams({ track_name: t, artist_name: a, duration: String(Math.round(duration)) })}`);
  if (t && have() < enough) await tryGet(`search?${new URLSearchParams({ track_name: t, ...(a ? { artist_name: a } : {}) })}`);
  const free = q || [a, t].filter(Boolean).join(' ');
  if (free && have() < enough) await tryGet(`search?${new URLSearchParams({ q: free })}`);
  return out;
}

const lyricsParams = (url: URL) => ({
  title: url.searchParams.get('title')?.slice(0, 200).trim() ?? '',
  artist: url.searchParams.get('artist')?.slice(0, 200).trim() ?? '',
  q: url.searchParams.get('q')?.slice(0, 300).trim() ?? '',
  duration: Number(url.searchParams.get('duration')) || 0,
});

/** The lyrics to use without asking (browser maker): `{ synced, plain }`, both null if unsure. */
export async function lookupLyrics(url: URL): Promise<Response> {
  const { title, artist, duration } = lyricsParams(url);
  if (!title) return Response.json({ synced: null, plain: null });
  const best = bestLyrics(rankLyrics(await findLyrics(title, artist, duration, '', 1), { title, artist, duration }), duration);
  return Response.json({ synced: best?.synced ?? null, plain: best?.plain ?? null });
}

/** Candidates to choose from (lyrics finder): `{ results: LyricsCandidate[] }`, best first. */
export async function searchLyrics(url: URL): Promise<Response> {
  const { title, artist, q, duration } = lyricsParams(url);
  if (!title && !q) return Response.json({ results: [] });
  const ranked = rankLyrics(await findLyrics(title, artist, duration, q, 6), { title: title || q, artist, duration });
  return Response.json({ results: ranked.slice(0, 8) });
}
