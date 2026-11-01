// Live connection to a room: state, library, clock sync and reconnects.

import { type ClockSample, estimateOffset, positionAt, sampleFrom } from '$shared/clock';
import type { ClientMsg, Member, Playback, RoomState, ServerMsg, SongSummary } from '$shared/protocol';
import { store } from './store';

export type Status = 'connecting' | 'open' | 'closed' | 'kicked' | 'gone';

export interface ConnectOpts {
  code: string;
  role: 'screen' | 'admin' | 'guest';
  nickname?: string;
  admin?: string | null;
}

export class RoomConnection {
  state = $state<RoomState | null>(null);
  library = $state<SongSummary[]>([]);
  you = $state<Member | null>(null);
  status = $state<Status>('connecting');
  error = $state<string | null>(null);
  playback = $state<Playback | null>(null);
  offset = 0;                 // serverTime - Date.now()
  synced = $state(false);

  private ws: WebSocket | null = null;
  private samples: ClockSample[] = [];
  private pingTimer = 0;
  private retry = 0;
  private closedByUs = false;
  private listeners = new Set<(m: ServerMsg) => void>();

  constructor(private opts: ConnectOpts) {
    this.connect();
  }

  get code() { return this.opts.code; }
  get memberToken() { return store.memberToken(this.opts.code); }
  get isAdmin() { return this.opts.role !== 'guest'; }

  serverNow() { return Date.now() + this.offset; }

  /** Current song position from the last playback message (for guests). */
  songPosition(): number {
    return this.playback ? positionAt(this.playback, this.serverNow()) : 0;
  }

  on(fn: (m: ServerMsg) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  send(m: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  close() {
    this.closedByUs = true;
    clearInterval(this.pingTimer);
    this.ws?.close();
  }

  private url() {
    const q = new URLSearchParams();
    if (this.opts.role !== 'guest') { q.set('role', this.opts.role); q.set('token', this.opts.admin ?? ''); }
    const member = store.memberToken(this.opts.code);
    if (member) q.set('member', member);
    if (this.opts.nickname) q.set('nickname', this.opts.nickname);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/api/rooms/${this.opts.code}/ws?${q}`;
  }

  private connect() {
    this.status = 'connecting';
    const ws = new WebSocket(this.url());
    this.ws = ws;
    const openTimeout = setTimeout(() => ws.readyState !== WebSocket.OPEN && ws.close(), 10_000);
    ws.onopen = () => {
      clearTimeout(openTimeout);
      this.retry = 0;
      this.status = 'open';
      this.error = null;
      this.samples = [];
      this.burstPing();
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.ping(), 10_000);
    };
    ws.onmessage = (e) => this.onMessage(JSON.parse(e.data));
    ws.onclose = (e) => {
      clearTimeout(openTimeout);
      clearInterval(this.pingTimer);
      if (this.closedByUs) return;
      if (e.code === 4403) { this.status = 'kicked'; store.setMemberToken(this.opts.code, null); return; }
      if (e.code === 4404) { this.status = 'gone'; return; }
      this.status = 'closed';
      const delay = Math.min(15_000, 500 * 2 ** this.retry++) + Math.random() * 300;
      setTimeout(() => this.connect(), delay);
    };
  }

  private burstPing() {
    for (let i = 0; i < 6; i++) setTimeout(() => this.ping(), i * 150);
  }

  private ping() { this.send({ type: 'ping', c: Date.now() }); }

  private onMessage(m: ServerMsg) {
    switch (m.type) {
      case 'welcome': {
        const tok = (m.you as Member & { token?: string }).token;
        if (tok) store.setMemberToken(this.opts.code, tok);
        this.you = { id: m.you.id, nickname: m.you.nickname, role: m.you.role, online: true };
        this.state = m.state;
        this.playback = m.state.playback;
        break;
      }
      case 'state':
        this.state = m.state;
        if (m.state.playback.queueItemId !== this.playback?.queueItemId) this.playback = m.state.playback;
        break;
      case 'playback': this.playback = m.playback; break;
      case 'library': this.library = m.songs; break;
      case 'pong': {
        this.samples.push(sampleFrom(m.c, m.s, Date.now()));
        if (this.samples.length > 30) this.samples.shift();
        this.offset = estimateOffset(this.samples) ?? 0;
        this.synced = this.samples.length >= 3;
        break;
      }
      case 'error': this.error = m.message; setTimeout(() => { if (this.error === m.message) this.error = null; }, 5000); break;
      case 'kicked': this.status = 'kicked'; break;
    }
    for (const l of this.listeners) l(m);
  }
}
