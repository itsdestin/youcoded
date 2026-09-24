// PlanHostBridge — everything plan-specific the native session host needs
// (specialists plans, Task 4). The host owns sessions, slots and transcripts;
// this owns the plan journal, budget, executor and service, and speaks to the
// host only through the small `PlanHostPort` below.
//
// WHY a separate module: native-session-host.ts is already ~4,700 lines. The
// host keeps only the mechanics nothing else can do (minting and tearing down
// specialist sessions, the send queue); the decisions — which model a plan
// specialist runs on, what its fixed starting cost is, what a transcript
// proves after a crash, how much Add budget is enough — live here, next to the
// rest of the plan code, where they can be read and tested together.
import { PLAN_COMMENT_TAG } from '../history-only';
import { createHash, randomUUID } from 'crypto';
import type { CatalogModel, ModelBinding, ProviderReadiness } from '../../../shared/provider-types';
import type { PlanView, TranscriptEvent } from '../../../shared/types';
import type { NativeHome } from '../../native-home';
import { isFreePricing, type ModelPricing } from '../pricing';
import type { CapabilityProfile, ProfileProviderType } from '../capability-profile';
import type { SpecialistDefinition, SpecialistRoster } from '../specialists/registry';
import {
  DelegatedModelRefused, DelegatedModelUnavailable, resolveDelegatedBinding, resolveRequestedModel, type DelegatedModels,
} from '../specialists/delegated-models';
import { log } from '../../logger';
// Task 9a: each tool's declared effect decides what a cut-off call means.
import { nativeToolEffect } from '../tools';
import type { PlanDocumentV1, PlanStepV1 } from './schema';
import { PlanJournal, PlanJournalUnreadableError, projectPlan } from './plan-journal';
import { PlanService, type PlanHandoffProblem, type PlanProposal, type PlanRecommendation } from './plan-service';
import { PLAN_HANDOFF_BACKSTOP_MS, normalizePlanQuestion, planHandoffNotice } from './plan-handoff';
import {
  PlanExecutor, PlanLaunchDriftError, PlanLaunchRefusedError, PlanNotReadyError, classifyChildTranscript,
  type PlanChildHandle, type PlanChildLaunch, type PlanRunner, type TranscriptVerdict,
} from './plan-executor';
import type {
  ExecutionManifest, PlanActionResult, PlanAutoApproveRead, PlanEvent, PlanRecord, PlanRef, PlanSettingsWriteResult,
} from './types';
// T5 (design §4): the snapshot type `PlanHostPort.specialistUsageHistory`
// (below) and `PlanService.deps.history` both carry — the concrete
// `SpecialistUsageHistory` class stays a native-session-host.ts concern.
import type { SpecialistUsageSnapshot } from './specialist-usage-history';
// Final review F6: refusals worded for people (the failed card shows them).
import { PlanProposalError, PlanSpecialistsNotReadyError, type PlanNotReadySpecialist } from './types';

// WHY pricingSnapshot lives here now, not plan-budget.ts (spending rework
// stage 1, design §1: plan-budget.ts is deleted — this pure classifier
// "carries over" into T2's plan-spend.ts, per design §1's own wording; a
// local copy keeps resolveManifest's pricing real in the meantime rather
// than writing a placeholder null for every step).
// T5 (design §4): exported so plan-estimate.ts can price past runs at a
// step's FROZEN rate without duplicating this shape — `manifest.steps[id].
// pricing` is typed `unknown` on the journal record (types.ts's own WHY:
// "an unrecognized snapshot must not quarantine the whole journal"), so
// plan-estimate.ts narrows it back to this exact union itself, the same
// tolerant way plan-spend.ts would.
export type PricingSnapshot = { kind: 'priced'; rates: ModelPricing } | { kind: 'free' } | { kind: 'local' };
function pricingSnapshot(input: { pricing: ModelPricing | null; free: boolean; local: boolean }): PricingSnapshot | null {
  if (input.local) return { kind: 'local' };
  if (input.free || isFreePricing(input.pricing)) return { kind: 'free' };
  if (!input.pricing) return null;
  const { in: inRate, out, cacheRead, cacheWrite } = input.pricing;
  return {
    kind: 'priced',
    rates: { in: inRate, out, ...(cacheRead != null ? { cacheRead } : {}), ...(cacheWrite != null ? { cacheWrite } : {}) },
  };
}

/** Task 11 (§6): the "Ask the assistant" refusals main words itself. */
const NOT_HERE = "This conversation isn't running here right now, so the assistant can't be asked.";
const NO_TOOLS = "The model in this conversation can't use tools, so it can't look into the plan.";
const QUEUE_FAILED = "Couldn't ask the assistant: this conversation isn't running here right now.";

// WHY PLAN_MINIMUM_ADD_MARGIN_TOKENS is GONE (spending rework stage 1,
// decision 34): no measured Add budget minimum exists any more.

/** The route facts the host already resolves for any binding. */
export interface PlanRoute {
  providerType: ProfileProviderType;
  profile: CapabilityProfile;
  pricing: ModelPricing | null;
  free: boolean;
  contextLength: number | null;
  totalSlots: number | null;
}

