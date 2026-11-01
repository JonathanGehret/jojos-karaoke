// Large browser-maker assets served same-origin from R2:
// - ONNX Runtime WebAssembly files (too big for Workers static assets), uploaded at deploy
//   time by scripts/upload-runtime.mjs
// - AI models, fetched once from their upstream and cached in R2

import { type Env, HttpError } from './util';

const RUNTIME_FILE = /^ort-wasm-simd-threaded(\.(jsep|asyncify|jspi))?\.(wasm|mjs)$/;
const VERSION = /^[0-9A-Za-z.-]{1,60}$/;

export const MODELS: Record<string, string> = {
  'UVR-MDX-NET-Inst_HQ_3.onnx':
    'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Inst_HQ_3.onnx',
};

const immutable = 'public, max-age=31536000, immutable';

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
  const key = `models/${name}`;
  const headers = { 'content-type': 'application/octet-stream', 'cache-control': immutable };
  const obj = await env.LIBRARY.get(key);
  if (obj) return new Response(obj.body, { headers: { ...headers, 'content-length': String(obj.size) } });

  const r = await fetch(upstream, { redirect: 'follow' });
  const len = Number(r.headers.get('content-length'));
  if (!r.ok || !r.body || !len) throw new HttpError(502, `could not fetch the model (${r.status})`);
  const [toClient, toCache] = r.body.tee();
  const fixed = new FixedLengthStream(len);
  ctx.waitUntil(Promise.all([toCache.pipeTo(fixed.writable), env.LIBRARY.put(key, fixed.readable)]).catch((e) => console.error('model cache', e)));
  return new Response(toClient, { headers: { ...headers, 'content-length': String(len) } });
}

/** LRCLIB lookup for the browser maker (same choice rules as maker/lyrics.py). */
export async function lookupLyrics(url: URL): Promise<Response> {
  const title = url.searchParams.get('title')?.slice(0, 200) ?? '';
  const artist = url.searchParams.get('artist')?.slice(0, 200) ?? '';
  const duration = Number(url.searchParams.get('duration')) || 0;
  const none = () => Response.json({ synced: null, plain: null });
  if (!title) return none();
  const ua = { 'user-agent': 'jojos-karaoke (https://github.com/JonathanGehret/jojos-karaoke)' };
  const get = async (path: string): Promise<any> => {
    const r = await fetch(`https://lrclib.net/api/${path}`, { headers: ua, signal: AbortSignal.timeout(8000) });
    return r.ok ? r.json() : r.status === 404 ? null : Promise.reject(new Error(String(r.status)));
  };
  try {
    const q = new URLSearchParams({ track_name: title, artist_name: artist });
    let cands: any[] = [];
    const exact = duration ? await get(`get?${q}&duration=${Math.round(duration)}`) : null;
    if (exact) cands = [exact];
    else cands = ((await get(`search?${q}`)) as any[] | null) ?? [];
    const ok = cands.filter((c) => c && !c.instrumental && (c.syncedLyrics || c.plainLyrics) &&
      (!duration || !c.duration || Math.abs(c.duration - duration) <= 8));
    ok.sort((a, b) => (a.syncedLyrics ? 0 : 1) - (b.syncedLyrics ? 0 : 1) ||
      Math.abs((a.duration ?? duration) - duration) - Math.abs((b.duration ?? duration) - duration));
    const best = ok[0];
    return best ? Response.json({ synced: best.syncedLyrics || null, plain: best.plainLyrics || null }) : none();
  } catch {
    return none();
  }
}
