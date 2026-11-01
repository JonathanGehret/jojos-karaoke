// Songs stored on this device (IndexedDB). Each record is a complete package, so it can be
// played offline, edited, exported as .jkp or uploaded to the online library later.

import type { Lyrics } from '$shared/lyrics';
import type { SongSummary } from '$shared/protocol';
import type { Manifest } from './api';
import { type LocalPackage, readPackage, writePackage } from './jkp';

export interface StoredSong {
  id: string;
  manifest: Manifest & Record<string, unknown>;
  lyrics: Lyrics;
  files: Record<string, Blob>;     // instrumental.opus, vocals.opus, cover.jpg …
  addedAt: number;
  size: number;
}

const DB = 'jojos-karaoke';
const STORE = 'songs';
let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('storage is busy in another tab'));
  });
  return dbp;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then((d) => new Promise<T>((res, rej) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req.result);
    t.onerror = () => rej(t.error ?? req.error);
    t.onabort = () => rej(t.error ?? new Error('storage write aborted (is the device full?)'));
  }));
}

const listeners = new Set<() => void>();
export function onLibraryChange(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); }
const changed = () => { for (const l of listeners) l(); };

export function summary(s: StoredSong): SongSummary {
  return { id: s.id, title: s.manifest.title, artist: s.manifest.artist ?? '', durationMs: s.manifest.durationMs,
    hasVocals: !!s.manifest.files.vocals, hasPitch: false, ...(s.manifest.language ? { language: s.manifest.language } : {}) };
}

export async function listSongs(): Promise<StoredSong[]> {
  const all = await tx<StoredSong[]>('readonly', (s) => s.getAll() as IDBRequest<StoredSong[]>);
  return all.sort((a, b) => (a.manifest.artist + a.manifest.title).localeCompare(b.manifest.artist + b.manifest.title));
}

export const getSong = (id: string) => tx<StoredSong | undefined>('readonly', (s) => s.get(id) as IDBRequest<StoredSong | undefined>);
export const hasSong = async (id: string) => !!(await getSong(id));

export async function saveSong(manifest: any, lyrics: Lyrics, files: Record<string, Uint8Array | Blob>): Promise<StoredSong> {
  const blobs: Record<string, Blob> = {};
  let size = 0;
  for (const [n, d] of Object.entries(files)) {
    if (n === 'manifest.json' || n === 'lyrics.json') continue;
    const b = d instanceof Blob ? d : new Blob([d as BlobPart], { type: n.endsWith('.opus') ? 'audio/ogg' : 'application/octet-stream' });
    blobs[n] = b;
    size += b.size;
  }
  // plain copies: callers may pass reactive (proxied) objects, which IndexedDB can't clone
  const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));
  const rec: StoredSong = { id: manifest.id, manifest: plain(manifest), lyrics: plain(lyrics), files: blobs, addedAt: Date.now(), size };
  requestPersistence();
  await tx('readwrite', (s) => s.put(rec));
  changed();
  return rec;
}

export async function updateLyrics(id: string, lyrics: Lyrics, offsetMs?: number) {
  const s = await getSong(id);
  if (!s) throw new Error('song not found on this device');
  s.lyrics = JSON.parse(JSON.stringify(lyrics));
  if (offsetMs != null) s.manifest.offsetMs = offsetMs;
  if (s.manifest.lyricsSource === 'none' && lyrics.lines.length) s.manifest.lyricsSource = 'user';
  await tx('readwrite', (st) => st.put(s));
  changed();
}

export async function deleteSong(id: string) {
  await tx('readwrite', (s) => s.delete(id));
  changed();
}

export async function importJkp(bytes: Uint8Array): Promise<StoredSong> {
  const p = readPackage(bytes);
  return saveSong(p.manifest, p.lyrics, p.files);
}

export async function toPackage(s: StoredSong): Promise<LocalPackage> {
  const files: Record<string, Uint8Array> = {};
  for (const [n, b] of Object.entries(s.files)) files[n] = new Uint8Array(await b.arrayBuffer());
  return { manifest: s.manifest, lyrics: s.lyrics, pitch: null, files };
}

export async function exportJkp(s: StoredSong): Promise<Uint8Array> {
  return writePackage(await toPackage(s));
}

export function downloadBytes(bytes: Uint8Array, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/zip' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export const fileName = (m: { artist?: string; title: string }) =>
  `${[m.artist, m.title].filter(Boolean).join(' - ').replace(/[\\/:*?"<>|]+/g, '').slice(0, 80) || 'song'}.jkp`;

let persistAsked = false;
function requestPersistence() {
  if (persistAsked) return;
  persistAsked = true;
  navigator.storage?.persist?.().catch(() => {});
}

export async function storageInfo(): Promise<{ used: number; quota: number; persisted: boolean } | null> {
  try {
    const e = await navigator.storage.estimate();
    return { used: e.usage ?? 0, quota: e.quota ?? 0, persisted: (await navigator.storage.persisted?.()) ?? false };
  } catch { return null; }
}
