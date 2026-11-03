// MDX-Net vocal separation (UVR models), model-agnostic: the network is passed in as a
// function so this file is pure DSP and unit-testable. Parameters match UVR's MDX path:
// torch-style centred STFT with a periodic Hann window, spectrogram cut to dim_f bins,
// channels laid out [L.re, L.im, R.re, R.im], lowest 3 bins zeroed, chunks blended with a
// Hann window at 25 % overlap.

import { FFT } from './fft';

export interface MdxConfig {
  nFft: number;
  hop: number;
  dimF: number;
  dimT: number;
  compensate: number;
  /** what the model outputs */
  primary: 'instrumental' | 'vocals';
}

export const INST_HQ_3: MdxConfig = { nFft: 6144, hop: 1024, dimF: 3072, dimT: 256, compensate: 1.022, primary: 'instrumental' };

export type ModelFn = (spec: Float32Array) => Promise<Float32Array>;

export class Stft {
  readonly fft: FFT;
  readonly win: Float64Array;
  readonly chunk: number;
  private re: Float64Array;
  private im: Float64Array;

  constructor(readonly c: MdxConfig) {
    this.fft = new FFT(c.nFft);
    this.win = new Float64Array(c.nFft);
    for (let i = 0; i < c.nFft; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / c.nFft);
    this.chunk = c.hop * (c.dimT - 1);
    this.re = new Float64Array(c.nFft);
    this.im = new Float64Array(c.nFft);
  }

  /** chunk-length stereo → model input [4, dimF, dimT] */
  forward(left: Float32Array, right: Float32Array): Float32Array {
    const { nFft, hop, dimF, dimT } = this.c;
    const pad = nFft >> 1;
    const out = new Float32Array(4 * dimF * dimT);
    const n = this.chunk;
    [left, right].forEach((x, ch) => {
      for (let t = 0; t < dimT; t++) {
        const s0 = t * hop - pad;
        for (let i = 0; i < nFft; i++) {
          let j = s0 + i;
          if (j < 0) j = -j;                       // reflect padding (no edge repeat)
          else if (j >= n) j = 2 * (n - 1) - j;
          this.re[i] = (x[j] ?? 0) * this.win[i];
          this.im[i] = 0;
        }
        this.fft.forward(this.re, this.im);
        const baseR = (ch * 2) * dimF * dimT, baseI = (ch * 2 + 1) * dimF * dimT;
        for (let f = 3; f < dimF; f++) {           // bins 0..2 stay zero
          out[baseR + f * dimT + t] = this.re[f];
          out[baseI + f * dimT + t] = this.im[f];
        }
      }
    });
    return out;
  }

  /** model output [4, dimF, dimT] → chunk-length stereo */
  inverse(spec: Float32Array): [Float32Array, Float32Array] {
    const { nFft, hop, dimF, dimT } = this.c;
    const pad = nFft >> 1;
    const len = nFft + hop * (dimT - 1);
    const res: Float32Array[] = [];
    const wsum = new Float64Array(len);
    for (let t = 0; t < dimT; t++) for (let i = 0; i < nFft; i++) wsum[t * hop + i] += this.win[i] * this.win[i];
    for (let ch = 0; ch < 2; ch++) {
      const acc = new Float64Array(len);
      const baseR = (ch * 2) * dimF * dimT, baseI = (ch * 2 + 1) * dimF * dimT;
      for (let t = 0; t < dimT; t++) {
        this.re.fill(0); this.im.fill(0);
        for (let f = 0; f < dimF; f++) {
          this.re[f] = spec[baseR + f * dimT + t];
          this.im[f] = spec[baseI + f * dimT + t];
        }
        for (let f = 1; f < nFft >> 1; f++) {      // Hermitian mirror; bins ≥ dimF are zero
          this.re[nFft - f] = this.re[f];
          this.im[nFft - f] = -this.im[f];
        }
        this.im[0] = 0;
        this.fft.inverse(this.re, this.im);
        for (let i = 0; i < nFft; i++) acc[t * hop + i] += this.re[i] * this.win[i];
      }
      const out = new Float32Array(this.chunk);
      for (let i = 0; i < this.chunk; i++) out[i] = acc[i + pad] / Math.max(wsum[i + pad], 1e-8);
      res.push(out);
    }
    return [res[0], res[1]];
  }
}

export interface Separated { instL: Float32Array; instR: Float32Array; vocL: Float32Array; vocR: Float32Array }

/** Separate a whole song (44.1 kHz stereo). `onPart(done)` is called whenever more of the
 *  result is final: samples [0, done) of the returned arrays won't change any more (the same
 *  arrays are returned at the end), so playback can start before the whole song is done. */
export async function separate(left: Float32Array, right: Float32Array, model: ModelFn, c: MdxConfig = INST_HQ_3,
  onProgress?: (frac: number) => void, overlap = 0.25,
  onPart?: (done: number, out: Separated) => void): Promise<Separated> {
  const st = new Stft(c);
  const chunk = st.chunk;
  const trim = c.nFft >> 1;
  const gen = chunk - 2 * trim;
  const n = left.length;
  const padEnd = gen + trim - (n % gen);
  const total = trim + n + padEnd;
  const mixL = new Float32Array(total), mixR = new Float32Array(total);
  mixL.set(left, trim);
  mixR.set(right, trim);
  const accL = new Float64Array(total), accR = new Float64Array(total), div = new Float64Array(total);
  const win = new Float64Array(chunk);
  for (let i = 0; i < chunk; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (chunk - 1)); // np.hanning
  const step = Math.max(1, Math.floor((1 - overlap) * chunk));
  const starts: number[] = [];
  for (let i = 0; i < total; i += step) starts.push(i);

  const primL = new Float32Array(n), primR = new Float32Array(n);
  const otherL = new Float32Array(n), otherR = new Float32Array(n);
  const out: Separated = c.primary === 'instrumental'
    ? { instL: primL, instR: primR, vocL: otherL, vocR: otherR }
    : { instL: otherL, instR: otherR, vocL: primL, vocR: primR };
  let done = 0;
  // output sample k is final once no later chunk overlaps it (acc index trim + k)
  const finalize = (upTo: number) => {
    upTo = Math.min(n, Math.max(done, upTo));
    for (let k = done; k < upTo; k++) {
      const d = Math.max(div[trim + k], 1e-4);
      const pl = accL[trim + k] / d, pr = accR[trim + k] / d;
      primL[k] = pl; primR[k] = pr;
      otherL[k] = left[k] - primL[k];
      otherR[k] = right[k] - primR[k];
      if (c.primary === 'instrumental') { primL[k] *= c.compensate; primR[k] *= c.compensate; }
    }
    done = upTo;
  };

  const partL = new Float32Array(chunk), partR = new Float32Array(chunk);
  for (let s = 0; s < starts.length; s++) {
    const i = starts[s];
    const end = Math.min(i + chunk, total);
    partL.fill(0); partR.fill(0);
    partL.set(mixL.subarray(i, end));
    partR.set(mixR.subarray(i, end));
    const [oL, oR] = st.inverse(await model(st.forward(partL, partR)));
    for (let k = 0; k < end - i; k++) {
      const w = win[k];
      accL[i + k] += oL[k] * w;
      accR[i + k] += oR[k] * w;
      div[i + k] += w;
    }
    const before = done;
    finalize(s + 1 < starts.length ? starts[s + 1] - trim : n);
    if (onPart && done > before) onPart(done, out);
    onProgress?.((s + 1) / starts.length);
  }
  finalize(n);
  return out;
}
