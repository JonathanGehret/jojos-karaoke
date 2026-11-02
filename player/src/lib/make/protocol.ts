// Messages between the page and make.worker.ts.
import type { MdxConfig } from './mdx';
import type { TimedWord } from './align';

export type ToWorker =
  | { id: number; type: 'separate'; left: Float32Array; right: Float32Array; modelUrl: string; config: MdxConfig }
  | { id: number; type: 'transcribe'; audio: Float32Array; model: string; language?: string };

export type FromWorker =
  | { id: number; type: 'progress'; stage: 'download' | 'load' | 'separate' | 'transcribe'; frac: number; detail?: string }
  | { id: number; type: 'separated'; instL: Float32Array; instR: Float32Array; vocL: Float32Array; vocR: Float32Array; backend: string }
  | { id: number; type: 'transcribed'; words: TimedWord[]; language?: string; backend: string }
  | { id: number; type: 'error'; message: string };
