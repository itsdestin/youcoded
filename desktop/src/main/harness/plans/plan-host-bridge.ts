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
import { createHash } from 'crypto';
import type { CatalogModel, ModelBinding } from '../../../shared/provider-types';
import type { PlanView, TranscriptEvent } from '../../../shared/types';
import type { NativeHome } from '../../native-home';
import type { ModelPricing } from '../pricing';
import type { CapabilityProfile, ProfileProviderType } from '../capability-profile';
import type { HarnessSession } from '../harness-session';
import type { SpecialistDefinition, SpecialistRoster } from '../specialists/registry';
import {
  DelegatedModelRefused, DelegatedModelUnavailable, resolveDelegatedBinding, resolveRequestedModel, type DelegatedModels,
} from '../specialists/delegated-models';
import { log } from '../../logger';
// Task 9a: each tool's declared effect decides what a cut-off call means.
import { nativeToolEffect } from '../tools';
import type { PlanDocumentV1, PlanStepV1 } from './schema';
import { PlanJournal, PlanJournalUnreadableError } from './plan-journal';
import { PlanBudget, pricingSnapshot } from './plan-budget';
import { PlanService, type PlanProposal } from './plan-service';
import {
  PlanExecutor, PlanLaunchDriftError, classifyChildTranscript, planRestartBrief,
  type PlanChildHandle, type PlanChildLaunch, type PlanRunner, type TranscriptVerdict,
} from './plan-executor';
import {
  adapterDisabledReason, budgetAdapterFor, setupBound, type PlanBudgetAdapter, type PlanChildRequestGate, type PlanChildStop,
} from './budget-adapter';
import type {
  ExecutionManifest, PlanActionResult, PlanAutoApproveRead, PlanEvent, PlanRecord, PlanRef, PlanSettingsWriteResult,
} from './types';

/** Extra room on top of a measured resume request when telling the user the
 *  minimum Add budget. WHY: a project rule injected at that turn's start is
 *  not predicted by the measurement, and the system prompt is reassembled at
 *  launch (date, git state). Too small a number would pause again at once. */
export const PLAN_MINIMUM_ADD_MARGIN_TOKENS = 512;

/** The route facts the host already resolves for any binding. */
export interface PlanRoute {
  providerType: ProfileProviderType;
  profile: CapabilityProfile;
  pricing: ModelPricing | null;
  free: boolean;
  contextLength: number | null;
  totalSlots: number | null;
}

export interface PlanChildStart {
  parentId: string;
  specialist: SpecialistDefinition;
  binding: ModelBinding;
  providerType: ProfileProviderType;
  gate: PlanChildRequestGate;
  /** The propose_plan call the plan renders on (ask cards nest under it). */
  parentToolCallId: string;
  resumeChildId?: string;
  signal: AbortSignal;
  tag: { planId: string; stepId: string; attemptId: string };
  recordChild(childId: string, info?: { title?: string }): Promise<void>;
  brief: string;
  /** Task 9a: send `brief` with tools switched off (the report-only turn). */
  toolsDisabled?: boolean;
  /** The budget stop the gate reported during the turn, if any. */
  budgetStop(): PlanChildStop | undefined;
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
  maxConcurrent(sessionId: string): number;
  readChildEvents(childId: string, cwd: string): TranscriptEvent[];
  /** Queue a user turn carrying a host turn id; throws with the real reason. */
  /** `historyNote`: shown to the model only, never in the chat (5b follow-up). */
  queueTurn(sessionId: string, text: string, turnId: string, historyNote?: string): void;
  currentTurnId(sessionId: string): string | undefined;
  /** Mint (or rebuild) a plan specialist, holding a specialist slot. */
  startChild(input: PlanChildStart): Promise<PlanChildHandle>;
  /** An unwired plan-child session, for measurement only. */
  probeSession(input: {
    parentId: string; specialist: SpecialistDefinition; binding: ModelBinding; route: PlanRoute;
    gate: PlanChildRequestGate; historyFromChildId?: string;
  }): { session: HarnessSession; dispose(): void };
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

/** A gate that can only be measured with — never used to send. */
function measurementGate(adapter: PlanBudgetAdapter): PlanChildRequestGate {
  return {
    adapter,
    reserve: async () => ({ ok: false, kind: 'refused', detail: 'This session is used only to measure a request.' }),
    settle: async () => { throw new Error('This session is used only to measure a request.'); },
  };
}

export class PlanHostBridge {
  readonly journal: PlanJournal;
  readonly budget: PlanBudget;
  readonly executor: PlanExecutor;
  readonly service: PlanService;
  private readonly lastViews = new Map<string, PlanView>();
  private readonly rechecks = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly now: () => number;

