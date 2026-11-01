// Library accounts, maker tokens and the song index. One instance ("global"); SQLite-backed.

import { DurableObject } from 'cloudflare:workers';
import type { SongSummary } from '../../shared/protocol';
import { Env, randomId, randomToken, sha256 } from './util';

export interface Principal { ownerId: string; ownerName: string; role: 'owner' | 'contributor'; tokenId: string; name: string }
export interface TokenInfo { id: string; name: string; role: string; created: number }

export function summarize(m: any): SongSummary {
  return {
    id: m.id, title: m.title, artist: m.artist ?? '', durationMs: m.durationMs,
    hasVocals: !!m.files?.vocals, hasPitch: !!m.files?.pitch, language: m.language,
  };
}

export class Accounts extends DurableObject<Env> {
  sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS owners (id TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, id TEXT NOT NULL, owner_id TEXT NOT NULL,
        role TEXT NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS songs (owner_id TEXT NOT NULL, id TEXT NOT NULL, manifest TEXT NOT NULL,
        updated INTEGER NOT NULL, PRIMARY KEY (owner_id, id));
    `);
  }

  async createOwner(name: string): Promise<{ ownerId: string; token: string }> {
    const ownerId = randomId().toLowerCase().replace(/[^a-z0-9]/g, 'x');
    this.sql.exec('INSERT INTO owners VALUES (?, ?, ?)', ownerId, name, Date.now());
    const token = await this.createToken(ownerId, name, 'owner');
    return { ownerId, token };
  }

  async createToken(ownerId: string, name: string, role: 'owner' | 'contributor' = 'contributor'): Promise<string> {
    const token = `jk_${randomToken(24)}`;
    this.sql.exec('INSERT INTO tokens VALUES (?, ?, ?, ?, ?, ?)', await sha256(token), randomId(), ownerId, role,
      name, Date.now());
    return token;
  }

  async auth(token: string): Promise<Principal | null> {
    const rows = this.sql.exec<any>(
      `SELECT t.id, t.owner_id, t.role, t.name, o.name AS owner_name FROM tokens t
       JOIN owners o ON o.id = t.owner_id WHERE t.hash = ?`, await sha256(token)).toArray();
    const r = rows[0];
    return r ? { ownerId: r.owner_id, ownerName: r.owner_name, role: r.role, tokenId: r.id, name: r.name } : null;
  }

  listTokens(ownerId: string): TokenInfo[] {
    return this.sql.exec<any>('SELECT id, name, role, created FROM tokens WHERE owner_id = ? ORDER BY created',
      ownerId).toArray();
  }

  revokeToken(ownerId: string, tokenId: string): boolean {
    const c = this.sql.exec("DELETE FROM tokens WHERE owner_id = ? AND id = ? AND role = 'contributor'",
      ownerId, tokenId);
    return c.rowsWritten > 0;
  }

  listSongs(ownerId: string): SongSummary[] {
    return this.sql.exec<any>('SELECT manifest FROM songs WHERE owner_id = ?', ownerId).toArray()
      .map((r) => summarize(JSON.parse(r.manifest)))
      .sort((a, b) => (a.artist + a.title).localeCompare(b.artist + b.title));
  }

  getSong(ownerId: string, id: string): any | null {
    const r = this.sql.exec<any>('SELECT manifest FROM songs WHERE owner_id = ? AND id = ?', ownerId, id).toArray()[0];
    return r ? JSON.parse(r.manifest) : null;
  }

  putSong(ownerId: string, manifest: any): void {
    this.sql.exec('INSERT OR REPLACE INTO songs VALUES (?, ?, ?, ?)', ownerId, manifest.id,
      JSON.stringify(manifest), Date.now());
  }

  deleteSong(ownerId: string, id: string): void {
    this.sql.exec('DELETE FROM songs WHERE owner_id = ? AND id = ?', ownerId, id);
  }
}
