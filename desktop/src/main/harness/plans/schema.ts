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
// WHY a sentence's worth and no more (decision 30, 2026-09-18): `summary` is
// the ONE plain line the person approving the plan reads on the row. Left
// unbounded — or bounded like `task` at 4,000 — a model would write a second
// brief into it and the row would be exactly as unreadable as the machine
// prompt it replaced. Every other free-text field here is bounded too.
const PLAN_MAX_SUMMARY_CHARS = 200;
const PLAN_MAX_REPEAT_BODY_STEPS = 4;
const PLAN_MAX_TOP_LEVEL_STEPS = 6;
const PLAN_MAX_MAP_ITEMS = 8;

/**
 * ONE table describing the four step kinds, and BOTH halves of the schema are
 * built from it: the JSON Schema the model is shown, and the Zod schema that
 * accepts what comes back.
 *
 * WHY it is one table (2026-09-18, from three of Destin's sessions): the two
 * halves had drifted. The advertised schema was a FLAT object with every
 * kind's fields optional on every step, while Zod was a strict per-kind union.
 * Constrained decoding follows the advertised one, so the model filled in all
 * ten fields on every step — `of`, `max_iterations`, `until` and `steps` on a
 * `map` — and Zod then rejected the lot with a bare list of unknown keys that
 * never said which kind was wrong or what that kind allows. Deriving both from
 * this table is what stops them disagreeing again; `plan-schema.test.ts` pins
 * the two against each other branch by branch.
 */
const STEP_KINDS = ['map', 'verify', 'combine', 'repeat'] as const;
/** A repeat body holds LEAF steps: the kinds that cannot repeat again. This is
 *  the depth bound — see the runaway note on `steps` below. */
const LEAF_STEP_KINDS = ['map', 'verify', 'combine'] as const;
type StepKind = (typeof STEP_KINDS)[number];

const COMMON_STEP_FIELDS = ['id', 'kind', 'specialist', 'task', 'budget_tokens'] as const;
/**
 * Fields EVERY kind may carry and no kind must.
 *
 * WHY they are in this table rather than added to one half (decision 30,
 * 2026-09-18): `summary` is the plain sentence the card shows the person
 * approving the plan, and it is optional so that every plan written before it
 * existed — and every model that ignores it — still validates untouched. It
 * still has to reach BOTH halves from here, because a field advertised to the
 * decoder but absent from Zod is precisely what produced the owner's "unknown
 * parameter(s)" failure, and a field Zod knows but the schema never advertises
 * is a field no model will ever write.
 */
const OPTIONAL_COMMON_STEP_FIELDS = ['summary'] as const;
/** The extra fields each kind owns — and the ONLY ones it accepts. */
const KIND_FIELDS: Record<StepKind, readonly string[]> = {
  map: ['items'],
  verify: ['of'],
  combine: ['of'],
  repeat: ['max_iterations', 'until', 'steps'],
};
/** Every field any kind can carry, used to tell "belongs to another kind" from
 *  "not a parameter at all" — the two deserve different sentences. */
const ALL_STEP_FIELDS = new Set<string>([...COMMON_STEP_FIELDS, ...OPTIONAL_COMMON_STEP_FIELDS, 'items', 'of', 'max_iterations', 'until', 'steps']);

const allowedFieldsFor = (kind: StepKind): string[] => [...COMMON_STEP_FIELDS, ...OPTIONAL_COMMON_STEP_FIELDS, ...KIND_FIELDS[kind]];
/** What a step of this kind MUST carry — the allowed set minus the optional
 *  common fields. Separate from `allowedFieldsFor` since 2026-09-18, when the
 *  first optional field arrived: `required` and "accepted" stopped being the
 *  same list. */
const requiredFieldsFor = (kind: StepKind): string[] => [...COMMON_STEP_FIELDS, ...KIND_FIELDS[kind]];

// ---------------------------------------------------------------------------
// The model-facing grammar (JSON Schema), one branch per kind.
// ---------------------------------------------------------------------------

