import { z } from 'zod';

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
// WHY 128 (spending rework stage 1, design §2 / decision 35.4): a model id
// like "anthropic/claude-opus-4-7-20260901" is well under this; the field
// only ever holds "budget", "frontier" or one exact model id.
const PLAN_MAX_MODEL_CHARS = 128;

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

/**
 * WHY `summary` is REQUIRED here rather than optional (decision 33, Destin
 * 2026-09-18: "i'm not sure what the benefit would be of making it optional"):
 * every step — including every step of a repeat body — draws its own row on the
 * approval card, and that row's words ARE the summary. Optional meant a plan
 * could reach the person approving real spending with nothing but the first
 * line of a prompt written for a machine on every row. Old journals that were
 * written without it may now fail to parse; the owner accepted that explicitly
 * ("all of the existing plans are demos").
 */
const COMMON_STEP_FIELDS = ['id', 'kind', 'specialist', 'task', 'summary'] as const;
/**
 * Fields EVERY kind may carry and no kind must.
 *
 * WHY the list stays although it used to be EMPTY (decision 33): it is the
 * mechanism that carries a field to BOTH halves of the schema — the advertised
 * JSON Schema and Zod — without making it required, and `requiredFieldsFor`
 * exists only because of it. A field advertised to the decoder but absent from
 * Zod is precisely what produced the owner's "unknown parameter(s)" failure,
 * and a field Zod knows but the schema never advertises is a field no model
 * will ever write.
 *
 * WHY `model` lives here (spending rework stage 1, design §2 / §9, decision
 * 35.4): "any step's model can be changed" is a per-step override, and the
 * grammar's only vocabulary for "this field applies to every kind" is this
 * list — a `map`, `verify`, `combine` or `repeat` step may all name a model.
 * `budget_tokens` used to be the one REQUIRED common field forcing the model
 * to predict a per-step cost (decision 34: "it forces the model to try and
 * predict how much each step is gonna cost, and that just doesn't make
 * sense") — removed entirely, not replaced.
 */
const OPTIONAL_COMMON_STEP_FIELDS: readonly string[] = ['model'];
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
  summary: { type: 'string', minLength: 1, maxLength: PLAN_MAX_SUMMARY_CHARS, description: 'One plain sentence for the user who approves this plan, in everyday words: what this step does. Not a restatement of task, no jargon, no file paths or tool names.' },
  // WHY optional, not required (design §2): every step runs on its
  // specialist's default model unless the user explicitly asked for a
  // particular one — see propose_plan's own description (tools/propose-plan.ts).
  // Issue 3 fix (owner's live test): the softer wording this replaced ("Only
  // when the user explicitly asked... Otherwise omit.") still let a model set
  // this field on its own judgment (a live plan froze gpt-6-sol on a step
  // nobody asked to change) — decision 35.4 is an outright "assistant never
  // decides this", not a preference, so the field description says so as a
  // prohibition, not a condition.
  model: { type: 'string', maxLength: PLAN_MAX_MODEL_CHARS, description: 'Leave unset. Do NOT set this yourself for any reason (a step seeming hard, slow, cheap, or important is not a reason) — that is the user\'s decision alone, never yours. Set it ONLY when the user has explicitly named a model or provider for this exact step, earlier in this conversation: "budget", "frontier", or an exact model id.' },
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
  // Built by walking the ONE table, in its order, so a field added to
  // COMMON_STEP_FIELDS cannot reach Zod and miss the advertised schema.
  const properties: Record<string, unknown> = {};
  for (const field of COMMON_STEP_FIELDS) {
    properties[field] = field === 'kind'
      ? { type: 'string', enum: [kind], description: KIND_DESCRIPTION[kind] }
      : JSON_FIELD[field as keyof typeof JSON_FIELD];
  }
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
  id: string; kind: StepKind; specialist: string; task: string;
  summary: string;
  items?: string[]; of?: string; max_iterations?: number; until?: string; steps?: PlanStep[];
  /** Design §2/§9: a per-step model override, resolved by plan-host-bridge.ts
   *  `resolveManifest` (T4) — "budget"/"frontier" or an exact model id. */
  model?: string;
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
    // Decision 33: required on every kind, and the same bound the advertised
    // schema states. A step without a plain sentence has nothing to show the
    // person approving it.
    summary: nonEmptyBounded(PLAN_MAX_SUMMARY_CHARS),
    // Design §2/§9: optional per-step model override — never required, since
    // every step defaults to its specialist's own model.
    model: z.string().min(1).max(PLAN_MAX_MODEL_CHARS).optional(),
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
