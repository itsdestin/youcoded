// PlanJournal — the ONLY writer of sessions/<slug>/<parentId>.plans.json
// (specialists plans, Task 2; backend design §2).
//
// A plan lives for minutes to days: proposed, approved, paused for budget,
// interrupted by a restart, resumed. This file is the single source of truth
// for all of that. Every later piece (budgets, executor, card events, IPC)
// reads and writes plans through this class, never through the file.
//
// Four guarantees, each enforced here rather than by callers:
//  1. STRICT READS. Absent, valid, broken JSON and an unknown version are four
//     different answers. A damaged file is copied aside byte-for-byte and every
//     write is refused, so a bug or a newer app version can never be "repaired"
//     by overwriting approved budgets and finished reports.
//  2. ONE CHOKEPOINT. Every write goes through `mutate`, which bumps the plan's
//     `seq` and emits exactly one card update per visibly changed plan.
//  3. FENCING. An executor may write only while it holds the current lease
//     token; a stale executor (one that lost its lease to a takeover) is
//     rejected on every write.
//  4. FINISHED WORK IS FROZEN. A committed attempt's report can never change,
//     because resume reads it back as a finished input instead of rerunning it.
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'util';
import type { NativeHome } from '../../native-home';
// nativeStoreSlug (not the CC-mirroring slug): an app-private sidecar beside
// the delegation ledger, under the same frozen native-store directory.
import { nativeStoreSlug } from '../../slug-encoding';
import type { PlanChildView, PlanStepView, PlanView } from '../../../shared/types';
import type { PlanStepV1 } from './schema';
import {
  PLAN_JOURNAL_VERSION, PlanJournalFileSchema,
  type JournalPlanStatus, type PlanAttemptRecord, type PlanEvent, type PlanJournalFile, type PlanLease,
  type PlanRecord, type PlanRef,
} from './types';

/** How long a lease stays authoritative without a heartbeat. */
const PLAN_LEASE_TTL_MS = 60_000;

/** The journal exists but cannot be trusted; nothing may be written over it. */
export class PlanJournalUnreadableError extends Error {
  constructor(readonly detail: string, readonly quarantinePath?: string) {
    super(detail);
    this.name = 'PlanJournalUnreadableError';
  }
}

/** The writer no longer holds the plan's current lease. */
export class PlanFenceError extends Error {
  constructor(planId: string) {
    super(`This plan is being run by another YouCoded window or was restarted (plan ${planId}).`);
    this.name = 'PlanFenceError';
  }
}

/** A write tried to change or remove a finished (committed) attempt. */
export class PlanJournalIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanJournalIntegrityError';
  }
}

export type JournalReadResult =
  | { kind: 'absent' }
  | { kind: 'valid'; file: PlanJournalFile }
  | { kind: 'invalid'; detail: string; quarantinePath: string };

export type LeaseResult =
  | { ok: true; fence: string; epoch: number }
  | { ok: false; reason: 'held' | 'missing' | 'wrong-status' };

export interface PlanJournalDeps {
  home: NativeHome;
  now?: () => number;
  /** This process. instanceId must be random per process (never reused). */
  identity?: { instanceId: string; pid: number };
  /** Signal-0 style probe; only consulted for an EXPIRED foreign lease. */
  isProcessAlive?: (pid: number) => boolean;
  onEvent?: (event: PlanEvent) => void;
  leaseTtlMs?: number;
}

// One identity per process, like the delegation ledger's OWNER stamp.
const PROCESS_IDENTITY = { instanceId: randomUUID(), pid: process.pid };

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type ParseResult = { ok: true; file: PlanJournalFile } | { ok: false; detail: string };

/** Pure strict parse. The wording is the real reason, shown to the user as-is. */
function parseJournal(text: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e: any) {
    return { ok: false, detail: `The saved plan file is not valid JSON (${e?.message ?? 'parse error'}).` };
  }
  const v = (json as { v?: unknown } | null)?.v;
  if (v !== PLAN_JOURNAL_VERSION) {
    return { ok: false, detail: `The saved plan file uses version ${JSON.stringify(v ?? null)}, which this version of YouCoded can't read.` };
  }
  const parsed = PlanJournalFileSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'file'}: ${i.message}`);
    return { ok: false, detail: `The saved plan file doesn't match the expected layout (${issues.join('; ')}).` };
  }
  return { ok: true, file: parsed.data };
}

