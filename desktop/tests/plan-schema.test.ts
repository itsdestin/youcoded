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

// WHY `budget_tokens` is gone (spending rework stage 1, design §2, decision
// 34): the model no longer predicts a per-step cost.
const COMMON_FIELDS = ['id', 'kind', 'specialist', 'task', 'summary'];
/** Fields EVERY kind may carry and NO kind must: advertised on all four
 *  branches so a constrained decoder may emit one, never in `required`.
 *  WHY `model` is here now (design §2/§9, decision 35.4): a per-step model
 *  override, the same "advertised on all four kinds" mechanism `summary`
 *  used before it became required. */
const OPTIONAL_COMMON_FIELDS: string[] = ['model'];
/** The fields each kind owns, as the ADVERTISED schema states them. The
 *  drift pin below proves the runtime validator agrees with exactly this. */
const ADVERTISED_KIND_FIELDS: Record<string, string[]> = {
  map: ['items'], verify: ['of'], combine: ['of'], repeat: ['max_iterations', 'until', 'steps'],
};
/** A minimal, valid step of each kind — only the fields that kind owns. */
const minimalStep = (kind: string, id = kind): Record<string, any> => ({
  id, kind, specialist: 'worker', task: 'Do the thing.', summary: 'One plain sentence for the user.',
  // TWO items, not one: decision 33 refuses a whole PLAN whose worst case is a
  // single specialist run, and every document below is built from this step.
  ...(kind === 'map' ? { items: ['x', 'y'] } : {}),
  ...(kind === 'verify' || kind === 'combine' ? { of: 'earlier' } : {}),
  ...(kind === 'repeat' ? { max_iterations: 2, until: 'Done.', steps: [minimalStep('map', 'body')] } : {}),
});

const mapVerifyCombine: LooseDocument = {
  goal: 'Review each source and produce one report.',
  steps: [
    { id: 'map', kind: 'map', specialist: 'reviewer', task: 'Review {item}.', summary: 'Two helpers read one changed file each.', items: ['auth.ts', 'billing.ts'] },
    { id: 'verify', kind: 'verify', specialist: 'researcher', task: 'Check the reviews.', summary: 'One helper checks those notes against the files.', of: 'map' },
    { id: 'combine', kind: 'combine', specialist: 'worker', task: 'Write the report.', summary: 'One helper writes it all up as one report.', of: 'verify' },
  ],
};

const nestedRepeat: LooseDocument = {
  goal: 'Iterate on a draft.',
  steps: [{
    id: 'repeat', kind: 'repeat', specialist: 'reviewer', task: 'Direct the iteration.', summary: 'Draft and check, over and over, until it is right.',
    max_iterations: 3, until: 'The draft is correct.', steps: [
      { id: 'draft', kind: 'map', specialist: 'worker', task: 'Draft {item}.', summary: 'One helper writes the next draft.', items: ['document'] },
      { id: 'check', kind: 'verify', specialist: 'reviewer', task: 'Check it.', summary: 'One helper says whether the draft is right yet.', of: 'draft' },
    ],
  }],
};

