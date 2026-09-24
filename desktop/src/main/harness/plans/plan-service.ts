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
import { pausedRouting, resetRecoveriesForContinue, type PlanPauseAction } from './pause-routing';
import { PLAN_NOTICE_DETAIL_MAX_CHARS, PLAN_RECOMMENDATION_MAX_CHARS, normalizePlanQuestion } from './plan-handoff';
import type {
  ExecutionManifest, JournalPlanStatus, PlanActionResult, PlanAutoApproveRead, PlanEstimate, PlanRecord, PlanRef,
  PlanSettingsWriteResult, PlanUnsupported,
} from './types';
import { PlanProposalError, PlanSpecialistsNotReadyError } from './types';
// T5 (design §4): the estimate is computed here (propose, re-freeze) rather
// than inside resolveManifest/reconcile, because it needs the plan's own
// specialist-usage history — a dependency plan-host-bridge.ts's
// resolveManifest has no reason to carry.
import { estimatePlan } from './plan-estimate';
import type { SpecialistUsageSnapshot } from './specialist-usage-history';

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

// WHY PlanBudgetHooks is GONE (spending rework stage 1, design §1): no Add
// budget authorization tranche exists any more to record.

/** Task 9b: told when a user action superseded a pending handoff, so the
 *  host withdraws its undelivered notice and stops its backstop. */
interface PlanHandoffHooks {
  superseded(ref: PlanRef, planId: string, handoffId: string): void;
}

/** Task 9b: what recommend_plan_action sends (pause handoff §2 step 6). */
export interface PlanRecommendation {
  sessionId: string;
  planId: string;
  handoffId: string;
  action: string;
  message: string;
}
export type PlanRecommendResult = { ok: true; plan: PlanView } | { ok: false; error: string };

/** Task 11 (§6): the handoff the host minted for one press of "Ask the
 *  assistant" — already registered in its in-memory map before this write. */
export interface PlanAskHandoff {
  id: string;
  /** The notice turn's id: the pending revision a propose_plan from that
   *  turn may link to. */
  turnId: string;
  /** The question will wait behind a reply already in progress. */
  waiting?: boolean;
}

/** Task 11 (§6): why a question was cleared without an answer. */
export type PlanHandoffProblem = { kind: 'no-start' } | { kind: 'reply-failed'; detail?: string };

export interface PlanServiceDeps {
  journal: PlanJournal;
  home: NativeHome;
  now?: () => number;
  /** The parent session's working folder, or undefined when it has no native session here. */
  sessionCwd(sessionId: string): string | undefined;
  /** Model binding (through the automatic specialist model resolver), price,
   *  specialist definition and permission fingerprints for this document.
   *  `pricing` must be a PlanPricingSnapshot (plan-spend.ts, T2) or null;
   *  anything else is read as "no price". */
  resolveManifest(input: { sessionId: string; cwd: string; document: PlanDocumentV1 }): Promise<ExecutionManifest>;
  /** Queue the user-visible follow-up turn a Comment creates. */
  queueCommentTurn(input: { sessionId: string; turnId: string; planId: string; text: string }): Promise<void> | void;
  executor?: PlanExecutorHooks;
  handoffs?: PlanHandoffHooks;
  newId?: () => string;
  /** T5 (design §4): past-run usage `estimatePlan` prices from. Optional —
   *  absent or empty still prices every built-in specialist type from
   *  plan-estimate.ts's own pinned defaults, so a bare test construction of
   *  this interface (there are ~70) keeps compiling AND keeps getting a real
   *  estimate rather than none. */
  history?: { snapshot(): SpecialistUsageSnapshot };
  /** T5: only consulted for a CUSTOM specialist with no usage history of its
   *  own, to choose plan-estimate.ts's worker-vs-reviewer default (design
   *  §4's own fallback). Absent → that module's own conservative default. */
  specialistCanWrite?(cwd: string, specialistId: string): boolean | undefined;
}