/** Everything about a plan except lease bookkeeping — the part a card can see. */
function visiblePart(plan: PlanRecord): Omit<PlanRecord, 'lease' | 'fenceEpoch' | 'seq'> {
  const { lease: _lease, fenceEpoch: _epoch, seq: _seq, ...rest } = plan;
  return rest;
}

function isCommitted(attempt: PlanAttemptRecord): boolean {
  return attempt.phase === 'committed' || attempt.completedAt !== undefined;
}

/** Throws if any committed attempt in `before` is missing or altered in `after`. */
function assertCommittedUnchanged(before: PlanJournalFile, after: PlanJournalFile): void {
  for (const oldPlan of before.plans) {
    const newPlan = after.plans.find((p) => p.planId === oldPlan.planId);
    for (const oldStep of oldPlan.steps) {
      for (const oldAttempt of oldStep.attempts) {
        if (!isCommitted(oldAttempt)) continue;
        const newAttempt = newPlan?.steps.find((s) => s.id === oldStep.id)?.attempts.find((a) => a.attemptId === oldAttempt.attemptId);
        if (!newAttempt || !isDeepStrictEqual(newAttempt, oldAttempt)) {
          throw new PlanJournalIntegrityError(
            `Finished work in step "${oldStep.id}" can't be changed (plan ${oldPlan.planId}, attempt ${oldAttempt.attemptId}).`,
          );
        }
      }
    }
  }
}

interface AppliedMutation<T> {
  draft: PlanJournalFile;
  result: T;
  changed: PlanRecord[];
  /** False when the draft equals what was read — nothing to write or emit. */
  write: boolean;
}

function emptyJournal(): PlanJournalFile {
  return { v: PLAN_JOURNAL_VERSION, plans: [] };
}

/**
 * Run one mutation on a private copy of `before`: bump seq on every visibly
 * changed plan, refuse changes to finished attempts, and re-validate the
 * result (a caller bug must fail here, not produce a file the next read would
 * quarantine). Pure apart from whatever `fn` itself does.
 */
function applyMutation<T>(before: PlanJournalFile, fn: (file: PlanJournalFile) => T): AppliedMutation<T> {
  const draft = structuredClone(before);
  const result = fn(draft);
  const changed: PlanRecord[] = [];
  for (const plan of draft.plans) {
    const old = before.plans.find((p) => p.planId === plan.planId);
    if (!old || !isDeepStrictEqual(visiblePart(old), visiblePart(plan))) {
      plan.seq = (old?.seq ?? 0) + 1;
      changed.push(plan);
    } else {
      plan.seq = old.seq;
    }
  }
  assertCommittedUnchanged(before, draft);
  const checked = PlanJournalFileSchema.safeParse(draft);
  if (!checked.success) {
    throw new PlanJournalIntegrityError(`Refused to save an invalid plan record: ${checked.error.issues[0]?.message ?? 'unknown issue'}`);
  }
  return { draft, result, changed, write: !isDeepStrictEqual(before, draft) };
}

const STEP_TITLE_MAX_CHARS = 80;

function stepTitle(task: string): string {
  const firstLine = task.trim().split('\n')[0].trim();
  return firstLine.length > STEP_TITLE_MAX_CHARS ? `${firstLine.slice(0, STEP_TITLE_MAX_CHARS - 1)}…` : firstLine;
}

/** One plan specialist as the card's row shows it. A finished attempt says how
 *  it ended; an unfinished one is `running` only while this plan is actually
 *  being advanced (it holds a lease), otherwise `interrupted`. */
