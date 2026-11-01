// Short-lived signed URLs for library files, so the library is never public.

import { Env, FILE_TYPES, HttpError, libKey, safeEqual, sign } from './util';

export const MEDIA_TTL_S = 6 * 3600;

function secret(env: Env): string {
  if (!env.MEDIA_SECRET) throw new HttpError(500, 'MEDIA_SECRET is not configured');
  return env.MEDIA_SECRET;
}

export async function signedMediaUrl(env: Env, origin: string, owner: string, song: string, file: string,
  version = 0): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + MEDIA_TTL_S;
  const path = `/api/media/${owner}/${song}/${file}`;
  const sig = await sign(secret(env), `${path}?${exp}`);
  return `${origin}${path}?exp=${exp}&v=${version}&sig=${sig}`;
}

export async function serveMedia(req: Request, env: Env, url: URL, owner: string, song: string, file: string) {
  if (!(file in FILE_TYPES)) throw new HttpError(404, 'not found');
  const exp = Number(url.searchParams.get('exp'));
  const sig = url.searchParams.get('sig') ?? '';
  if (!exp || exp < Date.now() / 1000) throw new HttpError(403, 'link expired');
  const want = await sign(secret(env), `${url.pathname}?${exp}`);
  if (!safeEqual(sig, want)) throw new HttpError(403, 'bad signature');

  const range = req.headers.get('range');
  const obj = await env.LIBRARY.get(libKey(owner, song, file), range ? { range: req.headers } : undefined);
  if (!obj) throw new HttpError(404, 'not found');
  const h = new Headers({
    'content-type': FILE_TYPES[file],
    'cache-control': 'private, max-age=21600',
    'accept-ranges': 'bytes',
    etag: obj.httpEtag,
  });
  if (range && obj.range && 'offset' in obj.range) {
    const off = obj.range.offset ?? 0;
    const len = obj.range.length ?? obj.size - off;
    h.set('content-range', `bytes ${off}-${off + len - 1}/${obj.size}`);
    h.set('content-length', String(len));
    return new Response(obj.body, { status: 206, headers: h });
  }
  h.set('content-length', String(obj.size));
  return new Response(obj.body, { headers: h });
}
