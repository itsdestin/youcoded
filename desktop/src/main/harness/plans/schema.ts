import { z } from 'zod';

export const PLAN_MIN_BUDGET_TOKENS = 500;
export const PLAN_MAX_BUDGET_TOKENS = 20_000;
export const PLAN_MAX_REPEAT_ITERATIONS = 5;
export const PLAN_MAX_ID_CHARS = 64;
export const PLAN_MAX_GOAL_CHARS = 2_000;
export const PLAN_MAX_TASK_CHARS = 4_000;
export const PLAN_MAX_ITEM_CHARS = 2_000;
export const PLAN_MAX_UNTIL_CHARS = 2_000;

/**
 * This intentionally recursive schema mirrors the completed grammar probe.
 * The model grammar needs recursion; validator.ts supplies the semantic rule
 * that a repeat body cannot itself contain a repeat.
 */
const stepProperties = {
  id: { type: 'string', minLength: 1, maxLength: PLAN_MAX_ID_CHARS, description: 'Short unique step id, e.g. "s1".' },
  kind: { type: 'string', enum: ['map', 'verify', 'combine', 'repeat'] },
  specialist: { type: 'string', enum: ['explorer', 'researcher', 'reviewer', 'worker'] },
  task: { type: 'string', minLength: 1, maxLength: PLAN_MAX_TASK_CHARS, description: 'What each child does. For map, may reference {item}.' },
  budget_tokens: { type: 'integer', minimum: PLAN_MIN_BUDGET_TOKENS, maximum: PLAN_MAX_BUDGET_TOKENS },
  items: { type: 'array', items: { type: 'string', minLength: 1, maxLength: PLAN_MAX_ITEM_CHARS }, minItems: 1, maxItems: 8, description: 'map only: one child per item.' },
  of: { type: 'string', minLength: 1, maxLength: PLAN_MAX_ID_CHARS, description: 'verify/combine: the id of the step whose results this consumes.' },
  max_iterations: { type: 'integer', minimum: 1, maximum: PLAN_MAX_REPEAT_ITERATIONS, description: 'repeat only: hard cap.' },
  until: { type: 'string', minLength: 1, maxLength: PLAN_MAX_UNTIL_CHARS, description: 'repeat only: plain-words stop condition.' },
  steps: { type: 'array', items: { $ref: '#/$defs/step' }, minItems: 1, maxItems: 4, description: 'repeat only: the steps to repeat.' },
} as const;

export const PLAN_DOCUMENT_JSON_SCHEMA = {
  $defs: {
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

export const PlanStepSchema: z.ZodType<PlanStep> = z.lazy(() => z.discriminatedUnion('kind', [
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
