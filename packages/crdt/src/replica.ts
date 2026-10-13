import { compareIds, key, type MetaKey, type Op, type OpId, type ReplicaId, type VersionVector } from './types.js';

/**
 * Deliberate mistakes, each a known way to build a CRDT that does not
 * converge. They exist so the fuzzer can show it would notice: every one
 * must be caught, and the correct replica never.
 */
export interface Bugs {
  /** Place concurrent inserts at the same spot in arrival order, not id order. */
  arrivalOrderTieBreak?: boolean;
  /** Apply ops as they arrive, without waiting for the ops they depend on. */
  noCausalBuffer?: boolean;
  /** Remove deleted characters instead of keeping tombstones. */
  forgetTombstones?: boolean;
  /** Let the last-arriving title or deleted flag win, not the highest id. */
  lwwByArrival?: boolean;
  /** Remove every add of a tag, including concurrent ones the remover never saw. */
  removeUnobserved?: boolean;
  /** Apply a duplicated op again. */
  acceptDuplicates?: boolean;
}

interface Elem {
  readonly key: string;
  readonly id: OpId;
  readonly ch: string;
  deleted: boolean;
}

interface Register {
  value: string | boolean;
  id: OpId;
}

class NoteState {
  readonly meta = new Map<MetaKey, Register>();
  /** tag -> keys of the adds that are still in effect */
  readonly tags = new Map<string, Set<string>>();
  /** The sequence, tombstones included, in document order. */
  readonly seq: Elem[] = [];
  readonly byKey = new Map<string, Elem>();
  constructor(readonly id: string) {}

  text(): string {
    let s = '';
    for (const e of this.seq) if (!e.deleted) s += e.ch;
    return s;
  }

  /** Visible characters, as elements. */
  visible(): Elem[] {
    return this.seq.filter((e) => !e.deleted);
  }
}

export interface NoteView {
  id: string;
  title: string;
  deleted: boolean;
  tags: string[];
  text: string;
}

export type Listener = (op: Op, local: boolean) => void;

export class Replica {
  private clock = 0;
  private ownSeq = 0;
  private readonly vv: VersionVector = {};
  private readonly log: Op[] = [];
  private buffer: Op[] = [];
  private readonly notes = new Map<string, NoteState>();
  private readonly listeners = new Set<Listener>();

  constructor(
    readonly id: ReplicaId,
    readonly bugs: Bugs = {},
  ) {
    if (!id || id.includes('@')) throw new Error(`bad replica id ${JSON.stringify(id)}`);
  }

  // ---- reading -------------------------------------------------------------

  version(): VersionVector {
    return { ...this.vv };
  }

  /** Every op applied here, in the order applied. Enough to rebuild the replica. */
  ops(): readonly Op[] {
    return this.log;
  }

  /** Ops received but waiting for ops they depend on. */
  pending(): number {
    return this.buffer.length;
  }

  /** The ops this replica has that a replica at `vv` lacks. */
  missingFor(vv: VersionVector): Op[] {
    return this.log.filter((op) => op.seq > (vv[op.id.r] ?? 0));
  }

  notesList(): NoteView[] {
    return [...this.notes.keys()].sort().map((id) => this.note(id)!);
  }

  note(id: string): NoteView | undefined {
    const n = this.notes.get(id);
    if (!n) return undefined;
    return {
      id,
      title: (n.meta.get('title')?.value as string | undefined) ?? '',
      deleted: (n.meta.get('deleted')?.value as boolean | undefined) ?? false,
      tags: [...n.tags].filter(([, adds]) => adds.size > 0).map(([t]) => t).sort(),
      text: n.text(),
    };
  }

  text(note: string): string {
    return this.state(note).text();
  }

  /** Keys of the visible characters, in order. */
  visibleKeys(note: string): string[] {
    return this.state(note).visible().map((e) => e.key);
  }

  /** The key of the visible character at `index`, for cursor tracking. */
  charKey(note: string, index: number): string | null {
    return this.state(note).visible()[index]?.key ?? null;
  }

  /** The visible index just after character `k` (0 for null or a deleted run at the start). */
  indexAfter(note: string, k: string | null): number {
    if (k === null) return 0;
    let i = 0;
    for (const e of this.state(note).seq) {
      if (!e.deleted) i++;
      if (e.key === k) return i;
    }
    return 0;
  }

