import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startRelay, type Relay } from '../src/server.ts';

const op = (r: string, seq: number, extra: object = {}) => ({ id: { c: seq, r }, seq, deps: {}, note: `${seq}@${r}`, t: 'create', ...extra });

let relay: Relay | undefined;
afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

/** A client that records every message. */
async function client(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/sync`);
  const got: any[] = [];
  ws.on('message', (d) => got.push(JSON.parse(String(d))));
  await new Promise((ok) => ws.on('open', ok));
  const until = async (pred: () => boolean) => {
    for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(pred()).toBe(true);
  };
  return { ws, got, until, send: (m: object) => ws.send(JSON.stringify(m)) };
}

describe('relay', () => {
  it('forwards new ops to other clients, not back to the sender', async () => {
    relay = await startRelay({ port: 0 });
    const a = await client(relay.port);
    const b = await client(relay.port);
    a.send({ type: 'hello', have: {} });
    b.send({ type: 'hello', have: {} });
    await b.until(() => b.got.some((m) => m.type === 'welcome'));
    a.send({ type: 'ops', ops: [op('a', 1)] });
    await b.until(() => b.got.some((m) => m.type === 'ops' && m.ops.length === 1));
    expect(a.got.filter((m) => m.type === 'ops' && m.ops.length > 0)).toEqual([]);
    a.ws.close();
    b.ws.close();
  });

  it('sends a newcomer exactly what it lacks', async () => {
    relay = await startRelay({ port: 0 });
    const a = await client(relay.port);
    a.send({ type: 'ops', ops: [op('a', 1), op('a', 2), op('b', 1)] });
    await a.until(() => relay!.ops().length === 3);
    const c = await client(relay.port);
    c.send({ type: 'hello', have: { a: 1 } });
    await c.until(() => c.got.some((m) => m.type === 'welcome'));
    const ops = c.got.find((m) => m.type === 'ops').ops;
    expect(ops.map((o: any) => `${o.id.r}${o.seq}`).sort()).toEqual(['a2', 'b1']);
    expect(c.got.find((m) => m.type === 'welcome').have).toEqual({ a: 2, b: 1 });
    a.ws.close();
    c.ws.close();
  });

  it('stores each op once, however often it is sent', async () => {
    relay = await startRelay({ port: 0 });
    const a = await client(relay.port);
    for (let i = 0; i < 3; i++) a.send({ type: 'ops', ops: [op('a', 1)] });
    await a.until(() => relay!.ops().length === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(relay.ops().length).toBe(1);
    a.ws.close();
  });

  it('survives a restart through its data file, and skips a torn last line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-'));
    const dataFile = join(dir, 'ops.jsonl');
    relay = await startRelay({ port: 0, dataFile });
    const a = await client(relay.port);
    a.send({ type: 'ops', ops: [op('a', 1), op('a', 2)] });
    await a.until(() => relay!.ops().length === 2);
    a.ws.close();
    await relay.close();
    writeFileSync(dataFile, readFileSync(dataFile, 'utf8') + '{"id":{"c":3,');
    relay = await startRelay({ port: 0, dataFile });
    expect(relay.ops().length).toBe(2);
  });

  it('closes on garbage instead of crashing', async () => {
    relay = await startRelay({ port: 0 });
    const a = await client(relay.port);
    const closed = new Promise<number>((ok) => a.ws.on('close', ok));
    a.ws.send('not json');
    expect(await closed).toBe(1003);
    const b = await client(relay.port);
    const closedB = new Promise<number>((ok) => b.ws.on('close', ok));
    b.send({ type: 'ops', ops: [{ id: { c: -1, r: 'x' }, seq: 0 }] });
    expect(await closedB).toBe(1003);
    // Still serving.
    const c = await client(relay.port);
    c.send({ type: 'hello', have: {} });
    await c.until(() => c.got.some((m) => m.type === 'welcome'));
    c.ws.close();
  });

  it('refuses malformed ops instead of passing them on', async () => {
    relay = await startRelay({ port: 0 });
    const b = await client(relay.port);
    b.send({ type: 'hello', have: {} });
    await b.until(() => b.got.some((m) => m.type === 'welcome'));
    const set = { t: 'set', note: '1@a', key: 'title', value: 'x' };
    const bad = [
      op('a', 1, { deps: undefined }),
      op('a', 1, { deps: [1] }),
      op('a', 1, { note: '1@z' }), // a create names itself
      op('a', 1, { note: undefined, t: 'tag+', tag: 'x' }),
      op('a', 1, { id: { c: 1, r: 'a@b' } }),
      op('a', 1, { ...set, value: 7 }),
      op('a', 1, { ...set, key: 'colour' }),
      op('a', 1, { t: 'tag+', note: '1@a', tag: '' }),
      op('a', 1, { t: 'tag-', note: '1@a', tag: 'x' }),
      op('a', 1, { t: 'ins', note: '1@a', after: null }),
      op('a', 1, { t: 'ins', note: '1@a', after: 3, text: 'x' }),
      op('a', 1, { t: 'del', note: '1@a', targets: [] }),
      op('a', 1, { t: 'move' }),
    ];
    for (const o of bad) {
      const a = await client(relay.port);
      const closed = new Promise<number>((ok) => a.ws.on('close', ok));
      a.send({ type: 'ops', ops: [op('a', 2), o] });
      expect(await closed, JSON.stringify(o)).toBe(1003);
    }
    // None stored or forwarded, not even the good op sent alongside.
    expect(relay.ops()).toEqual([]);
    expect(b.got.filter((m) => m.type === 'ops' && m.ops.length > 0)).toEqual([]);
    b.ws.close();
  });

  it('serves the app, falls back to index.html, and refuses to leave its directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<h1>app</h1>');
    writeFileSync(join(dir, 'main.js'), 'console.log(1)');
    relay = await startRelay({ port: 0, staticDir: dir });
    const base = `http://127.0.0.1:${relay.port}`;
    expect(await (await fetch(`${base}/`)).text()).toBe('<h1>app</h1>');
    const js = await fetch(`${base}/main.js`);
    expect(js.headers.get('content-type')).toBe('text/javascript');
    expect(await (await fetch(`${base}/notes/123`)).text()).toBe('<h1>app</h1>');
    expect((await fetch(`${base}/..%2f..%2fetc%2fpasswd`)).status).toBe(403);
  });
});
