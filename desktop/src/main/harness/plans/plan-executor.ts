// PlanExecutor — runs an approved plan (specialists plans, Task 4; backend
// design §3). It is the only thing that launches a plan's specialists.
//
// What it guarantees, and why each matters to the person using the app:
//  - ORDER. Steps run in the order the card shows. A step starts only after
//    every result it reads is safely on disk, so a crash can never leave a
//    later step working from a result that was lost.
//  - WAVES. A map step's specialists run at most `cap` (≤ 4) at a time, and
//    write-capable specialists one at a time, so two of them never edit the
//    same files at once.
//  - HARD BUDGETS. Before any specialist starts, its whole allowance is
//    reserved in the journal (plan-budget.ts). Nothing is ever sent without it.
//  - SETTLE BEFORE VISIBLE. When something goes wrong (a failure, a budget
//    stop, the user pressing Stop, the app closing), every running specialist
//    is stopped and given a short, fixed time to finish; anything still going
//    after that is torn down. Unknown spending is charged in full, every
//    reservation is given back, the lease is dropped — and only THEN does the
//    card change. A paused plan therefore costs nothing while it waits.
//  - NO SILENT REPLAY. Resume reads finished results from disk and never
//    reruns a finished step. A specialist whose last request or action has an
//    unknown outcome pauses the plan and is only picked up again after the
//    user has been told and pressed Continue.
//
// Host-agnostic on purpose: the host (native-session-host.ts) supplies a
// PlanRunner that turns "launch this attempt" into a real specialist session.
import { z } from 'zod';
import type { PlanStepV1 } from './schema';
import { PlanFenceError, PlanJournalUnreadableError, type PlanJournal } from './plan-journal';
import type { PlanBudget, ReserveMember } from './plan-budget';
import type { PlanChildStop } from './budget-adapter';
import type { PlanPauseKind } from '../../../shared/types';
import type { PlanExecutorHooks } from './plan-service';
import type { PlanAttemptRecord, PlanRecord, PlanRef, PlanStepRecord } from './types';
import type { TranscriptEvent } from '../../../shared/types';

/** Well inside the journal's 60 s lease, so a slow disk never lets it lapse. */
export const PLAN_HEARTBEAT_MS = 20_000;
/** How long stopped specialists get to finish on their own before teardown. */
export const PLAN_SETTLE_DEADLINE_MS = 10_000;
/** The hard product maximum of simultaneous specialists (global constraints). */
export const PLAN_MAX_CONCURRENT_SPECIALISTS = 4;
/** One dependency report handed to a verify/combine specialist, at most. */
export const PLAN_DEPENDENCY_REPORT_MAX_CHARS = 6_000;
/** All dependency reports in one brief, together, at most. */
export const PLAN_DEPENDENCY_TOTAL_MAX_CHARS = 24_000;
/** The fresh turn a safely restarted specialist receives (its own transcript
 *  already holds the original brief and everything it did). */
export const PLAN_RESTART_BRIEF =
  'You were interrupted before you finished. Continue the same task from where your work above ends, '
  + 'and finish with your report.';

/**
 * The fresh turn for a restarted specialist, given what its transcript proves
 * (review item 4). WHY name the tool: after the user pressed Continue on an
 * unclear action, the specialist must learn that the action may already have
 * happened, and check before doing it again — otherwise "continue" invites a
 * blind repeat (a second commit, a second file write).
 */
export function planRestartBrief(verdict: TranscriptVerdict): string {
  if (verdict.kind !== 'dangling-effect') return PLAN_RESTART_BRIEF;
  return `You were interrupted before you finished. Your last ${verdict.tool} call has no recorded result, so it may or may `
    + `not have taken effect. Check the current state before repeating it. Then continue the same task from where your `
    + 'work above ends, and finish with your report.';
}

// ---- the runner contract (implemented by the host) ----

export interface PlanChildLaunch {
  ref: PlanRef;
  planId: string;
  fence: string;
  stepId: string;
  attemptId: string;
  itemIndex: number;
  iteration: number;
  specialist: string;
  /** The first user turn this launch sends. */
  brief: string;
  /** Restart: rebuild this existing specialist session from its transcript. */
  resumeChildId?: string;
  /** Cancels a launch still waiting for a free specialist slot. */
  signal: AbortSignal;
  /** Must be awaited after the session exists and BEFORE anything is sent, so
   *  the journal always knows which session an attempt's spending belongs to. */
  recordChild(childId: string, info?: { title?: string }): Promise<void>;
}

export type PlanChildOutcome =
  | { kind: 'completed'; report: string }
  /** The plan's request gate stopped the specialist (plan-budget / adapter). */
  | { kind: 'stopped'; stop: PlanChildStop }
  | { kind: 'failed'; detail: string }
  | { kind: 'interrupted' };

export interface PlanChildHandle {
  childId: string;
  /** Resolves once the specialist's turn has ended. Never rejects. */
  outcome: Promise<PlanChildOutcome>;
  /** Stop the current turn (cooperative). */
  abort(): void;
  /** Tear the specialist down and free its slot. Idempotent; bounded. After it
   *  resolves `outcome` resolves too (as interrupted if nothing else). */
  dispose(): Promise<void>;
}

/** What a specialist's own transcript proves about an unfinished attempt. */
export type TranscriptVerdict =
  /** Its last turn finished with a report — commit it without a request. */
  | { kind: 'terminal'; report: string }
  /** A side-effecting tool call has no recorded result — outcome unknown. */
  | { kind: 'dangling-effect'; tool: string }
  /** Nothing is proven; restarting is safe. `briefDelivered` says whether its
   *  transcript already contains the brief. */
  | { kind: 'resumable'; briefDelivered: boolean };