  /**
   * Everything that must be equal on two converged replicas, tombstones and
   * their order included, as one string.
   */
  snapshot(): string {
    const out = [...this.notes.keys()].sort().map((id) => {
      const n = this.notes.get(id)!;
      return {
        ...this.note(id),
        seq: n.seq.map((e) => (e.deleted ? `~${e.key}` : e.key)).join(' '),
      };
    });
    return JSON.stringify(out);
  }

  onOp(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- local edits -----------------------------------------------------------

  createNote(title = ''): string {
    const op = this.emit({ t: 'create', note: '' });
    if (title) this.setTitle(op.note, title);
    return op.note;
  }

  setTitle(note: string, title: string): void {
    this.state(note);
    this.emit({ t: 'set', note, key: 'title', value: title });
  }

  setDeleted(note: string, deleted: boolean): void {
    this.state(note);
    this.emit({ t: 'set', note, key: 'deleted', value: deleted });
  }

  addTag(note: string, tag: string): void {
    this.state(note);
    if (!tag) throw new Error('empty tag');
    this.emit({ t: 'tag+', note, tag });
  }

  removeTag(note: string, tag: string): void {
    const adds = this.state(note).tags.get(tag);
    if (!adds || adds.size === 0) return;
    this.emit({ t: 'tag-', note, tag, removes: [...adds].sort() });
  }

  insertText(note: string, index: number, text: string): void {
    const vis = this.state(note).visible();
    if (index < 0 || index > vis.length) throw new RangeError(`index ${index} outside 0..${vis.length}`);
    if (!text) return;
    this.emit({ t: 'ins', note, after: index === 0 ? null : vis[index - 1].key, text });
  }

  deleteText(note: string, index: number, length: number): void {
    const vis = this.state(note).visible();
    if (index < 0 || length < 0 || index + length > vis.length) {
      throw new RangeError(`range ${index}+${length} outside 0..${vis.length}`);
    }
    if (length === 0) return;
    this.emit({ t: 'del', note, targets: vis.slice(index, index + length).map((e) => e.key) });
  }

  /** Turns the note's text into `next` with one delete and one insert at most. */
  replaceText(note: string, next: string): void {
    const prev = this.text(note);
    if (prev === next) return;
    const a = [...prev];
    const b = [...next];
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
      endA--;
      endB--;
    }
    // Work in UTF-16 code units, as the sequence stores them.
    const unitStart = a.slice(0, start).join('').length;
    const removed = a.slice(start, endA).join('').length;
    this.deleteText(note, unitStart, removed);
    this.insertText(note, unitStart, b.slice(start, endB).join(''));
  }

  // ---- remote ops ------------------------------------------------------------

  /**
   * Takes an op from elsewhere. It is applied once everything it depends on
   * has been; until then it waits. Duplicates are ignored. Returns how many
   * ops were applied as a result (it may release others that were waiting).
   */
  receive(op: Op): number {
    const dup = op.seq <= (this.vv[op.id.r] ?? 0);
    if (dup && !this.bugs.acceptDuplicates) return 0;
    if (this.bugs.noCausalBuffer || dup) {
      this.apply(op, false);
      return 1;
    }
    if (this.buffer.some((b) => b.id.r === op.id.r && b.seq === op.seq)) return 0;
    this.buffer.push(op);
    let applied = 0;
    for (let progress = true; progress; ) {
      progress = false;
      for (let i = 0; i < this.buffer.length; i++) {
        if (this.ready(this.buffer[i])) {
          const [next] = this.buffer.splice(i, 1);
          this.apply(next, false);
          applied++;
          progress = true;
          break;
        }
      }
    }
    return applied;
  }

  private ready(op: Op): boolean {
    if (op.seq !== (this.vv[op.id.r] ?? 0) + 1) return false;
    for (const [r, n] of Object.entries(op.deps)) {
      if (r !== op.id.r && (this.vv[r] ?? 0) < n) return false;
    }
    return true;
  }

  // ---- internals -------------------------------------------------------------

  private state(note: string): NoteState {
    const n = this.notes.get(note);
    if (!n) throw new Error(`no note ${note}`);
    return n;
  }