function childView(plan: PlanRecord, step: PlanStepV1, stepStatus: string, a: PlanAttemptRecord): PlanChildView {
  const binding = plan.manifest.specialists[step.specialist]?.binding;
  const done = isCommitted(a);
  const status: PlanChildView['status'] = done
    ? (a.terminal === 'completed' ? 'completed' : a.terminal === 'failed' ? 'failed' : 'interrupted')
    : (plan.status === 'running' && plan.lease && stepStatus === 'running' ? 'running' : 'interrupted');
  const view: PlanChildView = {
    childId: a.childId!,
    parentToolCallId: plan.toolUseId,
    agentType: step.specialist,
    title: a.childTitle ?? step.specialist,
    background: false,
    status,
    startedAt: a.startedAt ?? plan.startedAt ?? plan.createdAt,
    planAttempt: { stepId: step.id, attemptId: a.attemptId, itemIndex: a.itemIndex, iteration: a.iteration },
  };
  if (a.completedAt !== undefined) view.endedAt = a.completedAt;
  if (binding) view.model = { label: binding.modelId };
  if (a.brief !== undefined) view.prompt = a.brief;
  if (done && a.reportText !== undefined) {
    view.report = { text: a.reportText, status: a.terminal === 'completed' ? 'completed' : 'failed', timestamp: a.completedAt ?? 0 };
  }
  return view;
}

/**
 * The renderer's view of one journal record. The ONLY place a PlanView is
 * built from durable state — the renderer never invents lifecycle states.
 *
 * WHY repeat bodies are flattened into rows: the card prices each row as
 * `budgetTokens × fanOut`, and a repeat body with several differently-budgeted
 * steps has no single honest pair of numbers. Each body step becomes its own
 * row with its fan-out multiplied by max_iterations, so the rows still add up
 * to exactly the approved ceiling. Every such row is labelled `repeat`
 * ("repeats until done"), never with the inner step's own kind: a 3-item map
 * inside a 5-iteration repeat is 15 specialists over time, and "at the same
 * time" would misdescribe what will happen.
 */
export function projectPlan(plan: PlanRecord): PlanView {
  const rows: PlanStepView[] = [];
  const row = (step: PlanStepV1, kind: PlanStepView['kind'], multiplier: number): void => {
    const rec = plan.steps.find((s) => s.id === step.id);
    const attempts = rec?.attempts ?? [];
    const out: PlanStepView = {
      id: step.id,
      kind,
      title: stepTitle(step.task),
      specialist: step.specialist,
      fanOut: (step.kind === 'map' ? step.items!.length : 1) * multiplier,
      budgetTokens: step.budget_tokens,
      setupTokens: plan.manifest.specialists[step.specialist]?.setupTokens ?? 0,
      status: rec?.status ?? 'pending',
    };
    if (attempts.length > 0) {
      out.done = attempts.filter((a) => isCommitted(a) && a.terminal === 'completed').length;
      out.usedTokens = attempts.reduce((n, a) => n + a.spentTokens, 0);
      // Task 4 review item 6: one row per specialist this step launched, from
      // durable state (the renderer adds the live activity to it).
      const children = attempts.filter((a) => a.childId).map((a) => childView(plan, step, rec!.status, a));
      if (children.length > 0) out.children = children;
    }
    rows.push(out);
  };
  for (const step of plan.document.steps) {
    if (step.kind !== 'repeat') {
      row(step, step.kind, 1);
      continue;
    }
    for (const inner of step.steps!) row(inner, 'repeat', step.max_iterations!);
  }

  const view: PlanView = {
    planId: plan.planId,
    toolUseId: plan.toolUseId,
    title: plan.document.goal,
    status: plan.status,
    steps: rows,
    ceilingTokens: plan.ceilingTokens,
    ceilingUsd: plan.ceilingUsd,
    model: { label: plan.manifest.modelLabel },
    usedTokens: plan.usedTokens,
    seq: plan.seq,
  };
  if (plan.usedUsd !== undefined) view.usedUsd = plan.usedUsd;
  if (plan.autoApproved) view.autoApproved = true;
  // Only the card's two fields: the attempt id is executor bookkeeping.
  if (plan.paused) {
    view.paused = { stepId: plan.paused.stepId, reason: plan.paused.reason };
    if (plan.paused.minimumAddTokens !== undefined) view.paused.minimumAddTokens = plan.paused.minimumAddTokens;
  }
  if (plan.revisionOf) view.revisionOf = plan.revisionOf;
  if (plan.revisedBy) view.revisedBy = plan.revisedBy;
  if (plan.startedAt !== undefined) view.startedAt = plan.startedAt;
  if (plan.endedAt !== undefined) view.endedAt = plan.endedAt;
  // Decision 5: the record's own flag, or any frozen specialist on a soft route.
  if (plan.approximateLimit || Object.values(plan.manifest.specialists).some((s) => s.approximateLimit)) {
    view.approximateLimit = true;
  }
  if (plan.failure) view.failure = { detail: plan.failure.detail };
  return view;
}

