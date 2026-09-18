import { z } from 'zod';

const PLAN_MIN_BUDGET_TOKENS = 500;
// WHY 30,000 (product decision 4, 2026-09-16): a step's budget now pays for
// work only — each specialist's fixed setup cost is counted separately — and
// the owner asked for "a bit" more room. Only the numeric maximum changed, so
// the completed grammar probe's evidence still holds (not re-run).
const PLAN_MAX_BUDGET_TOKENS = 30_000;
const PLAN_MAX_REPEAT_ITERATIONS = 5;
const PLAN_MAX_ID_CHARS = 64;
const PLAN_MAX_GOAL_CHARS = 2_000;
const PLAN_MAX_TASK_CHARS = 4_000;
const PLAN_MAX_ITEM_CHARS = 2_000;
const PLAN_MAX_UNTIL_CHARS = 2_000;

/**
 * The model-facing grammar. It mirrors the completed grammar probe, with its
 * recursion BOUNDED to the one level validator.ts can actually accept.
 *
 * WHY bounded (2026-09-18, from two of Destin's real sessions): `$defs/step`
 * used to offer the recursive `steps` on every step, so a model doing
 * constrained decoding could descend steps→steps→steps with nothing to stop it.
 * Three real propose_plan calls did exactly that — 343, 353 and 206 levels of
 * filler steps — until the output-token cap cut the arguments mid-string; the
 * arguments then arrived as unparseable text and the plan died. validator.ts
 * already rejects a repeat inside a repeat, so the unbounded grammar could only
 * ever produce documents the semantics would refuse. A repeat body is now a
 * LEAF step, which makes that descent inexpressible rather than merely invalid.
 */
const sharedStepProperties = {
  id: { type: 'string', minLength: 1, maxLength: PLAN_MAX_ID_CHARS, description: 'Short unique step id, e.g. "s1".' },
  specialist: { type: 'string', enum: ['explorer', 'researcher', 'reviewer', 'worker'] },
  task: { type: 'string', minLength: 1, maxLength: PLAN_MAX_TASK_CHARS, description: 'What each child does. For map, may reference {item}.' },
  budget_tokens: { type: 'integer', minimum: PLAN_MIN_BUDGET_TOKENS, maximum: PLAN_MAX_BUDGET_TOKENS },
  items: { type: 'array', items: { type: 'string', minLength: 1, maxLength: PLAN_MAX_ITEM_CHARS }, minItems: 1, maxItems: 8, description: 'map only: one child per item.' },
  of: { type: 'string', minLength: 1, maxLength: PLAN_MAX_ID_CHARS, description: 'verify/combine: the id of the step whose results this consumes.' },
} as const;

/** A step inside a repeat body: no `steps` of its own, and `repeat` is not one
 *  of its kinds — the two together are what bound the grammar. */
const leafStepProperties = {
  ...sharedStepProperties,
  kind: { type: 'string', enum: ['map', 'verify', 'combine'] },
} as const;

const stepProperties = {
  ...sharedStepProperties,
  kind: { type: 'string', enum: ['map', 'verify', 'combine', 'repeat'] },
  max_iterations: { type: 'integer', minimum: 1, maximum: PLAN_MAX_REPEAT_ITERATIONS, description: 'repeat only: hard cap.' },
  until: { type: 'string', minLength: 1, maxLength: PLAN_MAX_UNTIL_CHARS, description: 'repeat only: plain-words stop condition.' },
  steps: { type: 'array', items: { $ref: '#/$defs/leafStep' }, minItems: 1, maxItems: 4, description: 'repeat only: the steps to repeat. These may not repeat again.' },
} as const;

export const PLAN_DOCUMENT_JSON_SCHEMA = {
  $defs: {
    leafStep: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'kind', 'specialist', 'task', 'budget_tokens'],
      properties: leafStepProperties,
    },
    step: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'kind', 'specialist', 'task', 'budget_tokens'],
      properties: stepProperties,
    },
  },
  type: 'object',
  additionalProperties: false,
  required: ['goal', 'steps'],
  properties: {
    goal: { type: 'string', minLength: 1, maxLength: PLAN_MAX_GOAL_CHARS, description: 'One sentence: what the whole plan achieves.' },
    steps: { type: 'array', items: { $ref: '#/$defs/step' }, minItems: 1, maxItems: 6 },
  },
} as const;

const nonEmptyBounded = (maximum: number) => z.string().min(1).max(maximum).refine((value) => value.trim().length > 0, 'Must contain non-whitespace text');

const BaseStepSchema = z.object({
  id: nonEmptyBounded(PLAN_MAX_ID_CHARS),
  kind: z.enum(['map', 'verify', 'combine', 'repeat']),
  // The model-facing schema is intentionally the four built-ins proven by the
  // probe. Runtime parsing stays open because a live roster can include custom ids.
  specialist: nonEmptyBounded(PLAN_MAX_ID_CHARS),
  task: nonEmptyBounded(PLAN_MAX_TASK_CHARS),
  budget_tokens: z.number().int().min(PLAN_MIN_BUDGET_TOKENS).max(PLAN_MAX_BUDGET_TOKENS),
}).strict();

type PlanStep = z.infer<typeof BaseStepSchema> & {
  items?: string[]; of?: string; max_iterations?: number; until?: string; steps?: PlanStep[];
};

const PlanStepSchema: z.ZodType<PlanStep> = z.lazy(() => z.discriminatedUnion('kind', [
  BaseStepSchema.extend({ kind: z.literal('map'), items: z.array(nonEmptyBounded(PLAN_MAX_ITEM_CHARS)).min(1).max(8) }),
  BaseStepSchema.extend({ kind: z.literal('verify'), of: nonEmptyBounded(PLAN_MAX_ID_CHARS) }),
  BaseStepSchema.extend({ kind: z.literal('combine'), of: nonEmptyBounded(PLAN_MAX_ID_CHARS) }),
  BaseStepSchema.extend({
    kind: z.literal('repeat'), max_iterations: z.number().int().min(1).max(PLAN_MAX_REPEAT_ITERATIONS), until: nonEmptyBounded(PLAN_MAX_UNTIL_CHARS),
    steps: z.array(PlanStepSchema).min(1).max(4),
  }),
]));

export const PlanDocumentSchema = z.object({
  goal: nonEmptyBounded(PLAN_MAX_GOAL_CHARS),
  steps: z.array(PlanStepSchema).min(1).max(6),
}).strict();

export type PlanDocumentV1 = z.infer<typeof PlanDocumentSchema>;
export type PlanStepV1 = z.infer<typeof PlanStepSchema>;
