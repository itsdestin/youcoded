// PlanSpend — the per-attempt spend recorder (specialists plans, spending
// rework T2; backend design §3). One object per plan specialist attempt,
// built by NativeSessionHost.startPlanChild and attached to that attempt's
// HarnessSession (as `planSpend`) so the ordinary request loop can call it
// exactly like it already calls `costForUsage` for the cost chip.
//
// WHY a class and not two closures: `afterReply` must chain its journal
// writes so two replies from the SAME attempt never race each other (a plan
// specialist can, in principle, start a new step before the previous one's
// write lands), and `spendSettled()` must be able to hand back whatever that
// chain currently is — including a write `afterReply` starts AFTER
// `spendSettled` was first called. A plain pair of functions closing over a
// module-level variable would work too, but couldn't be constructed once per
// attempt with its own journal coordinates without an object to hold them.
import { log } from '../../logger';
import type { PricedUsage } from '../pricing';
import { billedEquivalentTokens } from '../pricing';
import { PlanJournalIntegrityError, type PlanJournal } from './plan-journal';
import type { PlanRecord, PlanRef } from './types';

/** Design §3 (renamed from the deleted `PLAN_BUDGET_EXHAUSTED_STOP_REASON`):
 *  the turn-complete stopReason a plan specialist ends with when `beforeRequest`
 *  refuses its next request — never a finished report. Shared by
 *  harness-session.ts (emits it) and plan-executor.ts's transcript classifier
 *  (excludes it from "this turn ended in a report"), so it lives in the one
 *  module both already depend on. */
export const PLAN_LIMIT_REACHED_STOP_REASON = 'plan_limit_reached';

/** T3/X1 fix (review 2026-09-24, `docs/active/reviews/2026-09-24-plans-spending-T3-review.md`):
 *  mirrors plan-executor.ts's own `PlanSpendLimit` — kept as a separate small
 *  copy rather than an import so this file stays independent of
 *  plan-executor.ts's internals (which itself imports FROM this file, so the
 *  reverse import would be circular), the same reasoning `crossedLimit`
 *  below already used for `spendLimitCrossed`. */
type PlanSpendLimit = NonNullable<PlanRecord['spendLimit']>;

/** What one reply reports — exactly the shape the turn loop already has in
 *  hand (`step.usage`, and the SAME `costForUsage` call the chip uses). */
export interface PlanSpendReply {
  usage: PricedUsage;
  /** null exactly when the chip's own figure would be null (free, or no
   *  published price) — never a guessed rate. */
  costUsd: number | null;
}

/** `HarnessSessionOpts.planSpend`'s shape (design §3's `{beforeRequest,
 *  afterReply}` hook). Kept separate from the concrete `PlanSpend` class so
 *  harness-session.ts depends on the narrow contract it actually calls, not
 *  on the journal-writing machinery behind it. */
export interface PlanSpendHooks {
  /** Awaited at the top of every step, before `streamText`. Returns a stop
   *  reason (design §3: `PLAN_LIMIT_REACHED_STOP_REASON`) when the run's
   *  shared limit flag is set or this attempt's own write failed; undefined
   *  to go ahead. Always waits for every write started so far first, so a
   *  refusal is never based on a stale in-memory reading. */
  beforeRequest(): Promise<string | undefined>;
  /** Never throws, never returns a promise the caller must await — the write
   *  it starts runs in the background, overlapping tool execution, exactly
   *  like the chip's own cost figure does today. */
  afterReply(reply: PlanSpendReply): void;
}

/** design §3 "Concurrency": the flags every attempt of the SAME plan RUN
 *  shares, so one sibling's crossing or write failure is visible to every
 *  other sibling's own `beforeRequest` check, and to `commitReport`'s
 *  routing (Revision 2 E4). These live on plan-executor.ts's `ActiveRun` —
 *  threaded down through `PlanChildLaunch`/`PlanChildStart` as get/set pairs
 *  rather than handing the run object itself across the host boundary, so
 *  this module stays host-agnostic like the rest of `plans/*.ts`. */
export interface PlanSpendRunFlags {
  isLimitReached(): boolean;
  /** X1 fix: called with the limit value THIS write already knows (from
   *  `crossedLimit` below) — never `void` any more — so the executor's
   *  `requestHalt` can be called synchronously, with no journal re-read
   *  needed to find out what the limit was. */
  markLimitReached(limit: PlanSpendLimit): void;
  isWriteFailed(): boolean;
  markWriteFailed(): void;
}

export interface PlanSpendDeps extends PlanSpendRunFlags {
  journal: PlanJournal;
  ref: PlanRef;
  planId: string;
  stepId: string;
  attemptId: string;
  fence: string;
}

/** Design §4: the limit itself once this write pushed the plan's own used
 *  figure to or past it, in whichever unit the limit was set in — undefined
 *  when not crossed. A plan with no `spendLimit` is never crossed (decision
 *  34: "no limit by default"). X1 fix: returns the LIMIT, not a bare
 *  boolean, so `afterReply` below can hand it straight to `markLimitReached`
 *  — the executor's `requestHalt` no longer needs to re-read the plan just
 *  to learn what it already knew at this exact call site. */
