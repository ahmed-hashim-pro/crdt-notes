import { Injectable, inject, signal } from '@angular/core';
import type { Op, VersionVector } from '@crdt-notes/crdt';
import { NotesStore } from './store';

export type Connection = 'offline' | 'connecting' | 'online';

/**
 * Op-based sync through the relay. On connect: say what we have, take what
 * we lack, send what the relay lacks. After that, every local op goes out as
 * it is made. Offline, nothing is lost: the ops are in IndexedDB and go out
 * on the next connect, whenever that is.
 */
@Injectable({ providedIn: 'root' })
export class SyncService {
  private readonly store = inject(NotesStore);
  readonly state = signal<Connection>('offline');
  /** The user's switch: stay offline even when the network is there. */
  readonly wanted = signal(true);
  private ws?: WebSocket;
  private retry = 0;
  private timer?: ReturnType<typeof setTimeout>;

  start(): void {
    this.store.onLocal = (op) => this.send([op]);
    this.connect();
  }

  setOnline(on: boolean): void {
    this.wanted.set(on);
    clearTimeout(this.timer);
    if (on) this.connect();
    else {
      this.ws?.close();
      this.ws = undefined;
      this.state.set('offline');
    }
  }

  private url(): string {
    const override = new URLSearchParams(location.search).get('relay');
    if (override) return override;
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/sync`;
  }

  private connect(): void {
    if (!this.wanted() || this.ws) return;
    this.state.set('connecting');
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', have: this.store.replica.version() }));
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string) as { type: string; ops?: Op[]; have?: VersionVector };
      if (msg.type === 'ops' && msg.ops) this.store.receive(msg.ops);
      if (msg.type === 'welcome' && msg.have) {
        this.state.set('online');
        this.retry = 0;
        const missing = this.store.replica.missingFor(msg.have);
        if (missing.length) ws.send(JSON.stringify({ type: 'ops', ops: missing }));
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.state.set('offline');
      if (this.wanted()) this.timer = setTimeout(() => this.connect(), Math.min(10_000, 500 * 2 ** this.retry++));
    };
  }

  private send(ops: Op[]): void {
    if (this.state() === 'online' && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'ops', ops }));
    }
  }
}
