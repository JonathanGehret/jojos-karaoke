<script lang="ts">
  // The host screen: plays the audio (the only device that does), shows lyrics, QR, queue.
  // It is the playback authority: guests follow the `playback` messages it publishes.
  import { onDestroy } from 'svelte';
  import {
    Cast, ListMusic, Maximize, Minus, Pause, PencilLine, Play, Plus, RotateCcw, Search, Upload, Settings2, SkipForward, Smartphone, Users, X,
  } from '@lucide/svelte';
  import { type Lyrics, shiftLyrics } from '$shared/lyrics';
  import type { QueueItem, ServerMsg } from '$shared/protocol';
  import LyricsView from '../components/LyricsView.svelte';
  import Qr from '../components/Qr.svelte';
  import QueueList from '../components/QueueList.svelte';
  import RequestForm from '../components/RequestForm.svelte';
  import Toast from '../components/Toast.svelte';
  import { type Media, fetchJson, saveLyrics, songMedia } from '../lib/api';
  import { AudioEngine, KEY_RANGE, decode, fetchAudio, unlockAudio } from '../lib/audio/engine';
  import { getSong, importJkp, listSongs, onLibraryChange, summary, updateLyrics } from '../lib/localLibrary';
  import { keepAwake, toggleFullscreen } from '../lib/device';
  import { joinUrl, mmss } from '../lib/format';
  import { navigate, takeHashParam } from '../lib/nav.svelte';
  import { RoomConnection } from '../lib/room.svelte';
  import { store } from '../lib/store';
  import { BrowserJobRunner } from '../lib/make/runner';
  import type { EarlySong, MadeSong } from '../lib/make/pipeline';

  let { code }: { code: string } = $props();

  const fromHash = takeHashParam('admin');
  if (fromHash) store.setAdminToken(code, fromHash);
  const admin = store.adminToken(code);
  store.addRecentRoom(code);

  const conn = admin ? new RoomConnection({ code, role: 'screen', admin }) : null;
  const engine = new AudioEngine();
  let engineReady = false;

  let started = $state(false);
  let loadedItem = $state<QueueItem | null>(null);
  let media = $state<Media | null>(null);
  /** where the current song came from */
  let source = $state<'device' | 'online' | null>(null);
  let coverUrl = $state<string | null>(null);
  let lyrics = $state<Lyrics | null>(null);
  let rawLyrics: Lyrics | null = null;
  let loading = $state(false);
  let countdown = $state(0);
  let playing = $state(false);
  let pos = $state(0);
  let key = $state(0);
  let rate = $state(1);
  let vocal = $state(store.vocal);
  let songOffset = $state(0);
  let offsetDirty = $state(false);
  let showQueue = $state(true);
  // the host can queue songs here too, like a guest does on their phone
  let songSearch = $state('');
  let requestOpen = $state(false);
  const pickable = $derived((conn?.library ?? []).filter((x) =>
    (x.title + ' ' + x.artist).toLowerCase().includes(songSearch.trim().toLowerCase())));
  function addSong(id: string, title: string) {
    conn?.send({ type: 'queue.add', songId: id });
    say(`Added “${title}”`);
  }
  let showControls = $state(true);
  let showAdminQr = $state(false);
  let toast = $state<string | null>(null);
  let reactions = $state<{ id: number; emoji: string; x: number; nickname: string }[]>([]);
  let loadToken = 0;
  let runner: BrowserJobRunner | null = null;
  let makingHere = $state(false);
  let makingJob = $state<string | null>(null);

  // ---- playing a request while this device is still making it (spec/protocol.md)
  interface EarlyEntry { e: EarlySong; title: string; first?: { t: number; ready: number }; playableSent: boolean;
    extendedTo: number; made?: MadeSong }
  const earlyJobs = new Map<string, EarlyEntry>(); // by queue item id; not reactive (big arrays)
  let earlyLoaded: string | null = null;            // queue item id whose early audio is loaded
  let starved = $state(false);                       // playback caught up with the making

  /** Start only when making will stay ahead: measured speed (with 20 % margin) must keep at
   *  least 15 s of ready audio in front of the singer from the start to the end. */
  function safeToStart(en: EarlyEntry): boolean {
    const { e } = en, sr = e.sampleRate, n = e.inst[0].length;
    if (!e.lyrics) return false;          // phase 1: only with synced lyrics (line timing known now)
    if (e.ready >= n) return true;
    if (!en.first) return false;
    const dt = (performance.now() - en.first.t) / 1000;
    if (dt < 8) return false;             // measure for a while first
    const r = (((e.ready - en.first.ready) / sr) / dt) * 0.8; // audio seconds made per second
    const ready = e.ready / sr, dur = n / sr, startIn = 5, margin = 15;
    if (ready + r * startIn < margin) return false;
    return (dur - ready) / Math.max(r, 1e-6) <= dur + startIn - margin;
  }

  function earlyBuffers(e: EarlySong, frames: number): [AudioBuffer, AudioBuffer] {
    const mk = (pair: [Float32Array, Float32Array]) => {
      const b = engine.ctx.createBuffer(2, Math.max(1, frames), e.sampleRate);
      b.copyToChannel(pair[0].subarray(0, frames) as Float32Array<ArrayBuffer>, 0);
      b.copyToChannel(pair[1].subarray(0, frames) as Float32Array<ArrayBuffer>, 1);
      return b;
    };
    return [mk(e.inst), mk(e.voc)];
  }

  /** More audio is ready: swap it in (every 20 s of new audio, or at the end), resume if starved. */
  function extendEarly(id: string) {
    const en = earlyJobs.get(id);
    if (!en || earlyLoaded !== id) return;
    const { e } = en, n = e.inst[0].length;
    const done = e.ready >= n;
    const wantMs = engine.positionMs() + 8000;
    if (!done && e.ready - en.extendedTo < e.sampleRate * 20 && !(starved && (e.ready * 1000) / e.sampleRate >= wantMs)) return;
    const [inst, voc] = earlyBuffers(e, e.ready);
    en.extendedTo = e.ready;
    engine.extend(inst, voc, !done);
    if (starved && (done || (e.ready * 1000) / e.sampleRate >= wantMs)) {
      starved = false;
      engine.play(engine.positionMs());
      playing = true;
      publish();
    }
  }

  function onEarly(job: { queueItemId: string; title: string }, e: EarlySong) {
    let en = earlyJobs.get(job.queueItemId);
    if (!en) { en = { e, title: job.title, playableSent: false, extendedTo: 0 }; earlyJobs.set(job.queueItemId, en); }
    en.e = e;
    if (!en.first && e.ready > 0) en.first = { t: performance.now(), ready: e.ready };
    if (!en.playableSent && safeToStart(en) && queue.some((q) => q.id === job.queueItemId)) {
      en.playableSent = true;
      conn?.send({ type: 'queue.playable', itemId: job.queueItemId });
    }
    extendEarly(job.queueItemId);
  }

  function onMade(job: { queueItemId: string }, song: MadeSong) {
    const en = earlyJobs.get(job.queueItemId);
    if (!en) return;
    if (earlyLoaded !== job.queueItemId) { earlyJobs.delete(job.queueItemId); return; } // plays the normal way later
    en.made = song;
    en.e.ready = en.e.inst[0].length;
    extendEarly(job.queueItemId);
    // the word-timed lyrics replace the line timing
    rawLyrics = song.lyrics;
    lyrics = shiftLyrics(song.lyrics, songOffset);
    sendLyrics();
  }

  function onFailed(job: { queueItemId: string; title: string }, message: string) {
    const en = earlyJobs.get(job.queueItemId);
    earlyJobs.delete(job.queueItemId);
    if (!en || earlyLoaded !== job.queueItemId) return;
    if (en.e.ready >= en.e.inst[0].length) return; // the audio is all here: let it finish
    say(`Could not finish making "${job.title}": ${message}. Skipping.`);
    skip();
  }

  engine.onStarved = () => {
    starved = true;
    playing = false;
    publish();
  };

  function toggleMakingHere() {
    if (runner) { runner.stop(); runner = null; makingHere = false; makingJob = null; store.makeHere = false; return; }
    store.makeHere = true;
    runner = new BrowserJobRunner(code, admin!, {
      onJob: (j, p) => (makingJob = j ? `${j.title} ${Math.round(p ?? 0)}%` : null),
      onEarly, onMade, onFailed,
    });
    runner.start();
    makingHere = true;
  }
  let hideTimer = 0;
  let advanceTimer = 0;

  const queue = $derived(conn?.state?.queue ?? []);
  const nowItem = $derived(conn?.state?.nowPlaying ?? null);
  const upNext = $derived(queue.find((q) => q.status === 'ready' || (q.status === 'processing' && q.playable)) ?? null);
  const guests = $derived(conn?.state?.members.filter((m) => m.online && m.role === 'guest').length ?? 0);
  const canCast = typeof window !== 'undefined' && 'PresentationRequest' in window;

  function say(msg: string) {
    toast = msg;
    setTimeout(() => { if (toast === msg) toast = null; }, 4000);
  }

  function lyricsClock() {
    return engine.positionMs() - store.deviceOffsetMs;
  }

  function publish() {
    if (!conn) return;
    conn.send({ type: 'playback', playback: {
      state: engine.playing ? 'playing' : loadedItem ? 'paused' : 'stopped',
      positionMs: Math.round(engine.positionMs()), atServerMs: Math.round(conn.serverNow()), rate: engine.rate,
      key: engine.key, vocal: engine.vocal, queueItemId: loadedItem?.id ?? null, songId: loadedItem?.songId ?? null,
    } });
  }

  async function start() {
    await unlockAudio();
    if (!engineReady) {
      await engine.init();
      engineReady = true;
      if (!engine.pitchShift) say('Key change is not supported in this browser; tempo will shift the pitch.');
    }
    engine.setVocal(vocal);
    engine.onEnded = () => { playing = false; publish(); endedId = loadedItem?.id ?? null; endedTries = 0; conn?.send({ type: 'advance' }); };
    started = true;
    keepAwake();
    if (store.makeHere && !runner && admin) toggleMakingHere(); // the host makes requests by default
    publishDeviceSongs();
    if (nowItem && nowItem.id !== loadedItem?.id) load(nowItem);
  }

  /** A request this device is still making: play the part that's ready, extend as it grows. */
  async function loadEarly(item: QueueItem, my: number) {
    const en = earlyJobs.get(item.id)!;
    const { e } = en, n = e.inst[0].length;
    earlyLoaded = item.id;
    const [inst, voc] = earlyBuffers(e, e.ready);
    en.extendedTo = e.ready;
    engine.load(inst, voc, e.ready < n);
    const lyr = en.made?.lyrics ?? e.lyrics ?? { version: 1, lines: [] };
    media = { manifest: { id: '', title: item.title, artist: item.artist, durationMs: e.durationMs,
      files: { instrumental: 'instrumental', vocals: 'vocals', lyrics: 'lyrics.json' } } as any,
      urls: { lyrics: '', vocals: 'local' } };
    source = 'device';
    rawLyrics = lyr;
    songOffset = 0;
    offsetDirty = false;
    lyrics = shiftLyrics(lyr, 0);
    sendLyrics();
    key = 0; rate = 1;
    engine.setKey(0); engine.setRate(1);
    publish();
    for (countdown = 5; countdown > 0; countdown--) {
      await new Promise((r) => setTimeout(r, 1000));
      if (my !== loadToken) return;
    }
    extendEarly(item.id);
    play();
  }

  async function load(item: QueueItem) {
    const my = ++loadToken;
    engine.stop();
    playing = false;
    loadedItem = item;
    lyrics = null;
    media = null;
    source = null;
    countdown = 0;
    starved = false;
    if (earlyLoaded && earlyLoaded !== item.id) { earlyJobs.delete(earlyLoaded); earlyLoaded = null; }
    if (!item.songId && admin && earlyJobs.has(item.id)) return loadEarly(item, my);
    if (!item.songId || !admin) return;
    loading = true;
    try {
      // songs on this device first; then a request's finished package; then the online library
      let local = await getSong(item.songId);
      if (!local && item.hasResult) local = await importResult(item.id);
      let inst: AudioBuffer, voc: AudioBuffer | null, lyr: Lyrics, offsetMs: number, m: Media;
      if (local) {
        [inst, voc] = await Promise.all([
          decode(await local.files[local.manifest.files.instrumental].arrayBuffer()),
          local.manifest.files.vocals ? decode(await local.files[local.manifest.files.vocals].arrayBuffer()) : Promise.resolve(null),
        ]);
        lyr = local.lyrics;
        offsetMs = local.manifest.offsetMs ?? 0;
        if (coverUrl) URL.revokeObjectURL(coverUrl);
        const cover = local.manifest.files.cover;
        coverUrl = cover && local.files[cover] ? URL.createObjectURL(local.files[cover]) : null;
        m = { manifest: local.manifest, urls: { lyrics: '', ...(coverUrl ? { cover: coverUrl } : {}),
          ...(local.manifest.files.vocals ? { vocals: 'local' } : {}) } };
        source = 'device';
      } else {
        m = await songMedia(code, item.songId, { admin });
        [inst, voc, lyr] = await Promise.all([
          fetchAudio(m.urls.instrumental!),
          m.urls.vocals ? fetchAudio(m.urls.vocals) : Promise.resolve(null),
          fetchJson<Lyrics>(m.urls.lyrics),
        ]);
        offsetMs = m.manifest.offsetMs ?? 0;
        source = 'online';
      }
      if (my !== loadToken) return;
      media = m;
      rawLyrics = lyr;
      songOffset = offsetMs;
      offsetDirty = false;
      lyrics = shiftLyrics(lyr, songOffset);
      sendLyrics();
      engine.load(inst, voc);
      key = 0; rate = 1;
      engine.setKey(0); engine.setRate(1);
      publish();
      // "Up next" interstitial, then go
      for (countdown = 5; countdown > 0; countdown--) {
        await new Promise((r) => setTimeout(r, 1000));
        if (my !== loadToken) return;
      }
      play();
    } catch (e) {
      say(`Could not load "${item.title}": ${(e as Error).message}. Skipping.`);
      setTimeout(() => my === loadToken && conn?.send({ type: 'advance' }), 3000);
    } finally {
      if (my === loadToken) loading = false;
    }
  }

  function play() { if (loadedItem && media) { countdown = 0; engine.play(); playing = true; publish(); } }
  function pause() { engine.pause(); playing = false; publish(); }
  function toggle() { playing ? pause() : play(); }
  function skip() { engine.stop(); playing = false; conn?.send({ type: 'advance' }); }
  function restart() { engine.seek(0); if (!playing) play(); publish(); }
  function seekBy(ms: number) { engine.seek(Math.max(0, engine.positionMs() + ms)); publish(); }
  function setKey(k: number) { key = Math.max(-KEY_RANGE, Math.min(KEY_RANGE, k)); engine.setKey(key); publish(); }
  function setRate(r: number) { rate = Math.round(Math.max(0.8, Math.min(1.2, r)) * 100) / 100; engine.setRate(rate); publish(); }
  function setVocal(v: number) { vocal = v; store.vocal = v; engine.setVocal(v); publish(); }
  let lyricsTimer = 0;
  /** Guests get the lyrics from the screen, already shifted by the song's offset. */
  function sendLyrics() {
    clearTimeout(lyricsTimer);
    lyricsTimer = window.setTimeout(() => {
      if (lyrics && loadedItem) conn?.send({ type: 'lyrics', queueItemId: loadedItem.id, lyrics });
    }, 150);
  }

  async function publishDeviceSongs() {
    if (!started) return;
    conn?.send({ type: 'screen.library', songs: (await listSongs()).map(summary) });
  }
  const offLib = onLibraryChange(publishDeviceSongs);
  $effect(() => { if (conn?.status === 'open' && started) publishDeviceSongs(); });

  const importing = new Set<string>();
  async function importResult(itemId: string) {
    const r = await fetch(`/api/rooms/${code}/results/${itemId}?admin=${encodeURIComponent(admin!)}`);
    if (!r.ok) throw new Error(`could not fetch the finished request (${r.status})`);
    return importJkp(new Uint8Array(await r.arrayBuffer()));
  }
  // finished requests are copied into this device's songs as soon as they are ready
  $effect(() => {
    for (const q of queue) {
      if (!q.hasResult || !q.songId || importing.has(q.id)) continue;
      importing.add(q.id);
      getSong(q.songId).then((have) => have ?? importResult(q.id)).catch((e) => say((e as Error).message));
    }
  });

  function nudgeOffset(ms: number) {
    if (!rawLyrics) return;
    songOffset += ms;
    offsetDirty = true;
    lyrics = shiftLyrics(rawLyrics, songOffset);
    sendLyrics();
  }
  async function saveOffset() {
    if (!rawLyrics || !loadedItem?.songId || !admin) return;
    try {
      if (source === 'device') {
        await updateLyrics(loadedItem.songId, rawLyrics, songOffset);
        offsetDirty = false;
        say('Lyrics offset saved for this song.');
        return;
      }
      await saveLyrics(code, loadedItem.songId, admin, rawLyrics, songOffset);
      offsetDirty = false;
      say('Lyrics offset saved for this song.');
    } catch (e) { say((e as Error).message); }
  }

  // new song chosen by the server → load it
  $effect(() => {
    const it = nowItem;
    if (!started) return;
    if (it && it.id !== loadedItem?.id) load(it);
    else if (it && it.id === loadedItem?.id && it.status !== loadedItem.status) loadedItem = it;
    if (!it && loadedItem) { loadToken++; engine.stop(); playing = false; loadedItem = null; media = null; lyrics = null; }
  });

  // a song ended but the room still has it as playing (the "advance" got lost, e.g. the
  // connection was down at that moment): ask again, a few times
  let endedId: string | null = null;
  let endedTries = 0;
  const advanceRetry = setInterval(() => {
    if (!endedId || nowItem?.id !== endedId || playing) { endedId = nowItem?.id === endedId ? endedId : null; return; }
    if (endedTries++ < 3) conn?.send({ type: 'advance' });
  }, 5000);

  // idle with songs waiting → start the next one
  $effect(() => {
    clearTimeout(advanceTimer);
    if (started && !nowItem && upNext) advanceTimer = window.setTimeout(() => conn?.send({ type: 'advance' }), 2500);
  });

  const off = conn?.on((m: ServerMsg) => {
    if (m.type === 'control') {
      if (m.action === 'play') play();
      else if (m.action === 'pause') pause();
      else if (m.action === 'skip') skip();
      else if (m.action === 'restart') restart();
      else if (m.action === 'seek' && m.positionMs != null) { engine.seek(m.positionMs); publish(); }
    } else if (m.type === 'control.set') {
      if (m.key != null) setKey(m.key);
      if (m.rate != null) setRate(m.rate);
      if (m.vocal != null) setVocal(m.vocal);
    } else if (m.type === 'react') {
      const id = Math.random();
      reactions = [...reactions.slice(-30), { id, emoji: m.emoji, x: 10 + Math.random() * 80, nickname: m.nickname }];
      setTimeout(() => (reactions = reactions.filter((r) => r.id !== id)), 3500);
    }
  });

  // engine fields aren't reactive: copy them on a timer
  let dur = $state(0);
  const posTimer = setInterval(() => { pos = engine.positionMs(); dur = engine.durationMs; }, 250);
  // guests follow the clock between updates; changes (play, seek, …) are published right away
  const pubTimer = setInterval(() => { if (playing) publish(); }, 10000);

  function wake() {
    showControls = true;
    clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => { if (playing) showControls = false; }, 4000);
  }

  function onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    wake();
    const k = e.key;
    if (k === ' ') { e.preventDefault(); toggle(); }
    else if (k === 'n' || k === 'N') skip();
    else if (k === 'ArrowLeft') seekBy(-5000);
    else if (k === 'ArrowRight') seekBy(5000);
    else if (k === '+' || k === '=') setKey(key + 1);
    else if (k === '-') setKey(key - 1);
    else if (k === ']') setRate(rate + 0.05);
    else if (k === '[') setRate(rate - 0.05);
    else if (k === 'v' || k === 'V') setVocal(vocal > 0 ? 0 : 0.6);
    else if (k === 'f' || k === 'F') toggleFullscreen();
    else if (k === 'q' || k === 'Q') showQueue = !showQueue;
    else if (k === ',') nudgeOffset(-50);
    else if (k === '.') nudgeOffset(50);
  }

  async function cast() {
    try {
      const req = new PresentationRequest([`/screen/${code}#admin=${encodeURIComponent(admin!)}`]);
      await req.start();
      engine.stop();
      navigate(`/join/${code}#admin=${encodeURIComponent(admin!)}`);
    } catch (e) {
      if ((e as DOMException).name !== 'AbortError' && (e as DOMException).name !== 'NotAllowedError') say((e as Error).message);
    }
  }

  onDestroy(() => { clearInterval(advanceRetry);
    off?.();
    offLib();
    if (coverUrl) URL.revokeObjectURL(coverUrl);
    runner?.stop();
    conn?.close();
    engine.stop();
    clearInterval(posTimer);
    clearInterval(pubTimer);
    clearTimeout(advanceTimer);
  });
