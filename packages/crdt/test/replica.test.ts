import { describe, expect, it } from 'vitest';
import { Replica, type Op } from '../src/index.js';

/** Delivers every op `from` has that `to` lacks. */
function sync(from: Replica, to: Replica): void {
  for (const op of from.missingFor(to.version())) to.receive(op);
}

function pair(): [Replica, Replica, string] {
  const a = new Replica('a');
  const b = new Replica('b');
  const note = a.createNote('shopping');
  sync(a, b);
  return [a, b, note];
}

describe('local editing behaves like a string', () => {
  it('inserts, deletes and replaces', () => {
    const r = new Replica('a');
    const n = r.createNote();
    r.insertText(n, 0, 'hello');
    r.insertText(n, 5, ' world');
    r.insertText(n, 0, '> ');
    r.deleteText(n, 2, 6);
    expect(r.text(n)).toBe('> world');
    r.replaceText(n, '> wide world!');
    expect(r.text(n)).toBe('> wide world!');
    r.replaceText(n, '');
    expect(r.text(n)).toBe('');
  });

  it('replaceText makes at most one delete and one insert', () => {
    const r = new Replica('a');
    const n = r.createNote();
    r.insertText(n, 0, 'the quick fox');
    const before = r.ops().length;
    r.replaceText(n, 'the slow brown fox');
    expect(r.ops().length - before).toBeLessThanOrEqual(2);
    expect(r.text(n)).toBe('the slow brown fox');
  });

  it('keeps surrogate pairs whole when diffing', () => {
    const r = new Replica('a');
    const n = r.createNote();
    r.replaceText(n, 'a😀b');
    r.replaceText(n, 'a😃b');
    expect(r.text(n)).toBe('a😃b');
  });

  it('rejects out-of-range edits', () => {
    const r = new Replica('a');
    const n = r.createNote();
    expect(() => r.insertText(n, 1, 'x')).toThrow(RangeError);
    expect(() => r.deleteText(n, 0, 1)).toThrow(RangeError);
    expect(() => r.setTitle('nope', 'x')).toThrow();
  });
});

describe('concurrent edits converge', () => {
  it('two inserts at the same spot land in the same order everywhere', () => {
    const [a, b, n] = pair();
    a.insertText(n, 0, 'milk');
    b.insertText(n, 0, 'eggs');
    sync(a, b);
    sync(b, a);
    expect(a.text(n)).toBe(b.text(n));
    expect(['milkeggs', 'eggsmilk']).toContain(a.text(n));
  });

  it('runs typed concurrently at one spot do not interleave', () => {
    const [a, b, n] = pair();
    for (const [i, ch] of [...'apples'].entries()) a.insertText(n, i, ch);
    for (const [i, ch] of [...'pears'].entries()) b.insertText(n, i, ch);
    sync(a, b);
    sync(b, a);
    expect(a.text(n)).toBe(b.text(n));
    expect(['applespears', 'pearsapples']).toContain(a.text(n));
  });

  it('an insert next to a concurrently deleted character survives, in place', () => {
    const [a, b, n] = pair();
    a.insertText(n, 0, 'abc');
    sync(a, b);
    a.deleteText(n, 1, 1); // delete b
    b.insertText(n, 2, 'X'); // after b
    sync(a, b);
    sync(b, a);
    expect(a.text(n)).toBe('aXc');
    expect(b.text(n)).toBe('aXc');
  });

  it('the title with the higher id wins on both sides', () => {
    const [a, b, n] = pair();
    a.setTitle(n, 'groceries');
    b.setTitle(n, 'errands');
    sync(a, b);
    sync(b, a);
    expect(a.note(n)!.title).toBe(b.note(n)!.title);
  });

  it('a tag added concurrently with its removal stays (add wins)', () => {
    const [a, b, n] = pair();
    a.addTag(n, 'home');
    sync(a, b);
    b.removeTag(n, 'home'); // removes the add b has seen
    a.addTag(n, 'home'); // a new add b has not
    sync(a, b);
    sync(b, a);
    expect(a.note(n)!.tags).toEqual(['home']);
    expect(b.note(n)!.tags).toEqual(['home']);
    b.removeTag(n, 'home');
    sync(b, a);
    expect(a.note(n)!.tags).toEqual([]);
  });

  it('deleting a note is a flag that can be undone', () => {
    const [a, b, n] = pair();
    a.setDeleted(n, true);
    sync(a, b);
    expect(b.note(n)!.deleted).toBe(true);
    b.setDeleted(n, false);
    sync(b, a);
    expect(a.note(n)!.deleted).toBe(false);
  });
});

