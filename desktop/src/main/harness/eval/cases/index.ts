import { HARNESS_BATTERY } from './harness-battery';
import { CODE_EXPLANATION } from './code-explanation';
import { EVERYDAY_BAKERY, EVERYDAY_LAPTOP, EVERYDAY_ROME, EVERYDAY_SYSTEM32 } from './everyday';
import { CONFIG_INVESTIGATION } from './config-investigation';
import { OPTIONS_PROPOSAL } from './options-proposal';
import { PORT_BUMP } from './port-bump';
import type { EvalCase } from '../case-types';

// WHY the registry is built from the list rather than hand-written as an object
// literal keyed by string: a hand-written key can disagree with the case's own
// `id` (a copy-paste that renames the key but not the body), and `getCase` would
// then return a case whose id is not the one that was asked for — which is
// billed and reported as the case the plan named. Keying off `c.id` makes that
// unrepresentable.
const ALL: EvalCase[] = [
  HARNESS_BATTERY,
  // The four CLAUDE.md-guidance cases (test-engine/eval-plans/claude-md-guidance.json).
  CONFIG_INVESTIGATION,
  OPTIONS_PROPOSAL,
  PORT_BUMP,
  CODE_EXPLANATION,
  // Everyday non-coding requests (test-engine/eval-plans/persona-prompt.json).
  EVERYDAY_BAKERY,
  EVERYDAY_LAPTOP,
  EVERYDAY_SYSTEM32,
  EVERYDAY_ROME,
];

const CASES: Record<string, EvalCase> = {};
for (const body of ALL) {
  // A duplicate id would silently drop one whole case while a plan naming it
  // ran a different one — the same class of bug as the key/id mismatch above,
  // and equally invisible in a report. Caught at import time.
  if (CASES[body.id]) throw new Error(`Duplicate eval case id "${body.id}" in cases/index.ts.`);
  CASES[body.id] = body;
}

export function allCaseIds(): string[] {
  return Object.keys(CASES).sort();
}

export function getCase(id: string): EvalCase {
  const found = CASES[id];
  // WHY name the known ids: a typo'd case id in a test plan is the most likely
  // failure here, and "unknown case: confgi-investigation" without the list
  // sends you reading source to find the right spelling.
  if (!found) throw new Error(`Unknown case "${id}". Known cases: ${allCaseIds().join(', ')}`);
  return found;
}