const JSON_FIELD = {
  id: { type: 'string', minLength: 1, maxLength: PLAN_MAX_ID_CHARS, description: 'Short unique step id, e.g. "s1".' },
  specialist: { type: 'string', enum: ['explorer', 'researcher', 'reviewer', 'worker'] },
  task: { type: 'string', minLength: 1, maxLength: PLAN_MAX_TASK_CHARS, description: 'What each child does. For map, may reference {item}.' },
  budget_tokens: { type: 'integer', minimum: PLAN_MIN_BUDGET_TOKENS, maximum: PLAN_MAX_BUDGET_TOKENS },
  summary: { type: 'string', minLength: 1, maxLength: PLAN_MAX_SUMMARY_CHARS, description: 'One plain sentence for the user who approves this plan, in everyday words: what this step does. Not a restatement of task, no jargon, no file paths or tool names.' },
  items: { type: 'array', items: { type: 'string', minLength: 1, maxLength: PLAN_MAX_ITEM_CHARS }, minItems: 1, maxItems: PLAN_MAX_MAP_ITEMS, description: 'map only: one child per item.' },
  of: { type: 'string', minLength: 1, maxLength: PLAN_MAX_ID_CHARS, description: 'verify/combine: the id of the step whose results this consumes.' },
  max_iterations: { type: 'integer', minimum: 1, maximum: PLAN_MAX_REPEAT_ITERATIONS, description: 'repeat only: hard cap.' },
  until: { type: 'string', minLength: 1, maxLength: PLAN_MAX_UNTIL_CHARS, description: 'repeat only: plain-words stop condition.' },
  // WHY a repeat body is LEAF steps and nothing deeper: `steps` used to point
  // back at the full step, so a model doing constrained decoding could descend
  // steps→steps→steps with nothing to stop it. Three real calls did exactly
  // that — 343, 353 and 206 levels of filler steps — until the output-token cap
  // cut the arguments mid-string and the plan died. validator.ts rejects a
  // repeat inside a repeat anyway, so the unbounded form could only ever
  // produce documents the semantics would refuse.
  steps: { type: 'array', items: { $ref: '#/$defs/leafStep' }, minItems: 1, maxItems: PLAN_MAX_REPEAT_BODY_STEPS, description: 'repeat only: the steps to repeat. These may not repeat again.' },
} as const;

const KIND_DESCRIPTION: Record<StepKind, string> = {
  map: 'Run one child per item.',
  verify: 'Check an earlier step\'s results.',
  combine: 'Merge an earlier step\'s results.',
  repeat: 'Run a short body up to max_iterations times.',
};

function jsonStepBranch(kind: StepKind): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    id: JSON_FIELD.id,
    kind: { type: 'string', enum: [kind], description: KIND_DESCRIPTION[kind] },
    specialist: JSON_FIELD.specialist,
    task: JSON_FIELD.task,
    budget_tokens: JSON_FIELD.budget_tokens,
  };
  for (const field of OPTIONAL_COMMON_STEP_FIELDS) properties[field] = JSON_FIELD[field as keyof typeof JSON_FIELD];
  for (const field of KIND_FIELDS[kind]) properties[field] = JSON_FIELD[field as keyof typeof JSON_FIELD];
  return {
    type: 'object',
    additionalProperties: false,
    // Every field a kind OWNS is REQUIRED for that kind — a `map` without
    // `items` is not a map. This is what makes the branches mutually exclusive,
    // so `anyOf` picks exactly one and the decoder cannot mix two kinds' fields.
    // The optional common fields are advertised but never required, which keeps
    // the branches exclusive on `kind` exactly as before.
    required: requiredFieldsFor(kind),
    properties,
  };
}

export const PLAN_DOCUMENT_JSON_SCHEMA = {
  $defs: {
    // `anyOf` rather than `oneOf`: the branches are already mutually exclusive
    // on `kind`, and anyOf is the form providers support most widely.
    leafStep: { anyOf: LEAF_STEP_KINDS.map(jsonStepBranch) },
    step: { anyOf: STEP_KINDS.map(jsonStepBranch) },
  },
  type: 'object',
  additionalProperties: false,
  required: ['goal', 'steps'],
  properties: {
    goal: { type: 'string', minLength: 1, maxLength: PLAN_MAX_GOAL_CHARS, description: 'One sentence: what the whole plan achieves.' },
    steps: { type: 'array', items: { $ref: '#/$defs/step' }, minItems: 1, maxItems: PLAN_MAX_TOP_LEVEL_STEPS },
  },
} as const;

// ---------------------------------------------------------------------------
// The runtime schema (Zod), built from the same table.
// ---------------------------------------------------------------------------

const nonEmptyBounded = (maximum: number) => z.string().min(1).max(maximum).refine((value) => value.trim().length > 0, 'Must contain non-whitespace text');

