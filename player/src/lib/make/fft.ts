// Complex FFT for sizes 2^a and 3·2^a (the separation model uses n_fft = 6144 = 3·2048).
// In place on separate real/imag arrays.

class Radix2 {
  readonly cos: Float64Array;
  readonly sin: Float64Array;
  readonly rev: Uint32Array;

  constructor(readonly n: number) {
    if (n & (n - 1)) throw new Error(`radix-2 FFT size must be a power of two, got ${n}`);
    this.cos = new Float64Array(n >> 1);
    this.sin = new Float64Array(n >> 1);
    for (let i = 0; i < n >> 1; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  forward(re: Float64Array, im: Float64Array) {
    const { n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, tw = 0; k < half; k++, tw += step) {
          const a = start + k, b = a + half;
          const wr = cos[tw], wi = sin[tw];
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }
}

export class FFT {
  private r2: Radix2;
  private three: boolean;
  private m: number;
  private sub: Float64Array[] = [];
  private tw1r!: Float64Array; private tw1i!: Float64Array;
  private tw2r!: Float64Array; private tw2i!: Float64Array;

  constructor(readonly n: number) {
    this.three = n % 3 === 0;
    this.m = this.three ? n / 3 : n;
    this.r2 = new Radix2(this.m);
    if (this.three) {
      const m = this.m;
      for (let i = 0; i < 6; i++) this.sub.push(new Float64Array(m));
      this.tw1r = new Float64Array(n); this.tw1i = new Float64Array(n);
      this.tw2r = new Float64Array(n); this.tw2i = new Float64Array(n);
      for (let k = 0; k < n; k++) {
        this.tw1r[k] = Math.cos((2 * Math.PI * k) / n); this.tw1i[k] = -Math.sin((2 * Math.PI * k) / n);
        this.tw2r[k] = Math.cos((4 * Math.PI * k) / n); this.tw2i[k] = -Math.sin((4 * Math.PI * k) / n);
      }
    }
  }

  forward(re: Float64Array, im: Float64Array) {
    if (!this.three) return this.r2.forward(re, im);
    const { m, n, sub } = this;
    const [r0, i0, r1, i1, r2, i2] = sub;
    for (let k = 0; k < m; k++) {
      r0[k] = re[3 * k]; i0[k] = im[3 * k];
      r1[k] = re[3 * k + 1]; i1[k] = im[3 * k + 1];
      r2[k] = re[3 * k + 2]; i2[k] = im[3 * k + 2];
    }
    this.r2.forward(r0, i0);
    this.r2.forward(r1, i1);
    this.r2.forward(r2, i2);
    // X[k] = F0[k mod m] + W^k F1[k mod m] + W^2k F2[k mod m]
    for (let k = 0; k < n; k++) {
      const q = k % m;
      const ar = r1[q] * this.tw1r[k] - i1[q] * this.tw1i[k];
      const ai = r1[q] * this.tw1i[k] + i1[q] * this.tw1r[k];
      const br = r2[q] * this.tw2r[k] - i2[q] * this.tw2i[k];
      const bi = r2[q] * this.tw2i[k] + i2[q] * this.tw2r[k];
      re[k] = r0[q] + ar + br;
      im[k] = i0[q] + ai + bi;
    }
  }

  /** Inverse (scaled by 1/n). */
  inverse(re: Float64Array, im: Float64Array) {
    for (let i = 0; i < this.n; i++) im[i] = -im[i];
    this.forward(re, im);
    const s = 1 / this.n;
    for (let i = 0; i < this.n; i++) { re[i] *= s; im[i] = -im[i] * s; }
  }
}
