// The fuzzer from the command line:
//   node dist/cli.js hunt [--seeds N] [--start N] [--bug NAME]
//   node dist/cli.js mutants [--seeds N]
//   node dist/cli.js run --seed N [--bug NAME]
import { fuzz, hunt, MUTANTS, profileFor } from './fuzz.js';
import type { Bugs } from './replica.js';

function flag(args: string[], name: string, fallback: string): string {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

function bugsFor(name: string): Bugs {
  if (!name) return {};
  const m = MUTANTS.find((x) => x.name === name);
  if (!m) {
    console.error(`unknown bug ${name}; one of: ${MUTANTS.map((x) => x.name).join(', ')}`);
    process.exit(2);
  }
  return m.bugs;
}

const [cmd, ...args] = process.argv.slice(2);
const seeds = Number(flag(args, '--seeds', '2000'));
const start = Number(flag(args, '--start', '1'));
const bug = flag(args, '--bug', '');
const t0 = Date.now();

if (cmd === 'hunt') {
  const h = hunt(start, seeds, bugsFor(bug));
  console.log(`${h.seeds} seeds (${start}..${start + h.seeds - 1}) in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${h.failures.length} failed`);
  if (h.failures.length) {
    const f = h.failures[0];
    console.log(`first: seed ${f.seed}: ${f.failure}`);
    console.log(`replay: npm run fuzz -- run --seed ${f.seed}${bug ? ` --bug ${bug}` : ''}`);
    process.exit(1);
  }
} else if (cmd === 'run') {
  const seed = Number(flag(args, '--seed', '1'));
  const r = fuzz(seed, bugsFor(bug));
  console.log(`seed ${seed}${bug ? `, bug ${bug}` : ''}: profile ${JSON.stringify(profileFor(seed))}`);
  console.log(`  ${JSON.stringify(r.stats)}`);
  console.log(r.ok ? '  converged: all checks hold' : `  FAILED: ${r.failure}`);
  process.exit(r.ok ? 0 : 1);
} else if (cmd === 'mutants') {
  let code = 0;
  const row = (...cells: string[]) =>
    console.log(cells.map((c, i) => c.padEnd([26, 9, 12, 14, 0][i])).join(''));
  row('variant', 'result', 'first seed', 'seeds failed', 'caught by');
  const clean = hunt(1, seeds);
  if (clean.failures.length) {
    code = 1;
    row('correct', 'FAILED', String(clean.failures[0].seed), String(clean.failures.length), clean.failures[0].failure ?? '');
  } else row('correct', 'clean', '-', `0 of ${seeds}`, 'every check held');
  for (const m of MUTANTS) {
    const h = hunt(1, seeds, m.bugs);
    if (!h.failures.length) {
      code = 1;
      row(m.name, 'MISSED', '-', `0 of ${seeds}`, '');
      continue;
    }
    const checks = new Map<string, number>();
    for (const f of h.failures) checks.set(f.check!, (checks.get(f.check!) ?? 0) + 1);
    const by = [...checks].sort((x, y) => y[1] - x[1]).map(([c]) => c).join(', ');
    const pct = ((100 * h.failures.length) / seeds).toFixed(0);
    row(m.name, 'caught', String(h.failures[0].seed), `${pct}%`, by);
  }
  console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)}s. Replay one: npm run fuzz -- run --seed N --bug NAME`);
  process.exit(code);
} else {
  console.error('usage: cli.js hunt|run|mutants [--seeds N] [--start N] [--seed N] [--bug NAME]');
  process.exit(2);
}
