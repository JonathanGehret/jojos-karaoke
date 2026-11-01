// YIN pitch detection for the singer's mic (same algorithm as the maker's pitch.py).

const THRESHOLD = 0.15;

export function yin(frame: Float32Array, sr: number, fmin = 70, fmax = 1100): number | null {
  const w = frame.length >> 1;
  const tauMin = Math.floor(sr / fmax);
  const tauMax = Math.min(Math.floor(sr / fmin), w);
  const d = new Float32Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0;
    for (let j = 0; j < w; j++) {
      const x = frame[j] - frame[j + tau];
      s += x * x;
    }
    d[tau] = s;
  }
  let running = 0;
  let tau = -1;
  const cmnd = new Float32Array(tauMax + 1);
  cmnd[0] = 1;
  for (let t = 1; t <= tauMax; t++) {
    running += d[t];
    cmnd[t] = running > 0 ? (d[t] * t) / running : 1;
  }
  for (let t = tauMin; t <= tauMax; t++) {
    if (cmnd[t] < THRESHOLD) {
      while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) return null;
  let shift = 0;
  if (tau > 0 && tau < tauMax) {
    const a = cmnd[tau - 1], b = cmnd[tau], c = cmnd[tau + 1];
    const den = a - 2 * b + c;
    if (den !== 0) shift = (0.5 * (a - c)) / den;
  }
  return sr / (tau + shift);
}

export const hzToMidi = (f: number) => 69 + 12 * Math.log2(f / 440);

export function rms(frame: Float32Array): number {
  let s = 0;
  for (const x of frame) s += x * x;
  return Math.sqrt(s / frame.length);
}
