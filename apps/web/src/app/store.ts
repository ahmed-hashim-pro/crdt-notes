import { Injectable, computed, signal } from '@angular/core';
import { Replica, type NoteView, type Op } from '@crdt-notes/crdt';
import { OpStore } from './idb';

/** The local replica, its persistence, and signals for the UI. */
@Injectable({ providedIn: 'root' })
export class NotesStore {
  replica!: Replica;
  private db!: OpStore;
  /** Bumped on every op, local or remote: the UI's change signal. */
  readonly version = signal(0);
  readonly ready = signal(false);
  /** Local ops, for the sync service to send. */
  onLocal: (op: Op) => void = () => {};

  readonly notes = computed<NoteView[]>(() => {
    this.version();
    return this.ready() ? this.replica.notesList() : [];
  });
  readonly live = computed(() => this.notes().filter((n) => !n.deleted));
  readonly trash = computed(() => this.notes().filter((n) => n.deleted));

  async init(): Promise<void> {
    this.db = await OpStore.open();
    let id = await this.db.replicaId();
    if (!id) {
      const bytes = crypto.getRandomValues(new Uint8Array(4));
      id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
      await this.db.setReplicaId(id);
    }
    this.replica = new Replica(id);
    for (const op of await this.db.ops()) this.replica.receive(op);
    this.replica.onOp((op, local) => {
      void this.db.put(op);
      if (local) this.onLocal(op);
      this.version.update((v) => v + 1);
    });
    this.ready.set(true);
  }

  receive(ops: Op[]): void {
    for (const op of ops) {
      try {
        this.replica.receive(op);
      } catch (e) {
        // The replica refused a bad op and is unchanged; keep the rest.
        console.warn((e as Error).message);
      }
    }
  }
}
