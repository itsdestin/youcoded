import { describe, expect, it } from 'vitest';
import { PLAN_DOCUMENT_JSON_SCHEMA, PlanDocumentSchema } from '../src/main/harness/plans/schema';
import { validatePlanDocument } from '../src/main/harness/plans/validator';
import { BUILTIN_ROSTER, type SpecialistRoster } from '../src/main/harness/specialists/registry';
import { STEP_SCHEMA as PROBE_PLAN_DOCUMENT_JSON_SCHEMA } from '../test-engine/probe-plan-grammar.mjs';

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
  it('pins the complete model-facing schema to the schema proven by the live probe', () => {
    expect(PLAN_DOCUMENT_JSON_SCHEMA).toEqual(PROBE_PLAN_DOCUMENT_JSON_SCHEMA);
    expect(PLAN_DOCUMENT_JSON_SCHEMA.$defs.step.properties.specialist.enum).toEqual(['explorer', 'researcher', 'reviewer', 'worker']);
    expect(PLAN_DOCUMENT_JSON_SCHEMA.$defs.step.properties.steps.items.$ref).toBe('#/$defs/step');
    expect(PlanDocumentSchema.safeParse(mapVerifyCombine).success).toBe(true);
    expect(PlanDocumentSchema.safeParse(nestedRepeat).success).toBe(true);
  });

  it('keeps the live semantic specialist field open to custom roster ids', () => {
    const custom = { ...mapVerifyCombine, steps: [{ ...mapVerifyCombine.steps[0], specialist: 'security-auditor' }] };
    const customDefinition = { ...BUILTIN_ROSTER.list()[0], id: 'security-auditor' };
    const roster: SpecialistRoster = {
      list: () => [...BUILTIN_ROSTER.list(), customDefinition],
      resolve: (id) => id === customDefinition.id ? customDefinition : BUILTIN_ROSTER.resolve(id),
    };
    expect(PlanDocumentSchema.safeParse(custom).success).toBe(true);
    expect(validatePlanDocument(custom, roster).ok).toBe(true);
  });

  it.each([
    ['goal', { ...mapVerifyCombine, goal: '' }],
    ['goal length', { ...mapVerifyCombine, goal: 'g'.repeat(2_001) }],
    ['id', { ...mapVerifyCombine, steps: [{ ...mapVerifyCombine.steps[0], id: '' }] }],
    ['id length', { ...mapVerifyCombine, steps: [{ ...mapVerifyCombine.steps[0], id: 'i'.repeat(65) }] }],
    ['task', { ...mapVerifyCombine, steps: [{ ...mapVerifyCombine.steps[0], task: '' }] }],
    ['task length', { ...mapVerifyCombine, steps: [{ ...mapVerifyCombine.steps[0], task: 't'.repeat(4_001) }] }],
    ['of', { ...mapVerifyCombine, steps: [mapVerifyCombine.steps[0], { ...mapVerifyCombine.steps[1], of: '' }] }],
    ['of length', { ...mapVerifyCombine, steps: [mapVerifyCombine.steps[0], { ...mapVerifyCombine.steps[1], of: 'o'.repeat(65) }] }],
    ['until', { ...nestedRepeat, steps: [{ ...nestedRepeat.steps[0], until: '' }] }],
    ['until length', { ...nestedRepeat, steps: [{ ...nestedRepeat.steps[0], until: 'u'.repeat(2_001) }] }],
    ['item', { ...mapVerifyCombine, steps: [{ ...mapVerifyCombine.steps[0], items: [''] }] }],
    ['item length', { ...mapVerifyCombine, steps: [{ ...mapVerifyCombine.steps[0], items: ['x'.repeat(2_001)] }] }],
  ])('rejects empty or oversized %s text', (_name, document) => {
    expect(PlanDocumentSchema.safeParse(document).success).toBe(false);
  });

  it.each([
    ['goal', { ...mapVerifyCombine, goal: '   ' }],
    ['id', { ...mapVerifyCombine, steps: [{ ...mapVerifyCombine.steps[0], id: '   ' }] }],
    ['task', { ...mapVerifyCombine, steps: [{ ...mapVerifyCombine.steps[0], task: '\n\t' }] }],
    ['of', { ...mapVerifyCombine, steps: [mapVerifyCombine.steps[0], { ...mapVerifyCombine.steps[1], of: '  ' }] }],
    ['until', { ...nestedRepeat, steps: [{ ...nestedRepeat.steps[0], until: '\t' }] }],
    ['item', { ...mapVerifyCombine, steps: [{ ...mapVerifyCombine.steps[0], items: ['\n'] }] }],
  ])('rejects whitespace-only %s text', (_name, document) => {
    expect(PlanDocumentSchema.safeParse(document).success).toBe(false);
  });

  it('accepts every text field at its exact bound', () => {
    const document = {
      goal: 'g'.repeat(2_000),
      steps: [{
        id: 'i'.repeat(64), kind: 'repeat', specialist: 'worker', task: 't'.repeat(4_000), budget_tokens: 500,
        max_iterations: 1, until: 'u'.repeat(2_000), steps: [{
          id: 'm'.repeat(64), kind: 'map', specialist: 'worker', task: 't', budget_tokens: 500, items: ['x'.repeat(2_000)],
        }],
      }],
    };
    expect(PlanDocumentSchema.safeParse(document).success).toBe(true);
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

  it('allows repeat-body references only to globally earlier steps or earlier siblings', () => {
    const valid = structuredClone(nestedRepeat);
    valid.steps.unshift({ ...mapVerifyCombine.steps[0], id: 'source' });
    valid.steps[1].steps[0].id = 'draft';
    valid.steps[1].steps[1].of = 'source';
    expect(validatePlanDocument(valid, BUILTIN_ROSTER).ok).toBe(true);

    const self = structuredClone(nestedRepeat);
    self.steps[0].steps[1].of = 'check';
    expect(validatePlanDocument(self, BUILTIN_ROSTER).ok).toBe(false);

    const laterSibling = structuredClone(nestedRepeat);
    laterSibling.steps[0].steps[0] = { ...mapVerifyCombine.steps[1], id: 'early-check', of: 'later-map' };
    laterSibling.steps[0].steps[1] = { ...mapVerifyCombine.steps[0], id: 'later-map' };
    expect(validatePlanDocument(laterSibling, BUILTIN_ROSTER).ok).toBe(false);

    const laterTopLevel = structuredClone(nestedRepeat);
    laterTopLevel.steps[0].steps[1].of = 'after-repeat';
    laterTopLevel.steps.push({ ...mapVerifyCombine.steps[0], id: 'after-repeat' });
    expect(validatePlanDocument(laterTopLevel, BUILTIN_ROSTER).ok).toBe(false);
  });
});
