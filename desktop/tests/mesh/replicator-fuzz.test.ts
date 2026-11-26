// Seeded fuzz of the replicator against its own plain-array oracle (replicator-model.ts). A fast slice runs in the normal suite; long runs are opt-in:
//   MESH_REPLICATOR_FUZZ_SEEDS=2000 MESH_REPLICATOR_FUZZ_START=10000 npx vitest run tests/mesh/replicator-fuzz.test.ts
// A failure names the seed; rerun it alone with MESH_REPLICATOR_FUZZ_SEEDS=1 MESH_REPLICATOR_FUZZ_START=<seed>.
import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runSeed } from './replicator-model';

const N = Number(process.env.MESH_REPLICATOR_FUZZ_SEEDS ?? 0);
const START = Number(process.env.MESH_REPLICATOR_FUZZ_START ?? 1);
const LONG = N > 0;
const SEEDS = LONG ? N : 10;

// Seeds that once failed, kept as regression tests (each takes about a second): 605068 two live incarnations after an out-of-band retire raced a step; 616864 and 505206 an in-sync claim with
// lines missing; 601614 a serve session still open at the end; 300584 a second history after the only peer heard was repairing; 300026 a recopy that finished by forking.
describe('replicator fuzz: seeds that once failed', () => {
  for (const seed of [605068, 616864, 505206, 601614, 300584, 300026, 400382, 400398, 400712]) {
    it(`seed ${seed} passes`, async () => { await runSeed(seed); }, 300_000);
  }
});

describe('replicator fuzz', () => {
  it(`${SEEDS} seeds from ${START}: prefix of the oracle, in-sync means complete, nothing acknowledged is silently lost, nothing parked`, async () => {
    const ops: Record<string, number> = {}; const excuses: Record<string, number> = {};
    const failed: string[] = [];
    for (let seed = START; seed < START + SEEDS; seed++) {
      // a long run keeps going after a failing seed and lists every one at the end (a short slice stops at the first)
      const r = await runSeed(seed).catch((e: unknown) => { if (!LONG) throw e; failed.push(e instanceof Error ? e.message : String(e)); return null; });
      if (!r) continue;
      for (const [k, v] of Object.entries(r.ops)) ops[k] = (ops[k] ?? 0) + v;
      for (const e of r.excuses) { const k = e.split(':').slice(2).join(':'); excuses[k] = (excuses[k] ?? 0) + 1; }
    }
    // the counts go to a file (vitest hides a passing test's console); MESH_REPLICATOR_FUZZ_OUT names it
    if (process.env.MESH_REPLICATOR_FUZZ_OUT) fs.appendFileSync(process.env.MESH_REPLICATOR_FUZZ_OUT, `${JSON.stringify({ seeds: SEEDS, start: START, ops, excuses })}\n`);
    if (process.env.MESH_REPLICATOR_FUZZ_OUT && failed.length) fs.appendFileSync(process.env.MESH_REPLICATOR_FUZZ_OUT, `${JSON.stringify({ failed })}\n`);
    expect(failed).toEqual([]);
    expect(Object.values(ops).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  }, 24 * 3_600_000);
});
