/** A replica is one copy of the notes: one browser profile, one device. */
export type ReplicaId = string;

/**
 * A Lamport timestamp. `c` is the replica's logical clock when the op was
 * made, always greater than every clock the replica had seen, so an op's id
 * is greater than the id of anything it could know about. Ties between
 * replicas break on the replica id. Ids are therefore unique and totally
 * ordered, and the order respects causality.
 */
export interface OpId {
  readonly c: number;
  readonly r: ReplicaId;
}

/** Version vector: for each replica, how many of its ops have been applied. */
export type VersionVector = Record<ReplicaId, number>;

export type MetaKey = 'title' | 'deleted';

interface Base {
  /** Lamport id. For an insert of n characters, the characters get c..c+n-1. */
  readonly id: OpId;
  /** Position in its replica's own sequence of ops: 1, 2, 3, ... */
  readonly seq: number;
  /** What the replica had applied when it made the op. */
  readonly deps: VersionVector;
  /** The note it belongs to: the key of the note's `create` op. */
  readonly note: string;
}

export type Op =
  | (Base & { readonly t: 'create' })
  | (Base & { readonly t: 'set'; readonly key: MetaKey; readonly value: string | boolean })
  | (Base & { readonly t: 'tag+'; readonly tag: string })
  /** Removes the adds of `tag` its replica had seen, by key. */
  | (Base & { readonly t: 'tag-'; readonly tag: string; readonly removes: readonly string[] })
  /** Inserts `text` after the character `after` (null: at the start). */
  | (Base & { readonly t: 'ins'; readonly after: string | null; readonly text: string })
  | (Base & { readonly t: 'del'; readonly targets: readonly string[] });

export function key(id: OpId): string {
  return `${id.c}@${id.r}`;
}

export function compareIds(a: OpId, b: OpId): number {
  if (a.c !== b.c) return a.c - b.c;
  return a.r < b.r ? -1 : a.r > b.r ? 1 : 0;
}
