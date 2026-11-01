// Plays the instrumental and vocal stems in sample-accurate sync, with guide-vocal level,
// key shift (SoundTouch AudioWorklet) and tempo (source playbackRate, pitch compensated).

import { SoundTouchNode } from '@soundtouchjs/audio-worklet';
import processorUrl from '@soundtouchjs/audio-worklet/processor?url';

export const KEY_RANGE = 6;
export const RATE_RANGE: [number, number] = [0.8, 1.2];

let sharedCtx: AudioContext | null = null;
let workletReady: Promise<boolean> | null = null;

/** One AudioContext per page; create/resume it from a user gesture (autoplay rules). */
export function audioContext(): AudioContext {
  if (!sharedCtx) sharedCtx = new AudioContext({ latencyHint: 'playback' });
  return sharedCtx;
}

export async function unlockAudio(): Promise<void> {
  const ctx = audioContext();
  if (ctx.state !== 'running') await ctx.resume();
}

function loadWorklet(ctx: AudioContext): Promise<boolean> {
  workletReady ??= Promise.race([
    SoundTouchNode.register(ctx, processorUrl).then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
  ]).catch(() => false);
  return workletReady;
}

export async function decode(data: ArrayBuffer): Promise<AudioBuffer> {
  return audioContext().decodeAudioData(data);
}

export async function fetchAudio(url: string): Promise<AudioBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`could not load audio (${r.status})`);
  return decode(await r.arrayBuffer());
}

export class AudioEngine {
  ctx = audioContext();
  inst: AudioBuffer | null = null;
  voc: AudioBuffer | null = null;
  private srcI: AudioBufferSourceNode | null = null;
  private srcV: AudioBufferSourceNode | null = null;
  private gainV = this.ctx.createGain();
  private gainI = this.ctx.createGain();
  private master = this.ctx.createGain();
  private st: SoundTouchNode | null = null;
  private anchorCtx = 0;   // ctx time at which anchorPos was the position
  private anchorPos = 0;   // song position in ms
  playing = false;
  rate = 1;
  key = 0;
  vocal = 0;
  volume = 1;
  pitchShift = false;      // true once the SoundTouch worklet is wired in
  onEnded: (() => void) | null = null;

  async init() {
    this.gainI.connect(this.master);
    this.gainV.connect(this.master);
    this.gainV.gain.value = 0;
    if (await loadWorklet(this.ctx)) {
      try {
        this.st = new SoundTouchNode({ context: this.ctx });
        this.master.connect(this.st);
        this.st.connect(this.ctx.destination);
        this.pitchShift = true;
        return;
      } catch { /* fall through */ }
    }
    this.master.connect(this.ctx.destination);
  }

  load(inst: AudioBuffer, voc: AudioBuffer | null) {
    this.stop();
    this.inst = inst;
    this.voc = voc;
    this.anchorPos = 0;
  }

  get durationMs() { return this.inst ? this.inst.duration * 1000 : 0; }

  /** Output latency the listener hears on top of the scheduling clock. */
  private latencyMs() {
    return ((this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0)) * 1000;
  }

  /** Audible song position in ms. */
  positionMs(): number {
    if (!this.playing) return this.anchorPos;
    const p = this.anchorPos + (this.ctx.currentTime - this.anchorCtx) * 1000 * this.rate - this.latencyMs() * this.rate;
    return Math.max(0, Math.min(p, this.durationMs));
  }

  play(fromMs = this.anchorPos) {
    if (!this.inst) return;
    this.stopSources();
    const when = this.ctx.currentTime + 0.05;
    const offset = Math.max(0, Math.min(fromMs, this.durationMs - 1)) / 1000;
    const mk = (buf: AudioBuffer, dst: AudioNode) => {
      const s = this.ctx.createBufferSource();
      s.buffer = buf;
      s.playbackRate.value = this.rate;
      s.connect(dst);
      s.start(when, offset);
      return s;
    };
    this.srcI = mk(this.inst, this.gainI);
    if (this.voc) this.srcV = mk(this.voc, this.gainV);
    const me = this.srcI;
    this.srcI.onended = () => {
      if (this.srcI === me && this.playing) {
        this.playing = false;
        this.anchorPos = this.durationMs;
        this.onEnded?.();
      }
    };
    // anchor so that positionMs() == fromMs once the sound actually reaches the speakers
    this.anchorCtx = when;
    this.anchorPos = fromMs + this.latencyMs() * this.rate;
    this.playing = true;
    this.applyParams();
  }

  pause() {
    if (!this.playing) return;
    this.anchorPos = this.positionMs();
    this.playing = false;
    this.stopSources();
  }

  seek(ms: number) {
    if (this.playing) this.play(ms);
    else this.anchorPos = Math.max(0, Math.min(ms, this.durationMs));
  }

  stop() {
    this.playing = false;
    this.stopSources();
    this.anchorPos = 0;
  }

  setRate(rate: number) {
    rate = Math.max(RATE_RANGE[0], Math.min(RATE_RANGE[1], rate));
    if (this.playing) {
      const pos = this.positionMs();
      this.anchorCtx = this.ctx.currentTime;
      this.anchorPos = pos + this.latencyMs() * rate;
    }
    this.rate = rate;
    this.applyParams();
  }

  setKey(semitones: number) {
    this.key = Math.max(-KEY_RANGE, Math.min(KEY_RANGE, Math.round(semitones)));
    this.applyParams();
  }

  setVocal(v: number) {
    this.vocal = Math.max(0, Math.min(1, v));
    this.applyParams();
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    this.applyParams();
  }

  private applyParams() {
    const t = this.ctx.currentTime;
    this.gainV.gain.setTargetAtTime(this.vocal, t, 0.03);
    this.master.gain.setTargetAtTime(this.volume, t, 0.03);
    for (const s of [this.srcI, this.srcV]) if (s) s.playbackRate.setValueAtTime(this.rate, t);
    if (this.st) {
      this.st.playbackRate.value = this.rate;   // processor divides pitch by this: tempo keeps the key
      this.st.pitchSemitones.value = this.key;
    }
  }

  private stopSources() {
    for (const s of [this.srcI, this.srcV]) {
      if (!s) continue;
      s.onended = null;
      try { s.stop(); } catch { /* not started */ }
      s.disconnect();
    }
    this.srcI = this.srcV = null;
  }
}
