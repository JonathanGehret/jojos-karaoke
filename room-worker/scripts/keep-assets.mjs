// Before a deploy: copy the app files that are live now (hashed names under /assets/) to R2, so
// tabs still running this version keep working after the deploy replaces them. Without this,
// an open host screen asks for its old song-maker file and gets the start page back instead.
// Usage: node scripts/keep-assets.mjs <site url> [--local [--persist-to DIR]]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const [arg, ...rest] = process.argv.slice(2);
const site = arg && !arg.startsWith('--') ? arg : process.env.SITE_URL;
if (arg?.startsWith('--')) rest.unshift(arg);
if (!site) { console.log('keep-assets: no site url, nothing to keep'); process.exit(0); }
const base = site.replace(/\/$/, '');
const remote = !rest.includes('--local');
const require = createRequire(import.meta.url);
const pkg = require.resolve('wrangler/package.json', { paths: [join(import.meta.dirname, '..')] });
const wrangler = join(dirname(pkg), JSON.parse(readFileSync(pkg, 'utf8')).bin.wrangler);
const ASSET = /\/?assets\/([\w.-]+\.(?:js|css|woff2|wasm|svg|png))/g;
const SIBLING = /["'`]\.\/([\w.-]+\.(?:js|css|wasm))["'`]/g;
const TYPES = { js: 'text/javascript', css: 'text/css', woff2: 'font/woff2', wasm: 'application/wasm', svg: 'image/svg+xml', png: 'image/png' };

let html;
try {
  const r = await fetch(`${base}/`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(String(r.status));
  html = await r.text();
} catch (e) { console.log(`keep-assets: site not reachable (${e.message}), nothing to keep`); process.exit(0); }

// the page's files, and the files those load (the song maker and its chunks)
const names = new Set([...html.matchAll(ASSET)].map((m) => m[1]));
const files = new Map();
const queue = [...names];
while (queue.length) {
  const name = queue.shift();
  const r = await fetch(`${base}/assets/${name}`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok || (r.headers.get('content-type') ?? '').includes('text/html')) continue;
  const body = Buffer.from(await r.arrayBuffer());
  files.set(name, body);
  if (/\.(js|css)$/.test(name)) {
    const text = body.toString('utf8');
    // "assets/x.js" from the page, "./x.js" between files in assets/ (the maker's own chunks)
    for (const m of [...text.matchAll(ASSET), ...text.matchAll(SIBLING)]) if (!names.has(m[1])) { names.add(m[1]); queue.push(m[1]); }
  }
}
const tmp = mkdtempSync(join(tmpdir(), 'jojo-assets-'));
try {
  for (const [name, body] of files) {
    const f = join(tmp, name);
    writeFileSync(f, body);
    execFileSync(process.execPath, [wrangler, 'r2', 'object', 'put', `jojos-karaoke-library/app-assets/${name}`, '--file', f,
      '--content-type', TYPES[name.split('.').pop()] ?? 'application/octet-stream', ...(remote ? ['--remote'] : []), ...rest],
    { stdio: ['ignore', 'ignore', 'inherit'], cwd: join(import.meta.dirname, '..') });
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }
console.log(`kept ${files.size} live app files in R2 (${[...files.keys()].join(', ')})`);
