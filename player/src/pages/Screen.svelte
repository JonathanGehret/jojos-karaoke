<script lang="ts">
  // The host screen: plays the audio (the only device that does), shows lyrics, QR, queue.
  // It is the playback authority: guests follow the `playback` messages it publishes.
  import { onDestroy } from 'svelte';
  import { type Lyrics, shiftLyrics } from '$shared/lyrics';
  import type { QueueItem, ServerMsg } from '$shared/protocol';
  import LyricsView from '../components/LyricsView.svelte';
  import Qr from '../components/Qr.svelte';
  import QueueList from '../components/QueueList.svelte';
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
  let showControls = $state(true);
  let showAdminQr = $state(false);
  let toast = $state<string | null>(null);
  let reactions = $state<{ id: number; emoji: string; x: number; nickname: string }[]>([]);
  let loadToken = 0;
  let runner: BrowserJobRunner | null = null;
  let makingHere = $state(false);
  let makingJob = $state<string | null>(null);

  function toggleMakingHere() {
    if (runner) { runner.stop(); runner = null; makingHere = false; makingJob = null; return; }
    runner = new BrowserJobRunner(code, admin!, {
      onJob: (j, p) => (makingJob = j ? `${j.title} ${Math.round(p ?? 0)}%` : null),
    });
    runner.start();
    makingHere = true;
  }
  let hideTimer = 0;
  let advanceTimer = 0;

  const queue = $derived(conn?.state?.queue ?? []);
  const nowItem = $derived(conn?.state?.nowPlaying ?? null);
  const upNext = $derived(queue.find((q) => q.status === 'ready') ?? null);
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
    engine.onEnded = () => { playing = false; publish(); conn?.send({ type: 'advance' }); };
    started = true;
    keepAwake();
    publishDeviceSongs();
    if (nowItem && nowItem.id !== loadedItem?.id) load(nowItem);
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
    if (!it && loadedItem) { loadToken++; engine.stop(); playing = false; loadedItem = null; media = null; lyrics = null; }
  });

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

  const posTimer = setInterval(() => { pos = engine.positionMs(); }, 250);
  const pubTimer = setInterval(() => { if (playing) publish(); }, 5000);

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

  onDestroy(() => {
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
  <main class="page"><p class="error">This device is not the host of room {code}.</p>
    <button onclick={() => navigate(`/join/${code}`)}>Join as a guest</button></main>
{:else}
  <div class="screen" class:queue-open={showQueue}>
    <div class="stage" style:--cover={media?.urls.cover ? `url("${media.urls.cover}")` : 'none'}>
      <header class="top">
        <div class="room">
          <Qr text={joinUrl(code)} size={120} />
          <div><div class="code">{code}</div><div class="muted">{location.host}/join</div>
            <div class="muted">{guests} {guests === 1 ? 'guest' : 'guests'}{#if conn?.state?.workersOnline} · {conn.state.workersOnline} maker online{/if}</div></div>
        </div>
        {#if loadedItem}
          <div class="now"><div class="title">{loadedItem.title}</div>
            <div class="muted">{loadedItem.artist} · sung by <b>{loadedItem.nickname}</b></div></div>
        {/if}
        <div class="status">
          {#if conn?.status !== 'open'}<span class="badge fail">{conn?.status === 'gone' ? 'room closed' : 'reconnecting…'}</span>{/if}
        </div>
      </header>

      {#if !started}
        <div class="center-card">
          <h2>Room {code}</h2>
          <p>Scan the code to join. Start the party when you're ready.</p>
          <button class="primary big" onclick={start}>▶ Start the party</button>
          <p class="hint">Space play/pause · N skip · ←/→ seek · +/− key · [ ] tempo · V guide vocal · F fullscreen · Q queue · , . lyrics offset</p>
        </div>
      {:else if countdown > 0 && loadedItem}
        <div class="center-card upnext">
          <div class="muted">Up next</div>
          <h2>{loadedItem.nickname}</h2>
          <p class="title">{loadedItem.title} <span class="muted">· {loadedItem.artist}</span></p>
          <div class="count">{countdown}</div>
          <button onclick={play}>Start now</button>
        </div>
      {:else if loading}
        <div class="center-card"><p>Loading “{loadedItem?.title}”…</p></div>
      {:else if !loadedItem}
        <div class="center-card">
          <h2>{upNext ? 'Starting…' : 'Pick a song!'}</h2>
          {#if !conn?.library.length}<p class="hint">No songs yet: add some in <b>My songs</b> on this device, or guests can bring their own in the Request tab.</p>{/if}
          <p>Scan the QR code or open <b>{location.host}/join</b> and enter <b>{code}</b>.</p>
          <Qr text={joinUrl(code)} size={260} />
        </div>
      {:else if lyrics && !lyrics.lines.length}
        <div class="center-card"><p>This song has no lyrics yet.</p></div>
      {/if}

      {#if started && loadedItem && lyrics && countdown === 0}
        <LyricsView {lyrics} clock={lyricsClock} />
      {/if}

      <div class="reactions" aria-hidden="true">
        {#each reactions as r (r.id)}<span style:left="{r.x}%">{r.emoji}</span>{/each}
      </div>

      {#if started && showControls}
        <footer class="controls">
          <div class="progress"><span>{mmss(pos)}</span>
            <input type="range" min="0" max={engine.durationMs || 1} value={pos}
                   oninput={(e) => engine.seek(+(e.target as HTMLInputElement).value)} onchange={publish} />
            <span>{mmss(engine.durationMs)}</span></div>
          <div class="row">
            <button onclick={restart} title="Restart">⏮</button>
            <button class="primary" onclick={toggle} disabled={!media}>{playing ? '⏸' : '▶'}</button>
            <button onclick={skip} title="Skip">⏭</button>
            <span class="group">Key <button onclick={() => setKey(key - 1)}>−</button><b>{key > 0 ? '+' : ''}{key}</b><button onclick={() => setKey(key + 1)}>+</button></span>
            <span class="group">Tempo <button onclick={() => setRate(rate - 0.05)}>−</button><b>{Math.round(rate * 100)}%</b><button onclick={() => setRate(rate + 0.05)}>+</button></span>
            <label class="group">Guide vocal <input type="range" min="0" max="1" step="0.05" value={vocal}
                   oninput={(e) => setVocal(+(e.target as HTMLInputElement).value)} disabled={!media?.urls.vocals} /></label>
            <span class="group">Lyrics <button onclick={() => nudgeOffset(-50)}>−</button><b>{songOffset} ms</b><button onclick={() => nudgeOffset(50)}>+</button>
              {#if offsetDirty}<button class="small" onclick={saveOffset}>save</button>{/if}</span>
            <button onclick={() => (showQueue = !showQueue)}>Queue ({queue.length})</button>
            <button onclick={toggleFullscreen}>⛶</button>
            {#if canCast}<button onclick={cast} title="Show on a TV / Chromecast">Cast</button>{/if}
            <button onclick={() => (showAdminQr = !showAdminQr)} title="Control from your phone">📱</button>
            {#if loadedItem?.songId && source === 'online'}<button onclick={() => navigate(`/edit/${code}/${loadedItem!.songId}`)}>Edit timing</button>{/if}
          </div>
        </footer>
      {/if}

      {#if showAdminQr}
        <div class="center-card admin-qr">
          <h3>Host controls on your phone</h3>
          <p class="hint">Only scan this yourself: it gives full control of the room.</p>
          <Qr text={`${location.origin}/join/${code}#admin=${encodeURIComponent(admin)}`} size={220} />
          <button onclick={() => (showAdminQr = false)}>Close</button>
        </div>
      {/if}
    </div>

    {#if showQueue}
      <aside class="side">
        <h3>Queue</h3>
        <QueueList items={queue} admin
          onmove={(id, to) => conn?.send({ type: 'queue.move', itemId: id, to })}
          onremove={(id) => conn?.send({ type: 'queue.remove', itemId: id })}
          onplaynext={(id) => conn?.send({ type: 'queue.playNext', itemId: id })} />
        {#if queue.some((q) => q.status === 'processing') && !conn?.state?.workersOnline}
          <p class="hint warn">Requests are waiting to be made: turn on “Make requests here”, open
            <b>Make a song → Help at a party</b> on another laptop, or run <code>jojo worker --room {code}</code>.</p>
        {/if}
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
        <details>
          <summary>Room settings</summary>
          <label class="row"><input type="checkbox" checked={conn?.state?.settings.fair}
            onchange={(e) => conn?.send({ type: 'settings', settings: { fair: (e.target as HTMLInputElement).checked } })} /> Fair rotation</label>
          <label class="row">Max songs per person <input type="number" min="0" max="50" style="width:4em"
            value={conn?.state?.settings.maxPerPerson}
            onchange={(e) => conn?.send({ type: 'settings', settings: { maxPerPerson: +(e.target as HTMLInputElement).value } })} /></label>
          <h4>People</h4>
          <ul class="plain">
            {#each conn?.state?.members.filter((m) => m.role === 'guest') ?? [] as m (m.id)}
              <li class:muted={!m.online}>{m.nickname} <button class="link danger" onclick={() => confirm(`Remove ${m.nickname}?`) && conn?.send({ type: 'kick', memberId: m.id })}>remove</button></li>
            {/each}
          </ul>
        </details>
      </aside>
    {/if}
    <Toast message={toast ?? conn?.error ?? null} />
  </div>
{/if}