  constructor(private readonly port: PlanHostPort, opts: PlanHostBridgeOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.journal = new PlanJournal({
      home: port.home,
      ...(opts.now ? { now: opts.now } : {}),
      onEvent: (event) => {
        this.lastViews.set(this.viewKey(event.sessionId, event.plan.planId), event.plan);
        port.emit(event);
      },
    });
    this.budget = new PlanBudget({ journal: this.journal });
    this.executor = new PlanExecutor({
      journal: this.journal,
      budget: this.budget,
      runner: this.runner(),
      settleDeadlineMs: opts.settleDeadlineMs,
      heartbeatMs: opts.heartbeatMs,
    });
    this.service = new PlanService({
      journal: this.journal,
      home: port.home,
      sessionCwd: (sessionId) => port.rootCwd(sessionId),
      resolveManifest: (input) => this.resolveManifest(input),
      queueCommentTurn: ({ sessionId, turnId, text }) => {
        port.queueTurn(sessionId, commentTurnText(text), turnId, COMMENT_MODEL_NOTE);
      },
      executor: this.executor,
      budget: { addTokens: (input) => this.budget.addTokens(input) },
    });
  }

  private viewKey(sessionId: string, planId: string): string {
    return `${sessionId}\u0000${planId}`;
  }

  // ---- ToolServices.plans ----

  /** propose_plan's callback, with the HOST's turn id (never model input). */
  propose(sessionId: string, proposal: Omit<PlanProposal, 'turnId'>): Promise<PlanView> {
    const turnId = this.port.currentTurnId(sessionId);
    return this.service.propose({ ...proposal, ...(turnId !== undefined ? { turnId } : {}) });
  }

  // ---- the seven actions + hydration ----

  approve(sessionId: string, planId: string): Promise<PlanActionResult> { return this.service.approve(sessionId, planId); }
  comment(sessionId: string, planId: string, text: string): Promise<PlanActionResult> { return this.service.comment(sessionId, planId, text); }
  addBudget(sessionId: string, planId: string, tokens: number): Promise<PlanActionResult> { return this.service.addBudget(sessionId, planId, tokens); }
  resume(sessionId: string, planId: string): Promise<PlanActionResult> { return this.service.resume(sessionId, planId); }
  stop(sessionId: string, planId: string): Promise<PlanActionResult> { return this.service.stop(sessionId, planId); }
  getAutoApprove(): Promise<PlanAutoApproveRead> { return this.service.getAutoApprove(); }
  setAutoApprove(underTokens: unknown): Promise<PlanSettingsWriteResult> { return this.service.setAutoApprove(underTokens); }

