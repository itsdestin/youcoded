// Specialists plans, Task 9a — who deals with a pause.
// Design: youcoded-dev docs/active/design/2026-09-16-specialists-plans-pause-handoff.md
// §1 (routing table) and §2 (the actions the assistant may recommend).
//
// The product owner's rule (review deck 6, decision 13): obvious pauses are
// recovered automatically where that is safe, the rest are handed to the
// assistant, and only what genuinely needs the person stays with them. Nobody
// but the person ever spends money or restarts work, so `auto` is only ever a
// ONE-time retry of something that provably did nothing outside this computer.
//
// This is one pure function so the executor (which decides at the moment a
// specialist fails) and Task 9b (which decides from the saved pause) can never
// disagree about a pause.
import type { PlanPauseKind } from '../../../shared/types';
import type { ToolEffect } from '../tools/types';
import type { PlanRecord } from './types';

export type PlanPauseRoute = 'auto' | 'assistant' | 'user';
/** What the card may offer / the assistant may recommend (§2 table). */
export type PlanPauseAction = 'add_budget' | 'continue' | 'stop';
/** The pause kinds that can be recovered automatically; also the `cause` of
 *  a journalled recovery (one per step, iteration, item and cause). */
export type PlanRecoveryCause = 'launch-failed' | 'specialist-error' | 'invalid-report' | 'unknown-request' | 'unknown-outcome';
/** A pause kind, or a plan interrupted by an app restart (not a pause kind,
 *  but it has a route: the person presses Continue — signed R9). */
export type PlanPauseSituation = PlanPauseKind | 'interrupted';

export interface PlanPauseContext {
  /** launch-failed: the start was REFUSED (the budget route is unusable or
   *  switched off). A refusal would only repeat, so it is never retried. */
  launchRefused?: boolean;
  /** A specialist's definition, model or price changed since approval.
   *  Never retried: the fix is a newly proposed plan. */
  drift?: boolean;
  /** An automatic recovery already ran for this step, iteration, item and
   *  cause — this is the second failure. */
  alreadyRecovered?: boolean;
  /** unknown-outcome: the effect of the call that has no recorded result.
   *  Absent counts as `external` (the safe direction). */
  toolEffect?: ToolEffect;
  /** The specialist's transcript ends in an `external` call with no result.
   *  Checked before EVERY automatic restart: repeating it could send
   *  something twice (review 1, finding 14). */
  unansweredExternal?: boolean;
  /** invalid-report: the failed attempt left at least the report-only turn's
   *  allowance unspent. Anything else (including unknown) is not fundable. */
  reportOnlyFundable?: boolean;
}

export interface PlanPauseRouting {
  route: PlanPauseRoute;
  /** For `assistant`/`user`: the actions allowed for this pause (§2). Empty
   *  for `auto` — nobody is asked. */
  actions: readonly PlanPauseAction[];
  /** For `auto`: the cause the one recovery is counted under. */
  recoveryCause?: PlanRecoveryCause;
}

const STOP_ONLY: readonly PlanPauseAction[] = ['stop'];
const BUDGET: readonly PlanPauseAction[] = ['add_budget', 'stop'];
const CONTINUE_OR_STOP: readonly PlanPauseAction[] = ['continue', 'stop'];

const toAssistant = (actions: readonly PlanPauseAction[]): PlanPauseRouting => ({ route: 'assistant', actions: [...actions] });

export function routePlanPause(kind: PlanPauseSituation, ctx: PlanPauseContext = {}): PlanPauseRouting {
  switch (kind) {
    // The person's own: they stopped a specialist, or the app restarted.
    case 'specialist-stopped':
    case 'interrupted':
      return { route: 'user', actions: [...CONTINUE_OR_STOP] };
    // Budget kinds: more budget can help, and only the person can add it.
    case 'budget':
    case 'ceiling-shortfall':
      return ctx.drift ? toAssistant(STOP_ONLY) : toAssistant(BUDGET);
    // Nothing Continue or budget can fix here; the fix is a revised plan.
    // local-pool: the pool check is this plan's own fixed capacity, so
    // waiting can never help (review 1, finding 1).
    case 'plan-limit':
    case 'budget-refused':
    case 'iteration-cap':
    case 'local-pool':
      return toAssistant(STOP_ONLY);
    case 'unexpected-error':
      return ctx.drift ? toAssistant(STOP_ONLY) : toAssistant(CONTINUE_OR_STOP);
    default:
      break;
  }
  // The recoverable kinds.
  if (ctx.drift || (kind === 'launch-failed' && ctx.launchRefused)) return toAssistant(STOP_ONLY);
  if (kind === 'unknown-outcome' && (ctx.toolEffect ?? 'external') === 'external') return toAssistant(CONTINUE_OR_STOP);
  if (kind === 'invalid-report' && ctx.reportOnlyFundable !== true) return toAssistant(CONTINUE_OR_STOP);
  if (ctx.unansweredExternal || ctx.alreadyRecovered) return toAssistant(CONTINUE_OR_STOP);
  return { route: 'auto', actions: [], recoveryCause: kind };
}

/** The facts a saved pause carries (journal `paused` / PlanView `paused`). */
export interface RecordedPauseFacts {
  kind?: PlanPauseKind;
  tool?: string;
  toolEffect?: ToolEffect;
  launch?: 'refused' | 'drift';
  retried?: true;
}

/**
 * The route of a pause that is already on the card — Task 9b's entry point.
 * WHY never `auto`: a pause is only written when the executor did NOT recover
 * it (a second failure, an unfundable report turn, a missing decision), so a
 * recoverable kind read back here belongs to the assistant. A journal written
 * before `kind` existed reads as an unexpected problem.
 */
export function pausedRouting(paused: RecordedPauseFacts): PlanPauseRouting {
  const routed = routePlanPause(paused.kind ?? 'unexpected-error', {
    ...(paused.launch === 'refused' ? { launchRefused: true } : {}),
    ...(paused.launch === 'drift' ? { drift: true } : {}),
    ...(paused.retried ? { alreadyRecovered: true } : {}),
    ...(paused.toolEffect ? { toolEffect: paused.toolEffect } : {}),
  });
  return routed.route === 'auto' ? toAssistant(CONTINUE_OR_STOP) : routed;
}

/**
 * Review fix 4 (controller decision, decision 13's intent): the person's own
 * Continue gives every piece of work it resumes its one automatic retry back.
 * Applied inside the same journal write that takes the lease. "Resumed" = an
 * item whose newest attempt has not finished with a report; a finished item's
 * record is left alone. Entries are marked, not deleted, so the card can still
 * say a specialist was retried.
 */
export function resetRecoveriesForContinue(plan: PlanRecord): void {
  for (const r of plan.recoveries ?? []) {
    if (r.reset) continue;
    const attempts = plan.steps.find((s) => s.id === r.stepId)?.attempts
      .filter((a) => a.itemIndex === r.itemIndex && a.iteration === r.iteration) ?? [];
    const latest = attempts[attempts.length - 1];
    const finished = latest !== undefined && (latest.phase === 'committed' || latest.completedAt !== undefined) && latest.terminal === 'completed';
    if (!finished) r.reset = true;
  }
}