// WHY no `gate`/`budgetStop` any more (spending rework stage 1, design §1):
// PlanChildRequestGate/PlanChildStop were budget-adapter.ts's own types
// (deleted); nothing gates a plan child's requests before sending any more.
// T2: the real replacement is `PlanSpend` (design §3's `{afterReply,
// beforeRequest}` hook), built by the host from `fence` and the four flag
// callbacks below.
export interface PlanChildStart {
  parentId: string;
  specialist: SpecialistDefinition;
  binding: ModelBinding;
  providerType: ProfileProviderType;
  /** The propose_plan call the plan renders on (ask cards nest under it). */
  parentToolCallId: string;
  resumeChildId?: string;
  signal: AbortSignal;
  tag: { planId: string; stepId: string; attemptId: string };
  recordChild(childId: string, info?: { title?: string }): Promise<void>;
  brief: string;
  /** Task 9a: send `brief` with tools switched off (the report-only turn). */
  toolsDisabled?: boolean;
  /** T2 (design §3): forwarded straight from `PlanChildLaunch.fence` — the
   *  host builds ONE `PlanSpend` per attempt (Revision 3 F1) and it needs the
   *  same fence every other write for this attempt uses. */
  fence: string;
  /** T2: this run's shared spend flags, forwarded from `PlanChildLaunch` (see
   *  its own WHY comment) straight into the `PlanSpend` the host builds. */
  isLimitReached(): boolean;
  markLimitReached(): void;
  isWriteFailed(): boolean;
  markWriteFailed(): void;
}

/** Task 9b: one plan pause notice the host delivers as its own model turn.
 *  Task 11: queued only because the user pressed "Ask the assistant". */
export interface PlanNoticeDelivery {
  text: string;
  /** The notice turn's id — what propose_plan reads as the current turn. */
  turnId: string;
  planId: string;
  /** Tags the queued notice so a clear can withdraw it. */
  handoffId: string;
  /** Delivery started (the backstop no longer applies). */
  onStart(): void;
  /** The turn that delivered it ended — success, error or Stop — or it was
   *  dropped without being delivered. Called exactly once. Task 11: `failed`
   *  is the real error when delivery threw or the turn ended in a provider
   *  error (never for the user's own Stop), so the card can say so. */
  onEnd(outcome?: { failed?: string }): void;
}

export interface PlanHostPort {
  home: NativeHome;
  emit(event: PlanEvent): void;
  /** A LIVE root session's working folder (never a specialist's). */
  rootCwd(sessionId: string): string | undefined;
  parentBinding(sessionId: string): ModelBinding | undefined;
  /** What the plan's permission fingerprint covers (preset + mode). */
  permissionState(sessionId: string): unknown;
  roster(cwd: string): SpecialistRoster;
  designated?: DelegatedModels;
  catalog(): Promise<CatalogModel[] | null>;
  resolveRoute(binding: ModelBinding): Promise<PlanRoute>;
  /** Task 13 (decisions 25 + 26): can this binding's provider actually run —
   *  signed in, key saved, endpoint configured, local engine installed? Asked
   *  LOCALLY: no network call, no spend, no model client. Never throws, and
   *  its `message` is the provider's own sentence, repeated verbatim. */
  credentialReadiness(binding: ModelBinding): Promise<ProviderReadiness>;
  maxConcurrent(sessionId: string): number;
  readChildEvents(childId: string, cwd: string): TranscriptEvent[];
  /** Queue a user turn carrying a host turn id; throws with the real reason. */
  /** `historyNote`: shown to the model only, never in the chat (5b follow-up). */
  queueTurn(sessionId: string, text: string, turnId: string, historyNote?: string): void;
  currentTurnId(sessionId: string): string | undefined;
  /** Final review F3: a key unique to the turn running right now (every turn
   *  has one; see NativeSessionHost `currentTurnKey`). Optional for fakes. */
  currentTurnKey?(sessionId: string): string | undefined;
  /** Task 11 (§6): why this conversation can't take a plan notice right now
   *  (not open here, or the user pressed Stop so deliveries are held), in the
   *  user's words; undefined when it can. */
  noticeRefusal(sessionId: string): string | undefined;
  /** Task 11 (§6): whether this conversation's model is offered the plan
   *  tools (it can answer a question about a plan). undefined when the
   *  conversation isn't open here. */
  planToolsAvailable(sessionId: string): boolean | undefined;
  /** Task 11 (§6): a notice queued now would wait behind a reply (or other
   *  notices) already in progress. */
  noticeWouldWait(sessionId: string): boolean;
  /** Task 9b: queue a plan notice; false when it can't be (never while held). */
  queuePlanNotice(sessionId: string, notice: PlanNoticeDelivery): boolean;
  /** Task 9b: drop a queued notice that has not started to be delivered. */
  withdrawPlanNotice(sessionId: string, handoffId: string): boolean;
  /** Mint (or rebuild) a plan specialist, holding a specialist slot. */
  startChild(input: PlanChildStart): Promise<PlanChildHandle>;
  // WHY no probeSession any more (spending rework stage 1, design §1): it
  // existed only to measure a specialist's fixed setup cost and an Add
  // budget minimum through an unwired session — resolveManifest no longer
  // measures anything before freezing a step's binding.
  /** T5 (design §4): the host's specialist-usage-history index, threaded
   *  straight into PlanService's own `history` dep below. Optional — a bare
   *  test port (most of plan-host-bridge.test.ts) gets plan-estimate.ts's
   *  own built-in defaults instead of real past runs, same as an empty one. */
  specialistUsageHistory?: { snapshot(): SpecialistUsageSnapshot };
}

export interface PlanHostBridgeOptions {
  settleDeadlineMs?: number;
  heartbeatMs?: number;
  /**
   * The lease clock (tests only). WHY: restart recovery decides "another
   * window may still own this plan" by comparing a lease's expiry with now,
   * and schedules its recheck from the same clock. A test on wall time races
   * the machine's load (Task 7: a 300 ms lease expired before a loaded run
   * finished reopening); an injected clock makes that decision deterministic.
   */
  now?: () => number;
  /** Task 9b: the "never stuck" backstop (tests only; 10 minutes otherwise). */
  handoffBackstopMs?: number;
  /** Final review F2: when recovery runs after a run's final write failed
   *  (tests only). One attempt per entry; a later one runs only if the plan
   *  is still shown as running. */
  orphanRecoveryDelaysMs?: readonly number[];
}

