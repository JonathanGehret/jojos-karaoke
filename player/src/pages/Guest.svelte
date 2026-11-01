<script lang="ts">
  // A guest's phone: join with a nickname, see synced lyrics, pick songs, request new ones.
  // With the host token (from the host's 📱 QR or after casting) it is also the remote control.
  import { onDestroy } from 'svelte';
  import type { Lyrics } from '$shared/lyrics';
  import { REACTIONS, cleanNickname } from '$shared/protocol';
  import LyricsView from '../components/LyricsView.svelte';
  import QueueList from '../components/QueueList.svelte';
  import Toast from '../components/Toast.svelte';
  import { roomInfo, uploadForRequest } from '../lib/api';
  import { downloadBytes, importJkp } from '../lib/localLibrary';
  import { keepAwake, vibrate } from '../lib/device';
  import { mmss } from '../lib/format';
  import { navigate, takeHashParam } from '../lib/nav.svelte';
  import { RoomConnection } from '../lib/room.svelte';
  import { store } from '../lib/store';

  let { code }: { code: string } = $props();

  const fromHash = takeHashParam('admin');
  if (fromHash) store.setAdminToken(code, fromHash);
  const admin = store.adminToken(code);

  let nickname = $state(store.nickname);
  let joined = $state(!!store.memberToken(code) || !!admin);
  let ownerName = $state<string | null>(null);
  let missing = $state(false);
  let conn = $state<RoomConnection | null>(null);
  let tab = $state<'lyrics' | 'songs' | 'queue' | 'request' | 'host'>('songs');
  let search = $state('');

  let toast = $state<string | null>(null);
  let alerted = '';

  // request form
  let reqFile = $state<File | null>(null);
  let reqTitle = $state('');
  let reqArtist = $state('');
  let reqLyrics = $state('');
  let reqBusy = $state(false);

  roomInfo(code).then((r) => (ownerName = r.ownerName)).catch(() => (missing = true));

  function connect() {
    conn = new RoomConnection({ code, role: admin ? 'admin' : 'guest', nickname: nickname || undefined, admin });
    keepAwake();
  }
  if (joined) connect();

  function join(e: Event) {
    e.preventDefault();
    const n = cleanNickname(nickname);
    if (!n) return;
    store.nickname = nickname = n;
    joined = true;
    connect();
  }

  function say(m: string) {
    toast = m;
    setTimeout(() => { if (toast === m) toast = null; }, 3500);
  }

  const st = $derived(conn?.state ?? null);
  const you = $derived(conn?.you ?? null);
  const now = $derived(st?.nowPlaying ?? null);
  const myTurn = $derived(!!now && now.memberId === you?.id);
  const nextUp = $derived(st?.queue.find((q) => q.status === 'ready') ?? null);
  const iAmNext = $derived(!!nextUp && nextUp.memberId === you?.id);
  const songs = $derived((conn?.library ?? []).filter((s) =>
    (s.title + ' ' + s.artist).toLowerCase().includes(search.trim().toLowerCase())));

  // the screen sends the lyrics of the song it plays
  const lyrics = $derived<Lyrics | null>(conn?.lyrics && conn.lyrics.queueItemId === now?.id ? conn.lyrics.lyrics : null);
  let shownFor = '';
  $effect(() => {
    const id = now?.id ?? '';
    if (id && id !== shownFor) { shownFor = id; tab = 'lyrics'; }
  });

  const myResults = $derived((st?.queue ?? []).concat(now ? [now] : []).filter((q) => q.hasResult && q.memberId === you?.id));
  async function fetchResult(itemId: string): Promise<Uint8Array> {
    const r = await fetch(`/api/rooms/${code}/results/${itemId}?member=${encodeURIComponent(conn?.memberToken ?? '')}`);
    if (!r.ok) throw new Error('could not download it');
    return new Uint8Array(await r.arrayBuffer());
  }
  async function keep(it: { id: string; title: string; artist: string }, how: 'download' | 'save') {
    try {
      const b = await fetchResult(it.id);
      if (how === 'download') downloadBytes(b, `${[it.artist, it.title].filter(Boolean).join(' - ') || 'song'}.jkp`);
      else { await importJkp(b); say('Saved in My songs on this phone.'); }
    } catch (e) { say((e as Error).message); }
  }
  $effect(() => {
    const k = myTurn ? `turn:${now?.id}` : iAmNext ? `next:${nextUp?.id}` : '';
    if (k && k !== alerted) { alerted = k; vibrate(myTurn ? [200, 100, 200, 100, 400] : [150, 80, 150]); }
  });


  const clock = () => (conn ? conn.songPosition() - store.deviceOffsetMs : 0);

  function add(id: string) {
    conn?.send({ type: 'queue.add', songId: id });
    say('Added to the queue');
  }

  async function request(e: Event) {
    e.preventDefault();
    if (!reqFile || !conn?.memberToken) return;
    if (reqFile.size > 60 * 1024 * 1024) return say('That file is too big (max 60 MB).');
    reqBusy = true;
    try {
      const { uploadId } = await uploadForRequest(code, conn.memberToken, reqFile);
      conn.send({ type: 'request.add', uploadId, title: reqTitle.trim() || reqFile.name.replace(/\.[^.]+$/, ''),
        artist: reqArtist.trim(), lyrics: reqLyrics.trim() || undefined });
      reqFile = null; reqTitle = ''; reqArtist = ''; reqLyrics = '';
      say('Request sent! It will show in the queue while it is being made.');
      tab = 'queue';
    } catch (err) { say((err as Error).message); }
    finally { reqBusy = false; }
  }

  function pickFile(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0] ?? null;
    reqFile = f;
    if (f && !reqTitle) {
      const base = f.name.replace(/\.[^.]+$/, '');
      const m = base.match(/^(.+?)\s+-\s+(.+)$/);
      if (m) { reqArtist ||= m[1]; reqTitle = m[2]; } else reqTitle = base;
    }
  }

  const ctl = (action: 'play' | 'pause' | 'skip' | 'restart') => conn?.send({ type: 'control', action });
  const pb = $derived(conn?.playback ?? null);

  onDestroy(() => conn?.close());
