# crdt-notes

[![CI](https://github.com/ahmed-hashim-pro/crdt-notes/actions/workflows/ci.yml/badge.svg)](https://github.com/ahmed-hashim-pro/crdt-notes/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A local-first notes app. Every browser keeps the whole notebook, works with
no network at all, and merges with the others when it can reach them. There
are no conflicts to resolve and no server deciding who wins. The merging is
a CRDT written from scratch in TypeScript, and a fuzzer checks that replicas
converge under a hostile network.

"Eventually consistent" is easy to claim and hard to check. A CRDT that
merges correctly in every demo can still diverge when two edits land at the
same character, or a delete overtakes the insert it deletes, or a message
turns up twice. This repository treats convergence as a claim to test:

```
$ npm run fuzz -- mutants --seeds 2000
variant                   result   first seed  seeds failed  caught by
correct                   clean    -           0 of 2000     every check held
arrival-order-tie-break   caught   1           95%           convergence
no-causal-buffer          caught   1           100%          convergence
forget-tombstones         caught   1           88%           convergence, order independence
lww-by-arrival            caught   1           88%           convergence, order independence
remove-unobserved         caught   1           70%           convergence, order independence
accept-duplicates         caught   1           93%           convergence, local intent
```

The first row is the real implementation over 2,000 hostile seeds. The others
are six known ways to get a CRDT wrong, each behind a switch, and the fuzzer
catches every one. CI also runs the correct build on 5,000 seeds on every push.

![Two browsers side by side, in three steps: online, A types a grocery list and B sees it; both offline, A adds "bread" and a tag while B adds "TODO" at the top, "coffee" at the end and renames the note; back online, both show the same merged note "Groceries for Sat" with TODO, milk, eggs, coffee and bread, and the tag](docs/converge.gif)

*Recorded by the end-to-end test (`make demo`). Two browser contexts with
separate storage edit the same note while both are offline, then reconnect.*

## Quickstart

You need Node 22.22 or newer.

```bash
git clone https://github.com/ahmed-hashim-pro/crdt-notes && cd crdt-notes
npm ci
npm test                        # CRDT unit tests, 500 fuzz seeds, the six bugs, the relay
npm run build                   # the CRDT package and the Angular app
npm start                       # relay + app on http://127.0.0.1:8787
```

Open http://127.0.0.1:8787 in two browsers, or in a normal and a private
window, which have separate storage. Use the switch in the top right to take
either one offline, edit both, and switch them back.

```bash
npm run fuzz -- hunt --seeds 5000             # the correct CRDT on 5,000 seeds
npm run fuzz -- mutants --seeds 2000          # the table above
npm run fuzz -- run --seed 7 --bug arrival-order-tie-break   # replay one
npx playwright install --with-deps chromium   # browser + its system libraries (uses sudo on Linux)
npm run e2e                                    # the two-browser test
```

## How it is built

```
packages/crdt   the CRDT and the fuzzer; no runtime dependencies
apps/relay      store-and-forward WebSocket relay that also serves the app
apps/web        Angular (standalone components, signals, zoneless)
e2e             Playwright: two browsers, offline edits, reconnect
```

### The CRDT

A replica holds every note, and every change is an **op**: create a note,
set a title, add or remove a tag, insert text, delete text. Each op has a
Lamport id: a counter bigger than any the replica has seen, plus the replica
id to break ties. Ids are unique and totally ordered, and an op's id is
greater than that of anything it could have known about.

- **Text is a sequence CRDT: RGA**, the Replicated Growable Array.
  - Each character is an element with an id. An insert names the character
    it goes after, never an index: indexes shift under concurrent edits,
    while ids don't.
  - When two replicas insert after the same character at once, the greater
    id goes first, and everything typed after it stays with it. Every
    replica makes that choice the same way, whatever order the ops arrived
    in.
  - A delete only marks its characters as deleted (a **tombstone**). An
    insert typed next to a character someone else just deleted still has
    something to anchor to.
- **Title and the deleted flag are last-writer-wins registers.** The value
  with the greatest op id wins. Deleting a note is a flag, so it can be
  undone, and an edit made offline to a note someone else deleted isn't lost.
- **Tags are an observed-remove set.** A removal cancels only the adds its
  replica had seen, so a tag added concurrently with its removal survives
  (add wins).
- **Causal delivery.** Each op carries the version vector of what its
  replica had applied. A receiver holds an op until everything it depends on
  has arrived. An insert never arrives before the character it follows, and
  a delete never arrives before what it deletes. Duplicates are recognised
  by (replica, sequence number) and ignored.
- **Bad ops are refused whole.** A malformed op, or one that names a note or
  character that still isn't there once its dependencies are, is rejected
  before it touches anything: the log, the version vector and the notes are
  as if it never arrived.

There's no merge function to get wrong: a replica's state is just its ops,
applied in causal order. Reloading the page replays the op log from
IndexedDB.

### The relay

The relay stores ops and forwards them. It has no authority:
- It doesn't merge, order or reject any edit. It only refuses a message
  whose ops aren't well-formed, by closing the socket, so a broken client
  can't send other replicas something they would have to throw on.
- It doesn't have to stay up.
- It can lose its data without losing an edit, as long as some replica
  still holds it.

On connect, each side sends its version vector and receives what it lacks.
After that, new ops are forwarded as they arrive. It's under 200 lines,
using `ws`, and it also serves the built app, so `npm start` is the whole
demo.

### The app

Angular with signals throughout:
- A signal bumped on every op drives the note list and the editor.
- Every keystroke becomes at most one delete and one insert, diffed against
  the current text.
- When a remote edit changes the text you're typing in, your cursor stays
  next to the same characters, not at the same offset. The selection is
  held as the ids of the characters before each end.

## How the convergence is checked

`packages/crdt/src/fuzz.ts`. A seed describes a whole run:
- 2–5 replicas making random edits (typing runs, pastes, deletes, titles,
  tags, deletion and restore) on up to three notes
- a network that delays and reorders ops, and drops or duplicates them
  (up to 30% each)
- partitions that come and go

Each seed draws its own profile (swarm testing), so some runs are calm and
some are a storm of one kind. Then the network heals and the replicas
exchange whatever they're missing, and five checks run:

| Check | What it rules out |
|---|---|
| **Convergence**: every replica's state is identical, *tombstones and their order included* | divergence, including divergence the text doesn't show yet |
| **Order independence**: a fresh replica fed every op in a random order, and again in another, reaches the same state | results that depend on delivery order |
| **Nothing lost, nothing invented**: the visible characters are exactly those inserted and never deleted, each once | "converging" by dropping or duplicating ops |
| **Local intent**: every local edit does to its replica's text exactly what a plain string edit would | an editor that merges correctly but types in the wrong place |
| **Nothing stuck**: no replica is left holding ops it can't apply | causal delivery that waits forever |

Convergence on its own is easy to fake. Replicas that ignore every remote op
all agree, on nothing. That's why the third and fourth checks are there. The
first check compares tombstones too because, with the arrival-order bug,
seed 7 diverges with identical visible text: the replicas disagree only in
the order of deleted characters. The next concurrent insert near them would
have shown it.

### The deliberate bugs

| Bug | What it does wrong |
|---|---|
| `arrival-order-tie-break` | orders concurrent inserts at one spot by arrival instead of by id |
| `no-causal-buffer` | applies ops as they arrive, before the ops they depend on |
| `forget-tombstones` | removes deleted characters instead of keeping tombstones |
| `lww-by-arrival` | lets the last title to arrive win, not the highest id |
| `remove-unobserved` | a tag removal also cancels concurrent adds it never saw |
| `accept-duplicates` | applies a duplicated op a second time |

Each is in `Replica` behind a flag (`Bugs`). `npm test` fails if any of them
survives 200 seeds.

## How it is tested

`npm test`:

- **CRDT (20 tests).**
  - Local edits behave like a string, surrogate pairs included.
  - Concurrent inserts at one spot, concurrent typed runs (no interleaving),
    an insert next to a concurrent delete, and title races.
  - Add-wins tags, and deleting and restoring a note.
  - Causal buffering, including dependencies through a third replica.
  - Duplicates are ignored.
  - Rebuilding from the op log, as after a reload.
  - Malformed ops, and ops naming a note or character the replica doesn't
    have, are rejected and leave its state unchanged.
  - Cursor tracking.
  - One test pins a known limitation (below).
- **Fuzzer (10 tests).**
  - 500 seeds of the correct CRDT; `FUZZ_SEEDS` raises it.
  - Determinism per seed.
  - The runs are actually hostile: over 100 seeds, more than 10,000 ops,
    2,000 dropped and 1,000 duplicated, and 50 partitions.
  - Profiles vary.
  - Each of the six bugs is caught.
- **Relay (7 tests).**
  - It forwards to others but not back to the sender.
  - A newcomer gets exactly what it lacks.
  - Each op is stored once.
  - A restart reloads from the data file and skips a torn last line.
  - Garbage closes the socket instead of crashing the relay.
  - Malformed ops are neither stored nor forwarded.
  - The app is served, with an index.html fallback and no path traversal.

`npm run e2e` (2 tests) runs the real app in two browser contexts against
the real relay:
- They edit offline and converge on reconnect.
- The note survives a reload from IndexedDB.
- An edit made while one side was offline arrives later.

CI runs:
- typecheck, tests and the build on Node 22 and 24
- the 5,000-seed hunt and the mutant table
- the Playwright tests in Chromium

## What this does not do

- **RGA interleaves backward typing.** Typing forward keeps runs together.
  But if two people concurrently type at the same spot by repeatedly
  inserting at the *start*, as in some prepend workflows, their characters
  can interleave. Fugue (Weidner & Kleppmann, 2023) avoids this, and RGA
  doesn't. A test pins the behaviour so a change is noticed.
- **Tombstones are never collected.** Deleted characters stay forever, and
  so does every op in the log. Garbage collection needs to know that every
  replica has seen a delete, which takes membership tracking this project
  doesn't do.
- **Plain text only.** No rich text, no formatting marks, no move
  operations: moving a paragraph is a delete plus an insert.
- **No authentication or encryption.** Anyone who can reach the relay can
  read and write every note. A real deployment would put it behind auth and
  could end-to-end encrypt ops, since the relay never needs to read them.
- **One op per character element.** Fine for notes; a book-length document
  would want run-length-encoded elements.
- **The fuzzer is evidence, not proof.** It ran about 20,000 hostile schedules
  for this README, and the mutants show it would catch these six mistakes. It
  doesn't prove convergence the way a mechanised proof of RGA does.

## License

MIT