/** Final review F2: a failed final write is usually a moment's lock or disk
 *  trouble; recovery is tried again a few times before waiting for the next
 *  time the conversation opens. */
const ORPHAN_RECOVERY_DELAYS_MS: readonly number[] = [2_000, 30_000, 5 * 60_000];

/** Task 9b: one pause this process handed to the assistant. */
interface LiveHandoff {
  ref: PlanRef;
  planId: string;
  handoffId: string;
  turnId: string;
  started: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const sha = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex').slice(0, 24);

/**
 * What the user consented to about a specialist: its instructions, tools and
 * charter. WHY hash built-ins too (they carry no file fingerprint): an app
 * update that changes a built-in's tools must also fail an approved plan
 * closed rather than silently widen what it may do.
 */
export function definitionFingerprint(def: SpecialistDefinition): string {
  return `def:${sha({
    id: def.id, systemPrompt: def.systemPrompt, allowedTools: [...def.allowedTools].sort(), charter: def.charter,
    modelPreference: def.modelPreference ?? null, source: def.source, grantScope: def.grantScope, file: def.fingerprint ?? null,
  })}`;
}

function leafSteps(steps: PlanStepV1[]): PlanStepV1[] {
  return steps.flatMap((s) => (s.kind === 'repeat' ? leafSteps(s.steps!) : [s]));
}

// WHY measurementGate is GONE (spending rework stage 1, design §1): built a
// PlanChildRequestGate (budget-adapter.ts, deleted) that could only measure,
// never send — for the now-deleted setup/Add-budget measurement probes.

export class PlanHostBridge {
  readonly journal: PlanJournal;
  readonly executor: PlanExecutor;
  readonly service: PlanService;
  private readonly lastViews = new Map<string, PlanView>();
  private readonly rechecks = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly now: () => number;
  /** Task 9b: pending handoffs by id, and the ids of plan notice turns (a
   *  proposal made during one never auto-approves, whatever happened to the
   *  handoff meanwhile — review 3, finding 1). Task 11: a handoff is added
   *  here BEFORE its journal write (review 4-4), so restart recovery running
   *  at the same moment keeps it. */
  private readonly handoffs = new Map<string, LiveHandoff>();
  private readonly noticeTurns = new Set<string>();
  private readonly handoffBackstopMs: number;
  private readonly orphanRecoveryDelaysMs: readonly number[];
  private readonly orphanTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly port: PlanHostPort, opts: PlanHostBridgeOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.handoffBackstopMs = opts.handoffBackstopMs ?? PLAN_HANDOFF_BACKSTOP_MS;
    this.orphanRecoveryDelaysMs = opts.orphanRecoveryDelaysMs ?? ORPHAN_RECOVERY_DELAYS_MS;
    this.journal = new PlanJournal({
      home: port.home,
      ...(opts.now ? { now: opts.now } : {}),
      onEvent: (event) => {
        const plan = this.decorate(event.sessionId, event.plan);
        this.lastViews.set(this.viewKey(event.sessionId, plan.planId), plan);
        port.emit({ ...event, plan });
      },
    });
    // WHY no PlanBudget any more (spending rework stage 1, design §1):
    // deleted — the executor and service no longer take a budget dependency.
    this.executor = new PlanExecutor({
      journal: this.journal,
      runner: this.runner(),
      settleDeadlineMs: opts.settleDeadlineMs,
      heartbeatMs: opts.heartbeatMs,
    });
    this.service = new PlanService({
      journal: this.journal,
      home: port.home,
      ...(opts.now ? { now: opts.now } : {}),
      sessionCwd: (sessionId) => port.rootCwd(sessionId),
      resolveManifest: (input) => this.resolveManifest(input),
      queueCommentTurn: ({ sessionId, turnId, text }) => {
        port.queueTurn(sessionId, commentTurnText(text), turnId, COMMENT_MODEL_NOTE);
      },
      executor: this.executor,
      // A user action (or a recommendation) answered it: an undelivered
      // notice has nothing left to ask. A notice already being delivered
      // stays until its turn ends.
      handoffs: { superseded: (_ref, _planId, handoffId) => { void this.clearHandoff(handoffId, { force: false }); } },
      // T5: threaded straight from the port; absent exactly when the port's
      // own field is (a bare test host).
      ...(port.specialistUsageHistory ? { history: port.specialistUsageHistory } : {}),
      // T5's own fallback tier ("worker if it can write, else reviewer") —
      // the SAME read-only/read-write charter check `runner().isWriter`
      // (below) already makes for the executor's serialization decision, so
      // an unresolvable specialist id answers `undefined` here exactly like
      // isWriter's own "unknown → serialize" comment, letting plan-estimate.ts
      // fall back to its own conservative default rather than guessing.
      specialistCanWrite: (cwd, specialistId) => {
        const def = port.roster(cwd).resolve(specialistId);
        return def ? def.charter !== 'read-only' : undefined;
      },
    });
  }

  private viewKey(sessionId: string, planId: string): string {
    return `${sessionId}\u0000${planId}`;
  }

  // ---- ToolServices.plans ----