export interface PlanProposal {
  sessionId: string;
  toolUseId: string;
  document: PlanDocumentV1;
  maximumAttempts: number;
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
  /** Final review F3: host-supplied key of the turn this call came from. At
   *  most one proposal per key starts without a click; the rest wait for
   *  Approve. Absent (unit tests) → no per-turn limit. */
  autoStartKey?: string;
}

/** Final review F3: how many turn keys the service remembers (a turn is long
 *  over well before this many newer turns have auto-started a plan). */
const AUTO_START_KEYS_KEPT = 256;

// WHY PENDING_ASKS_KEPT/PLAN_LIMIT_ASK_MS are GONE (spending rework stage 1,
// design §5): there is no new-limit question left to remember or expire.

const unsupported = (error: string): PlanUnsupported => ({ ok: false, unsupported: true, error });
/** A malformed request id comes from a broken caller, never from a person's
 *  choice: the same general line the transport uses (no cause is invented). */
const ACTION_REQUEST_UNREADABLE = "Couldn't update the plan. Please try again.";
/** Final review F11: the general settings lines (the same words the card's
 *  bridge uses when it can't read an answer). */
const SETTINGS_READ_FAILED = "Couldn't read the plan settings. Please try again.";
const SETTINGS_WRITE_FAILED = "Couldn't save the plan settings. Please try again.";
/** A general failure that keeps the system's own text for the bug report. */
function generalFailure(error: string, cause: unknown): { ok: false; error: string; detail?: string } {
  const detail = String((cause as { message?: unknown } | null)?.message ?? cause ?? '').trim();
  return detail ? { ok: false, error, detail } : { ok: false, error };
}
const failure = (error: string) => ({ ok: false as const, error });

/** Thrown inside a journal mutation to abort it with a user-facing reason. */
class PlanActionRefused extends Error {}

const ACTIONS: readonly PlanPauseAction[] = ['continue', 'stop'];
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
  // Task 11: the user acted, so neither "waiting" nor an old question's
  // error line describes the card any more.
  delete h.waiting;
  delete h.problem;
  return h.id;
}

