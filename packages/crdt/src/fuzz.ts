/**
 * The convergence fuzzer. A seed describes a whole run: how many replicas,
 * how hostile the network is, and every edit and delivery. Replicas edit
 * concurrently while the network delays, reorders, duplicates and drops
 * their ops and partitions them; then the network heals, the replicas
 * exchange whatever they are missing, and the checks run:
 *
 *  1. Convergence: every replica holds the same state, tombstones and their
 *     order included.
 *  2. Order independence: a fresh replica fed every op in a random order (and
 *     again in another) reaches that same state.
 *  3. Nothing lost, nothing invented: the visible characters are exactly the
 *     ones inserted and never deleted, each once.
 *  4. Local intent: every local edit does to its replica's text exactly what
 *     a plain string edit would (checked as the run goes).
 *  5. Nothing stuck: no replica is left holding ops it cannot apply.
 *
 * Convergence alone is easy to fake (drop every remote op and all replicas
 * agree on nothing), which is why 3 and 4 are there.
 */
import { Replica, type Bugs } from './replica.js';
import { Rng } from './rng.js';
import type { Op } from './types.js';

export interface Profile {
  replicas: number;
  steps: number;
  dropRate: number;
  dupRate: number;
  maxDelay: number;
  /** Chance per step that the network splits (or, if split, heals). */
  partitionRate: number;
}

/** Each seed draws its own profile (swarm testing): calm, lossy, slow, split. */
export function profileFor(seed: number): Profile {
  const r = new Rng(seed ^ 0x5eed);
  return {
    replicas: 2 + r.int(4),
    steps: 150 + r.int(250),
    dropRate: r.pick([0, 0.1, 0.3]),
    dupRate: r.pick([0, 0.1, 0.3]),
    maxDelay: r.pick([1, 5, 30]),
    partitionRate: r.pick([0, 0.01, 0.05]),
  };
}

export type Check = 'convergence' | 'order independence' | 'nothing lost' | 'local intent' | 'nothing stuck' | 'no exceptions';

export interface FuzzResult {
  seed: number;
  ok: boolean;
  failure?: string;
  /** Which of the checks failed. */
  check?: Check;
  stats: { replicas: number; ops: number; delivered: number; dropped: number; duplicated: number; partitions: number };
}

interface Message {
  at: number;
  to: number;
  op: Op;
}

const WORDS = ['plan', 'todo', 'idea', 'draft', 'notes', 'meeting'];
const TAGS = ['work', 'home', 'urgent', 'later'];
const ALPHABET = 'abcdefgh ';

