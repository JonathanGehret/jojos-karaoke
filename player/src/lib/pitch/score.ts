// Score singing against the reference pitch contour. Octave-agnostic, so anyone can sing
// in a comfortable octave; key changes are applied to the reference.

export interface Contour { hopMs: number; midi: (number | null)[] }

export function refAt(c: Contour, tMs: number, key = 0): number | null {
  const i = Math.round(tMs / c.hopMs);
  const v = c.midi[i];
  return v == null ? null : v + key;
}

/** Distance in semitones between two notes, ignoring octaves (0..6). */
export function pitchClassDistance(a: number, b: number): number {
  const d = (((a - b) % 12) + 12) % 12;
  return Math.min(d, 12 - d);
}

/** 1 for within a semitone, falling to 0 at 2.5 semitones. */
export function frameScore(sung: number, ref: number): number {
  const d = pitchClassDistance(sung, ref);
  if (d <= 1) return 1;
  if (d >= 2.5) return 0;
  return (2.5 - d) / 1.5;
}

export class ScoreKeeper {
  private total = 0;
  private hits = 0;

  /** Feed one mic frame. `sung` null = silence/unvoiced. Only frames where the reference
   * is voiced count; staying silent during a sung part costs points. */
  add(ref: number | null, sung: number | null) {
    if (ref == null) return;
    this.total++;
    if (sung != null) this.hits += frameScore(sung, ref);
  }

  get value(): number {
    return this.total ? Math.round((this.hits / this.total) * 100) : 0;
  }

  get frames() { return this.total; }
}
