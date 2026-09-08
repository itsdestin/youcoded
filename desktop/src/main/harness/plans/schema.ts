import { z } from 'zod';

export const PLAN_MIN_BUDGET_TOKENS = 500;
export const PLAN_MAX_BUDGET_TOKENS = 20_000;
export const PLAN_MAX_REPEAT_ITERATIONS = 5;

/**
 * This intentionally recursive schema mirrors the completed grammar probe.
 * The model grammar needs recursion; validator.ts supplies the semantic rule
 * that a repeat body cannot itself contain a repeat.
 */
const stepProperties = {
  id: { type: 'string' },
  kind: { type: 'string', enum: ['map', 'verify', 'combine', 'repeat'] },
  specialist: { type: 'string' },
  task: { type: 'string' },
  budget_tokens: { type: 'integer', minimum: PLAN_MIN_BUDGET_TOKENS, maximum: PLAN_MAX_BUDGET_TOKENS },
  items: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
  of: { type: 'string' },
  max_iterations: { type: 'integer', minimum: 1, maximum: PLAN_MAX_REPEAT_ITERATIONS },
  until: { type: 'string' },
  steps: { type: 'array', items: { $ref: '#/$defs/step' }, minItems: 1, maxItems: 4 },
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
    goal: { type: 'string' },
    steps: { type: 'array', items: { $ref: '#/$defs/step' }, minItems: 1, maxItems: 6 },
  },
} as const;

const BaseStepSchema = z.object({
  id: z.string(), kind: z.enum(['map', 'verify', 'combine', 'repeat']), specialist: z.string(), task: z.string(),
  budget_tokens: z.number().int().min(PLAN_MIN_BUDGET_TOKENS).max(PLAN_MAX_BUDGET_TOKENS),
}).strict();

type PlanStep = z.infer<typeof BaseStepSchema> & {
  items?: string[]; of?: string; max_iterations?: number; until?: string; steps?: PlanStep[];
};

export const PlanStepSchema: z.ZodType<PlanStep> = z.lazy(() => z.discriminatedUnion('kind', [
  BaseStepSchema.extend({ kind: z.literal('map'), items: z.array(z.string()).min(1).max(8) }),
  BaseStepSchema.extend({ kind: z.literal('verify'), of: z.string() }),
  BaseStepSchema.extend({ kind: z.literal('combine'), of: z.string() }),
  BaseStepSchema.extend({
    kind: z.literal('repeat'), max_iterations: z.number().int().min(1).max(PLAN_MAX_REPEAT_ITERATIONS), until: z.string(),
    steps: z.array(PlanStepSchema).min(1).max(4),
  }),
]));

export const PlanDocumentSchema = z.object({
  goal: z.string(),
  steps: z.array(PlanStepSchema).min(1).max(6),
}).strict();

export type PlanDocumentV1 = z.infer<typeof PlanDocumentSchema>;
export type PlanStepV1 = z.infer<typeof PlanStepSchema>;