/** Task 11 (§6): a provider error can be long; the card shows at most this much. */
function capDetail(detail: string): string {
  const t = detail.trim();
  return t.length <= PLAN_NOTICE_DETAIL_MAX_CHARS ? t : `${t.slice(0, PLAN_NOTICE_DETAIL_MAX_CHARS)}…`;
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
 * What changed between the frozen manifest and now — in plain words (Task
 * 14, decision 27). WHY only `definition`/`permissions` now, no `repricing`
 * category (spending rework stage 1, design §5): a model/price/tier change
 * is no longer a refusal OR a question — `reconcile` re-freezes it silently
 * whenever anything differs, so nothing here needs to classify WHAT kind of
 * difference that was any more.
 */
interface ManifestDrift {
  /** A specialist's instructions or tools, or the set of specialists itself. */
  definition: boolean;
  permissions: boolean;
  /** The phrases the refusal sentence joins, in the order they were found. */
  phrases: string[];
}

function manifestDrift(frozen: ExecutionManifest, current: ExecutionManifest): ManifestDrift {
  const changes = new Set<string>();
  const drift: ManifestDrift = { definition: false, permissions: false, phrases: [] };
  const ids = new Set([...Object.keys(frozen.specialists), ...Object.keys(current.specialists)]);
  for (const id of ids) {
    const a = frozen.specialists[id];
    const b = current.specialists[id];
    if (!a || !b || a.definitionFingerprint !== b.definitionFingerprint) {
      changes.add("a specialist's instructions or tools");
      drift.definition = true;
    }
  }
  if (frozen.permissionFingerprint !== current.permissionFingerprint) { changes.add('the permission settings'); drift.permissions = true; }
  drift.phrases = [...changes];
  return drift;
}

/** Task 14: what one press of Approve/Continue must do about the drift.
 *  WHY no `confirm` kind any more (spending rework stage 1, design §5
 *  "Approve/Continue drift (reconcile, 397) stays cheap — no probe, no
 *  session... Tier/price change → silently re-freeze not-started steps and
 *  recompute the estimate. The confirm notice is no longer produced"):
 *  a price/tier change is no longer a question — there is no ceiling for it
 *  to raise, so it just re-freezes and runs. */
type PlanReconcile =
  | { kind: 'unchanged' }
  /** Re-freeze to these models in the write that starts the run. */
  | { kind: 'refreshed'; manifest: ExecutionManifest };

// WHY limitChangeNotice/refreeze's old body are GONE (spending rework stage
// 1, design §1/§5): both worded/computed a ceiling change the user had to
// confirm before a bigger worst case ran. `refreeze` below still re-freezes
// the manifest — silently, every time, never asking.

/**
 * Task 14: re-freeze this plan to the models that are configured NOW, in the
 * caller's own journal write. T5 (design §5 "recompute the estimate"):
 * `estimate` is passed in rather than computed here, because it needs the
 * usage-history dependency, which lives on PlanService, not on this bare
 * function — see PlanService.estimateFor's own WHY.
 */
function refreeze(plan: PlanRecord, current: ExecutionManifest, estimate: PlanEstimate | undefined): void {
  plan.manifest = current;
  plan.estimate = estimate;
}

/** Design §8: `autoStart.underUsd` (renamed from `autoApprove.underTokens` —
 *  decision 34 Q-6, "when the estimate is under $X"), finite, 0–1000
 *  dollars (cent precision, e.g. 1.50); 0 = off. A damaged setting, or an
 *  OLD `underTokens` value, reads as OFF — the safe direction, since "on"
 *  would start spending without a click. */
function readUnderUsd(raw: unknown): number {
  const value = (raw as { autoStart?: { underUsd?: unknown } } | null)?.autoStart?.underUsd;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000 ? value : 0;
}

export class PlanService {
  private readonly journal: PlanJournal;
  private readonly now: () => number;
  private readonly newId: () => string;
  /** Final review F3: turn keys that already auto-started a plan (oldest first). */
  private readonly autoStartedKeys = new Set<string>();
  constructor(private readonly deps: PlanServiceDeps) {
    this.journal = deps.journal;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => randomUUID());
  }

  private refFor(sessionId: string): PlanRef | undefined {
    const cwd = this.deps.sessionCwd(sessionId);
    return cwd === undefined ? undefined : { cwd, sessionId };
  }

  /** Shared wrapper: every action returns a result, never throws.
   *  Final review F11: a refusal worded for people is shown as it is; any
   *  other error (a disk or lock failure) answers the general line, and its
   *  own text travels in `detail` for the bug report only. */
  private async act(verb: string, fn: () => Promise<PlanActionResult>): Promise<PlanActionResult> {
    try {
      return await fn();
    } catch (e: any) {
      if (e instanceof PlanActionRefused || e instanceof PlanJournalUnreadableError || e instanceof PlanProposalError) return failure(e.message);
      console.error(`[plan-service] could not ${verb} a plan`, e);
      return generalFailure(ACTION_REQUEST_UNREADABLE, e);
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

  /**
   * Task 14 (decision 27). What one press must do about a manifest that no
   * longer matches the approved one:
   *  - instructions/tools or permissions changed → refuse, in today's words.
   *    What the specialist can DO changed; that is not a price question.
   *  - only the models and/or their prices changed → re-freeze and run, SILENTLY
   *    when the new worst case is provably not more than the approved one;
   *    otherwise ask ONCE (the same button, pressed again, runs it).
   *  - nothing changed → unchanged.
   */
  /**
   * WHY no pendingAsk read/write any more (spending rework stage 1, design
   * §5): there is no new-limit question left to arm or answer — a
   * definition/permission drift still refuses; anything else re-freezes
   * silently, every time.
   */
  private async reconcile(ref: PlanRef, plan: PlanRecord): Promise<PlanReconcile> {
    // Review finding 2: this is Approve and Continue, on a plan the person is
    // looking at. A specialist whose provider went not-ready since the plan was
    // proposed must not answer with the PROPOSAL's ending ("The plan wasn't
    // created.") about a card that is plainly on screen — decision 26's promise
    // is "sign in, then press Continue". The provider's own sentence is
    // unchanged; only this ending is ours.
    const current = await this.deps.resolveManifest({ sessionId: ref.sessionId, cwd: ref.cwd, document: plan.document })
      .catch((e) => {
        if (e instanceof PlanSpecialistsNotReadyError) throw new PlanActionRefused(`${e.message} The plan can't start yet.`);
        throw e;
      });
    const drift = manifestDrift(plan.manifest, current);
    if (drift.definition || drift.permissions) {
      throw new PlanActionRefused(
        `This plan can't run as approved because ${drift.phrases.join(', ')} changed since it was proposed. Ask the assistant to propose it again.`,
      );
    }
    return canonical(plan.manifest) === canonical(current) ? { kind: 'unchanged' } : { kind: 'refreshed', manifest: current };
  }

  /**
   * T5 (design §4): compute `plan.estimate` from a document and a manifest's
   * steps, using whatever specialist-usage history this service was built
   * with. ONE named function — called from `propose` (below), from the two
   * re-freeze sites (Approve/Continue drift, above), and left here for T4's
   * `setStepModel` to call after it re-resolves one step's manifest entry
   * (design §4: "Computed at propose... on setStepModel, and on
   * re-freeze") — so every site that changes what a plan's steps would run
   * on updates the estimate the SAME way, and never invents its own.
   */
  private estimateFor(ref: PlanRef, document: PlanDocumentV1, manifestSteps: ExecutionManifest['steps']): PlanEstimate | undefined {
    const history = this.deps.history?.snapshot() ?? { entries: [] };
    const canWrite = this.deps.specialistCanWrite
      ? (specialistId: string) => this.deps.specialistCanWrite!(ref.cwd, specialistId)
      : undefined;
    return estimatePlan(document, manifestSteps, history, canWrite);
  }

  private async view(ref: PlanRef, planId: string): Promise<PlanView> {
    const plan = await this.journal.get(ref, planId);
    if (!plan) throw new PlanActionRefused('This plan no longer exists.');
    return projectPlan(plan, this.now());
  }

  /**
   * Lease + transition to running in one journal write, then hand the fence
   * to the executor. `onStart` stamps fields in that same write.
   */
  private async startRun(
    ref: PlanRef, planId: string, from: JournalPlanStatus[],
    onStart: (plan: PlanRecord, replaced: { paused?: PlanRecord['paused'] }) => void,
  ): Promise<PlanView> {
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
    if (!ref) throw new PlanProposalError("Plans aren't available for this conversation.");
    // The proposal's own ending: here the plan really was not created.
    const manifest = await this.deps.resolveManifest({ sessionId: ref.sessionId, cwd: ref.cwd, document: proposal.document })
      .catch((e) => {
        if (e instanceof PlanSpecialistsNotReadyError) throw new PlanProposalError(`${e.message} The plan wasn't created.`);
        throw e;
      });
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
      // WHY no ceilingTokens/ceilingUsd/approximateLimit any more (spending
      // rework stage 1, design §1/§2, decision 34): there is no per-step
      // token budget left to sum into a worst-case ceiling, and nothing is
      // capped in advance for a route's replies to overshoot.
      // T5 (design §4): the estimate is computed here, right after the
      // manifest resolves, so a proposal's card shows it from its very
      // first write — the same moment auto-start (below) reads it.
      const rec: PlanRecord = {
        planId,
        toolUseId: proposal.toolUseId,
        document: proposal.document,
        maximumAttempts: proposal.maximumAttempts,
        maxFanOut: proposal.maxFanOut,
        usedTokens: 0,
        status: 'proposed',
        seq: 1,
        createdAt: this.now(),
        manifest,
        estimate: this.estimateFor(ref, proposal.document, manifest.steps),
        steps: allSteps(proposal.document.steps).map((s) => ({ id: s.id, status: 'pending' as const, attempts: [] })),
        fenceEpoch: 0,
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
      const key = proposal.autoStartKey;
      // Final review F3: checked and claimed with no await in between, so two
      // proposals from the same turn can't both see the key as free.
      // Design §8, decision 34 Q-6: auto-start only when the estimate is in
      // dollars and its p90 (highUsd, conservative) is under the setting.
      // Unpriced plans (T5: `estimate` has a `tokens` shape, not `highUsd`)
      // never auto-start.
      if (settings.ok && settings.underUsd > 0 && record.estimate && 'highUsd' in record.estimate && record.estimate.highUsd < settings.underUsd
        && (key === undefined || !this.autoStartedKeys.has(key))) {
        if (key !== undefined) {
          this.autoStartedKeys.add(key);
          if (this.autoStartedKeys.size > AUTO_START_KEYS_KEPT) this.autoStartedKeys.delete(this.autoStartedKeys.values().next().value!);
        }
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
    return projectPlan(record, this.now());
  }

  // ---- card actions ----

  approve(sessionId: string, planId: string): Promise<PlanActionResult> {
    return this.act('approve', async () => {
      if (!this.deps.executor) return unsupported("Running plans isn't available in this version of YouCoded.");
      const { ref, plan } = await this.loadPlan(sessionId, planId);
      this.requireStatus(plan, ['proposed']);
      // Task 14 (decision 27): a tier change re-freezes in the SAME write that
      // starts the run — never a second write that could half-apply.
      const reconciled = await this.reconcile(ref, plan);
      return { ok: true, plan: await this.startRun(ref, planId, ['proposed'], (p) => {
        p.startedAt = this.now();
        if (reconciled.kind === 'refreshed') refreeze(p, reconciled.manifest, this.estimateFor(ref, p.document, reconciled.manifest.steps));
      }) };
    });
  }

  resume(sessionId: string, planId: string): Promise<PlanActionResult> {
    return this.act('continue', async () => {
      if (!this.deps.executor) return unsupported("Running plans isn't available in this version of YouCoded.");
      const { ref, plan } = await this.loadPlan(sessionId, planId);
      this.requireStatus(plan, ['paused', 'interrupted']);
      // WHY no disabledAdapters refusal any more (spending rework stage 1,
      // design §1): there is no adapter left to disable.
      // T6: design §7 — "resume also refuses when spendLimit is set and
      // used ≥ limit, for every pause kind" — is not wired here yet.
      // Task 14 (decision 27): Destin's own case — the plan paused because a
      // specialist's provider couldn't run, he pointed his tiers at another
      // provider, and Continue is the fix. Only what a specialist can DO still
      // refuses; new models re-freeze here and run.
      const reconciled = await this.reconcile(ref, plan);
      // Review fix 4: the user's Continue resets the automatic-retry allowance
      // of the work it resumes, in the same write that takes the lease.
      // Task 9b: that write also drops the pause, and with it any handoff —
      // the user decided; its undelivered notice is withdrawn below.
      // Task 11 (review 4-2): the handoff to withdraw is read INSIDE that
      // write — an Ask can land during the drift check above, and an id read
      // before it would leave that question queued behind a running plan.
      let handoffId: string | undefined;
      const view = await this.startRun(ref, planId, ['paused', 'interrupted'], (p, replaced) => {
        handoffId = replaced.paused?.handoff?.id;
        resetRecoveriesForContinue(p);
        if (reconciled.kind === 'refreshed') refreeze(p, reconciled.manifest, this.estimateFor(ref, p.document, reconciled.manifest.steps));
      });
      this.notifySuperseded(ref, planId, handoffId);
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
      // Task 11 (review 4-2): whichever write stops the plan reads the handoff
      // it drops, so a question asked a moment earlier is still withdrawn.
      let handoffId: string | undefined;
      const markStopped = (p: PlanRecord): void => {
        handoffId = p.paused?.handoff?.id ?? handoffId;
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
        if (applied === true) {
          this.notifySuperseded(ref, planId, handoffId);
          return { ok: true, plan: await this.view(ref, planId) };
        }
      }
      // Task 9b: stopping a paused plan drops its pause and any handoff with it
      // (markStopped); "Stopping the plan withdraws its queued notice".
      await this.journal.mutate(ref, (file) => {
        const p = file.plans.find((x) => x.planId === planId);
        if (!p) throw new PlanActionRefused('This plan no longer exists.');
        this.requireStatus(p, ['proposed', 'running', 'paused', 'interrupted']);
        if (this.journal.leaseOwner(p) === 'live') throw new PlanActionRefused('This plan is running in another YouCoded window. Stop it there.');
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

  // WHY addBudget is GONE (spending rework stage 1, design §1/§6): deleted —
  // there is no Add budget authorization left to record.

  // ---- Task 9b: the assistant's side of a pause handoff ----

  private notifySuperseded(ref: PlanRef, planId: string, handoffId: string | undefined): void {
    if (handoffId === undefined) return;
    try { this.deps.handoffs?.superseded(ref, planId, handoffId); } catch (e) {
      console.error('[plan-service] could not withdraw a superseded plan notice', e);
    }
  }

  /**
   * Task 11 (pause handoff §6): the user pressed "Ask the assistant". The host
   * has already registered `handoff` in its in-memory map (so a restart
   * recovery running now keeps it — review 4-4) and checked that the
   * conversation can take a notice. Here, INSIDE the write, the plan must be
   * paused with no question already pending (review 4-3: a second press from
   * another window, the phone or a double click is refused by this check, not
   * by an earlier read), and the pending handoff is recorded in that same
   * write. Asking again after an answer replaces the old recommendation,
   * error and revision link. The host queues the notice afterwards.
   */
  askAssistant(sessionId: string, planId: string, handoff: PlanAskHandoff, question?: unknown): Promise<PlanActionResult> {
    return this.act('ask the assistant about', async () => {
      // Decision 20: the optional typed question is checked here, like a
      // Comment's text, before anything is read or written.
      const q = normalizePlanQuestion(question);
      if (!q.ok) return failure(q.error);
      const { ref } = await this.loadPlan(sessionId, planId);
      await this.journal.mutate(ref, (file) => {
        const p = file.plans.find((x) => x.planId === planId);
        if (!p) throw new PlanActionRefused('This plan no longer exists.');
        // An interrupted card has no pause to hold a handoff (review 4-1).
        if (p.status !== 'paused' || !p.paused) {
          throw new PlanActionRefused(`Only a paused plan can be asked about. This plan is ${STATUS_WORDS[p.status]}.`);
        }
        if (p.paused.handoff?.state === 'pending') throw new PlanActionRefused('The assistant is already looking into this plan.');
        p.paused.handoff = {
          id: handoff.id, state: 'pending', at: this.now(), revisionTurnId: handoff.turnId,
          ...(handoff.waiting ? { waiting: 'reply' as const } : {}),
          ...(q.question ? { question: q.question } : {}),
        };
      });
      return { ok: true, plan: await this.view(ref, planId) };
    });
  }

  /**
   * Task 11 (§6): set or clear "waiting behind a reply" on this pending
   * handoff only. `stillApplies` is re-checked inside the write (the host's
   * "has delivery started?"), so a late correction never overwrites the
   * start of delivery. Never throws.
   */
  async setHandoffWaiting(ref: PlanRef, planId: string, handoffId: string, waiting: boolean, stillApplies: () => boolean = () => true): Promise<void> {
    try {
      const read = await this.journal.get(ref, planId);
      const h0 = read?.paused?.handoff;
      if (!h0 || h0.id !== handoffId || h0.state !== 'pending' || (h0.waiting === 'reply') === waiting) return;
      await this.journal.mutate(ref, (file) => {
        const h = file.plans.find((x) => x.planId === planId)?.paused?.handoff;
        if (!h || h.id !== handoffId || h.state !== 'pending' || !stillApplies()) return;
        if (waiting) h.waiting = 'reply';
        else delete h.waiting;
      });
    } catch (e) {
      console.error('[plan-service] could not update a plan question\'s waiting state', e);
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
        // WHY no add_budget branch any more (spending rework stage 1, decision
        // 34): `action` is 'continue'|'stop' only — nothing left to size.
        if (!message) throw new PlanActionRefused('message must say briefly why.');
        if (message.length > PLAN_RECOMMENDATION_MAX_CHARS) {
          throw new PlanActionRefused(`message must be ${PLAN_RECOMMENDATION_MAX_CHARS} characters or fewer (it had ${message.length}).`);
        }
        h.state = 'answered';
        h.recommendation = { action, message };
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
  async answerHandoff(ref: PlanRef, planId: string, handoffId: string, problem?: PlanHandoffProblem): Promise<boolean> {
    let changed = false;
    try {
      await this.journal.mutate(ref, (file) => {
        const h = file.plans.find((x) => x.planId === planId)?.paused?.handoff;
        if (!h || h.id !== handoffId) return;
        if (h.state === 'pending') {
          h.state = 'answered';
          changed = true;
          // Task 11 (§6, review 4-5/4-10): a question the assistant never
          // answered because it did not start in time, or because its turn
          // failed, leaves that on the card (with Retry). An answered one
          // (a recommendation already recorded) keeps its answer instead.
          if (problem) {
            h.problem = problem.kind === 'reply-failed' && problem.detail?.trim()
              ? { kind: 'reply-failed', detail: capDetail(problem.detail) }
              : { kind: problem.kind };
          }
        }
        if (h.waiting !== undefined) { delete h.waiting; changed = true; }
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
  async clearStaleHandoffs(ref: PlanRef, isLive: (handoffId: string) => boolean): Promise<void> {
    const read = await this.journal.read(ref);
    if (read.kind !== 'valid') return;
    // Task 11 (review 4-4): `isLive` is asked again INSIDE the write below —
    // an Ask pressed right after the app opened registers its handoff before
    // its own write, so a question this process now holds is never cleared.
    const stale = (p: PlanRecord) => {
      const h = p.paused?.handoff;
      return !!h && (h.state === 'pending' || h.revisionTurnId !== undefined) && !isLive(h.id);
    };
    if (!read.file.plans.some(stale)) return;
    await this.journal.mutate(ref, (file) => {
      for (const p of file.plans) {
        if (!stale(p)) continue;
        const h = p.paused!.handoff!;
        h.state = 'answered';
        delete h.revisionTurnId;
        delete h.waiting;
      }
    });
  }

  // ---- settings ----

  async getAutoApprove(): Promise<PlanAutoApproveRead> {
    try {
      return { ok: true, underUsd: readUnderUsd(this.deps.home.readJson(PLAN_SETTINGS_FILE)) };
    } catch (e: any) {
      console.error('[plan-service] could not read the plan settings', e);
      return generalFailure(SETTINGS_READ_FAILED, e);
    }
  }

  async setAutoApprove(underUsd: unknown): Promise<PlanSettingsWriteResult> {
    if (!(typeof underUsd === 'number' && Number.isFinite(underUsd) && underUsd >= 0 && underUsd <= 1000)) {
      return failure('The limit must be a dollar amount, 0 or more and no more than $1,000 (0 turns it off).');
    }
    try {
      await this.deps.home.mutateJson(PLAN_SETTINGS_FILE, (current) => {
        const base = current && typeof current === 'object' && !Array.isArray(current) ? current as Record<string, unknown> : {};
        // WHY `autoApprove` is dropped, not kept alongside `autoStart`
        // (design §8): an old `underTokens` there must read as OFF, never as
        // a stale dollar figure a new build would misinterpret.
        delete base.autoApprove;
        return { v: 1, ...base, autoStart: { underUsd } };
      });
      return { ok: true };
    } catch (e: any) {
      console.error('[plan-service] could not save the plan settings', e);
      return generalFailure(SETTINGS_WRITE_FAILED, e);
    }
  }
}
