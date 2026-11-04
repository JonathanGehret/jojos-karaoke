import { beforeAll, describe, expect, inject, it } from 'vitest';
import { request } from 'node:http';
import { Client } from './client';

/** HTTP status of a WebSocket handshake (101 when accepted). */
function wsStatus(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(base() + path, { headers: {
      connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
    req.on('response', (r) => { r.resume(); resolve(r.statusCode!); });
    req.on('upgrade', (_r, sock) => { sock.destroy(); resolve(101); });
    req.on('error', reject);
    req.end();
  });
}

const base = () => inject('base' as never) as string;
const ws = (path: string) => base().replace('http', 'ws') + path;

async function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  const r = await fetch(base() + path, { ...init, headers });
  const body = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.arrayBuffer();
  return { status: r.status, body: body as any };
}

const LYRICS = { version: 1, lines: [{ start: 1000, end: 2000, words: [{ t: 'la', s: 1000, e: 2000 }] }] };

async function addSong(token: string, id: string, title: string) {
  const audio = new Uint8Array(2048).fill(7);
  expect((await api(`/api/library/songs/${id}/files/instrumental.opus`, { method: 'PUT', body: audio, token })).status).toBe(200);
  expect((await api(`/api/library/songs/${id}/files/lyrics.json`, { method: 'PUT', body: JSON.stringify(LYRICS), token })).status).toBe(200);
  const manifest = { formatVersion: 1, id, title, artist: 'Nobody', durationMs: 5000,
    files: { instrumental: 'instrumental.opus', lyrics: 'lyrics.json' } };
  const r = await api(`/api/library/songs/${id}/commit`, { method: 'POST', body: JSON.stringify(manifest), token });
  expect(r.status).toBe(200);
}

let owner: string;
let code: string;
let admin: string;

beforeAll(async () => {
  const r = await api('/api/accounts', { method: 'POST', body: JSON.stringify({ name: 'Host' }) });
  expect(r.status).toBe(201);
  owner = r.body.token;
  await addSong(owner, 'nobody-first-aaaaaa', 'First');
  await addSong(owner, 'nobody-second-bbbbbb', 'Second');
  const room = await api('/api/rooms', { method: 'POST', token: owner });
  expect(room.status).toBe(200);
  ({ code, adminToken: admin } = room.body);
  expect(code).toMatch(/^[A-Z2-9]{4}$/);
});

describe('accounts and library', () => {
  it('rejects bad tokens and reports who you are', async () => {
    expect((await api('/api/me', { token: 'nope' })).status).toBe(401);
    expect((await api('/api/me', { token: owner })).body).toMatchObject({ name: 'Host', role: 'owner' });
  });

  it('lists songs and refuses a commit whose files were not uploaded', async () => {
    const r = await api('/api/library/songs', { token: owner });
    expect(r.body.songs.map((s: any) => s.title)).toEqual(['First', 'Second']);
    const bad = { formatVersion: 1, id: 'nobody-ghost-cccccc', title: 'Ghost', artist: '', durationMs: 1,
      files: { instrumental: 'instrumental.opus', lyrics: 'lyrics.json' } };
    expect((await api('/api/library/songs/nobody-ghost-cccccc/commit', { method: 'POST', body: JSON.stringify(bad), token: owner })).status).toBe(400);
  });

  it('contributor tokens can add songs but not delete', async () => {
    const t = await api('/api/tokens', { method: 'POST', body: JSON.stringify({ name: 'Friend' }), token: owner });
    expect(t.status).toBe(201);
    await addSong(t.body.token, 'nobody-third-dddddd', 'Third');
    expect((await api('/api/library/songs/nobody-third-dddddd', { method: 'DELETE', token: t.body.token })).status).toBe(403);
    expect((await api('/api/tokens', { token: t.body.token })).status).toBe(403);
    expect((await api('/api/library/songs/nobody-third-dddddd', { method: 'DELETE', token: owner })).status).toBe(200);
  });
});

