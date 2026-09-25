import { PlanDocumentSchema, ofIds, type PlanDocumentV1, type PlanStepV1 } from './schema';
import type { SpecialistRoster } from '../specialists/registry';

// WHY `ceilingTokens` is gone (spending rework stage 1, decision 34): the
// model no longer predicts a per-step cost, so there is nothing left to sum
// into a worst-case token ceiling. `maximumAttempts` (kept — decision 33.1,
// "hire a specialist directly instead of proposing a plan" still needs the
// worst-case RUN count) and `maxFanOut` are unaffected by that removal.
export type PlanValidation =
  | { ok: true; document: PlanDocumentV1; maximumAttempts: number; maxFanOut: number }
  | { ok: false; issues: string[] };

/** Validate constraints that JSON Schema cannot express without losing grammar recursion. */
export function validatePlanDocument(input: unknown, roster: SpecialistRoster): PlanValidation {
  const parsed = PlanDocumentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'document'}: ${issue.message}`) };

  const issues: string[] = [];
  const ids = new Set<string>();
  let maximumAttempts = 0;
  let maxFanOut = 0;

  const visit = (step: PlanStepV1, priorIds: Set<string>, inRepeat: boolean, multiplier: number): void => {
    if (ids.has(step.id)) issues.push(`duplicate step id "${step.id}"`);
    ids.add(step.id);
    if (!roster.resolve(step.specialist)) issues.push(`unknown specialist "${step.specialist}"`);

    if (step.kind === 'map') {
      const attempts = step.items!.length * multiplier;
      maximumAttempts += attempts;
      maxFanOut = Math.max(maxFanOut, step.items!.length);
    } else if (step.kind === 'verify' || step.kind === 'combine') {
      // Decision 39: `of` may name several earlier steps — every one of them
      // must actually be earlier, not just the first.
      for (const ref of ofIds(step.of)) {
        if (!priorIds.has(ref)) issues.push(`${step.id}: reference "${ref}" must name an earlier step`);
      }
      maximumAttempts += multiplier;
      maxFanOut = Math.max(maxFanOut, 1);
    } else {
      if (inRepeat) issues.push(`${step.id}: nested repeat is not allowed`);
      // WHY recursive JSON Schema remains necessary for constrained decoding, while
      // this pass prohibits semantic nesting the model-facing grammar must allow.
      const bodyPrior = new Set(priorIds);
      for (const child of step.steps!) {
        visit(child, bodyPrior, true, multiplier * step.max_iterations!);
        bodyPrior.add(child.id);
      }
    }
  };

  const priorIds = new Set<string>();
  for (const step of parsed.data.steps) {
    visit(step, priorIds, false, 1);
    priorIds.add(step.id);
  }

  // WHY a whole plan may not be one specialist run (decision 33, Destin
  // 2026-09-18: "if the entire plan is a single specialist doing a single
  // thing, its a shitty plan and should just be a specialist call"). The rule
  // belongs to the PLAN, not the step — a one-item split is still how the
  // assistant puts a single worker inside a larger plan — and `maximumAttempts`
  // is already exactly the number the rule is about: the worst case count of
  // specialist runs, items times repeat rounds included.
  if (maximumAttempts < 2) {
    issues.push('this plan\'s whole worst case is one specialist doing one thing — hire a specialist directly instead of proposing a plan');
  }

  return issues.length ? { ok: false, issues } : { ok: true, document: parsed.data, maximumAttempts, maxFanOut };
}
