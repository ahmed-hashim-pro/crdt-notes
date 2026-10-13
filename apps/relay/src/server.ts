// The sync relay: stores every op it is given and forwards it to everyone
// else. It has no authority and no CRDT logic. It never decides anything,
// merges anything or rejects an edit for conflicting; the replicas do all
// of that themselves, so the relay can be restarted, replaced or lost
// without losing an edit any replica still holds.
//
// It also serves the built web app, so one process is the whole demo.
//
// Protocol (JSON over one WebSocket at /sync):
//   client -> relay  {type:"hello", replica, have}   have: the client's version vector
//   relay  -> client {type:"ops", ops}               what the relay has that the client lacks
//   relay  -> client {type:"welcome", have}          the relay's version vector
//   client -> relay  {type:"ops", ops}               what the relay lacks, then each new local op
//   relay  -> others {type:"ops", ops}               anything new, as it arrives
import { createReadStream, existsSync, readFileSync, appendFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';

type VersionVector = Record<string, number>;
interface WireOp {
  id: { c: number; r: string };
  seq: number;
  [k: string]: unknown;
}

export interface RelayOptions {
  port?: number;
  host?: string;
  /** Append-only JSON-lines file of every op; reloaded on start. */
  dataFile?: string;
  /** Directory of the built web app to serve, if any. */
  staticDir?: string;
}

export interface Relay {
  port: number;
  server: Server;
  ops(): readonly WireOp[];
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

const str = (x: unknown) => typeof x === 'string' && x.length > 0;
const strs = (x: unknown) => Array.isArray(x) && x.every(str);

// The relay doesn't judge edits, but it won't pass on an op that isn't one:
// a malformed op would make every replica that receives it throw. This is
// the same shape check the replicas make (opProblem in packages/crdt).
function isOp(x: unknown): x is WireOp {
  const o = x as WireOp & Record<string, any>;
  if (typeof o !== 'object' || o === null || typeof o.id !== 'object' || o.id === null) return false;
  if (!Number.isInteger(o.id.c) || o.id.c <= 0 || !Number.isInteger(o.seq) || o.seq <= 0) return false;
  if (!str(o.id.r) || o.id.r.length > 64 || o.id.r.includes('@') || !str(o.note)) return false;
  if (!isVV(o.deps) || Array.isArray(o.deps)) return false;
  switch (o.t) {
    case 'create': return o.note === `${o.id.c}@${o.id.r}`;
    case 'set': return (o.key === 'title' && typeof o.value === 'string') || (o.key === 'deleted' && typeof o.value === 'boolean');
    case 'tag+': return str(o.tag);
    case 'tag-': return str(o.tag) && strs(o.removes);
    case 'ins': return (o.after === null || str(o.after)) && str(o.text);
    case 'del': return strs(o.targets) && o.targets.length > 0;
    default: return false;
  }
}

function isVV(x: unknown): x is VersionVector {
  return typeof x === 'object' && x !== null && Object.values(x).every((n) => Number.isInteger(n) && (n as number) >= 0);
}

export function startRelay(opts: RelayOptions = {}): Promise<Relay> {
  const log: WireOp[] = [];
  const have: VersionVector = {};
  // Ops are kept per replica, by sequence number; a gap waits for the missing op.
  const byReplica = new Map<string, Map<number, WireOp>>();

  const store = (op: WireOp, persist: boolean): boolean => {
    let ops = byReplica.get(op.id.r);
    if (!ops) byReplica.set(op.id.r, (ops = new Map()));
    if (ops.has(op.seq)) return false;
    ops.set(op.seq, op);
    log.push(op);
    let n = have[op.id.r] ?? 0;
    while (ops.has(n + 1)) n++;
    have[op.id.r] = n;
    if (persist && opts.dataFile) appendFileSync(opts.dataFile, JSON.stringify(op) + '\n');
    return true;
  };

  if (opts.dataFile && existsSync(opts.dataFile)) {
    for (const line of readFileSync(opts.dataFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const op = JSON.parse(line);
        if (isOp(op)) store(op, false);
      } catch {
        // A torn last line from a crash: skip it, the replica still has the op.
      }
    }
  }

  const server = createServer((req, res) => {
    if (!opts.staticDir) {
      res.writeHead(404).end('no web app configured; this relay only syncs');
      return;
    }
    const root = resolve(opts.staticDir);
    const url = new URL(req.url ?? '/', 'http://x');
    let file = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root + sep) && file !== root) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html'); // client-side routes
    if (!existsSync(file)) {
      res.writeHead(404).end('web app not built: run npm run build');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({ server, path: '/sync', maxPayload: 16 * 1024 * 1024 });
  const clients = new Set<WebSocket>();
  const send = (ws: WebSocket, msg: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('message', (data) => {
      let msg: { type?: string; have?: unknown; ops?: unknown };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return ws.close(1003, 'not JSON');
      }
      if (msg.type === 'hello' && isVV(msg.have)) {
        const theirs = msg.have;
        send(ws, { type: 'ops', ops: log.filter((op) => op.seq > (theirs[op.id.r] ?? 0)) });
        send(ws, { type: 'welcome', have: { ...have } });
      } else if (msg.type === 'ops' && Array.isArray(msg.ops) && msg.ops.every(isOp)) {
        const fresh = msg.ops.filter((op) => store(op, true));
        if (fresh.length) for (const other of clients) if (other !== ws) send(other, { type: 'ops', ops: fresh });
      } else {
        ws.close(1003, 'unknown message');
      }
    });
  });

  return new Promise((ok) => {
    server.listen(opts.port ?? 8787, opts.host ?? '127.0.0.1', () => {
      const addr = server.address();
      ok({
        port: typeof addr === 'object' && addr ? addr.port : 0,
        server,
        ops: () => log,
        close: () =>
          new Promise<void>((done) => {
            for (const c of clients) c.terminate();
            wss.close();
            server.close(() => done());
          }),
      });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const relay = await startRelay({
    port: Number(process.env.PORT ?? 8787),
    host: process.env.HOST ?? '127.0.0.1',
    dataFile: process.env.DATA ?? join(here, '../relay-data.jsonl'),
    staticDir: process.env.STATIC ?? join(here, '../../web/dist/web/browser'),
  });
  console.log(`crdt-notes relay on http://${process.env.HOST ?? '127.0.0.1'}:${relay.port} (${relay.ops().length} ops stored)`);
}
