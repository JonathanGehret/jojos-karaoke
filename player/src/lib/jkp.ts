// Open a local .jkp package (zip) in the browser: for solo play and the editor.

import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import type { Lyrics } from '$shared/lyrics';
import type { Manifest } from './api';

export interface LocalPackage {
  manifest: Manifest;
  lyrics: Lyrics;
  pitch: { hopMs: number; midi: (number | null)[] } | null;
  files: Record<string, Uint8Array>;
}

export function readPackage(bytes: Uint8Array): LocalPackage {
  const files = unzipSync(bytes);
  const need = (n: string) => {
    if (!files[n]) throw new Error(`not a karaoke package: ${n} is missing`);
    return files[n];
  };
  const manifest = JSON.parse(strFromU8(need('manifest.json'))) as Manifest;
  if ((manifest as any).formatVersion !== 1) throw new Error('unsupported package version');
  const lyrics = JSON.parse(strFromU8(need('lyrics.json'))) as Lyrics;
  const pitch = files['pitch.json'] ? JSON.parse(strFromU8(files['pitch.json'])) : null;
  need(manifest.files.instrumental);
  return { manifest, lyrics, pitch, files };
}

export function writePackage(pkg: LocalPackage): Uint8Array {
  const out: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};
  for (const [n, data] of Object.entries(pkg.files)) {
    if (n === 'manifest.json' || n === 'lyrics.json') continue;
    out[n] = n.endsWith('.json') ? data : [data, { level: 0 }];
  }
  out['manifest.json'] = strToU8(JSON.stringify(pkg.manifest, null, 1));
  out['lyrics.json'] = strToU8(JSON.stringify(pkg.lyrics));
  return zipSync(out as any);
}

export function bufferOf(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}
