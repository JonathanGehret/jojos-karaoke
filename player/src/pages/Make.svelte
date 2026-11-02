<script lang="ts">
  // Make karaoke from a song file right here in the browser (no install), or help a party
  // by processing its on-the-spot requests on this device.
  import { onDestroy } from 'svelte';
  import type { Lyrics } from '$shared/lyrics';
  import LyricsView from '../components/LyricsView.svelte';
  import { AudioEngine, decode, unlockAudio } from '../lib/audio/engine';
  import { bufferOf } from '../lib/jkp';
  import { mmss } from '../lib/format';
  import { downloadBytes, exportJkp, fileName, saveSong } from '../lib/localLibrary';
  import { canEncodeOpus } from '../lib/make/encode';
  import { type MadeSong, SEPARATION_MODEL, guessFromFilename, makeSong, makerWorker, uploadSong } from '../lib/make/pipeline';
  import { BrowserJobRunner } from '../lib/make/runner';
  import { navigate } from '../lib/nav.svelte';
  import { store } from '../lib/store';

  const params = new URLSearchParams(location.search);
  const modelUrl = params.get('model') ?? undefined;        // advanced/testing override
  const token = store.ownerToken;
  const helperKey = new URLSearchParams(location.hash.slice(1)).get('key');   // from the host's "Help make songs" link

  let gpu = $state<boolean | null>(null);
  let opusOk = $state<boolean | null>(null);
  let file = $state<File | null>(null);
  let title = $state('');
  let artist = $state('');
  let lyricsText = $state('');
  let language = $state('');
  let separateOn = $state(true);
  let asrOn = $state(params.get('asr') !== 'off');
  let busy = $state(false);
  let stage = $state('');
  let pct = $state(0);
  let detail = $state('');
  let error = $state<string | null>(null);
  let result = $state<MadeSong | null>(null);
  let uploaded = $state<string | null>(null);
  let saved = $state(false);
  let alsoOnline = $state(false);
  let ctl: AbortController | null = null;
  let t0 = 0;
  let eta = $state<number | null>(null);

  // preview
  const engine = new AudioEngine();
  let engineReady = false;
  let previewLyrics = $state<Lyrics | null>(null);
  let pos = $state(0);
  let dur = $state(0);
  const posTimer = setInterval(() => { if (engineReady) pos = engine.positionMs(); }, 250);
  let playing = $state(false);

  // room helper
  let roomCode = $state(params.get('room')?.toUpperCase() ?? '');
  let runner = $state<BrowserJobRunner | null>(null);
  let runnerStatus = $state<string | null>(null);
  let runnerJob = $state<string | null>(null);

  (async () => {
    try { gpu = !!(await (navigator as any).gpu?.requestAdapter()); } catch { gpu = false; }
    opusOk = await canEncodeOpus();
  })();

  function pick(e: Event) {
    file = (e.target as HTMLInputElement).files?.[0] ?? null;
    if (file && !title) ({ title, artist } = guessFromFilename(file.name));
    result = null; uploaded = null; saved = false; error = null;
  }

  const STAGES: Record<string, string> = {
    decode: 'Reading the file', download: 'Downloading the AI model (first time only)', load: 'Loading the AI model from this device', separate: 'Removing vocals',
    lyrics: 'Finding lyrics', transcribe: 'Timing the words', encode: 'Saving audio',
  };

  async function make(e: Event) {
    e.preventDefault();
    if (!file) return;
    busy = true; error = null; result = null; uploaded = null; saved = false; pct = 0; eta = null;
    ctl = new AbortController();
    t0 = performance.now();
    try {
      result = await makeSong(file, {
        title: title.trim() || 'Untitled', artist: artist.trim(), lyricsText, language: language || undefined,
        separate: separateOn, asr: asrOn, token, modelUrl, signal: ctl.signal,
        onProgress: (s, p, d) => {
          stage = s; pct = p; detail = d ?? '';
          const el = (performance.now() - t0) / 1000;
          eta = p > 12 && s !== 'download' && s !== 'load' ? Math.round((el * (100 - p)) / p) : null;
        },
      });
      await saveSong(result.manifest, result.lyrics, result.files);
      saved = true;
      if (token && alsoOnline) uploaded = await uploadSong(token, result);
      await preview();
    } catch (err) {
      if ((err as Error).name !== 'AbortError') error = (err as Error).message;
    } finally {
      busy = false;
      ctl = null;
    }
  }

  function cancel() { ctl?.abort(); }

  async function preview() {
    if (!result) return;
    await unlockAudio();
    if (!engineReady) { await engine.init(); engineReady = true; }
    const inst = await decode(bufferOf(result.files['instrumental.opus']));
    const voc = result.files['vocals.opus'] ? await decode(bufferOf(result.files['vocals.opus'])) : null;
    engine.load(inst, voc);
    dur = engine.durationMs; pos = 0;
    engine.onEnded = () => (playing = false);
    previewLyrics = result.lyrics;
  }

  function toggle() {
    if (engine.playing) engine.pause(); else engine.play();
    playing = engine.playing;
  }

  async function download() {
    if (!result) return;
    const bytes = await exportJkp({ id: result.manifest.id, manifest: result.manifest, lyrics: result.lyrics, addedAt: 0, size: 0,
      files: Object.fromEntries(Object.entries(result.files).map(([n, d]) => [n, new Blob([d as BlobPart])])) });
    downloadBytes(bytes, fileName(result.manifest));
  }

  function help(e: Event) {
    e.preventDefault();
    const key = helperKey ?? token;
    if (!key) return;
    runner?.stop();
    runner = new BrowserJobRunner(roomCode.trim().toUpperCase(), key, {
      onStatus: (s) => (runnerStatus = s),
      onJob: (j, p, s) => (runnerJob = j ? `${j.title}: ${STAGES[s ?? ''] ?? s} ${Math.round(p ?? 0)}%` : null),
    }, { modelUrl, asr: asrOn });
    runner.start();
  }

  onDestroy(() => { clearInterval(posTimer); runner?.stop(); engine.stop(); makerWorker.terminate(); });
