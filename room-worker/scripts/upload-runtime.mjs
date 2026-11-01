// Upload the ONNX Runtime WebAssembly files to R2 (they exceed the 25 MB static-asset limit).
// Usage: node scripts/upload-runtime.mjs [--local [--persist-to DIR]]
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
// the package doesn't export package.json; find it from the main entry (…/onnxruntime-web/dist/…)
const entry = require.resolve('onnxruntime-web', { paths: [join(import.meta.dirname, '..', '..', 'player')] });
const dist = dirname(entry);
const version = JSON.parse(readFileSync(join(dist, '..', 'package.json'), 'utf8')).version;
const files = readdirSync(dist).filter((f) => /^ort-wasm-simd-threaded(\.(jsep|asyncify|jspi))?\.(wasm|mjs)$/.test(f));
const args = process.argv.slice(2);
// --skip-if-live <site url>: do nothing when the site already serves this runtime version
const live = args.indexOf('--skip-if-live');
if (live >= 0) {
  const site = args.splice(live, 2)[1]?.replace(/\/$/, '');
  try {
    const r = await fetch(`${site}/api/runtime/${version}/ort-wasm-simd-threaded.wasm`, { method: 'HEAD' });
    if (r.ok) { console.log(`ONNX Runtime ${version} is already live on ${site}`); process.exit(0); }
  } catch { /* site not up yet: upload */ }
}
const extra = args;
const remote = !extra.includes('--local');
for (const f of files) {
  const key = `jojos-karaoke-library/runtime/${version}/${f}`;
  console.log(`↑ ${key}`);
  execFileSync('npx', ['wrangler', 'r2', 'object', 'put', key, '--file', join(dist, f),
    '--content-type', f.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', ...(remote ? ['--remote'] : []), ...extra],
  { stdio: ['ignore', 'ignore', 'inherit'], cwd: join(import.meta.dirname, '..') });
}
console.log(`uploaded ONNX Runtime ${version} (${files.length} files)`);
