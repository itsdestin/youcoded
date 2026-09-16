// Specialists plans, Task 3 — the plan's token and dollar arithmetic
// (backend design §3 wave reservation, §4 budgets).
//
// Every number here lives in the plan journal and changes only through the
// journal's locked, fenced mutation — there is no second writer and no
// in-memory running total. That is what makes the ceiling a hard stop: two
// waves (or two windows) racing for the same remaining balance are serialized
// by the file lock, and each one sees what the other already reserved.
//
// The model: every specialist attempt has an allowance (its step's
// budget_tokens plus any Add budget tranches). While it is live it HOLDS the
// unspent part of that allowance (`reservedTokens`). Before each provider
// request the whole held amount is committed to that one request; the reply
// may use whatever the input does not. Afterwards the real usage is charged
// and the rest goes back to being held. Unknown usage is charged in full.
import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { PlanView } from '../../../shared/types';
import { costForUsage, isFreePricing, type ModelPricing } from '../pricing';
import type { PlanDocumentV1, PlanStepV1 } from './schema';
import { PlanJournal, PlanJournalIntegrityError, projectPlan } from './plan-journal';
import {
  adapterDisabledReason, disableAdapterForPlans,
  type PlanBudgetAdapter, type PlanChildRequestGate, type PlanRequestOutcome,
  type PlanRequestReservation, type PlanRequestSettlement,
} from './budget-adapter';
import type { ExecutionManifest, PlanAttemptRecord, PlanRecord, PlanRef } from './types';

// ---- pricing snapshot (the meaning of ExecutionManifest…pricing) ----

/**
 * What a specialist costs, frozen when the plan is proposed. Three honest
 * states, plus `null` for "no published price" — which is never the same as
 * free (docs/error-message-standards.md: no fabricated $0.00).
 */
export type PlanPricingSnapshot =
  | { kind: 'priced'; rates: ModelPricing }
  /** A cloud model whose published rates are all zero. */
  | { kind: 'free' }
  /** The user's own local engine: free, and shares one context pool. */
  | { kind: 'local' };

const RatesSchema = z.object({
  in: z.number().min(0), out: z.number().min(0),
  cacheRead: z.number().min(0).optional(), cacheWrite: z.number().min(0).optional(),
}).strict();
const SnapshotSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('priced'), rates: RatesSchema }).strict(),
  z.object({ kind: z.literal('free') }).strict(),
  z.object({ kind: z.literal('local') }).strict(),
]);

/** Build the snapshot the plan service freezes into the manifest. */
export function pricingSnapshot(input: { pricing: ModelPricing | null; free: boolean; local: boolean }): PlanPricingSnapshot | null {
  if (input.local) return { kind: 'local' };
  if (input.free || isFreePricing(input.pricing)) return { kind: 'free' };
  if (!input.pricing) return null;
  const { in: inRate, out, cacheRead, cacheWrite } = input.pricing;
  return {
    kind: 'priced',
    rates: { in: inRate, out, ...(cacheRead != null ? { cacheRead } : {}), ...(cacheWrite != null ? { cacheWrite } : {}) },
  };
}

