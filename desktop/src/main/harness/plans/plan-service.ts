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
  /** Settle and dispose everything the plan owns, releasing its lease. */
  stop(input: { ref: PlanRef; planId: string }): Promise<void>;
}

export interface PlanBudgetHooks {
  /** Task 3: record an authorization tranche for the paused step. */
  addTokens(input: { ref: PlanRef; planId: string; stepId: string; tokens: number }): Promise<PlanView>;
}

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
   *  Only a turn a Comment queued can link a revision. */
  turnId?: string;
}

const unsupported = (error: string): PlanUnsupported => ({ ok: false, unsupported: true, error });
const failure = (error: string) => ({ ok: false as const, error });

/** Thrown inside a journal mutation to abort it with a user-facing reason. */
class PlanActionRefused extends Error {}

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
      const pending = file.pendingRevision;
      if (pending && proposal.turnId !== undefined && pending.turnId === proposal.turnId) {
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
    if (this.deps.executor) {
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
      await this.assertNoDrift(ref, plan);
      return { ok: true, plan: await this.startRun(ref, planId, ['paused', 'interrupted'], () => {}) };
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
      if (owner === 'self' && this.deps.executor) await this.deps.executor.stop({ ref, planId });
      await this.journal.mutate(ref, (file) => {
        const p = file.plans.find((x) => x.planId === planId);
        if (!p) throw new PlanActionRefused('This plan no longer exists.');
        this.requireStatus(p, ['proposed', 'running', 'paused', 'interrupted']);
        if (this.journal.leaseOwner(p) === 'live') throw new PlanActionRefused('This plan is running in another YouCoded window. Stop it there.');
        p.status = 'stopped';
        p.endedAt = this.now();
        delete p.paused;
        // A stopped plan owns nothing: clearing any leftover lease also fences
        // out an executor that failed to release it.
        delete p.lease;
        for (const step of p.steps) if (step.status !== 'done' && step.status !== 'failed') step.status = 'skipped';
      });
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
      return { ok: true, plan: await this.deps.budget.addTokens({ ref, planId, stepId: plan.paused.stepId, tokens }) };
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
