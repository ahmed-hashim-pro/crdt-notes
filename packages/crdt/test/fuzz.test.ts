import { describe, expect, it } from 'vitest';
import { fuzz, hunt, MUTANTS, profileFor } from '../src/index.js';

const SEEDS = Number(process.env.FUZZ_SEEDS ?? 500);

describe('the correct replica', () => {
  it(`converges on ${SEEDS} hostile seeds`, () => {
    const h = hunt(1, SEEDS);
    expect(h.failures.map((f) => `seed ${f.seed}: ${f.failure}`)).toEqual([]);
  });

  it('is deterministic per seed', () => {
    expect(fuzz(42)).toEqual(fuzz(42));
  });

  it('runs are actually hostile', () => {
    const total = { ops: 0, dropped: 0, duplicated: 0, partitions: 0, delivered: 0 };
    for (let s = 1; s <= 100; s++) {
      const st = fuzz(s).stats;
      for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += st[k];
    }
    expect(total.ops).toBeGreaterThan(10_000);
    expect(total.dropped).toBeGreaterThan(2_000);
    expect(total.duplicated).toBeGreaterThan(1_000);
    expect(total.partitions).toBeGreaterThan(50);
  });

  it('profiles vary across seeds', () => {
    const replicas = new Set<number>();
    const delays = new Set<number>();
    for (let s = 1; s <= 50; s++) {
      replicas.add(profileFor(s).replicas);
      delays.add(profileFor(s).maxDelay);
    }
    expect(replicas.size).toBe(4);
    expect(delays.size).toBe(3);
  });
});

// Every deliberate bug must be caught within a stated number of seeds. The
// bounds are generous next to today's first failing seed; a change that
// blinds the fuzzer to one of them fails here.
describe('every deliberate bug is caught', () => {
  for (const m of MUTANTS) {
    it(m.name, () => {
      const h = hunt(1, 200, m.bugs, true);
      expect(h.failures.length, `${m.name} survived 200 seeds`).toBe(1);
    });
  }
});
