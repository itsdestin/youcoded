import { describe, it, expect } from 'vitest';
// The test-engine is plain .mjs; tsc resolves it via allowJs, so no directive is needed.
import { comparisonNoiseWarning } from '../test-engine/harness-eval.mjs';

// WHY this exists (2026-09-05): a session paid for an 8-cell before/after run at
// one run per cell, reported the gap as a finding, and had to retract it — a
// re-run of the SAME builds moved the judged scores by as much as the effect.
// The report said "one run is noise" in prose and prose did not stop it.
const cells = (...builds: string[]) => builds.map((buildId, i) => ({ buildId, cellId: `c${i}` }));

describe('comparisonNoiseWarning', () => {
  it('warns when two or more build arms run once each — the case that misled a session', () => {
    const w = comparisonNoiseWarning({}, cells('before', 'after'));
    expect(w).toBeTruthy();
    expect(w).toContain('2 build arms');
    expect(w).toContain('--repeats');
  });

  it('counts arms, not cells: three arms across many cells still reads as three', () => {
    const w = comparisonNoiseWarning({}, cells('a', 'a', 'b', 'b', 'c', 'c'));
    expect(w).toContain('3 build arms');
  });

  it('stays silent once the plan asks for repeats — the warning is not nagging', () => {
    expect(comparisonNoiseWarning({ repeats: 2 }, cells('before', 'after'))).toBeNull();
  });

  it('stays silent for a single-arm plan — one run of one build is a smoke test, not a comparison', () => {
    expect(comparisonNoiseWarning({}, cells('current', 'current'))).toBeNull();
  });
});
