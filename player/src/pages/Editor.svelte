<script lang="ts">
  // Timing editor. Room mode (host): loads from the library and saves back.
  // Local mode: edits the package opened in Solo and downloads a new .jkp.
  import { onDestroy } from 'svelte';
  import type { Lyrics } from '$shared/lyrics';
  import { type Manifest, fetchJson, saveLyrics, songMedia } from '../lib/api';
  import { AudioEngine, decode, fetchAudio, unlockAudio } from '../lib/audio/engine';
  import { mmss } from '../lib/format';
  import { bufferOf, writePackage } from '../lib/jkp';
  import { downloadBytes, fileName, updateLyrics } from '../lib/localLibrary';
  import * as E from '../lib/lyrics/edit';
  import { navigate } from '../lib/nav.svelte';
  import { session } from '../lib/session';
  import { store } from '../lib/store';

  let { code = null, songId = null }: { code?: string | null; songId?: string | null } = $props();

  const admin = code ? store.adminToken(code) : null;
  const engine = new AudioEngine();
  let manifest = $state<Manifest | null>(null);
  let lyrics = $state<Lyrics | null>(null);
  let undo: Lyrics[] = [];
  let redo: Lyrics[] = [];
  let sel = $state<[number, number]>([0, 0]);
  let tapMode = $state(false);
  let playing = $state(false);
  let pos = $state(0);
  let speed = $state(1);
  let offset = $state(0);
  let dirty = $state(false);
  let status = $state<string | null>('Loading…');
  let peaks: Float32Array | null = null;
  let canvas = $state<HTMLCanvasElement | null>(null);
  let raf = 0;
  const VIEW_MS = 8000;

  async function load() {
    try {
      await unlockAudio();
      await engine.init();
      if (code && songId) {
        if (!admin) throw new Error('Only the host can edit songs.');
        const m = await songMedia(code, songId, { admin });
        manifest = m.manifest;
        const [inst, voc, l] = await Promise.all([fetchAudio(m.urls.instrumental!),
          m.urls.vocals ? fetchAudio(m.urls.vocals) : Promise.resolve(null), fetchJson<Lyrics>(m.urls.lyrics)]);
        engine.load(inst, voc);
        lyrics = l;
        peaks = computePeaks(voc ?? inst);
      } else {
        const pkg = session.localPackage;
        if (!pkg) throw new Error('Open a package in “Play a file” first.');
        manifest = pkg.manifest;
        const inst = await decode(bufferOf(pkg.files[pkg.manifest.files.instrumental]));
        const voc = pkg.manifest.files.vocals ? await decode(bufferOf(pkg.files[pkg.manifest.files.vocals])) : null;
        engine.load(inst, voc);
        lyrics = pkg.lyrics;
        peaks = computePeaks(voc ?? inst);
      }
      offset = manifest!.offsetMs ?? 0;
      engine.setVocal(1);
      engine.onEnded = () => (playing = false);
      status = null;
      loop();
    } catch (e) { status = (e as Error).message; }
  }
  load();

  function computePeaks(b: AudioBuffer): Float32Array {
    const per = Math.floor(b.sampleRate / 100); // 10 ms buckets
    const ch = b.getChannelData(0);
    const out = new Float32Array(Math.ceil(ch.length / per));
    for (let i = 0; i < out.length; i++) {
      let m = 0;
      for (let j = i * per, end = Math.min(ch.length, j + per); j < end; j++) m = Math.max(m, Math.abs(ch[j]));
      out[i] = m;
    }
    return out;
  }

  function commit(next: Lyrics) {
    if (!lyrics) return;
    undo.push(lyrics);
    if (undo.length > 100) undo.shift();
    redo = [];
    lyrics = next;
    dirty = true;
  }
  function doUndo() { if (undo.length && lyrics) { redo.push(lyrics); lyrics = undo.pop()!; dirty = true; } }
  function doRedo() { if (redo.length && lyrics) { undo.push(lyrics); lyrics = redo.pop()!; dirty = true; } }

  // song time ↔ lyrics time: lyrics are shown at (song - offset)
  const now = () => engine.positionMs() - offset;

  function toggle() {
    if (engine.playing) engine.pause(); else engine.play();
    playing = engine.playing;
  }
  function seekTo(lyricsMs: number) { engine.seek(Math.max(0, lyricsMs + offset - 1000)); }

  function select(li: number, wi: number, seek = true) {
    sel = [li, wi];
    if (seek && lyrics) seekTo(lyrics.lines[li].words[wi].s);
  }

  function advance() {
    if (!lyrics) return;
    const [li, wi] = sel;
    if (wi + 1 < lyrics.lines[li].words.length) sel = [li, wi + 1];
    else if (li + 1 < lyrics.lines.length) sel = [li + 1, 0];
  }

  function tap() {
    if (!lyrics) return;
    commit(E.tapWord(lyrics, sel[0], sel[1], now()));
    advance();
  }
  function tapEnd() {
    if (!lyrics) return;
    const [li, wi] = sel;
    const prev: [number, number] = wi > 0 ? [li, wi - 1] : li > 0 ? [li - 1, lyrics.lines[li - 1].words.length - 1] : [li, wi];
    commit(E.tapEnd(lyrics, prev[0], prev[1], now()));
  }

  function onKey(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if (e.key === ' ') { e.preventDefault(); tapMode && playing ? tap() : toggle(); }
    else if (e.key === 'Enter' && tapMode) { e.preventDefault(); tapEnd(); }
    else if (e.key === 'p' || e.key === 'P') toggle();
    else if (e.key === 'ArrowRight') { advance(); }
    else if (e.key === 'ArrowLeft') { const [li, wi] = sel; sel = wi > 0 ? [li, wi - 1] : li > 0 ? [li - 1, lyrics!.lines[li - 1].words.length - 1] : sel; }
    else if (e.key === '[' && lyrics) commit(E.nudgeLine(lyrics, sel[0], -50));
    else if (e.key === ']' && lyrics) commit(E.nudgeLine(lyrics, sel[0], 50));
  }

  // ---- waveform + word boxes, drag with pointer events
  let drag: { li: number; wi: number; mode: 's' | 'e' | 'move'; x0: number; s0: number; e0: number } | null = null;

  function viewStart() { return now() - VIEW_MS * 0.35; }
  function msToX(ms: number) { return ((ms - viewStart()) / VIEW_MS) * (canvas?.width ?? 1); }
  function xToMs(x: number) { return viewStart() + (x / (canvas?.width ?? 1)) * VIEW_MS; }

  function hit(x: number, y: number) {
    if (!lyrics || !canvas || y < canvas.height * 0.55) return null;
    for (let li = 0; li < lyrics.lines.length; li++) {
      const ws = lyrics.lines[li].words;
      for (let wi = 0; wi < ws.length; wi++) {
        const a = msToX(ws[wi].s), b = msToX(ws[wi].e);
        if (x >= a - 6 && x <= b + 6) {
          const mode = Math.abs(x - a) < 8 ? 's' : Math.abs(x - b) < 8 ? 'e' : 'move';
          return { li, wi, mode } as const;
        }
      }
    }
    return null;
  }

  function pdown(e: PointerEvent) {
    const r = canvas!.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * canvas!.width;
    const y = ((e.clientY - r.top) / r.height) * canvas!.height;
    const h = hit(x, y);
    if (!h || !lyrics) { engine.seek(Math.max(0, xToMs(x) + offset)); return; }
    const w = lyrics.lines[h.li].words[h.wi];
    sel = [h.li, h.wi];
    drag = { ...h, x0: x, s0: w.s, e0: w.e };
    undo.push(lyrics);
    canvas!.setPointerCapture(e.pointerId);
  }
  function pmove(e: PointerEvent) {
    if (!drag || !lyrics || !canvas) return;
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * canvas.width;
    const d = ((x - drag.x0) / canvas.width) * VIEW_MS;
    const s = drag.mode === 'e' ? drag.s0 : drag.s0 + d;
    const en = drag.mode === 's' ? drag.e0 : drag.e0 + d;
    lyrics = E.setWordTimes(lyrics, drag.li, drag.wi, s, Math.max(s + E.MIN_WORD_MS, en));
    dirty = true;
  }
  function pup() { drag = null; redo = []; }

  function loop() {
    const tick = () => {
      pos = engine.positionMs();
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  function draw() {
    const c = canvas?.getContext('2d');
    if (!c || !canvas) return;
    const W = canvas.width, H = canvas.height;
    c.clearRect(0, 0, W, H);
    if (peaks) {
      c.fillStyle = '#5b5591';
      const songStart = viewStart() + offset;
      for (let x = 0; x < W; x += 2) {
        const i = Math.floor((songStart + (x / W) * VIEW_MS) / 10);
        const p = i >= 0 && i < peaks.length ? peaks[i] : 0;
        const h = p * H * 0.5;
        c.fillRect(x, H * 0.28 - h / 2, 2, Math.max(1, h));
      }
    }
    if (lyrics) {
      c.font = '14px system-ui, sans-serif';
      c.textBaseline = 'middle';
      lyrics.lines.forEach((ln, li) => ln.words.forEach((w, wi) => {
        const a = msToX(w.s), b = msToX(w.e);
        if (b < 0 || a > W) return;
        const selected = sel[0] === li && sel[1] === wi;
        c.fillStyle = selected ? '#ffd34d' : w.lowConfidence ? '#ff6fb188' : li % 2 ? '#7e78c8' : '#a39ee6';
        c.fillRect(a, H * 0.62, Math.max(2, b - a - 1), H * 0.3);
        c.fillStyle = '#14112b';
        c.fillText(w.t, a + 3, H * 0.77, Math.max(0, b - a - 4));
      }));
    }
    const x = msToX(now());
    c.fillStyle = '#ffffff';
    c.fillRect(x, 0, 2, H);
  }

  async function save() {
    if (!lyrics || !manifest) return;
    const clean = E.normalize(lyrics);
    try {
      if (code && songId && admin) {
        await saveLyrics(code, songId, admin, clean, offset);
        status = 'Saved to the library.';
      } else if (session.localPackage) {
        const pkg = session.localPackage;
        pkg.lyrics = clean;
        pkg.manifest.offsetMs = offset;
        if (pkg.manifest.lyricsSource === 'none' && clean.lines.length) pkg.manifest.lyricsSource = 'user';
        if (session.localSongId) {
          await updateLyrics(session.localSongId, clean, offset);
          status = 'Saved on this device.';
        } else {
          downloadBytes(writePackage(pkg), fileName(pkg.manifest));
          status = 'Downloaded the updated package.';
        }
      }
      dirty = false;
      setTimeout(() => (status = null), 3000);
    } catch (e) { status = (e as Error).message; }
  }

  function back() {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    history.length > 1 ? history.back() : navigate('/');
  }

  onDestroy(() => { cancelAnimationFrame(raf); engine.stop(); });
</script>

<svelte:window onkeydown={onKey} />

<main class="editor">
  <header class="bar">
    <button class="link" onclick={back}>← Back</button>
    <h2>Edit timing{#if manifest}: {manifest.title}{/if}</h2>
    {#if !code && session.localPackage}<button onclick={() => { const p = session.localPackage!; p.lyrics = E.normalize(lyrics!); p.manifest.offsetMs = offset; downloadBytes(writePackage(p), fileName(p.manifest)); }}>Download .jkp</button>{/if}
    <button class="primary" onclick={save} disabled={!dirty && offset === (manifest?.offsetMs ?? 0)}>Save</button>
  </header>
  {#if status}<p class="hint">{status}</p>{/if}

  {#if lyrics}
    <canvas class="timeline" bind:this={canvas} width="1200" height="180"
            onpointerdown={pdown} onpointermove={pmove} onpointerup={pup} onpointercancel={pup}></canvas>

    <div class="row transport">
      <button class="primary" onclick={toggle}>{playing ? '⏸' : '▶'}</button>
      <span>{mmss(pos)} / {mmss(engine.durationMs)}</span>
      <label class="group">Speed
        <select bind:value={speed} onchange={() => engine.setRate(speed)}>
          <option value={0.5}>50%</option><option value={0.75}>75%</option><option value={1}>100%</option>
        </select></label>
      <label class="group"><input type="checkbox" bind:checked={tapMode} /> Tap mode</label>
      {#if tapMode}<button class="primary" onpointerdown={(e) => { e.preventDefault(); tap(); }}>TAP word</button>
        <button onpointerdown={(e) => { e.preventDefault(); tapEnd(); }}>end previous</button>{/if}
      <span class="group">Whole song <button onclick={() => (offset -= 50)}>−</button><b>{offset} ms</b><button onclick={() => (offset += 50)}>+</button></span>
      <button onclick={doUndo} title="Ctrl+Z">Undo</button><button onclick={doRedo}>Redo</button>
    </div>
    <p class="hint">Tap mode: play, then press Space (or TAP) as each highlighted word starts; Enter ends the previous word.
      Drag word boxes or their edges. [ ] nudge the selected line. Pink = the aligner wasn't sure.</p>

    <ol class="lines">
      {#each lyrics.lines as ln, li (li)}
        <li class:sel={sel[0] === li} data-singer={ln.singer ?? ''}>
          <span class="t muted">{mmss(ln.start)}</span>
          <span class="words">
            {#each ln.words as w, wi (wi)}
              <button class="word" class:sel={sel[0] === li && sel[1] === wi} class:low={w.lowConfidence}
                      onclick={() => select(li, wi)}>{w.t}</button>
            {/each}
          </span>
          {#if sel[0] === li}
            <span class="acts">
              <button class="small" onclick={() => commit(E.nudgeLine(lyrics!, li, -50))}>−50</button>
              <button class="small" onclick={() => commit(E.nudgeLine(lyrics!, li, 50))}>+50</button>
              <button class="small" onclick={() => commit(E.splitLine(lyrics!, li, sel[1]))} disabled={sel[1] === 0}>split</button>
              <button class="small" onclick={() => commit(E.mergeWithNext(lyrics!, li))}>merge ↓</button>
              <button class="small" onclick={() => commit(E.setSinger(lyrics!, li, ln.singer === 'A' ? 'B' : ln.singer === 'B' ? null : 'A'))}>singer: {ln.singer ?? '–'}</button>
              <button class="small" onclick={() => { const t = prompt('Line text', ln.words.map((w) => w.t).join(' ')); if (t != null) commit(E.retextLine(lyrics!, li, t)); }}>text</button>
              <button class="small" onclick={() => { const t = prompt('New line after this one'); if (t?.trim()) commit(E.insertLineAfter(lyrics!, li, t)); }}>+ line</button>
              <button class="small danger" onclick={() => confirm('Delete this line?') && commit(E.deleteLine(lyrics!, li))}>delete</button>
            </span>
          {/if}
        </li>
      {:else}
        <li class="muted">No lyrics yet.
          <button onclick={() => { const t = prompt('Paste the lyrics (one line per line)'); if (t) {
            let l: Lyrics = { version: 1, lines: [] };
            let at = -1;
            for (const line of t.split('\n').map((s) => s.trim()).filter(Boolean)) { l = E.insertLineAfter(l, at, line); at++; }
            commit(l); } }}>Paste lyrics</button></li>
      {/each}
    </ol>
  {/if}
</main>
