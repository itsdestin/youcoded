// PlanService — the one API every plan action goes through (specialists
// plans, Task 2; backend design §2 and §5). The propose_plan tool, the card
// buttons (desktop IPC and remote alike) and the Settings auto-approve row
// all call this; it reads and writes plans only through PlanJournal.
//
// Host-agnostic on purpose: the session lookup, model/price/permission
// fingerprints, the comment follow-up turn, the executor and the budget
// adapter are all injected. Tasks 3–4 supply the real ones; until then an
// absent executor/budget adapter makes the matching action answer
// "unsupported" honestly instead of pretending to run.
import { randomUUID } from 'crypto';
import type { NativeHome } from '../../native-home';
import type { PlanView } from '../../../shared/types';
import type { PlanDocumentV1, PlanStepV1 } from './schema';
import { PlanJournal, PlanJournalUnreadableError, projectPlan } from './plan-journal';
import { planCeilingTokens, planCeilingUsd } from './plan-budget';
import { pausedRouting, resetRecoveriesForContinue, type PlanPauseAction } from './pause-routing';
import { PLAN_RECOMMENDATION_MAX_CHARS, addBudgetCap, addBudgetFloor } from './plan-handoff';
import type {
  ExecutionManifest, JournalPlanStatus, PlanActionResult, PlanAutoApproveRead, PlanRecord, PlanRef,
  PlanSettingsWriteResult, PlanUnsupported,
} from './types';

/** ~/.youcoded/plans.json — the auto-approve limit lives here (design §5). */
const PLAN_SETTINGS_FILE = 'plans.json';
const PLAN_COMMENT_MAX_CHARS = 4_000;

export interface PlanExecutorHooks {
  /** Begin advancing a plan this service has just leased. Must not throw synchronously. */
  start(input: { ref: PlanRef; planId: string; fence: string }): void;
  /** Settle and dispose everything the plan owns, releasing its lease.
   *  Task 4 review item 8: `finalize` is the stopped edit; an executor that
   *  applied it in the same write as the lease release resolves true. */
  stop(input: { ref: PlanRef; planId: string; finalize?: (plan: PlanRecord) => void }): Promise<boolean | void>;
}

export interface PlanBudgetHooks {
  /** Task 3: record an authorization tranche for the paused step. Task 9b:
   *  `edit` is applied to the plan in that SAME write (the handoff it
   *  supersedes is answered by the write that adds the budget). */
  addTokens(input: { ref: PlanRef; planId: string; stepId: string; tokens: number; edit?: (plan: PlanRecord) => void }): Promise<PlanView>;
}

/** Task 9b: told when a user action superseded a pending handoff, so the
 *  host withdraws its undelivered notice and stops its backstop. */
export interface PlanHandoffHooks {
  superseded(ref: PlanRef, planId: string, handoffId: string): void;
}

/** Task 9b: what recommend_plan_action sends (pause handoff §2 step 6). */
export interface PlanRecommendation {
  sessionId: string;
  planId: string;
  handoffId: string;
  action: string;
  addTokens?: number;
  message: string;
}
export type PlanRecommendResult = { ok: true; plan: PlanView } | { ok: false; error: string };

export interface PlanServiceDeps {
  journal: PlanJournal;
  home: NativeHome;
  now?: () => number;
  /** The parent session's working folder, or undefined when it has no native session here. */
  sessionCwd(sessionId: string): string | undefined;
  /** Model binding (through the automatic specialist model resolver), price,
   *  specialist definition and permission fingerprints for this document.
   *  `pricing` must be a PlanPricingSnapshot (plan-budget.ts
   *  `pricingSnapshot`) or null; anything else is read as "no price".
   *  `setupTokens` must come from budget-adapter.ts `setupBound` over the
   *  specialist's exact system prompt and tool list, and `approximateLimit`
   *  must be true when its adapter has `capsOutput: false` (ChatGPT). */
  resolveManifest(input: { sessionId: string; cwd: string; document: PlanDocumentV1 }): Promise<ExecutionManifest>;
  /** Queue the user-visible follow-up turn a Comment creates. */
  queueCommentTurn(input: { sessionId: string; turnId: string; planId: string; text: string }): Promise<void> | void;
  executor?: PlanExecutorHooks;
  budget?: PlanBudgetHooks;
  handoffs?: PlanHandoffHooks;
  newId?: () => string;
}

