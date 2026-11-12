// Screenshots and a screen recording of the app, for the README and the portfolio site.
// Real Worker (wrangler dev) + built PWA + headless Chromium, like run.mjs. The songs are
// invented and the audio is a quiet tone, so no copyrighted music or lyrics end up in them.
// usage: npm run build && node player/e2e/screenshots.mjs [out dir, default: out/screenshots]
// Needs Playwright's Chromium and ffmpeg.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = resolve(process.argv[2] ?? join(repo, 'out', 'screenshots'));
mkdirSync(out, { recursive: true });
const require = createRequire(join(repo, 'player', 'e2e', 'x.mjs'));
const wranglerPkg = require.resolve('wrangler/package.json', { paths: [join(repo, 'room-worker')] });
const wrangler = join(dirname(wranglerPkg), JSON.parse(readFileSync(wranglerPkg, 'utf8')).bin.wrangler);
const { chromium } = require('playwright');

const tmp = mkdtempSync(join(tmpdir(), 'jojo-shots-'));
const audio = join(tmp, 'tone.opus');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=60', '-af', 'volume=0.05', '-c:a', 'libopus', audio]);

const port = 8900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const wr = spawn(process.execPath, [wrangler, 'dev', '--port', String(port), '--ip', '127.0.0.1', '--var', 'MEDIA_SECRET:e2e',
  '--persist-to', join(tmp, 'state'), '--show-interactive-dev-session=false'],
  { cwd: join(repo, 'room-worker'), env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
wr.stdout.on('data', (d) => (log += d));
wr.stderr.on('data', (d) => (log += d));
// stop the dev server and its children: taskkill /T on Windows, a process group elsewhere
const killTree = (pid) => {
  if (!pid) return;
  if (process.platform === 'win32') { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
  else { try { process.kill(-pid, 'SIGTERM'); } catch { /* gone */ } }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { method = 'GET', body, token, raw } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(base + path, { method, headers, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

// invented lyrics: [singer, text]; every word gets `beat` ms
function timed(rows, startMs, beat) {
  let t = startMs;
  const lines = [];
  for (const [singer, text] of rows) {
    const words = text.split(' ').map((w) => { const o = { t: w, s: t, e: t + beat - 40 }; t += beat; return o; });
    lines.push({ start: words[0].s, end: words[words.length - 1].e, singer, words });
    t += beat;
  }
  return { version: 1, singers: { A: 'Lead', B: 'Second' }, lines };
}
const disco = timed([
  ['A', 'Turn the kitchen lights down low'],
  ['B', 'Hand me the spoon, my microphone'],
  ['A', 'Every neighbour is gonna know'],
  ['B', 'We sing it loud, we sing it wrong'],
  ['A', 'Midnight kitchen disco'],
  ['B', 'Dancing in our socks again'],
  ['A', 'Midnight kitchen disco'],
  ['B', 'One more song and then to bed'],
  ['A', 'Turn the kitchen lights down low'],
  ['B', 'Nobody here can hold a note'],
  ['A', 'Still the best show that I know'],
  ['B', 'Sing it again, sing it again'],
], 3500, 430);
const songs = [
  ['midnight-kitchen-disco', 'Midnight Kitchen Disco', 'Jojo & the Night Herons', disco],
  ['bearded-vulture-blues', 'Bearded Vulture Blues', 'The Updrafts', timed([['A', 'High above the valley floor']], 2000, 500)],
  ['zwei-bier-ein-mikro', 'Zwei Bier, ein Mikro', 'Die Nachtschwärmer', timed([['A', 'Zwei Bier und ein Mikrofon']], 2000, 500)],
  ['last-bus-home', 'Last Bus Home', 'Corner Table Choir', timed([['A', 'We missed the last bus home']], 2000, 500)],
  ['sing-it-wrong', 'Sing It Wrong', 'Karaoke Kollektiv', timed([['A', 'Sing it wrong and sing it proud']], 2000, 500)],
];

let browser;
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(base + '/api/me')).status === 401) break; } catch { /* starting */ }
    if (i > 180) throw new Error(`wrangler did not start\n${log.slice(-2000)}`);
    await sleep(500);
  }
  const { token } = await api('/api/accounts', { method: 'POST', body: { name: 'Jojo' } });
  for (const [id, title, artist, lyrics] of songs) {
    const sid = `${id}-shots01`;
    await api(`/api/library/songs/${sid}/files/instrumental.opus`, { method: 'PUT', token, raw: readFileSync(audio) });
    await api(`/api/library/songs/${sid}/files/lyrics.json`, { method: 'PUT', token, raw: JSON.stringify(lyrics) });
    await api(`/api/library/songs/${sid}/commit`, { method: 'POST', token, body: { formatVersion: 1, id: sid, title, artist,
      durationMs: 60000, files: { instrumental: 'instrumental.opus', lyrics: 'lyrics.json' } } });
  }
  const { code, adminToken } = await api('/api/rooms', { method: 'POST', token });

  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const shot = (page, name) => page.screenshot({ path: join(out, name) });

  // home
  const homeCtx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
  const home = await homeCtx.newPage();
  await home.goto(base + '/');
  await sleep(1200);
  await shot(home, 'home.png');
  await homeCtx.close();

  // host screen (recorded)
  const videoDir = join(tmp, 'video');
  const hostCtx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } });
  await hostCtx.addInitScript(([c, t]) => { localStorage.setItem('jk.admin', JSON.stringify({ [c]: t })); localStorage.setItem('jk.makeHere', 'false'); }, [code, adminToken]);
  const screen = await hostCtx.newPage();
  await screen.goto(`${base}/screen/${code}`);
  await sleep(1000);
  await shot(screen, 'host_lobby.png');
  await screen.getByRole('button', { name: /Start the party/ }).click();
  await screen.getByRole('heading', { name: 'Pick a song!' }).waitFor({ timeout: 10000 });
  await sleep(800);
  await shot(screen, 'host_waiting.png');

  // guests
  const guests = [];
  for (const name of ['Mia', 'Ben', 'Jojo']) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(`${base}/join/${code}`);
    if (name === 'Mia') { await sleep(600); await shot(page, 'guest_join.png'); }
    await page.getByPlaceholder('Nickname').fill(name);
    await page.getByRole('button', { name: 'Join' }).click();
    await page.getByText('Midnight Kitchen Disco').first().waitFor({ timeout: 10000 });
    guests.push(page);
  }
  const [mia, ben, jojo] = guests;
  await sleep(500);
  await shot(mia, 'guest_songs.png');
  await mia.getByRole('button', { name: /Midnight Kitchen Disco/ }).tap();
  await sleep(300);
  await ben.getByRole('button', { name: /Bearded Vulture Blues/ }).tap();
  await sleep(300);
  await jojo.getByRole('button', { name: /Zwei Bier/ }).tap();

  await screen.getByText('Up next').waitFor({ timeout: 10000 });
  await sleep(500);
  await shot(screen, 'host_up_next.png');
  await screen.locator('.lyrics .w').first().waitFor({ timeout: 20000 });
  await mia.locator('.lyrics .w').first().waitFor({ timeout: 10000 });

  // wait until the clock is inside a line, so the wipe is mid-word
  const at = async (ms) => { for (;;) { const t = await screen.evaluate(() => window.__jkClock()); if (t >= ms) return; await sleep(40); } };
  await at(disco.lines[1].words[3].s + 150);
  await Promise.all([shot(screen, 'host_singing.png'), shot(mia, 'guest_singing.png')]);
  await mia.getByRole('button', { name: '🔥' }).tap().catch(() => {});
  await ben.getByRole('button', { name: '🔥' }).tap().catch(() => {});
  await at(disco.lines[4].words[1].s + 200);
  await shot(screen, 'host_singing_2.png');
  await screen.keyboard.press('q').catch(() => {});
  await sleep(700);
  await shot(screen, 'host_queue.png');
  await shot(ben, 'guest_queue.png');
  await screen.keyboard.press('q').catch(() => {});
  await at(disco.lines[8].start);
  await hostCtx.close(); // flushes the video
  const vid = readdirSync(videoDir).find((f) => f.endsWith('.webm'));
  if (vid) renameSync(join(videoDir, vid), join(out, 'host_raw.webm'));
  console.log('done', readdirSync(out).join(' '));
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser?.close();
  killTree(wr.pid);
}