describe('lyrics lookup', () => {
  it('answers without an account and without asking upstream when nothing is given', async () => {
    expect(await api('/api/lyrics/search')).toEqual({ status: 200, body: { results: [] } });
    expect(await api('/api/lyrics')).toEqual({ status: 200, body: { synced: null, plain: null } });
    expect((await api('/api/lyrics/nope')).status).toBe(404);
  });
});

describe('room', () => {
  it('runs a party: fair queue, sync relay, media access, kick', async () => {
    expect((await api(`/api/rooms/${code}/info`)).body.ownerName).toBe('Host');
    expect((await api('/api/rooms/ZZZZ/info')).status).toBe(404);

    const screen = new Client(ws(`/api/rooms/${code}/ws?role=screen&token=${admin}`));
    expect((await screen.next('welcome')).you.role).toBe('screen');
    const ann = new Client(ws(`/api/rooms/${code}/ws?nickname=Ann`));
    const annWelcome = await ann.next('welcome');
    const annToken = (annWelcome.you as any).token as string;
    expect(annToken).toBeTruthy();
    expect((await ann.next('library')).songs).toHaveLength(2);
    const ben = new Client(ws(`/api/rooms/${code}/ws?nickname=Ben`));
    const benWelcome = await ben.next('welcome');
    const benToken = (benWelcome.you as any).token as string;

    // guests can't pretend to be the screen
    const fake = await wsStatus(`/api/rooms/${code}/ws?role=screen&token=wrong`);
    expect(fake).toBe(403);

    // clock
    ann.send({ type: 'ping', c: 123 });
    const pong = await ann.next('pong');
    expect(pong.c).toBe(123);
    expect(Math.abs(pong.s - Date.now())).toBeLessThan(5000);

    // fair rotation: Ann, Ann, then Ben → Ann, Ben, Ann
    ann.send({ type: 'queue.add', songId: 'nobody-first-aaaaaa' });
    await screen.state((s) => s.queue.length === 1);
    ann.send({ type: 'queue.add', songId: 'nobody-second-bbbbbb' });
    await screen.state((s) => s.queue.length === 2);
    ben.send({ type: 'queue.add', songId: 'nobody-first-aaaaaa' });
    const st = await screen.state((s) => s.queue.length === 3);
    expect(st.queue.map((q: any) => q.nickname)).toEqual(['Ann', 'Ben', 'Ann']);

    // per-person limit
    screen.send({ type: 'settings', settings: { maxPerPerson: 2 } });
    await screen.state((s) => s.settings.maxPerPerson === 2);
    ann.send({ type: 'queue.add', songId: 'nobody-first-aaaaaa' });
    expect((await ann.next('error')).message).toMatch(/already have 2/);
    ann.send({ type: 'queue.add', songId: 'not-a-song' });
    expect((await ann.next('error')).message).toMatch(/not in the library/);

    // guests can't reorder or remove other people's songs
    ben.send({ type: 'queue.playNext', itemId: st.queue[2].id });
    expect((await ben.next('error')).message).toBe('host only');
    ben.send({ type: 'queue.remove', itemId: st.queue[0].id });
    expect((await ben.next('error')).message).toBe('not your song');
    screen.send({ type: 'queue.playNext', itemId: st.queue[2].id });
    await screen.state((s) => s.queue[0].id === st.queue[2].id);

    // advance + playback relay
    screen.send({ type: 'advance' });
    const playing = await ann.state((s) => s.nowPlaying?.id === st.queue[2].id);
    expect(playing.queue).toHaveLength(2);
    const pb = { state: 'playing', positionMs: 1500, atServerMs: Date.now(), rate: 1, key: -2, vocal: 0.3, queueItemId: null, songId: null };
    screen.send({ type: 'playback', playback: pb });
    const got = await ben.next('playback');
    expect(got.playback).toMatchObject({ state: 'playing', positionMs: 1500, key: -2, songId: 'nobody-second-bbbbbb' });

    // admin controls are forwarded to the screen only
    ann.send({ type: 'control', action: 'pause' });
    expect((await ann.next('error')).message).toBe('host only');

    // reactions reach the screen
    ben.send({ type: 'react', emoji: '🔥' });
    expect(await screen.next('react')).toMatchObject({ emoji: '🔥', nickname: 'Ben' });

    // media: guests get lyrics but no audio; the screen gets audio; links are signed
    const gm = await api(`/api/rooms/${code}/songs/nobody-first-aaaaaa/media?member=${annToken}`);
    expect(Object.keys(gm.body.urls).sort()).toEqual(['lyrics']);
    const lyr = await fetch(gm.body.urls.lyrics.replace(/^https?:\/\/[^/]+/, base()));
    expect(await lyr.json()).toEqual(LYRICS);
    const sm = await api(`/api/rooms/${code}/songs/nobody-first-aaaaaa/media?admin=${admin}`);
    const instUrl = sm.body.urls.instrumental.replace(/^https?:\/\/[^/]+/, base());
    const inst = await fetch(instUrl, { headers: { range: 'bytes=0-99' } });
    expect(inst.status).toBe(206);
    expect((await inst.arrayBuffer()).byteLength).toBe(100);
    expect((await fetch(instUrl.replace(/sig=[^&]+/, 'sig=forged'))).status).toBe(403);
    expect((await api(`/api/rooms/${code}/songs/nobody-first-aaaaaa/media?member=wrong`)).status).toBe(403);

    // reconnect keeps identity
    const ann2 = new Client(ws(`/api/rooms/${code}/ws?member=${annToken}`));
    expect((await ann2.next('welcome')).you).toMatchObject({ id: annWelcome.you.id, nickname: 'Ann' });
    ann2.close();

    // kick removes Ben and his songs
    screen.send({ type: 'kick', memberId: benWelcome.you.id });
    expect(await ben.closed).toBe(4403);
    const after = await screen.state((s) => !s.queue.some((q: any) => q.nickname === 'Ben'));
    expect(after.queue.map((q: any) => q.nickname)).toEqual(['Ann']);
    const again = await wsStatus(`/api/rooms/${code}/ws?member=${benToken}`);
    expect(again).toBe(403);

    screen.close(); ann.close();
  });

  it('processes an on-the-spot request through a worker', async () => {
    const screen = new Client(ws(`/api/rooms/${code}/ws?role=screen&token=${admin}`));
    await screen.next('welcome');
    const cara = new Client(ws(`/api/rooms/${code}/ws?nickname=Cara`));
    const caraToken = ((await cara.next('welcome')).you as any).token;

    const up = await api(`/api/rooms/${code}/uploads?member=${caraToken}`, { method: 'POST', body: new Uint8Array(4096).fill(3) });
    expect(up.status).toBe(200);
    cara.send({ type: 'request.add', title: 'Brand New', artist: 'Nobody', uploadId: up.body.uploadId, lyrics: 'la la' });
    const req = await screen.state((s) => s.queue.some((q: any) => q.title === 'Brand New'));
    const item = req.queue.find((q: any) => q.title === 'Brand New');
    expect(item).toMatchObject({ status: 'processing', songId: null });

    // a worker needs a library token of the room's owner
    const badWorker = await wsStatus(`/api/rooms/${code}/ws?role=worker&token=nope`);
    expect(badWorker).toBe(403);
    const other = await api('/api/accounts', { method: 'POST', body: JSON.stringify({ name: 'Stranger' }) });
    const strangerWs = await wsStatus(`/api/rooms/${code}/ws?role=worker&token=${other.body.token}`);
    expect(strangerWs).toBe(403);

    // first worker claims, then disconnects: the job goes back to waiting
    const w1 = new Client(ws(`/api/rooms/${code}/ws?role=worker&token=${owner}`));
    await w1.next('welcome');
    w1.send({ type: 'job.claim' });
    const j1 = (await w1.next('job', (m) => !!m.job)).job!;
    expect(j1).toMatchObject({ title: 'Brand New', lyrics: 'la la', state: 'claimed' });
    w1.close();
    await new Promise((r) => setTimeout(r, 500));

    const w2 = new Client(ws(`/api/rooms/${code}/ws?role=worker&token=${owner}`));
    await w2.next('welcome');
    await screen.state((s) => s.workersOnline === 1);
    w2.send({ type: 'job.claim' });
    const job = (await w2.next('job', (m) => !!m.job)).job!;
    expect(job.id).toBe(j1.id);

    const dl = await api(`/api/rooms/${code}/uploads/${job.uploadId}`, { token: owner });
    expect(new Uint8Array(dl.body).length).toBe(4096);
    expect((await api(`/api/rooms/${code}/uploads/${job.uploadId}`, { token: other.body.token })).status).toBe(403);

    w2.send({ type: 'job.progress', jobId: job.id, stage: 'separate', pct: 40, etaS: 60 });
    await screen.state((s) => s.queue.find((q: any) => q.id === item.id)?.progress?.pct === 40);

    // done before upload → rejected; after upload → ready
    w2.send({ type: 'job.done', jobId: job.id, songId: 'nobody-brand-new-eeeeee' });
    expect((await w2.next('error')).message).toMatch(/not uploaded/);
    await addSong(owner, 'nobody-brand-new-eeeeee', 'Brand New');
    w2.send({ type: 'job.done', jobId: job.id, songId: 'nobody-brand-new-eeeeee' });
    const ready = await screen.state((s) => s.queue.find((q: any) => q.id === item.id)?.status === 'ready');
    expect(ready.queue.find((q: any) => q.id === item.id).songId).toBe('nobody-brand-new-eeeeee');
    expect((await cara.next('library', (m) => m.songs.length === 3)).songs).toHaveLength(3);
    expect((await api(`/api/rooms/${code}/uploads/${job.uploadId}`, { token: owner })).status).toBe(404); // cleaned up

    screen.close(); cara.close(); w2.close();
  });

  it('host saves edited lyrics and offset', async () => {
    const edited = { version: 1, lines: [{ start: 0, end: 0, words: [{ t: 'lo', s: 1200, e: 1900 }] }] };
    const r = await api(`/api/rooms/${code}/songs/nobody-first-aaaaaa/lyrics?admin=${admin}`, {
      method: 'PUT', body: JSON.stringify({ lyrics: edited, offsetMs: 120 }),
    });
    expect(r.status).toBe(200);
    const m = await api(`/api/rooms/${code}/songs/nobody-first-aaaaaa/media?admin=${admin}`);
    expect(m.body.manifest.offsetMs).toBe(120);
    const l = await (await fetch(m.body.urls.lyrics.replace(/^https?:\/\/[^/]+/, base()))).json();
    expect(l.lines[0]).toMatchObject({ start: 1200, end: 1900 });
    const bad = { version: 1, lines: [{ start: 0, end: 0, words: [{ t: 'a', s: 900, e: 100 }] }] };
    expect((await api(`/api/rooms/${code}/songs/nobody-first-aaaaaa/lyrics?admin=${admin}`, { method: 'PUT', body: JSON.stringify({ lyrics: bad }) })).status).toBe(400);
    expect((await api(`/api/rooms/${code}/songs/nobody-first-aaaaaa/lyrics?admin=nope`, { method: 'PUT', body: JSON.stringify({ lyrics: edited }) })).status).toBe(403);
  });
});

