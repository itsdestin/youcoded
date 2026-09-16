import type { PlanView } from '../../../shared/types';

/**
 * Specialists plans, Task 5b — which kind of pause is this?
 *
 * Two pauses need a different card from the ordinary "reached its limit" one:
 *  - unknown outcome: a specialist was cut off after starting an action that
 *    can change things (a command, a file write…), and nobody knows whether it
 *    finished. Continue may run it again, so the card warns first.
 *  - iteration cap: a repeating step used all its rounds. More budget or
 *    Continue cannot help (the executor pauses again at once), so the card
 *    offers only Stop and suggests asking for a revised plan.
 *
 * WHY read the backend's sentence: PlanView.paused carries only
 * { stepId, reason, minimumAddTokens } — no kind and no tool name (a question
 * for the product owner in the Task 5b report). Until it does, the two
 * executor templates are the only signal. tests/plan-pause.test.ts pins those
 * templates in plan-executor.ts, so a wording change there fails a test
 * rather than quietly downgrading these cards to ordinary pauses.
 */
export type PauseKind =
  | { kind: 'unknown-outcome'; tool: string; rest: string }
  | { kind: 'iteration-cap'; rounds: number; until: string }
  | { kind: 'other' };

// Only the "its last action (<tool>)" form: an unanswered REQUEST (no tool)
// changes nothing outside the conversation, so it keeps the ordinary card.
const UNKNOWN_OUTCOME = /^A specialist in step "[^"]*" was cut off, and it isn't known whether its last action \((.+?)\) finished\. Press Continue to let it pick up from what it recorded\.\s*([\s\S]*)$/;
const ITERATION_CAP = /^The repeated steps ran (\d+) times without meeting their stop condition \("([\s\S]*)"\)\. Ask the assistant to revise the plan\.$/;

export function classifyPause(paused: PlanView['paused']): PauseKind {
  if (!paused) return { kind: 'other' };
  const reason = paused.reason.trim();
  const unknown = UNKNOWN_OUTCOME.exec(reason);
  if (unknown) return { kind: 'unknown-outcome', tool: unknown[1], rest: unknown[2].trim() };
  const cap = ITERATION_CAP.exec(reason);
  if (cap) return { kind: 'iteration-cap', rounds: Number(cap[1]), until: cap[2] };
  return { kind: 'other' };
}