export interface PlanRunner {
  /** The parent's resolved concurrent-specialist count (clamped to 4 here). */
  maxConcurrent(ref: PlanRef): number;
  isWriter(ref: PlanRef, specialist: string): boolean;
  /** The shared local-engine context pool, when any specialist in `plan` is local. */
  localPoolTokens(ref: PlanRef, plan: PlanRecord): Promise<number | undefined>;
  /** Mint (or rebuild) the specialist and send its turn. Throws with the real
   *  reason when it cannot start. */
  launch(input: PlanChildLaunch): Promise<PlanChildHandle>;
  inspectTranscript(ref: PlanRef, childId: string): TranscriptVerdict;
  /** The journal became unreadable mid-run: show a failed card (seq = last + 1). */
  onUnreadable(ref: PlanRef, planId: string, detail: string): void;
  /** The smallest Add budget that lets this paused attempt send its next
   *  request (its fresh resume prompt, plus any soft-limit overshoot), or
   *  undefined when it can't be worked out. */
  minimumAddTokens?(ref: PlanRef, plan: PlanRecord, attemptId: string): Promise<number | undefined>;
  /** Why `specialist` cannot run right now (no budget adapter for its route,
   *  or that adapter was switched off), or undefined. Asked BEFORE its wave is
   *  reserved, so a refusal never holds any budget (Task 3 obligation). */
  launchRefusal?(ref: PlanRef, plan: PlanRecord, specialist: string): Promise<string | undefined>;
}

/** Tools whose call changes nothing outside the conversation. A call to any
 *  OTHER tool (Bash, Write, Edit, …) with no recorded result may already have
 *  done its work, so it is never silently repeated. Unknown names count as
 *  side-effecting — the safe direction. */
export const PLAN_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'TodoWrite', 'ModelSearch', 'BashOutput', 'AskUserQuestion',
]);

/** The turn-complete stopReason a plan specialist ends with when its budget
 *  runs out (harness-session.ts) — not a finished report. */
const PLAN_BUDGET_EXHAUSTED_STOP_REASON = 'plan_budget_exhausted';

/**
 * Read a plan specialist's own transcript (design §3 resume): what does it
 * PROVE about an attempt whose journal phase never reached committed?
 * Only the latest user turn can hold the finished report — an earlier turn
 * that ended on a budget stop was followed by a restart turn.
 */
export function classifyChildTranscript(events: readonly TranscriptEvent[]): TranscriptVerdict {
  let lastUser = -1;
  events.forEach((e, i) => { if (e.type === 'user-message') lastUser = i; });
  if (lastUser < 0) return { kind: 'resumable', briefDelivered: false };
  const tail = events.slice(lastUser + 1);
  // Review item 3, in this order:
  //  1. A finished report in the latest turn wins — the work is done, and
  //     re-running a side-effecting task because of an OLDER dangling call
  //     would do it twice.
  //  2. Only calls AFTER the latest user turn can still be unexplained: an
  //     earlier dangling call was already shown to the user, who pressed
  //     Continue, and the restart turn told the specialist to check it.
  const endIndex = tail.findIndex((e) => e.type === 'turn-complete' || e.type === 'session-error' || e.type === 'user-interrupt');
  const end = endIndex >= 0 ? tail[endIndex] : undefined;
  if (end?.type === 'turn-complete' && end.data.stopReason !== PLAN_BUDGET_EXHAUSTED_STOP_REASON) {
    let report = '';
    for (const e of tail.slice(0, endIndex)) {
      if (e.type === 'tool-use') report = '';
      else if (e.type === 'assistant-text') report += String(e.data.text ?? '');
    }
    if (report.trim()) return { kind: 'terminal', report: report.trim() };
  }
  const answered = new Set(tail.filter((e) => e.type === 'tool-result').map((e) => e.data.toolUseId));
  for (const e of tail) {
    if (e.type !== 'tool-use' || answered.has(e.data.toolUseId)) continue;
    const tool = e.data.toolName ?? 'an unknown tool';
    if (!PLAN_READ_ONLY_TOOLS.has(tool)) return { kind: 'dangling-effect', tool };
  }
  return { kind: 'resumable', briefDelivered: true };
}

export interface PlanExecutorTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface PlanExecutorDeps {
  journal: PlanJournal;
  budget: PlanBudget;
  runner: PlanRunner;
  settleDeadlineMs?: number;
  heartbeatMs?: number;
  timers?: PlanExecutorTimers;
}

// ---- repeat decisions ----

const RepeatDecisionSchema = z.object({ report: z.string(), repeatSatisfied: z.boolean() }).strict();

/** Parse a repeat's final-leaf report. The text may be the bare JSON object or
 *  wrap it in a code fence; anything else is refused with the real reason. */
export function parseRepeatDecision(text: string): { ok: true; report: string; satisfied: boolean } | { ok: false; detail: string } {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced) candidates.push(fenced[1].trim());
  const brace = trimmed.lastIndexOf('{');
  if (brace > 0) candidates.push(trimmed.slice(trimmed.indexOf('{')));
  let lastIssue = 'it was not a JSON object';
  for (const candidate of candidates) {
    let json: unknown;
    try { json = JSON.parse(candidate); } catch { continue; }
    const parsed = RepeatDecisionSchema.safeParse(json);
    if (parsed.success) return { ok: true, report: parsed.data.report, satisfied: parsed.data.repeatSatisfied };
    lastIssue = parsed.error.issues.map((i) => `${i.path.join('.') || 'object'}: ${i.message}`).join('; ');
  }
  return { ok: false, detail: `its answer must be {"report": text, "repeatSatisfied": true or false}, but ${lastIssue}` };
}

// ---- helpers ----

type HaltRequest =
  | { kind: 'complete' }
  /** minimumAddTokens: known up front (a ceiling shortfall, review item 1). */
  /** why/tool/repeat (5b follow-up): the facts the card words the pause
   *  from, so it never has to read `reason`. Every pause names its `why`. */
  | {
    kind: 'pause'; why: PlanPauseKind; stepId: string; reason: string; attemptId?: string;
    minimumAddTokens?: number; ceilingShortfall?: true; tool?: string; repeat?: { rounds: number; until: string };
  }
  /** finalize: PlanService's "stopped" edit, applied in the SAME write that
   *  drops the lease (review item 8). */
  | { kind: 'stop'; finalize?: (plan: PlanRecord) => void; applied?: boolean }
  | { kind: 'interrupt' }
  /** The lease is gone (or the journal is unreadable): write nothing more. */
  | { kind: 'lost' };

