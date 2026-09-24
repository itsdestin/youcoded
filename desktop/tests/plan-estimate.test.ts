// Tests for estimatePlan — the proposed/re-frozen card's ONE estimate line
// (specialists plans, spending rework T5; backend design §4). Pure function:
// no filesystem, no clock — every input is built in-memory.
import { describe, it, expect } from 'vitest';
import { estimatePlan } from '../src/main/harness/plans/plan-estimate';
import type { ExecutionManifest } from '../src/main/harness/plans/types';
import type { PlanDocumentV1 } from '../src/main/harness/plans/schema';
import type { SpecialistUsageEntry, SpecialistUsageSnapshot } from '../src/main/harness/plans/specialist-usage-history';

const EMPTY_HISTORY: SpecialistUsageSnapshot = { entries: [] };

function manifestSteps(ids: string[], overrides: Partial<ExecutionManifest['steps'][string]> = {}): ExecutionManifest['steps'] {
  const out: ExecutionManifest['steps'] = {};
  for (const id of ids) {
    out[id] = {
      binding: { providerId: 'anthropic', modelId: 'claude' },
      label: 'claude',
      pricing: { kind: 'priced', rates: { in: 3, out: 15 } }, // $/M tokens
      source: 'default',
      ...overrides,
    };
  }
  return out;
}

function doc(steps: PlanDocumentV1['steps']): PlanDocumentV1 {
  return { goal: 'g', steps };
}

function usageEntry(over: Partial<SpecialistUsageEntry> = {}): SpecialistUsageEntry {
  return {
    childId: `c-${Math.random()}`, agentType: 'worker', providerId: 'anthropic', modelId: 'claude',
    usage: { uncached: 1000, cacheRead: 0, cacheWrite: 0, output: 100 },
    size: 1, mtimeMs: 1,
    ...over,
  };
}

