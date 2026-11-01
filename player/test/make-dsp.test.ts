import { describe, expect, it } from 'vitest';
import { FFT } from '../src/lib/make/fft';
import { INST_HQ_3, type MdxConfig, Stft, separate } from '../src/lib/make/mdx';
import { muxOggOpus, oggCrc, readOggPages } from '../src/lib/make/ogg';

function naiveDft(re: number[], im: number[]) {
  const n = re.length, R = new Array(n).fill(0), I = new Array(n).fill(0);
  for (let k = 0; k < n; k++) for (let t = 0; t < n; t++) {
    const a = (-2 * Math.PI * k * t) / n;
    R[k] += re[t] * Math.cos(a) - im[t] * Math.sin(a);
    I[k] += re[t] * Math.sin(a) + im[t] * Math.cos(a);
  }
  return [R, I];
}

describe('fft', () => {
  for (const n of [8, 12, 48, 96, 6144]) {
    it(`matches a naive DFT for n=${n}`, () => {
      const re = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.37) + (i % 5) * 0.1);
      const im = Float64Array.from({ length: n }, (_, i) => Math.cos(i * 0.11) * 0.5);
      const [R, I] = n <= 96 ? naiveDft([...re], [...im]) : [null, null];
      const r = Float64Array.from(re), m = Float64Array.from(im);
      const f = new FFT(n);
      f.forward(r, m);
      if (R) for (let k = 0; k < n; k++) { expect(r[k]).toBeCloseTo(R[k], 8); expect(m[k]).toBeCloseTo(I![k], 8); }
      f.inverse(r, m);
      for (let k = 0; k < n; k++) { expect(r[k]).toBeCloseTo(re[k], 9); expect(m[k]).toBeCloseTo(im[k], 9); }
    });
  }
  it('rejects unsupported sizes', () => expect(() => new FFT(10)).toThrow());
});

// small config so tests are fast; same structure as the real model
const SMALL: MdxConfig = { nFft: 96, hop: 16, dimF: 48, dimT: 32, compensate: 1, primary: 'instrumental' };

describe('stft', () => {
  it('reconstructs a chunk', () => {
    const st = new Stft(SMALL);
    const n = st.chunk;
    const sr = 1000;
    const L = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 120 * i) / sr));
    const R = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 200 * i) / sr + 1));
    const spec = st.forward(L, R);
    expect(spec.length).toBe(4 * SMALL.dimF * SMALL.dimT);
    const [l2, r2] = st.inverse(spec);
    // the outer nFft/2 samples see the reflect padding, where dropping the lowest bins matters;
    // chunk edges get (almost) no weight when chunks are blended
    let err = 0;
    for (let i = SMALL.nFft / 2; i < n - SMALL.nFft / 2; i++) err = Math.max(err, Math.abs(l2[i] - L[i]), Math.abs(r2[i] - R[i]));
    expect(err).toBeLessThan(1e-2); // coarse test bins: zeroing bins 0-2 costs a little here
  });

  it('is near-exact with the real model settings (44.1 kHz, n_fft 6144)', () => {
    const st = new Stft(INST_HQ_3);
    const n = st.chunk;
    const L = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 44100));
    const R = Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 1234 * i) / 44100 + 0.5));
    const [l2, r2] = st.inverse(st.forward(L, R));
    let err = 0;
    for (let i = 3072; i < n - 3072; i++) err = Math.max(err, Math.abs(l2[i] - L[i]), Math.abs(r2[i] - R[i]));
    expect(err).toBeLessThan(1e-3); // float32 spectrogram (the model's input type): ~ -65 dB
  });

  it('lays out channels as [L.re, L.im, R.re, R.im]', () => {
    const st = new Stft(SMALL);
    const n = st.chunk;
    const L = Float32Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * 10 * i) / SMALL.nFft));
    const R = new Float32Array(n);
    const spec = st.forward(L, R);
    const plane = SMALL.dimF * SMALL.dimT;
    const energy = (p: number) => spec.subarray(p * plane, (p + 1) * plane).reduce((a, x) => a + x * x, 0);
    expect(energy(0)).toBeGreaterThan(1);
    expect(energy(2) + energy(3)).toBe(0);
  });
});

describe('mdx separation', () => {
  const sr = 1000;
  const n = 5000;
  const inst = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 100 * i) / sr));
  const voc = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 250 * i) / sr));
  const mix = inst.map((x, i) => x + voc[i]);

  it('with an identity "model" the instrumental is the mix and vocals are silent', async () => {
    const st = new Stft(SMALL);
    let calls = 0;
    const res = await separate(mix, mix, async (s) => { calls++; return s; }, SMALL);
    expect(calls).toBeGreaterThan(Math.ceil(n / st.chunk));       // overlapping chunks
    let err = 0;
    for (let i = SMALL.nFft; i < n - SMALL.nFft; i++) err = Math.max(err, Math.abs(res.instL[i] - mix[i]), Math.abs(res.vocR[i]));
    expect(err).toBeLessThan(1e-2);
  });

  it('a model that keeps only low bins splits the two tones', async () => {
    const keepLow = async (s: Float32Array) => {
      const out = new Float32Array(s.length);
      const { dimF, dimT } = SMALL;
      const cut = Math.round((175 / sr) * SMALL.nFft);              // bin between 100 Hz and 250 Hz
      for (let p = 0; p < 4; p++) for (let f = 0; f < Math.min(cut, dimF); f++) for (let t = 0; t < dimT; t++) {
        const k = (p * dimF + f) * dimT + t;
        out[k] = s[k];
      }
      return out;
    };
    const res = await separate(mix, mix, keepLow, SMALL);
    const rms = (a: Float32Array, b: Float32Array) => Math.sqrt(a.reduce((acc, x, i) => acc + (x - b[i]) ** 2, 0) / a.length);
    expect(rms(res.instL.subarray(500, 4500), inst.subarray(500, 4500))).toBeLessThan(0.05);
    expect(rms(res.vocL.subarray(500, 4500), voc.subarray(500, 4500))).toBeLessThan(0.05);
  });

  it('reports progress', async () => {
    const seen: number[] = [];
    await separate(mix, mix, async (s) => s, SMALL, (f) => seen.push(f));
    expect(seen.at(-1)).toBe(1);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });
});

describe('ogg opus muxer', () => {
  it('known CRC', () => {
    expect(oggCrc(new TextEncoder().encode('OggS'))).toBe(0x5fb0a94f);
  });
  it('writes valid pages with granule positions', () => {
    const packets = Array.from({ length: 120 }, (_, i) => ({ data: new Uint8Array(i === 7 ? 600 : 40).fill(i), samples: 960 }));
    const file = muxOggOpus(packets, { channels: 2, preSkip: 312, inputRate: 44100, totalSamples: 120 * 960 - 500 });
    const pages = readOggPages(file);
    expect(pages.every((p) => p.crcOk)).toBe(true);
    expect(pages[0].flags).toBe(0x02);
    expect(pages.at(-1)!.flags).toBe(0x04);
    expect(pages.length).toBe(2 + 3);
    expect(pages[2].granule).toBe(50n * 960n);
    expect(pages.at(-1)!.granule).toBe(BigInt(312 + 120 * 960 - 500));
    expect(pages.slice(2).reduce((a, p) => a + p.packets, 0)).toBe(120);
  });
});