export interface PlanProposal {
  sessionId: string;
  toolUseId: string;
  document: PlanDocumentV1;
  maximumAttempts: number;
  ceilingTokens: number;
  maxFanOut: number;
  signal: AbortSignal;
  commit(): boolean;
  /** Host-supplied id of the turn that produced this call — never model input.
   *  Only a turn a Comment queued, or a pause's notice turn, can link a revision. */
  turnId?: string;
  /** Task 9b (review 3, finding 1): host-supplied — this call was made during
   *  a plan pause's notice turn. Such a proposal NEVER auto-approves, linked
   *  or not: the rule follows the turn, not the pending revision, so a user
   *  action that superseded the handoff mid-turn can't let one start. */
  fromPlanNotice?: boolean;
}

const unsupported = (error: string): PlanUnsupported => ({ ok: false, unsupported: true, error });
const failure = (error: string) => ({ ok: false as const, error });

/** Thrown inside a journal mutation to abort it with a user-facing reason. */
class PlanActionRefused extends Error {}

const ACTIONS: readonly PlanPauseAction[] = ['add_budget', 'continue', 'stop'];
const NOT_WAITING = 'This pause is no longer waiting for your advice (the plan changed, or the user already decided).';

/**
 * Task 9b: a user's own Continue, Add budget or Stop while a handoff is pending
 * (from another window, say) supersedes it — the user decided. The pending
 * revision always goes (an old notice turn's proposal must not stop a plan the
 * user just acted on); a pending handoff becomes answered with nothing to
 * recommend. Returns the handoff id to withdraw, if there was a handoff.
 */
function supersedeHandoff(plan: PlanRecord): string | undefined {
  const h = plan.paused?.handoff;
  if (!h) return undefined;
  if (h.state === 'pending') h.state = 'answered';
  delete h.revisionTurnId;
  return h.id;
}

const STATUS_WORDS: Record<JournalPlanStatus, string> = {
  proposed: 'waiting for approval',
  running: 'already running',
  paused: 'paused',
  interrupted: 'interrupted',
  completed: 'already finished',
  stopped: 'already stopped',
  failed: 'failed',
};

function allSteps(steps: PlanStepV1[]): PlanStepV1[] {
  return steps.flatMap((s) => (s.kind === 'repeat' ? [s, ...allSteps(s.steps!)] : [s]));
}

/** Stable JSON for fingerprint comparison (key order must not matter). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * What changed between the frozen manifest and now, in plain words. Any
 * difference blocks the action (design §3: drift fails closed and needs a
 * newly proposed plan, never widened consent or a silent reprice).
 */
function manifestDrift(frozen: ExecutionManifest, current: ExecutionManifest): string[] {
  const changes = new Set<string>();
  const ids = new Set([...Object.keys(frozen.specialists), ...Object.keys(current.specialists)]);
  for (const id of ids) {
    const a = frozen.specialists[id];
    const b = current.specialists[id];
    if (!a || !b || a.definitionFingerprint !== b.definitionFingerprint) {
      changes.add("a specialist's instructions or tools");
      continue;
    }
    if (canonical(a.binding) !== canonical(b.binding)) changes.add('the model a specialist would use');
    if (canonical(a.pricing) !== canonical(b.pricing)) changes.add("the model's price");
  }
  if (frozen.permissionFingerprint !== current.permissionFingerprint) changes.add('the permission settings');
  if (frozen.modelLabel !== current.modelLabel && changes.size === 0) changes.add('the model');
  return [...changes];
}

