// Types for lyrics.json (spec/lyrics.schema.json) plus pure timeline helpers.

export interface Word { t: string; s: number; e: number; lowConfidence?: boolean }
export interface Line { start: number; end: number; singer?: string; words: Word[] }
export interface Lyrics { version: 1; singers?: Record<string, string>; lines: Line[] }

/** Gap before a line (ms) that earns countdown dots. */
export const COUNTDOWN_GAP_MS = 4000;
/** Dots shown before a line after a long gap; one disappears per beat. */
export const COUNTDOWN_DOTS = 3;
export const COUNTDOWN_LEAD_MS = 3000;

/** Index of the line to show as "current" at time t: the line being sung, or the
 * next one up. Returns lines.length after the last line. Binary search. */
export function currentLineIndex(lines: Line[], t: number): number {
  let lo = 0, hi = lines.length;
  // first line whose end > t
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].end <= t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Fraction 0..1 of a word that has been sung at time t. */
export function wordProgress(w: Word, t: number): number {
  if (t <= w.s) return 0;
  if (t >= w.e) return 1;
  return (t - w.s) / Math.max(1, w.e - w.s);
}

/** Countdown dots (0..COUNTDOWN_DOTS) to show before line i at time t, 0 if none. */
export function countdownDots(lines: Line[], i: number, t: number): number {
  const line = lines[i];
  if (!line || t >= line.start) return 0;
  const prevEnd = i > 0 ? lines[i - 1].end : 0;
  if (line.start - prevEnd < COUNTDOWN_GAP_MS) return 0;
  const left = line.start - t;
  if (left > COUNTDOWN_LEAD_MS) return 0;
  return Math.min(COUNTDOWN_DOTS, Math.ceil(left / (COUNTDOWN_LEAD_MS / COUNTDOWN_DOTS)));
}

/** True when nothing is being sung for a while: show "♪ instrumental ♪". */
export function inInstrumentalBreak(lines: Line[], t: number): boolean {
  const i = currentLineIndex(lines, t);
  const line = lines[i];
  if (!line) return lines.length > 0;
  const prevEnd = i > 0 ? lines[i - 1].end : 0;
  return t < line.start - COUNTDOWN_LEAD_MS && line.start - prevEnd >= COUNTDOWN_GAP_MS;
}

/** The two lines to display (top, bottom). Lines alternate between the two slots so the
 * line being sung never jumps, and the upcoming line appears in the other slot. */
export function displayPair(lines: Line[], t: number): [number | null, number | null] {
  const i = currentLineIndex(lines, t);
  if (i >= lines.length) return [null, null];
  const other = i + 1 < lines.length ? i + 1 : null;
  return i % 2 === 0 ? [i, other] : [other, i];
}

/** Shift every timestamp by offsetMs (positive = later), clamped at 0. */
export function shiftLyrics(l: Lyrics, offsetMs: number): Lyrics {
  const f = (x: number) => Math.max(0, x + offsetMs);
  return {
    ...l,
    lines: l.lines.map((ln) => ({
      ...ln, start: f(ln.start), end: f(ln.end),
      words: ln.words.map((w) => ({ ...w, s: f(w.s), e: f(w.e) })),
    })),
  };
}