export function fuzz(seed: number, bugs: Bugs = {}, profile: Profile = profileFor(seed)): FuzzResult {
  const rng = new Rng(seed);
  const stats = { replicas: profile.replicas, ops: 0, delivered: 0, dropped: 0, duplicated: 0, partitions: 0 };
  const replicas = Array.from({ length: profile.replicas }, (_, i) => new Replica(`r${i}`, bugs));
  let inflight: Message[] = [];
  let side: number[] | null = null; // partition side per replica, null when connected
  let now = 0;

  const fail = (failure: string, check: Check): FuzzResult => ({ seed, ok: false, failure, check, stats });

  replicas.forEach((rep, from) =>
    rep.onOp((op, local) => {
      if (!local) return;
      stats.ops++;
      for (let to = 0; to < replicas.length; to++) {
        if (to === from) continue;
        if (rng.chance(profile.dropRate)) {
          stats.dropped++;
          continue;
        }
        const copies = rng.chance(profile.dupRate) ? 2 : 1;
        stats.duplicated += copies - 1;
        for (let k = 0; k < copies; k++) inflight.push({ at: now + 1 + rng.int(profile.maxDelay), to, op });
      }
    }),
  );

  try {
    for (now = 0; now < profile.steps; now++) {
      // Deliver what is due, in random order; a partition loses it.
      const due = rng.shuffle(inflight.filter((m) => m.at <= now));
      inflight = inflight.filter((m) => m.at > now);
      for (const m of due) {
        if (side && side[m.to] !== side[Number(m.op.id.r.slice(1))]) {
          stats.dropped++;
          continue;
        }
        stats.delivered++;
        replicas[m.to].receive(m.op);
      }
      if (rng.chance(profile.partitionRate)) {
        if (side) side = null;
        else {
          side = replicas.map(() => rng.int(2));
          stats.partitions++;
        }
      }
      // A few edits per step, so concurrent edits are common.
      for (let k = rng.int(3); k > 0; k--) {
        const problem = edit(rng, rng.pick(replicas));
        if (problem) return fail(problem, 'local intent');
      }
    }

    // Heal: deliver the stragglers, then anti-entropy until nobody learns anything.
    for (const m of rng.shuffle(inflight)) replicas[m.to].receive(m.op);
    inflight = [];
    for (let changed = true; changed; ) {
      changed = false;
      for (const a of replicas) {
        for (const b of replicas) {
          if (a === b) continue;
          for (const op of rng.shuffle(a.missingFor(b.version()))) {
            if (b.receive(op) > 0) changed = true;
          }
        }
      }
    }
  } catch (e) {
    return fail(`exception: ${(e as Error).message}`, 'no exceptions');
  }

  for (const r of replicas) {
    if (r.pending() > 0) return fail(`replica ${r.id} is stuck with ${r.pending()} ops it cannot apply`, 'nothing stuck');
  }
  const reference = replicas[0].snapshot();
  for (const r of replicas.slice(1)) {
    if (r.snapshot() !== reference) return fail(`replicas r0 and ${r.id} diverged: ${firstDifference(replicas[0], r)}`, 'convergence');
  }

  // Order independence: the same ops, delivered in two other random orders.
  const all = replicas.flatMap((r) => r.ops().filter((op) => op.id.r === r.id));
  for (const name of ['x', 'y']) {
    const fresh = new Replica(name, bugs);
    try {
      for (const op of rng.shuffle([...all])) fresh.receive(op);
    } catch (e) {
      return fail(`a fresh replica fed the ops in another order threw: ${(e as Error).message}`, 'order independence');
    }
    if (fresh.snapshot() !== reference) {
      return fail(`a fresh replica fed the same ops in another order reached a different state: ${firstDifference(replicas[0], fresh)}`, 'order independence');
    }
  }

  // Nothing lost, nothing invented.
  const inserted = new Map<string, Set<string>>();
  const deleted = new Set<string>();
  for (const op of all) {
    if (op.t === 'ins') {
      let s = inserted.get(op.note);
      if (!s) inserted.set(op.note, (s = new Set()));
      for (let i = 0; i < op.text.length; i++) s.add(`${op.id.c + i}@${op.id.r}`);
    }
    if (op.t === 'del') op.targets.forEach((k) => deleted.add(k));
  }
  for (const note of replicas[0].notesList()) {
    const expect = [...(inserted.get(note.id) ?? [])].filter((k) => !deleted.has(k)).sort();
    const got = replicas[0].visibleKeys(note.id);
    if (new Set(got).size !== got.length) return fail(`note ${note.id} shows a character twice`, 'nothing lost');
    if (JSON.stringify([...got].sort()) !== JSON.stringify(expect)) {
      return fail(`note ${note.id} shows ${got.length} characters; ${expect.length} were inserted and not deleted`, 'nothing lost');
    }
  }
  return { seed, ok: true, stats };
}

