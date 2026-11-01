// Room WebSocket protocol. Source of truth for player and room-worker; spec/protocol.md
// documents it for humans.

import type { PlaybackClock } from './clock';
import type { Lyrics } from './lyrics';

export type Role = 'screen' | 'admin' | 'guest' | 'worker';

export interface Member { id: string; nickname: string; role: Role; online: boolean }

export interface SongSummary {
  id: string; title: string; artist: string; durationMs: number;
  hasVocals: boolean; hasPitch: boolean; language?: string;
  /** 'screen': stored on the host screen's device; 'online': in the owner's online library */
  where?: 'screen' | 'online';
}

export type QueueStatus = 'ready' | 'processing' | 'failed';

export interface QueueItem {
  id: string;
  memberId: string;
  nickname: string;
  songId: string | null;          // null while an on-the-spot request is processing
  title: string;
  artist: string;
  status: QueueStatus;
  jobId?: string;
  progress?: { stage: string; pct: number; etaS?: number };
  error?: string;
  /** a request's finished package is waiting in the room (screen imports it; the requester can download it) */
  hasResult?: boolean;
}

export interface Job {
  id: string;
  queueItemId: string;
  uploadId: string;
  title: string;
  artist: string;
  lyrics?: string;               // optional lyrics the guest pasted
  state: 'waiting' | 'claimed' | 'done' | 'failed';
  workerId?: string;
  claimedAt?: number;
}

export interface Playback extends PlaybackClock {
  queueItemId: string | null;
  songId: string | null;
  key: number;                    // semitones
  vocal: number;                  // guide vocal 0..1
}

export interface RoomSettings { fair: boolean; maxPerPerson: number }

export interface RoomState {
  code: string;
  members: Member[];
  queue: QueueItem[];             // queue[0] is up next (current song is in nowPlaying)
  nowPlaying: QueueItem | null;
  playback: Playback;
  settings: RoomSettings;
  workersOnline: number;
}

// ---- client → server
export type ClientMsg =
  | { type: 'ping'; c: number }
  | { type: 'queue.add'; songId: string }
  | { type: 'queue.remove'; itemId: string }
  | { type: 'queue.move'; itemId: string; to: number }            // admin
  | { type: 'queue.playNext'; itemId: string }                    // admin
  | { type: 'request.add'; title: string; artist: string; uploadId: string; lyrics?: string }
  | { type: 'control'; action: 'play' | 'pause' | 'skip' | 'restart' | 'seek'; positionMs?: number } // admin → screen
  | { type: 'control.set'; key?: number; vocal?: number; rate?: number }                          // admin → screen
  | { type: 'playback'; playback: Playback }                       // screen
  | { type: 'advance' }                                            // screen: song ended, start next
  | { type: 'settings'; settings: Partial<RoomSettings> }          // admin
  | { type: 'kick'; memberId: string }                             // admin
  | { type: 'react'; emoji: string }
  | { type: 'job.claim' }                                          // worker
  | { type: 'job.progress'; jobId: string; stage: string; pct: number; etaS?: number }
  | { type: 'job.done'; jobId: string; songId: string }               // after POST …/results/{jobId} or a library upload
  | { type: 'screen.library'; songs: SongSummary[] }                 // screen: songs stored on its device
  | { type: 'lyrics'; queueItemId: string; lyrics: Lyrics }           // screen: lyrics of the song now playing
  | { type: 'job.failed'; jobId: string; error: string };

// ---- server → client
export type ServerMsg =
  | { type: 'welcome'; you: Member; state: RoomState }
  | { type: 'pong'; c: number; s: number }
  | { type: 'state'; state: RoomState }
  | { type: 'playback'; playback: Playback }
  | { type: 'control'; action: 'play' | 'pause' | 'skip' | 'restart' | 'seek'; positionMs?: number }
  | { type: 'control.set'; key?: number; vocal?: number; rate?: number }
  | { type: 'library'; songs: SongSummary[] }
  | { type: 'lyrics'; queueItemId: string; lyrics: Lyrics }
  | { type: 'react'; emoji: string; nickname: string }
  | { type: 'job'; job: Job | null }
  | { type: 'error'; message: string }
  | { type: 'kicked' };

export const REACTIONS = ['👏', '🔥', '😂', '❤️', '🎤', '🤩'] as const;

export const LIMITS = {
  nickname: 24,
  title: 120,
  lyrics: 20_000,
  uploadBytes: 60 * 1024 * 1024,
  reactionsPerMinute: 30,
  queuePerPersonDefault: 3,
  jobClaimTimeoutMs: 15 * 60 * 1000,
  roomIdleMs: 12 * 60 * 60 * 1000,
  resultBytes: 120 * 1024 * 1024,
  screenSongs: 5000,
  lyricsMsgBytes: 512 * 1024,
} as const;

export function cleanNickname(s: unknown): string {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, LIMITS.nickname);
}
