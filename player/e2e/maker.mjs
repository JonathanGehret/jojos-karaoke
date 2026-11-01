// End-to-end for the in-browser maker (#26): real Worker + R2 (wrangler dev), real ONNX Runtime
// Web (WebAssembly in headless Chromium) and real WebCodecs Opus encoding. The separation
// network is a tiny stand-in with the same input/output shape (fixtures/scale.onnx), so the
// test is fast; set JOJO_E2E_REAL_MODEL=1 to use the real UVR model through /api/models.
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const strict = process.env.JOJO_E2E_STRICT === '1';
const realModel = process.env.JOJO_E2E_REAL_MODEL === '1';
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log(strict ? 'FAIL: playwright missing' : 'SKIP: playwright not installed');
  process.exit(strict ? 1 : 0);
}

const workerDir = join(here, '..', '..', 'room-worker');
const dist = join(here, '..', 'dist');
const tmp = mkdtempSync(join(tmpdir(), 'jojo-maker-e2e-'));
const state = join(tmp, 'state');
mkdirSync(join(dist, 'test-models'), { recursive: true });
copyFileSync(join(here, 'fixtures', 'scale.onnx'), join(dist, 'test-models', 'scale.onnx'));

// a generated stereo "song": two tones, 8 s (no real music in tests)
const song = join(tmp, 'Nobody - Webmade.wav');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=8', '-f', 'lavfi',
  '-i', 'sine=frequency=330:duration=8', '-filter_complex', '[0][1]amerge=inputs=2', '-ac', '2', song]);
const req = join(tmp, 'Nobody - Requested.wav');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=262:duration=6', '-ac', '2', req]);

console.log('uploading ONNX Runtime to local R2…');
execFileSync('node', ['scripts/upload-runtime.mjs', '--local', '--persist-to', state], { cwd: workerDir, stdio: 'inherit' });

