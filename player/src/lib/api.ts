import type { Lyrics } from '$shared/lyrics';
import type { SongSummary } from '$shared/protocol';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const TIMEOUT_MS = 20_000;

export async function api<T = any>(path: string, init: RequestInit & { token?: string | null; timeout?: number } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  if (init.body && typeof init.body === 'string') headers.set('content-type', 'application/json');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), init.timeout ?? TIMEOUT_MS);
  try {
    const r = await fetch(path, { ...init, headers, signal: ctl.signal });
    const body = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
    if (!r.ok) throw new ApiError(r.status, body?.error ?? r.statusText);
    return body as T;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw new ApiError(0, 'the server did not answer in time');
    if (e instanceof TypeError) throw new ApiError(0, 'no connection');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export interface Manifest {
  id: string; title: string; artist: string; durationMs: number; language?: string;
  offsetMs?: number; lyricsSource?: string; version?: number;
  files: { instrumental: string; vocals?: string; lyrics: string; pitch?: string; cover?: string };
}

export interface Media {
  manifest: Manifest;
  urls: { instrumental?: string; vocals?: string; lyrics: string; pitch?: string; cover?: string };
}

export const signUp = (name: string, signupCode?: string) =>
  api<{ ownerId: string; token: string }>('/api/accounts', { method: 'POST', body: JSON.stringify({ name, signupCode }) });
export const me = (token: string) => api<{ name: string; role: string; ownerName: string }>('/api/me', { token });
export const createRoom = (token: string | null, name?: string, signupCode?: string) =>
  api<{ code: string; adminToken: string; workerKey: string }>('/api/rooms', { method: 'POST', token, body: JSON.stringify({ name, signupCode }) });
export const roomInfo = (code: string) => api<{ code: string; ownerName: string }>(`/api/rooms/${code}/info`);
export const librarySongs = (token: string) => api<{ songs: SongSummary[] }>('/api/library/songs', { token });
export const deleteSong = (token: string, id: string) => api(`/api/library/songs/${id}`, { method: 'DELETE', token });
export const listTokens = (token: string) => api<{ tokens: { id: string; name: string; role: string; created: number }[] }>('/api/tokens', { token });
export const createToken = (token: string, name: string) => api<{ token: string }>('/api/tokens', { method: 'POST', token, body: JSON.stringify({ name }) });
export const revokeToken = (token: string, id: string) => api(`/api/tokens/${id}`, { method: 'DELETE', token });

export function songMedia(code: string, songId: string, cred: { admin?: string | null; member?: string | null }) {
  const q = cred.admin ? `admin=${encodeURIComponent(cred.admin)}` : `member=${encodeURIComponent(cred.member ?? '')}`;
  return api<Media>(`/api/rooms/${code}/songs/${songId}/media?${q}`);
}

export const saveLyrics = (code: string, songId: string, admin: string, lyrics: Lyrics, offsetMs?: number) =>
  api(`/api/rooms/${code}/songs/${songId}/lyrics?admin=${encodeURIComponent(admin)}`, {
    method: 'PUT', body: JSON.stringify({ lyrics, offsetMs }),
  });

export const uploadForRequest = (code: string, member: string, file: File) =>
  api<{ uploadId: string }>(`/api/rooms/${code}/uploads?member=${encodeURIComponent(member)}`, {
    method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream' }, timeout: 300_000,
  });

export async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new ApiError(r.status, 'could not load song data');
  return r.json();
}