interface LiveChild {
  stepId: string;
  attemptId: string;
  handle: PlanChildHandle;
  outcome?: PlanChildOutcome;
  /** The completion write for this child, once started. */
  commit?: Promise<void>;
  /** Report to commit (already validated for a repeat decision). */
  finalLeaf: boolean;
}

interface ActiveRun {
  key: string;
  ref: PlanRef;
  planId: string;
  fence: string;
  halt?: HaltRequest;
  haltSignal: Promise<void>;
  fireHalt: () => void;
  launchAbort: AbortController;
  live: LiveChild[];
  heartbeat?: unknown;
  done: Promise<void>;
}

const isCommitted = (a: PlanAttemptRecord) => a.phase === 'committed' || a.completedAt !== undefined;
const fmtItem = (n: number, of: number) => `${n + 1} of ${of}`;

function allSteps(steps: PlanStepV1[]): PlanStepV1[] {
  return steps.flatMap((s) => (s.kind === 'repeat' ? [s, ...allSteps(s.steps!)] : [s]));
}

/** Is `stepId` the last body step of a repeat (the step that decides)? */
function isFinalLeaf(steps: PlanStepV1[], stepId: string): boolean {
  return steps.some((s) => s.kind === 'repeat' && s.steps![s.steps!.length - 1].id === stepId);
}

function itemCount(step: PlanStepV1): number {
  return step.kind === 'map' ? step.items!.length : 1;
}

/** The newest attempt for one item of one iteration (later attempts only exist
 *  after an earlier one was committed as failed). */
function latestAttempt(rec: PlanStepRecord, itemIndex: number, iteration: number): PlanAttemptRecord | undefined {
  const matching = rec.attempts.filter((a) => a.itemIndex === itemIndex && a.iteration === iteration);
  return matching[matching.length - 1];
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[… shortened: ${text.length - max} more characters not shown]`;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The sentence a pause adds about siblings it had to cut off mid-request. */
function cutOffNote(cut: Array<{ stepId: string }>): string {
  if (cut.length === 0) return '';
  const steps = [...new Set(cut.map((c) => `"${c.stepId}"`))].join(', ');
  const one = cut.length === 1;
  const who = one ? `1 other specialist in step ${steps} was` : `${cut.length} other specialists in step${steps.includes(',') ? 's' : ''} ${steps} were`;
  return `${who} cut off mid-request, and it isn't known whether ${one ? 'that request' : 'those requests'} finished; `
    + `Continue lets ${one ? 'it' : 'them'} pick up from what ${one ? 'it' : 'they'} recorded.`;
}

/** Join the pause's own reason and the cut-off note as two sentences. */
function withCutOffNote(reason: string, cut: Array<{ stepId: string }>): string {
  const note = cutOffNote(cut);
  if (!note) return reason;
  return `${/[.!?]$/.test(reason.trim()) ? reason.trim() : `${reason.trim()}.`} ${note}`;
}

export class PlanExecutor implements PlanExecutorHooks {
  private readonly journal: PlanJournal;
  private readonly budget: PlanBudget;
  private readonly runner: PlanRunner;
  private readonly settleDeadlineMs: number;
  private readonly heartbeatMs: number;
  private readonly timers: PlanExecutorTimers;
  private readonly runs = new Map<string, ActiveRun>();

  constructor(deps: PlanExecutorDeps) {
    this.journal = deps.journal;
    this.budget = deps.budget;
    this.runner = deps.runner;
    this.settleDeadlineMs = deps.settleDeadlineMs ?? PLAN_SETTLE_DEADLINE_MS;
    this.heartbeatMs = deps.heartbeatMs ?? PLAN_HEARTBEAT_MS;
    this.timers = deps.timers ?? {
      setInterval: (fn, ms) => {
        const h = setInterval(fn, ms);
        // A heartbeat must never keep the app alive on its own.
        (h as { unref?: () => void }).unref?.();
        return h;
      },
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    };
  }

  private keyOf(ref: PlanRef, planId: string): string {
    return `${ref.sessionId}\u0000${planId}`;
  }

  /** How many plans are advancing right now (tests + diagnostics). */
  activeRuns(): number {
    return this.runs.size;
  }

  /** Resolves once the plan's current run (if any) has fully settled. */
  async settled(planId: string): Promise<void> {
    for (const run of [...this.runs.values()]) if (run.planId === planId) await run.done;
  }

  // ---- PlanExecutorHooks ----

  start(input: { ref: PlanRef; planId: string; fence: string }): void {
    const key = this.keyOf(input.ref, input.planId);
    if (this.runs.has(key)) {
      // The journal lease makes this unreachable (a second start needs a
      // second lease). Refusing keeps one owner per plan in memory too.
      console.error('[plan-executor] a run is already active for this plan', input.planId);
      return;
    }
    let fireHalt!: () => void;
    const haltSignal = new Promise<void>((r) => { fireHalt = r; });
    const run: ActiveRun = {
      key, ref: input.ref, planId: input.planId, fence: input.fence,
      haltSignal, fireHalt, launchAbort: new AbortController(), live: [], done: Promise.resolve(),
    };
    this.runs.set(key, run);
    run.heartbeat = this.timers.setInterval(() => { void this.beat(run); }, this.heartbeatMs);
    run.done = this.drive(run);
  }

  /** Returns true when `finalize` was applied in the executor's final write
   *  (so the caller must not write the stopped state again). */
  async stop(input: { ref: PlanRef; planId: string; finalize?: (plan: PlanRecord) => void }): Promise<boolean> {
    const run = this.runs.get(this.keyOf(input.ref, input.planId));
    if (!run) return false;
    const request: HaltRequest = { kind: 'stop', ...(input.finalize ? { finalize: input.finalize } : {}) };
    this.requestHalt(run, request);
    await run.done;
    return run.halt === request && request.applied === true;
  }