function crossedLimit(plan: PlanRecord): PlanSpendLimit | undefined {
  const limit = plan.spendLimit;
  if (!limit) return undefined;
  const crossed = 'usd' in limit ? (plan.usedUsd ?? 0) >= limit.usd : plan.usedTokens >= limit.tokens;
  return crossed ? limit : undefined;
}

/**
 * One plan specialist attempt's spend recorder (design §3). `afterReply`
 * chains onto its own `pending` promise so replies from this SAME attempt
 * never race each other's journal write; `beforeRequest` and `spendSettled`
 * both read that CURRENT chain, never a value captured at construction.
 */
export class PlanSpend implements PlanSpendHooks {
  /** Always resolves — `afterReply`'s own `.catch` (Revision 1 D3) — so
   *  nothing awaiting it can ever see a rejection. */
  private pending: Promise<void> = Promise.resolve();
  /** Design §3: the running total the chip reads (Revision 3 F1's
   *  `runPlanChild` finally, via `total()`) — every reply this attempt has
   *  had `afterReply` called for, whether or not its journal write has
   *  landed yet. Kept in memory alongside the journal write (not read back
   *  from it) so the chip never waits on disk. */
  private totalUsage: PricedUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  private totalCostUsd: number | null = null;

  constructor(private readonly deps: PlanSpendDeps) {}

  afterReply(reply: PlanSpendReply): void {
    // In-memory total first: the chip must reflect this reply even while its
    // journal write is still in flight (and even if that write later fails —
    // design §3's crash-safety note: "a crash loses at most in-flight
    // replies, which the chip wouldn't have counted either" is about the
    // JOURNAL, not the live chip, which already showed the number).
    const billed = billedEquivalentTokens(reply.usage);
    this.totalUsage = {
      inputTokens: this.totalUsage.inputTokens + reply.usage.inputTokens,
      outputTokens: this.totalUsage.outputTokens + reply.usage.outputTokens,
      cacheReadTokens: this.totalUsage.cacheReadTokens + reply.usage.cacheReadTokens,
      cacheCreationTokens: this.totalUsage.cacheCreationTokens + reply.usage.cacheCreationTokens,
    };
    if (reply.costUsd !== null) this.totalCostUsd = (this.totalCostUsd ?? 0) + reply.costUsd;
    const { journal, ref, planId, stepId, attemptId, fence } = this.deps;
    // Chained onto the CURRENT pending, so two replies from this attempt
    // (a report-only retry racing a slow first write, say) never interleave
    // their journal.mutateFenced calls into one lock hold.
    this.pending = this.pending.then(() => journal.mutateFenced(ref, planId, fence, (plan) => {
      const step = plan.steps.find((s) => s.id === stepId);
      const attempt = step?.attempts.find((a) => a.attemptId === attemptId);
      if (!attempt) throw new PlanJournalIntegrityError(`No attempt ${attemptId} in step "${stepId}" (plan ${planId}).`);
      attempt.spentTokens += billed;
      plan.usedTokens += billed;
      if (reply.costUsd !== null) {
        attempt.spentUsd = (attempt.spentUsd ?? 0) + reply.costUsd;
        plan.usedUsd = (plan.usedUsd ?? 0) + reply.costUsd;
      }
      return crossedLimit(plan);
    })).then((crossed) => {
      // design §3: "The first crossing write sets the shared flag; a sibling
      // with a reply in flight finishes it ... and stops at its own
      // beforeRequest" — idempotent, so a later write that is ALSO past the
      // limit setting it again costs nothing.
      if (crossed) this.deps.markLimitReached(crossed);
    }, (e) => {
      // Revision 1 D3: never an unhandled rejection in the main process — the
      // failure is recorded on the shared run flag (beforeRequest and
      // commitReport both read it) and logged, and `pending` itself still
      // resolves so nothing awaiting it hangs.
      this.deps.markWriteFailed();
      log('ERROR', 'PlanSpend', 'a plan spend journal write failed', {
        planId, stepId, attemptId, error: String(e),
      });
    });
  }

  async beforeRequest(): Promise<string | undefined> {
    // Waits for every write started so far — including one a CONCURRENT
    // sibling's crossing set the shared flag from — before answering, so a
    // refusal (or a go-ahead) is never based on a stale in-memory reading.
    await this.pending;
    if (this.deps.isWriteFailed() || this.deps.isLimitReached()) return PLAN_LIMIT_REACHED_STOP_REASON;
    return undefined;
  }

  /** Revision 3 F2: the LIVE current chain at call time — never a value
   *  captured once at launch. A caller that awaits this after a THIRD
   *  `afterReply` was queued waits for that third write too. */
  spendSettled(): Promise<void> {
    return this.pending;
  }

  /** Design §3 / Revision 3 F1: the running total `runPlanChild`'s `finally`
   *  reports to the parent conversation's Cost chip — the SAME number the
   *  journal is converging on, read from memory so the chip never waits on
   *  disk. */
  total(): { usage: PricedUsage; costUsd: number | null } {
    return { usage: this.totalUsage, costUsd: this.totalCostUsd };
  }
}