describe('causal delivery', () => {
  it('holds an op until what it depends on arrives, then applies both', () => {
    const a = new Replica('a');
    const b = new Replica('b');
    const n = a.createNote();
    a.insertText(n, 0, 'x');
    const [create, ins] = a.ops();
    expect(b.receive(ins)).toBe(0);
    expect(b.pending()).toBe(1);
    expect(b.receive(create)).toBe(2);
    expect(b.pending()).toBe(0);
    expect(b.text(n)).toBe('x');
  });

  it('waits for a third replica\'s op that the sender had seen', () => {
    const a = new Replica('a');
    const b = new Replica('b');
    const c = new Replica('c');
    const n = a.createNote();
    sync(a, b);
    b.insertText(n, 0, 'hi'); // depends on a's create
    const fromB = b.ops().filter((op) => op.id.r === 'b');
    c.receive(fromB[0]);
    expect(c.pending()).toBe(1);
    sync(a, c);
    expect(c.pending()).toBe(0);
    expect(c.text(n)).toBe('hi');
  });

  it('ignores duplicates', () => {
    const a = new Replica('a');
    const b = new Replica('b');
    const n = a.createNote();
    a.insertText(n, 0, 'once');
    for (let i = 0; i < 3; i++) for (const op of a.ops()) b.receive(op);
    expect(b.text(n)).toBe('once');
    expect(b.ops().length).toBe(a.ops().length);
  });

  it('rebuilds from its own op log, as after a reload', () => {
    const a = new Replica('a');
    const n = a.createNote('t');
    a.insertText(n, 0, 'persisted');
    a.addTag(n, 'work');
    const saved: Op[] = JSON.parse(JSON.stringify(a.ops()));
    const again = new Replica('a');
    for (const op of saved) again.receive(op);
    expect(again.snapshot()).toBe(a.snapshot());
    // And keeps numbering its own ops where it left off.
    again.insertText(n, 0, '>');
    const mine = again.ops().filter((op) => op.id.r === 'a');
    expect(mine.at(-1)!.seq).toBe(mine.length);
    const b = new Replica('b');
    for (const op of again.ops()) b.receive(op);
    expect(b.text(n)).toBe('>persisted');
  });
});

describe('cursor tracking', () => {
  it('a character key finds its new index after a remote insert before it', () => {
    const [a, b, n] = pair();
    a.insertText(n, 0, 'world');
    sync(a, b);
    const k = b.charKey(n, 2); // after "wor"
    a.insertText(n, 0, 'hello ');
    sync(a, b);
    expect(b.indexAfter(n, k)).toBe(9);
    expect(b.indexAfter(n, null)).toBe(0);
  });
});

describe('a known RGA limitation', () => {
  // RGA keeps forward-typed runs together, but text typed backwards (each
  // character at the start, as with some right-to-left habits or "prepend"
  // edits) concurrently at the same spot can interleave. Fugue avoids this;
  // RGA does not. Pinned here so a change in behaviour is noticed.
  it('interleaves concurrent backward typing', () => {
    const [a, b, n] = pair();
    for (const ch of [...'cba']) a.insertText(n, 0, ch); // a types "abc" backwards
    for (const ch of [...'zyx']) b.insertText(n, 0, ch); // b types "xyz" backwards
    sync(a, b);
    sync(b, a);
    expect(a.text(n)).toBe(b.text(n));
    expect(['abcxyz', 'xyzabc']).not.toContain(a.text(n));
  });
});