  /** Destroy/quiesce of a parent session: its plans become `interrupted`. */
  async interruptSession(sessionId: string): Promise<void> {
    const runs = [...this.runs.values()].filter((r) => r.ref.sessionId === sessionId);
    for (const run of runs) this.requestHalt(run, { kind: 'interrupt' });
    await Promise.all(runs.map((r) => r.done));
  }

  /** App quit: every plan becomes `interrupted`, all settled in parallel. */
  async interruptAll(): Promise<void> {
    const runs = [...this.runs.values()];
    for (const run of runs) this.requestHalt(run, { kind: 'interrupt' });
    await Promise.all(runs.map((r) => r.done));
  }

  // ---- internals ----

  private requestHalt(run: ActiveRun, request: HaltRequest): void {
    // First reason wins, except that losing the lease overrides everything:
    // once another owner holds the plan, nothing here may write.
    if (run.halt && request.kind !== 'lost') return;
    if (run.halt?.kind === 'lost') return;
    run.halt = request;
    run.launchAbort.abort();
    for (const child of run.live) {
      if (!child.outcome) child.handle.abort();
    }
    run.fireHalt();
  }

  private async beat(run: ActiveRun): Promise<void> {
    if (run.halt?.kind === 'lost') return;
    try {
      await this.journal.heartbeat(run.ref, run.planId, run.fence);
    } catch (e) {
      this.onJournalError(run, e);
    }
  }

  /** Classify a journal failure: lease lost / file damaged → stop writing. */
  private onJournalError(run: ActiveRun, e: unknown): boolean {
    if (e instanceof PlanFenceError) {
      this.requestHalt(run, { kind: 'lost' });
      return true;
    }
    if (e instanceof PlanJournalUnreadableError) {
      if (run.halt?.kind !== 'lost') {
        try { this.runner.onUnreadable(run.ref, run.planId, e.detail); } catch (err) {
          console.error('[plan-executor] unreadable-journal listener threw', err);
        }
      }
      this.requestHalt(run, { kind: 'lost' });
      return true;
    }
    // A transient write failure (lock exhaustion, disk): logged. The next
    // heartbeat retries; the lease stays valid for its full TTL meanwhile.
    console.error('[plan-executor] journal write failed', e);
    return false;
  }

  private async load(run: ActiveRun): Promise<PlanRecord> {
    const plan = await this.journal.get(run.ref, run.planId);
    if (!plan || plan.lease?.fence !== run.fence) throw new PlanFenceError(run.planId);
    return plan;
  }

  private async drive(run: ActiveRun): Promise<void> {
    try {
      await this.prepare(run);
      if (!run.halt) await this.walk(run);
      if (!run.halt) this.requestHalt(run, { kind: 'complete' });
    } catch (e) {
      if (!this.onJournalError(run, e)) {
        // Never a guessed cause: the real message, in a sentence the card can show.
        this.requestHalt(run, {
          kind: 'pause', why: 'unexpected-error',
          stepId: await this.currentStepId(run),
          reason: `The plan stopped because of an unexpected problem: ${errorText(e)}`,
        });
      }
    }
    try {
      await this.settle(run);
    } catch (e) {
      console.error('[plan-executor] settling failed', e);
    } finally {
      this.timers.clearInterval(run.heartbeat);
      run.heartbeat = undefined;
      this.runs.delete(run.key);
    }
  }

  private async currentStepId(run: ActiveRun): Promise<string> {
    try {
      const plan = await this.journal.get(run.ref, run.planId);
      return plan?.steps.find((s) => s.status === 'running')?.id ?? plan?.steps[0]?.id ?? '';
    } catch {
      return '';
    }
  }

  // -- start-time recovery of unfinished attempts --

  /**
   * Before anything launches, decide what every unfinished attempt left by an
   * earlier run means (design §3 resume):
   *  - a stale hold (crash) is given back, to be reserved again with the wave;
   *  - an unsettled request is charged in full and becomes ambiguous;
   *  - a terminal transcript is committed with no request;
   *  - an ambiguity the user has NOT been shown pauses the plan (and is marked
   *    shown in that same write); one they HAVE been shown is picked up again,
   *    because pressing Continue on that pause is the explicit recovery;
   *  - a response-persisted attempt whose transcript shows a side-effecting
   *    tool call with no result is an ambiguity too.
   */
  private async prepare(run: ActiveRun): Promise<void> {
    const plan = await this.load(run);
    let pause: HaltRequest | undefined;
    for (const stepRec of plan.steps) {
      const def = allSteps(plan.document.steps).find((s) => s.id === stepRec.id);
      if (!def || def.kind === 'repeat') continue;
      for (const attempt of stepRec.attempts) {
        if (isCommitted(attempt)) continue;
        const outcome = await this.recoverAttempt(run, def, attempt, isFinalLeaf(plan.document.steps, def.id));
        if (outcome && !pause) pause = outcome;
      }
    }
    if (pause) this.requestHalt(run, pause);
  }

  private async recoverAttempt(run: ActiveRun, def: PlanStepV1, original: PlanAttemptRecord, finalLeaf: boolean): Promise<HaltRequest | undefined> {
    const stepId = def.id;
    const { attemptId } = original;
    if (original.phase !== 'request-sent' && original.reservedTokens > 0) {
      await this.budget.releaseAttempt(run.ref, run.planId, run.fence, stepId, attemptId);
    }
    const verdict: TranscriptVerdict = original.childId
      ? this.runner.inspectTranscript(run.ref, original.childId)
      : { kind: 'resumable', briefDelivered: false };
    let phase = original.phase;
    if (phase === 'request-sent') {
      await this.budget.chargeUnresolved(run.ref, run.planId, run.fence, stepId, attemptId);
      phase = 'ambiguous';
    }
    if (phase === 'prepared') return undefined;
    if (verdict.kind === 'terminal') {
      return this.commitReport(run, def, attemptId, verdict.report, finalLeaf);
    }
    const acknowledged = original.phase === 'ambiguous' && original.ambiguityReported === true;
    if (acknowledged) {
      // The user saw this ambiguity and pressed Continue: that is the explicit
      // recovery. The attempt goes back to a settled phase so it can be
      // reserved again (its unknown request stays charged in full).
      await this.journal.mutateFenced(run.ref, run.planId, run.fence, (plan) => {
        const a = this.findAttempt(plan, stepId, attemptId);
        a.phase = 'response-persisted';
        delete a.ambiguityReported;
      });
      return undefined;
    }
    if (phase === 'ambiguous' || verdict.kind === 'dangling-effect') {
      const what = verdict.kind === 'dangling-effect'
        ? `its last action (${verdict.tool})`
        : 'its last request';
      await this.journal.mutateFenced(run.ref, run.planId, run.fence, (plan) => {
        const a = this.findAttempt(plan, stepId, attemptId);
        a.phase = 'ambiguous';
        a.ambiguityReported = true;
      });
      return {
        kind: 'pause', stepId, attemptId,
        ...(verdict.kind === 'dangling-effect'
          ? { why: 'unknown-outcome' as const, tool: verdict.tool }
          : { why: 'unknown-request' as const }),
        reason: `A specialist in step "${stepId}" was cut off, and it isn't known whether ${what} finished. `
          + 'Press Continue to let it pick up from what it recorded.',
      };
    }
    return undefined;
  }