describe('plan schema and semantic validator', () => {
  it('a step may name a model, up to 128 characters (design §2/§9, decision 35.4)', () => {
    const doc = (model: string) => ({ goal: 'g', steps: [{ id: 's', kind: 'map', specialist: 'worker', task: 't', summary: 's', items: ['x'], model }] });
    expect(PlanDocumentSchema.safeParse(doc('frontier')).success).toBe(true);
    expect(PlanDocumentSchema.safeParse(doc('a'.repeat(128))).success).toBe(true);
    expect(PlanDocumentSchema.safeParse(doc('a'.repeat(129))).success).toBe(false);
    expect(branch('map').properties.model.maxLength).toBe(128);
  });

  // Issue 3 fix (owner's live test): a live plan froze a step's model
  // (gpt-6-sol, source 'document') that the user never asked for, under the
  // older, softer wording ("Only when the user explicitly asked... Otherwise
  // omit."). The field description is now an outright prohibition, not a
  // condition the model can weigh against other judgment calls.
  it('the `model` field description reads as a flat prohibition, not a soft preference (decision 35.4, issue 3)', () => {
    const description = branch('map').properties.model.description as string;
    for (const kind of ['map', 'verify', 'combine', 'repeat']) expect(branch(kind).properties.model.description).toBe(description);
    expect(description).toMatch(/do not|leave unset/i);
    expect(description).toMatch(/never yours|not your (call|decision)/i);
    expect(description).toMatch(/only when the user has explicitly named/i);
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
      id: 'again', kind: 'repeat', specialist: 'reviewer', task: 'Repeat again.',
      max_iterations: 2, until: 'Done.', steps: [{ id: 'leaf', kind: 'map', specialist: 'worker', task: 'Do {item}.', items: ['x'] }],
    }];
    expect(validate(twoLevels)).toBe(false);

    // The exact shape the runaway rode: `map` steps chained through their own
    // `steps`, the way all three real calls descended. Now that each kind is its
    // own branch, a `map` cannot carry `steps` at ALL, so the chain is
    // ungrammatical from its very first link rather than merely bounded.
    const mapChain = (depth: number): any => ({
      id: `m${depth}`, kind: 'map', specialist: 'explorer', task: 'Do not run.', summary: 'Filler.', items: ['none'],
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
          const withOptional = { goal: 'g', steps: [minimalStep('map', 'earlier'), { ...minimalStep(kind), [optional]: 'frontier' }] };
          expect(PlanDocumentSchema.safeParse(withOptional).success).toBe(true);
          expect(validatePlanDocument(withOptional, BUILTIN_ROSTER).ok).toBe(true);
          const validateBranch = new Ajv({ strict: false }).compile(PLAN_DOCUMENT_JSON_SCHEMA);
          expect(validateBranch(withOptional)).toBe(true);
          const without = { goal: 'g', steps: [minimalStep('map', 'earlier'), minimalStep(kind)] };
          expect(PlanDocumentSchema.safeParse(without).success).toBe(true);
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
        id: 'i'.repeat(64), kind: 'repeat', specialist: 'worker', task: 't'.repeat(4_000),
        summary: 's'.repeat(200),
        max_iterations: 1, until: 'u'.repeat(2_000), steps: [{
          id: 'm'.repeat(64), kind: 'map', specialist: 'worker', task: 't', summary: 's', items: ['x'.repeat(2_000)],
        }],
      }],
    };
    expect(PlanDocumentSchema.safeParse(document).success).toBe(true);
  });

  // The per-step sentence exists for the PERSON pressing Approve, so the model
  // has to be told that — the old row was the first line of a prompt written
  // for a machine ("EXPECTATION PASS (fresh eyes, no implementation reading)…")
  // and told the user nothing about what the step would do.
  // Decision 33, Destin 2026-09-18 ("i'm not sure what the benefit would be of
  // making it optional"): every step draws its own row on the approval card,
  // and the row's words ARE the summary. Optional meant a plan could reach the
  // person approving real spending with nothing but the first line of a machine
  // prompt on every row. Old journals may stop parsing; that was accepted.
  it('requires the plain sentence on every step of every kind, in BOTH halves', () => {
    const ajv = new Ajv({ strict: false });
    for (const kind of ['map', 'verify', 'combine', 'repeat']) {
      // Advertised: in this branch's `required`, not merely in its properties.
      expect(branch(kind).required).toContain('summary');
      const step = { ...minimalStep(kind) };
      delete step.summary;
      const document = { goal: 'g', steps: [minimalStep('map', 'earlier'), step] };
      expect(ajv.compile(PLAN_DOCUMENT_JSON_SCHEMA)(document)).toBe(false);
      expect(PlanDocumentSchema.safeParse(document).success).toBe(false);
      expect(validatePlanDocument(document, BUILTIN_ROSTER).ok).toBe(false);
    }
    // Including a repeat's BODY step, which draws its own row too.
    const body = structuredClone(nestedRepeat);
    delete body.steps[0].steps[0].summary;
    expect(PlanDocumentSchema.safeParse(body).success).toBe(false);
    expect(ajv.compile(PLAN_DOCUMENT_JSON_SCHEMA)(body)).toBe(false);
  });

  // Decision 33, Destin's own words: "we need to allow single-specialist split
  // steps, but not single-specialists single-step plans. if the entire plan is
  // a single specialist doing a single thing, its a shitty plan and should just
  // be a specialist call."
  describe('a whole plan may not be one specialist doing one thing', () => {
    const oneRun: LooseDocument = {
      goal: 'Rename one function.',
      steps: [{ id: 's1', kind: 'map', specialist: 'worker', task: 'Rename {item}.', summary: 'One helper renames it.', items: ['the function'] }],
    };

    it('refuses the document, and tells the assistant to hire a specialist instead', () => {
      const result = validatePlanDocument(oneRun, BUILTIN_ROSTER);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.join('\n')).toContain('hire a specialist directly instead of proposing a plan');
    });

    it('keeps a ONE-ITEM split legal inside a larger plan (items still has a minimum of 1)', () => {
      const withSingleWorker: LooseDocument = {
        goal: 'Fix it and check it.',
        steps: [
          oneRun.steps[0],
          { id: 's2', kind: 'verify', specialist: 'reviewer', task: 'Check it.', summary: 'One helper checks the change.', of: 's1' },
        ],
      };
      expect(validatePlanDocument(withSingleWorker, BUILTIN_ROSTER).ok).toBe(true);
      expect(branch('map').properties.items.minItems).toBe(1);
    });

    it('counts repeat rounds, so a one-round repeat over one item is still refused', () => {
      const onceRound: LooseDocument = {
        goal: 'Draft it.',
        steps: [{
          id: 'loop', kind: 'repeat', specialist: 'worker', task: 'Iterate.', summary: 'Draft until it is right.',
          max_iterations: 1, until: 'The draft is correct.',
          steps: [{ id: 'draft', kind: 'map', specialist: 'worker', task: 'Draft {item}.', summary: 'One helper drafts it.', items: ['document'] }],
        }],
      };
      expect(validatePlanDocument(onceRound, BUILTIN_ROSTER).ok).toBe(false);
      // Two rounds IS two specialist runs, and is a plan.
      const twice = structuredClone(onceRound);
      twice.steps[0].max_iterations = 2;
      expect(validatePlanDocument(twice, BUILTIN_ROSTER).ok).toBe(true);
    });
  });

  it('tells the model the per-step sentence is written for the user, not for a machine', () => {
    const description = branch('map').properties.summary.description as string;
    expect(description).toMatch(/one .*sentence/i);
    expect(description).toMatch(/user|person/i);
    // Every kind advertises the same words: a summary is not a map-only idea.
    for (const kind of ['map', 'verify', 'combine', 'repeat']) {
      expect(branch(kind).properties.summary.description).toBe(description);
    }
  });

  // WHY no ceilingTokens assertion any more (spending rework stage 1, design
  // §1/§2, decision 34): the validator no longer sums a per-step token
  // ceiling — see plans/validator.ts.
  it('accepts a valid map → verify → combine document and derives every attempt', () => {
    const result = validatePlanDocument(mapVerifyCombine, BUILTIN_ROSTER);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.maximumAttempts).toBe(4);
      expect(result.maxFanOut).toBe(2);
    }
  });

  it('derives the repeat attempt count using every possible iteration', () => {
    const result = validatePlanDocument(nestedRepeat, BUILTIN_ROSTER);
    expect(result).toMatchObject({ ok: true, maximumAttempts: 6, maxFanOut: 1 });
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
      id: 'again', kind: 'repeat', specialist: 'reviewer', task: 'Repeat again.',
      max_iterations: 2, until: 'Done.', steps: [{ id: 'leaf', kind: 'map', specialist: 'worker', task: 'Do {item}.', items: ['x'] }],
    }];
    expect(PlanDocumentSchema.safeParse(document).success).toBe(false);
    const result = validatePlanDocument(document, BUILTIN_ROSTER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join('\n')).toMatch(/map|verify|combine/);

    // The advertised grammar refuses it too, so a decoder never emits one.
    const validate = new Ajv({ strict: false }).compile(PLAN_DOCUMENT_JSON_SCHEMA);
    expect(validate(document)).toBe(false);
  });

  it('rejects duplicate or forward ids and unknown specialists', () => {
    expect(validatePlanDocument({ ...mapVerifyCombine, steps: [{ ...mapVerifyCombine.steps[0], id: 'same' }, { ...mapVerifyCombine.steps[1], id: 'same', of: 'same' }] }, BUILTIN_ROSTER).ok).toBe(false);
    expect(validatePlanDocument({ ...mapVerifyCombine, steps: [mapVerifyCombine.steps[0], { ...mapVerifyCombine.steps[1], of: 'combine' }] }, BUILTIN_ROSTER).ok).toBe(false);
    expect(validatePlanDocument({ ...mapVerifyCombine, steps: [{ ...mapVerifyCombine.steps[0], specialist: 'missing' }] }, BUILTIN_ROSTER).ok).toBe(false);
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

  // Decision 39 (the owner's live test, 2026-09-24): a verify/combine step
  // used to name exactly ONE earlier step. Three independent researcher steps
  // followed by a combine step that could only reference the first meant the
  // other two results silently never reached it — the combine specialist
  // reported "I only received Result 1". `of` now also accepts an array of
  // up to 6 distinct earlier step ids; a single string stays valid.
  describe('a verify/combine step may name several earlier steps in `of` (decision 39)', () => {
    const threeUp: LooseDocument = {
      goal: 'Research three categories and combine them.',
      steps: [
        { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Research {item}', summary: 'One helper researches keyboards.', items: ['keyboards'] },
        { id: 's2', kind: 'map', specialist: 'reviewer', task: 'Research {item}', summary: 'One helper researches mice.', items: ['mice'] },
        { id: 's3', kind: 'map', specialist: 'reviewer', task: 'Research {item}', summary: 'One helper researches monitors.', items: ['monitors'] },
        { id: 's4', kind: 'combine', specialist: 'worker', task: 'Combine all three', summary: 'One helper writes one combined report.', of: ['s1', 's2', 's3'] },
      ],
    };

    it('the advertised schema offers a single id or an array of up to 6, alongside the plain string', () => {
      for (const kind of ['verify', 'combine']) {
        const of = branch(kind).properties.of;
        expect(of.anyOf[0]).toMatchObject({ type: 'string' });
        expect(of.anyOf[1]).toMatchObject({ type: 'array', minItems: 1, maxItems: 6, uniqueItems: true });
      }
    });

    it('accepts the array form on both halves, and every named step arrives', () => {
      const ajv = new Ajv({ strict: false });
      expect(ajv.compile(PLAN_DOCUMENT_JSON_SCHEMA)(threeUp)).toBe(true);
      expect(PlanDocumentSchema.safeParse(threeUp).success).toBe(true);
      const result = validatePlanDocument(threeUp, BUILTIN_ROSTER);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.maximumAttempts).toBe(4);
    });

    it('keeps a single string valid — the array is additive, not a replacement', () => {
      const single = { ...threeUp, steps: [threeUp.steps[0], { ...threeUp.steps[3], of: 's1' }] };
      expect(PlanDocumentSchema.safeParse(single).success).toBe(true);
      expect(validatePlanDocument(single, BUILTIN_ROSTER).ok).toBe(true);
    });

    it('checks EVERY id in the array is an earlier step, not only the first', () => {
      const oneMissing = structuredClone(threeUp);
      oneMissing.steps[3].of = ['s1', 'nowhere', 's3'];
      const result = validatePlanDocument(oneMissing, BUILTIN_ROSTER);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const message = result.issues.join('\n');
        expect(message).toContain('reference "nowhere" must name an earlier step');
        expect(message).not.toContain('reference "s1"');
        expect(message).not.toContain('reference "s3"');
      }
    });

    it('checks EVERY id is actually earlier, not merely present somewhere in the plan', () => {
      const selfRef = structuredClone(threeUp);
      // s4 naming itself is present in the plan, but is not an EARLIER step.
      selfRef.steps[3].of = ['s1', 's4'];
      const result = validatePlanDocument(selfRef, BUILTIN_ROSTER);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.join('\n')).toContain('reference "s4" must name an earlier step');
    });

    it('rejects a duplicate id inside the array, on both halves', () => {
      const dup = structuredClone(threeUp);
      dup.steps[3].of = ['s1', 's1'];
      expect(PlanDocumentSchema.safeParse(dup).success).toBe(false);
      const ajv = new Ajv({ strict: false });
      expect(ajv.compile(PLAN_DOCUMENT_JSON_SCHEMA)(dup)).toBe(false);
    });

    it('rejects more than 6 ids in the array, on both halves', () => {
      // A structural check only — the ids don't need to name real steps for
      // this bound, and the document must stay under the unrelated 6
      // TOP-LEVEL step cap to isolate the one being tested.
      const many: LooseDocument = {
        goal: 'g',
        steps: [threeUp.steps[0], { ...threeUp.steps[3], of: Array.from({ length: 7 }, (_, i) => `s${i}`) }],
      };
      expect(PlanDocumentSchema.safeParse(many).success).toBe(false);
      const ajv = new Ajv({ strict: false });
      expect(ajv.compile(PLAN_DOCUMENT_JSON_SCHEMA)(many)).toBe(false);
    });

    it('rejects an empty array', () => {
      const empty = structuredClone(threeUp);
      empty.steps[3].of = [];
      expect(PlanDocumentSchema.safeParse(empty).success).toBe(false);
    });
  });
});