describe('estimatePlan — fallback chain', () => {
  it('uses same-binding runs when there are at least 5', () => {
    const history: SpecialistUsageSnapshot = {
      entries: [
        ...Array.from({ length: 5 }, () => usageEntry({ agentType: 'worker', providerId: 'anthropic', modelId: 'claude', usage: { uncached: 1000, cacheRead: 0, cacheWrite: 0, output: 0 } })),
        // A same-agentType-but-different-model run that must be IGNORED once the same-binding tier qualifies.
        usageEntry({ agentType: 'worker', providerId: 'openrouter', modelId: 'other', usage: { uncached: 9_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } }),
      ],
    };
    const document = doc([{ id: 's1', kind: 'verify', specialist: 'worker', task: 't', summary: 's', of: 'x' }]);
    const est = estimatePlan(document, manifestSteps(['s1']), history);
    expect('lowUsd' in est).toBe(true);
    // 1000 uncached tokens at $3/M = $0.003, both low and high (all 5 runs identical).
    if ('lowUsd' in est) {
      expect(est.lowUsd).toBeCloseTo(0.003, 5);
      expect(est.highUsd).toBeCloseTo(0.003, 5);
    }
  });

  it('falls back to same-agentType (any model) when fewer than 5 share the exact binding', () => {
    const history: SpecialistUsageSnapshot = {
      entries: [
        usageEntry({ agentType: 'worker', providerId: 'anthropic', modelId: 'claude', usage: { uncached: 1000, cacheRead: 0, cacheWrite: 0, output: 0 } }),
        usageEntry({ agentType: 'worker', providerId: 'openrouter', modelId: 'other-model', usage: { uncached: 2000, cacheRead: 0, cacheWrite: 0, output: 0 } }),
      ],
    };
    const document = doc([{ id: 's1', kind: 'verify', specialist: 'worker', task: 't', summary: 's', of: 'x' }]);
    const est = estimatePlan(document, manifestSteps(['s1']), history);
    // Both of the 2 runs are used (priced at the STEP's own frozen rate, not
    // their own) — median of {1000,2000} tokens = 1500 -> $0.0045.
    expect('lowUsd' in est).toBe(true);
    if ('lowUsd' in est) expect(est.lowUsd).toBeCloseTo(0.0045, 5);
  });

  it('falls back to the built-in per-type default when history has nothing for this agentType', () => {
    const document = doc([{ id: 's1', kind: 'verify', specialist: 'reviewer', task: 't', summary: 's', of: 'x' }]);
    const est = estimatePlan(document, manifestSteps(['s1']), EMPTY_HISTORY);
    expect('lowUsd' in est).toBe(true);
    if ('lowUsd' in est) { expect(est.lowUsd).toBeGreaterThan(0); expect(est.highUsd).toBeGreaterThan(est.lowUsd); }
  });

  it('a custom specialist with no history and no type match falls back to the worker default when it can write', () => {
    const document = doc([{ id: 's1', kind: 'verify', specialist: 'my-custom-agent', task: 't', summary: 's', of: 'x' }]);
    const withWorker = estimatePlan(document, manifestSteps(['s1']), EMPTY_HISTORY, () => true);
    const workerAlone = estimatePlan(doc([{ id: 's1', kind: 'verify', specialist: 'worker', task: 't', summary: 's', of: 'x' }]), manifestSteps(['s1']), EMPTY_HISTORY);
    expect(withWorker).toEqual(workerAlone);
  });

  it('a custom specialist with no history falls back to the reviewer default when it cannot write', () => {
    const document = doc([{ id: 's1', kind: 'verify', specialist: 'my-custom-agent', task: 't', summary: 's', of: 'x' }]);
    const withReviewer = estimatePlan(document, manifestSteps(['s1']), EMPTY_HISTORY, () => false);
    const reviewerAlone = estimatePlan(doc([{ id: 's1', kind: 'verify', specialist: 'reviewer', task: 't', summary: 's', of: 'x' }]), manifestSteps(['s1']), EMPTY_HISTORY);
    expect(withReviewer).toEqual(reviewerAlone);
  });

  it('a custom specialist with no canWrite lookup at all defaults to the (conservative) worker row', () => {
    const document = doc([{ id: 's1', kind: 'verify', specialist: 'my-custom-agent', task: 't', summary: 's', of: 'x' }]);
    const est = estimatePlan(document, manifestSteps(['s1']), EMPTY_HISTORY);
    const workerAlone = estimatePlan(doc([{ id: 's1', kind: 'verify', specialist: 'worker', task: 't', summary: 's', of: 'x' }]), manifestSteps(['s1']), EMPTY_HISTORY);
    expect(est).toEqual(workerAlone);
  });
});

describe('estimatePlan — run counts', () => {
  const history: SpecialistUsageSnapshot = {
    entries: Array.from({ length: 5 }, () => usageEntry({ usage: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } })),
  };
  const RATE_PER_RUN = 1_000_000 / 1e6 * 3; // $3 per run at these fixed rates

  it('a split (map) step counts one run per item', () => {
    const document = doc([{ id: 's1', kind: 'map', specialist: 'worker', task: 't', summary: 's', items: ['a', 'b', 'c'] }]);
    const est = estimatePlan(document, manifestSteps(['s1']), history);
    if ('lowUsd' in est) expect(est.lowUsd).toBeCloseTo(RATE_PER_RUN * 3, 5);
  });

  it('a verify/combine step counts exactly one run regardless of anything else', () => {
    const verify = doc([{ id: 's1', kind: 'verify', specialist: 'worker', task: 't', summary: 's', of: 'x' }]);
    const combine = doc([{ id: 's1', kind: 'combine', specialist: 'worker', task: 't', summary: 's', of: 'x' }]);
    for (const document of [verify, combine]) {
      const est = estimatePlan(document, manifestSteps(['s1']), history);
      if ('lowUsd' in est) expect(est.lowUsd).toBeCloseTo(RATE_PER_RUN, 5);
    }
  });

  it('a repeat body counts 1 round for low and max_iterations for high', () => {
    const document = doc([{
      id: 'loop', kind: 'repeat', specialist: 'worker', task: 't', summary: 's', max_iterations: 4, until: 'done',
      steps: [{ id: 'body', kind: 'verify', specialist: 'worker', task: 't', summary: 's', of: 'x' }],
    }]);
    const est = estimatePlan(document, manifestSteps(['body']), history);
    if ('lowUsd' in est) {
      expect(est.lowUsd).toBeCloseTo(RATE_PER_RUN * 1, 5); // 1 round, low
      expect(est.highUsd).toBeCloseTo(RATE_PER_RUN * 4, 5); // max_iterations rounds, high
    }
  });

  it('a split step inside a repeat multiplies items by rounds', () => {
    const document = doc([{
      id: 'loop', kind: 'repeat', specialist: 'worker', task: 't', summary: 's', max_iterations: 3, until: 'done',
      steps: [{ id: 'body', kind: 'map', specialist: 'worker', task: 't', summary: 's', items: ['a', 'b'] }],
    }]);
    const est = estimatePlan(document, manifestSteps(['body']), history);
    if ('lowUsd' in est) {
      expect(est.lowUsd).toBeCloseTo(RATE_PER_RUN * 2 * 1, 5); // 2 items x 1 round
      expect(est.highUsd).toBeCloseTo(RATE_PER_RUN * 2 * 3, 5); // 2 items x 3 rounds
    }
  });
});

