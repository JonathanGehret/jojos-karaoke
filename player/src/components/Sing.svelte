<script lang="ts">
  // The singer's phone listens to their voice and scores it against the reference pitch.
  import { onDestroy } from 'svelte';
  import { hzToMidi, rms, yin } from '../lib/pitch/yin';
  import { type Contour, ScoreKeeper, refAt } from '../lib/pitch/score';

  let { pitch, clock, keyShift = 0, onscore }:
    { pitch: Contour; clock: () => number; keyShift?: number; onscore: (v: number, final: boolean) => void } = $props();

  let on = $state(false);
  let value = $state(0);
  let err = $state<string | null>(null);
  let canvas = $state<HTMLCanvasElement | null>(null);
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let timer = 0;
  let sendTimer = 0;
  const keeper = new ScoreKeeper();
  const trail: { t: number; m: number | null }[] = [];

  async function start() {
    err = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      err = 'Microphone permission is needed for scoring.';
      return;
    }
    ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    on = true;
    timer = window.setInterval(() => {
      an.getFloatTimeDomainData(buf);
      const t = clock();
      const ref = refAt(pitch, t, keyShift);
      const f = rms(buf) > 0.01 ? yin(buf, ctx!.sampleRate) : null;
      const m = f ? hzToMidi(f) : null;
      keeper.add(ref, m);
      value = keeper.value;
      trail.push({ t, m });
      if (trail.length > 200) trail.shift();
      draw(t);
    }, 50);
    sendTimer = window.setInterval(() => onscore(keeper.value, false), 2000);
  }

  function stop(final = true) {
    clearInterval(timer);
    clearInterval(sendTimer);
    stream?.getTracks().forEach((t) => t.stop());
    ctx?.close();
    if (on && final && keeper.frames > 20) onscore(keeper.value, true);
    on = false;
  }

  function draw(t: number) {
    const cv = canvas;
    const c = cv?.getContext('2d');
    if (!cv || !c) return;
    const W = cv.width, H = cv.height;
    c.clearRect(0, 0, W, H);
    const span = 6000, x = (tt: number) => ((tt - t + span / 2) / span) * W;
    const y = (m: number) => H - ((((m % 12) + 12) % 12) / 12) * H;
    c.fillStyle = '#ffd34d55';
    for (let tt = t - span / 2; tt < t + span / 2; tt += pitch.hopMs) {
      const r = refAt(pitch, tt, keyShift);
      if (r != null) c.fillRect(x(tt), y(r) - 4, 3, 8);
    }
    c.fillStyle = '#ff6fb1';
    for (const p of trail) if (p.m != null) c.fillRect(x(p.t) - 2, y(p.m) - 2, 4, 4);
    c.fillStyle = '#ffffff44';
    c.fillRect(W / 2, 0, 1, H);
  }

  onDestroy(() => stop(true));
</script>

<div class="sing">
  {#if on}
    <canvas bind:this={canvas} width="320" height="90"></canvas>
    <div class="row"><b>Score {value}</b><button class="small" onclick={() => stop(true)}>Stop</button></div>
  {:else}
    <button onclick={start}>🎙 Score my singing</button>
  {/if}
  {#if err}<p class="error">{err}</p>{/if}
</div>