</script>

<svelte:window onkeydown={onKey} onpointermove={wake} />

{#if !admin}
  <main class="page"><div class="empty-state"><p class="error">This device is not the host of room {code}.</p>
    <button onclick={() => navigate(`/join/${code}`)}>Join as a guest</button></div></main>
{:else}
  <div class="screen" class:queue-open={showQueue}>
    <div class="stage" style:--cover={media?.urls.cover ? `url("${media.urls.cover}")` : 'none'}>
      <header class="top">
        <div class="room">
          {#if loadedItem || !started}<Qr text={joinUrl(code)} size={120} />{/if}
          <div><div class="code">{code}</div><div class="muted">{location.host}/join</div>
            <div class="muted row" style="gap:.3rem"><Users size={14} />{guests} {guests === 1 ? 'guest' : 'guests'}{#if conn?.state?.workersOnline} · {conn.state.workersOnline} maker online{/if}</div></div>
        </div>
        {#if loadedItem}
          <div class="now"><div class="title">{loadedItem.title}</div>
            <div class="muted">{loadedItem.artist}{loadedItem.artist ? ' · ' : ''}sung by <b>{loadedItem.nickname}</b></div></div>
        {/if}
        <div class="status">
          {#if conn?.status !== 'open'}<span class="badge fail">{conn?.status === 'gone' ? 'room closed' : 'reconnecting…'}</span>{/if}
        </div>
      </header>

      {#if !started}
        <div class="center-card">
          <h2>Room {code}</h2>
          <p class="muted">Guests scan the code to join. Start the party when you're ready.</p>
          <button class="primary big" onclick={start}><Play size={22} />Start the party</button>
          <div class="keys" aria-label="Keyboard shortcuts">
            <span><kbd>Space</kbd>play/pause</span><span><kbd>N</kbd>skip</span><span><kbd>←</kbd><kbd>→</kbd>seek</span>
            <span><kbd>+</kbd><kbd>−</kbd>key</span><span><kbd>[</kbd><kbd>]</kbd>tempo</span><span><kbd>V</kbd>guide vocal</span>
            <span><kbd>F</kbd>fullscreen</span><span><kbd>Q</kbd>queue</span><span><kbd>,</kbd><kbd>.</kbd>lyrics offset</span>
          </div>
        </div>
      {:else if countdown > 0 && loadedItem}
        <div class="center-card upnext">
          <div class="label">Up next</div>
          <h2>{loadedItem.nickname}</h2>
          <p class="title">{loadedItem.title}{#if loadedItem.artist}<span class="muted">{` · ${loadedItem.artist}`}</span>{/if}</p>
          <div class="count" aria-live="polite">{countdown}</div>
          <button onclick={play}><Play size={18} />Start now</button>
        </div>
      {:else if loading}
        <div class="center-card"><p>Loading “{loadedItem?.title}”…</p></div>
      {:else if !loadedItem}
        <div class="center-card">
          <h2>{upNext ? 'Starting…' : 'Pick a song!'}</h2>
          <p>Scan the code with your phone, or open <b>{location.host}/join</b> and enter <b class="code">{code}</b>.</p>
          <Qr text={joinUrl(code)} size={240} />
          {#if !conn?.library.length}<p class="hint">No songs yet: add some in <b>My songs</b> on this device, or guests can bring
            their own in the Request tab.</p>{/if}
        </div>
      {:else if lyrics && !lyrics.lines.length}
        <div class="center-card"><p>This song has no lyrics yet.</p></div>
      {/if}

      {#if started && loadedItem && lyrics && countdown === 0}
        <LyricsView {lyrics} clock={lyricsClock} />
      {/if}
      {#if starved}
        <div class="center-card starved" role="status"><p>Still making the rest of “{loadedItem?.title}”… it continues in a moment.</p></div>
      {/if}

      <div class="reactions" aria-hidden="true">
        {#each reactions as r (r.id)}<span style:left="{r.x}%">{r.emoji}</span>{/each}
      </div>

      {#if started}
        <footer class="controls" class:hidden={!showControls && !!loadedItem}>
          {#if loadedItem}
            <div class="progress"><span>{mmss(pos)}</span>
              <input type="range" min="0" max={dur || 1} value={pos} aria-label="Position"
                     oninput={(e) => engine.seek(+(e.target as HTMLInputElement).value)} onchange={publish} />
              <span>{mmss(dur)}</span></div>
          {/if}
          <div class="row">
            {#if loadedItem}
              <button class="icon" onclick={restart} title="Restart" aria-label="Restart"><RotateCcw size={20} /></button>
              <button class="primary play" onclick={toggle} disabled={!media} aria-label={playing ? 'Pause' : 'Play'}>
                {#if playing}<Pause size={26} />{:else}<Play size={26} />{/if}</button>
              <button class="icon" onclick={skip} title="Skip (N)" aria-label="Skip"><SkipForward size={20} /></button>
              <span class="group">Key <button onclick={() => setKey(key - 1)} aria-label="Key down"><Minus size={16} /></button><b>{key > 0 ? '+' : ''}{key}</b><button onclick={() => setKey(key + 1)} aria-label="Key up"><Plus size={16} /></button></span>
              <span class="group">Tempo <button onclick={() => setRate(rate - 0.05)} aria-label="Slower"><Minus size={16} /></button><b>{Math.round(rate * 100)}%</b><button onclick={() => setRate(rate + 0.05)} aria-label="Faster"><Plus size={16} /></button></span>
              <label class="group">Guide vocal <input type="range" min="0" max="1" step="0.05" value={vocal}
                     oninput={(e) => setVocal(+(e.target as HTMLInputElement).value)} disabled={!media?.urls.vocals} /></label>
              <span class="group">Lyrics <button onclick={() => nudgeOffset(-50)} aria-label="Lyrics earlier"><Minus size={16} /></button><b>{songOffset} ms</b><button onclick={() => nudgeOffset(50)} aria-label="Lyrics later"><Plus size={16} /></button>
                {#if offsetDirty}<button class="small" onclick={saveOffset}>save</button>{/if}</span>
            {/if}
            <span class="spacer"></span>
            {#if loadedItem?.songId && source === 'online'}<button onclick={() => navigate(`/edit/${code}/${loadedItem!.songId}`)}><PencilLine size={18} />Edit timing</button>{/if}
            <button onclick={() => (showQueue = !showQueue)} aria-pressed={showQueue}><ListMusic size={18} />Queue ({queue.length})</button>
            <button class="icon" onclick={toggleFullscreen} title="Fullscreen (F)" aria-label="Fullscreen"><Maximize size={18} /></button>
            {#if canCast}<button class="icon" onclick={cast} title="Show on a TV / Chromecast" aria-label="Cast to a TV"><Cast size={18} /></button>{/if}
            <button class="icon" onclick={() => (showAdminQr = !showAdminQr)} title="Control from your phone" aria-label="Control from your phone"><Smartphone size={18} /></button>
          </div>
        </footer>
      {/if}

      {#if showAdminQr}
        <div class="center-card admin-qr">
          <h3>Host controls on your phone</h3>
          <p class="hint">Only scan this yourself: it gives full control of the room.</p>
          <Qr text={`${location.origin}/join/${code}#admin=${encodeURIComponent(admin)}`} size={220} />
          <button onclick={() => (showAdminQr = false)} style="margin-top:1rem">Close</button>
        </div>
      {/if}
    </div>

    {#if showQueue}
      <aside class="side">
        <h3><ListMusic size={20} />Queue <span class="spacer"></span>
          <button class="icon small ghost" aria-label="Hide the queue" onclick={() => (showQueue = false)}><X size={18} /></button></h3>
        <QueueList items={queue} admin
          onmove={(id, to) => conn?.send({ type: 'queue.move', itemId: id, to })}
          onremove={(id) => conn?.send({ type: 'queue.remove', itemId: id })}
          onplaynext={(id) => conn?.send({ type: 'queue.playNext', itemId: id })} />
        {#if conn?.library.length}
          <details class="box add-songs" open={!queue.length}>
            <summary><Plus size={16} />Add a song</summary>
            {#if conn.library.length > 6}
              <div class="search-box search"><Search size={18} />
                <input type="search" bind:value={songSearch} placeholder="Search {conn.library.length} songs" aria-label="Search songs" /></div>
            {/if}
            <ul class="songs">
              {#each pickable as x (x.id)}
                <li><button class="song" onclick={() => addSong(x.id, x.title)} aria-label="Add {x.title} to the queue">
                  <span class="what"><b>{x.title}</b><span class="muted">{x.artist}{x.artist ? ' · ' : ''}{mmss(x.durationMs)}</span></span>
                  <span class="plus"><Plus size={18} /></span></button></li>
              {:else}
                <li class="hint">No match for “{songSearch}”.</li>
              {/each}
            </ul>
          </details>
        {/if}
        {#if started}
          <details class="box add-songs" bind:open={requestOpen}>
            <summary><Upload size={16} />Request a new song</summary>
            <RequestForm {code} {conn} compact workersOnline={!!conn?.state?.workersOnline} onerror={say}
              onsent={() => { say('Request sent: it is being made and shows in the queue.'); requestOpen = false; }} />
          </details>
        {/if}
        {#if queue.some((q) => q.status === 'processing') && !conn?.state?.workersOnline}
          <p class="hint warn">Requests are waiting to be made: turn on “Make requests on this device”, open
            <b>Make a song → Help at a party</b> on another laptop, or run <code>jojo worker --room {code}</code>.</p>
        {/if}
        <div class="box">
          <label class="row"><input type="checkbox" checked={makingHere} onchange={toggleMakingHere} /> Make requests on this device</label>
          {#if makingJob}<p class="hint">Making {makingJob}</p>{/if}
          {#if store.workerKey(code)}
            <details>
              <summary>Let another computer make requests</summary>
              <p class="hint">On a laptop: open this link (Chrome), or with the CLI:</p>
              <code class="cmd">{location.origin}/make?room={code}#key={store.workerKey(code)}</code>
              <code class="cmd">jojo worker --server {location.origin} --room {code} --key {store.workerKey(code)}</code>
            </details>
          {/if}
        </div>
        <details class="box">
          <summary><Settings2 size={16} />Room settings</summary>
          <label class="row"><input type="checkbox" checked={conn?.state?.settings.fair}
            onchange={(e) => conn?.send({ type: 'settings', settings: { fair: (e.target as HTMLInputElement).checked } })} /> Fair rotation</label>
          <label class="row" style="margin-top:.5rem">Max songs per person <input type="number" min="0" max="50" style="width:4.5em"
            value={conn?.state?.settings.maxPerPerson}
            onchange={(e) => conn?.send({ type: 'settings', settings: { maxPerPerson: +(e.target as HTMLInputElement).value } })} /></label>
          <h4>People</h4>
          <ul class="plain">
            {#each conn?.state?.members.filter((m) => m.role === 'guest') ?? [] as m (m.id)}
              <li class:muted={!m.online}>{m.nickname}<span class="spacer"></span>
                <button class="small icon ghost danger" aria-label="Remove {m.nickname}" onclick={() => confirm(`Remove ${m.nickname}?`) && conn?.send({ type: 'kick', memberId: m.id })}><X size={16} /></button></li>
            {:else}
              <li class="muted">No guests yet.</li>
            {/each}
          </ul>
        </details>
      </aside>
    {/if}
    <Toast message={toast ?? conn?.error ?? null} />
  </div>
{/if}