  private emit(partial: DistributiveOmit<Op, 'id' | 'seq' | 'deps'>): Op {
    const id: OpId = { c: this.clock + 1, r: this.id };
    const seq = this.ownSeq + 1;
    const op = { ...partial, id, seq, deps: { ...this.vv } } as Op;
    if (op.t === 'create') (op as { note: string }).note = key(id);
    this.apply(op, true);
    return op;
  }

  private apply(op: Op, local: boolean): void {
    // Lamport: the clock passes every id seen (an insert uses one per character).
    const last = op.t === 'ins' ? op.id.c + op.text.length - 1 : op.id.c;
    this.clock = Math.max(this.clock, last);
    if (op.id.r === this.id) this.ownSeq = Math.max(this.ownSeq, op.seq);
    this.vv[op.id.r] = Math.max(this.vv[op.id.r] ?? 0, op.seq);
    this.log.push(op);

    let n = this.notes.get(op.note);
    if (!n) {
      if (op.t !== 'create' && !this.bugs.noCausalBuffer) {
        throw new Error(`op ${key(op.id)} for unknown note ${op.note}: causal delivery broken`);
      }
      n = new NoteState(op.note);
      this.notes.set(op.note, n);
    }

    switch (op.t) {
      case 'create':
        break;
      case 'set': {
        const cur = n.meta.get(op.key);
        if (!cur || this.bugs.lwwByArrival || compareIds(op.id, cur.id) > 0) {
          n.meta.set(op.key, { value: op.value, id: op.id });
        }
        break;
      }
      case 'tag+': {
        let adds = n.tags.get(op.tag);
        if (!adds) n.tags.set(op.tag, (adds = new Set()));
        adds.add(key(op.id));
        break;
      }
      case 'tag-': {
        const adds = n.tags.get(op.tag);
        if (!adds) break;
        if (this.bugs.removeUnobserved) adds.clear();
        else for (const k of op.removes) adds.delete(k);
        break;
      }
      case 'ins':
        this.integrate(n, op);
        break;
      case 'del':
        for (const k of op.targets) {
          const e = n.byKey.get(k);
          if (!e) {
            if (this.bugs.noCausalBuffer || this.bugs.forgetTombstones) continue;
            throw new Error(`delete of unknown character ${k}: causal delivery broken`);
          }
          if (this.bugs.forgetTombstones) {
            n.seq.splice(n.seq.indexOf(e), 1);
            n.byKey.delete(k);
          } else {
            e.deleted = true;
          }
        }
        break;
    }
    for (const l of this.listeners) l(op, local);
  }

  /**
   * RGA. A character goes right after its anchor, except that it skips over
   * any run of characters with greater ids: those were inserted at the same
   * place concurrently (or after them), and the greater id goes first. Ids
   * grow with causality, so the run skipped is exactly the concurrent
   * siblings with greater ids and everything typed after them. Every
   * replica, whatever order it received the ops in, makes the same choice.
   */
  private integrate(n: NoteState, op: Extract<Op, { t: 'ins' }>): void {
    let anchor = op.after;
    let c = op.id.c;
    // One element per UTF-16 code unit, matching textarea indices.
    for (const ch of op.text.split('')) {
      const id: OpId = { c: c++, r: op.id.r };
      const k = key(id);
      if (n.byKey.has(k) && !this.bugs.acceptDuplicates) {
        anchor = k;
        continue;
      }
      let i: number;
      if (anchor === null) {
        i = 0;
      } else {
        const a = n.byKey.get(anchor);
        if (!a) {
          if (!this.bugs.noCausalBuffer && !this.bugs.forgetTombstones) {
            throw new Error(`insert after unknown character ${anchor}: causal delivery broken`);
          }
          i = n.seq.length; // the anchor is gone or not here yet: guess the end
        } else {
          i = n.seq.indexOf(a) + 1;
        }
      }
      if (!this.bugs.arrivalOrderTieBreak) {
        while (i < n.seq.length && compareIds(n.seq[i].id, id) > 0) i++;
      }
      const e: Elem = { key: k, id, ch, deleted: false };
      n.seq.splice(i, 0, e);
      n.byKey.set(k, e);
      anchor = k;
    }
  }
}

/** Omit that distributes over a union, keeping each member's own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
