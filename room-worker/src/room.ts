// One Durable Object per room: members, queue, playback relay, on-the-spot jobs.
// The server is the authority for the queue; the screen is the authority for playback.

import { DurableObject } from 'cloudflare:workers';
import type { Lyrics } from '../../shared/lyrics';
import {
  ClientMsg, Job, LIMITS, Member, Playback, QueueItem, REACTIONS, Role, RoomSettings, RoomState, ServerMsg,
  SongSummary, cleanNickname,
} from '../../shared/protocol';
import { countFor, fairInsertIndex } from '../../shared/rotation';
import { signedMediaUrl } from './media';
import { Env, HttpError, accountsOf, json, libKey, randomId, randomToken, sha256 } from './util';

interface StoredMember extends Omit<Member, 'online'> { tokenHash: string; lastSeen: number }
interface Upload { id: string; memberId: string; size: number; at: number }

interface Stored {
  code: string;
  ownerId: string | null;          // null: a room without an online library (songs from the screen's device)
  ownerName: string;
  adminHash: string;
  workerHash: string;              // "worker key": lets a maker process requests, nothing else
  localSongs: SongSummary[];       // songs stored on the screen's device
  currentLyrics: { queueItemId: string; lyrics: Lyrics } | null;
  results: { jobId: string; queueItemId: string; memberId: string; size: number }[];
  createdAt: number;
  lastActive: number;
  members: StoredMember[];
  banned: string[];
  queue: QueueItem[];
  nowPlaying: QueueItem | null;
  playback: Playback;
  settings: RoomSettings;
  jobs: Job[];
  uploads: Upload[];
  history: { songId: string; memberId: string; at: number }[];
}

interface Attachment { memberId: string; role: Role }

const SONG_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;

const idlePlayback = (): Playback => ({
  state: 'stopped', positionMs: 0, atServerMs: 0, rate: 1, key: 0, vocal: 0,
  queueItemId: null, songId: null,
});