/** Strict read: anything unrecognized is treated as "no published price". */
export function parsePricingSnapshot(raw: unknown): PlanPricingSnapshot | null {
  const parsed = SnapshotSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function snapshotFor(manifest: ExecutionManifest, specialist: string): PlanPricingSnapshot | null {
  return parsePricingSnapshot(manifest.specialists[specialist]?.pricing ?? null);
}

/**
 * Dollars for `tokens` when every one of them is billed at the model's
 * HIGHEST published rate (design §4). Conservative on purpose: a reserved
 * token may turn out to be input, output or a cache write, and the limit must
 * hold whichever it is. null for free/local/unpriced — never 0.
 */
export function worstCaseUsd(snapshot: PlanPricingSnapshot | null, tokens: number): number | null {
  if (!snapshot || snapshot.kind !== 'priced') return null;
  const r = snapshot.rates;
  const top = Math.max(r.in, r.out, r.cacheRead ?? 0, r.cacheWrite ?? 0);
  // Through costForUsage — the one place tokens become dollars.
  return costForUsage({ inputTokens: 0, outputTokens: tokens, cacheReadTokens: 0, cacheCreationTokens: 0 }, { in: top, out: top });
}

// ---- document helpers ----

/** Every executable (non-repeat) step with how many attempts it can have. */
function leafAllocations(steps: PlanStepV1[], multiplier = 1): Array<{ step: PlanStepV1; attempts: number }> {
  return steps.flatMap((step) => (step.kind === 'repeat'
    ? leafAllocations(step.steps!, multiplier * step.max_iterations!)
    : [{ step, attempts: (step.kind === 'map' ? step.items!.length : 1) * multiplier }]));
}

function executableStep(document: PlanDocumentV1, stepId: string): PlanStepV1 | undefined {
  return leafAllocations(document.steps).find((a) => a.step.id === stepId)?.step;
}

/**
 * The card's dollar limit: every possible attempt at its specialist's highest
 * rate. null when any specialist has no published price (the dollar limit
 * couldn't be honest), and null when nothing in the plan costs money (a local
 * or free plan shows tokens only — never "$0.00").
 */
export function planCeilingUsd(document: PlanDocumentV1, manifest: ExecutionManifest): number | null {
  let total = 0;
  let anyPriced = false;
  for (const { step, attempts } of leafAllocations(document.steps)) {
    const snapshot = snapshotFor(manifest, step.specialist);
    if (snapshot === null) return null;
    const usd = worstCaseUsd(snapshot, step.budget_tokens * attempts);
    if (usd === null) continue;
    total += usd;
    anyPriced = true;
  }
  return anyPriced ? total : null;
}

// ---- journal arithmetic ----

const isCommitted = (a: PlanAttemptRecord) => a.phase === 'committed' || a.completedAt !== undefined;
const allowanceLeft = (a: PlanAttemptRecord) => a.baseTokens + a.addedTokens - a.spentTokens;
const fmt = (n: number) => n.toLocaleString('en-US');
/** Float slack for dollar comparisons (a millionth of a cent). */
const USD_EPSILON = 1e-8;

function attemptsWithSpecialist(plan: PlanRecord): Array<{ attempt: PlanAttemptRecord; specialist: string }> {
  return plan.steps.flatMap((s) => {
    const def = executableStep(plan.document, s.id);
    return def ? s.attempts.map((attempt) => ({ attempt, specialist: def.specialist })) : [];
  });
}

export interface ReserveMember {
  stepId: string;
  /** Re-reserve an existing (restarting/resumed) attempt instead of creating one. */
  attemptId?: string;
  itemIndex?: number;
  iteration?: number;
}

export type ReserveResult =
  | { ok: true; attempts: Array<{ stepId: string; attemptId: string; reservedTokens: number }> }
  | { ok: false; reason: 'ceiling-tokens' | 'ceiling-usd' | 'local-pool' | 'invalid' | 'attempt-exhausted'; detail: string };

export interface PlanBudgetDeps {
  journal: PlanJournal;
  now?: () => number;
  newId?: () => string;
}

export class PlanBudget {
  private readonly journal: PlanJournal;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(deps: PlanBudgetDeps) {
    this.journal = deps.journal;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => randomUUID());
  }

  /**
   * Reserve a whole wave in ONE fenced write (design §3), or nothing at all.
   * Checked against everything already spent plus everything any live
   * attempt still holds: tokens, dollars at the highest rate, and — for local
   * specialists, when `localPoolTokens` is given — the one shared context
   * pool. A live local attempt claims its whole unspent allowance, because a
   * single request can fill that much context.
   */
  reserveAttempts(ref: PlanRef, planId: string, fence: string, members: ReserveMember[], opts: { localPoolTokens?: number } = {}): Promise<ReserveResult> {
    return this.journal.mutateFenced<ReserveResult>(ref, planId, fence, (plan) => {
      const invalid = (detail: string): ReserveResult => ({ ok: false, reason: 'invalid', detail });
      const planned: Array<{
        stepId: string; specialist: string; amount: number;
        existing?: PlanAttemptRecord; fresh?: PlanAttemptRecord; trancheIds?: string[];
      }> = [];
      const claimedTranches = new Set<string>();
      for (const member of members) {
        const def = executableStep(plan.document, member.stepId);
        const stepRec = plan.steps.find((s) => s.id === member.stepId);
        if (!def || !stepRec) return invalid(`Step "${member.stepId}" can't run a specialist.`);
        if (member.attemptId !== undefined) {
          const existing = stepRec.attempts.find((a) => a.attemptId === member.attemptId);
          if (!existing || isCommitted(existing)) return invalid(`Attempt ${member.attemptId} can't be restarted.`);
          if (existing.phase === 'request-sent' || existing.phase === 'ambiguous') {
            return invalid(`Attempt ${member.attemptId} has a request whose outcome isn't known yet.`);
          }
          if (existing.reservedTokens > 0 || planned.some((p) => p.existing === existing)) {
            return invalid(`Attempt ${member.attemptId} already holds its budget.`);
          }
          const amount = allowanceLeft(existing);
          if (amount <= 0) {
            return { ok: false, reason: 'attempt-exhausted', detail: `The specialist in step "${member.stepId}" has used its whole budget.` };
          }
          planned.push({ stepId: member.stepId, specialist: def.specialist, amount, existing });
          continue;
        }
        // An Add budget made before this step had an attempt belongs to its
        // FIRST new attempt (design §4: "explicitly named future attempts").
        const tranches = (plan.tranches ?? []).filter((t) => t.stepId === member.stepId && !t.attemptId && !claimedTranches.has(t.trancheId));
        tranches.forEach((t) => claimedTranches.add(t.trancheId));
        const added = tranches.reduce((n, t) => n + t.tokens, 0);
        const fresh: PlanAttemptRecord = {
          attemptId: this.newId(),
          itemIndex: member.itemIndex ?? 0,
          iteration: member.iteration ?? 0,
          baseTokens: def.budget_tokens,
          addedTokens: added,
          reservedTokens: 0,
          spentTokens: 0,
          phase: 'prepared',
        };
        planned.push({
          stepId: member.stepId, specialist: def.specialist, amount: def.budget_tokens + added,
          fresh, trancheIds: tranches.map((t) => t.trancheId),
        });
      }

      const live = attemptsWithSpecialist(plan).filter(({ attempt }) => !isCommitted(attempt));
      const newTokens = planned.reduce((n, p) => n + p.amount, 0);
      const heldTokens = live.reduce((n, { attempt }) => n + attempt.reservedTokens, 0);
      if (plan.usedTokens + heldTokens + newTokens > plan.ceilingTokens) {
        return {
          ok: false, reason: 'ceiling-tokens',
          detail: `Starting these specialists needs ${fmt(newTokens)} tokens, but only ${fmt(Math.max(0, plan.ceilingTokens - plan.usedTokens - heldTokens))} of the plan's limit are left.`,
        };
      }
      if (plan.ceilingUsd !== null) {
        const usd = (specialist: string, tokens: number) => worstCaseUsd(snapshotFor(plan.manifest, specialist), tokens) ?? 0;
        const held = live.reduce((n, { attempt, specialist }) => n + usd(specialist, attempt.reservedTokens), 0);
        const wanted = planned.reduce((n, p) => n + usd(p.specialist, p.amount), 0);
        if ((plan.usedUsd ?? 0) + held + wanted > plan.ceilingUsd + USD_EPSILON) {
          return { ok: false, reason: 'ceiling-usd', detail: "Starting these specialists could go past the plan's dollar limit." };
        }
      }
      if (opts.localPoolTokens !== undefined) {
        const isLocal = (specialist: string) => snapshotFor(plan.manifest, specialist)?.kind === 'local';
        const heldLocal = live.filter(({ specialist }) => isLocal(specialist)).reduce((n, { attempt }) => n + attempt.reservedTokens, 0);
        const wantedLocal = planned.filter((p) => isLocal(p.specialist)).reduce((n, p) => n + p.amount, 0);
        if (heldLocal + wantedLocal > opts.localPoolTokens) {
          return {
            ok: false, reason: 'local-pool',
            detail: `These local specialists would need ${fmt(heldLocal + wantedLocal)} tokens of context at once, more than the ${fmt(opts.localPoolTokens)} the local engine has.`,
          };
        }
      }

      // Every check passed — only now does anything change.
      const out: Array<{ stepId: string; attemptId: string; reservedTokens: number }> = [];
      for (const p of planned) {
        const target = p.existing ?? p.fresh!;
        target.reservedTokens = p.amount;
        if (p.fresh) {
          for (const t of plan.tranches ?? []) if (p.trancheIds?.includes(t.trancheId)) t.attemptId = p.fresh.attemptId;
          plan.steps.find((s) => s.id === p.stepId)!.attempts.push(p.fresh);
        }
        out.push({ stepId: p.stepId, attemptId: target.attemptId, reservedTokens: p.amount });
      }
      return { ok: true, attempts: out };
    });
  }

  /** The per-request gate a plan-child HarnessSession is given (Task 4 wires it). */
  requestGate(ref: PlanRef, planId: string, fence: string, stepId: string, attemptId: string, adapter: PlanBudgetAdapter): PlanChildRequestGate {
    const locate = (plan: PlanRecord) => {
      const attempt = plan.steps.find((s) => s.id === stepId)?.attempts.find((a) => a.attemptId === attemptId);
      const specialist = executableStep(plan.document, stepId)?.specialist;
      if (!attempt || specialist === undefined) throw new PlanJournalIntegrityError(`No attempt ${attemptId} in step "${stepId}" (plan ${planId}).`);
      return { attempt, snapshot: snapshotFor(plan.manifest, specialist) };
    };
    return {
      adapter,
      reserve: async ({ inputBoundTokens }): Promise<PlanRequestReservation> => {
        const refused = (detail: string): PlanRequestReservation => ({ ok: false, kind: 'refused', detail });
        try {
          return await this.journal.mutateFenced<PlanRequestReservation>(ref, planId, fence, (plan) => {
            const disabled = adapterDisabledReason(adapter.id)
              ?? plan.disabledAdapters?.find((d) => d.adapterId === adapter.id)?.detail;
            if (disabled) return refused(`Plan budgets are switched off for this model after a request went over its limit: ${disabled}`);
            const { attempt } = locate(plan);
            if (isCommitted(attempt)) return refused('This specialist has already finished.');
            if (attempt.phase === 'request-sent' || attempt.phase === 'ambiguous') {
              return refused("This specialist's previous request hasn't been accounted for, so nothing more was sent.");
            }
            const left = allowanceLeft(attempt);
            if (left <= 0) return { ok: false, kind: 'exhausted', detail: 'This specialist has used its whole budget.' };
            // WHY exact equality: the held amount IS the authorization. A paused
            // or released attempt holds nothing and must be re-reserved (with the
            // plan-wide ceiling check) before it may send anything.
            if (attempt.reservedTokens !== left) return refused("This specialist's budget isn't reserved right now.");
            const room = left - Math.max(0, Math.ceil(inputBoundTokens));
            if (room < 1) {
              return {
                ok: false, kind: 'exhausted',
                detail: `The specialist's next request could need up to ${fmt(inputBoundTokens)} tokens, but only ${fmt(left)} are left in its budget.`,
              };
            }
            attempt.phase = 'request-sent';
            return { ok: true, maxOutputTokens: room };
          });
        } catch (e: any) {
          // Nothing was written (the mutation threw), so nothing may be sent.
          return refused(e?.message ?? String(e));
        }
      },
      settle: (outcome: PlanRequestOutcome) => this.journal.mutateFenced<PlanRequestSettlement>(ref, planId, fence, (plan) => {
        const { attempt, snapshot } = locate(plan);
        if (attempt.phase !== 'request-sent') {
          throw new PlanJournalIntegrityError(`Attempt ${attemptId} has no request to settle (plan ${planId}).`);
        }
        const held = attempt.reservedTokens;
        let charged: number;
        let usd: number | null;
        if (outcome.kind === 'unknown') {
          charged = held;
          usd = worstCaseUsd(snapshot, held);
        } else {
          charged = outcome.tokens;
          // Real rates for the split the provider reported; anything a larger
          // reported total adds beyond that split is priced at the worst case.
          const split = outcome.usage.inputTokens + outcome.usage.outputTokens;
          const base = snapshot?.kind === 'priced' ? costForUsage(outcome.usage, snapshot.rates) : null;
          const extra = worstCaseUsd(snapshot, Math.max(0, charged - split));
          usd = base === null && extra === null ? null : (base ?? 0) + (extra ?? 0);
        }
        this.charge(plan, attempt, charged, usd);
        attempt.reservedTokens = Math.max(0, allowanceLeft(attempt));
        attempt.phase = 'response-persisted';
        if (outcome.kind === 'reported' && outcome.tokens > held) {
          const detail = `a specialist's request used ${fmt(outcome.tokens)} tokens, more than the ${fmt(held)} reserved for it`;
          if (!plan.disabledAdapters?.some((d) => d.adapterId === adapter.id)) {
            plan.disabledAdapters = [...(plan.disabledAdapters ?? []), { adapterId: adapter.id, detail }];
          }
          disableAdapterForPlans(adapter.id, detail);
          return { kind: 'over-bound', chargedTokens: charged, detail };
        }
        return { kind: 'ok', chargedTokens: charged };
      }),
    };
  }

  private charge(plan: PlanRecord, attempt: PlanAttemptRecord, tokens: number, usd: number | null): void {
    attempt.spentTokens += tokens;
    plan.usedTokens += tokens;
    // Free/local/unpriced spend adds no dollars — the field stays absent
    // rather than claiming $0.00.
    if (usd !== null) plan.usedUsd = (plan.usedUsd ?? 0) + usd;
  }

  /**
   * Pausing/stop path (design §3): a request whose outcome never arrived is
   * charged its whole reservation and marked ambiguous, so resume can never
   * replay it automatically. A no-op for any other phase.
   */
  async chargeUnresolved(ref: PlanRef, planId: string, fence: string, stepId: string, attemptId: string): Promise<void> {
    await this.journal.mutateFenced(ref, planId, fence, (plan) => {
      const attempt = plan.steps.find((s) => s.id === stepId)?.attempts.find((a) => a.attemptId === attemptId);
      if (!attempt || attempt.phase !== 'request-sent') return;
      const specialist = executableStep(plan.document, stepId)!.specialist;
      this.charge(plan, attempt, attempt.reservedTokens, worstCaseUsd(snapshotFor(plan.manifest, specialist), attempt.reservedTokens));
      attempt.reservedTokens = 0;
      attempt.phase = 'ambiguous';
    });
  }

  /** Give back what a non-finished attempt holds (it keeps what it spent). */
  async releaseAttempt(ref: PlanRef, planId: string, fence: string, stepId: string, attemptId: string): Promise<void> {
    await this.journal.mutateFenced(ref, planId, fence, (plan) => {
      const attempt = plan.steps.find((s) => s.id === stepId)?.attempts.find((a) => a.attemptId === attemptId);
      if (!attempt || isCommitted(attempt)) return;
      if (attempt.phase === 'request-sent') {
        // Releasing here would silently forgive a request that may have been billed.
        throw new PlanJournalIntegrityError(`Attempt ${attemptId} has an unsettled request; charge it before releasing.`);
      }
      attempt.reservedTokens = 0;
    });
  }

  /**
   * Add budget (PlanService's PlanBudgetHooks.addTokens). A paused plan has
   * no executor and no lease, so this is an ordinary (unfenced) journal write.
   * The tranche enlarges the paused attempt — including the fresh prompt it
   * will send on Continue — and the card's token and dollar limits. Spent and
   * finished work are untouched.
   */
  async addTokens(input: { ref: PlanRef; planId: string; stepId: string; tokens: number }): Promise<PlanView> {
    const { ref, planId, stepId, tokens } = input;
    if (!(Number.isSafeInteger(tokens) && tokens > 0)) throw new Error('The added budget must be a whole number of tokens greater than 0.');
    await this.journal.mutate(ref, (file) => {
      const plan = file.plans.find((p) => p.planId === planId);
      if (!plan) throw new Error('This plan no longer exists.');
      if (plan.status !== 'paused' || !plan.paused || plan.lease) throw new Error('Budget can only be added to a paused plan.');
      if (plan.paused.stepId !== stepId) throw new Error('Budget can only be added to the paused step.');
      const def = executableStep(plan.document, stepId);
      const stepRec = plan.steps.find((s) => s.id === stepId);
      if (!def || !stepRec) throw new Error(`Step "${stepId}" can't run a specialist.`);

      let target: PlanAttemptRecord | undefined;
      if (plan.paused.attemptId !== undefined) {
        target = stepRec.attempts.find((a) => a.attemptId === plan.paused!.attemptId);
        if (!target || isCommitted(target)) throw new Error('The paused specialist for this step no longer exists.');
      } else {
        const open = stepRec.attempts.filter((a) => !isCommitted(a));
        if (open.length > 1) throw new Error("This step has several unfinished specialists, so it isn't clear which one the budget is for.");
        target = open[0];
      }
      if (target) target.addedTokens += tokens;
      plan.tranches = [...(plan.tranches ?? []), {
        trancheId: this.newId(), stepId, ...(target ? { attemptId: target.attemptId } : {}), tokens, at: this.now(),
      }];
      plan.ceilingTokens += tokens;
      if (plan.ceilingUsd !== null) {
        const snapshot = snapshotFor(plan.manifest, def.specialist);
        // A missing price can't be bounded; a free/local one adds nothing.
        plan.ceilingUsd = snapshot === null ? null : plan.ceilingUsd + (worstCaseUsd(snapshot, tokens) ?? 0);
      }
    });
    const plan = await this.journal.get(ref, planId);
    if (!plan) throw new Error('This plan no longer exists.');
    return projectPlan(plan);
  }
}
