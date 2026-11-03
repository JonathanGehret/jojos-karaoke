<script lang="ts">
  // A guest's phone: join with a nickname, see synced lyrics, pick songs, request new ones.
  // With the host token (from the host's 📱 QR or after casting) it is also the remote control.
  import { onDestroy } from 'svelte';
  import {
    AudioLines, Download, Gamepad2, ListMusic, MicVocal, Minus, Music, Pause, Play, Plus, Save, Search,
    SkipBack, SkipForward, Upload, User, WifiOff, X,
  } from '@lucide/svelte';
  import type { Lyrics } from '$shared/lyrics';
  import { REACTIONS, cleanNickname } from '$shared/protocol';
  import LyricsView from '../components/LyricsView.svelte';
  import QueueList from '../components/QueueList.svelte';
  import RequestForm from '../components/RequestForm.svelte';
  import Toast from '../components/Toast.svelte';
  import { roomInfo } from '../lib/api';
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

  const ctl = (action: 'play' | 'pause' | 'skip' | 'restart') => conn?.send({ type: 'control', action });
  const pb = $derived(conn?.playback ?? null);

  onDestroy(() => conn?.close());
</script>

{#if missing}
  <main class="page"><div class="empty-state"><Music size={40} /><h2>Room {code} not found</h2><p>Check the code with the host.</p>
    <button onclick={() => navigate('/')}>Home</button></div></main>
{:else if !joined}
  <main class="page join-page">
    <div class="logo" aria-hidden="true"><MicVocal size={34} /></div>
    <h1>Room <span class="code">{code}</span></h1>
    {#if ownerName}<p class="muted">{ownerName}'s party</p>{/if}
    <form class="card stack" onsubmit={join}>
      <label for="nick" class="field-label">Your name</label>
      <input id="nick" bind:value={nickname} maxlength="24" autocomplete="nickname" placeholder="Nickname" required />
      <button class="primary big" type="submit">Join the party</button>
    </form>
  </main>
{:else if conn?.status === 'kicked'}
  <main class="page"><div class="empty-state"><h2>You were removed from this room.</h2><button onclick={() => navigate('/')}>Home</button></div></main>
{:else if conn?.status === 'gone'}
  <main class="page"><div class="empty-state"><Music size={40} /><h2>This party has ended.</h2><p>Thanks for singing!</p>
    <button onclick={() => navigate('/')}>Home</button></div></main>
{:else}
  <div class="guest">
    <header class="bar">
      <span class="code">{code}</span>
      <span class="spacer"></span>
      {#if conn?.status !== 'open'}<span class="badge fail"><WifiOff size={12} />reconnecting…</span>{/if}
      <span class="who"><User size={16} />{you?.nickname ?? nickname}{#if admin} · host{/if}</span>
    </header>

    {#if myTurn}
      <div class="banner turn" role="status"><MicVocal size={20} />Your turn: {now?.title}</div>
    {:else if iAmNext}
      <div class="banner next" role="status">You're up next: {nextUp?.title}</div>
    {/if}

    <section class="panel">
      {#if tab === 'lyrics'}
        {#if now}
          <div class="now-card"><AudioLines size={22} class="eq" />
            <span class="what"><b>{now.title}</b><span class="muted">{now.artist ? `${now.artist} · ` : ''}sung by {now.nickname}</span></span>
            {#if pb?.state === 'paused'}<span class="badge">paused</span>{/if}</div>
          {#if lyrics}
            <LyricsView {lyrics} {clock} size="phone" />
          {:else}
            <p class="muted center">Loading lyrics…</p>
          {/if}
          <div class="react-bar">
            {#each REACTIONS as r}<button onclick={() => conn?.send({ type: 'react', emoji: r })} aria-label="React {r}">{r}</button>{/each}
          </div>
        {:else}
          <div class="empty-state"><Music size={40} /><b>Nothing is playing yet.</b>
            {#if nextUp}<span>Next: <b>{nextUp.title}</b> ({nextUp.nickname})</span>
            {:else}<span>Pick a song and it starts on the big screen.</span>
              <button class="primary" onclick={() => (tab = 'songs')}><Search size={18} />Find a song</button>{/if}
          </div>
        {/if}

      {:else if tab === 'songs'}
        <div class="search-box search"><Search size={18} />
          <input type="search" bind:value={search} placeholder="Search {conn?.library.length ?? 0} songs" aria-label="Search songs" /></div>
        <ul class="songs">
          {#each songs as s (s.id)}
            <li><button class="song" onclick={() => add(s.id)} aria-label="Add {s.title} to the queue">
              <span class="what"><b>{s.title}</b><span class="muted">{s.artist}{s.artist ? ' · ' : ''}{mmss(s.durationMs)}</span></span>
              <span class="plus"><Plus size={20} /></span></button></li>
          {:else}
            <li class="empty-state">
              {#if search}<span>No match for “{search}”.</span><button onclick={() => (tab = 'request')}><Upload size={18} />Request it</button>
              {:else}<Music size={36} /><span>The host hasn't added songs yet.</span>
                <button onclick={() => (tab = 'request')}><Upload size={18} />Bring your own</button>{/if}
            </li>
          {/each}
        </ul>

      {:else if tab === 'queue'}
        {#if now}<div class="now-card"><AudioLines size={22} class="eq" /><span class="what"><b>{now.title}</b>
          <span class="muted">now · {now.nickname}</span></span></div>{/if}
        {#each myResults as r (r.id)}
          <div class="card"><p style="margin-top:0">Your karaoke version of <b>{r.title}</b> is ready.</p>
            <div class="row"><button class="small" onclick={() => keep(r, 'download')}><Download size={16} />Download .jkp</button>
            <button class="small" onclick={() => keep(r, 'save')}><Save size={16} />Save in My songs</button></div></div>
        {/each}
        <QueueList items={st?.queue ?? []} youId={you?.id} admin={!!admin}
          onmove={(id, to) => conn?.send({ type: 'queue.move', itemId: id, to })}
          onremove={(id) => conn?.send({ type: 'queue.remove', itemId: id })}
          onplaynext={(id) => conn?.send({ type: 'queue.playNext', itemId: id })} />

      {:else if tab === 'request'}
        <RequestForm {code} {conn} workersOnline={!!st?.workersOnline} onerror={say}
          onsent={() => { say('Request sent! It will show in the queue while it is being made.'); tab = 'queue'; }} />

      {:else if tab === 'host' && admin}
        <div class="stack">
          <div class="remote">
            <button onclick={() => ctl('restart')} aria-label="Restart"><SkipBack size={22} /></button>
            <button class="primary" onclick={() => ctl(pb?.state === 'playing' ? 'pause' : 'play')} aria-label={pb?.state === 'playing' ? 'Pause' : 'Play'}>
              {#if pb?.state === 'playing'}<Pause size={28} />{:else}<Play size={28} />{/if}</button>
            <button onclick={() => ctl('skip')} aria-label="Skip"><SkipForward size={22} /></button>
          </div>
          <div class="stepper"><span>Key</span>
            <button class="icon small" aria-label="Key down" onclick={() => conn?.send({ type: 'control.set', key: (pb?.key ?? 0) - 1 })}><Minus size={18} /></button>
            <b>{(pb?.key ?? 0) > 0 ? '+' : ''}{pb?.key ?? 0}</b>
            <button class="icon small" aria-label="Key up" onclick={() => conn?.send({ type: 'control.set', key: (pb?.key ?? 0) + 1 })}><Plus size={18} /></button></div>
          <div class="stepper"><span>Tempo</span>
            <button class="icon small" aria-label="Slower" onclick={() => conn?.send({ type: 'control.set', rate: (pb?.rate ?? 1) - 0.05 })}><Minus size={18} /></button>
            <b>{Math.round((pb?.rate ?? 1) * 100)}%</b>
            <button class="icon small" aria-label="Faster" onclick={() => conn?.send({ type: 'control.set', rate: (pb?.rate ?? 1) + 0.05 })}><Plus size={18} /></button></div>
          <label class="stepper"><span>Guide vocal</span><input type="range" min="0" max="1" step="0.05" value={pb?.vocal ?? 0} style="max-width:12em"
            onchange={(e) => conn?.send({ type: 'control.set', vocal: +(e.target as HTMLInputElement).value })} /></label>
          <h4>People</h4>
          <ul class="plain">
            {#each st?.members.filter((m) => m.role === 'guest' && m.id !== you?.id) ?? [] as m (m.id)}
              <li class:muted={!m.online}><User size={16} />{m.nickname}<span class="spacer"></span>
                <button class="small icon ghost danger" aria-label="Remove {m.nickname}" onclick={() => confirm(`Remove ${m.nickname}?`) && conn?.send({ type: 'kick', memberId: m.id })}><X size={16} /></button></li>
            {:else}
              <li class="muted">No guests yet.</li>
            {/each}
          </ul>
          <button onclick={() => navigate(`/screen/${code}`)}>Make this device the screen</button>
        </div>
      {/if}
    </section>

    <nav class="tabbar" aria-label="Sections"><div class="inner">
      <button class:on={tab === 'lyrics'} onclick={() => (tab = 'lyrics')} aria-current={tab === 'lyrics' ? 'page' : undefined}><MicVocal size={22} />Lyrics</button>
      <button class:on={tab === 'songs'} onclick={() => (tab = 'songs')} aria-current={tab === 'songs' ? 'page' : undefined}><Music size={22} />Songs</button>
      <button class:on={tab === 'queue'} onclick={() => (tab = 'queue')} aria-current={tab === 'queue' ? 'page' : undefined}><ListMusic size={22} />Queue
        {#if st?.queue.length}<span class="count">{st.queue.length}</span>{/if}</button>
      <button class:on={tab === 'request'} onclick={() => (tab = 'request')} aria-current={tab === 'request' ? 'page' : undefined}><Upload size={22} />Request</button>
      {#if admin}<button class:on={tab === 'host'} onclick={() => (tab = 'host')} aria-current={tab === 'host' ? 'page' : undefined}><Gamepad2 size={22} />Host</button>{/if}
    </div></nav>
    <Toast message={toast ?? conn?.error ?? null} />
  </div>
{/if}