/** One random local edit, checked against what a plain string would do. */
function edit(rng: Rng, r: Replica): string | undefined {
  const notes = r.notesList();
  if (notes.length === 0 || (notes.length < 3 && rng.chance(0.05))) {
    r.createNote(rng.pick(WORDS));
    return;
  }
  const note = rng.pick(notes).id;
  const before = r.text(note);
  const x = rng.next();
  if (x < 0.4) {
    const at = rng.int(before.length + 1);
    // Sometimes type a run one character at a time, as a person would.
    if (rng.chance(0.3)) {
      let s = before;
      for (let i = 0, n = 1 + rng.int(5); i < n; i++) {
        const ch = rng.pick([...ALPHABET]);
        r.insertText(note, at + i, ch);
        s = s.slice(0, at + i) + ch + s.slice(at + i);
      }
      if (r.text(note) !== s) return `local typing at ${at} gave ${JSON.stringify(r.text(note))}, expected ${JSON.stringify(s)}`;
      return;
    }
    const text = Array.from({ length: 1 + rng.int(4) }, () => rng.pick([...ALPHABET])).join('');
    r.insertText(note, at, text);
    const expect = before.slice(0, at) + text + before.slice(at);
    if (r.text(note) !== expect) return `local insert at ${at} gave ${JSON.stringify(r.text(note))}, expected ${JSON.stringify(expect)}`;
  } else if (x < 0.65) {
    if (before.length === 0) return;
    const at = rng.int(before.length);
    const len = 1 + rng.int(Math.min(4, before.length - at));
    r.deleteText(note, at, len);
    const expect = before.slice(0, at) + before.slice(at + len);
    if (r.text(note) !== expect) return `local delete of ${at}+${len} gave ${JSON.stringify(r.text(note))}, expected ${JSON.stringify(expect)}`;
  } else if (x < 0.75) {
    r.setTitle(note, rng.pick(WORDS) + rng.int(10));
  } else if (x < 0.85) {
    r.addTag(note, rng.pick(TAGS));
  } else if (x < 0.95) {
    r.removeTag(note, rng.pick(TAGS));
  } else {
    r.setDeleted(note, rng.chance(0.5));
  }
}

function firstDifference(a: Replica, b: Replica): string {
  const na = a.notesList();
  const nb = b.notesList();
  if (na.length !== nb.length) return `${na.length} notes vs ${nb.length}`;
  for (let i = 0; i < na.length; i++) {
    const x = na[i];
    const y = nb[i];
    for (const f of ['id', 'title', 'deleted', 'tags', 'text'] as const) {
      if (JSON.stringify(x[f]) !== JSON.stringify(y[f])) {
        return `note ${x.id} ${f}: ${JSON.stringify(x[f])} vs ${JSON.stringify(y[f])}`;
      }
    }
  }
  return 'same visible notes, different tombstones or order underneath';
}

export interface Mutant {
  name: string;
  description: string;
  bugs: Bugs;
}

export const MUTANTS: Mutant[] = [
  { name: 'arrival-order-tie-break', description: 'order concurrent inserts at one spot by arrival, not by id', bugs: { arrivalOrderTieBreak: true } },
  { name: 'no-causal-buffer', description: 'apply ops on arrival, before the ops they depend on', bugs: { noCausalBuffer: true } },
  { name: 'forget-tombstones', description: 'remove deleted characters instead of keeping tombstones', bugs: { forgetTombstones: true } },
  { name: 'lww-by-arrival', description: 'let the last title to arrive win, not the highest id', bugs: { lwwByArrival: true } },
  { name: 'remove-unobserved', description: 'a tag removal also cancels concurrent adds it never saw', bugs: { removeUnobserved: true } },
  { name: 'accept-duplicates', description: 'apply a duplicated op a second time', bugs: { acceptDuplicates: true } },
];

export interface HuntResult {
  seeds: number;
  failures: FuzzResult[];
}

/** Runs seeds from..from+count-1; with stopAtFirst, stops at the first failure. */
export function hunt(from: number, count: number, bugs: Bugs = {}, stopAtFirst = false): HuntResult {
  const failures: FuzzResult[] = [];
  let seeds = 0;
  for (let s = from; s < from + count; s++) {
    seeds++;
    const r = fuzz(s, bugs);
    if (!r.ok) {
      failures.push(r);
      if (stopAtFirst) break;
    }
  }
  return { seeds, failures };
}
