import type { Op } from '@crdt-notes/crdt';

/**
 * The replica's durable state in IndexedDB: its id and every op it has
 * applied. Reloading replays the ops, so the notes survive a closed tab, a
 * restart, and any length of time offline.
 */
export class OpStore {
  private constructor(private readonly db: IDBDatabase) {}

  static open(name = 'crdt-notes'): Promise<OpStore> {
    return new Promise((ok, fail) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('ops', { keyPath: ['id.r', 'seq'] });
        req.result.createObjectStore('meta');
      };
      req.onsuccess = () => ok(new OpStore(req.result));
      req.onerror = () => fail(req.error);
    });
  }

  private tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise((ok, fail) => {
      const req = run(this.db.transaction(store, mode).objectStore(store));
      req.onsuccess = () => ok(req.result);
      req.onerror = () => fail(req.error);
    });
  }

  replicaId(): Promise<string | undefined> {
    return this.tx('meta', 'readonly', (s) => s.get('replica'));
  }

  setReplicaId(id: string): Promise<IDBValidKey> {
    return this.tx('meta', 'readwrite', (s) => s.put(id, 'replica'));
  }

  ops(): Promise<Op[]> {
    return this.tx('ops', 'readonly', (s) => s.getAll());
  }

  put(op: Op): Promise<IDBValidKey> {
    return this.tx('ops', 'readwrite', (s) => s.put(op));
  }
}