export class Room extends DurableObject<Env> {
  s: Stored | null = null;
  library: SongSummary[] = [];
  /** last empty job.claim answered per worker socket (in memory: lost on hibernation, that's fine) */
  private emptyClaims = new WeakMap<WebSocket, number>();
  private playbackSavedAt = 0;
  private alarmSetAt = 0;
  libraryAt = 0;
  reactions = new Map<string, number[]>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.s = (await ctx.storage.get<Stored>('room')) ?? null;
    });
  }

  // ------------------------------------------------------------------ HTTP

  async fetch(req: Request): Promise<Response> {
    try {
      return await this.route(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'internal error' }, 500);
    }
  }

  private async route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean).slice(3); // api rooms CODE ...
    const [a, b, c] = parts;

    if (a === 'init' && req.method === 'POST') return this.init(await req.json());
    if (!this.s) throw new HttpError(404, 'room not found');
    if (a === 'info' && req.method === 'GET') {
      return json({ code: this.s.code, ownerName: this.s.ownerName, members: this.s.members.length });
    }
    if (a === 'ws') return this.openSocket(req, url);
    if (a === 'uploads' && !b && req.method === 'POST') return this.upload(req, url);
    if (a === 'uploads' && b && req.method === 'GET') return this.downloadUpload(req, url, b);
    if (a === 'results' && b && req.method === 'POST') return this.putResult(req, url, b);
    if (a === 'results' && b && req.method === 'GET') return this.getResult(url, b);
    if (a === 'results' && !b && req.method === 'GET') {
      // the host's screen copies every finished request into its device songs, also ones it
      // missed (it was reloaded, or the song was already playing when it finished)
      await this.requireAdmin(url.searchParams.get('admin'));
      return json({ results: this.s.results.map((r) => ({ queueItemId: r.queueItemId, jobId: r.jobId })) });
    }
    if (a === 'songs' && b && c === 'media' && req.method === 'GET') return this.media(url, b);
    if (a === 'songs' && b && c === 'lyrics' && req.method === 'PUT') return this.saveLyrics(req, url, b);
    if (a === 'close' && req.method === 'POST') {
      await this.requireAdmin(url.searchParams.get('admin'));
      await this.destroy();
      return json({ ok: true });
    }
    throw new HttpError(404, 'not found');
  }

  private async init(body: { code: string; ownerId: string | null; ownerName: string }): Promise<Response> {
    if (this.s && Date.now() - this.s.lastActive < LIMITS.roomIdleMs) throw new HttpError(409, 'room code in use');
    if (this.s) await this.destroy();
    const adminToken = randomToken();
    const workerKey = `wk_${randomToken(12)}`;
    this.s = {
      code: body.code, ownerId: body.ownerId ?? null, ownerName: body.ownerName, adminHash: await sha256(adminToken),
      workerHash: await sha256(workerKey), localSongs: [], currentLyrics: null, results: [],
      createdAt: Date.now(), lastActive: Date.now(), members: [], banned: [], queue: [], nowPlaying: null,
      playback: idlePlayback(), settings: { fair: true, maxPerPerson: LIMITS.queuePerPersonDefault },
      jobs: [], uploads: [], history: [],
    };
    await this.save();
    return json({ code: body.code, adminToken, workerKey });
  }

  /** A maker may work for this room: worker key, host token, or a library token of the owner. */
  private async isWorker(req: Request, url: URL): Promise<boolean> {
    const s = this.s!;
    if (s.ownerId && req.headers.get('x-jojo-owner') === s.ownerId) return true;
    const h = req.headers.get('authorization');
    const t = h?.startsWith('Bearer ') ? h.slice(7).trim() : url.searchParams.get('key') ?? url.searchParams.get('token');
    if (!t) return false;
    const th = await sha256(t);
    return th === s.workerHash || th === s.adminHash;
  }

  private async isAdmin(token: string | null | undefined): Promise<boolean> {
    return !!token && !!this.s && (await sha256(token)) === this.s.adminHash;
  }

  private async requireAdmin(token: string | null | undefined) {
    if (!(await this.isAdmin(token))) throw new HttpError(403, 'host only');
  }

  private async memberByToken(token: string | null): Promise<StoredMember | null> {
    if (!token || !this.s) return null;
    const h = await sha256(token);
    return this.s.members.find((m) => m.tokenHash === h) ?? null;
  }

  private async openSocket(req: Request, url: URL): Promise<Response> {
    if (req.headers.get('upgrade') !== 'websocket') throw new HttpError(426, 'expected websocket');
    const s = this.s!;
    const roleQ = url.searchParams.get('role') as Role | null;
    let role: Role = 'guest';
    let member: StoredMember | null = null;
    let memberToken: string | null = null;

    if (roleQ === 'worker') {
      if (!(await this.isWorker(req, url))) throw new HttpError(403, 'not a maker for this room');
      role = 'worker';
    } else if (roleQ === 'screen' || roleQ === 'admin') {
      await this.requireAdmin(url.searchParams.get('token'));
      role = roleQ;
    }
    member = await this.memberByToken(url.searchParams.get('member'));
    if (member && s.banned.includes(member.id)) throw new HttpError(403, 'removed from this room');
    const nickname = cleanNickname(url.searchParams.get('nickname')) ||
      (role === 'screen' ? 'Screen' : role === 'worker' ? 'Worker' : '');
    if (!member) {
      if (!nickname) throw new HttpError(400, 'nickname required');
      if (s.members.length >= 200) throw new HttpError(429, 'room is full');
      memberToken = randomToken();
      member = { id: randomId(), nickname, role, tokenHash: await sha256(memberToken), lastSeen: Date.now() };
      s.members.push(member);
    } else {
      if (nickname) member.nickname = nickname;
      member.role = role;
    }
    member.lastSeen = Date.now();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ memberId: member.id, role } satisfies Attachment);
    await this.touch();
    await this.refreshLibrary();
    const you: Member & { token?: string } = { id: member.id, nickname: member.nickname, role, online: true };
    if (memberToken) you.token = memberToken;
    this.sendTo(server, { type: 'welcome', you, state: this.state() });
    this.sendTo(server, { type: 'library', songs: this.mergedLibrary() });
    if (s.currentLyrics && s.currentLyrics.queueItemId === s.nowPlaying?.id) {
      this.sendTo(server, { type: 'lyrics', ...s.currentLyrics });
    }
    this.broadcastState();
    return new Response(null, { status: 101, webSocket: client });
  }

  private async upload(req: Request, url: URL): Promise<Response> {
    const m = await this.memberByToken(url.searchParams.get('member'));
    if (!m) throw new HttpError(403, 'join the room first');
    const len = Number(req.headers.get('content-length') || 0);
    if (!len) throw new HttpError(411, 'content-length required');
    if (len > LIMITS.uploadBytes) throw new HttpError(413, 'file too large (max 60 MB)');
    if (this.s!.uploads.filter((u) => u.memberId === m.id).length >= 5) throw new HttpError(429, 'too many uploads');
    const id = randomId();
    await this.env.LIBRARY.put(`uploads/${this.s!.code}/${id}`, req.body!, {
      httpMetadata: { contentType: req.headers.get('content-type') || 'application/octet-stream' },
    });
    this.s!.uploads.push({ id, memberId: m.id, size: len, at: Date.now() });
    await this.touch();
    return json({ uploadId: id });
  }

  private async downloadUpload(req: Request, url: URL, id: string): Promise<Response> {
    if (!(await this.isWorker(req, url))) throw new HttpError(403, 'not a maker for this room');
    const obj = await this.env.LIBRARY.get(`uploads/${this.s!.code}/${id}`);
    if (!obj) throw new HttpError(404, 'upload not found');
    return new Response(obj.body, { headers: { 'content-type': 'application/octet-stream' } });
  }

  /** The finished package of a request (.jkp), kept until the room closes. */
  private async putResult(req: Request, url: URL, jobId: string): Promise<Response> {
    if (!(await this.isWorker(req, url))) throw new HttpError(403, 'not a maker for this room');
    const s = this.s!;
    const job = s.jobs.find((j) => j.id === jobId);
    if (!job) throw new HttpError(404, 'job not found');
    const item = s.queue.find((q) => q.id === job.queueItemId) ?? (s.nowPlaying?.id === job.queueItemId ? s.nowPlaying : null);
    if (!item) throw new HttpError(404, 'request is no longer queued');
    const len = Number(req.headers.get('content-length') || 0);
    if (!len) throw new HttpError(411, 'content-length required');
    if (len > LIMITS.resultBytes) throw new HttpError(413, 'package too large');
    await this.env.LIBRARY.put(`rooms/${s.code}/results/${jobId}.jkp`, req.body!, { httpMetadata: { contentType: 'application/zip' } });
    s.results = s.results.filter((r) => r.jobId !== jobId);
    s.results.push({ jobId, queueItemId: item.id, memberId: item.memberId, size: len });
    await this.touch();
    return json({ ok: true });
  }

  /** Host (to import it) or the guest who requested it (to keep it) can download a result. */
  private async getResult(url: URL, idOrItem: string): Promise<Response> {
    const s = this.s!;
    const r = s.results.find((x) => x.jobId === idOrItem || x.queueItemId === idOrItem);
    if (!r) throw new HttpError(404, 'not found');
    const admin = await this.isAdmin(url.searchParams.get('admin'));
    const m = admin ? null : await this.memberByToken(url.searchParams.get('member'));
    if (!admin && m?.id !== r.memberId) throw new HttpError(403, 'only the host and the person who requested it can download it');
    const obj = await this.env.LIBRARY.get(`rooms/${s.code}/results/${r.jobId}.jkp`);
    if (!obj) throw new HttpError(404, 'not found');
    const item = s.queue.find((q) => q.id === r.queueItemId) ?? s.nowPlaying;
    const name = (item?.title ?? 'song').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 60) || 'song';
    return new Response(obj.body, { headers: {
      'content-type': 'application/zip', 'content-length': String(obj.size),
      'content-disposition': `attachment; filename="${encodeURIComponent(name)}.jkp"`,
    } });
  }

  private async media(url: URL, songId: string): Promise<Response> {
    if (!this.s!.ownerId) throw new HttpError(404, 'this room has no online library');
    const admin = await this.isAdmin(url.searchParams.get('admin'));
    const m = admin ? null : await this.memberByToken(url.searchParams.get('member'));
    if (!admin && !m) throw new HttpError(403, 'join the room first');
    const manifest = await accountsOf(this.env).getSong(this.s!.ownerId!, songId);
    if (!manifest) throw new HttpError(404, 'song not found');
    const origin = url.origin;
    const v = manifest.version ?? 0;
    const sign = (f: string) => signedMediaUrl(this.env, origin, this.s!.ownerId!, songId, f, v);
    const files = manifest.files as Record<string, string>;
    // Guests only need lyrics (+ pitch for scoring); audio is for the screen.
    const out: Record<string, string> = { lyrics: await sign(files.lyrics) };
    if (files.cover) out.cover = await sign(files.cover);
    if (admin) {
      out.instrumental = await sign(files.instrumental);
      if (files.vocals) out.vocals = await sign(files.vocals);
    }
    return json({ manifest, urls: out });
  }

  private async saveLyrics(req: Request, url: URL, songId: string): Promise<Response> {
    await this.requireAdmin(url.searchParams.get('admin'));
    const body = (await req.json()) as { lyrics: Lyrics; offsetMs?: number };
    const l = body.lyrics;
    if (!l || l.version !== 1 || !Array.isArray(l.lines)) throw new HttpError(400, 'invalid lyrics');
    let prev = 0;
    for (const ln of l.lines) {
      if (!Array.isArray(ln.words) || !ln.words.length) throw new HttpError(400, 'empty line');
      for (const w of ln.words) {
        if (typeof w.t !== 'string' || !Number.isInteger(w.s) || !Number.isInteger(w.e) || w.e < w.s || w.s < prev) {
          throw new HttpError(400, 'word times must be integers and in order');
        }
        prev = w.s;
      }
      ln.start = ln.words[0].s;
      ln.end = ln.words[ln.words.length - 1].e;
    }
    if (!this.s!.ownerId) throw new HttpError(404, 'this room has no online library');
    const acc = accountsOf(this.env);
    const manifest = await acc.getSong(this.s!.ownerId, songId);
    if (!manifest) throw new HttpError(404, 'song not found');
    await this.env.LIBRARY.put(libKey(this.s!.ownerId, songId, 'lyrics.json'), JSON.stringify(l), {
      httpMetadata: { contentType: 'application/json' },
    });
    manifest.version = (manifest.version ?? 0) + 1;
    if (typeof body.offsetMs === 'number') manifest.offsetMs = Math.round(body.offsetMs);
    if (manifest.lyricsSource === 'none' && l.lines.length) manifest.lyricsSource = 'user';
    await acc.putSong(this.s!.ownerId, manifest);
    await this.refreshLibrary(true);
    this.broadcast({ type: 'library', songs: this.mergedLibrary() });
    return json({ ok: true, version: manifest.version });
  }

  // ------------------------------------------------------------------ WebSocket

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (!this.s) return ws.close(4404, 'room closed');
    const att = ws.deserializeAttachment() as Attachment;
    const max = att?.role === 'screen' ? LIMITS.lyricsMsgBytes : 65536;
    if (typeof raw !== 'string' || raw.length > max) return;
    let msg: ClientMsg;
    try { msg = JSON.parse(raw); } catch { return; }
    const me = this.s.members.find((m) => m.id === att.memberId);
    if (!me || this.s.banned.includes(me.id)) return ws.close(4403, 'removed');
    try {
      await this.handle(ws, att, me, msg);
    } catch (e) {
      this.sendTo(ws, { type: 'error', message: e instanceof HttpError ? e.message : 'something went wrong' });
      if (!(e instanceof HttpError)) console.error(e);
    }
  }

  private async handle(ws: WebSocket, att: Attachment, me: StoredMember, msg: ClientMsg) {
    const s = this.s!;
    const admin = att.role === 'admin' || att.role === 'screen';
    const need = (ok: boolean, why = 'host only') => { if (!ok) throw new HttpError(403, why); };

    switch (msg.type) {
      case 'ping':
        return this.sendTo(ws, { type: 'pong', c: msg.c, s: Date.now() });

      case 'queue.add': {
        await this.refreshLibrary();
        const song = this.mergedLibrary().find((x) => x.id === msg.songId);
        if (!song) throw new HttpError(404, 'song not in the library');
        this.checkQuota(me, admin);
        this.insert({
          id: randomId(), memberId: me.id, nickname: me.nickname, songId: song.id, title: song.title,
          artist: song.artist, status: 'ready',
        });
        break;
      }

      case 'request.add': {
        const up = s.uploads.find((u) => u.id === msg.uploadId && u.memberId === me.id);
        if (!up) throw new HttpError(404, 'upload not found');
        if (s.jobs.some((j) => j.uploadId === up.id)) throw new HttpError(409, 'already requested');
        this.checkQuota(me, admin);
        const title = String(msg.title ?? '').trim().slice(0, LIMITS.title);
        if (!title) throw new HttpError(400, 'title required');
        const item: QueueItem = {
          id: randomId(), memberId: me.id, nickname: me.nickname, songId: null, title,
          artist: String(msg.artist ?? '').trim().slice(0, LIMITS.title), status: 'processing',
          progress: { stage: 'waiting', pct: 0 },
        };
        const job: Job = {
          id: randomId(), queueItemId: item.id, uploadId: up.id, title: item.title, artist: item.artist,
          lyrics: msg.lyrics ? String(msg.lyrics).slice(0, LIMITS.lyrics) : undefined, state: 'waiting',
        };
        item.jobId = job.id;
        s.jobs.push(job);
        this.insert(item);
        this.offerJobs();
        break;
      }

      case 'queue.remove': {
        const it = s.queue.find((q) => q.id === msg.itemId);
        if (!it) return;
        need(admin || it.memberId === me.id, 'not your song');
        s.queue = s.queue.filter((q) => q !== it);
        if (it.jobId) this.dropJob(it.jobId);
        break;
      }

      case 'queue.move':
      case 'queue.playNext': {
        need(admin);
        const i = s.queue.findIndex((q) => q.id === msg.itemId);
        if (i < 0) return;
        const [it] = s.queue.splice(i, 1);
        const to = msg.type === 'queue.playNext' ? 0 : Math.max(0, Math.min(Math.trunc(msg.to), s.queue.length));
        s.queue.splice(to, 0, it);
        break;
      }

      case 'settings': {
        need(admin);
        if (typeof msg.settings.fair === 'boolean') s.settings.fair = msg.settings.fair;
        if (Number.isInteger(msg.settings.maxPerPerson)) {
          s.settings.maxPerPerson = Math.max(0, Math.min(50, msg.settings.maxPerPerson!));
        }
        break;
      }

      case 'kick': {
        need(admin);
        const target = s.members.find((m) => m.id === msg.memberId);
        if (!target || target.id === me.id) return;
        s.banned.push(target.id);
        s.queue = s.queue.filter((q) => {
          if (q.memberId !== target.id) return true;
          if (q.jobId) this.dropJob(q.jobId);
          return false;
        });
        for (const w of this.socketsOf(target.id)) {
          this.sendTo(w, { type: 'kicked' });
          w.close(4403, 'removed');
        }
        break;
      }

      case 'control':
      case 'control.set':
        need(admin);
        this.broadcast(msg as ServerMsg, (a) => a.role === 'screen');
        return;

      case 'playback': {
        need(att.role === 'screen', 'screen only');
        const p = msg.playback;
        s.playback = {
          state: p.state, positionMs: Math.max(0, +p.positionMs || 0), atServerMs: +p.atServerMs || Date.now(),
          rate: Math.max(0.5, Math.min(2, +p.rate || 1)), key: Math.max(-12, Math.min(12, Math.trunc(+p.key || 0))),
          vocal: Math.max(0, Math.min(1, +p.vocal || 0)), queueItemId: s.nowPlaying?.id ?? null,
          songId: s.nowPlaying?.songId ?? null,
        };
        this.broadcast({ type: 'playback', playback: s.playback }, (a) => a.memberId !== me.id);
        // sent every few seconds while a song plays: keep it in memory, store it now and then
        // (storage writes are a daily-limited resource)
        s.lastActive = Date.now();
        if (Date.now() - this.playbackSavedAt > 30_000) { this.playbackSavedAt = Date.now(); await this.touch(); }
        return;
      }

      case 'advance': {
        need(att.role === 'screen', 'screen only');
        if (s.nowPlaying?.songId) {
          s.history.push({ songId: s.nowPlaying.songId, memberId: s.nowPlaying.memberId, at: Date.now() });
          s.history = s.history.slice(-200);
        }
        const i = s.queue.findIndex((q) => q.status === 'ready' || (q.status === 'processing' && q.playable));
        s.nowPlaying = i >= 0 ? s.queue.splice(i, 1)[0] : null;
        s.currentLyrics = null;
        s.playback = { ...idlePlayback(), key: 0, vocal: s.playback.vocal,
          queueItemId: s.nowPlaying?.id ?? null, songId: s.nowPlaying?.songId ?? null };
        break;
      }

      case 'queue.playable': {
        need(att.role === 'screen', 'screen only');
        const it = s.queue.find((q) => q.id === msg.itemId && q.status === 'processing');
        if (!it) return;
        it.playable = true;
        break;
      }

      case 'react': {
        if (!(REACTIONS as readonly string[]).includes(msg.emoji)) return;
        const now = Date.now();
        const times = (this.reactions.get(me.id) ?? []).filter((t) => now - t < 60_000);
        if (times.length >= LIMITS.reactionsPerMinute) return;
        times.push(now);
        this.reactions.set(me.id, times);
        this.broadcast({ type: 'react', emoji: msg.emoji, nickname: me.nickname }, (a) => a.role === 'screen');
        return;
      }

      case 'screen.library': {
        need(att.role === 'screen', 'screen only');
        const songs = Array.isArray(msg.songs) ? msg.songs.slice(0, LIMITS.screenSongs) : [];
        s.localSongs = songs.filter((x) => x && typeof x.id === 'string' && SONG_ID.test(x.id)).map((x) => ({
          id: x.id, title: String(x.title ?? '').slice(0, 200) || x.id, artist: String(x.artist ?? '').slice(0, 200),
          durationMs: Math.max(0, Math.round(+x.durationMs || 0)), hasVocals: !!x.hasVocals, hasPitch: false,
          ...(x.language ? { language: String(x.language).slice(0, 16) } : {}), where: 'screen' as const,
        }));
        await this.touch();
        this.broadcast({ type: 'library', songs: this.mergedLibrary() });
        return;
      }

      case 'lyrics': {
        need(att.role === 'screen', 'screen only');
        if (msg.queueItemId !== s.nowPlaying?.id || !msg.lyrics || !Array.isArray(msg.lyrics.lines)) return;
        s.currentLyrics = { queueItemId: msg.queueItemId, lyrics: msg.lyrics };
        await this.save();
        this.broadcast({ type: 'lyrics', queueItemId: msg.queueItemId, lyrics: msg.lyrics }, (a) => a.memberId !== me.id);
        return;
      }

      case 'job.claim': {
        need(att.role === 'worker', 'workers only');
        const now = Date.now();
        const job = s.jobs.find((j) => j.state === 'waiting' ||
          (j.state === 'claimed' && now - (j.claimedAt ?? 0) > LIMITS.jobClaimTimeoutMs));
        if (job) {
          job.state = 'claimed';
          job.workerId = me.id;
          job.claimedAt = now;
          this.setItem(job.queueItemId, { progress: { stage: 'starting', pct: 0 } });
        }
        if (!job) {
          // a worker that claims again right after "no job" (old browser makers did, in a tight
          // loop) gets no answer: it asks again on its normal timer
          const last = this.emptyClaims.get(ws) ?? 0;
          this.emptyClaims.set(ws, now);
          if (now - last < 2000) return;
        }
        this.sendTo(ws, { type: 'job', job: job ?? null });
        if (!job) return;
        break;
      }

      case 'job.progress': {
        const job = s.jobs.find((j) => j.id === msg.jobId && j.workerId === me.id);
        if (!job) return;
        job.claimedAt = Date.now();
        this.setItem(job.queueItemId, {
          progress: { stage: String(msg.stage).slice(0, 20), pct: Math.max(0, Math.min(100, +msg.pct || 0)),
            etaS: msg.etaS == null ? undefined : Math.max(0, Math.round(+msg.etaS)) },
        });
        this.broadcastState();
        return; // progress is not worth a storage write
      }

      case 'job.done': {
        const job = s.jobs.find((j) => j.id === msg.jobId && j.workerId === me.id);
        if (!job) return;
        const hasResult = s.results.some((r) => r.jobId === job.id);
        await this.refreshLibrary(true);
        const online = this.library.find((x) => x.id === msg.songId);
        if (!hasResult && !online) throw new HttpError(400, 'the song was not uploaded (room result or library)');
        if (!SONG_ID.test(String(msg.songId))) throw new HttpError(400, 'bad song id');
        job.state = 'done';
        this.setItem(job.queueItemId, {
          songId: msg.songId, title: online?.title ?? job.title, artist: online?.artist ?? job.artist, status: 'ready',
          progress: undefined, hasResult,
        });
        await this.deleteUpload(job.uploadId);
        s.jobs = s.jobs.filter((j) => j !== job);
        this.broadcast({ type: 'library', songs: this.mergedLibrary() });
        break;
      }

      case 'job.failed': {
        const job = s.jobs.find((j) => j.id === msg.jobId && j.workerId === me.id);
        if (!job) return;
        job.state = 'failed';
        this.setItem(job.queueItemId, { status: 'failed', error: String(msg.error).slice(0, 200), progress: undefined });
        await this.deleteUpload(job.uploadId);
        s.jobs = s.jobs.filter((j) => j !== job);
        break;
      }

      default:
        return;
    }
    await this.touch();
    this.broadcastState();
  }

  async webSocketClose(ws: WebSocket) {
    await this.onLeave(ws);
  }

  async webSocketError(ws: WebSocket) {
    await this.onLeave(ws);
  }

  private async onLeave(ws: WebSocket) {
    if (!this.s) return;
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.role === 'worker') {
      const stillThere = this.socketsOf(att.memberId).some((w) => w !== ws);
      if (!stillThere) {
        for (const j of this.s.jobs) {
          if (j.state === 'claimed' && j.workerId === att.memberId) {
            j.state = 'waiting';
            j.workerId = undefined;
            this.setItem(j.queueItemId, { progress: { stage: 'waiting', pct: 0 } });
          }
        }
        await this.save();
        this.offerJobs();
      }
    }
    this.broadcastState(ws);
  }

  async alarm() {
    if (!this.s) return;
    if (Date.now() - this.s.lastActive >= LIMITS.roomIdleMs) await this.destroy();
    else await this.ctx.storage.setAlarm(this.s.lastActive + LIMITS.roomIdleMs);
  }

  // ------------------------------------------------------------------ helpers

  private checkQuota(me: StoredMember, admin: boolean) {
    const max = this.s!.settings.maxPerPerson;
    if (!admin && max > 0 && countFor(this.s!.queue, me.id) >= max) {
      throw new HttpError(429, `you already have ${max} songs in the queue`);
    }
  }

  private insert(item: QueueItem) {
    const s = this.s!;
    const at = fairInsertIndex(s.queue, item.memberId, s.settings.fair);
    s.queue.splice(at, 0, item);
  }

  private setItem(id: string, patch: Partial<QueueItem>) {
    const s = this.s!;
    const it = s.queue.find((q) => q.id === id) ?? (s.nowPlaying?.id === id ? s.nowPlaying : null);
    if (it) Object.assign(it, patch);
  }

  private dropJob(jobId: string) {
    const s = this.s!;
    const j = s.jobs.find((x) => x.id === jobId);
    if (!j) return;
    s.jobs = s.jobs.filter((x) => x !== j);
    this.ctx.waitUntil(this.deleteUpload(j.uploadId));
  }

  private async deleteUpload(id: string) {
    await this.env.LIBRARY.delete(`uploads/${this.s!.code}/${id}`);
    this.s!.uploads = this.s!.uploads.filter((u) => u.id !== id);
  }

  /** Nudge idle workers so they don't wait for their next poll. */
  private offerJobs() {
    if (!this.s!.jobs.some((j) => j.state === 'waiting')) return;
    for (const w of this.ctx.getWebSockets('worker')) this.sendTo(w, { type: 'job', job: null });
  }

  private async refreshLibrary(force = false) {
    if (!this.s!.ownerId) { this.library = []; return; }
    if (!force && Date.now() - this.libraryAt < 30_000) return;
    this.library = (await accountsOf(this.env).listSongs(this.s!.ownerId)).map((x) => ({ ...x, where: 'online' as const }));
    this.libraryAt = Date.now();
  }

  /** Songs guests can pick: the screen's own songs first, then the online library. */
  private mergedLibrary(): SongSummary[] {
    const local = this.s!.localSongs ?? [];
    const ids = new Set(local.map((x) => x.id));
    return [...local, ...this.library.filter((x) => !ids.has(x.id))]
      .sort((a, b) => (a.artist + a.title).localeCompare(b.artist + b.title));
  }

  private socketsOf(memberId: string): WebSocket[] {
    return this.ctx.getWebSockets().filter((w) => (w.deserializeAttachment() as Attachment)?.memberId === memberId);
  }

  private state(): RoomState {
    const s = this.s!;
    const online = new Set<string>();
    let workers = 0;
    for (const w of this.ctx.getWebSockets()) {
      const a = w.deserializeAttachment() as Attachment;
      if (!a) continue;
      online.add(a.memberId);
      if (a.role === 'worker') workers++;
    }
    return {
      code: s.code,
      members: s.members.filter((m) => !s.banned.includes(m.id) && (online.has(m.id) || Date.now() - m.lastSeen < 3600_000))
        .map((m) => ({ id: m.id, nickname: m.nickname, role: m.role, online: online.has(m.id) })),
      queue: s.queue, nowPlaying: s.nowPlaying, playback: s.playback, settings: s.settings, workersOnline: workers,
    };
  }

  private sendTo(ws: WebSocket, msg: ServerMsg | (ServerMsg & Record<string, unknown>)) {
    try { ws.send(JSON.stringify(msg)); } catch { /* socket already gone */ }
  }

  private broadcast(msg: ServerMsg, filter?: (a: Attachment) => boolean) {
    const data = JSON.stringify(msg);
    for (const w of this.ctx.getWebSockets()) {
      const a = w.deserializeAttachment() as Attachment;
      if (filter && (!a || !filter(a))) continue;
      try { w.send(data); } catch { /* gone */ }
    }
  }

  private broadcastState(except?: WebSocket) {
    const data = JSON.stringify({ type: 'state', state: this.state() } satisfies ServerMsg);
    for (const w of this.ctx.getWebSockets()) {
      if (w === except) continue;
      try { w.send(data); } catch { /* gone */ }
    }
  }

  private async touch() {
    this.s!.lastActive = Date.now();
    await this.save();
    // the idle alarm only needs to be roughly right (rooms close after hours): set it now and then
    if (this.s!.lastActive - this.alarmSetAt > 10 * 60_000) {
      this.alarmSetAt = this.s!.lastActive;
      await this.ctx.storage.setAlarm(this.s!.lastActive + LIMITS.roomIdleMs);
    }
  }

  private async save() {
    if (this.s) await this.ctx.storage.put('room', this.s);
  }

  private async destroy() {
    if (!this.s) return;
    for (const u of this.s.uploads) await this.env.LIBRARY.delete(`uploads/${this.s.code}/${u.id}`);
    for (const r of this.s.results ?? []) await this.env.LIBRARY.delete(`rooms/${this.s.code}/results/${r.jobId}.jkp`);
    for (const w of this.ctx.getWebSockets()) w.close(4404, 'room closed');
    await this.ctx.storage.deleteAll();
    this.s = null;
  }
}

