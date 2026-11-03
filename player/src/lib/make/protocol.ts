// Messages between the page and make.worker.ts.
import type { MdxConfig } from './mdx';
import type { TimedWord } from './align';

export type ToWorker =
  | { id: number; type: 'separate'; left: Float32Array; right: Float32Array; modelUrl: string; config: MdxConfig; parts?: boolean }
  | { id: number; type: 'transcribe'; audio: Float32Array; model: string; language?: string }
  | { id: number; type: 'align'; audio: Float32Array; model: string; tokens: string[] };

export type FromWorker =
  | { id: number; type: 'progress'; stage: 'download' | 'load' | 'separate' | 'transcribe'; frac: number; detail?: string }
  // with `parts`: samples [from, from + length) of the result are final (sent while separating)
  | { id: number; type: 'part'; from: number; instL: Float32Array; instR: Float32Array; vocL: Float32Array; vocR: Float32Array }
  | { id: number; type: 'separated'; instL: Float32Array; instR: Float32Array; vocL: Float32Array; vocR: Float32Array; backend: string }
  | { id: number; type: 'transcribed'; words: TimedWord[]; language?: string; backend: string }
  // one entry per token (ms); null where the token has no letters the model knows
  | { id: number; type: 'aligned'; words: ({ start: number; end: number; score: number } | null)[]; backend: string }
  | { id: number; type: 'error'; message: string };
