// End-to-end: real Worker (wrangler dev) + built PWA + headless Chromium.
// A host screen and a guest phone join one room; the guest queues a song, the screen plays
// it, and the guest's lyrics must track the screen's within a small tolerance.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
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

let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.log(strict ? 'FAIL: playwright missing' : 'SKIP: playwright not installed');
  process.exit(strict ? 1 : 0);
}

const tmp = mkdtempSync(join(tmpdir(), 'jojo-e2e-'));
const audio = join(tmp, 'tone.opus');
// 20 s generated tone stands in for an instrumental (no real music in tests)
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=20', '-c:a', 'libopus', audio]);

const port = 8900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const wr = spawn(process.execPath, [wrangler, 'dev', '--port', String(port), '--ip', '127.0.0.1', '--var', 'MEDIA_SECRET:e2e',
  '--persist-to', join(tmp, 'state'), '--show-interactive-dev-session=false'],
  { cwd: join(here, '..', '..', 'room-worker'), env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function api(path, { method = 'GET', body, token, raw } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(base + path, { method, headers, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

let browser;
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(base + '/api/me')).status === 401) break; } catch { /* starting */ }
    if (i > 180) throw new Error(`wrangler did not start\n${log.slice(-2000)}`);
    await sleep(500);
  }

  const { token } = await api('/api/accounts', { method: 'POST', body: { name: 'Host' } });
  const sid = 'nobody-tone-e2e123';
  const lyrics = { version: 1, lines: [
    { start: 1000, end: 4000, words: [{ t: 'la', s: 1000, e: 2000 }, { t: 'lo', s: 2000, e: 4000 }] },
    { start: 4500, end: 9000, words: [{ t: 'li', s: 4500, e: 6000 }, { t: 'lu', s: 6000, e: 9000 }] },
    { start: 9500, end: 18000, words: [{ t: 'na', s: 9500, e: 13000 }, { t: 'no', s: 13000, e: 18000 }] },
  ] };
  await api(`/api/library/songs/${sid}/files/instrumental.opus`, { method: 'PUT', token, raw: readFileSync(audio) });
  await api(`/api/library/songs/${sid}/files/lyrics.json`, { method: 'PUT', token, raw: JSON.stringify(lyrics) });
  await api(`/api/library/songs/${sid}/commit`, { method: 'POST', token, body: { formatVersion: 1, id: sid, title: 'Test Tone',
    artist: 'Nobody', durationMs: 20000, files: { instrumental: 'instrumental.opus', lyrics: 'lyrics.json' } } });
  const { code, adminToken } = await api('/api/rooms', { method: 'POST', token });

  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

  // host screen
  const hostCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await hostCtx.addInitScript(([c, t]) => localStorage.setItem('jk.admin', JSON.stringify({ [c]: t })), [code, adminToken]);
  const screen = await hostCtx.newPage();
  const errors = [];
  screen.on('pageerror', (e) => errors.push(`screen: ${e.message}`));
  await screen.goto(`${base}/screen/${code}`);
  await screen.getByRole('button', { name: /Start the party/ }).click();
  await screen.getByRole('heading', { name: 'Pick a song!' }).waitFor({ timeout: 10000 });
  check(true, 'screen started and waits for songs');

  // guest phone
  const guestCtx = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
  const guest = await guestCtx.newPage();
  guest.on('pageerror', (e) => errors.push(`guest: ${e.message}`));
  await guest.goto(`${base}/join/${code}`);
  await guest.getByPlaceholder('Nickname').fill('Ann');
  await guest.getByRole('button', { name: 'Join' }).click();
  await guest.getByText('Test Tone').first().waitFor({ timeout: 10000 });
  check(true, 'guest joined and sees the library');
  await guest.getByRole('button', { name: /Test Tone/ }).tap();

  await screen.getByText('Up next').waitFor({ timeout: 10000 });
  check(await screen.getByRole('heading', { name: 'Ann' }).isVisible(), 'screen shows "Up next: Ann"');

  await screen.locator('.lyrics .w').first().waitFor({ timeout: 15000 });
  await guest.locator('.lyrics .w').first().waitFor({ timeout: 10000 });
  check(true, 'lyrics showing on screen and phone');
  check(await guest.getByText(/Your turn/).isVisible(), 'singer sees "Your turn" on their phone');
  await sleep(2500);

  // sync: compare both clocks at (nearly) the same instant
  const diffs = [];
  for (let i = 0; i < 8; i++) {
    const [a, b] = await Promise.all([
      screen.evaluate(() => ({ t: window.__jkClock(), now: Date.now() })),
      guest.evaluate(() => ({ t: window.__jkClock(), now: Date.now() })),
    ]);
    diffs.push(Math.abs((a.t - b.t) - (a.now - b.now)));
    await sleep(300);
  }
  diffs.sort((x, y) => x - y);
  const median = diffs[diffs.length >> 1];
  const pos = await screen.evaluate(() => window.__jkClock());
  check(pos > 1500 && pos < 15000, `screen is playing (position ${Math.round(pos)} ms)`);
  check(median < 120, `guest lyrics within ${Math.round(median)} ms of the screen (limit 120)`);

  // the sung word on the phone is the same one as on the screen
  const sung = (p) => p.evaluate(() => [...document.querySelectorAll('.lyrics .slot.active .w')]
    .filter((w) => { const v = +getComputedStyle(w).getPropertyValue('--p'); return v > 0 && v < 1; }).map((w) => w.textContent).join(' '));
  const [ws, wg] = await Promise.all([sung(screen), sung(guest)]);
  check(ws !== '' && ws === wg, `same word highlighted: screen "${ws}" / phone "${wg}"`);

  // pause from the screen propagates
  await screen.keyboard.press('Space');
  await sleep(600);
  const p1 = await guest.evaluate(() => window.__jkClock());
  await sleep(800);
  const p2 = await guest.evaluate(() => window.__jkClock());
  check(Math.abs(p2 - p1) < 30, 'pause on the screen freezes the phone lyrics');
  await screen.keyboard.press('Space');

  // reactions
  await guest.getByRole('button', { name: '🔥' }).tap();
  await screen.locator('.reactions span').first().waitFor({ timeout: 5000 });
  check(true, 'reaction reached the screen');

  // on-the-spot request: guest uploads a file, the Python maker worker processes it
  const wav = join(tmp, 'Nobody - Fresh.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=262:duration=6', wav]);
  await guest.getByRole('button', { name: 'Request' }).tap();
  await guest.locator('input[type=file]').setInputFiles(wav);
  check(await guest.getByPlaceholder('Title').inputValue() === 'Fresh', 'title and artist guessed from the file name');
  await guest.getByPlaceholder(/Lyrics/).fill('la lo\nli lu');
  await guest.getByRole('button', { name: 'Request song' }).tap();
  await guest.getByText(/making…/).waitFor({ timeout: 10000 });
  check(true, 'request shows in the queue as "making…"');
  const maker = join(here, '..', '..', 'maker');
  let workerLog = '';
  const worker = spawn('uv', ['run', '-q', '--project', maker, 'jojo', 'worker', '--room', code, '--separator', 'none', '--once'],
    { env: { ...process.env, JOJO_SERVER: base, JOJO_TOKEN: token }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  worker.stdout.on('data', (d) => (workerLog += d));
  worker.stderr.on('data', (d) => (workerLog += d));
  const exit = await new Promise((r) => { worker.on('exit', r); setTimeout(() => { worker.kill(); r('timeout'); }, 90000); });
  check(exit === 0, `maker worker processed the request (exit ${exit})${exit === 0 ? '' : '\n' + workerLog}`);
  await guest.locator('.queue li', { hasText: 'Fresh' }).filter({ hasNotText: 'making' }).waitFor({ timeout: 10000 });
  check(true, 'request became a ready song in the queue');
  check(await guest.getByText(/Your karaoke version of/).isVisible(), 'requester is offered their karaoke version');
  await sleep(1500);
  const imported = await screen.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('jojos-karaoke');
    r.onsuccess = () => { const g = r.result.transaction('songs').objectStore('songs').getAll(); g.onsuccess = () => res(g.result.map((x) => x.manifest.title)); };
  }));
  check(imported.includes('Fresh'), 'the screen imported the request into its device songs');

  // offline-capable shell: service worker registers
  const sw = await screen.evaluate(async () => !!(await navigator.serviceWorker?.getRegistration()));
  check(sw, 'service worker registered');

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`);
} catch (e) {
  console.error(e);
  failures++;
} finally {
  await browser?.close();
  killTree(wr.pid);
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall e2e checks passed');
process.exit(failures ? 1 : 0);