type PlanStep = {
  id: string; kind: StepKind; specialist: string; task: string; budget_tokens: number;
  summary?: string;
  items?: string[]; of?: string; max_iterations?: number; until?: string; steps?: PlanStep[];
};

/**
 * Name the kind and the fields it accepts, rather than listing unknown keys.
 *
 * WHY (2026-09-18): the model was told `unknown parameter(s) "steps.0.of",
 * "steps.0.max_iterations", "steps.0.until", "steps.0.steps"` twelve times over
 * and had no way to tell WHICH of its three steps was wrong, what kind they
 * were, or what a step of that kind may carry. It repaired the wrong thing and
 * the plan died. A field that belongs to ANOTHER kind is a different mistake
 * from a field that is not a parameter at all, and reads differently here; a
 * genuinely unknown key is left to the object's own strictness.
 */
function checkKindFields(step: PlanStep, ctx: z.RefinementCtx): void {
  const allowed = allowedFieldsFor(step.kind);
  const allowedSet = new Set(allowed);
  const present = Object.keys(step).filter((key) => (step as Record<string, unknown>)[key] !== undefined);

  const foreign = present.filter((key) => ALL_STEP_FIELDS.has(key) && !allowedSet.has(key));
  if (foreign.length > 0) {
    ctx.addIssue({
      code: 'custom',
      message: `a "${step.kind}" step accepts only ${allowed.join(', ')} — remove ${foreign.join(', ')}`,
    });
  }
  const missing = KIND_FIELDS[step.kind].filter((field) => (step as Record<string, unknown>)[field] === undefined);
  if (missing.length > 0) {
    ctx.addIssue({
      code: 'custom',
      message: `a "${step.kind}" step needs ${missing.join(', ')}`,
    });
  }
}

/** One object shape for every kind, narrowed by `kinds` and then policed by
 *  checkKindFields. Keeping every field in the shape is deliberate: it is what
 *  lets a wrong-kind field get the sentence above instead of zod's bare
 *  "unrecognized key". */
function stepSchema(kinds: readonly StepKind[]): z.ZodType<PlanStep> {
  return z.object({
    id: nonEmptyBounded(PLAN_MAX_ID_CHARS),
    kind: z.enum(kinds as unknown as [StepKind, ...StepKind[]]),
    // The model-facing schema is intentionally the four built-ins proven by the
    // probe. Runtime parsing stays open because a live roster can include custom ids.
    specialist: nonEmptyBounded(PLAN_MAX_ID_CHARS),
    task: nonEmptyBounded(PLAN_MAX_TASK_CHARS),
    budget_tokens: z.number().int().min(PLAN_MIN_BUDGET_TOKENS).max(PLAN_MAX_BUDGET_TOKENS),
    // Optional on every kind, and the same bound the advertised schema states.
    summary: nonEmptyBounded(PLAN_MAX_SUMMARY_CHARS).optional(),
    items: z.array(nonEmptyBounded(PLAN_MAX_ITEM_CHARS)).min(1).max(PLAN_MAX_MAP_ITEMS).optional(),
    of: nonEmptyBounded(PLAN_MAX_ID_CHARS).optional(),
    max_iterations: z.number().int().min(1).max(PLAN_MAX_REPEAT_ITERATIONS).optional(),
    until: nonEmptyBounded(PLAN_MAX_UNTIL_CHARS).optional(),
    // A repeat body holds leaves only — the depth bound, mirroring the grammar.
    // On a leaf this field is always foreign, so the element schema is never
    // reached there; it is in the shape so `steps` on a map reads as a
    // wrong-kind field rather than an unknown one.
    steps: z.array(z.lazy(() => PlanLeafStepSchema)).min(1).max(PLAN_MAX_REPEAT_BODY_STEPS).optional(),
  }).strict().superRefine(checkKindFields) as unknown as z.ZodType<PlanStep>;
}

const PlanLeafStepSchema: z.ZodType<PlanStep> = z.lazy(() => stepSchema(LEAF_STEP_KINDS));
const PlanStepSchema: z.ZodType<PlanStep> = z.lazy(() => stepSchema(STEP_KINDS));

export const PlanDocumentSchema = z.object({
  goal: nonEmptyBounded(PLAN_MAX_GOAL_CHARS),
  steps: z.array(PlanStepSchema).min(1).max(PLAN_MAX_TOP_LEVEL_STEPS),
}).strict();

export type PlanDocumentV1 = z.infer<typeof PlanDocumentSchema>;
export type PlanStepV1 = PlanStep;