describe('estimatePlan — quantiles', () => {
  it('lowUsd sums each step\'s MEDIAN and highUsd sums each step\'s P90', () => {
    // Ten runs: 1..10 million uncached tokens. Median (p50) = 550k*... use
    // the same percentile method estimatePlan itself uses (index interp).
    const tokens = Array.from({ length: 10 }, (_, i) => (i + 1) * 100_000);
    const history: SpecialistUsageSnapshot = { entries: tokens.map((t) => usageEntry({ usage: { uncached: t, cacheRead: 0, cacheWrite: 0, output: 0 } })) };
    const document = doc([{ id: 's1', kind: 'verify', specialist: 'worker', task: 't', summary: 's', of: 'x' }]);
    const est = estimatePlan(document, manifestSteps(['s1']), history);
    expect('lowUsd' in est).toBe(true);
    if (!('lowUsd' in est)) return;
    // p50 index = (10-1)*0.5 = 4.5 -> interpolate tokens[4]=500k, tokens[5]=600k -> 550k
    // p90 index = (10-1)*0.9 = 8.1 -> interpolate tokens[8]=900k, tokens[9]=1,000,000 -> 910k
    expect(est.lowUsd).toBeCloseTo((550_000 / 1e6) * 3, 5);
    expect(est.highUsd).toBeCloseTo((910_000 / 1e6) * 3, 5);
  });
});

