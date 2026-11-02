import type { SongSummary } from '../../shared/protocol';
import type { Principal, TokenInfo } from './accounts';

export interface Env {
  ROOM: DurableObjectNamespace;
  ACCOUNTS: DurableObjectNamespace;
  LIBRARY: R2Bucket;
  ASSETS: Fetcher;
  MEDIA_SECRET?: string;
  SIGNUP_CODE?: string;
  /** Workers rate limiting bindings (optional: missing in tests means "no limit") */
  CREATE_LIMIT?: RateLimit;
  UPLOAD_LIMIT?: RateLimit;
  LOOKUP_LIMIT?: RateLimit;
}

/** Per-client limit for abuse-prone calls on a public site. */
export async function limit(rl: RateLimit | undefined, req: Request, what: string) {
  if (!rl) return;
  const ip = req.headers.get('cf-connecting-ip') ?? 'local';
  const { success } = await rl.limit({ key: `${what}:${ip}` });
  if (!success) throw new HttpError(429, 'too many requests, try again in a minute');
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(bytes = 24): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function randomId(): string {
  return randomToken(9);
}

export async function sha256(text: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function sign(secret: string, data: string): Promise<string> {
  return b64url(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data)));
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function bearer(req: Request, url?: URL): string | null {
  const h = req.headers.get('authorization');
  if (h?.startsWith('Bearer ')) return h.slice(7).trim();
  return url?.searchParams.get('token') ?? null;
}

const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function roomCode(len = 4): string {
  const r = crypto.getRandomValues(new Uint8Array(len));
  return [...r].map((x) => ROOM_ALPHABET[x % ROOM_ALPHABET.length]).join('');
}
export const ROOM_CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;

export const SONG_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
export const FILE_TYPES: Record<string, string> = {
  'instrumental.opus': 'audio/ogg',
  'vocals.opus': 'audio/ogg',
  'lyrics.json': 'application/json',
  'pitch.json': 'application/json',
  'cover.jpg': 'image/jpeg',
  'cover.png': 'image/png',
};
export const MAX_FILE_BYTES = 60 * 1024 * 1024;

export const libKey = (owner: string, song: string, file: string) => `lib/${owner}/${song}/${file}`;

/** Typed RPC surface of the Accounts DO (spelled out: the inferred stub type is too deep for tsc). */
export interface AccountsApi {
  createOwner(name: string): Promise<{ ownerId: string; token: string }>;
  createToken(ownerId: string, name: string, role?: 'owner' | 'contributor'): Promise<string>;
  auth(token: string): Promise<Principal | null>;
  listTokens(ownerId: string): Promise<TokenInfo[]>;
  revokeToken(ownerId: string, tokenId: string): Promise<boolean>;
  listSongs(ownerId: string): Promise<SongSummary[]>;
  getSong(ownerId: string, id: string): Promise<any | null>;
  putSong(ownerId: string, manifest: any): Promise<void>;
  deleteSong(ownerId: string, id: string): Promise<void>;
}

export const accountsOf = (env: Env): AccountsApi =>
  env.ACCOUNTS.get(env.ACCOUNTS.idFromName('global')) as unknown as AccountsApi;