  private findAttempt(plan: PlanRecord, stepId: string, attemptId: string): PlanAttemptRecord {
    const a = plan.steps.find((s) => s.id === stepId)?.attempts.find((x) => x.attemptId === attemptId);
    if (!a) throw new Error(`No attempt ${attemptId} in step "${stepId}".`);
    return a;
  }

  // -- walking the document --

  private async walk(run: ActiveRun): Promise<void> {
    const plan = await this.load(run);
    for (const step of plan.document.steps) {
      if (run.halt) return;
      if (step.kind === 'repeat') await this.runRepeat(run, step);
      else await this.runStep(run, step, 0, undefined);
    }
  }

  private async setStatus(run: ActiveRun, ids: string[], status: PlanStepRecord['status']): Promise<void> {
    await this.journal.mutateFenced(run.ref, run.planId, run.fence, (plan) => {
      for (const s of plan.steps) if (ids.includes(s.id)) s.status = status;
    });
  }

  private async runRepeat(run: ActiveRun, step: PlanStepV1): Promise<void> {
    const body = step.steps!;
    const finalLeaf = body[body.length - 1];
    const ids = [step.id, ...body.map((s) => s.id)];
    const plan = await this.load(run);
    if (plan.steps.find((s) => s.id === step.id)?.status === 'done') return;
    await this.setStatus(run, ids, 'running');
    for (let iteration = 0; iteration < step.max_iterations!; iteration++) {
      for (const inner of body) {
        if (run.halt) return;
        await this.runStep(run, inner, iteration, { repeat: step, finalLeaf: inner.id === finalLeaf.id });
      }
      if (run.halt) return;
      const decision = await this.decisionFor(run, finalLeaf, iteration);
      if (!decision.ok) {
        this.requestHalt(run, { kind: 'pause', why: 'invalid-report', stepId: finalLeaf.id, reason: decision.detail });
        return;
      }
      if (decision.satisfied) {
        await this.setStatus(run, ids, 'done');
        return;
      }
    }
    // Reaching the cap is not success (design §3): pause for replanning.
    this.requestHalt(run, {
      kind: 'pause', why: 'iteration-cap', stepId: step.id,
      repeat: { rounds: step.max_iterations!, until: step.until ?? '' },
      reason: `The repeated steps ran ${step.max_iterations} times without meeting their stop condition ("${step.until}"). `
        + 'Ask the assistant to revise the plan.',
    });
  }

  private async decisionFor(run: ActiveRun, leaf: PlanStepV1, iteration: number): Promise<{ ok: true; satisfied: boolean } | { ok: false; detail: string }> {
    const plan = await this.load(run);
    const rec = plan.steps.find((s) => s.id === leaf.id)!;
    let satisfied = true;
    for (let i = 0; i < itemCount(leaf); i++) {
      const a = latestAttempt(rec, i, iteration);
      if (!a || !isCommitted(a) || a.terminal !== 'completed') {
        return { ok: false, detail: `The decision for round ${iteration + 1} of step "${leaf.id}" is missing.` };
      }
      const parsed = parseRepeatDecision(a.reportText ?? '');
      if (!parsed.ok) return { ok: false, detail: `The check in step "${leaf.id}" didn't answer in the required form: ${parsed.detail}.` };
      satisfied &&= parsed.satisfied;
    }
    return { ok: true, satisfied };
  }

  private async runStep(
    run: ActiveRun, step: PlanStepV1, iteration: number, repeat: { repeat: PlanStepV1; finalLeaf: boolean } | undefined,
  ): Promise<void> {
    const plan = await this.load(run);
    const rec = plan.steps.find((s) => s.id === step.id);
    if (!rec) throw new Error(`The plan has no record for step "${step.id}".`);
    const needed: number[] = [];
    for (let i = 0; i < itemCount(step); i++) {
      const a = latestAttempt(rec, i, iteration);
      if (!(a && isCommitted(a) && a.terminal === 'completed')) needed.push(i);
    }
    if (needed.length > 0) {
      if (!repeat) await this.setStatus(run, [step.id], 'running');
      const writer = this.runner.isWriter(run.ref, step.specialist);
      const cap = Math.max(1, Math.min(PLAN_MAX_CONCURRENT_SPECIALISTS, this.runner.maxConcurrent(run.ref)));
      const width = writer ? 1 : cap;
      for (let at = 0; at < needed.length; at += width) {
        if (run.halt) return;
        await this.runWave(run, step, iteration, needed.slice(at, at + width), !!repeat?.finalLeaf);
        if (run.halt) return;
      }
    }
    if (!repeat && !run.halt) await this.setStatus(run, [step.id], 'done');
  }