</script>

<main class="page make">
  <header class="bar"><button class="link" onclick={() => navigate('/')}>← Home</button><h2>Make a song</h2></header>

  <p class="hint">Everything runs here in your browser: nothing to install. The first time, the AI models
    download once (about {SEPARATION_MODEL.sizeMb} MB for vocal removal, 40–250 MB for word timing) and are kept for next time.</p>
  <p class="hint">
    {#if gpu === null}Checking this device…
    {:else if gpu}✓ Graphics card available: about 1–3 minutes per song.
    {:else}⚠ No WebGPU here: it works on the CPU but can take 10+ minutes per song. Chrome on a laptop/desktop is fastest.{/if}
    {#if opusOk === false}<br /><span class="error">This browser can't save Opus audio (needs Chrome, Edge or a recent Safari/Firefox).</span>{/if}
  </p>

  <form class="card stack" onsubmit={make}>
    <label>Song file (one you own)<input type="file" accept="audio/*,.mp3,.m4a,.flac,.wav,.ogg,.opus" onchange={pick} disabled={busy} /></label>
    <div class="row">
      <input bind:value={title} placeholder="Title" maxlength="200" required disabled={busy} style="flex:2" />
      <input bind:value={artist} placeholder="Artist" maxlength="200" disabled={busy} style="flex:1" />
    </div>
    <textarea bind:value={lyricsText} rows="5" disabled={busy}
      placeholder="Lyrics (optional, plain text or .lrc). Empty: looked up online, otherwise transcribed."></textarea>
    <div class="row">
      <label class="row">Language
        <select bind:value={language} disabled={busy} style="width:auto">
          <option value="">auto / English</option><option value="de">Deutsch</option><option value="es">Español</option>
          <option value="fr">Français</option><option value="it">Italiano</option><option value="nl">Nederlands</option>
          <option value="pt">Português</option><option value="pl">Polski</option><option value="tr">Türkçe</option>
          <option value="ja">日本語</option><option value="ko">한국어</option>
        </select></label>
      <label class="row"><input type="checkbox" bind:checked={separateOn} disabled={busy} /> Remove vocals</label>
      <label class="row"><input type="checkbox" bind:checked={asrOn} disabled={busy} /> AI word timing</label>
      {#if token}<label class="row"><input type="checkbox" bind:checked={alsoOnline} disabled={busy} /> Also add to my online library</label>{/if}
    </div>
    {#if busy}
      <div class="progress-block">
        <div class="meter"><div style:width="{pct}%"></div></div>
        <div class="row"><span>{STAGES[stage] ?? stage} {detail ? `(${detail})` : ''}</span>
          <span class="muted">{pct}%{#if eta} · ~{Math.ceil(eta / 60)} min left{/if}</span>
          <button type="button" class="link danger" onclick={cancel}>cancel</button></div>
        <p class="hint">Keep this tab open.</p>
      </div>
    {:else}
      <button class="primary" type="submit" disabled={!file || opusOk === false}>Make karaoke</button>
    {/if}
    {#if error}<p class="error">{error}</p>{/if}
  </form>

  {#if result}
    <section class="card">
      <h3>{result.manifest.title} <span class="muted">{result.manifest.artist}</span></h3>
      {#each result.warnings as w}<p class="hint warn">{w}</p>{/each}
      {#if saved}<p class="ok">✓ Saved on this device (My songs).</p>{/if}
      {#if uploaded}<p class="ok">✓ Added to your online library.</p>{/if}
      {#if previewLyrics}<LyricsView lyrics={previewLyrics} clock={() => engine.positionMs()} size="phone" />{/if}
      <div class="row seek"><span>{mmss(pos)}</span>
        <input type="range" min="0" max={dur || 1} value={pos} aria-label="Position"
          oninput={(e) => { pos = +(e.target as HTMLInputElement).value; engine.seek(pos); }} />
        <span>{mmss(dur)}</span>
        <button onclick={() => engine.seek(Math.max(0, engine.positionMs() - 10000))} aria-label="Back 10 seconds">−10s</button>
        <button onclick={() => engine.seek(engine.positionMs() + 10000)} aria-label="Forward 10 seconds">+10s</button></div>
      <div class="row">
        <button class="primary" onclick={toggle}>{playing ? '⏸' : '▶'} Preview</button>
        <label class="row">Guide vocal <input type="range" min="0" max="1" step="0.1" value="0"
          oninput={(e) => engine.setVocal(+(e.target as HTMLInputElement).value)} style="width:8em" /></label>
        <button onclick={download}>Download .jkp</button>
        <button onclick={() => navigate('/songs')}>My songs</button>
      </div>
    </section>
  {/if}

  {#if helperKey || token}
    <section class="card">
      <h3>Help at a party</h3>
      <p class="hint">Make the songs guests request, on this device. Keep this tab open while the party runs.
        The host's screen gets each finished song, and the guest who brought it can download it.</p>
      <form class="row" onsubmit={help}>
        <input bind:value={roomCode} maxlength="4" placeholder="Room code" style="width:7em; text-transform:uppercase" />
        <button type="submit">{runner ? 'Restart' : 'Start'}</button>
        {#if runner}<button type="button" onclick={() => { runner?.stop(); runner = null; runnerJob = null; }}>Stop</button>{/if}
      </form>
      {#if runnerStatus}<p class="hint">Status: {runnerStatus}</p>{/if}
      {#if runnerJob}<p>{runnerJob}</p>{/if}
    </section>
  {/if}
</main>
