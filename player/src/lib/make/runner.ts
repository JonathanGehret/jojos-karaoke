// Process a room's on-the-spot requests in this browser (like `jojo worker --room CODE`).

import type { Job, ServerMsg } from '$shared/protocol';
import { exportJkp } from '../localLibrary';
import { makeSong } from './pipeline';

export interface RunnerEvents {
  onStatus?: (s: string) => void;
  onJob?: (job: Job | null, pct?: number, stage?: string) => void;
}

export class BrowserJobRunner {
  private ws: WebSocket | null = null;
  private busy = false;
  private stopped = false;
  private timer = 0;
  private retry = 0;
  private lastClaim = 0;

  constructor(private code: string, private token: string, private ev: RunnerEvents = {},
    private opts: { modelUrl?: string; asr?: boolean } = {}) {}

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.ws?.close();
    this.ev.onStatus?.('stopped');
  }

  /** Ask for work. The answer to an empty claim is `job: null`, which is also the server's
   *  "work is waiting" nudge: never answer it right away, or the two ping-pong without end. */
  private claim() {
    if (this.busy || Date.now() - this.lastClaim < 2000) return;
    this.lastClaim = Date.now();
    this.send({ type: 'job.claim' });
  }

  private send(m: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = new URLSearchParams({ role: 'worker', token: this.token, nickname: 'Browser maker' });
    const ws = new WebSocket(`${proto}://${location.host}/api/rooms/${this.code}/ws?${q}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.ev.onStatus?.('waiting for requests');
      this.claim();
      clearInterval(this.timer);
      // the server nudges workers when a request comes in; this is only a fallback
      this.timer = window.setInterval(() => this.claim(), 15000);
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data) as ServerMsg;
      if (m.type === 'job' && m.job && !this.busy) this.run(m.job);
      else if (m.type === 'job' && !m.job) this.claim(); // a nudge (throttled; see claim())
    };
    ws.onclose = (e) => {
      clearInterval(this.timer);
      if (this.stopped) return;
      if (e.code === 4403 || e.code === 4404) { this.ev.onStatus?.('room closed'); return; }
      this.ev.onStatus?.('reconnecting…');
      setTimeout(() => !this.stopped && this.connect(), Math.min(15000, 1000 * 2 ** this.retry++));
    };
  }

  private async run(job: Job) {
    this.busy = true;
    this.ev.onJob?.(job, 0, 'download');
    let last = 0;
    try {
      const r = await fetch(`/api/rooms/${this.code}/uploads/${job.uploadId}`, { headers: { authorization: `Bearer ${this.token}` } });
      if (!r.ok) throw new Error(`could not download the upload (${r.status})`);
      const blob = await r.blob();
      const song = await makeSong(blob, {
        title: job.title, artist: job.artist, lyricsText: job.lyrics, token: this.token, ...this.opts,
        onProgress: (stage, pct) => {
          this.ev.onJob?.(job, pct, stage);
          if (Date.now() - last > 1000) { last = Date.now(); this.send({ type: 'job.progress', jobId: job.id, stage, pct }); }
        },
      });
      // the finished package goes back to the room: the screen imports it into its device
      // library, and the guest who brought the song can download it
      const pkg = await exportJkp({ id: song.manifest.id, manifest: song.manifest, lyrics: song.lyrics, addedAt: 0, size: 0,
        files: Object.fromEntries(Object.entries(song.files).map(([n, d]) => [n, new Blob([d as BlobPart])])) });
      const up = await fetch(`/api/rooms/${this.code}/results/${job.id}`, {
        method: 'POST', body: pkg as BodyInit, headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/zip' },
      });
      if (!up.ok) throw new Error(`could not hand the song to the room (${up.status})`);
      this.send({ type: 'job.done', jobId: job.id, songId: song.manifest.id });
    } catch (e) {
      this.send({ type: 'job.failed', jobId: job.id, error: String((e as Error).message ?? e).slice(0, 200) });
    } finally {
      this.busy = false;
      this.ev.onJob?.(null);
      this.lastClaim = 0;
      this.claim();
    }
  }
}