  private async runWave(run: ActiveRun, step: PlanStepV1, iteration: number, items: number[], finalLeaf: boolean): Promise<void> {
    let plan = await this.load(run);
    const rec = plan.steps.find((s) => s.id === step.id)!;
    const refusal = await this.runner.launchRefusal?.(run.ref, plan, step.specialist);
    if (refusal) {
      this.requestHalt(run, { kind: 'pause', why: 'launch-failed', stepId: step.id, reason: refusal });
      return;
    }
    const members: ReserveMember[] = items.map((itemIndex) => {
      const latest = latestAttempt(rec, itemIndex, iteration);
      return latest && !isCommitted(latest)
        ? { stepId: step.id, attemptId: latest.attemptId }
        : { stepId: step.id, itemIndex, iteration };
    });
    // One fenced write reserves the whole wave, or nothing (design §3).
    const reserved = await this.budget.reserveAttempts(run.ref, run.planId, run.fence, members, {
      localPoolTokens: await this.runner.localPoolTokens(run.ref, plan),
    });
    if (!reserved.ok) {
      const exhausted = reserved.reason === 'attempt-exhausted'
        ? members.find((m) => {
          const a = m.attemptId ? rec.attempts.find((x) => x.attemptId === m.attemptId) : undefined;
          return a && a.baseTokens + a.addedTokens - a.spentTokens <= 0;
        })?.attemptId
        : undefined;
      // Review item 1: a shortfall that names no attempt is recorded as the
      // minimum Add budget; that tranche raises the plan limit only, so the
      // fresh attempt then fits.
      const shortfall = !exhausted && 'shortfallTokens' in reserved ? reserved.shortfallTokens : undefined;
      this.requestHalt(run, {
        kind: 'pause', stepId: step.id, reason: reserved.detail,
        why: exhausted ? 'budget'
          : shortfall !== undefined ? 'ceiling-shortfall'
          : reserved.reason === 'local-pool' ? 'local-pool'
          : reserved.reason === 'invalid' ? 'unexpected-error'
          : 'plan-limit',
        ...(exhausted ? { attemptId: exhausted } : {}),
        ...(shortfall !== undefined ? { minimumAddTokens: shortfall, ceilingShortfall: true as const } : {}),
      });
      return;
    }
    plan = await this.load(run);
    const briefBase = this.briefFor(plan, step, iteration, finalLeaf);
    const wave: LiveChild[] = [];
    await Promise.all(reserved.attempts.map(async ({ attemptId }) => {
      const attempt = this.findAttempt(plan, step.id, attemptId);
      let brief = briefBase(attempt.itemIndex);
      if (attempt.childId) {
        // Review item 3: once the brief has reached the specialist, a restart
        // never sends it again — only the fresh continue turn (naming any
        // action whose outcome is unknown, item 4).
        const verdict = this.runner.inspectTranscript(run.ref, attempt.childId);
        if (!(verdict.kind === 'resumable' && !verdict.briefDelivered)) brief = planRestartBrief(verdict);
      }
      if (run.halt) return;
      try {
        const handle = await this.runner.launch({
          ref: run.ref, planId: run.planId, fence: run.fence, stepId: step.id, attemptId,
          itemIndex: attempt.itemIndex, iteration: attempt.iteration, specialist: step.specialist, brief,
          ...(attempt.childId ? { resumeChildId: attempt.childId } : {}),
          signal: run.launchAbort.signal,
          recordChild: (childId, info) => this.journal.mutateFenced(run.ref, run.planId, run.fence, (p) => {
            const a = this.findAttempt(p, step.id, attemptId);
            a.childId = childId;
            // Review item 6: what the card's specialist row shows.
            if (info?.title) a.childTitle = info.title;
            a.startedAt = Date.now();
            a.brief = brief;
            // The spawn-time manifest entry actually used (design §2).
            const entry = p.manifest.specialists[step.specialist];
            a.manifest = { ...p.manifest, specialists: entry ? { [step.specialist]: entry } : {} };
          }),
        });
        const child: LiveChild = { stepId: step.id, attemptId, handle, finalLeaf };
        run.live.push(child);
        wave.push(child);
        if (run.halt) handle.abort();
      } catch (e) {
        if (this.onJournalError(run, e)) return;
        if (run.halt) return;
        this.requestHalt(run, {
          kind: 'pause', why: 'launch-failed', stepId: step.id, attemptId,
          reason: `A specialist in step "${step.id}" couldn't start: ${errorText(e)}`,
        });
      }
    }));

    await new Promise<void>((resolve) => {
      let remaining = wave.length;
      if (remaining === 0) resolve();
      for (const child of wave) {
        void child.handle.outcome.then(async (outcome) => {
          child.outcome = outcome;
          try {
            await this.onOutcome(run, step, child);
          } catch (e) {
            // WHY: an unexpected throw here must still end the wave (a pause
            // with the real message), or the plan would wait forever.
            this.requestHalt(run, { kind: 'pause', why: 'unexpected-error', stepId: step.id, attemptId: child.attemptId, reason: `The plan stopped because of an unexpected problem: ${errorText(e)}` });
          }
          if (--remaining === 0) resolve();
        });
      }
      void run.haltSignal.then(() => resolve());
    });
    if (run.halt) return;
    // Every member is finished and journalled: free their sessions and slots
    // before the next wave or step starts.
    await Promise.all(wave.map((c) => c.handle.dispose()));
    run.live = run.live.filter((c) => !wave.includes(c));
  }

  private async onOutcome(run: ActiveRun, step: PlanStepV1, child: LiveChild): Promise<void> {
    const outcome = child.outcome!;
    if (outcome.kind === 'completed') {
      child.commit = (async () => {
        try {
          const halt = await this.commitReport(run, step, child.attemptId, outcome.report, child.finalLeaf);
          if (halt) this.requestHalt(run, halt);
        } catch (e) {
          if (!this.onJournalError(run, e)) {
            this.requestHalt(run, { kind: 'pause', why: 'unexpected-error', stepId: step.id, attemptId: child.attemptId, reason: `A specialist's result couldn't be saved: ${errorText(e)}` });
          }
        }
      })();
      await child.commit;
      return;
    }
    if (run.halt) return;
    if (outcome.kind === 'stopped') {
      this.requestHalt(run, {
        kind: 'pause', stepId: step.id, attemptId: child.attemptId, reason: outcome.stop.detail,
        // Only running out is fixed by Add budget; a refused or broken
        // request is not a matter of size.
        why: outcome.stop.kind === 'exhausted' ? 'budget' : 'budget-refused',
      });
    } else if (outcome.kind === 'failed') {
      this.requestHalt(run, {
        kind: 'pause', why: 'specialist-error', stepId: step.id, attemptId: child.attemptId,
        reason: `A specialist in step "${step.id}" stopped with an error: ${outcome.detail}`,
      });
    } else {
      this.requestHalt(run, {
        kind: 'pause', why: 'specialist-stopped', stepId: step.id, attemptId: child.attemptId,
        reason: `A specialist in step "${step.id}" was stopped before it finished.`,
      });
    }
  }

