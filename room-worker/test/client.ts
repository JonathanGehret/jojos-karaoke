// Tiny WebSocket test client that queues messages so tests can await specific ones.
import type { ServerMsg } from '../../shared/protocol';

export class Client {
  ws: WebSocket;
  inbox: ServerMsg[] = [];
  waiters: { pred: (m: ServerMsg) => boolean; res: (m: ServerMsg) => void }[] = [];
  closed: Promise<number>;

  constructor(url: string) {
    let done!: (code: number) => void;
    this.closed = new Promise<number>((r) => { done = r; });
    this.ws = new WebSocket(url);
    this.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as ServerMsg;
      const w = this.waiters.findIndex((x) => x.pred(m));
      if (w >= 0) this.waiters.splice(w, 1)[0].res(m);
      else this.inbox.push(m);
    };
    this.ws.onclose = (e) => done(e.code);
  }

  send(m: unknown) { this.ws.send(JSON.stringify(m)); }

  next<T extends ServerMsg['type']>(type: T, pred: (m: Extract<ServerMsg, { type: T }>) => boolean = () => true,
    timeout = 10_000): Promise<Extract<ServerMsg, { type: T }>> {
    const p = (m: ServerMsg) => m.type === type && pred(m as any);
    const i = this.inbox.findIndex(p);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0] as any);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), timeout);
      this.waiters.push({ pred: p, res: (m) => { clearTimeout(t); res(m as any); } });
    });
  }

  /** Wait for a state message satisfying pred (drains older ones). */
  async state(pred: (s: any) => boolean) {
    for (;;) {
      const m = await this.next('state');
      if (pred(m.state)) return m.state;
    }
  }

  close() { this.ws.close(); }
}
