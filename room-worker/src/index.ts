// HTTP entry: library API, room routing, signed media. Everything else is the PWA (assets).

import { summarize, type Principal } from './accounts';
import { lookupLyrics, searchLyrics, serveHf, serveModel, serveRuntime } from './assets';
import { serveMedia } from './media';
import {
  Env, FILE_TYPES, accountsOf, limit, HttpError, MAX_FILE_BYTES, ROOM_CODE_RE, SONG_ID_RE, bearer, json, libKey, roomCode,
} from './util';

export { Accounts } from './accounts';
export { Room } from './room';

const accounts = accountsOf;

async function principal(req: Request, env: Env, url?: URL): Promise<Principal> {
  const t = bearer(req, url);
  const p = t ? await accounts(env).auth(t) : null;
  if (!p) throw new HttpError(401, 'invalid or missing token');
  return p;
}

async function route(req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const p = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const m = req.method;

  // ---- accounts & tokens
  if (p[1] === 'accounts' && m === 'POST') {
    await limit(env.CREATE_LIMIT, req, 'account');
    const body = (await req.json().catch(() => ({}))) as { name?: string; signupCode?: string };
    if (env.SIGNUP_CODE && body.signupCode !== env.SIGNUP_CODE) throw new HttpError(403, 'wrong signup code');
    const name = String(body.name ?? '').trim().slice(0, 40);
    if (!name) throw new HttpError(400, 'name required');
    return json(await accounts(env).createOwner(name), 201);
  }
  if (p[1] === 'me' && m === 'GET') {
    const me = await principal(req, env);
    return json({ name: me.name, role: me.role, ownerId: me.ownerId, ownerName: me.ownerName });
  }
  if (p[1] === 'tokens') {
    const me = await principal(req, env);
    if (me.role !== 'owner') throw new HttpError(403, 'owner only');
    if (m === 'GET' && !p[2]) return json({ tokens: await accounts(env).listTokens(me.ownerId) });
    if (m === 'POST' && !p[2]) {
      const body = (await req.json().catch(() => ({}))) as { name?: string };
      const name = String(body.name ?? '').trim().slice(0, 40) || 'friend';
      return json({ token: await accounts(env).createToken(me.ownerId, name) }, 201);
    }
    if (m === 'DELETE' && p[2]) return json({ ok: await accounts(env).revokeToken(me.ownerId, p[2]) });
  }

  // ---- library (owner + contributors)
  if (p[1] === 'library' && p[2] === 'songs') {
    const me = await principal(req, env);
    const sid = p[3];
    if (!sid && m === 'GET') return json({ songs: await accounts(env).listSongs(me.ownerId) });
    if (!sid || !SONG_ID_RE.test(sid)) throw new HttpError(400, 'bad song id');

    if (p[4] === 'files' && p[5] && m === 'PUT') {
      const file = p[5];
      if (!(file in FILE_TYPES)) throw new HttpError(400, 'unexpected file name');
      const len = Number(req.headers.get('content-length') || 0);
      if (len > MAX_FILE_BYTES) throw new HttpError(413, 'file too large');
      if (file.endsWith('.json')) {
        const text = await req.text();
        try { JSON.parse(text); } catch { throw new HttpError(400, 'invalid JSON'); }
        await env.LIBRARY.put(libKey(me.ownerId, sid, file), text, { httpMetadata: { contentType: FILE_TYPES[file] } });
      } else {
        if (!len) throw new HttpError(411, 'content-length required');
        await env.LIBRARY.put(libKey(me.ownerId, sid, file), req.body!, { httpMetadata: { contentType: FILE_TYPES[file] } });
      }
      return json({ ok: true });
    }
    if (p[4] === 'commit' && m === 'POST') {
      const manifest = (await req.json()) as any;
      if (manifest?.formatVersion !== 1 || manifest.id !== sid || !manifest.title || !(manifest.durationMs > 0)) {
        throw new HttpError(400, 'invalid manifest');
      }
      for (const f of Object.values(manifest.files ?? {}) as string[]) {
        if (!(f in FILE_TYPES)) throw new HttpError(400, `unexpected file ${f}`);
        if (!(await env.LIBRARY.head(libKey(me.ownerId, sid, f)))) throw new HttpError(400, `${f} was not uploaded`);
      }
      const prev = await accounts(env).getSong(me.ownerId, sid);
      manifest.version = (prev?.version ?? 0) + 1;
      manifest.addedBy = me.name;
      await accounts(env).putSong(me.ownerId, manifest);
      return json({ ok: true, song: summarize(manifest) });
    }
    if (!p[4] && m === 'DELETE') {
      if (me.role !== 'owner') throw new HttpError(403, 'owner only');
      const list = await env.LIBRARY.list({ prefix: `lib/${me.ownerId}/${sid}/` });
      await Promise.all(list.objects.map((o) => env.LIBRARY.delete(o.key)));
      await accounts(env).deleteSong(me.ownerId, sid);
      return json({ ok: true });
    }
  }

  // ---- rooms
  if (p[1] === 'rooms' && !p[2] && m === 'POST') {
    await limit(env.CREATE_LIMIT, req, 'room');
    // With a library token the room can also use that online library; without one it is a
    // plain party with the songs stored on the host screen's device.
    const body = (await req.json().catch(() => ({}))) as { name?: string; signupCode?: string };
    const me = bearer(req) ? await principal(req, env) : null;
    if (!me && env.SIGNUP_CODE && body.signupCode !== env.SIGNUP_CODE) throw new HttpError(403, 'wrong signup code');
    const ownerName = me?.ownerName ?? (String(body.name ?? '').trim().slice(0, 40) || 'Host');
    for (let i = 0; i < 8; i++) {
      const code = roomCode();
      const stub = env.ROOM.get(env.ROOM.idFromName(code));
      const r = await stub.fetch(new Request(`${url.origin}/api/rooms/${code}/init`, {
        method: 'POST', body: JSON.stringify({ code, ownerId: me?.ownerId ?? null, ownerName }),
      }));
      if (r.status !== 409) return r;
    }
    throw new HttpError(503, 'could not allocate a room code');
  }
  if (p[1] === 'rooms' && p[2]) {
    const code = p[2].toUpperCase();
    if (!ROOM_CODE_RE.test(code)) throw new HttpError(404, 'room not found');
    if (m === 'POST' && (p[3] === 'uploads' || p[3] === 'results')) await limit(env.UPLOAD_LIMIT, req, 'upload');
    const headers = new Headers(req.headers);
    headers.delete('x-jojo-owner');
    // Makers authenticate with the room's worker key (checked by the room) or a library token
    // (checked here; the room compares the owner).
    const makerCall = (p[3] === 'ws' && url.searchParams.get('role') === 'worker') ||
      (p[3] === 'uploads' && p[4] && m === 'GET') || (p[3] === 'results' && p[4] && m === 'POST');
    const t = makerCall ? bearer(req, url) : null;
    if (t?.startsWith('jk_')) {
      const who = await accountsOf(env).auth(t);
      if (who) headers.set('x-jojo-owner', who.ownerId);
    }
    const fwd = new URL(url);
    fwd.pathname = `/api/rooms/${code}/${p.slice(3).join('/')}`;
    return env.ROOM.get(env.ROOM.idFromName(code)).fetch(new Request(fwd, { method: m, headers, body: req.body }));
  }

  // ---- browser maker assets
  if (p[1] === 'runtime' && p.length === 4 && (m === 'GET' || m === 'HEAD')) return serveRuntime(env, p[2], p[3], m === 'HEAD');
  if (p[1] === 'models' && p.length === 3 && m === 'GET') return serveModel(env, ctx, p[2]);
  if (p[1] === 'hf' && m === 'GET') return serveHf(env, ctx, p.slice(2));
  // no account needed (songs are device-first); rate limited per IP instead
  if (p[1] === 'lyrics' && m === 'GET' && p.length <= 3) {
    await limit(env.LOOKUP_LIMIT, req, 'lyrics');
    if (p[2] === 'search') return searchLyrics(url);
    if (!p[2]) return lookupLyrics(url);
  }

  // ---- media (signed)
  if (p[1] === 'media' && p.length === 5 && (m === 'GET' || m === 'HEAD')) {
    return serveMedia(req, env, url, p[2], p[3], p[4]);
  }
  throw new HttpError(404, 'not found');
}

const ASSET_NAME = /^\/assets\/([\w.-]+)$/;

/** App files have hashed names that change with each deploy. A tab still running an older
 *  version asks for its own files: serve those from R2 (kept there by scripts/keep-assets.mjs
 *  before each deploy) instead of the start page, which made the song maker crash. */
async function appAsset(req: Request, env: Env, url: URL): Promise<Response> {
  const r = await env.ASSETS.fetch(req);
  // a live file (also "304 not modified"); a missing one comes back as the start page or a 404
  const missing = r.status === 404 || (r.ok && (r.headers.get('content-type') ?? '').includes('text/html'));
  if (!missing) return r;
  const name = url.pathname.match(ASSET_NAME)?.[1];
  const obj = name ? await env.LIBRARY.get(`app-assets/${name}`) : null;
  if (!obj) return new Response('not found', { status: 404 });
  return new Response(obj.body, { headers: {
    'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
    'cache-control': 'public, max-age=31536000, immutable',
    // same isolation headers as the live files (the song maker runs as a worker from these)
    'cross-origin-embedder-policy': 'credentialless', 'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
  } });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/assets/')) return appAsset(req, env, url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      return await route(req, env, url, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'internal error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