function readUnderTokens(raw: unknown): number {
  const value = (raw as { autoApprove?: { underTokens?: unknown } } | null)?.autoApprove?.underTokens;
  // A damaged or hand-edited setting reads as OFF — the safe direction, since
  // "on" would start spending without a click.
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export class PlanService {
  private readonly journal: PlanJournal;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: PlanServiceDeps) {
    this.journal = deps.journal;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => randomUUID());
  }

  private refFor(sessionId: string): PlanRef | undefined {
    const cwd = this.deps.sessionCwd(sessionId);
    return cwd === undefined ? undefined : { cwd, sessionId };
  }

  /** Shared wrapper: every action returns a result, never throws. */
  private async act(verb: string, fn: () => Promise<PlanActionResult>): Promise<PlanActionResult> {
    try {
      return await fn();
    } catch (e: any) {
      if (e instanceof PlanActionRefused || e instanceof PlanJournalUnreadableError) return failure(e.message);
      return failure(`Couldn't ${verb} the plan: ${e?.message ?? String(e)}`);
    }
  }

  private async loadPlan(sessionId: string, planId: string): Promise<{ ref: PlanRef; plan: PlanRecord }> {
    const ref = this.refFor(sessionId);
    if (!ref) throw new PlanActionRefused("This conversation's plans aren't available right now.");
    const plan = await this.journal.get(ref, planId);
    if (!plan) throw new PlanActionRefused('This plan no longer exists.');
    return { ref, plan };
  }

  private requireStatus(plan: PlanRecord, allowed: JournalPlanStatus[]): void {
    if (!allowed.includes(plan.status)) throw new PlanActionRefused(`This plan is ${STATUS_WORDS[plan.status]}.`);
  }

  private async assertNoDrift(ref: PlanRef, plan: PlanRecord): Promise<void> {
    const current = await this.deps.resolveManifest({ sessionId: ref.sessionId, cwd: ref.cwd, document: plan.document });
    const changes = manifestDrift(plan.manifest, current);
    if (changes.length > 0) {
      throw new PlanActionRefused(
        `This plan can't run as approved because ${changes.join(', ')} changed since it was proposed. Ask the assistant to propose it again.`,
      );
    }
  }

  private async view(ref: PlanRef, planId: string): Promise<PlanView> {
    const plan = await this.journal.get(ref, planId);
    if (!plan) throw new PlanActionRefused('This plan no longer exists.');
    return projectPlan(plan);
  }

  /**
   * Lease + transition to running in one journal write, then hand the fence
   * to the executor. `onStart` stamps fields in that same write.
   */
  private async startRun(ref: PlanRef, planId: string, from: JournalPlanStatus[], onStart: (plan: PlanRecord) => void): Promise<PlanView> {
    const executor = this.deps.executor!;
    const lease = await this.journal.acquireLease(ref, planId, { startFrom: from, onStart });
    if (!lease.ok) {
      throw new PlanActionRefused(
        lease.reason === 'held' ? 'This plan is being run by another YouCoded window.'
          : lease.reason === 'missing' ? 'This plan no longer exists.'
            : 'This plan changed before it could start.',
      );
    }
    executor.start({ ref, planId, fence: lease.fence });
    return this.view(ref, planId);
  }

  // ---- propose (the ToolServices.plans.propose callback) ----

  /**
   * Journal a validated proposal. Throws on failure — the propose_plan tool
   * turns that into a failed card and a real error message.
   */
  async propose(proposal: PlanProposal): Promise<PlanView> {
    const ref = this.refFor(proposal.sessionId);
    if (!ref) throw new Error("Plans aren't available for this conversation.");
    const manifest = await this.deps.resolveManifest({ sessionId: ref.sessionId, cwd: ref.cwd, document: proposal.document });
    if (proposal.signal.aborted) throw new Error('The plan proposal was interrupted.');

    const planId = `plan_${this.newId()}`;
    // WHY remember the latch: the journal may run this mutation twice (a dry
    // run while the file is absent, then again under the lock if the file
    // appeared meanwhile). The tool's commit() is one-shot, so a second call
    // would wrongly read as "interrupted". An abort that lands in between
    // still wins.
    let committed: boolean | undefined;
    const commitOnce = (): boolean => {
      committed ??= proposal.commit();
      return committed && !proposal.signal.aborted;
    };
    const record = await this.journal.mutate(ref, (file) => {
      // WHY commit here, inside the write: it is the tool's one-shot interrupt
      // latch, and must be taken immediately before the durable write.
      if (!commitOnce()) throw new Error('The plan proposal was interrupted.');
      const rec: PlanRecord = {
        planId,
        toolUseId: proposal.toolUseId,
        document: proposal.document,
        maximumAttempts: proposal.maximumAttempts,
        maxFanOut: proposal.maxFanOut,
        // Decision 4: the validator's Σ work budgets plus every attempt's fixed
        // setup cost, so the card's total stays an honest worst case.
        ceilingTokens: planCeilingTokens(proposal.document, manifest),
        // Task 3: every possible token at the frozen snapshot's highest rate.
        // null (tokens only) when any specialist is unpriced or nothing in the
        // plan costs money — never a false $0.00.
        ceilingUsd: planCeilingUsd(proposal.document, manifest),
        usedTokens: 0,
        status: 'proposed',
        seq: 1,
        createdAt: this.now(),
        manifest,
        steps: allSteps(proposal.document.steps).map((s) => ({ id: s.id, status: 'pending' as const, attempts: [] })),
        fenceEpoch: 0,
        // Decision 5: any specialist on an uncapped route makes the limit approximate.
        ...(Object.values(manifest.specialists).some((sp) => sp.approximateLimit) ? { approximateLimit: true } : {}),
      };
      // WHY the link is decided here and not by the model: only the turn a
      // Comment queued carries the matching turnId, and the token is consumed
      // in this same write, so an unrelated or repeated proposal cannot link.
      // Task 9b (§2 "Revise"): a pause's notice turn may replace that paused
      // plan. The pending revision lives on the plan's own handoff; the old
      // plan is stopped as revised in THIS write, but only while it is still
      // paused on that same handoff (a user action deletes the revision, and a
      // newer pause carries a different one) — otherwise the new plan simply
      // stands alone.
      const pausedOld = proposal.turnId === undefined ? undefined
        : file.plans.find((p) => p.status === 'paused' && p.paused?.handoff?.revisionTurnId === proposal.turnId);
      if (pausedOld) {
        rec.revisionOf = pausedOld.planId;
        pausedOld.revisedBy = planId;
        pausedOld.revisedOnPause = true;
        pausedOld.status = 'stopped';
        pausedOld.endedAt = this.now();
        delete pausedOld.paused;
        for (const step of pausedOld.steps) if (step.status !== 'done' && step.status !== 'failed') step.status = 'skipped';
      }
      const pending = file.pendingRevision;
      if (!pausedOld && pending && proposal.turnId !== undefined && pending.turnId === proposal.turnId) {
        const old = file.plans.find((p) => p.planId === pending.oldPlanId);
        if (old) {
          rec.revisionOf = old.planId;
          old.revisedBy = planId;
        }
        delete file.pendingRevision;
      }
      file.plans.push(rec);
      return rec;
    });

    // Auto-approve (design §5): journalled and emitted as a proposal first so
    // the card exists, then started in a second write. Never without an
    // executor — a "running" plan nothing runs would be a lie.
    // Task 9b: never from a pause's notice turn (see PlanProposal.fromPlanNotice).
    if (this.deps.executor && !proposal.fromPlanNotice) {
      const settings = await this.getAutoApprove();
      if (settings.ok && settings.underTokens > 0 && record.ceilingTokens < settings.underTokens) {
        try {
          return await this.startRun(ref, planId, ['proposed'], (plan) => {
            plan.autoApproved = true;
            plan.startedAt = this.now();
          });
        } catch (e) {
          // The proposal is durable and still approvable by hand; report its real state.
          console.error('[plan-service] auto-approve failed', e);
          return this.view(ref, planId);
        }
      }
    }
    return projectPlan(record);
  }

  // ---- card actions ----

  approve(sessionId: string, planId: string): Promise<PlanActionResult> {
    return this.act('approve', async () => {
      if (!this.deps.executor) return unsupported("Running plans isn't available in this version of YouCoded.");
      const { ref, plan } = await this.loadPlan(sessionId, planId);
      this.requireStatus(plan, ['proposed']);
      await this.assertNoDrift(ref, plan);
      return { ok: true, plan: await this.startRun(ref, planId, ['proposed'], (p) => { p.startedAt = this.now(); }) };
    });
  }

  resume(sessionId: string, planId: string): Promise<PlanActionResult> {
    return this.act('continue', async () => {
      if (!this.deps.executor) return unsupported("Running plans isn't available in this version of YouCoded.");
      const { ref, plan } = await this.loadPlan(sessionId, planId);
      this.requireStatus(plan, ['paused', 'interrupted']);
      // Task 4 (Task 3 obligation): a request through one of this plan's
      // routes broke its certified bound, so nothing more may go through it.
      // The gate would refuse at send time; the card says why before that.
      const disabled = plan.disabledAdapters?.[0];
      if (disabled) {
        throw new PlanActionRefused(`Plan budgets are switched off for this model after a request went over its limit: ${disabled.detail}`);
      }
      await this.assertNoDrift(ref, plan);
      // Review fix 4: the user's Continue resets the automatic-retry allowance
      // of the work it resumes, in the same write that takes the lease.
      // Task 9b: that write also drops the pause, and with it any handoff —
      // the user decided; its undelivered notice is withdrawn below.
      const view = await this.startRun(ref, planId, ['paused', 'interrupted'], (p) => resetRecoveriesForContinue(p));
      this.notifySuperseded(ref, planId, plan.paused?.handoff?.id);
      return { ok: true, plan: view };
    });
  }

  stop(sessionId: string, planId: string): Promise<PlanActionResult> {
    return this.act('stop', async () => {
      const { ref, plan } = await this.loadPlan(sessionId, planId);
      this.requireStatus(plan, ['proposed', 'running', 'paused', 'interrupted']);
      const owner = this.journal.leaseOwner(plan);
      if (owner === 'live') throw new PlanActionRefused('This plan is running in another YouCoded window. Stop it there.');
      // Bounded settle-before-visible (design §3): the executor disposes every
      // child, timer and reservation and releases its lease before the card
      // is allowed to say "stopped".
      const markStopped = (p: PlanRecord): void => {
        p.status = 'stopped';
        p.endedAt = this.now();
        delete p.paused;
        // A stopped plan owns nothing: clearing any leftover lease also fences
        // out an executor that failed to release it.
        delete p.lease;
        for (const step of p.steps) if (step.status !== 'done' && step.status !== 'failed') step.status = 'skipped';
      };
      if (owner === 'self' && this.deps.executor) {
        // Review item 8: the executor applies the stopped edit in the write
        // that drops its lease, so no crash can leave a released plan that
        // still says "running" (which recovery would show as interrupted).
        const applied = await this.deps.executor.stop({ ref, planId, finalize: markStopped });
        if (applied === true) return { ok: true, plan: await this.view(ref, planId) };
      }
      // Task 9b: stopping a paused plan drops its pause and any handoff with it
      // (markStopped); "Stopping the plan withdraws its queued notice".
      let handoffId: string | undefined;
      await this.journal.mutate(ref, (file) => {
        const p = file.plans.find((x) => x.planId === planId);
        if (!p) throw new PlanActionRefused('This plan no longer exists.');
        this.requireStatus(p, ['proposed', 'running', 'paused', 'interrupted']);
        if (this.journal.leaseOwner(p) === 'live') throw new PlanActionRefused('This plan is running in another YouCoded window. Stop it there.');
        handoffId = p.paused?.handoff?.id;
        markStopped(p);
      });
      this.notifySuperseded(ref, planId, handoffId);
      return { ok: true, plan: await this.view(ref, planId) };
    });
  }

  /**
   * Comment (design §2): retire the unstarted proposal, record the trusted
   * revision token for the follow-up turn, and queue that turn. If the turn
   * can't be queued, both writes are undone so the card is approvable again.
   */
  comment(sessionId: string, planId: string, text: string): Promise<PlanActionResult> {
    return this.act('comment on', async () => {
      const trimmed = typeof text === 'string' ? text.trim() : '';
      if (!trimmed) return failure('Write a comment first.');
      if (trimmed.length > PLAN_COMMENT_MAX_CHARS) return failure(`Comments are limited to ${PLAN_COMMENT_MAX_CHARS} characters.`);
      const { ref } = await this.loadPlan(sessionId, planId);
      const turnId = this.newId();
      const token = this.newId();
      await this.journal.mutate(ref, (file) => {
        const p = file.plans.find((x) => x.planId === planId);
        if (!p) throw new PlanActionRefused('This plan no longer exists.');
        this.requireStatus(p, ['proposed']);
        p.status = 'stopped';
        p.revisedByComment = true;
        p.endedAt = this.now();
        for (const step of p.steps) step.status = 'skipped';
        // A newer comment always replaces an older pending one.
        file.pendingRevision = { token, turnId, oldPlanId: planId, createdAt: this.now() };
      });
      try {
        await this.deps.queueCommentTurn({ sessionId, turnId, planId, text: trimmed });
      } catch (e: any) {
        await this.journal.mutate(ref, (file) => {
          const p = file.plans.find((x) => x.planId === planId);
          if (p && p.revisedByComment && !p.revisedBy) {
            p.status = 'proposed';
            delete p.revisedByComment;
            delete p.endedAt;
            for (const step of p.steps) step.status = 'pending';
          }
          if (file.pendingRevision?.token === token) delete file.pendingRevision;
        });
        return failure(`Your comment couldn't be sent: ${e?.message ?? String(e)}`);
      }
      return { ok: true, plan: await this.view(ref, planId) };
    });
  }

  addBudget(sessionId: string, planId: string, tokens: number): Promise<PlanActionResult> {
    return this.act('add budget to', async () => {
      if (!(typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens > 0)) {
        return failure('The added budget must be a whole number of tokens greater than 0.');
      }
      if (!this.deps.budget) return unsupported("Adding budget isn't available in this version of YouCoded.");
      const { ref, plan } = await this.loadPlan(sessionId, planId);
      if (plan.status !== 'paused' || !plan.paused) throw new PlanActionRefused('Budget can only be added to a paused plan.');
      // Task 4: a smaller amount would let Continue start and then pause again
      // at once (the resume prompt, or a soft overshoot, would not fit), so it
      // is refused with the real minimum instead of being silently accepted.
      const minimum = plan.paused.minimumAddTokens;
      if (minimum !== undefined && tokens < minimum) {
        return failure(`Add at least ${minimum.toLocaleString('en-US')} tokens so the paused specialist can continue.`);
      }
      // Task 9b: the user decided — answered in the same write that adds it.
      let handoffId: string | undefined;
      const view = await this.deps.budget.addTokens({
        ref, planId, stepId: plan.paused.stepId, tokens,
        edit: (p) => { handoffId = supersedeHandoff(p); },
      });
      this.notifySuperseded(ref, planId, handoffId);
      return { ok: true, plan: view };
    });
  }

  // ---- Task 9b: the assistant's side of a pause handoff ----

  private notifySuperseded(ref: PlanRef, planId: string, handoffId: string | undefined): void {
    if (handoffId === undefined) return;
    try { this.deps.handoffs?.superseded(ref, planId, handoffId); } catch (e) {
      console.error('[plan-service] could not withdraw a superseded plan notice', e);
    }
  }

  /**
   * recommend_plan_action (§2 step 6). Records the button the assistant
   * recommends; it never resumes, stops or adds budget — the user presses the
   * button. Every refusal says why, so the assistant can advise in chat.
   */
  async recommend(input: PlanRecommendation): Promise<PlanRecommendResult> {
    const refuse = (error: string): PlanRecommendResult => ({ ok: false, error });
    const ref = this.refFor(input.sessionId);
    const noPlan = 'There is no plan with that id in this conversation.';
    if (!ref) return refuse(noPlan);
    const action = input.action as PlanPauseAction;
    const message = typeof input.message === 'string' ? input.message.trim() : '';
    let handoffId: string | undefined;
    try {
      await this.journal.mutate(ref, (file) => {
        const p = file.plans.find((x) => x.planId === input.planId);
        if (!p) throw new PlanActionRefused(noPlan);
        const h = p.paused?.handoff;
        if (p.status !== 'paused' || !p.paused || !h || h.state !== 'pending' || h.id !== input.handoffId) throw new PlanActionRefused(NOT_WAITING);
        const allowed = pausedRouting(p.paused).actions;
        if (!ACTIONS.includes(action) || !allowed.includes(action)) {
          throw new PlanActionRefused(`"${input.action}" isn't allowed for this pause. Allowed: ${allowed.join(', ')}.`);
        }
        if (action === 'add_budget') {
          const n = input.addTokens;
          if (!(typeof n === 'number' && Number.isSafeInteger(n))) throw new PlanActionRefused('add_budget needs addTokens, a whole number of tokens.');
          const floor = addBudgetFloor(p);
          const cap = addBudgetCap(p);
          if (n < floor) throw new PlanActionRefused(`addTokens must be at least ${floor.toLocaleString('en-US')} for the plan to continue.`);
          if (n > cap) throw new PlanActionRefused(`addTokens can be at most ${cap.toLocaleString('en-US')} (four times the plan's limit).`);
        } else if (input.addTokens !== undefined) {
          throw new PlanActionRefused('addTokens only goes with add_budget.');
        }
        if (!message) throw new PlanActionRefused('message must say briefly why.');
        if (message.length > PLAN_RECOMMENDATION_MAX_CHARS) {
          throw new PlanActionRefused(`message must be ${PLAN_RECOMMENDATION_MAX_CHARS} characters or fewer (it had ${message.length}).`);
        }
        h.state = 'answered';
        h.recommendation = { action, ...(action === 'add_budget' ? { addTokens: input.addTokens } : {}), message };
        handoffId = h.id;
      });
    } catch (e: any) {
      if (e instanceof PlanActionRefused) return refuse(e.message);
      if (e instanceof PlanJournalUnreadableError) return refuse(e.message);
      return refuse(`The recommendation couldn't be saved: ${e?.message ?? String(e)}`);
    }
    // Answered: an undelivered copy of the notice has nothing left to ask.
    this.notifySuperseded(ref, input.planId, handoffId);
    return { ok: true, plan: await this.view(ref, input.planId) };
  }

  /**
   * The turn that delivered this handoff's notice ended (or the handoff is
   * being cleared): a still-pending handoff becomes answered with no
   * recommendation, so the card shows its default buttons. The pending
   * revision goes too — only a proposal from that turn could have used it.
   * Only for the same id: a newer pause is never touched. Never throws.
   */
  async answerHandoff(ref: PlanRef, planId: string, handoffId: string): Promise<boolean> {
    let changed = false;
    try {
      await this.journal.mutate(ref, (file) => {
        const h = file.plans.find((x) => x.planId === planId)?.paused?.handoff;
        if (!h || h.id !== handoffId) return;
        if (h.state === 'pending') { h.state = 'answered'; changed = true; }
        if (h.revisionTurnId !== undefined) { delete h.revisionTurnId; changed = true; }
      });
    } catch (e) {
      console.error('[plan-service] could not answer a plan handoff', e);
      return false;
    }
    return changed;
  }

  /**
   * App restart (§2 "never stuck"): no notice survives a restart, so every
   * pending handoff this process is not delivering is answered. Reads first,
   * so a conversation that never had a plan gets no file.
   */
  async clearStaleHandoffs(ref: PlanRef, keep: ReadonlySet<string>): Promise<void> {
    const read = await this.journal.read(ref);
    if (read.kind !== 'valid') return;
    const stale = (p: PlanRecord) => {
      const h = p.paused?.handoff;
      return !!h && (h.state === 'pending' || h.revisionTurnId !== undefined) && !keep.has(h.id);
    };
    if (!read.file.plans.some(stale)) return;
    await this.journal.mutate(ref, (file) => {
      for (const p of file.plans) {
        if (!stale(p)) continue;
        const h = p.paused!.handoff!;
        h.state = 'answered';
        delete h.revisionTurnId;
      }
    });
  }

  // ---- settings ----

  async getAutoApprove(): Promise<PlanAutoApproveRead> {
    try {
      return { ok: true, underTokens: readUnderTokens(this.deps.home.readJson(PLAN_SETTINGS_FILE)) };
    } catch (e: any) {
      return failure(`Couldn't read the plan settings: ${e?.message ?? String(e)}`);
    }
  }

  async setAutoApprove(underTokens: unknown): Promise<PlanSettingsWriteResult> {
    if (!(typeof underTokens === 'number' && Number.isSafeInteger(underTokens) && underTokens >= 0)) {
      return failure('The limit must be a whole number of tokens, 0 or more (0 turns it off).');
    }
    try {
      await this.deps.home.mutateJson(PLAN_SETTINGS_FILE, (current) => {
        const base = current && typeof current === 'object' && !Array.isArray(current) ? current as Record<string, unknown> : {};
        return { v: 1, ...base, autoApprove: { underTokens } };
      });
      return { ok: true };
    } catch (e: any) {
      return failure(`Couldn't save the plan settings: ${e?.message ?? String(e)}`);
    }
  }
}
