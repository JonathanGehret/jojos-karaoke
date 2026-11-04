<script lang="ts">
  import { FileMusic, Maximize, Minus, Pause, PencilLine, Play, Plus, RotateCcw } from '@lucide/svelte';
  import TopBar from '../components/TopBar.svelte';
  // Play a local .jkp package on this device, with all the audio controls.
  import { onDestroy } from 'svelte';
  import { type Lyrics, shiftLyrics } from '$shared/lyrics';
  import LyricsView from '../components/LyricsView.svelte';
  import { AudioEngine, decode, unlockAudio } from '../lib/audio/engine';
  import { keepAwake, toggleFullscreen } from '../lib/device';
  import { mmss } from '../lib/format';
  import { type LocalPackage, bufferOf, readPackage } from '../lib/jkp';
  import { navigate } from '../lib/nav.svelte';
  import { session } from '../lib/session';
  import { store } from '../lib/store';

  const engine = new AudioEngine();
  let ready = false;
  let pkg = $state<LocalPackage | null>(session.localPackage);
  let lyrics = $state<Lyrics | null>(null);
  let error = $state<string | null>(null);
  let playing = $state(false);
  let pos = $state(0);
  let key = $state(0);
  let rate = $state(1);
  let vocal = $state(store.vocal);
  let volume = $state(store.volume);
  let offset = $state(0);

  async function open(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    error = null;
    try {
      pkg = readPackage(new Uint8Array(await f.arrayBuffer()));
      session.localSongId = null;
      await prepare();
    } catch (err) { error = (err as Error).message; }
  }

  async function prepare() {
    if (!pkg) return;
    await unlockAudio();
    if (!ready) { await engine.init(); ready = true; }
    const inst = await decode(bufferOf(pkg.files[pkg.manifest.files.instrumental]));
    const v = pkg.manifest.files.vocals ? await decode(bufferOf(pkg.files[pkg.manifest.files.vocals])) : null;
    engine.load(inst, v);
    engine.setVocal(vocal);
    engine.setVolume(volume);
    engine.onEnded = () => (playing = false);
    offset = pkg.manifest.offsetMs ?? 0;
    lyrics = shiftLyrics(pkg.lyrics, offset);
    session.localPackage = pkg;
    keepAwake();
  }

  function toggle() {
    if (!pkg) return;
    if (engine.playing) engine.pause(); else engine.play();
    playing = engine.playing;
  }

  let dur = $state(0);
  const t = setInterval(() => { pos = engine.positionMs(); dur = engine.durationMs; }, 250);
  onDestroy(() => { clearInterval(t); engine.stop(); });

  function edit() {
    if (!pkg) return;
    pkg.manifest.offsetMs = offset;
    if (!session.localPackage || session.localPackage !== pkg) session.localSongId = null;
    session.localPackage = pkg;
    engine.stop();
    navigate('/edit');
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === ' ') { e.preventDefault(); toggle(); }
  }
</script>

<svelte:window onkeydown={onKey} />

<main class="solo">
  <TopBar title={pkg ? pkg.manifest.title : 'Play a file'}>{#if pkg}<span class="muted">{pkg.manifest.artist}</span>{/if}</TopBar>

  {#if !lyrics}
    <div class="card stack" style="max-width:640px; width:100%; margin:1rem auto">
      {#if pkg}<button class="primary big" onclick={prepare}><Play size={22} />Load “{pkg.manifest.title}”</button>{/if}
      <label class="dropzone"><FileMusic size={28} />
        <span class="what"><b>Open a karaoke package</b><span class="hint">A .jkp file from My songs or <code>jojo make</code></span></span>
        <input type="file" accept=".jkp,application/zip" onchange={open} /></label>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </div>
  {:else}
    <LyricsView {lyrics} clock={() => engine.positionMs() - store.deviceOffsetMs} />
    <footer class="controls">
      <div class="progress"><span>{mmss(pos)}</span>
        <input type="range" min="0" max={dur || 1} value={pos} aria-label="Position" oninput={(e) => engine.seek(+(e.target as HTMLInputElement).value)} />
        <span>{mmss(dur)}</span></div>
      <div class="row">
        <button class="icon" onclick={() => engine.seek(0)} aria-label="Restart"><RotateCcw size={20} /></button>
        <button class="primary play" onclick={toggle} aria-label={playing ? 'Pause' : 'Play'}>{#if playing}<Pause size={26} />{:else}<Play size={26} />{/if}</button>
        <span class="group">Key <button onclick={() => engine.setKey(--key)} aria-label="Key down"><Minus size={16} /></button><b>{key > 0 ? '+' : ''}{key}</b><button onclick={() => engine.setKey(++key)} aria-label="Key up"><Plus size={16} /></button></span>
        <span class="group">Tempo <button onclick={() => { rate = Math.max(0.8, rate - 0.05); engine.setRate(rate); }} aria-label="Slower"><Minus size={16} /></button><b>{Math.round(rate * 100)}%</b><button onclick={() => { rate = Math.min(1.2, rate + 0.05); engine.setRate(rate); }} aria-label="Faster"><Plus size={16} /></button></span>
        <label class="group">Volume <input type="range" min="0" max="1" step="0.05" bind:value={volume}
          oninput={() => { engine.setVolume(volume); store.volume = volume; }} aria-label="Volume" /></label>
        <label class="group">Guide vocal <input type="range" min="0" max="1" step="0.05" bind:value={vocal}
          oninput={() => { engine.setVocal(vocal); store.vocal = vocal; }} disabled={!pkg?.manifest.files.vocals} /></label>
        <span class="group">Lyrics <button onclick={() => { offset -= 50; lyrics = shiftLyrics(pkg!.lyrics, offset); }} aria-label="Lyrics earlier"><Minus size={16} /></button><b>{offset} ms</b><button onclick={() => { offset += 50; lyrics = shiftLyrics(pkg!.lyrics, offset); }} aria-label="Lyrics later"><Plus size={16} /></button></span>
        <span class="spacer"></span>
        <button onclick={edit}><PencilLine size={18} />Edit timing</button>
        <button class="icon" onclick={toggleFullscreen} aria-label="Fullscreen"><Maximize size={18} /></button>
      </div>
    </footer>
  {/if}
</main>