/**
 * A damaged journal still owns cards in the transcript. WHY salvage tool ids
 * with a pattern rather than showing nothing: a card whose plan silently
 * vanished looks like it is still waiting. Each recoverable card id is shown
 * as failed instead; the real reason is returned by every action attempted
 * on it.
 */
function salvagedFailedViews(raw: string, detail: string): PlanView[] {
  const views: PlanView[] = [];
  const seen = new Set<string>();
  const matches = [...raw.matchAll(/"toolUseId"\s*:\s*"((?:[^"\\]|\\.){1,200})"/g)];
  matches.forEach((match, i) => {
    let toolUseId: string;
    try {
      toolUseId = JSON.parse(`"${match[1]}"`);
    } catch {
      return; // an escape we can't decode can't name a real card
    }
    if (seen.has(toolUseId)) return;
    seen.add(toolUseId);
    // WHY the record's own seq: the reducer drops a push whose seq is LOWER
    // than the card's. Reusing the damaged record's last seq lets this failed
    // state replace the stale card now, and lets a repaired journal (same or
    // higher seq) replace it later. A never-superseded MAX_SAFE_INTEGER would
    // pin the card as failed forever. No recoverable seq → 0.
    //
    // TASK 4 OBLIGATION: a seq-0 salvaged card LOSES to any higher seq the
    // renderer already holds (the reducer keeps the higher live seq), so a
    // card that was running would keep saying "running". A running executor
    // that hits PlanJournalUnreadableError must therefore push its own failed
    // view with seq = (last seq it knows from memory) + 1.
    const segmentEnd = matches[i + 1]?.index ?? raw.length;
    const seqMatch = /"seq"\s*:\s*(\d{1,15})\b/.exec(raw.slice(match.index, segmentEnd));
    views.push({
      planId: `unreadable:${toolUseId}`,
      toolUseId,
      // Empty so the card's own fallback wording applies (not "Plan: a plan").
      title: '',
      status: 'failed',
      steps: [],
      ceilingTokens: 0,
      ceilingUsd: null,
      model: { label: 'Unknown model' },
      seq: seqMatch ? Number(seqMatch[1]) : 0,
      // Decision 6: the strict reader's own reason, verbatim — never a guess.
      failure: { detail },
    });
  });
  return views;
}

export class PlanJournal {
  private readonly home: NativeHome;
  private readonly now: () => number;
  private readonly identity: { instanceId: string; pid: number };
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly onEvent?: (event: PlanEvent) => void;
  private readonly leaseTtlMs: number;

  constructor(deps: PlanJournalDeps) {
    this.home = deps.home;
    this.now = deps.now ?? Date.now;
    this.identity = deps.identity ?? PROCESS_IDENTITY;
    this.isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
    this.onEvent = deps.onEvent;
    this.leaseTtlMs = deps.leaseTtlMs ?? PLAN_LEASE_TTL_MS;
  }

  relPath(ref: PlanRef): string {
    return path.join('sessions', nativeStoreSlug(ref.cwd), `${ref.sessionId}.plans.json`);
  }

