import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect } from 'vitest';
import {
  mergeProjectEntries, readProjectRegistry, PROJECT_REGISTRY_SCHEMA,
  type ProjectRegistryEntry,
} from '../src/main/sync-spaces/project-registry';

const base: ProjectRegistryEntry = {
  schemaVersion: PROJECT_REGISTRY_SCHEMA,
  name: 'proj', repoName: 'proj-abc123', displayName: 'proj',
  state: 'active', updatedAt: 0,
  description: null, descriptionUpdatedAt: 0,
};

describe('mergeProjectEntries — description', () => {
  // THE regression this whole design exists to prevent: with a shared clock,
  // device B's description write would carry B's stale displayName and revert
  // device A's rename.
  it('keeps a rename and a description written on different devices', async () => {
    const a = { ...base, displayName: 'Renamed', updatedAt: 200 };
    const b = { ...base, description: 'my notes', descriptionUpdatedAt: 300 };
    const m = mergeProjectEntries(a, b);
    expect(m.displayName).toBe('Renamed');
    expect(m.description).toBe('my notes');
  });

  it('is commutative', async () => {
    const a = { ...base, displayName: 'Renamed', updatedAt: 200 };
    const b = { ...base, description: 'my notes', descriptionUpdatedAt: 300 };
    expect(mergeProjectEntries(a, b)).toEqual(mergeProjectEntries(b, a));
  });

  it('takes the newer description by its own clock', async () => {
    const a = { ...base, description: 'old', descriptionUpdatedAt: 100 };
    const b = { ...base, description: 'new', descriptionUpdatedAt: 200 };
    expect(mergeProjectEntries(a, b).description).toBe('new');
  });

  // stopped-dominance is unchanged and must stay unchanged.
  it('still lets stopped dominate regardless of description clocks', async () => {
    const a = { ...base, state: 'stopped' as const, updatedAt: 1 };
    const b = { ...base, description: 'x', descriptionUpdatedAt: 999 };
    expect(mergeProjectEntries(a, b).state).toBe('stopped');
  });

  // THE associativity guard. readProjectRegistry folds conflict copies in
  // fs.readdirSync order — which is filesystem-dependent — so a merge that is
  // only commutative is NOT enough: two devices holding byte-identical files
  // would otherwise display different descriptions.
  //
  // This case is built to break a description join whose equal-clock tiebreak
  // can see fields OTHER than the description. `a` and `b` share an EXACT
  // descriptionUpdatedAt (500) with different text, so the tiebreak decides;
  // `c` has an older description clock but a displayName that outranks a's
  // lexically. Fold (a,b) first and the tiebreak reads 'Zeta' vs 'Alpha';
  // fold (b,c) first and the accumulator carries 'Zzz', so the SAME tiebreak
  // reads 'Zzz' vs 'Zeta' and flips. Measured against the unwrapped version:
  // (a∘b)∘c = 'from A' while (b∘c)∘a = 'from B'.
  it('converges on the same record for every fold order, including an exact description-clock tie', async () => {
    const a = { ...base, displayName: 'Zeta',  updatedAt: 300, description: 'from A', descriptionUpdatedAt: 500 };
    const b = { ...base, displayName: 'Alpha', updatedAt: 100, description: 'from B', descriptionUpdatedAt: 500 };
    const c = { ...base, displayName: 'Zzz',   updatedAt: 200, description: 'from C', descriptionUpdatedAt: 400 };

    const permutations: ProjectRegistryEntry[][] = [
      [a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a],
    ];
    const folded = permutations.map(p => p.reduce((acc, e) => mergeProjectEntries(acc, e)));
    for (const f of folded) expect(f).toEqual(folded[0]);

    // And the winner must be decided by the DESCRIPTION, not by a neighbouring
    // field: 'from B' > 'from A' on the tiebreak, so B's text wins everywhere.
    expect(folded[0].description).toBe('from B');
    expect(folded[0].displayName).toBe('Zeta'); // still LWW by updatedAt (300)
  });
});

// THE schema trap, pinned. parseEntry is module-private, so this goes through
// readProjectRegistry against a real temp dir — which is also the honest test,
// since fail-soft-skip happens at the read layer.
describe('readProjectRegistry — records written by an older build', () => {
  it('reads a record that has no description instead of skipping it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
    const projectSync = path.join(dir, 'ProjectSync');
    fs.mkdirSync(projectSync, { recursive: true });
    // Exactly what a pre-description build writes: schema 1, no description keys.
    fs.writeFileSync(path.join(projectSync, 'proj.json'), JSON.stringify({
      schemaVersion: 1, name: 'proj', repoName: 'proj-abc123',
      displayName: 'Proj', state: 'active', updatedAt: 5,
    }));
    const out = (await readProjectRegistry(dir));
    expect(out).toHaveLength(1);           // NOT skipped
    expect(out[0].displayName).toBe('Proj');
    expect(out[0].description).toBeNull();
    expect(out[0].descriptionUpdatedAt).toBe(0);
  });

  it('caps an over-long description at read time', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
    const projectSync = path.join(dir, 'ProjectSync');
    fs.mkdirSync(projectSync, { recursive: true });
    fs.writeFileSync(path.join(projectSync, 'proj.json'), JSON.stringify({
      schemaVersion: 1, name: 'proj', repoName: 'proj-abc123',
      displayName: 'Proj', state: 'active', updatedAt: 5,
      description: 'x'.repeat(500), descriptionUpdatedAt: 9,
    }));
    expect((await readProjectRegistry(dir))[0].description).toHaveLength(200);
  });
});