const port = 9000 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const wr = spawn('npx', ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--var', 'MEDIA_SECRET:e2e',
  '--persist-to', state, '--show-interactive-dev-session=false'],
{ cwd: workerDir, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
wr.stdout.on('data', (d) => (log += d));
wr.stderr.on('data', (d) => (log += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) failures++; };
async function api(path, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + path, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body && JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.headers.get('content-type')?.includes('json') ? r.json() : Buffer.from(await r.arrayBuffer());
}
const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,channels,sample_rate', '-of', 'json', file]).toString());

let browser;
let page;
let errors = [];
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(base + '/api/me')).status === 401) break; } catch { /* starting */ }
    if (i > 180) throw new Error(`wrangler did not start\n${log.slice(-2000)}`);
    await sleep(500);
  }
  const { token } = await api('/api/accounts', { method: 'POST', body: { name: 'Host' } });
  const rt = await fetch(`${base}/api/runtime/x/ort-wasm-simd-threaded.wasm`);
  check(rt.status === 404, 'runtime route only serves uploaded versions');

  browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addInitScript((t) => localStorage.setItem('jk.ownerToken', JSON.stringify(t)), token);
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  if (process.env.JOJO_E2E_DEBUG) {
    page.on('worker', (w) => { console.log('worker started', w.url()); w.on('close', () => console.log('worker closed')); });
    page.on('requestfailed', (r) => console.log('request failed', r.url(), r.failure()?.errorText));
    page.on('response', (r) => r.url().includes('/api/') && console.log('response', r.status(), r.url().slice(0, 120)));
    ctx.on('console', (m) => console.log('console', m.type(), m.text().slice(0, 300)));
  }
  const modelParam = realModel ? '' : 'model=/test-models/scale.onnx&';
  await page.goto(`${base}/make?${modelParam}asr=off`);
  check(await page.evaluate(() => crossOriginIsolated), 'page is cross-origin isolated (multi-threaded WebAssembly)');
  await page.locator('input[type=file]').first().setInputFiles(song);
  check(await page.getByPlaceholder('Title').inputValue() === 'Webmade', 'title guessed from the file name');
  await page.getByPlaceholder(/Lyrics \(optional/).fill('la la\nlo lo');
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Make karaoke' }).click();
  await page.getByText('Added to your library').waitFor({ timeout: realModel ? 900_000 : Number(process.env.JOJO_E2E_MAKE_TIMEOUT || 180_000) });
  check(true, `song made and uploaded in the browser (${Math.round((Date.now() - t0) / 1000)} s)`);
  const backend = await page.evaluate(() => document.body.innerText.includes('No WebGPU') ? 'wasm' : 'webgpu');
  console.log(`  backend: ${backend}`);

  const lib = await api('/api/library/songs', { token });
  const made = lib.songs.find((s) => s.title === 'Webmade');
  check(!!made && made.artist === 'Nobody' && made.hasVocals, 'library has the song with a vocal stem');
  check(Math.abs(made.durationMs - 8000) < 100, `duration ${made?.durationMs} ms`);

  // download what was uploaded and check it with ffprobe
  const { code, adminToken } = await api('/api/rooms', { method: 'POST', token });
  const media = await api(`/api/rooms/${code}/songs/${made.id}/media?admin=${adminToken}`);
  for (const stem of ['instrumental', 'vocals']) {
    const f = join(tmp, `${stem}.opus`);
    writeFileSync(f, await api(media.urls[stem].replace(/^https?:\/\/[^/]+/, '')));
    const p = probe(f);
    const s = p.streams[0];
    check(s.codec_name === 'opus' && s.channels === 2 && Math.abs(+p.format.duration - 8) < 0.1,
      `${stem}.opus is valid Ogg Opus, stereo, ${(+p.format.duration).toFixed(2)} s`);
    execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'null', '-']); // decodes without errors
  }
  const lyrics = await api(media.urls.lyrics.replace(/^https?:\/\/[^/]+/, ''));
  check(lyrics.lines.map((l) => l.words.map((w) => w.t).join(' ')).join('|') === 'la la|lo lo', 'lyrics stored with timing');

  // preview plays in the page
  await page.getByRole('button', { name: /Preview/ }).click();
  await sleep(1500);
  check(await page.locator('.lyrics .w').count() > 0, 'preview shows the lyrics');

  // help at a party: a guest's request is made in this browser tab
  const guest = await (await browser.newContext()).newPage();
  await guest.goto(`${base}/join/${code}`);
  await guest.getByPlaceholder('Nickname').fill('Ann');
  await guest.getByRole('button', { name: 'Join' }).click();
  await guest.getByRole('button', { name: 'Request' }).click();
  await guest.locator('input[type=file]').setInputFiles(req);
  await guest.getByRole('button', { name: 'Request song' }).click();
  await guest.getByText(/making…/).waitFor({ timeout: 10000 });
  await page.getByPlaceholder('Room code').fill(code);
  await page.getByRole('button', { name: 'Start' }).click();
  await guest.locator('.queue li', { hasText: 'Requested' }).filter({ hasNotText: 'making' }).waitFor({ timeout: realModel ? 900_000 : 180_000 });
  check(true, 'guest request was made by the browser and is ready in the queue');
  check((await api('/api/library/songs', { token })).songs.some((s) => s.title === 'Requested'), 'requested song is in the library');

  // the lyrics lookup proxy needs a library token and fails soft without internet
  check((await fetch(`${base}/api/lyrics?title=x`)).status === 401, 'lyrics lookup requires a token');
  const ly = await api('/api/lyrics?title=Nothing&artist=Nobody&duration=10', { token });
  check('synced' in ly && 'plain' in ly, 'lyrics lookup answers even when LRCLIB is unreachable');

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
} catch (e) {
  console.error(e.message?.split('\n')[0] ?? e);
  if (page) console.error('--- page ---\n' + (await page.locator('main').innerText().catch(() => '?')).slice(0, 1500));
  if (errors.length) console.error('--- errors ---\n' + errors.join('\n'));
  failures++;
} finally {
  await browser?.close();
  try { process.kill(-wr.pid, 'SIGTERM'); } catch { /* gone */ }
  rmSync(join(dist, 'test-models'), { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall browser-maker checks passed');
process.exit(failures ? 1 : 0);