  /** Current card projections, read from the journal (never from memory). */
  async views(sessionId: string): Promise<PlanView[]> {
    const cwd = this.port.rootCwd(sessionId);
    if (cwd === undefined) return [];
    try {
      return await this.journal.list({ cwd, sessionId });
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
      const { recheckAt } = await this.journal.recoverInterrupted(ref, { onInterrupt: (plan) => this.budget.releaseOwnerlessHolds(plan) });
      // Plans left paused/interrupted/stopped with holds by an older crash.
      const read = await this.journal.read(ref);
      if (read.kind === 'valid') {
        for (const plan of read.file.plans) {
          if (plan.lease || plan.status === 'running') continue;
          const holds = plan.steps.some((s) => s.attempts.some((a) => a.phase !== 'committed' && a.completedAt === undefined
            && (a.reservedTokens > 0 || a.phase === 'request-sent')));
          if (holds) await this.budget.settleOwnerless(ref, plan.planId);
        }
      }
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
  }

  /** App quit. */
  async interruptAll(): Promise<void> {
    for (const id of [...this.rechecks.keys()]) this.cancelRecheck(id);
    await this.executor.interruptAll();
  }

  // ---- manifest (frozen at proposal) ----

  private async bindingFor(def: SpecialistDefinition, parent: ModelBinding, catalog: () => Promise<CatalogModel[] | null>): Promise<ModelBinding> {
    // The same resolver the Task tool uses for a specialist with no explicit
    // model: a provider-matched safe default, never the parent by accident.
    const requested = resolveRequestedModel(undefined, def.modelPreference);
    if (requested === 'parent') return parent;
    if (!this.port.designated) throw new Error("Specialist models aren't available in this session, so the plan wasn't created.");
    const needsCatalog = typeof requested === 'object' || !this.port.designated.get(requested);
    try {
      const { binding } = resolveDelegatedBinding({
        requested, parent, designated: this.port.designated, catalog: needsCatalog ? await catalog() : null,
      });
      return { providerId: binding.providerId, modelId: binding.modelId };
    } catch (e) {
      if (e instanceof DelegatedModelUnavailable) {
        throw new Error(`YouCoded couldn't confirm a ${e.tier} model for the "${def.id}" specialist, so the plan wasn't created.`);
      }
      if (e instanceof DelegatedModelRefused) throw new Error(e.message);
      throw e;
    }
  }

  async resolveManifest(input: { sessionId: string; cwd: string; document: PlanDocumentV1 }): Promise<ExecutionManifest> {
    const parent = this.port.parentBinding(input.sessionId);
    if (!parent) throw new Error("This conversation isn't open, so the plan can't be prepared.");
    const roster = this.port.roster(input.cwd);
    let catalog: Promise<CatalogModel[] | null> | undefined;
    const specialists: ExecutionManifest['specialists'] = {};
    for (const id of [...new Set(leafSteps(input.document.steps).map((s) => s.specialist))]) {
      const def = roster.resolve(id);
      if (!def) throw new Error(`The plan names a specialist ("${id}") that isn't available in this project.`);
      const binding = await this.bindingFor(def, parent, () => (catalog ??= this.port.catalog()));
      const route = await this.port.resolveRoute(binding);
      const lookup = budgetAdapterFor(route.providerType);
      if (!lookup.ok) throw new Error(lookup.reason);
      // Decision 4: the exact child system prompt and tool schemas, measured
      // by the same adapter its request gate will use.
      const probe = this.port.probeSession({ parentId: input.sessionId, specialist: def, binding, route, gate: measurementGate(lookup.adapter) });
      let setup: Awaited<ReturnType<HarnessSession['planSetupRequest']>>;
      try { setup = await probe.session.planSetupRequest(); } finally { probe.dispose(); }
      const bound = setupBound(lookup.adapter, setup);
      if (!bound.ok) throw new Error(bound.reason);
      specialists[id] = {
        definitionFingerprint: definitionFingerprint(def),
        binding,
        pricing: pricingSnapshot({ pricing: route.pricing, free: route.free, local: route.providerType === 'local-engine' }),
        setupTokens: bound.tokens,
        ...(lookup.adapter.capsOutput ? {} : { approximateLimit: true }),
      };
    }
    return {
      modelLabel: [...new Set(Object.values(specialists).map((s) => s.binding.modelId))].join(', '),
      specialists,
      permissionFingerprint: `perm:${sha(this.port.permissionState(input.sessionId))}`,
    };
  }

  // ---- the executor's runner ----

  private runner(): PlanRunner {
    return {
      maxConcurrent: (ref) => this.port.maxConcurrent(ref.sessionId),
      // Unknown specialist → serialize (the safe direction).
      isWriter: (ref, specialist) => this.port.roster(ref.cwd).resolve(specialist)?.charter !== 'read-only',
      localPoolTokens: (ref, plan) => this.localPoolTokens(plan),
      launch: (input) => this.launch(input),
      inspectTranscript: (ref, childId): TranscriptVerdict => classifyChildTranscript(this.port.readChildEvents(childId, ref.cwd), nativeToolEffect),
      onUnreadable: (ref, planId, detail) => this.onUnreadable(ref, planId, detail),
      minimumAddTokens: (ref, plan, attemptId) => this.minimumAddTokens(ref, plan, attemptId),
      launchRefusal: (_ref, plan, specialist) => this.launchRefusal(plan, specialist),
    };
  }

  private async launchRefusal(plan: PlanRecord, specialist: string): Promise<string | undefined> {
    const frozen = plan.manifest.specialists[specialist];
    if (!frozen) return `The plan has no approved settings for the "${specialist}" specialist.`;
    const lookup = budgetAdapterFor((await this.port.resolveRoute(frozen.binding)).providerType);
    if (!lookup.ok) return lookup.reason;
    const disabled = adapterDisabledReason(lookup.adapter.id)
      ?? plan.disabledAdapters?.find((d) => d.adapterId === lookup.adapter.id)?.detail;
    return disabled ? `Plan budgets are switched off for this model after a request went over its limit: ${disabled}` : undefined;
  }

  private async localPoolTokens(plan: PlanRecord): Promise<number | undefined> {
    const local = Object.values(plan.manifest.specialists).find((s) => (s.pricing as { kind?: string } | null)?.kind === 'local');
    if (!local) return undefined;
    const route = await this.port.resolveRoute(local.binding);
    // One configured pool shared by every slot (llama-server reports the
    // per-slot window). Unknown → the same 32k default the session assumes.
    return (route.contextLength ?? 32_768) * Math.max(1, route.totalSlots ?? 1);
  }

  private async launch(input: PlanChildLaunch): Promise<PlanChildHandle> {
    const { ref } = input;
    const cwd = this.port.rootCwd(ref.sessionId);
    if (cwd === undefined) throw new Error("the conversation that owns this plan isn't open");
    const plan = await this.journal.get(ref, input.planId);
    const frozen = plan?.manifest.specialists[input.specialist];
    if (!plan || !frozen) throw new Error(`the plan has no approved settings for the "${input.specialist}" specialist`);
    const def = this.port.roster(cwd).resolve(input.specialist);
    if (!def || definitionFingerprint(def) !== frozen.definitionFingerprint) {
      // Task 9a: a drift, never retried automatically.
      throw new PlanLaunchDriftError(`the "${input.specialist}" specialist's instructions or tools changed since the plan was approved. Ask the assistant to propose the plan again`);
    }
    const route = await this.port.resolveRoute(frozen.binding);
    const lookup = budgetAdapterFor(route.providerType);
    if (!lookup.ok) throw new Error(lookup.reason);
    let stop: PlanChildStop | undefined;
    const gate: PlanChildRequestGate = {
      ...this.budget.requestGate(ref, input.planId, input.fence, input.stepId, input.attemptId, lookup.adapter),
      onStop: (s) => { stop ??= s; },
    };
    return this.port.startChild({
      parentId: ref.sessionId, specialist: def, binding: frozen.binding, providerType: route.providerType, gate,
      parentToolCallId: plan.toolUseId,
      ...(input.resumeChildId ? { resumeChildId: input.resumeChildId } : {}),
      signal: input.signal,
      tag: { planId: input.planId, stepId: input.stepId, attemptId: input.attemptId },
      recordChild: input.recordChild,
      brief: input.brief,
      ...(input.toolsDisabled ? { toolsDisabled: true } : {}),
      budgetStop: () => stop,
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

  /**
   * The smallest Add budget after which Continue can send the paused
   * specialist's next request: its fresh resume prompt must fit what is left
   * of its allowance, and on a soft (ChatGPT) plan the plan's own limit must
   * be above what was already used (Task 3 obligation). undefined when
   * nothing more is needed or it can't be measured.
   */
  private async minimumAddTokens(ref: PlanRef, plan: PlanRecord, attemptId: string): Promise<number | undefined> {
    const stepRec = plan.steps.find((s) => s.attempts.some((a) => a.attemptId === attemptId));
    const attempt = stepRec?.attempts.find((a) => a.attemptId === attemptId);
    const step = stepRec && leafSteps(plan.document.steps).find((s) => s.id === stepRec.id);
    const frozen = step && plan.manifest.specialists[step.specialist];
    if (!attempt || !step || !frozen || !attempt.childId) return undefined;
    const route = await this.port.resolveRoute(frozen.binding);
    const lookup = budgetAdapterFor(route.providerType);
    if (!lookup.ok) return undefined;
    const left = attempt.baseTokens + attempt.addedTokens - attempt.spentTokens;
    // Review item 2: the plan-wide gap is asked ONCE. Every other unfinished
    // specialist that overshot its own allowance will pause on its own and be
    // asked at least that overshoot then, so it is not asked for here too.
    const coveredByOthers = plan.steps.flatMap((s) => s.attempts)
      .filter((a) => a.attemptId !== attemptId && a.phase !== 'committed' && a.completedAt === undefined)
      .reduce((n, a) => n + Math.max(0, a.spentTokens - a.baseTokens - a.addedTokens), 0);
    const softGap = !lookup.adapter.capsOutput && plan.usedTokens >= plan.ceilingTokens
      ? plan.usedTokens - plan.ceilingTokens + 1 - coveredByOthers : 0;
    const verdict = classifyChildTranscript(this.port.readChildEvents(attempt.childId, ref.cwd), nativeToolEffect);
    // A terminal transcript needs no request; an undelivered brief is covered
    // by the attempt's untouched allowance.
    if (verdict.kind === 'terminal' || (verdict.kind === 'resumable' && !verdict.briefDelivered)) return softGap > 0 ? softGap : undefined;
    const cwd = this.port.rootCwd(ref.sessionId);
    const def = cwd !== undefined ? this.port.roster(cwd).resolve(step.specialist) : undefined;
    if (!def) return softGap > 0 ? softGap : undefined;
    const probe = this.port.probeSession({
      parentId: ref.sessionId, specialist: def, binding: frozen.binding, route,
      gate: measurementGate(lookup.adapter), historyFromChildId: attempt.childId,
    });
    let need = 0;
    try {
      // The exact turn the restart will send (items 3/4).
      const bound = await probe.session.planNextRequestBound(lookup.adapter, planRestartBrief(verdict));
      if (bound.ok) need = bound.tokens + 1 + PLAN_MINIMUM_ADD_MARGIN_TOKENS - left;
    } finally {
      probe.dispose();
    }
    const minimum = Math.max(softGap, need);
    return minimum > 0 ? minimum : undefined;
  }
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
