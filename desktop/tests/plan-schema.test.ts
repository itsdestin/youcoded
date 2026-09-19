import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import { PLAN_DOCUMENT_JSON_SCHEMA, PlanDocumentSchema } from '../src/main/harness/plans/schema';
import { validatePlanDocument } from '../src/main/harness/plans/validator';
import { BUILTIN_ROSTER, type SpecialistRoster } from '../src/main/harness/specialists/registry';
import { STEP_SCHEMA as PROBE_PLAN_DOCUMENT_JSON_SCHEMA } from '../test-engine/probe-plan-grammar.mjs';

// WHY loose step records: several tests below deliberately build documents the
// strict type forbids (wrong kind fields, forward ids) to prove the validator
// rejects them; the typed PlanDocumentV1 would refuse to even compile those.
type LooseDocument = { goal: string; steps: Array<Record<string, any>> };

/** The advertised branch for one step kind. `$defs/step` is an `anyOf` of four
 *  mutually exclusive branches (2026-09-18), so there is no single `properties`
 *  bag to read a field off any more. */
const branch = (kind: string): any =>
  (PLAN_DOCUMENT_JSON_SCHEMA.$defs.step.anyOf as any[]).find((b) => b.properties.kind.enum[0] === kind);

const COMMON_FIELDS = ['id', 'kind', 'specialist', 'task', 'budget_tokens'];
/** Fields EVERY kind may carry and NO kind must: advertised on all four
 *  branches so a constrained decoder may emit one, never in `required` so an
 *  older plan — and a model that ignores it — still validates. */
const OPTIONAL_COMMON_FIELDS = ['summary'];
/** The fields each kind owns, as the ADVERTISED schema states them. The
 *  drift pin below proves the runtime validator agrees with exactly this. */
const ADVERTISED_KIND_FIELDS: Record<string, string[]> = {
  map: ['items'], verify: ['of'], combine: ['of'], repeat: ['max_iterations', 'until', 'steps'],
};
/** A minimal, valid step of each kind — only the fields that kind owns. */
const minimalStep = (kind: string, id = kind): Record<string, any> => ({
  id, kind, specialist: 'worker', task: 'Do the thing.', budget_tokens: 500,
  ...(kind === 'map' ? { items: ['x'] } : {}),
  ...(kind === 'verify' || kind === 'combine' ? { of: 'earlier' } : {}),
  ...(kind === 'repeat' ? { max_iterations: 2, until: 'Done.', steps: [minimalStep('map', 'body')] } : {}),
});

const mapVerifyCombine: LooseDocument = {
  goal: 'Review each source and produce one report.',
  steps: [
    { id: 'map', kind: 'map', specialist: 'reviewer', task: 'Review {item}.', budget_tokens: 500, items: ['auth.ts', 'billing.ts'] },
    { id: 'verify', kind: 'verify', specialist: 'researcher', task: 'Check the reviews.', budget_tokens: 600, of: 'map' },
    { id: 'combine', kind: 'combine', specialist: 'worker', task: 'Write the report.', budget_tokens: 700, of: 'verify' },
  ],
};