  /**
   * Freeze one finished attempt with the journal's OWN spent count (plan-
   * budget's contract). An unsettled request is charged in full first, so a
   * finished report never forgives spending. A repeat's final leaf must also
   * carry a valid decision; a malformed one is kept (as failed) and pauses.
   */
  private async commitReport(run: ActiveRun, step: PlanStepV1, attemptId: string, report: string, finalLeaf: boolean): Promise<HaltRequest | undefined> {
    let plan = await this.load(run);
    let attempt = this.findAttempt(plan, step.id, attemptId);
    if (isCommitted(attempt)) return undefined;
    if (attempt.phase === 'request-sent') {
      await this.budget.chargeUnresolved(run.ref, run.planId, run.fence, step.id, attemptId);
      plan = await this.load(run);
      attempt = this.findAttempt(plan, step.id, attemptId);
    }
    const decision = finalLeaf ? parseRepeatDecision(report) : undefined;
    const trimmed = report.trim();
    const failure = decision && !decision.ok
      ? `The check in step "${step.id}" didn't answer in the required form: ${decision.detail}.`
      : trimmed ? undefined : `The specialist in step "${step.id}" finished without writing a report.`;
    await this.journal.commitAttempt(run.ref, run.planId, run.fence, step.id, attemptId, {
      terminal: failure ? 'failed' : 'completed',
      reportText: report,
      spentTokens: attempt.spentTokens,
    });
    return failure ? { kind: 'pause', why: 'invalid-report', stepId: step.id, reason: failure } : undefined;
  }

  /** The brief for one item: the declared task, plus — for verify/combine
   *  only — the bounded, labelled reports of the step it reads. */
  private briefFor(plan: PlanRecord, step: PlanStepV1, iteration: number, finalLeaf: boolean): (itemIndex: number) => string {
    let dependencies = '';
    if (step.of !== undefined) {
      const reports = this.dependencyReports(plan, step.of, iteration);
      const perReport = Math.min(PLAN_DEPENDENCY_REPORT_MAX_CHARS, Math.floor(PLAN_DEPENDENCY_TOTAL_MAX_CHARS / Math.max(1, reports.length)));
      const blocks = reports.map((r, i) => `--- Result ${fmtItem(i, reports.length)} from step "${step.of}"${r.label ? ` (${r.label})` : ''} ---\n${shorten(r.text, perReport)}`);
      dependencies = `\n\nResults to work from (${reports.length}):\n\n${blocks.join('\n\n')}`;
    }
    const repeat = plan.document.steps.find((s) => s.kind === 'repeat' && s.steps!.some((b) => b.id === step.id));
    // Review item 5: from round 2 on, the FIRST step of a repeat reads the
    // previous round's check, through the same bounded, labelled mechanism as
    // verify/combine — otherwise every round gets the identical brief and the
    // stop condition can never be approached.
    let previousRound = '';
    if (repeat && iteration > 0 && repeat.steps![0].id === step.id) {
      const leaf = repeat.steps![repeat.steps!.length - 1];
      const reports = this.dependencyReports(plan, leaf.id, iteration - 1);
      const perReport = Math.min(PLAN_DEPENDENCY_REPORT_MAX_CHARS, Math.floor(PLAN_DEPENDENCY_TOTAL_MAX_CHARS / Math.max(1, reports.length)));
      const blocks = reports.map((r, i) => `--- Check ${fmtItem(i, reports.length)} from round ${iteration} (step "${leaf.id}")${r.label ? ` (${r.label})` : ''} ---\n${shorten(r.text, perReport)}`);
      if (blocks.length > 0) {
        previousRound = `\n\nThis is round ${iteration + 1}. The previous round's check found that the stop condition ("${repeat.until}") was not yet met:\n\n${blocks.join('\n\n')}`;
      }
    }
    let decisionRules = '';
    if (finalLeaf && repeat) {
      decisionRules = `\n\nThis is the check for round ${iteration + 1} of at most ${repeat.max_iterations}. `
        + `The rounds stop when: ${repeat.until}\n`
        + 'Reply with ONLY a JSON object, exactly in this form: {"report": "<your findings>", "repeatSatisfied": true or false}';
    }
    return (itemIndex) => {
      let task = step.task;
      if (step.kind === 'map') {
        const item = step.items![itemIndex];
        task = task.includes('{item}') ? task.split('{item}').join(item) : `${task}\n\nItem: ${item}`;
      }
      return `${task}${previousRound}${dependencies}${decisionRules}`;
    };
  }

