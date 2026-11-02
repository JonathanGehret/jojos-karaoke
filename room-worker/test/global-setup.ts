// Runs the real Worker under `wrangler dev` (local workerd, local R2/DO storage).
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// run wrangler through node: spawning `npx` directly fails on Windows (it's a .cmd)
const wranglerPkg = createRequire(import.meta.url).resolve('wrangler/package.json');
const wrangler = join(dirname(wranglerPkg), JSON.parse(readFileSync(wranglerPkg, 'utf8')).bin.wrangler);
let proc: ChildProcess | undefined;

export async function setup({ provide }: { provide: (k: string, v: string) => void }) {
  const dist = join(here, '..', '..', 'player', 'dist');
  if (!existsSync(join(dist, 'index.html'))) {
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>placeholder</title>');
  }
  const port = String(8790 + Math.floor(Math.random() * 100));
  const persist = mkdtempSync(join(tmpdir(), 'jojo-wrangler-'));
  proc = spawn(process.execPath, [wrangler, 'dev', '--port', port, '--ip', '127.0.0.1', '--var', 'MEDIA_SECRET:test-secret',
    '--persist-to', persist, '--show-interactive-dev-session=false'], {
    cwd: join(here, '..'), env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
  });
  let log = '';
  proc.stdout!.on('data', (d) => (log += d));
  proc.stderr!.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000) {
    try {
      const r = await fetch(`${base}/api/me`);
      if (r.status === 401) { provide('base', base); return; }
    } catch { /* not up yet */ }
    if (proc.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev did not start:\n${log.slice(-3000)}`);
}

export async function teardown() {
  if (proc?.pid) {
    // the dev server and its children: a process group on POSIX, taskkill /T on Windows
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
    else { try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* already gone */ } }
  }
}