  /** Copy the damaged bytes aside once (content-addressed, never overwritten). */
  private async quarantine(ref: PlanRef): Promise<string> {
    const rel = this.relPath(ref);
    const bytes = this.home.readRawBytes(rel) ?? Buffer.alloc(0);
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    const quarantineRel = `${rel}.quarantine-${digest}`;
    await this.home.createFileExclusive(quarantineRel, bytes);
    return path.join(this.home.root, quarantineRel);
  }

  async read(ref: PlanRef): Promise<JournalReadResult> {
    const bytes = this.home.readRawBytes(this.relPath(ref));
    if (bytes === null) return { kind: 'absent' };
    const parsed = parseJournal(bytes.toString('utf8'));
    if (parsed.ok) return { kind: 'valid', file: parsed.file };
    return { kind: 'invalid', detail: parsed.detail, quarantinePath: await this.quarantine(ref) };
  }

  /** Throws PlanJournalUnreadableError for a damaged journal. */
  private async readValid(ref: PlanRef): Promise<PlanJournalFile> {
    const result = await this.read(ref);
    if (result.kind === 'invalid') throw new PlanJournalUnreadableError(result.detail, result.quarantinePath);
    return result.kind === 'valid' ? result.file : { v: PLAN_JOURNAL_VERSION, plans: [] };
  }

  /** Current card projections, for hydration/replay. Never throws for damage. */
  async list(ref: PlanRef): Promise<PlanView[]> {
    const result = await this.read(ref);
    if (result.kind === 'absent') return [];
    if (result.kind === 'valid') return result.file.plans.map(projectPlan);
    return salvagedFailedViews(this.home.readRawBytes(this.relPath(ref))?.toString('utf8') ?? '', result.detail);
  }

  async get(ref: PlanRef, planId: string): Promise<PlanRecord | undefined> {
    return (await this.readValid(ref)).plans.find((p) => p.planId === planId);
  }

  async pendingRevision(ref: PlanRef): Promise<PlanJournalFile['pendingRevision']> {
    return (await this.readValid(ref)).pendingRevision;
  }

  /**
   * THE chokepoint. `fn` edits a private copy of the file; throwing aborts
   * with nothing written. Afterwards, under the same lock: the result is
   * re-validated, finished attempts are checked unchanged, and each plan
   * whose visible part changed gets seq+1. After the write lands, one event
   * per changed plan is emitted. Lease-only changes (heartbeat, release) are
   * written but not emitted — the card has nothing new to show.
   */
  async mutate<T>(ref: PlanRef, fn: (file: PlanJournalFile) => T): Promise<T> {
    const rel = this.relPath(ref);
    // WHY a dry run for an absent journal: the lock step creates the parent
    // folder before the callback runs, and NativeHome never removes folders
    // (another writer may be waiting on a lock inside one). So a write that
    // would change nothing — or would throw — must not reach the lock at all,
    // or merely checking a plan-less conversation would leave an empty folder.
    let precomputed: AppliedMutation<T> | undefined;
    if (this.home.readRawBytes(rel) === null) {
      precomputed = applyMutation(emptyJournal(), fn); // a throw propagates; disk untouched
      if (!precomputed.write) return precomputed.result;
    }
    let applied!: AppliedMutation<T>;
    try {
      await this.home.mutateText(rel, (onDisk) => {
        if (onDisk === null && precomputed) {
          // Still absent under the lock: write the dry run's result instead of
          // calling fn again (fn may hold one-shot latches, e.g. propose's commit()).
          applied = precomputed;
        } else {
          let before: PlanJournalFile;
          if (onDisk === null) {
            before = emptyJournal();
          } else {
            const parsed = parseJournal(onDisk);
            if (!parsed.ok) throw new PlanJournalUnreadableError(parsed.detail);
            before = parsed.file;
          }
          applied = applyMutation(before, fn);
        }
        return applied.write ? JSON.stringify(applied.draft, null, 2) : null;
      });
    } catch (e) {
      if (e instanceof PlanJournalUnreadableError) throw new PlanJournalUnreadableError(e.detail, await this.quarantine(ref));
      throw e;
    }
    for (const plan of applied.changed) this.emit(ref, plan);
    return applied.result;
  }