describe('rooms without an account (songs on the screen device)', () => {
  it('screen offers its own songs, relays lyrics, and a request comes back as a downloadable package', async () => {
    const r = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name: 'Jo' }) });
    expect(r.status).toBe(200);
    const { code: c, adminToken: adm, workerKey } = r.body;
    expect(workerKey).toMatch(/^wk_/);
    expect((await api(`/api/rooms/${c}/info`)).body.ownerName).toBe('Jo');

    const screen = new Client(ws(`/api/rooms/${c}/ws?role=screen&token=${adm}`));
    await screen.next('welcome');
    expect((await screen.next('library')).songs).toEqual([]);
    screen.send({ type: 'screen.library', songs: [
      { id: 'nobody-local-aaaaaa', title: 'Local One', artist: 'Nobody', durationMs: 5000, hasVocals: true, hasPitch: false },
      { id: 'BAD ID', title: 'x', artist: '', durationMs: 1, hasVocals: false, hasPitch: false },
    ] });
    const lib = await screen.next('library', (m) => m.songs.length > 0);
    expect(lib.songs).toEqual([expect.objectContaining({ id: 'nobody-local-aaaaaa', where: 'screen' })]);

    const bea = new Client(ws(`/api/rooms/${c}/ws?nickname=Bea`));
    const beaTok = ((await bea.next('welcome')).you as any).token;
    expect((await bea.next('library')).songs[0].title).toBe('Local One');

    // guests can't publish songs or lyrics
    bea.send({ type: 'screen.library', songs: [] });
    expect((await bea.next('error')).message).toBe('screen only');

    bea.send({ type: 'queue.add', songId: 'nobody-local-aaaaaa' });
    await screen.state((s) => s.queue.length === 1);
    screen.send({ type: 'advance' });
    const st = await screen.state((s) => s.nowPlaying?.songId === 'nobody-local-aaaaaa');
    const lyr = { version: 1, lines: [{ start: 100, end: 900, words: [{ t: 'la', s: 100, e: 900 }] }] };
    screen.send({ type: 'lyrics', queueItemId: st.nowPlaying.id, lyrics: lyr });
    expect((await bea.next('lyrics')).lyrics).toEqual(lyr);
    // late joiners get the current lyrics in their welcome burst
    const cid = new Client(ws(`/api/rooms/${c}/ws?nickname=Cid`));
    await cid.next('welcome');
    expect((await cid.next('lyrics')).queueItemId).toBe(st.nowPlaying.id);
    // lyrics for a song that isn't playing are ignored
    screen.send({ type: 'lyrics', queueItemId: 'nope', lyrics: lyr });

    // no online library in this room
    expect((await api(`/api/rooms/${c}/songs/nobody-local-aaaaaa/media?admin=${adm}`)).status).toBe(404);

    // request processed by a maker using the worker key
    const up = await api(`/api/rooms/${c}/uploads?member=${beaTok}`, { method: 'POST', body: new Uint8Array(1000).fill(1) });
    bea.send({ type: 'request.add', title: 'Brought Along', artist: 'Nobody', uploadId: up.body.uploadId });
    const withReq = await screen.state((s) => s.queue.some((q: any) => q.title === 'Brought Along'));
    const reqItem = withReq.queue.find((q: any) => q.title === 'Brought Along');
    expect(await wsStatus(`/api/rooms/${c}/ws?role=worker&token=wk_wrong`)).toBe(403);
    const w = new Client(ws(`/api/rooms/${c}/ws?role=worker&token=${workerKey}`));
    await w.next('welcome');
    w.send({ type: 'job.claim' });
    const job = (await w.next('job', (m) => !!m.job)).job!;
    expect((await api(`/api/rooms/${c}/uploads/${job.uploadId}`, { token: workerKey })).status).toBe(200);
    expect((await api(`/api/rooms/${c}/uploads/${job.uploadId}`, { token: beaTok })).status).toBe(403);

    // a processing request is skipped by advance until the screen says it can play it early
    bea.send({ type: 'queue.playable', itemId: reqItem.id });
    expect((await bea.next('error')).message).toBe('screen only');
    screen.send({ type: 'advance' });
    expect((await screen.state((s) => s.nowPlaying === null)).queue.some((q: any) => q.id === reqItem.id)).toBe(true);
    screen.send({ type: 'queue.playable', itemId: reqItem.id });
    await screen.state((s) => s.queue.find((q: any) => q.id === reqItem.id)?.playable === true);
    screen.send({ type: 'advance' });
    const early = await screen.state((s) => s.nowPlaying?.id === reqItem.id);
    expect(early.nowPlaying).toMatchObject({ status: 'processing', playable: true, songId: null });

    // job.done without a result is refused
    w.send({ type: 'job.done', jobId: job.id, songId: 'nobody-brought-along-bbbbbb' });
    expect((await w.next('error')).message).toMatch(/not uploaded/);
    const pkg = new Uint8Array(3000).fill(9);
    expect((await api(`/api/rooms/${c}/results/${job.id}`, { method: 'POST', body: pkg, token: beaTok })).status).toBe(403);
    expect((await api(`/api/rooms/${c}/results/${job.id}`, { method: 'POST', body: pkg, token: workerKey })).status).toBe(200);
    w.send({ type: 'job.done', jobId: job.id, songId: 'nobody-brought-along-bbbbbb' });
    // finishing while it plays updates the playing item
    const done = await screen.state((s) => s.nowPlaying?.id === reqItem.id && s.nowPlaying.status === 'ready');
    expect(done.nowPlaying).toMatchObject({ songId: 'nobody-brought-along-bbbbbb', hasResult: true });

    // the requester and the host can download the package; others can't
    const mine = await api(`/api/rooms/${c}/results/${reqItem.id}?member=${beaTok}`);
    expect(mine.status).toBe(200);
    expect(new Uint8Array(mine.body)).toEqual(pkg);
    expect((await api(`/api/rooms/${c}/results/${job.id}?admin=${adm}`)).status).toBe(200);
    const cidTok = ((await new Promise<any>((res) => { const x = new Client(ws(`/api/rooms/${c}/ws?nickname=Dee`)); x.next('welcome').then((m) => { res(m); x.close(); }); })).you).token;
    expect((await api(`/api/rooms/${c}/results/${reqItem.id}?member=${cidTok}`)).status).toBe(403);

    // closing the room deletes the results
    expect((await api(`/api/rooms/${c}/close?admin=${adm}`, { method: 'POST' })).status).toBe(200);
    expect((await api(`/api/rooms/${c}/info`)).status).toBe(404);
    screen.close(); bea.close(); cid.close(); w.close();
  });
});