  /** propose_plan's callback, with the HOST's turn id (never model input). */
  propose(sessionId: string, proposal: Omit<PlanProposal, 'turnId' | 'fromPlanNotice' | 'autoStartKey'>): Promise<PlanView> {
    const turnId = this.port.currentTurnId(sessionId);
    // Final review F3: at most one auto-start per turn. A call with no known
    // turn shares one key per conversation — the safe direction.
    const autoStartKey = this.port.currentTurnKey?.(sessionId) ?? turnId ?? `conversation:${sessionId}`;
    return this.service.propose({
      ...proposal,
      autoStartKey,
      ...(turnId !== undefined ? { turnId } : {}),
      // Task 9b: host-known, never model input.
      ...(turnId !== undefined && this.noticeTurns.has(turnId) ? { fromPlanNotice: true } : {}),
    });
  }

  /** recommend_plan_action's callback (Task 9b). */
  async recommend(input: PlanRecommendation): Promise<{ ok: true } | { ok: false; error: string }> {
    const res = await this.service.recommend(input);
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }

  // ---- Task 9b + Task 11: pause handoffs (design §2, and §6 revision 4) ----

  /** Task 11 (§6): the card hides "Ask the assistant" when this conversation's
   *  model can't use tools. Applied to every view main hands the renderer —
   *  pushes, hydration and action answers alike — so the button never
   *  reappears after an action. */
  private decorate(sessionId: string, view: PlanView): PlanView {
    if (!view.paused) return view;
    const unavailable = this.port.planToolsAvailable(sessionId) === false;
    if (unavailable === (view.paused.askUnavailable === true)) return view;
    const paused = { ...view.paused };
    if (unavailable) paused.askUnavailable = true;
    else delete paused.askUnavailable;
    return { ...view, paused };
  }

  private decorated(sessionId: string, res: PlanActionResult): PlanActionResult {
    return res.ok ? { ok: true, plan: this.decorate(sessionId, res.plan) } : res;
  }

  /**
   * Task 11 (pause handoff §6): the user pressed "Ask the assistant" on a
   * paused card. In order:
   *  1. liveness, held deliveries and tool use are checked BEFORE any write —
   *     a refusal is an ordinary action error with the real reason;
   *  2. the handoff is registered in `handoffs` FIRST (review 4-4);
   *  3. the service checks, inside its write, that the plan is paused with no
   *     question pending, and records the pending handoff (review 4-3);
   *  4. the notice is queued (§2 steps 3–5), with the backstop armed.
   */
  async askAssistant(sessionId: string, planId: string, question?: unknown): Promise<PlanActionResult> {
    // Decision 20: an over-long question is refused before anything is held
    // (the service checks it again inside its own action).
    const q = normalizePlanQuestion(question);
    if (!q.ok) return { ok: false, error: q.error };
    const refusal = this.port.noticeRefusal(sessionId);
    if (refusal !== undefined) return { ok: false, error: refusal };
    const cwd = this.port.rootCwd(sessionId);
    if (cwd === undefined) return { ok: false, error: NOT_HERE };
    if (this.port.planToolsAvailable(sessionId) === false) return { ok: false, error: NO_TOOLS };
    const ref: PlanRef = { cwd, sessionId };
    const entry: LiveHandoff = { ref, planId, handoffId: randomUUID(), turnId: randomUUID(), started: false };
    this.handoffs.set(entry.handoffId, entry);
    const waiting = this.port.noticeWouldWait(sessionId);
    const res = await this.service.askAssistant(sessionId, planId, { id: entry.handoffId, turnId: entry.turnId, ...(waiting ? { waiting: true } : {}) }, q.question);
    if (!res.ok) {
      // Refused inside the write (not paused, or a question already pending):
      // this press holds nothing.
      if (this.handoffs.get(entry.handoffId) === entry) this.handoffs.delete(entry.handoffId);
      return res;
    }
    // Review fix 1: a Stop or takeover that landed during the write cleared
    // the entry before the journal had this handoff, so that clear answered
    // nothing. Answer it here, or the card would stay greyed for good.
    if (this.handoffs.get(entry.handoffId) !== entry) {
      await this.answerOrphan(entry);
      const now = await this.journal.get(ref, planId).then((p) => (p ? projectPlan(p, this.now()) : res.plan), () => res.plan);
      return { ok: true, plan: this.decorate(sessionId, now) };
    }
    const queued = await this.queueAsk(entry, waiting);
    if (!queued) return { ok: false, error: QUEUE_FAILED };
    // The answer is the card as it stands after the queueing (a clear that
    // landed meanwhile already shows its buttons again).
    const view = await this.journal.get(ref, planId).then((p) => (p ? projectPlan(p, this.now()) : res.plan), () => res.plan);
    return { ok: true, plan: this.decorate(sessionId, view) };
  }

  /** Review fix 1: answer a recorded handoff whose map entry a clear already
   *  removed (that clear could not answer it). Never a problem: the user or a
   *  takeover chose this. */
  private async answerOrphan(entry: LiveHandoff): Promise<void> {
    this.noticeTurns.delete(entry.turnId);
    await this.service.answerHandoff(entry.ref, entry.planId, entry.handoffId);
  }

