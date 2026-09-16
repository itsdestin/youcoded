import type { PlanView } from '../../../shared/types';

/**
 * Specialists plans, Task 5b — which kind of pause gets its own card?
 *
 * Two pauses need a different card from the ordinary "reached its limit" one:
 *  - unknown outcome: a specialist was cut off after starting an action that
 *    can change things (a command, a file write…), and nobody knows whether it
 *    finished. Continue may run it again, so the card warns first.
 *  - iteration cap: a repeating step used all its rounds. More budget or
 *    Continue cannot help (the executor pauses again at once), so the card
 *    offers only Stop and suggests asking for a revised plan.
 *
 * WHY the executor's `paused.kind` (5b follow-up) and not its sentence: the
 * card used to recognise these two by matching the reason text, which broke
 * silently on any rewording. The executor now records the kind and the facts
 * the card words the pause from (`tool`, `repeat`, `note`).
 *
 * No sentence fallback for a journal without `kind`: plans have not shipped,
 * so such a journal only exists on a development machine, and there the pause
 * simply shows as an ordinary one with the host's own reason — true, just
 * less specific. A pause whose facts are missing is treated the same way,
 * rather than printing a sentence with a blank in it.
 */
export type PauseKind =
  | { kind: 'unknown-outcome'; tool: string; rest: string }
  | { kind: 'iteration-cap'; rounds: number; until: string }
  | { kind: 'other' };

export function classifyPause(paused: PlanView['paused']): PauseKind {
  if (paused?.kind === 'unknown-outcome' && paused.tool) {
    return { kind: 'unknown-outcome', tool: paused.tool, rest: paused.note ?? '' };
  }
  if (paused?.kind === 'iteration-cap' && paused.repeat) {
    return { kind: 'iteration-cap', rounds: paused.repeat.rounds, until: paused.repeat.until };
  }
  return { kind: 'other' };
}