describe('browser maker assets', () => {
  it('does not answer a worker that re-claims right after "no job" (no ping-pong loop)', async () => {
    const r = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name: 'Jo' }) });
    const { code: c, workerKey } = r.body;
    const w = new Client(ws(`/api/rooms/${c}/ws?role=worker&token=${workerKey}`));
    await w.next('welcome');
    w.send({ type: 'job.claim' });
    expect((await w.next('job')).job).toBeNull();
    for (let i = 0; i < 5; i++) w.send({ type: 'job.claim' });
    await new Promise((ok) => setTimeout(ok, 500));
    expect(w.inbox.filter((m) => m.type === 'job')).toHaveLength(0);
    w.close();
  });

  it('an app file that no longer exists is a 404, not the start page (old tabs would crash on it)', async () => {
    const r = await fetch(base() + '/assets/make.worker-gone123.js');
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type') ?? '').not.toContain('text/html');
  });

  it('only proxies allow-listed Hugging Face files', async () => {
    expect((await api('/api/hf/someone/else/resolve/main/config.json')).status).toBe(404);
    expect((await api('/api/hf/Xenova/whisper-small/resolve/dev/config.json')).status).toBe(404);
    expect((await api('/api/hf/Xenova/whisper-small/resolve/main/../../secret.json')).status).toBe(404);
    expect((await api('/api/hf/Xenova/whisper-small/resolve/main/run.sh')).status).toBe(404);
  });

  it('looks lyrics up without an account', async () => {
    const r = await api('/api/lyrics');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ synced: null, plain: null });
  });
});