describe('estimatePlan — unpriced notes', () => {
  it('an all-local plan returns tokens + "runs on your computer"', () => {
    const document = doc([{ id: 's1', kind: 'verify', specialist: 'worker', task: 't', summary: 's', of: 'x' }]);
    const steps = manifestSteps(['s1'], { pricing: { kind: 'local' } });
    const est = estimatePlan(document, steps, EMPTY_HISTORY);
    expect(est).toMatchObject({ unpricedNote: 'runs on your computer' });
    if ('tokens' in est) expect(est.tokens).toBeGreaterThan(0);
  });

  it('an all-ChatGPT (free-kind) plan returns tokens + "included in your ChatGPT plan"', () => {
    const document = doc([{ id: 's1', kind: 'verify', specialist: 'worker', task: 't', summary: 's', of: 'x' }]);
    const steps = manifestSteps(['s1'], { pricing: { kind: 'free' } });
    const est = estimatePlan(document, steps, EMPTY_HISTORY);
    expect(est).toMatchObject({ unpricedNote: 'included in your ChatGPT plan' });
  });

  it('a plan with no published price at all returns tokens + "no published price"', () => {
    const document = doc([{ id: 's1', kind: 'verify', specialist: 'worker', task: 't', summary: 's', of: 'x' }]);
    const steps = manifestSteps(['s1'], { pricing: null });
    const est = estimatePlan(document, steps, EMPTY_HISTORY);
    expect(est).toMatchObject({ unpricedNote: 'no published price' });
  });

  it('an unrecognized pricing shape is tolerated as "no published price", never a crash', () => {
    const document = doc([{ id: 's1', kind: 'verify', specialist: 'worker', task: 't', summary: 's', of: 'x' }]);
    const steps = manifestSteps(['s1'], { pricing: { kind: 'some-future-kind', extra: 123 } as never });
    expect(() => estimatePlan(document, steps, EMPTY_HISTORY)).not.toThrow();
    expect(estimatePlan(document, steps, EMPTY_HISTORY)).toMatchObject({ unpricedNote: 'no published price' });
  });

  it('combines two different unpriced notes when steps are unpriced for different reasons', () => {
    const document = doc([
      { id: 's1', kind: 'verify', specialist: 'worker', task: 't', summary: 's', of: 'x' },
      { id: 's2', kind: 'verify', specialist: 'reviewer', task: 't', summary: 's', of: 'x' },
    ]);
    const steps: ExecutionManifest['steps'] = {
      ...manifestSteps(['s1'], { pricing: { kind: 'local' } }),
      ...manifestSteps(['s2'], { pricing: { kind: 'free' } }),
    };
    const est = estimatePlan(document, steps, EMPTY_HISTORY);
    expect(est).toMatchObject({ unpricedNote: 'runs on your computer and included in your ChatGPT plan' });
  });

  // T5 review H4: a THIRD distinct reason must read as a proper list, not
  // "X and Y and Z".
  it('joins three distinct unpriced notes as a proper list, not "X and Y and Z"', () => {
    const document = doc([
      { id: 's1', kind: 'verify', specialist: 'worker', task: 't', summary: 's', of: 'x' },
      { id: 's2', kind: 'verify', specialist: 'reviewer', task: 't', summary: 's', of: 'x' },
      { id: 's3', kind: 'verify', specialist: 'explorer', task: 't', summary: 's', of: 'x' },
    ]);
    const steps: ExecutionManifest['steps'] = {
      ...manifestSteps(['s1'], { pricing: { kind: 'local' } }),
      ...manifestSteps(['s2'], { pricing: { kind: 'free' } }),
      ...manifestSteps(['s3'], { pricing: null }),
    };
    const est = estimatePlan(document, steps, EMPTY_HISTORY);
    expect(est).toMatchObject({ unpricedNote: 'runs on your computer, included in your ChatGPT plan and no published price' });
  });
});

describe('estimatePlan — mixed plans', () => {
  it('a plan with one priced and one unpriced step returns a dollar range over the priced step only', () => {
    const document = doc([
      { id: 's1', kind: 'verify', specialist: 'worker', task: 't', summary: 's', of: 'x' },
      { id: 's2', kind: 'verify', specialist: 'reviewer', task: 't', summary: 's', of: 'x' },
    ]);
    const priced = estimatePlan(doc([document.steps[0]]), manifestSteps(['s1']), EMPTY_HISTORY);
    const steps: ExecutionManifest['steps'] = {
      ...manifestSteps(['s1']),
      ...manifestSteps(['s2'], { pricing: { kind: 'local' } }),
    };
    const mixed = estimatePlan(document, steps, EMPTY_HISTORY);
    // The dollar figure is exactly the priced step's own contribution — the
    // unpriced step adds nothing to it.
    expect(mixed).toEqual(priced);
  });
});

describe('estimatePlan — edge cases', () => {
  it('a step id missing from the manifest contributes nothing rather than throwing', () => {
    const document = doc([{ id: 'ghost', kind: 'verify', specialist: 'worker', task: 't', summary: 's', of: 'x' }]);
    expect(() => estimatePlan(document, {}, EMPTY_HISTORY)).not.toThrow();
    expect(estimatePlan(document, {}, EMPTY_HISTORY)).toEqual({ tokens: 0, unpricedNote: 'no published price' });
  });
});
