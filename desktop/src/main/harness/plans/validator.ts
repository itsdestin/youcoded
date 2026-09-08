import { PlanDocumentSchema, type PlanDocumentV1, type PlanStepV1 } from './schema';
import type { SpecialistRoster } from '../specialists/registry';

export type PlanValidation =
  | { ok: true; document: PlanDocumentV1; maximumAttempts: number; ceilingTokens: number; maxFanOut: number }
  | { ok: false; issues: string[] };

/** Validate constraints that JSON Schema cannot express without losing grammar recursion. */
export function validatePlanDocument(input: unknown, roster: SpecialistRoster): PlanValidation {
  const parsed = PlanDocumentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'document'}: ${issue.message}`) };

  const issues: string[] = [];
  const ids = new Set<string>();
  let maximumAttempts = 0;
  let ceilingTokens = 0;
  let maxFanOut = 0;

  const visit = (step: PlanStepV1, priorIds: Set<string>, inRepeat: boolean, multiplier: number): void => {
    if (ids.has(step.id)) issues.push(`duplicate step id "${step.id}"`);
    ids.add(step.id);
    if (!roster.resolve(step.specialist)) issues.push(`unknown specialist "${step.specialist}"`);

    if (step.kind === 'map') {
      const attempts = step.items!.length * multiplier;
      maximumAttempts += attempts;
      ceilingTokens += attempts * step.budget_tokens;
      maxFanOut = Math.max(maxFanOut, step.items!.length);
    } else if (step.kind === 'verify' || step.kind === 'combine') {
      if (!priorIds.has(step.of!)) issues.push(`${step.id}: reference "${step.of}" must name an earlier step`);
      maximumAttempts += multiplier;
      ceilingTokens += multiplier * step.budget_tokens;
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

  return issues.length ? { ok: false, issues } : { ok: true, document: parsed.data, maximumAttempts, ceilingTokens, maxFanOut };
}
