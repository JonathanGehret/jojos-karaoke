// NTP-style clock offset estimation. offset = serverTime - clientTime.

export interface ClockSample { offset: number; rtt: number }

/** One ping/pong exchange: client sent at c0, server stamped s, client received at c1. */
export function sampleFrom(c0: number, s: number, c1: number): ClockSample {
  const rtt = c1 - c0;
  return { rtt, offset: s - (c0 + rtt / 2) };
}

/** Median offset of the lowest-RTT half of the samples (slow round trips are the noisy
 * ones). Returns null with no samples. */
export function estimateOffset(samples: ClockSample[]): number | null {
  if (!samples.length) return null;
  const best = [...samples].sort((a, b) => a.rtt - b.rtt).slice(0, Math.max(1, Math.ceil(samples.length / 2)));
  const offs = best.map((s) => s.offset).sort((a, b) => a - b);
  const m = offs.length >> 1;
  return offs.length % 2 ? offs[m] : (offs[m - 1] + offs[m]) / 2;
}

export interface PlaybackClock {
  state: 'playing' | 'paused' | 'stopped';
  positionMs: number;   // song position at atServerMs
  atServerMs: number;
  rate: number;
}

/** Song position (ms) at server time `serverNow`. */
export function positionAt(p: PlaybackClock, serverNow: number): number {
  if (p.state !== 'playing') return p.positionMs;
  return p.positionMs + Math.max(0, serverNow - p.atServerMs) * p.rate;
}