  /** Queue the notice for a handoff just recorded (cleared at once if that
   *  fails) and arm the backstop. False only when it could not be queued. */
  private async queueAsk(entry: LiveHandoff, waitingRecorded: boolean): Promise<boolean> {
    const { ref, planId, handoffId, turnId } = entry;
    let queued = false;
    try {
      const plan = await this.journal.get(ref, planId);
      if (plan?.paused?.handoff?.id === handoffId && plan.paused.handoff.state === 'pending') {
        this.noticeTurns.add(turnId);
        // Review 4-5: whether the question waits is decided again right
        // before queueing (a message may have been sent since the check the
        // write used); a difference is corrected below.
        const waitsNow = this.port.noticeWouldWait(ref.sessionId);
        queued = this.port.queuePlanNotice(ref.sessionId, {
          // Decision 20: the question recorded in the same write as the handoff.
          text: planHandoffNotice(plan, handoffId, plan.paused.handoff.question, this.now()),
          turnId,
          planId,
          handoffId,
          onStart: () => {
            entry.started = true;
            if (entry.timer) clearTimeout(entry.timer);
            // The card stops saying "after its current reply".
            void this.service.setHandoffWaiting(ref, planId, handoffId, false);
          },
          onEnd: (outcome) => {
            this.noticeTurns.delete(turnId);
            void this.clearHandoff(handoffId, {
              force: true,
              ...(outcome?.failed !== undefined ? { problem: { kind: 'reply-failed' as const, detail: outcome.failed } } : {}),
            });
          },
        });
        if (queued && waitsNow !== waitingRecorded && !entry.started) {
          void this.service.setHandoffWaiting(ref, planId, handoffId, waitsNow, () => !entry.started);
        }
      } else if (!this.handoffs.has(handoffId)) {
        // Already cleared (Stop, takeover) before anything was queued: the
        // card is already back to its buttons; nothing to report.
        return true;
      }
    } catch (e) {
      log('WARN', 'PlanHostBridge', 'could not queue a plan question', { planId, error: String(e) });
    }
    if (!queued) {
      this.noticeTurns.delete(turnId);
      // Review fix 1: with no entry left, clearHandoff returns early, so the
      // pending record is answered directly.
      if (this.handoffs.get(handoffId) === entry) await this.clearHandoff(handoffId, { force: true });
      else await this.answerOrphan(entry);
      return false;
    }
    // Task 9b follow-up: a clear (takeover, Stop) can land between the journal
    // read above and the queueing — it removed the handoff and withdrew
    // nothing, because nothing was queued yet. The notice just queued would
    // then reach the assistant for a question that is no longer open, so it
    // is withdrawn here, and its turn is not a notice turn after all.
    if (!this.handoffs.has(handoffId)) {
      if (!entry.started) {
        this.noticeTurns.delete(turnId);
        try { this.port.withdrawPlanNotice(ref.sessionId, handoffId); } catch (e) {
          log('WARN', 'PlanHostBridge', 'could not withdraw a plan pause notice', { error: String(e) });
        }
        // Review fix 1: the clear may have run before the journal held this
        // handoff; answering again is a no-op otherwise.
        await this.answerOrphan(entry);
      }
      return true;
    }
    // The host starts delivery on a later tick, so the backstop is armed
    // before any delivery can begin; it only ever clears a notice not started.
    // Task 11: that clear leaves "didn't get to your question" with Retry.
    if (!entry.started) {
      entry.timer = setTimeout(() => {
        if (!entry.started) void this.clearHandoff(handoffId, { force: false, problem: { kind: 'no-start' } });
      }, this.handoffBackstopMs);
      (entry.timer as { unref?: () => void }).unref?.();
    }
    return true;
  }

  /**
   * Clear one handoff this process holds. A notice not yet being delivered is
   * withdrawn and the handoff answered now. One being delivered is left to its
   * turn's end unless `force` (Stop, closing, the end of that turn itself).
   */
  private async clearHandoff(handoffId: string, opts: { force: boolean; problem?: PlanHandoffProblem }): Promise<void> {
    const entry = this.handoffs.get(handoffId);
    if (!entry) return;
    if (entry.started && !opts.force) return;
    this.handoffs.delete(handoffId);
    if (entry.timer) clearTimeout(entry.timer);
    if (!entry.started) {
      this.noticeTurns.delete(entry.turnId);
      try { this.port.withdrawPlanNotice(entry.ref.sessionId, handoffId); } catch (e) {
        log('WARN', 'PlanHostBridge', 'could not withdraw a plan pause notice', { error: String(e) });
      }
    }
    await this.service.answerHandoff(entry.ref, entry.planId, handoffId, opts.problem);
  }

  private async clearSessionHandoffs(sessionId: string): Promise<void> {
    const mine = [...this.handoffs.values()].filter((h) => h.ref.sessionId === sessionId);
    await Promise.all(mine.map((h) => this.clearHandoff(h.handoffId, { force: true })));
  }

  /** The user pressed Stop on the conversation (§2 "never stuck"). */
  conversationStopped(sessionId: string): void {
    void this.clearSessionHandoffs(sessionId);
  }

  // ---- the card and settings actions + hydration ----

  async approve(sessionId: string, planId: string): Promise<PlanActionResult> { return this.decorated(sessionId, await this.service.approve(sessionId, planId)); }
  async comment(sessionId: string, planId: string, text: string): Promise<PlanActionResult> { return this.decorated(sessionId, await this.service.comment(sessionId, planId, text)); }
  // WHY no addBudget any more (spending rework stage 1, design §1/§6):
  // deleted — T7 removes the matching `plans:add-budget` IPC channel.
  async resume(sessionId: string, planId: string): Promise<PlanActionResult> { return this.decorated(sessionId, await this.service.resume(sessionId, planId)); }
  async stop(sessionId: string, planId: string): Promise<PlanActionResult> { return this.decorated(sessionId, await this.service.stop(sessionId, planId)); }
  getAutoApprove(): Promise<PlanAutoApproveRead> { return this.service.getAutoApprove(); }
  setAutoApprove(underUsd: unknown): Promise<PlanSettingsWriteResult> { return this.service.setAutoApprove(underUsd); }

  /** Current card projections, read from the journal (never from memory). */
  async views(sessionId: string): Promise<PlanView[]> {
    const cwd = this.port.rootCwd(sessionId);
    if (cwd === undefined) return [];
    try {
      return (await this.journal.list({ cwd, sessionId })).map((v) => this.decorate(sessionId, v));
    } catch (e) {
      log('WARN', 'PlanHostBridge', 'could not read plan projections', { sessionId, error: String(e) });
      return [];
    }
  }

