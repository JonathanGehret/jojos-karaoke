// End-to-end for the in-browser maker (#26): real Worker + R2 (wrangler dev), real ONNX Runtime
// Web (WebAssembly in headless Chromium) and real WebCodecs Opus encoding. The separation
// network is a tiny stand-in with the same input/output shape (fixtures/scale.onnx), so the
// test is fast; set JOJO_E2E_REAL_MODEL=1 to use the real UVR model through /api/models.
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
// run wrangler through node: spawning `npx` directly fails on Windows (it's a .cmd)
const wranglerPkg = createRequire(import.meta.url).resolve('wrangler/package.json', { paths: [join(here, '..', '..', 'room-worker')] });
const wrangler = join(dirname(wranglerPkg), JSON.parse(readFileSync(wranglerPkg, 'utf8')).bin.wrangler);
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
execFileSync(process.execPath, ['scripts/upload-runtime.mjs', '--local', '--persist-to', state], { cwd: workerDir, stdio: 'inherit' });

const port = 9000 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const wr = spawn(process.execPath, [wrangler, 'dev', '--port', String(port), '--ip', '127.0.0.1', '--var', 'MEDIA_SECRET:e2e',
  '--persist-to', state, '--show-interactive-dev-session=false'],
{ cwd: workerDir, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
wr.stdout.on('data', (d) => (log += d));
wr.stderr.on('data', (d) => (log += d));

// stop the dev server and its children: a process group on POSIX, taskkill /T on Windows
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
  else { try { process.kill(-pid, 'SIGTERM'); } catch { /* gone */ } }
}
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

  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  // the host's laptop: no account, songs live in this browser
  const ctx = await browser.newContext({ acceptDownloads: true });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  if (process.env.JOJO_E2E_DEBUG) {
    page.on('requestfailed', (r) => console.log('request failed', r.url(), r.failure()?.errorText));
    ctx.on('console', (m) => console.log('console', m.type(), m.text().slice(0, 300)));
  }
  const modelParam = realModel ? '' : 'model=/test-models/scale.onnx&';
  await page.goto(`${base}/make?${modelParam}asr=off`);
  check(await page.evaluate(() => crossOriginIsolated), 'page is cross-origin isolated (multi-threaded WebAssembly)');
  await page.locator('input[type=file]').first().setInputFiles(song);
  check(await page.getByPlaceholder('Title').inputValue() === 'Webmade', 'title guessed from the file name');
  await page.getByRole('button', { name: 'Paste lyrics yourself' }).click();
  await page.getByLabel('Lyrics text').fill('la la\nlo lo');
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Make karaoke' }).click();
  await page.getByText('Saved on this device').waitFor({ timeout: realModel ? 900_000 : Number(process.env.JOJO_E2E_MAKE_TIMEOUT || 180_000) });
  check(true, `song made in the browser and saved on the device (${Math.round((Date.now() - t0) / 1000)} s)`);

  // download the .jkp and check it
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download .jkp' }).click()]);
  const jkp = join(tmp, 'made.jkp');
  await dl.saveAs(jkp);
  check(dl.suggestedFilename() === 'Nobody - Webmade.jkp', `download named "${dl.suggestedFilename()}"`);
  const { unzipSync, strFromU8 } = await import('fflate');
  const z = unzipSync(new Uint8Array(readFileSync(jkp)));
  const manifest = JSON.parse(strFromU8(z['manifest.json']));
  check(manifest.title === 'Webmade' && manifest.artist === 'Nobody' && Math.abs(manifest.durationMs - 8000) < 100, 'package manifest');
  for (const stem of ['instrumental', 'vocals']) {
    const f = join(tmp, `${stem}.opus`);
    writeFileSync(f, z[`${stem}.opus`]);
    const p = probe(f);
    check(p.streams[0].codec_name === 'opus' && p.streams[0].channels === 2 && Math.abs(+p.format.duration - 8) < 0.1,
      `${stem}.opus is valid Ogg Opus, stereo, ${(+p.format.duration).toFixed(2)} s`);
    execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'null', '-']);
  }
  const lyrics = JSON.parse(strFromU8(z['lyrics.json']));
  check(lyrics.lines.map((l) => l.words.map((w) => w.t).join(' ')).join('|') === 'la la|lo lo', 'lyrics stored with timing');

  // My songs lists it after a reload (IndexedDB)
  await page.goto(`${base}/songs`);
  await page.getByText('Webmade').waitFor({ timeout: 5000 });
  check(true, 'song is listed in My songs after a reload');

  // host a party without an account: the screen offers its device songs
  await page.goto(`${base}/`);
  await page.getByRole('button', { name: /Host a party/ }).click();
  await page.waitForURL(/\/screen\/[A-Z0-9]{4}$/);
  const code = page.url().split('/').pop();
  await page.getByRole('button', { name: /Start the party/ }).click();
  check(true, `party ${code} started without an account`);

  const gctx = await browser.newContext({ acceptDownloads: true });
  const guest = await gctx.newPage();
  guest.on('pageerror', (e) => errors.push(`guest: ${e.message}`));
  await guest.goto(`${base}/join/${code}`);
  await guest.getByPlaceholder('Nickname').fill('Ann');
  await guest.getByRole('button', { name: 'Join' }).click();
  await guest.getByRole('button', { name: /Webmade/ }).waitFor({ timeout: 10000 });
  check(true, "guest sees the screen device's songs");
  await guest.getByRole('button', { name: /Webmade/ }).click();
  await page.locator('.lyrics .w').first().waitFor({ timeout: 20000 });
  await guest.locator('.lyrics .w').first().waitFor({ timeout: 10000 });
  check(true, 'song plays from the device; guest gets the lyrics from the screen');
  await page.keyboard.press('n'); // skip

  // a guest's request is made by a helper tab with the room's helper key
  const key = await page.evaluate((c) => JSON.parse(localStorage.getItem('jk.worker'))[c], code);
  check(/^wk_/.test(key ?? ''), 'room has a helper key');
  await guest.getByRole('button', { name: 'Request' }).click();
  await guest.locator('input[type=file]').setInputFiles(req);
  await guest.getByRole('button', { name: 'Request song' }).click();
  await guest.getByText(/making…/).waitFor({ timeout: 10000 });
  const helper = await (await browser.newContext()).newPage();
  helper.on('pageerror', (e) => errors.push(`helper: ${e.message}`));
  await helper.goto(`${base}/make?${modelParam}asr=off&room=${code}#key=${key}`);
  await helper.getByRole('button', { name: 'Start' }).click();
  await guest.getByText(/Your karaoke version of/).waitFor({ timeout: realModel ? 900_000 : 180_000 });
  check(true, 'the request was made by the helper and is ready');
  const [gdl] = await Promise.all([guest.waitForEvent('download'), guest.getByRole('button', { name: 'Download .jkp' }).click()]);
  const gjkp = join(tmp, 'mine.jkp');
  await gdl.saveAs(gjkp);
  const gm = JSON.parse(strFromU8(unzipSync(new Uint8Array(readFileSync(gjkp)))['manifest.json']));
  check(gm.title === 'Requested', 'the requester downloaded their karaoke version');
  await guest.getByRole('button', { name: 'Save in My songs' }).click();
  await guest.getByText('Saved in My songs on this phone').waitFor({ timeout: 5000 });
  check(true, 'the requester saved it in My songs on their phone');
  // the screen imported it into its own songs
  const hostHas = await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('jojos-karaoke');
    r.onsuccess = () => { const g = r.result.transaction('songs').objectStore('songs').getAll(); g.onsuccess = () => res(g.result.map((x) => x.manifest.title)); };
  }));
  check(hostHas.includes('Requested'), `screen device now has: ${hostHas.join(', ')}`);

  // the lyrics lookup proxy works without an account (device-first) and fails soft without internet
  check((await fetch(`${base}/api/lyrics?title=x`)).status === 200, 'lyrics lookup works without a token');
  const ly = await api('/api/lyrics?title=Nothing&artist=Nobody&duration=10');
  check('synced' in ly && 'plain' in ly, 'lyrics lookup answers even when LRCLIB is unreachable');

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
} catch (e) {
  console.error(e.message?.split('\n')[0] ?? e);
  if (page) console.error('--- page ---\n' + (await page.locator('main').innerText().catch(() => '?')).slice(0, 1500));
  if (errors.length) console.error('--- errors ---\n' + errors.join('\n'));
  failures++;
} finally {
  await browser?.close();
  killTree(wr.pid);
  rmSync(join(dist, 'test-models'), { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall browser-maker checks passed');
process.exit(failures ? 1 : 0);
