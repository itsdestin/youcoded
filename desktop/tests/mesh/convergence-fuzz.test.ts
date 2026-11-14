// Convergence fuzz (second-round review). The fast slice below runs in the normal suite with fixed seeds, including one family of seeds per
// class the review found (N1 an undelivered entry, N2 forged entries naming a real signer, N3 concurrent removals, N7 ghost devices of a
// removed member, N8 a pairing whose host was away). The long run is opt-in:
//   MESH_FUZZ_FROM=0 MESH_FUZZ_TO=25000 npx vitest run tests/mesh/convergence-fuzz.test.ts      (run several shards in parallel, at most 4)
// and prints every violating seed; a violating seed is replayed exactly by `MESH_FUZZ_FROM=<seed> MESH_FUZZ_TO=<seed+1>`.
import fs from 'fs';
import { describe, expect, it } from 'vitest';
import { runSchedule, type RunOptions, type Scenario } from './convergence-model';

const from = process.env.MESH_FUZZ_FROM !== undefined ? Number(process.env.MESH_FUZZ_FROM) : null;
const to = process.env.MESH_FUZZ_TO !== undefined ? Number(process.env.MESH_FUZZ_TO) : null;
const SCENARIOS: Scenario[] = ['random', 'random', 'random', 'n1', 'n2', 'n3', 'n7', 'n8'];
const optsFor = (seed: number): RunOptions => {
  const scenario = SCENARIOS[seed % SCENARIOS.length];
  return { seed, scenario, hostile: scenario === 'random' ? seed % 5 === 0 : undefined, mutual: seed % 7 === 3 ? 'first-admitted' : 'both' };
};

describe('convergence fuzz: fast slice (fixed seeds)', () => {
  it('every scenario family, 16 seeds each, ends converged with no violation', async () => {
    const bad: string[] = [];
    for (let seed = 1; seed <= 16 * SCENARIOS.length; seed++) {
      const r = await runSchedule(optsFor(seed));
      for (const v of r.violations) bad.push(`seed ${seed} (${r.scenario}): ${v}`);
    }
    expect(bad).toEqual([]);
  }, 600_000);
  for (const [name, scenario] of [['N1 an entry that never left its author', 'n1'], ['N2 forged entries naming a real signer', 'n2'], ['N3 concurrent removals', 'n3'], ['N7 ghost devices of a removed member', 'n7'], ['N8 a pairing whose host stayed away', 'n8']] as const) {
    it(`${name}: seeds ${scenario} 1..12 converge`, async () => {
      const bad: string[] = [];
      for (let seed = 1; seed <= 12; seed++) {
        const r = await runSchedule({ seed: seed * 1000 + 1, scenario, mutual: seed % 2 ? 'both' : 'first-admitted' });
        for (const v of r.violations) bad.push(`seed ${seed * 1000 + 1}: ${v}`);
      }
      expect(bad).toEqual([]);
    }, 300_000);
  }
});

describe.skipIf(from === null)('convergence fuzz: long run (opt-in)', () => {
  it(`seeds ${from}..${to}`, async () => {
    const bad: string[] = [];
    let n = 0;
    for (let seed = from as number; seed < (to as number); seed++) {
      let r;
      try { r = await runSchedule(optsFor(seed)); } catch (e) { bad.push(`seed ${seed}: threw ${(e as Error).message}`); continue; }
      n++;
      for (const v of r.violations) bad.push(`seed ${seed} (${r.scenario}): ${v}`);
    }
    const summary = `FUZZ-RESULT seeds=${from}..${to} schedules=${n} violations=${bad.length}\n${bad.slice(0, 200).join('\n')}\n`;
    console.log(summary);
    if (process.env.MESH_FUZZ_OUT) fs.writeFileSync(process.env.MESH_FUZZ_OUT, summary);
    if (bad.length) console.log(`FUZZ-VIOLATIONS\n${bad.slice(0, 40).join('\n')}`);
    expect(bad).toEqual([]);
  }, 24 * 3_600_000);
});