  /**
   * Task 5a: every specialist a plan in this conversation ever launched, with
   * the card it belongs to — what history replay needs to
   * put its past activity back in the right row after a restart (the same job
   * the delegation ledger does for an ordinary specialist's card). Read-only
   * and synchronous; a missing or damaged journal yields none.
   */
  childTranscriptSources(sessionId: string): Array<{ parentToolCallId: string; childId: string; cwd: string }> {
    const cwd = this.port.rootCwd(sessionId);
    if (cwd === undefined) return [];
    // Keyed by childId: a safe restart continues the SAME specialist session,
    // so one transcript must be replayed once.
    const byChild = new Map<string, ReturnType<PlanHostBridge['childTranscriptSources']>[number]>();
    try {
      for (const plan of this.journal.peekRecords({ cwd, sessionId })) {
        for (const step of plan.steps) {
          for (const a of step.attempts) {
            if (!a.childId) continue;
            byChild.set(a.childId, { parentToolCallId: plan.toolUseId, childId: a.childId, cwd });
          }
        }
      }
    } catch (e) {
      // History must degrade, never break (same rule as the ledger read in getHistory).
      log('WARN', 'PlanHostBridge', 'could not list plan specialists for history replay', { sessionId, error: String(e) });
      return [];
    }
    return [...byChild.values()];
  }

  // ---- lifecycle ----

  /**
   * Restart recovery when a conversation opens (design §2): stale running
   * plans become interrupted, ownerless plans give back every hold, and
   * nothing runs until Continue. A foreign lease that has not expired yet is
   * checked again at its expiry, and again after that while one remains.
   */
  async recover(sessionId: string, cwd: string): Promise<void> {
    this.cancelRecheck(sessionId);
    const ref: PlanRef = { cwd, sessionId };
    try {
      // WHY no onInterrupt "release ownerless holds" / "settle ownerless"
      // pass any more (spending rework stage 1, design §1): there is
      // nothing reserved for a crashed run to hold or give back —
      // `recoverAttempt` (plan-executor.ts) reads each unfinished attempt's
      // transcript fresh the next time this plan starts.
      const { interrupted, recheckAt } = await this.journal.recoverInterrupted(ref, {
        // Final review F2: this process's own plan whose run ended without
        // its final write is shown paused with the real reason.
        orphaned: (planId) => this.executor.orphanReason(ref, planId),
      });
      for (const planId of interrupted) this.executor.clearOrphan(ref, planId);
      // Task 9b: a pending handoff no one in this process is delivering (the
      // app restarted) is answered, so its card gets its buttons back.
      // Task 11 (review 4-4): asked live, inside the service's write, so a
      // question pressed while this runs is kept.
      await this.service.clearStaleHandoffs(ref, (id) => this.handoffs.get(id)?.ref.sessionId === sessionId);
      if (recheckAt !== undefined && this.port.rootCwd(sessionId) === cwd) {
        const timer = setTimeout(() => {
          this.rechecks.delete(sessionId);
          if (this.port.rootCwd(sessionId) === cwd) void this.recover(sessionId, cwd);
        }, Math.max(0, recheckAt - this.now()) + 5);
        (timer as { unref?: () => void }).unref?.();
        this.rechecks.set(sessionId, timer);
      }
    } catch (e) {
      // A damaged journal still projects failed cards through views(); a
      // recovery failure must never stop the conversation from opening.
      log('WARN', 'PlanHostBridge', 'plan recovery failed', { sessionId, error: String(e instanceof PlanJournalUnreadableError ? e.detail : e) });
    }
  }

  private cancelRecheck(sessionId: string): void {
    const timer = this.rechecks.get(sessionId);
    if (timer) clearTimeout(timer);
    this.rechecks.delete(sessionId);
  }

  /** The conversation is closing or moving to another device. */
  async interruptSession(sessionId: string): Promise<void> {
    this.cancelRecheck(sessionId);
    await this.executor.interruptSession(sessionId);
    // Task 9b: closed or taken over — nothing here will deliver its notices.
    await this.clearSessionHandoffs(sessionId);
  }