  private dependencyReports(plan: PlanRecord, ofId: string, iteration: number): Array<{ text: string; label?: string }> {
    const def = allSteps(plan.document.steps).find((s) => s.id === ofId);
    if (!def) return [];
    if (def.kind === 'repeat') {
      // A repeat's result is its final check's last completed round.
      const leaf = def.steps![def.steps!.length - 1];
      const rec = plan.steps.find((s) => s.id === leaf.id);
      const last = Math.max(-1, ...(rec?.attempts.filter((a) => isCommitted(a) && a.terminal === 'completed').map((a) => a.iteration) ?? []));
      return last < 0 ? [] : this.dependencyReports(plan, leaf.id, last);
    }
    const rec = plan.steps.find((s) => s.id === ofId);
    if (!rec) return [];
    // A step inside the same repeat body is read from THIS round; a step
    // outside any repeat only ever has round 0.
    const inSameRepeat = plan.document.steps.some((s) => s.kind === 'repeat' && s.steps!.some((b) => b.id === ofId));
    const round = inSameRepeat ? iteration : 0;
    const finalLeafOfRepeat = isFinalLeaf(plan.document.steps, ofId);
    const out: Array<{ text: string; label?: string }> = [];
    for (let i = 0; i < itemCount(def); i++) {
      const a = latestAttempt(rec, i, round);
      if (!a || !isCommitted(a) || a.terminal !== 'completed') continue;
      let text = a.reportText ?? '';
      if (finalLeafOfRepeat) {
        const parsed = parseRepeatDecision(text);
        if (parsed.ok) text = parsed.report;
      }
      out.push({ text, ...(def.kind === 'map' ? { label: `item: ${def.items![i]}` } : {}) });
    }
    return out;
  }

  // -- settling --

  private async settle(run: ActiveRun): Promise<void> {
    const halt = run.halt ?? { kind: 'lost' as const };
    // 1. Everything still running was already asked to stop (requestHalt, or
    //    runWave for a launch that landed after the halt) and gets until the
    //    deadline to finish on its own.
    const pending = run.live.filter((c) => !c.outcome);
    if (pending.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(pending.map((c) => c.handle.outcome)),
        new Promise<void>((r) => { timer = setTimeout(r, this.settleDeadlineMs); }),
      ]);
      if (timer) clearTimeout(timer);
    }
    // 2. Whatever is left is torn down (this also frees every slot).
    await Promise.all(run.live.map((c) => c.handle.dispose()));
    if (halt.kind === 'lost') return;
    try {
      // 3. Real results that arrived keep their reports.
      await Promise.all(run.live.map((c) => c.commit));
      let pauseFromCommit: HaltRequest | undefined;
      for (const child of run.live) {
        if (child.outcome?.kind !== 'completed' || child.commit) continue;
        const step = allSteps((await this.load(run)).document.steps).find((s) => s.id === child.stepId)!;
        pauseFromCommit ??= await this.commitReport(run, step, child.attemptId, child.outcome.report, child.finalLeaf);
      }
      // 4. Pessimistic settlement: unknown spending is charged in full, and
      //    every hold is given back.
      const plan = await this.load(run);
      const cutOff: Array<{ stepId: string; attemptId: string }> = [];
      for (const stepRec of plan.steps) {
        for (const a of stepRec.attempts) {
          if (isCommitted(a)) continue;
          if (a.phase === 'request-sent') {
            await this.budget.chargeUnresolved(run.ref, run.planId, run.fence, stepRec.id, a.attemptId);
            cutOff.push({ stepId: stepRec.id, attemptId: a.attemptId });
          }
          if (a.reservedTokens > 0 || a.phase === 'request-sent') await this.budget.releaseAttempt(run.ref, run.planId, run.fence, stepRec.id, a.attemptId);
        }
      }
      // 5. Only now does the card change — in the same write that drops the lease.
      const final = halt.kind === 'complete' && pauseFromCommit ? pauseFromCommit : halt;
      // Task 3 obligation: after a soft overshoot (or any budget stop) the card
      // must say how much Add budget is enough, instead of accepting a smaller
      // amount that would silently pause again on Continue.
      let minimumAddTokens: number | undefined;
      if (final.kind === 'pause' && final.minimumAddTokens !== undefined) {
        minimumAddTokens = final.minimumAddTokens;
      } else if (final.kind === 'pause' && final.attemptId && this.runner.minimumAddTokens) {
        try {
          minimumAddTokens = await this.runner.minimumAddTokens(run.ref, await this.load(run), final.attemptId);
        } catch (e) {
          if (e instanceof PlanFenceError || e instanceof PlanJournalUnreadableError) throw e;
          console.error('[plan-executor] could not work out the minimum Add budget', e);
        }
      }
      if (final.kind === 'stop') {
        // Review item 8: PlanService's "stopped" edit rides in this same
        // write, so a crash can never leave a released-but-running plan.
        await this.journal.mutateFenced(run.ref, run.planId, run.fence, (p) => {
          delete p.lease;
          final.finalize?.(p);
        });
        final.applied = final.finalize !== undefined;
        return;
      }
      // Review item 7: siblings whose requests were cut off are named in THIS
      // pause and marked as shown, so Continue picks them up instead of
      // pausing once more for each.
      const cutOffOthers = final.kind === 'pause' ? cutOff.filter((c) => c.attemptId !== final.attemptId) : [];
      await this.journal.mutateFenced(run.ref, run.planId, run.fence, (p) => {
        delete p.lease;
        for (const c of cutOffOthers) {
          const a = p.steps.find((x) => x.id === c.stepId)?.attempts.find((x) => x.attemptId === c.attemptId);
          if (a && a.phase === 'ambiguous') a.ambiguityReported = true;
        }
        if (final.kind === 'complete') {
          p.status = 'completed';
          p.endedAt = Date.now();
          for (const s of p.steps) if (s.status !== 'skipped') s.status = 'done';
          return;
        }
        for (const s of p.steps) if (s.status === 'running') s.status = 'paused';
        if (final.kind === 'pause') {
          p.status = 'paused';
          const note = cutOffNote(cutOffOthers);
          p.paused = {
            stepId: final.stepId, reason: withCutOffNote(final.reason, cutOffOthers),
            kind: final.why,
            ...(final.tool ? { tool: final.tool } : {}),
            ...(final.repeat ? { repeat: final.repeat } : {}),
            ...(note ? { note } : {}),
            ...(final.attemptId ? { attemptId: final.attemptId } : {}),
            ...(minimumAddTokens !== undefined ? { minimumAddTokens } : {}),
            ...(final.ceilingShortfall ? { ceilingShortfall: true as const } : {}),
          };
          const s = p.steps.find((x) => x.id === final.stepId);
          if (s && s.status !== 'done') s.status = 'paused';
        } else {
          p.status = 'interrupted';
        }
      });
    } catch (e) {
      this.onJournalError(run, e);
    }
  }
}
