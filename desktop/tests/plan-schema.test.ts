import { describe, expect, it } from 'vitest';
import { PLAN_DOCUMENT_JSON_SCHEMA, PlanDocumentSchema } from '../src/main/harness/plans/schema';
import { validatePlanDocument } from '../src/main/harness/plans/validator';
import { BUILTIN_ROSTER } from '../src/main/harness/specialists/registry';

const mapVerifyCombine = {
  goal: 'Review each source and produce one report.',
  steps: [
    { id: 'map', kind: 'map', specialist: 'reviewer', task: 'Review {item}.', budget_tokens: 500, items: ['auth.ts', 'billing.ts'] },
    { id: 'verify', kind: 'verify', specialist: 'researcher', task: 'Check the reviews.', budget_tokens: 600, of: 'map' },
    { id: 'combine', kind: 'combine', specialist: 'worker', task: 'Write the report.', budget_tokens: 700, of: 'verify' },
  ],
};

const nestedRepeat = {
  goal: 'Iterate on a draft.',
  steps: [{
    id: 'repeat', kind: 'repeat', specialist: 'reviewer', task: 'Direct the iteration.', budget_tokens: 500,
    max_iterations: 3, until: 'The draft is correct.', steps: [
      { id: 'draft', kind: 'map', specialist: 'worker', task: 'Draft {item}.', budget_tokens: 800, items: ['document'] },
      { id: 'check', kind: 'verify', specialist: 'reviewer', task: 'Check it.', budget_tokens: 600, of: 'draft' },
    ],
  }],
};

describe('plan schema and semantic validator', () => {
  it('keeps the probe-compatible strict recursive JSON schema', () => {
    expect(PLAN_DOCUMENT_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(PLAN_DOCUMENT_JSON_SCHEMA.$defs.step.properties.steps.items.$ref).toBe('#/$defs/step');
    expect(PlanDocumentSchema.safeParse(mapVerifyCombine).success).toBe(true);
    expect(PlanDocumentSchema.safeParse(nestedRepeat).success).toBe(true);
  });

  it('accepts a valid map → verify → combine document and derives every attempt', () => {
    const result = validatePlanDocument(mapVerifyCombine, BUILTIN_ROSTER);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.maximumAttempts).toBe(4);
      expect(result.ceilingTokens).toBe(2_300);
      expect(result.maxFanOut).toBe(2);
    }
  });

  it('derives the repeat ceiling using every possible iteration', () => {
    const result = validatePlanDocument(nestedRepeat, BUILTIN_ROSTER);
    expect(result).toMatchObject({ ok: true, maximumAttempts: 6, ceilingTokens: 4_200, maxFanOut: 1 });
  });

  it('rejects extra keys and kind fields that do not belong to a step', () => {
    expect(PlanDocumentSchema.safeParse({ ...mapVerifyCombine, unexpected: true }).success).toBe(false);
    expect(validatePlanDocument({ ...mapVerifyCombine, steps: [{ ...mapVerifyCombine.steps[0], of: 'x' }] }, BUILTIN_ROSTER).ok).toBe(false);
  });

  it('rejects nested repeats even though the recursive grammar accepts them', () => {
    const document = structuredClone(nestedRepeat);
    document.steps[0].steps = [{
      id: 'again', kind: 'repeat', specialist: 'reviewer', task: 'Repeat again.', budget_tokens: 500,
      max_iterations: 2, until: 'Done.', steps: [{ id: 'leaf', kind: 'map', specialist: 'worker', task: 'Do {item}.', budget_tokens: 500, items: ['x'] }],
    }];
    expect(PlanDocumentSchema.safeParse(document).success).toBe(true);
    expect(validatePlanDocument(document, BUILTIN_ROSTER)).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.stringMatching(/nested repeat/i)]) });
  });

  it('rejects duplicate or forward ids, unknown specialists, and invalid bounds', () => {
    expect(validatePlanDocument({ ...mapVerifyCombine, steps: [{ ...mapVerifyCombine.steps[0], id: 'same' }, { ...mapVerifyCombine.steps[1], id: 'same', of: 'same' }] }, BUILTIN_ROSTER).ok).toBe(false);
    expect(validatePlanDocument({ ...mapVerifyCombine, steps: [{ ...mapVerifyCombine.steps[1], of: 'combine' }] }, BUILTIN_ROSTER).ok).toBe(false);
    expect(validatePlanDocument({ ...mapVerifyCombine, steps: [{ ...mapVerifyCombine.steps[0], specialist: 'missing' }] }, BUILTIN_ROSTER).ok).toBe(false);
    expect(validatePlanDocument({ ...mapVerifyCombine, steps: [{ ...mapVerifyCombine.steps[0], budget_tokens: 499 }] }, BUILTIN_ROSTER).ok).toBe(false);
  });
});