  /**
   * Final review F2: a run's final write failed, so its card still says
   * "running". Recovery is run after a short wait (the run has left the
   * executor's books by then), and again later while the plan is still
   * orphaned — a disk that stays broken is retried a bounded number of times.
   */
  private scheduleOrphanRecovery(ref: PlanRef, planId: string, attempt = 0): void {
    const delay = this.orphanRecoveryDelaysMs[attempt];
    if (delay === undefined) return;
    const timer = setTimeout(() => {
      this.orphanTimers.delete(timer);
      if (this.executor.orphanReason(ref, planId) === undefined) return;
      if (this.port.rootCwd(ref.sessionId) !== ref.cwd) return;
      void this.recover(ref.sessionId, ref.cwd).then(() => {
        if (this.executor.orphanReason(ref, planId) !== undefined) this.scheduleOrphanRecovery(ref, planId, attempt + 1);
      });
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    this.orphanTimers.add(timer);
  }

  /** App quit. */
  async interruptAll(): Promise<void> {
    for (const id of [...this.rechecks.keys()]) this.cancelRecheck(id);
    for (const t of this.orphanTimers) clearTimeout(t);
    this.orphanTimers.clear();
    await this.executor.interruptAll();
    await Promise.all([...new Set([...this.handoffs.values()].map((h) => h.ref.sessionId))].map((id) => this.clearSessionHandoffs(id)));
  }

  // ---- manifest (frozen at proposal) ----

  private async bindingFor(def: SpecialistDefinition, parent: ModelBinding, catalog: () => Promise<CatalogModel[] | null>): Promise<ModelBinding> {
    // The same resolver the Task tool uses for a specialist with no explicit
    // model: a provider-matched safe default, never the parent by accident.
    const requested = resolveRequestedModel(undefined, def.modelPreference);
    if (requested === 'parent') return parent;
    if (!this.port.designated) throw new PlanProposalError("Specialist models aren't available in this session, so the plan wasn't created.");
    const needsCatalog = typeof requested === 'object' || !this.port.designated.get(requested);
    try {
      const { binding } = resolveDelegatedBinding({
        requested, parent, designated: this.port.designated, catalog: needsCatalog ? await catalog() : null,
      });
      return { providerId: binding.providerId, modelId: binding.modelId };
    } catch (e) {
      if (e instanceof DelegatedModelUnavailable) {
        throw new PlanProposalError(`YouCoded couldn't confirm a ${e.tier} model for the "${def.id}" specialist, so the plan wasn't created.`);
      }
      if (e instanceof DelegatedModelRefused) throw new PlanProposalError(e.message);
      throw e;
    }
  }

  /**
   * WHY no setup-probe measurement any more (spending rework stage 1, design
   * §1/§5): the setup-probe existed to certify each specialist's fixed
   * starting cost for the (now deleted) per-step token ceiling — nothing
   * here measures anything before freezing a binding. `steps[id]` is keyed
   * by every LEAF step (design §5), because a per-step model override means
   * two steps naming the same specialist may resolve to different bindings.
   * // T4 owns the real per-step resolution order — (1) `stepModels[id]`
   * (user override), (2) `document.model` via `resolveRequestedModel`, (3)
   * the specialist's own default — and the `source`/`providerId`
   * disambiguation that goes with it. This still resolves ONE binding per
   * SPECIALIST (today's behavior) and freezes it onto every leaf step of
   * that specialist with `source: 'default'`, which is correct until T4
   * adds real overrides (`document.model`/`stepModels` are ignored here).
   */
  async resolveManifest(input: { sessionId: string; cwd: string; document: PlanDocumentV1 }): Promise<ExecutionManifest> {
    const parent = this.port.parentBinding(input.sessionId);
    if (!parent) throw new PlanProposalError("This conversation isn't open, so the plan can't be prepared.");
    const roster = this.port.roster(input.cwd);
    let catalog: Promise<CatalogModel[] | null> | undefined;
    const specialists: ExecutionManifest['specialists'] = {};
    // Task 13 (decision 25): a plan is never PROPOSED with a specialist that
    // cannot run. Resolved FIRST, for every specialist, before anything is
    // frozen — review finding 9's "one trip to Settings" holds: the refusal
    // below names every specialist that is not ready, not just the first.
    // The provider's own sentence is repeated verbatim: never a new cause.
    const resolved: Array<{ id: string; def: SpecialistDefinition; binding: ModelBinding; route: PlanRoute }> = [];
    const notReady: PlanNotReadySpecialist[] = [];
    const leaves = leafSteps(input.document.steps);
    for (const id of [...new Set(leaves.map((s) => s.specialist))]) {
      const def = roster.resolve(id);
      if (!def) throw new PlanProposalError(`The plan names a specialist ("${id}") that isn't available in this project.`);
      const binding = await this.bindingFor(def, parent, () => (catalog ??= this.port.catalog()));
      const route = await this.port.resolveRoute(binding);
      const ready = await this.port.credentialReadiness(binding);
      if (ready.ok) resolved.push({ id, def, binding, route });
      else notReady.push({ id, label: ready.label, message: ready.message });
    }
    if (notReady.length > 0) throw new PlanSpecialistsNotReadyError(notReady);
    const bySpecialist = new Map(resolved.map((r) => [r.id, r]));
    for (const { id, def } of resolved) specialists[id] = { definitionFingerprint: definitionFingerprint(def) };
    const steps: ExecutionManifest['steps'] = {};
    for (const step of leaves) {
      const r = bySpecialist.get(step.specialist)!;
      steps[step.id] = {
        binding: r.binding,
        label: r.binding.modelId,
        pricing: pricingSnapshot({ pricing: r.route.pricing, free: r.route.free, local: r.route.providerType === 'local-engine' }),
        source: 'default',
      };
    }
    return {
      modelLabel: [...new Set(resolved.map((r) => r.binding.modelId))].join(', '),
      specialists,
      steps,
      permissionFingerprint: `perm:${sha(this.port.permissionState(input.sessionId))}`,
    };
  }

  // ---- the executor's runner ----

  // WHY no localPoolTokens/minimumAddTokens/launchRefusal/reportOnlyInputBound
  // wiring any more (spending rework stage 1, design §1): see PlanRunner's
  // own WHY comment (plan-executor.ts) — none of the four exist any more.
  private runner(): PlanRunner {
    return {
      maxConcurrent: (ref) => this.port.maxConcurrent(ref.sessionId),
      // Unknown specialist → serialize (the safe direction).
      isWriter: (ref, specialist) => this.port.roster(ref.cwd).resolve(specialist)?.charter !== 'read-only',
      launch: (input) => this.launch(input),
      inspectTranscript: (ref, childId): TranscriptVerdict => classifyChildTranscript(this.port.readChildEvents(childId, ref.cwd), nativeToolEffect),
      onUnreadable: (ref, planId, detail) => this.onUnreadable(ref, planId, detail),
      onOrphaned: (ref, planId) => this.scheduleOrphanRecovery(ref, planId),
      providerNotReady: (_ref, plan, specialist) => this.providerNotReady(plan, specialist),
      latestUserText: (ref, childId) => {
        const events = this.port.readChildEvents(childId, ref.cwd);
        for (let i = events.length - 1; i >= 0; i--) {
          if (events[i].type === 'user-message') return String(events[i].data.text ?? '');
        }
        return undefined;
      },
    };
  }

  /**
   * Task 13 (decision 26): the provider's own sentence when this specialist's
   * frozen model can't run right now, so the executor never spends the plan's
   * ONE automatic retry on something that cannot heal itself.
   * WHY the binding comes from the FIRST leaf step naming `specialist`
   * (design §5): until T4 builds per-step overrides, every leaf step of one
   * specialist shares the same frozen binding, so any of them names it.
   */
  private async providerNotReady(plan: PlanRecord, specialist: string): Promise<string | undefined> {
    const stepId = leafSteps(plan.document.steps).find((s) => s.specialist === specialist)?.id;
    const frozen = stepId ? plan.manifest.steps[stepId] : undefined;
    if (!frozen) return undefined;
    const ready = await this.port.credentialReadiness(frozen.binding);
    return ready.ok ? undefined : ready.message;
  }

  private async launch(input: PlanChildLaunch): Promise<PlanChildHandle> {
    const { ref } = input;
    const cwd = this.port.rootCwd(ref.sessionId);
    if (cwd === undefined) throw new Error("the conversation that owns this plan isn't open");
    const plan = await this.journal.get(ref, input.planId);
    // Design §5: launch() reads manifest.steps[stepId].binding — the frozen
    // per-STEP entry, not a per-specialist one.
    const frozen = plan?.manifest.steps[input.stepId];
    const specialistEntry = plan?.manifest.specialists[input.specialist];
    // Review fix 6: these two can never succeed by trying again, so they are
    // refusals (never retried automatically; Stop-only for the assistant).
    if (!plan || !frozen || !specialistEntry) throw new PlanLaunchRefusedError(`the plan has no approved settings for the "${input.specialist}" specialist`);
    const def = this.port.roster(cwd).resolve(input.specialist);
    if (!def || definitionFingerprint(def) !== specialistEntry.definitionFingerprint) {
      // Task 9a: a drift, never retried automatically.
      throw new PlanLaunchDriftError(`the "${input.specialist}" specialist's instructions or tools changed since the plan was approved. Ask the assistant to propose the plan again`);
    }
    const route = await this.port.resolveRoute(frozen.binding);
    // Task 13 (decision 26): the FROZEN binding's provider is checked before
    // anything is minted. Not a refusal — the person signs in or adds the key
    // and presses Continue — so it carries the provider's own sentence and its
    // own error type, which the executor never retries.
    const ready = await this.port.credentialReadiness(frozen.binding);
    if (!ready.ok) throw new PlanNotReadyError(ready.message);
    // T2: forward the fence and the run's shared spend flags straight
    // through — the host (native-session-host.ts's startPlanChild) builds the
    // ONE `PlanSpend` object per attempt from exactly these (Revision 3 F1).
    return this.port.startChild({
      parentId: ref.sessionId, specialist: def, binding: frozen.binding, providerType: route.providerType,
      parentToolCallId: plan.toolUseId,
      ...(input.resumeChildId ? { resumeChildId: input.resumeChildId } : {}),
      signal: input.signal,
      tag: { planId: input.planId, stepId: input.stepId, attemptId: input.attemptId },
      recordChild: input.recordChild,
      brief: input.brief,
      ...(input.toolsDisabled ? { toolsDisabled: true } : {}),
      fence: input.fence,
      isLimitReached: input.isLimitReached, markLimitReached: input.markLimitReached,
      isWriteFailed: input.isWriteFailed, markWriteFailed: input.markWriteFailed,
    });
  }

  private onUnreadable(ref: PlanRef, planId: string, detail: string): void {
    const last = this.lastViews.get(this.viewKey(ref.sessionId, planId));
    if (last) {
      // Task 2 obligation: the renderer keeps the higher seq, so the failed
      // card must be exactly one newer than the last card it was shown.
      this.port.emit({ sessionId: ref.sessionId, plan: { ...last, status: 'failed', seq: (last.seq ?? 0) + 1, failure: { detail } } });
      return;
    }
    void this.journal.list(ref).then(
      (views) => { for (const plan of views) this.port.emit({ sessionId: ref.sessionId, plan }); },
      (e) => log('WARN', 'PlanHostBridge', 'could not project a damaged plan journal', { error: String(e) }),
    );
  }

  // WHY reportOnlyInputBound/minimumAddTokens are GONE (spending rework
  // stage 1, design §1): both measured an Add budget top-up (or a report
  // turn's fundability) through an unwired probe session — neither concept
  // exists any more. See PlanRunner's own WHY comment (plan-executor.ts).
}

/** 5b follow-up: what the MODEL is also told with a Comment's follow-up turn.
 *  History-only (HarnessSession `historyNote`): the chat shows only
 *  commentTurnText, while the model is pointed at the one tool that answers. */
export const COMMENT_MODEL_NOTE = `${PLAN_COMMENT_TAG}\nThe user's message above is feedback on the plan you proposed. `
  + 'Answer it by calling propose_plan with a revised plan that addresses it.\n</plan-comment>';

/** The follow-up turn a Comment queues (design §2). The user's own words come
 *  first; the instruction after them tells the assistant what to do next.
 *  Task 5b: this text shows in the chat as the USER's own message, so it is
 *  short and plain — no tool name. The model is told which tool to use by
 *  COMMENT_MODEL_NOTE, which only it sees. */
export function commentTurnText(comment: string): string {
  return `${comment}\n\n(Feedback on your plan: please revise it and propose it again.)`;
}
