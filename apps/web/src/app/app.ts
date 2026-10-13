import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { NotesStore } from './store';
import { SyncService } from './sync';

@Component({
  selector: 'app-root',
  template: `
    <header>
      <h1>crdt-notes</h1>
      <span class="replica" title="This browser's replica id">replica {{ store.replica.id }}</span>
      <label class="switch" [class.on]="sync.wanted()">
        <input type="checkbox" data-testid="online" [checked]="sync.wanted()" (change)="sync.setOnline($any($event.target).checked)" />
        <span class="dot" [attr.data-state]="sync.state()"></span>
        <span data-testid="state">{{ sync.state() }}</span>
      </label>
    </header>
    <main>
      <nav>
        <button class="new" data-testid="new" (click)="create()">+ New note</button>
        <ul>
          @for (n of store.live(); track n.id) {
            <li [class.active]="n.id === note()?.id" (click)="selected.set(n.id)" data-testid="note">
              <strong>{{ n.title || 'Untitled' }}</strong>
              <small>{{ n.text.slice(0, 48) || 'Empty' }}</small>
            </li>
          } @empty {
            <li class="empty">No notes yet.</li>
          }
        </ul>
        @if (store.trash().length) {
          <details>
            <summary>Trash ({{ store.trash().length }})</summary>
            <ul>
              @for (n of store.trash(); track n.id) {
                <li (click)="restore(n.id)" title="Restore">↺ {{ n.title || 'Untitled' }}</li>
              }
            </ul>
          </details>
        }
      </nav>
      @if (note(); as n) {
        <section class="editor">
          <div class="row">
            <input class="title" data-testid="title" placeholder="Title" [value]="n.title" (input)="setTitle($any($event.target).value)" />
            <button class="delete" (click)="remove()" title="Move to trash">Delete</button>
          </div>
          <div class="tags">
            @for (t of n.tags; track t) {
              <span class="tag">{{ t }} <button (click)="removeTag(t)" [attr.aria-label]="'Remove tag ' + t">×</button></span>
            }
            <input placeholder="add tag ↵" data-testid="tag" (keydown.enter)="addTag($any($event.target))" />
          </div>
          <textarea
            #body
            data-testid="body"
            placeholder="Write here. Edits merge with every other replica, online or not."
            (input)="edit()"
            (keyup)="remember()"
            (click)="remember()"
            (select)="remember()"
          ></textarea>
          <footer>{{ n.text.length }} characters · {{ pending() }}</footer>
        </section>
      } @else {
        <section class="editor placeholder">Select a note, or make one.</section>
      }
    </main>
  `,
  styles: `
    :host { display: flex; flex-direction: column; height: 100vh; }
    header { display: flex; align-items: center; gap: 16px; padding: 10px 18px; border-bottom: 1px solid var(--line); }
    h1 { font-size: 17px; margin: 0; }
    .replica { font: 12px ui-monospace, monospace; color: var(--muted); }
    .switch { margin-left: auto; display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #8c959f; }
    .dot[data-state='online'] { background: #1a7f37; }
    .dot[data-state='connecting'] { background: #d4a72c; }
    main { flex: 1; display: grid; grid-template-columns: 240px 1fr; min-height: 0; }
    nav { border-right: 1px solid var(--line); overflow: auto; padding: 12px; }
    nav ul { list-style: none; margin: 8px 0; padding: 0; }
    nav li { padding: 8px 10px; border-radius: 6px; cursor: pointer; display: flex; flex-direction: column; gap: 2px; }
    nav li small { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    nav li.active { background: var(--accent-bg); }
    nav li.empty { color: var(--muted); cursor: default; }
    details { color: var(--muted); font-size: 13px; }
    .new { width: 100%; }
    .editor { display: flex; flex-direction: column; gap: 10px; padding: 16px 20px; min-height: 0; }
    .placeholder { color: var(--muted); justify-content: center; align-items: center; }
    .row { display: flex; gap: 10px; }
    .title { flex: 1; font-size: 20px; font-weight: 600; border: none; background: transparent; color: inherit; outline: none; }
    .tags { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .tag { background: var(--accent-bg); border-radius: 12px; padding: 2px 4px 2px 10px; font-size: 13px; }
    .tag button { border: none; background: none; color: inherit; cursor: pointer; padding: 0 4px; }
    .tags input { border: none; background: transparent; color: inherit; font-size: 13px; outline: none; }
    textarea { flex: 1; resize: none; font: 15px/1.55 ui-monospace, monospace; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper); color: inherit; }
    footer { font-size: 12px; color: var(--muted); }
    button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--paper); color: inherit; cursor: pointer; }
    .delete { color: #cf222e; }
  `,
})
export class App {
  protected readonly store = inject(NotesStore);
  protected readonly sync = inject(SyncService);
  protected readonly selected = signal<string | null>(null);
  private readonly body = viewChild<ElementRef<HTMLTextAreaElement>>('body');
  /** The selection, held as the characters before each end, so it survives remote edits. */
  private selection: [string | null, string | null] = [null, null];

  protected readonly note = computed(() => {
    const id = this.selected() ?? this.store.live()[0]?.id ?? null;
    return id ? (this.store.notes().find((n) => n.id === id && !n.deleted) ?? null) : null;
  });

  protected readonly pending = computed(() => {
    this.store.version();
    const n = this.store.ready() ? this.store.replica.pending() : 0;
    return n ? `${n} ops waiting for earlier ones` : 'all ops applied';
  });

  constructor() {
    // Remote edits: put the new text in, and the cursor back where it was
    // relative to the characters around it, not at a stale offset.
    effect(() => {
      const n = this.note();
      const el = this.body()?.nativeElement;
      if (!n || !el || el.value === n.text) return;
      const focused = document.activeElement === el;
      el.value = n.text;
      if (focused) {
        const [a, b] = this.selection;
        el.setSelectionRange(this.store.replica.indexAfter(n.id, a), this.store.replica.indexAfter(n.id, b));
      }
    });
  }

  protected create(): void {
    this.selected.set(this.store.replica.createNote(''));
  }

  protected setTitle(title: string): void {
    const n = this.note();
    if (n) this.store.replica.setTitle(n.id, title);
  }

  protected addTag(input: HTMLInputElement): void {
    const n = this.note();
    const tag = input.value.trim();
    if (n && tag && !n.tags.includes(tag)) this.store.replica.addTag(n.id, tag);
    input.value = '';
  }

  protected removeTag(tag: string): void {
    const n = this.note();
    if (n) this.store.replica.removeTag(n.id, tag);
  }

  protected remove(): void {
    const n = this.note();
    if (n) this.store.replica.setDeleted(n.id, true);
    this.selected.set(null);
  }

  protected restore(id: string): void {
    this.store.replica.setDeleted(id, false);
    this.selected.set(id);
  }

  protected edit(): void {
    const n = this.note();
    const el = this.body()?.nativeElement;
    if (!n || !el) return;
    this.store.replica.replaceText(n.id, el.value);
    this.remember();
  }

  protected remember(): void {
    const n = this.note();
    const el = this.body()?.nativeElement;
    if (!n || !el) return;
    const r = this.store.replica;
    this.selection = [r.charKey(n.id, el.selectionStart - 1), r.charKey(n.id, el.selectionEnd - 1)];
  }
}