  private emit(ref: PlanRef, plan: PlanRecord): void {
    if (!this.onEvent) return;
    try {
      this.onEvent({ sessionId: ref.sessionId, plan: projectPlan(plan) });
    } catch (e) {
      // The write already landed; a listener failure must not make it look failed.
      console.error('[plan-journal] event listener threw', e);
    }
  }

  /** Who holds this plan's lease, for callers deciding whether they may act. */
  leaseOwner(plan: PlanRecord): 'none' | 'self' | 'live' | 'dead' {
    return plan.lease ? this.ownerState(plan.lease) : 'none';
  }

  private ownerState(lease: PlanLease): 'self' | 'live' | 'dead' {
    if (lease.instanceId === this.identity.instanceId) return 'self';
    // Our own pid under a different instance id can only be an earlier process
    // whose pid the OS gave back to us — that owner is certainly gone.
    if (lease.pid === this.identity.pid) return 'dead';
    // Takeover needs BOTH expiry and a failed liveness probe (design §2).
    if (this.now() < lease.expiresAt) return 'live';
    return this.isProcessAlive(lease.pid) ? 'live' : 'dead';
  }

  /**
   * Compare-and-swap lease acquisition. With `startFrom`, the plan must be in
   * one of those states and becomes `running` in the SAME write — so there is
   * never a running plan without an owner (which recovery would interrupt).
   * Without it, the plan must already be running (executor restart/takeover).
   * `force` is only for an explicit user-forced recovery.
   */
  async acquireLease(
    ref: PlanRef,
    planId: string,
    opts: { startFrom?: JournalPlanStatus[]; force?: boolean; onStart?: (plan: PlanRecord) => void } = {},
  ): Promise<LeaseResult> {
    return this.mutate<LeaseResult>(ref, (file) => {
      const plan = file.plans.find((p) => p.planId === planId);
      if (!plan) return { ok: false, reason: 'missing' };
      const allowed = opts.startFrom ?? ['running'];
      if (!allowed.includes(plan.status)) return { ok: false, reason: 'wrong-status' };
      if (plan.lease && !opts.force && this.ownerState(plan.lease) !== 'dead') return { ok: false, reason: 'held' };
      const now = this.now();
      const epoch = plan.fenceEpoch + 1;
      const fence = `${epoch}:${randomUUID()}`;
      plan.fenceEpoch = epoch;
      plan.lease = {
        instanceId: this.identity.instanceId, pid: this.identity.pid,
        heartbeatAt: now, expiresAt: now + this.leaseTtlMs, epoch, fence,
      };
      if (plan.status !== 'running') {
        plan.status = 'running';
        delete plan.paused;
      }
      opts.onStart?.(plan);
      return { ok: true, fence, epoch };
    });
  }

  private requireFence(file: PlanJournalFile, planId: string, fence: string): PlanRecord {
    const plan = file.plans.find((p) => p.planId === planId);
    if (!plan || !plan.lease || plan.lease.fence !== fence) throw new PlanFenceError(planId);
    return plan;
  }

  /**
   * Every executor write goes through here: reservation, launch, phase change,
   * completion, budget. The fence is checked under the same lock as the write.
   */
  async mutateFenced<T>(ref: PlanRef, planId: string, fence: string, fn: (plan: PlanRecord, file: PlanJournalFile) => T): Promise<T> {
    return this.mutate(ref, (file) => fn(this.requireFence(file, planId, fence), file));
  }

  async heartbeat(ref: PlanRef, planId: string, fence: string): Promise<void> {
    await this.mutateFenced(ref, planId, fence, (plan) => {
      const now = this.now();
      plan.lease = { ...plan.lease!, heartbeatAt: now, expiresAt: now + this.leaseTtlMs };
    });
  }

  /** Give the lease up (fenced). fenceEpoch is kept so the next one is larger. */
  async releaseLease(ref: PlanRef, planId: string, fence: string): Promise<void> {
    await this.mutateFenced(ref, planId, fence, (plan) => {
      delete plan.lease;
    });
  }