const nestedRepeat: LooseDocument = {
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
  it('a step may budget up to 30,000 tokens of work (product decision 4, 2026-09-16)', () => {
    const doc = (budget: number) => ({ goal: 'g', steps: [{ id: 's', kind: 'map', specialist: 'worker', task: 't', budget_tokens: budget, items: ['x'] }] });
    expect(PlanDocumentSchema.safeParse(doc(30_000)).success).toBe(true);
    expect(PlanDocumentSchema.safeParse(doc(30_001)).success).toBe(false);
    expect(branch('map').properties.budget_tokens.maximum).toBe(30_000);
  });

  it('pins the complete model-facing schema to the schema proven by the live probe', () => {
    expect(PLAN_DOCUMENT_JSON_SCHEMA).toEqual(PROBE_PLAN_DOCUMENT_JSON_SCHEMA);
    expect(branch('map').properties.specialist.enum).toEqual(['explorer', 'researcher', 'reviewer', 'worker']);
    expect(branch('repeat').properties.steps.items.$ref).toBe('#/$defs/leafStep');
    expect(PlanDocumentSchema.safeParse(mapVerifyCombine).success).toBe(true);
    expect(PlanDocumentSchema.safeParse(nestedRepeat).success).toBe(true);
  });

  // WHY this guard exists (2026-09-18, from two of Destin's real sessions):
  // `$defs/step` offered the recursive `steps` on EVERY step, so a model doing
  // constrained decoding could descend steps→steps→steps with nothing to stop
  // it. Three real propose_plan calls did exactly that — 343, 353 and 206
  // levels of filler steps ("Do not run.", "unused") — until the output-token
  // cap cut the arguments mid-string. The arguments then arrived as unparseable
  // text and the plan died. validator.ts already rejects a repeat inside a
  // repeat, so the unbounded grammar could only ever produce documents the
  // semantics would refuse. A repeat body is now a LEAF step: one level, and
  // the runaway is not expressible.
  it('the model-facing grammar cannot nest steps without bound', () => {
    const leafKinds = (PLAN_DOCUMENT_JSON_SCHEMA.$defs.leafStep.anyOf as any[]).map((b) => b.properties.kind.enum[0]);
    expect(leafKinds).toEqual(['map', 'verify', 'combine']);
    for (const b of PLAN_DOCUMENT_JSON_SCHEMA.$defs.leafStep.anyOf as any[]) {
      expect(b.properties).not.toHaveProperty('steps');
    }

    const validate = new Ajv({ strict: false }).compile(PLAN_DOCUMENT_JSON_SCHEMA);
    // One level of repeat body is still expressible…
    expect(validate(nestedRepeat)).toBe(true);
    // …a second is not, at any depth.
    const twoLevels = structuredClone(nestedRepeat);
    twoLevels.steps[0].steps = [{
      id: 'again', kind: 'repeat', specialist: 'reviewer', task: 'Repeat again.', budget_tokens: 500,
      max_iterations: 2, until: 'Done.', steps: [{ id: 'leaf', kind: 'map', specialist: 'worker', task: 'Do {item}.', budget_tokens: 500, items: ['x'] }],
    }];
    expect(validate(twoLevels)).toBe(false);

    // The exact shape the runaway rode: `map` steps chained through their own
    // `steps`, the way all three real calls descended. Now that each kind is its
    // own branch, a `map` cannot carry `steps` at ALL, so the chain is
    // ungrammatical from its very first link rather than merely bounded.
    const mapChain = (depth: number): any => ({
      id: `m${depth}`, kind: 'map', specialist: 'explorer', task: 'Do not run.', budget_tokens: 500, items: ['none'],
      ...(depth > 0 ? { steps: [mapChain(depth - 1)] } : {}),
    });
    expect(validate({ goal: 'g', steps: [mapChain(0)] })).toBe(true);
    expect(validate({ goal: 'g', steps: [mapChain(1)] })).toBe(false);
    expect(validate({ goal: 'g', steps: [mapChain(50)] })).toBe(false);
  });

  // The regression the owner hit on the rebuilt dev instance: the advertised
  // schema was a flat object with every kind's fields optional, so the model
  // emitted `of`, `max_iterations`, `until` AND `steps` on all three of its
  // `map` steps, and Zod answered with twelve unknown-key names that said
  // nothing about which step was wrong or what a map may carry.
  describe('each kind advertises, and accepts, only its own fields', () => {
    it.each(['map', 'verify', 'combine', 'repeat'])('%s: a minimal document of this kind is valid both sides', (kind) => {
      const validate = new Ajv({ strict: false }).compile(PLAN_DOCUMENT_JSON_SCHEMA);
      const document = kind === 'verify' || kind === 'combine'
        ? { goal: 'g', steps: [minimalStep('map', 'earlier'), minimalStep(kind)] }
        : { goal: 'g', steps: [minimalStep(kind)] };
      expect(validate(document)).toBe(true);
      expect(PlanDocumentSchema.safeParse(document).success).toBe(true);
      expect(validatePlanDocument(document, BUILTIN_ROSTER).ok).toBe(true);
    });

    it.each([
      ['map', 'of'], ['map', 'max_iterations'], ['map', 'until'], ['map', 'steps'],
      ['verify', 'items'], ['verify', 'steps'], ['combine', 'items'], ['repeat', 'items'], ['repeat', 'of'],
    ])('%s carrying a %s is refused, and the message names the kind and what it allows', (kind, foreign) => {
      const foreignValue: Record<string, unknown> = {
        of: 'earlier', items: ['x'], max_iterations: 2, until: 'Done.', steps: [minimalStep('map', 'body')],
      };
      const step = { ...minimalStep(kind), [foreign]: foreignValue[foreign] };
      const document = { goal: 'g', steps: [minimalStep('map', 'earlier'), step] };
      const result = validatePlanDocument(document, BUILTIN_ROSTER);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const message = result.issues.join('\n');
        expect(message).toContain(`a "${kind}" step accepts only`);
        // It names the allowed fields, and the offending one to drop.
        for (const allowed of [...COMMON_FIELDS, ...ADVERTISED_KIND_FIELDS[kind]]) expect(message).toContain(allowed);
        expect(message).toContain(`remove ${foreign}`);
        // Never the bare unknown-key list the owner actually saw.
        expect(message).not.toContain('unknown parameter');
      }
    });

    it.each(['map', 'verify', 'combine', 'repeat'])('%s missing its own field is refused by name', (kind) => {
      for (const own of ADVERTISED_KIND_FIELDS[kind]) {
        const step = { ...minimalStep(kind) };
        delete step[own];
        const document = { goal: 'g', steps: [minimalStep('map', 'earlier'), step] };
        const result = validatePlanDocument(document, BUILTIN_ROSTER);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.issues.join('\n')).toContain(`a "${kind}" step needs ${own}`);
      }
    });

    // THE ANTI-DRIFT PIN. Everything above tests one side or the other; this
    // walks the advertised branches and proves the runtime validator accepts
    // exactly the same field set for each kind — no more, no less. The flat
    // schema / strict union split that broke plans twice cannot come back
    // without this failing.
    it('every advertised branch matches the shape the validator accepts', () => {
      const branches = PLAN_DOCUMENT_JSON_SCHEMA.$defs.step.anyOf as any[];
      expect(branches.map((b) => b.properties.kind.enum[0])).toEqual(['map', 'verify', 'combine', 'repeat']);

      for (const b of branches) {
        const kind = b.properties.kind.enum[0];
        const advertised = Object.keys(b.properties).sort();
        // Advertised: common + the optional common ones + this kind's own fields.
        expect(advertised).toEqual([...COMMON_FIELDS, ...OPTIONAL_COMMON_FIELDS, ...ADVERTISED_KIND_FIELDS[kind]].sort());
        // Required: everything EXCEPT the optional common ones.
        expect([...b.required].sort()).toEqual([...COMMON_FIELDS, ...ADVERTISED_KIND_FIELDS[kind]].sort());
        expect(b.additionalProperties).toBe(false);

        // Accepted by the validator: exactly the advertised set. Present → ok…
        const ok = { goal: 'g', steps: [minimalStep('map', 'earlier'), minimalStep(kind)] };
        expect(PlanDocumentSchema.safeParse(ok).success).toBe(true);
        // …an optional common field is accepted on EVERY kind, and leaving it
        // out is still valid — the half that broke twice is the half where one
        // side learns a field and the other does not.
        for (const optional of OPTIONAL_COMMON_FIELDS) {
          const withOptional = { goal: 'g', steps: [minimalStep('map', 'earlier'), { ...minimalStep(kind), [optional]: 'One plain sentence for the user.' }] };
          expect(PlanDocumentSchema.safeParse(withOptional).success).toBe(true);
          expect(validatePlanDocument(withOptional, BUILTIN_ROSTER).ok).toBe(true);
          const validateBranch = new Ajv({ strict: false }).compile(PLAN_DOCUMENT_JSON_SCHEMA);
          expect(validateBranch(withOptional)).toBe(true);
        }
        // …and ANY field this branch does not advertise → refused.
        for (const other of ['items', 'of', 'max_iterations', 'until', 'steps']) {
          if (advertised.includes(other)) continue;
          const value: Record<string, unknown> = {
            of: 'earlier', items: ['x'], max_iterations: 2, until: 'Done.', steps: [minimalStep('map', 'body')],
          };
          const bad = { goal: 'g', steps: [minimalStep('map', 'earlier'), { ...minimalStep(kind), [other]: value[other] }] };
          expect(PlanDocumentSchema.safeParse(bad).success).toBe(false);
        }
      }
    });
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
    ['summary', { ...mapVerifyCombine, steps: [{ ...mapVerifyCombine.steps[0], summary: '' }] }],
    // Bounded so the one plain sentence can never grow into a second brief.
    ['summary length', { ...mapVerifyCombine, steps: [{ ...mapVerifyCombine.steps[0], summary: 's'.repeat(201) }] }],
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
    ['summary', { ...mapVerifyCombine, steps: [{ ...mapVerifyCombine.steps[0], summary: '   ' }] }],
  ])('rejects whitespace-only %s text', (_name, document) => {
    expect(PlanDocumentSchema.safeParse(document).success).toBe(false);
  });

  it('accepts every text field at its exact bound', () => {
    const document = {
      goal: 'g'.repeat(2_000),
      steps: [{
        id: 'i'.repeat(64), kind: 'repeat', specialist: 'worker', task: 't'.repeat(4_000), budget_tokens: 500,
        summary: 's'.repeat(200),
        max_iterations: 1, until: 'u'.repeat(2_000), steps: [{
          id: 'm'.repeat(64), kind: 'map', specialist: 'worker', task: 't', budget_tokens: 500, items: ['x'.repeat(2_000)],
        }],
      }],
    };
    expect(PlanDocumentSchema.safeParse(document).success).toBe(true);
  });

  // The per-step sentence exists for the PERSON pressing Approve, so the model
  // has to be told that — the old row was the first line of a prompt written
  // for a machine ("EXPECTATION PASS (fresh eyes, no implementation reading)…")
  // and told the user nothing about what the step would do.
  it('tells the model the per-step sentence is written for the user, not for a machine', () => {
    const description = branch('map').properties.summary.description as string;
    expect(description).toMatch(/one .*sentence/i);
    expect(description).toMatch(/user|person/i);
    // Every kind advertises the same words: a summary is not a map-only idea.
    for (const kind of ['map', 'verify', 'combine', 'repeat']) {
      expect(branch(kind).properties.summary.description).toBe(description);
    }
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

  // A repeat inside a repeat used to parse and be caught only by the semantic
  // pass. Since 2026-09-18 the repeat body is a leaf union, so it is refused
  // structurally — and the message says which kinds a body step may be, rather
  // than leaving the model to infer it.
  it('refuses a repeat nested inside a repeat body', () => {
    const document = structuredClone(nestedRepeat);
    document.steps[0].steps = [{
      id: 'again', kind: 'repeat', specialist: 'reviewer', task: 'Repeat again.', budget_tokens: 500,
      max_iterations: 2, until: 'Done.', steps: [{ id: 'leaf', kind: 'map', specialist: 'worker', task: 'Do {item}.', budget_tokens: 500, items: ['x'] }],
    }];
    expect(PlanDocumentSchema.safeParse(document).success).toBe(false);
    const result = validatePlanDocument(document, BUILTIN_ROSTER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join('\n')).toMatch(/map|verify|combine/);

    // The advertised grammar refuses it too, so a decoder never emits one.
    const validate = new Ajv({ strict: false }).compile(PLAN_DOCUMENT_JSON_SCHEMA);
    expect(validate(document)).toBe(false);
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