</script>

{#if missing}
  <main class="page"><h2>Room {code} not found</h2><p>Check the code with the host.</p>
    <button onclick={() => navigate('/')}>Home</button></main>
{:else if !joined}
  <main class="page join-page">
    <h1>Room <span class="code">{code}</span></h1>
    {#if ownerName}<p class="muted">{ownerName}'s party</p>{/if}
    <form class="card stack" onsubmit={join}>
      <label for="nick">Your name</label>
      <input id="nick" bind:value={nickname} maxlength="24" autocomplete="nickname" placeholder="Nickname" required />
      <button class="primary big" type="submit">Join</button>
    </form>
  </main>
{:else if conn?.status === 'kicked'}
  <main class="page"><h2>You were removed from this room.</h2><button onclick={() => navigate('/')}>Home</button></main>
{:else if conn?.status === 'gone'}
  <main class="page"><h2>This party has ended.</h2><button onclick={() => navigate('/')}>Home</button></main>
{:else}
  <div class="guest">
    <header class="bar">
      <span class="code">{code}</span>
      <span class="muted">{you?.nickname ?? nickname}{#if admin} · host{/if}</span>
      {#if conn?.status !== 'open'}<span class="badge fail">reconnecting…</span>{/if}
    </header>

    {#if myTurn}
      <div class="banner turn">🎤 Your turn: {now?.title}</div>
    {:else if iAmNext}
      <div class="banner next">You're up next: {nextUp?.title}</div>
    {/if}

    <nav class="tabs">
      <button class:on={tab === 'lyrics'} onclick={() => (tab = 'lyrics')}>Lyrics</button>
      <button class:on={tab === 'songs'} onclick={() => (tab = 'songs')}>Songs</button>
      <button class:on={tab === 'queue'} onclick={() => (tab = 'queue')}>Queue ({st?.queue.length ?? 0})</button>
      <button class:on={tab === 'request'} onclick={() => (tab = 'request')}>Request</button>
      {#if admin}<button class:on={tab === 'host'} onclick={() => (tab = 'host')}>Host</button>{/if}
    </nav>

    <section class="panel">
      {#if tab === 'lyrics'}
        {#if now}
          <div class="now"><b>{now.title}</b> <span class="muted">· {now.artist} · {now.nickname}</span>
            {#if pb?.state === 'paused'}<span class="badge">paused</span>{/if}</div>
          {#if lyrics}
            <LyricsView {lyrics} {clock} size="phone" />
          {:else}
            <p class="muted">Loading lyrics…</p>
          {/if}
          <div class="react-bar">
            {#each REACTIONS as r}<button onclick={() => conn?.send({ type: 'react', emoji: r })}>{r}</button>{/each}
          </div>
        {:else}
          <p class="muted center">Nothing is playing yet.{#if nextUp} Next: <b>{nextUp.title}</b> ({nextUp.nickname}).{/if}</p>
        {/if}

      {:else if tab === 'songs'}
        <input class="search" type="search" bind:value={search} placeholder="Search {conn?.library.length ?? 0} songs" />
        <ul class="songs">
          {#each songs as s (s.id)}
            <li><button class="song" onclick={() => add(s.id)}>
              <span><b>{s.title}</b><br /><span class="muted">{s.artist} · {mmss(s.durationMs)}</span></span>
              <span class="plus">＋</span></button></li>
          {:else}
            <li class="muted">{search ? 'No match. Try the Request tab!' : 'The library is empty.'}</li>
          {/each}
        </ul>

      {:else if tab === 'queue'}
        {#if now}<p class="muted">Now: <b>{now.title}</b> · {now.nickname}</p>{/if}
        {#each myResults as r (r.id)}
          <p class="card">Your karaoke version of <b>{r.title}</b> is ready.
            <button class="small" onclick={() => keep(r, 'download')}>Download .jkp</button>
            <button class="small" onclick={() => keep(r, 'save')}>Save in My songs</button></p>
        {/each}
        <QueueList items={st?.queue ?? []} youId={you?.id} admin={!!admin}
          onmove={(id, to) => conn?.send({ type: 'queue.move', itemId: id, to })}
          onremove={(id) => conn?.send({ type: 'queue.remove', itemId: id })}
          onplaynext={(id) => conn?.send({ type: 'queue.playNext', itemId: id })} />

      {:else if tab === 'request'}
        <form class="stack" onsubmit={request}>
          <p class="hint">Not in the list? Upload your own copy of the song: it is turned into karaoke during the
            party, and you can download the karaoke version afterwards.</p>
          {#if !st?.workersOnline}
            <p class="hint warn">No device is making songs right now. Your request will wait until the host
              turns on “Make requests on this device” or a friend helps from <b>Make a song</b>.</p>
          {/if}
          <input type="file" accept="audio/*,.mp3,.m4a,.flac,.wav,.ogg,.opus" onchange={pickFile} required />
          <input bind:value={reqTitle} placeholder="Title" maxlength="120" required />
          <input bind:value={reqArtist} placeholder="Artist" maxlength="120" />
          <textarea bind:value={reqLyrics} rows="4" placeholder="Lyrics (optional; otherwise looked up or transcribed)"></textarea>
          <button class="primary" type="submit" disabled={reqBusy || !reqFile}>{reqBusy ? 'Uploading…' : 'Request song'}</button>
        </form>

      {:else if tab === 'host' && admin}
        <div class="stack">
          <div class="row">
            <button onclick={() => ctl('restart')}>⏮</button>
            <button class="primary" onclick={() => ctl(pb?.state === 'playing' ? 'pause' : 'play')}>{pb?.state === 'playing' ? '⏸ Pause' : '▶ Play'}</button>
            <button onclick={() => ctl('skip')}>⏭ Skip</button>
          </div>
          <div class="row">Key
            <button onclick={() => conn?.send({ type: 'control.set', key: (pb?.key ?? 0) - 1 })}>−</button>
            <b>{pb?.key ?? 0}</b>
            <button onclick={() => conn?.send({ type: 'control.set', key: (pb?.key ?? 0) + 1 })}>+</button>
            Tempo
            <button onclick={() => conn?.send({ type: 'control.set', rate: (pb?.rate ?? 1) - 0.05 })}>−</button>
            <b>{Math.round((pb?.rate ?? 1) * 100)}%</b>
            <button onclick={() => conn?.send({ type: 'control.set', rate: (pb?.rate ?? 1) + 0.05 })}>+</button>
          </div>
          <label>Guide vocal <input type="range" min="0" max="1" step="0.05" value={pb?.vocal ?? 0}
            onchange={(e) => conn?.send({ type: 'control.set', vocal: +(e.target as HTMLInputElement).value })} /></label>
          <h4>People</h4>
          <ul class="plain">
            {#each st?.members.filter((m) => m.role === 'guest' && m.id !== you?.id) ?? [] as m (m.id)}
              <li class:muted={!m.online}>{m.nickname}
                <button class="link danger" onclick={() => confirm(`Remove ${m.nickname}?`) && conn?.send({ type: 'kick', memberId: m.id })}>remove</button></li>
            {/each}
          </ul>
          <button onclick={() => navigate(`/screen/${code}`)}>Make this device the screen</button>
        </div>
      {/if}
    </section>
    <Toast message={toast ?? conn?.error ?? null} />
  </div>
{/if}