  /**
   * Freeze one attempt's outcome. After this the attempt is immutable (the
   * chokepoint enforces it), its reservation is released, and resume reads
   * this report instead of rerunning the specialist.
   */
  async commitAttempt(
    ref: PlanRef,
    planId: string,
    fence: string,
    stepId: string,
    attemptId: string,
    outcome: { terminal: 'completed' | 'failed' | 'stopped'; reportText?: string; reportPath?: string; spentTokens: number },
  ): Promise<void> {
    await this.mutateFenced(ref, planId, fence, (plan) => {
      const attempt = plan.steps.find((s) => s.id === stepId)?.attempts.find((a) => a.attemptId === attemptId);
      if (!attempt) throw new PlanJournalIntegrityError(`No attempt ${attemptId} in step "${stepId}" (plan ${planId}).`);
      if (isCommitted(attempt)) {
        throw new PlanJournalIntegrityError(`Finished work in step "${stepId}" can't be changed (plan ${planId}, attempt ${attemptId}).`);
      }
      attempt.phase = 'committed';
      attempt.terminal = outcome.terminal;
      if (outcome.reportText !== undefined) attempt.reportText = outcome.reportText;
      if (outcome.reportPath !== undefined) attempt.reportPath = outcome.reportPath;
      plan.usedTokens += outcome.spentTokens - attempt.spentTokens;
      attempt.spentTokens = outcome.spentTokens;
      attempt.reservedTokens = 0;
      attempt.completedAt = this.now();
    });
  }

  /**
   * Startup/resume pass: a `running` plan with no valid owner becomes
   * `interrupted`, its lease is dropped and its running steps show paused.
   * Nothing restarts until the user presses Continue. A live foreign owner
   * (another window still working) is left alone.
   *
   * HOST OBLIGATION (`recheckAt`): a foreign lease that has not expired yet
   * is treated as live even if its process is gone — after a crash and a
   * quick relaunch that is exactly the case, and the card would otherwise
   * say "running" with nothing behind it. When this returns `recheckAt`, the
   * host MUST call recoverInterrupted again at (or after) that time — the
   * earliest skipped foreign expiry — and keep doing so while it returns a
   * new one. At that point the liveness probe decides. (Expired leases whose
   * process still answers are not re-scheduled: their owner is alive and
   * responsible for heartbeating or releasing.)
   */
  async recoverInterrupted(
    ref: PlanRef,
    // Task 4: applied to each plan this pass interrupts, INSIDE the same write,
    // so an interrupted plan is never visible while it still holds budget
    // (the host passes PlanBudget.releaseOwnerlessHolds).
    opts: { onInterrupt?: (plan: PlanRecord) => void } = {},
  ): Promise<{ interrupted: string[]; recheckAt?: number }> {
    // WHY the read first: opening a conversation that never had a plan must
    // not create a plan directory (the lock step creates parents).
    const current = await this.read(ref);
    if (current.kind === 'absent') return { interrupted: [] };
    if (current.kind === 'invalid') throw new PlanJournalUnreadableError(current.detail, current.quarantinePath);
    return this.mutate(ref, (file) => {
      const interrupted: string[] = [];
      let recheckAt: number | undefined;
      const now = this.now();
      for (const plan of file.plans) {
        if (plan.status !== 'running') continue;
        if (plan.lease) {
          const owner = this.ownerState(plan.lease);
          if (owner === 'self') continue;
          if (owner === 'live') {
            if (plan.lease.expiresAt > now) recheckAt = Math.min(recheckAt ?? Infinity, plan.lease.expiresAt);
            continue;
          }
        }
        plan.status = 'interrupted';
        delete plan.lease;
        for (const step of plan.steps) if (step.status === 'running') step.status = 'paused';
        opts.onInterrupt?.(plan);
        interrupted.push(plan.planId);
      }
      return recheckAt === undefined ? { interrupted } : { interrupted, recheckAt };
    });
  }
}
