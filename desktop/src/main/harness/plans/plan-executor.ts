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
//    reruns a finished step. A specialist whose last action may have reached
//    outside this computer (a command, a web request, a message) pauses the
//    plan and is only picked up again after the user has been told and pressed
//    Continue. Task 9a (pause handoff §1): an obviously safe case — a cut-off
//    request, a read, a local file change (restarted with "check first"), a
//    start or provider error, an invalid report — is retried by itself ONCE,
//    recorded in the journal before the retry (pause-routing.ts decides).
//
// Host-agnostic on purpose: the host (native-session-host.ts) supplies a
// PlanRunner that turns "launch this attempt" into a real specialist session.
import { z } from 'zod';
import type { PlanStepV1 } from './schema';
import { randomUUID } from 'crypto';
import { PlanFenceError, PlanJournalUnreadableError, type PlanJournal } from './plan-journal';
import type { PlanPauseKind } from '../../../shared/types';
import type { PlanExecutorHooks } from './plan-service';
import type { PlanAttemptRecord, PlanRecord, PlanRef, PlanStepRecord } from './types';
// T2 (design §3): the stop reason a plan specialist's turn ends with when
// `beforeRequest` refuses its next request — renamed from the deleted
// `PLAN_BUDGET_EXHAUSTED_STOP_REASON`, now owned by plan-spend.ts (the one
// module both this file and harness-session.ts already depend on).
import { PLAN_LIMIT_REACHED_STOP_REASON } from './plan-spend';
import type { TranscriptEvent } from '../../../shared/types';
import type { ToolEffect } from '../tools/types';
import { routePlanPause, type PlanPauseContext, type PlanRecoveryCause } from './pause-routing';

/** Well inside the journal's 60 s lease, so a slow disk never lets it lapse. */
const PLAN_HEARTBEAT_MS = 20_000;
/** How long stopped specialists get to finish on their own before teardown. */
const PLAN_SETTLE_DEADLINE_MS = 10_000;
/** T3 (design §3 "Concurrency"): how long a spend-limit DRAIN waits for every
 *  live specialist to end its own turn at its next `beforeRequest` before
 *  falling back to the ordinary abort-and-settle path. Long enough to cover a
 *  child waiting on a permission ask, which never times out on its own. */
const PLAN_DRAIN_DEADLINE_MS = 60_000;
/** Final review F2: a failed final write is tried again after these waits
 *  (a held lock or a busy disk usually clears within a second). */
const PLAN_SETTLE_WRITE_RETRY_DELAYS_MS: readonly number[] = [250, 1_000];
/** The hard product maximum of simultaneous specialists (global constraints). */
const PLAN_MAX_CONCURRENT_SPECIALISTS = 4;
/** One dependency report handed to a verify/combine specialist, at most. */
export const PLAN_DEPENDENCY_REPORT_MAX_CHARS = 6_000;
/** All dependency reports in one brief, together, at most. */
const PLAN_DEPENDENCY_TOTAL_MAX_CHARS = 24_000;
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
  // Task 9a: a cut-off READ changed nothing, so it is simply re-run.
  if (verdict.kind !== 'dangling-effect' || verdict.effect === 'read') return PLAN_RESTART_BRIEF;
  return `You were interrupted before you finished. Your last ${verdict.tool} call has no recorded result, so it may or may `
    + `not have taken effect. Check the current state before repeating it. Then continue the same task from where your `
    + 'work above ends, and finish with your report.';
}

/**
 * Task 9a (pause handoff §1): the one message of the report-only turn that
 * follows an invalid report. It continues the same specialist session with its
 * tools switched off, so nothing it did before can run again.
 * T3 (item 5, knip): no longer exported — nothing outside this file (or its
 * test) ever imported it; a leftover from before the request-phase machinery
 * that used to call it from plan-host-bridge.ts was removed.
 */
function planReportOnlyBrief(input: { finalLeaf: boolean; problem: string }): string {
  const noTools = 'Your tools are switched off for this reply.';
  if (input.finalLeaf) {
    return `Your last answer couldn't be used. ${input.problem} ${noTools} Reply now with ONLY a JSON object, exactly in this form: `
      + '{"report": "<your findings>", "repeatSatisfied": true or false}';
  }
  return `You finished without writing your report. ${noTools} Reply now with your report: what you found and what you did.`;
}

/** Review fix 2: the turn a report-only retry sends when its message already
 *  reached the specialist (a Continue after it paused) — never that message
 *  a second time. */
export const PLAN_REPORT_ONLY_RESEND = 'Send the report asked for above now. Your tools are still switched off.';

/** Thrown by the runner when a specialist's definition changed since the plan
 *  was approved. WHY a type: a drift would fail the same way every time, so it
 *  is never retried automatically (pause handoff §1). */
export class PlanLaunchDriftError extends Error {}

/** Thrown by the runner when a start can never succeed as things stand (the
 *  plan has no approved settings for the specialist, or its budget route can't
 *  be used). Review fix 6: a refusal, like `launchRefusal` — never retried,
 *  and the assistant may only recommend Stop. */
export class PlanLaunchRefusedError extends Error {}

/** Task 13 (decision 26): thrown by the runner when the specialist's PROVIDER
 *  cannot run as things stand — signed out of ChatGPT, no API key saved, no
 *  endpoint, the local engine not installed. Its message is the provider's own
 *  sentence about what to fix.
 *  WHY not a PlanLaunchRefusedError: a refusal routes the card to Stop only,
 *  and here Continue is exactly the right button once the person has signed in
 *  or added the key. Never retried automatically — the identical launch could
 *  not possibly succeed (Destin, 2026-09-18: a plan spent its ONE retry
 *  re-running a launch that died with "Sign in with ChatGPT…"). */
export class PlanNotReadyError extends Error {}

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
  /** Task 9a: the report-only turn — this turn is sent with tools switched off. */
  toolsDisabled?: boolean;
  /** Cancels a launch still waiting for a free specialist slot. */
  signal: AbortSignal;
  /** Must be awaited after the session exists and BEFORE anything is sent, so
   *  the journal always knows which session an attempt's spending belongs to. */
  recordChild(childId: string, info?: { title?: string }): Promise<void>;
  /** T2 (design §3 "Concurrency" / Revision 1 D3): read/write this RUN's
   *  shared spend flags. Every attempt in the same wave/run shares the same
   *  `ActiveRun`, so these close over it here (`memberStart`) — the host
   *  builds one `PlanSpend` per attempt (Revision 3 F1) and wires them
   *  straight through to it, never touching `ActiveRun` itself. `markX` is
   *  idempotent; T3 reads `isLimitReached` for the wave-start check and the
   *  drain halt — not built here. */
  isLimitReached(): boolean;
  markLimitReached(): void;
  isWriteFailed(): boolean;
  markWriteFailed(): void;
}

// WHY the `stopped`/`PlanChildStop` outcome is GONE (spending rework stage 1,
// design §1): it named a request-gate refusal (plan-budget / budget-adapter),
// both deleted. T2's replacement halt path (a `spend-limit` pause via
// `run.limitReached`, design §3) does not route through `PlanChildOutcome`.
export type PlanChildOutcome =
  | { kind: 'completed'; report: string }
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
  /** Revision 3 F2: the attempt's `PlanSpend.spendSettled()` — the LIVE
   *  current write chain at call time, never a value captured at launch.
   *  `commitReport` awaits it before committing (Revision 2 E4), so a report
   *  can never land ahead of the spend it cost. */
  spendSettled(): Promise<void>;
}

/** What a specialist's own transcript proves about an unfinished attempt. */
export type TranscriptVerdict =
  /** Its last turn finished with a report — commit it without a request. */
  | { kind: 'terminal'; report: string }
  /** A tool call has no recorded result — outcome unknown. `effect` (Task
   *  9a) says what it could have changed; with several, the widest. */
  | { kind: 'dangling-effect'; tool: string; effect: ToolEffect }
  /** Nothing is proven; restarting is safe. `briefDelivered` says whether its
   *  transcript already contains the brief. */
  | { kind: 'resumable'; briefDelivered: boolean };

// WHY localPoolTokens/minimumAddTokens/launchRefusal/reportOnlyInputBound are
// ALL GONE from this interface (spending rework stage 1, design §1):
//  - localPoolTokens named the shared local-engine context pool's SIZE, for a
//    token-math check; Revision 2 E2/E3 replace it with a headcount cap (at
//    most one local-engine plan specialist at a time, keyed on the step's
//    frozen binding) — T3's job, not a runner callback any more.
//  - minimumAddTokens/reportOnlyInputBound sized an Add budget top-up that no
//    longer exists.
//  - launchRefusal named a budget-adapter refusal; nothing refuses a launch
//    for budget reasons any more (credential readiness is `providerNotReady`,
//    kept below).
export interface PlanRunner {
  /** The parent's resolved concurrent-specialist count (clamped to 4 here). */
  maxConcurrent(ref: PlanRef): number;
  isWriter(ref: PlanRef, specialist: string): boolean;
  /** Mint (or rebuild) the specialist and send its turn. Throws with the real
   *  reason when it cannot start. */
  launch(input: PlanChildLaunch): Promise<PlanChildHandle>;
  inspectTranscript(ref: PlanRef, childId: string): TranscriptVerdict;
  /** The journal became unreadable mid-run: show a failed card (seq = last + 1). */
  onUnreadable(ref: PlanRef, planId: string, detail: string): void;
  /** Task 13 (decision 26): the provider's OWN sentence about what to fix when
   *  `specialist`'s provider cannot run right now (signed out, no key saved,
   *  no endpoint, engine not installed), or undefined when it can. Asked
   *  BEFORE every automatic retry of a launch failure or a specialist error,
   *  because a credential problem fails identically every time. A FACT check —
   *  never a string match on the error text. */
  providerNotReady?(ref: PlanRef, plan: PlanRecord, specialist: string): Promise<string | undefined>;
  /** Review fix 2: the newest user message in a specialist's transcript. */
  latestUserText?(ref: PlanRef, childId: string): string | undefined;
  /** Final review F2: a run ended but its final write never landed, so the
   *  journal still says `running` under this process's lease. The host runs
   *  recovery (with `PlanExecutor.orphanReason`) to show the real state. */
  onOrphaned?(ref: PlanRef, planId: string): void;
}


/** Final review F2 + Task 12 review fix 2: why a run's final write never
 *  landed. `reason` is the card's general line; `report` is the system's own
 *  text, for Report bug / Diagnose only. */
export interface PlanOrphan { reason: string; report?: string }

// WHY PlanMinimumAdd is GONE (spending rework stage 1, decision 34): no
// worked-out Add budget minimum exists any more.
const PLAN_PROGRESS_NOT_SAVED = "The plan stopped because its progress couldn't be saved.";

/**
 * Read a plan specialist's own transcript (design §3 resume): what does it
 * PROVE about an attempt whose journal phase never reached committed?
 * Only the latest user turn can hold the finished report — an earlier turn
 * that ended on a budget stop was followed by a restart turn.
 */
export function classifyChildTranscript(events: readonly TranscriptEvent[], effectOf: (toolName: string) => ToolEffect): TranscriptVerdict {
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
  if (end?.type === 'turn-complete' && end.data.stopReason !== PLAN_LIMIT_REACHED_STOP_REASON) {
    let report = '';
    for (const e of tail.slice(0, endIndex)) {
      if (e.type === 'tool-use') report = '';
      else if (e.type === 'assistant-text') report += String(e.data.text ?? '');
    }
    if (report.trim()) return { kind: 'terminal', report: report.trim() };
  }
  const answered = new Set(tail.filter((e) => e.type === 'tool-result').map((e) => e.data.toolUseId));
  // Task 9a: every unanswered call is reported with its declared effect (the
  // executor's own name list is gone). With several — parallel calls — the
  // widest one decides, so a cut-off Read beside a cut-off Bash is never
  // mistaken for a harmless one.
  const rank: Record<ToolEffect, number> = { read: 0, local: 1, external: 2 };
  let widest: { tool: string; effect: ToolEffect } | undefined;
  for (const e of tail) {
    if (e.type !== 'tool-use' || answered.has(e.data.toolUseId)) continue;
    const tool = e.data.toolName ?? 'an unknown tool';
    const effect = effectOf(tool);
    if (!widest || rank[effect] > rank[widest.effect]) widest = { tool, effect };
  }
  if (widest) return { kind: 'dangling-effect', ...widest };
  return { kind: 'resumable', briefDelivered: true };
}

export interface PlanExecutorTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface PlanExecutorDeps {
  journal: PlanJournal;
  // WHY no `budget` dep any more (spending rework stage 1): PlanBudget is
  // deleted — the journal alone is what createAttempts/commitReport use.
  runner: PlanRunner;
  settleDeadlineMs?: number;
  /** T3: overrides PLAN_DRAIN_DEADLINE_MS (tests pass a small value). */
  drainDeadlineMs?: number;
  heartbeatMs?: number;
  timers?: PlanExecutorTimers;
  /** Final review F2: the waits before each retry of a run's final write
   *  (tests pass zeros). Its length is the number of retries. */
  settleWriteRetryDelaysMs?: readonly number[];
  // Task 11 (pause handoff §6, review 4-11): no pause-time hook any more — a
  // pause is handed to the assistant only when the user asks (the host
  // bridge's askAssistant), never by the executor.
}

// ---- repeat decisions ----

const RepeatDecisionSchema = z.object({ report: z.string(), repeatSatisfied: z.boolean() }).strict();

/** Parse a repeat's final-leaf report. The text may be the bare JSON object or
 *  wrap it in a code fence; anything else is refused with the real reason. */
function parseRepeatDecision(text: string): { ok: true; report: string; satisfied: boolean } | { ok: false; detail: string } {
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

// WHY minimumAddTokens/ceilingShortfall/reportOnlyOf/acknowledge are ALL GONE
// from the pause variant (spending rework stage 1, design §1/§2, decision
// 34): none of Add budget's sizing, the ceiling-shortfall pause, the
// report-turn funding gap, or the ambiguityReported "shown once" flag exist
// any more. `limit` (design §2/§7) is added by T2/T6 once something actually
// produces a `spend-limit` pause.
type HaltRequest =
  | { kind: 'complete' }
  /** why/tool/repeat (5b follow-up): the facts the card words the pause
   *  from, so it never has to read `reason`. Every pause names its `why`. */
  | {
    kind: 'pause'; why: PlanPauseKind; stepId: string; reason: string; attemptId?: string;
    tool?: string; repeat?: { rounds: number; until: string };
    /** Task 9a: the facts pause-routing.ts reads back from the saved pause. */
    /** Task 13: `not-ready` = the specialist's provider couldn't run at all. */
    launch?: 'refused' | 'drift' | 'not-ready'; retried?: true; toolEffect?: ToolEffect;
    /** T3 (design §3 "Concurrency" / §7): a `spend-limit` pause carries the
     *  limit it hit, for the card's "Reached your $X limit." `drain: true`
     *  marks this halt as one `requestHalt` must NOT abort live children for
     *  — every running specialist gets to finish its own in-flight reply
     *  first (settle's drain deadline), instead of being cut off mid-request
     *  like every other pause reason. */
    limit?: PlanSpendLimit; drain?: true;
  }
  /** finalize: PlanService's "stopped" edit, applied in the SAME write that
   *  drops the lease (review item 8). */
  | { kind: 'stop'; finalize?: (plan: PlanRecord) => void; applied?: boolean }
  | { kind: 'interrupt' }
  /** The lease is gone (or the journal is unreadable): write nothing more. */
  | { kind: 'lost' };

/** What `createAttempts` (design §3) should turn into a journal attempt
 *  record — see its own WHY comment. Defined here now, not plan-budget.ts
 *  (deleted, spending rework stage 1). */
interface CreateAttemptMember {
  stepId: string;
  /** Restart an existing (unfinished) attempt instead of creating one. */
  attemptId?: string;
  itemIndex?: number;
  iteration?: number;
  /** The report-only retry of this committed, failed attempt (same item and
   *  iteration, continuing its specialist session). */
  reportOnlyOf?: string;
  /** With reportOnlyOf: the report-only message, stored on the new attempt so
   *  a crash before its launch still sends exactly that turn. */
  brief?: string;
}

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
  /** Review fix 1: member work settle must wait for (see track()). */
  busy: Set<Promise<void>>;
  /** Follow-up: settle stopped waiting for member work; anything a member
   *  starts after this is torn down at once. */
  closed?: boolean;
  heartbeat?: unknown;
  done: Promise<void>;
  /** T2 (design §3 "Concurrency", Revision 1 D3 / Revision 2 E4): set by ANY
   *  attempt's `PlanSpend` once one of its writes crosses `spendLimit` (or
   *  fails) — read by every OTHER attempt's own `beforeRequest` via the
   *  `isLimitReached`/`isWriteFailed` closures `memberStart` hands the
   *  runner, and by `commitReport` before committing. T3 also reads
   *  `limitReached` for the wave-start check and the drain halt — not built
   *  here. Never cleared: a run that crossed its limit stays crossed for the
   *  rest of this process's life on it. */
  limitReached?: boolean;
  spendWriteFailed?: boolean;
}

const isCommitted = (a: PlanAttemptRecord) => a.phase === 'committed' || a.completedAt !== undefined;
const fmtItem = (n: number, of: number) => `${n + 1} of ${of}`;

/** T3: the plan's own optional spend limit (design §2/§7). Reused from
 *  `PlanRecord` rather than declared fresh so the two can never drift. */
type PlanSpendLimit = NonNullable<PlanRecord['spendLimit']>;

/** T3 (design §3: "runWave first checks used ≥ limit on the plan it loaded,
 *  so no new wave starts past the limit"). Mirrors plan-spend.ts's own
 *  (private) `crossedLimit` — kept as a separate small copy rather than an
 *  import so this file stays independent of plan-spend.ts's internals, the
 *  same reasoning `pricingSnapshot` already used in plan-host-bridge.ts. */
function spendLimitCrossed(plan: PlanRecord): boolean {
  const limit = plan.spendLimit;
  if (!limit) return false;
  return 'usd' in limit ? (plan.usedUsd ?? 0) >= limit.usd : plan.usedTokens >= limit.tokens;
}

/** The pause's own `reason` sentence (design §7's "Reached your $5 limit.");
 *  `paused.limit`/`paused.kind` are what the card actually draws from —
 *  this is only the fallback text for anything that still reads `reason`. */
function spendLimitReason(limit: PlanSpendLimit | undefined): string {
  if (!limit) return "The plan stopped because it reached its spend limit.";
  return 'usd' in limit
    ? `Reached your $${limit.usd.toFixed(2)} limit.`
    : `Reached your ${limit.tokens.toLocaleString('en-US')}-token limit.`;
}

/** T3 (design §3 "Concurrency", Revision 2 E2/E3): true when this LEAF
 *  step's frozen binding is the local engine. `resolveManifest`
 *  (plan-host-bridge.ts, already built by T1) freezes `manifest.steps[id].
 *  pricing` to `{kind:'local'}` exactly when the step's binding resolved to
 *  a local-engine provider — this file only reads that, it never re-derives
 *  it. `pricing` is stored as `unknown` (types.ts: a snapshot shape this
 *  file must not have to parse strictly — see its own WHY), so anything
 *  that isn't recognizably `{kind:'local'}` — priced, free, or a missing/
 *  damaged entry — reads as NOT local, the safe direction: it can only
 *  under-serialize a genuinely local step, never wrongly serialize a cloud
 *  one down to one specialist at a time. */
function isLocalEngineStep(plan: PlanRecord, stepId: string): boolean {
  const snapshot = plan.manifest.steps[stepId]?.pricing;
  return !!snapshot && typeof snapshot === 'object' && (snapshot as { kind?: unknown }).kind === 'local';
}

/** T3: a plain re-read of `run.halt`, through a function call on purpose —
 *  `memberStart` already narrowed `run.halt` to falsy earlier in the SAME
 *  try block (`if (run.halt) return undefined;`, before any of this
 *  function's own `await`s), and re-reading the bare property later lets
 *  that stale narrowing leak across the awaits that follow, typing it as
 *  `never` even though `markLimitReached`'s async half may genuinely have
 *  set it by now. A function call is opaque to that narrowing. */
function currentHalt(run: ActiveRun): HaltRequest | undefined {
  return run.halt;
}

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

/**
 * Review finding 7: join two sentences on a card without running them together
 * or doubling a full stop. A provider's raw error detail ("socket hang up")
 * usually has no terminal punctuation, so `${base} ${next}` read as one garbled
 * line; a detail that DOES end in one must not gain a second.
 */
function joinSentences(base: string, next: string): string {
  const head = base.trimEnd();
  return /[.!?]$/.test(head) ? `${head} ${next}` : `${head}. ${next}`;
}

/** Why a finished report can't be used, or undefined when it can. Shared by
 *  the commit and by a Continue that asks for the report again (F4), so the
 *  specialist is told the same problem both times. */
function invalidReportProblem(stepId: string, report: string, finalLeaf: boolean): string | undefined {
  const decision = finalLeaf ? parseRepeatDecision(report) : undefined;
  if (decision && !decision.ok) return `The check in step "${stepId}" didn't answer in the required form: ${decision.detail}.`;
  return report.trim() ? undefined : `The specialist in step "${stepId}" finished without writing a report.`;
}

type RecoveryKey = { stepId: string; iteration: number; itemIndex: number };

/** What one wave member carries between its launches. `recovered`: the
 *  automatic retry the next launch is (review fix 3 marks it on that launch). */
interface MemberState { attemptId: string; recovered?: PlanRecoveryCause }

const isJournalError = (e: unknown): boolean => e instanceof PlanFenceError || e instanceof PlanJournalUnreadableError;

/** Review fix 3: the automatic retry for this key actually relaunched. */
function markRelaunched(plan: PlanRecord, key: RecoveryKey, cause: PlanRecoveryCause): void {
  for (const r of plan.recoveries ?? []) {
    if (!r.reset && r.stepId === key.stepId && r.iteration === key.iteration && r.itemIndex === key.itemIndex && r.cause === cause) r.relaunched = true;
  }
}

/** Task 9a: has this step/iteration/item already been recovered automatically
 *  for this cause? (One recovery each — pause handoff §1.) */
function hasRecovery(plan: PlanRecord, key: RecoveryKey, cause: PlanRecoveryCause): boolean {
  return (plan.recoveries ?? []).some((r) => !r.reset && r.stepId === key.stepId && r.iteration === key.iteration
    && r.itemIndex === key.itemIndex && r.cause === cause);
}

function recordRecovery(plan: PlanRecord, key: RecoveryKey, cause: PlanRecoveryCause): void {
  plan.recoveries = [...(plan.recoveries ?? []), { ...key, cause, at: Date.now() }];
}

// WHY cutOffNote/withCutOffNote are GONE (spending rework stage 1, design
// §1/§3): both worded the pessimistic-settlement sibling note ("N other
// specialists were cut off mid-request") for a request-in-flight state that
// no longer exists — settle no longer charges or cuts anything off.

export class PlanExecutor implements PlanExecutorHooks {
  private readonly journal: PlanJournal;
  private readonly runner: PlanRunner;
  private readonly settleDeadlineMs: number;
  private readonly drainDeadlineMs: number;
  private readonly heartbeatMs: number;
  private readonly timers: PlanExecutorTimers;
  private readonly runs = new Map<string, ActiveRun>();
  /** Runs whose visible end is being written. WHY separate (review fix 7
   *  follow-up): "a paused plan owns no timer" must already hold when the
   *  paused card is emitted, so the heartbeat stops and the run leaves `runs`
   *  BEFORE that write; `settled`/`stop` still find it here until it is done. */
  private readonly finishing = new Map<string, ActiveRun>();
  /** Final review F2: runs whose final write never landed, with the real
   *  reason — keyed like `runs`. Recovery reads it through orphanReason. */
  private readonly orphans = new Map<string, PlanOrphan>();
  private readonly settleWriteRetryDelaysMs: readonly number[];

  constructor(deps: PlanExecutorDeps) {
    this.settleWriteRetryDelaysMs = deps.settleWriteRetryDelaysMs ?? PLAN_SETTLE_WRITE_RETRY_DELAYS_MS;
    this.journal = deps.journal;
    this.runner = deps.runner;
    this.settleDeadlineMs = deps.settleDeadlineMs ?? PLAN_SETTLE_DEADLINE_MS;
    this.drainDeadlineMs = deps.drainDeadlineMs ?? PLAN_DRAIN_DEADLINE_MS;
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

  /**
   * Final review F2: why this process holds `planId`'s lease with nothing
   * running it — its final write failed — or undefined (a run is active, or
   * nothing went wrong). PlanJournal.recoverInterrupted asks this for every
   * plan leased by this process.
   */
  orphanReason(ref: PlanRef, planId: string): PlanOrphan | undefined {
    const key = this.keyOf(ref, planId);
    if (this.runs.has(key) || this.finishing.has(key)) return undefined;
    return this.orphans.get(key);
  }

  /** Recovery wrote the plan's real state: forget the orphan. */
  clearOrphan(ref: PlanRef, planId: string): void {
    this.orphans.delete(this.keyOf(ref, planId));
  }

  /** How many plans are advancing right now (tests + diagnostics). */
  activeRuns(): number {
    return this.runs.size;
  }

  /** Resolves once the plan's current run (if any) has fully settled. */
  async settled(planId: string): Promise<void> {
    for (const run of [...this.runs.values(), ...this.finishing.values()]) if (run.planId === planId) await run.done;
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
      haltSignal, fireHalt, launchAbort: new AbortController(), live: [], busy: new Set(), done: Promise.resolve(),
    };
    this.runs.set(key, run);
    run.heartbeat = this.timers.setInterval(() => { void this.beat(run); }, this.heartbeatMs);
    run.done = this.drive(run);
  }

  /** Returns true when `finalize` was applied in the executor's final write
   *  (so the caller must not write the stopped state again). */
  async stop(input: { ref: PlanRef; planId: string; finalize?: (plan: PlanRecord) => void }): Promise<boolean> {
    const key = this.keyOf(input.ref, input.planId);
    const run = this.runs.get(key) ?? this.finishing.get(key);
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
    // A run already writing its end is waited for too (it is not interrupted).
    const ending = [...this.finishing.values()].filter((r) => r.ref.sessionId === sessionId);
    await Promise.all([...runs, ...ending].map((r) => r.done));
  }

  /** App quit: every plan becomes `interrupted`, all settled in parallel. */
  async interruptAll(): Promise<void> {
    const runs = [...this.runs.values()];
    for (const run of runs) this.requestHalt(run, { kind: 'interrupt' });
    await Promise.all([...runs, ...this.finishing.values()].map((r) => r.done));
  }

  // ---- internals ----

  private requestHalt(run: ActiveRun, request: HaltRequest): void {
    // First reason wins, except that losing the lease overrides everything:
    // once another owner holds the plan, nothing here may write.
    if (run.halt && request.kind !== 'lost') return;
    if (run.halt?.kind === 'lost') return;
    run.halt = request;
    // T3 (design §3 "Concurrency"): a DRAIN halt (a spend-limit pause) must
    // NOT abort what is already running — the whole point is letting each
    // live specialist's already-in-flight reply, and that reply's tools,
    // finish normally; only settle's drain deadline aborts a straggler.
    // `launchAbort` still fires so nothing NEW starts (a specialist still
    // waiting for a free slot stops waiting) — that part matches every
    // other halt.
    run.launchAbort.abort();
    const draining = request.kind === 'pause' && request.drain === true;
    if (!draining) {
      for (const child of run.live) {
        if (!child.outcome) child.handle.abort();
      }
    }
    run.fireHalt();
  }

  /**
   * T3 (design §3 "Concurrency"): the FIRST attempt whose spend write crosses
   * the plan's limit calls this (via the `markLimitReached` closure
   * `memberStart` hands `runner.launch()`) to turn the crossing into a
   * visible pause. The synchronous half already happened in the caller
   * (`run.limitReached = true`, seen at once by every sibling's own
   * `beforeRequest`); this half re-reads the plan for the limit's actual
   * value (for the card) and requests the halt — `drain: true`, so
   * `requestHalt` does NOT abort anyone: every live specialist keeps running
   * until its own next `beforeRequest` ends its turn, or until settle's
   * drain deadline forces it. `requestHalt`'s own "first reason wins" guard
   * makes a second crossing (a different sibling, or a sibling's own
   * specialist-error/interrupted pause once it lands) a no-op, so the plan
   * pauses exactly once no matter how many attempts cross or land after it.
   */
  private requestSpendLimitDrain(run: ActiveRun, stepId: string): void {
    void (async () => {
      let limit: PlanSpendLimit | undefined;
      try { limit = (await this.load(run)).spendLimit; } catch { /* the run may already be gone; pause with no limit named */ }
      this.requestHalt(run, {
        kind: 'pause', why: 'spend-limit', drain: true, stepId, limit, reason: spendLimitReason(limit),
      });
    })();
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
      this.retireRun(run);
      // Follow-up: a fast Continue may already have a newer run of this plan
      // finishing under the same key; only this run's own entry is removed.
      if (this.finishing.get(run.key) === run) this.finishing.delete(run.key);
    }
  }

  /** Stop the heartbeat and take the run out of the active set (idempotent). */
  private retireRun(run: ActiveRun): void {
    this.timers.clearInterval(run.heartbeat);
    run.heartbeat = undefined;
    if (this.runs.get(run.key) === run) {
      this.runs.delete(run.key);
      this.finishing.set(run.key, run);
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
   * earlier run means (design §3 resume, revised by §3 "Crash safety" for the
   * spending rework): a `prepared` attempt never sent a request and is simply
   * restartable; a `launched` one is read through `classifyChildTranscript` —
   * terminal → commit with no request; an unanswered EXTERNAL call → paused
   * (never auto-replayed) via the same routing every recoverable failure uses.
   *
   * // Review R1/R2: the OLD "ambiguityReported" flag (deleted from the
   * schema — design §2) broke the loop where Continue on THIS pause would
   * otherwise re-run this exact check and pause again for the identical
   * unanswered call. Its durable replacement is `PlanAttemptRecord.
   * pauseAcknowledged`, set (in `settle`'s `finalWrite`) the moment the pause
   * itself becomes visible and consumed right here (recoverAttempt) the next
   * time this attempt is looked at — which can only be through the person's
   * own Continue, since nothing else restarts a paused plan — so that start
   * restarts the specialist with the check-first turn instead of re-pausing
   * (Revision 1 D6's promised test).
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

  /**
   * WHY this charges nothing and has no `ambiguous`/`request-sent` branch any
   * more (spending rework stage 1, design §3 "Crash safety"): plan children
   * now use the ordinary request path, so an interrupted model request has no
   * effect outside the computer — there is nothing to release, nothing
   * unresolved to charge, and no separate unsettled phase to detect an
   * input-side breach in. A `prepared` attempt never sent a request and is
   * simply restartable; a `launched` one goes through the SAME transcript
   * classification every restart uses: a finished report commits it with no
   * request, an unanswered call is never replayed automatically when it could
   * have changed something outside this computer (routed exactly as before,
   * via `routePlanPause`/`hasRecovery`), and anything else restarts.
   */
  private async recoverAttempt(run: ActiveRun, def: PlanStepV1, original: PlanAttemptRecord, finalLeaf: boolean): Promise<HaltRequest | undefined> {
    const stepId = def.id;
    const { attemptId } = original;
    if (original.phase === 'prepared') return undefined;
    const verdict: TranscriptVerdict = original.childId
      ? this.runner.inspectTranscript(run.ref, original.childId)
      : { kind: 'resumable', briefDelivered: false };
    if (verdict.kind === 'terminal') {
      return this.commitReport(run, def, attemptId, verdict.report, finalLeaf);
    }
    if (verdict.kind === 'dangling-effect') {
      // Review R2: `original.pauseAcknowledged` means the LAST time this
      // exact dangling call was found, the pause it produced was already
      // written (settle's `finalWrite` sets it in the same write). A paused
      // plan runs again only through `PlanService.resume` — the person's own
      // Continue — so reaching this attempt again with the flag still set
      // means that press already happened: skip the pause and restart with
      // the check-first turn (decision 13), never show the identical pause
      // twice. Consumed once, before anything else runs, so a fresh crash
      // (no prior pause) or a genuinely NEW dangling call still classifies
      // and pauses normally.
      if (original.pauseAcknowledged) {
        await this.journal.mutateFenced(run.ref, run.planId, run.fence, (plan) => {
          delete this.findAttempt(plan, stepId, attemptId).pauseAcknowledged;
        });
        return undefined;
      }
      const cause: PlanRecoveryCause = 'unknown-outcome';
      const key = { stepId, iteration: original.iteration, itemIndex: original.itemIndex };
      // Review finding 10 (decision 26): the restart-time self-recovery is the
      // other route to an automatic relaunch. Its relaunch would be stopped by
      // launch()'s own check a moment later, but asking here means the person
      // is never shown a pause that claims the plan picked itself up when it
      // could not. Local and free — the same hook restartAfter uses.
      const notReady = await this.runner.providerNotReady?.(run.ref, await this.load(run), def.specialist);
      // Task 9a (pause handoff §1): a cut-off call that could only read or
      // change this computer is picked up again by itself — once. The
      // recovery is journalled (fenced) in the same write that makes the
      // attempt restartable, before anything is relaunched.
      const decided = await this.journal.mutateFenced(run.ref, run.planId, run.fence, (plan) => {
        const routing = routePlanPause(cause, {
          toolEffect: verdict.effect, unansweredExternal: verdict.effect === 'external',
          alreadyRecovered: hasRecovery(plan, key, cause),
          ...(notReady !== undefined ? { notReady: true } : {}),
        });
        if (routing.route === 'auto') {
          recordRecovery(plan, key, cause);
          return { auto: true as const };
        }
        return { auto: false as const, retried: hasRecovery(plan, key, cause) };
      });
      if (decided.auto) return undefined;
      return {
        kind: 'pause', stepId, attemptId,
        why: 'unknown-outcome' as const, tool: verdict.tool, toolEffect: verdict.effect,
        ...(decided.retried ? { retried: true as const } : {}),
        reason: `A specialist in step "${stepId}" was cut off after starting its last action (${verdict.tool}), and it isn't known whether that finished. `
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

  /**
   * Design §3's `createAttempts` — replaces the deleted `PlanBudget.
   * reserveAttempts` (spending rework stage 1). One fenced append of fresh
   * attempt records: a member naming an existing `attemptId` is a restart
   * (creates nothing); one naming `reportOnlyOf` is the report-only retry of
   * a failed attempt, continuing its item/iteration; anything else is a
   * fresh item. WHY unconditional: there is no allowance left to reserve, and
   * — T3 — the wave-start spend-limit check ("runWave first checks used ≥
   * limit on the plan it loaded", design §3) is not built here.
   */
  private async createAttempts(
    ref: PlanRef, planId: string, fence: string, members: CreateAttemptMember[],
  ): Promise<{ attempts: Array<{ stepId: string; attemptId: string }> }> {
    return this.journal.mutateFenced(ref, planId, fence, (plan) => {
      const attempts = members.map((member) => {
        if (member.attemptId !== undefined) return { stepId: member.stepId, attemptId: member.attemptId };
        const stepRec = plan.steps.find((s) => s.id === member.stepId)!;
        const attemptId = randomUUID();
        const record: PlanAttemptRecord = {
          attemptId, itemIndex: member.itemIndex ?? 0, iteration: member.iteration ?? 0,
          spentTokens: 0, phase: 'prepared',
        };
        if (member.reportOnlyOf !== undefined) {
          record.reportOnly = true;
          // T1-fix-round bug (found in review): a report-only retry must
          // CONTINUE the failed attempt's own specialist session, not start a
          // fresh one — that is the whole point of "tools off, ask the same
          // session for its report again". Without copying `childId` here,
          // `launchBrief`'s `attempt.childId` check (memberStart's caller)
          // always saw `undefined`, so `runner.launch()` never received
          // `resumeChildId` and every report-only retry silently spawned a
          // brand-new specialist instead of continuing the one whose report
          // was rejected.
          const failed = stepRec.attempts.find((a) => a.attemptId === member.reportOnlyOf);
          if (failed?.childId) record.childId = failed.childId;
        }
        if (member.brief !== undefined) record.brief = member.brief;
        stepRec.attempts.push(record);
        return { stepId: member.stepId, attemptId };
      });
      return { attempts };
    });
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
      // T3 (design §3 "Concurrency", Revision 2 E2/E3): the local engine's one
      // shared context pool means at most ONE local-engine plan specialist
      // may run at a time — a headcount cap, not a token-math one. A step's
      // binding is frozen once per LEAF STEP (design §5), so every item of
      // THIS map step shares it; serializing the step is enough (this
      // executor never runs two steps concurrently — `walk`/`runRepeat` are
      // already sequential — so there is no cross-step case to also guard).
      // Cloud-bound steps are untouched: `local` is false and `width` is
      // exactly what it was before this task.
      const local = isLocalEngineStep(plan, step.id);
      const width = (writer || local) ? 1 : cap;
      for (let at = 0; at < needed.length; at += width) {
        if (run.halt) return;
        await this.runWave(run, step, iteration, needed.slice(at, at + width), !!repeat?.finalLeaf);
        if (run.halt) return;
      }
    }
    if (!repeat && !run.halt) await this.setStatus(run, [step.id], 'done');
  }

  // WHY no launchRefusal check and no reservation/reservePause any more
  // (spending rework stage 1, design §1): nothing refuses a launch for
  // budget reasons, and `createAttempts` (below) cannot fail for one either.
  private async runWave(run: ActiveRun, step: PlanStepV1, iteration: number, items: number[], finalLeaf: boolean): Promise<void> {
    let plan = await this.load(run);
    // T3 (design §3: "runWave first checks used ≥ limit on the plan it
    // loaded, so no new wave starts past the limit"). Checked BEFORE
    // createAttempts, so a plan already at (or resumed above) its limit
    // never grows a step record for work that will never launch — this
    // covers a fresh wave AND the next slice of the same step (a map with
    // more items than the cap runs several waves in sequence, each one
    // re-checking here) with one site. Retries an already-live wave triggers
    // (a specialist error's or an invalid report's one automatic relaunch)
    // don't need a second check here: the only way `used` can cross the
    // limit WHILE a wave is live is a reply's own spend write, and that
    // already sets `run.halt` via `requestSpendLimitDrain` before any retry
    // logic (`restartAfter`/`reportOnlyRetry`/`memberStart`'s own retry loop)
    // runs — every one of them already refuses to act once `run.halt` is set.
    if (spendLimitCrossed(plan)) {
      this.requestHalt(run, {
        kind: 'pause', why: 'spend-limit', stepId: step.id, limit: plan.spendLimit, reason: spendLimitReason(plan.spendLimit),
      });
      return;
    }
    const rec = plan.steps.find((s) => s.id === step.id)!;
    const members: CreateAttemptMember[] = items.map((itemIndex) => {
      const latest = latestAttempt(rec, itemIndex, iteration);
      if (latest && !isCommitted(latest)) return { stepId: step.id, attemptId: latest.attemptId };
      // Final review F4: an item whose newest attempt failed its report (the
      // only way an attempt is committed as `failed`) was paused for the
      // person. Their Continue asks that SAME specialist for its report with
      // tools off — never a fresh full run, which would repeat every command
      // and edit the first run already made. A report-only turn that failed
      // too is asked again with its own message, so a delivered message is
      // answered with the short nudge (launchBrief).
      if (latest && latest.terminal === 'failed' && latest.childId) {
        return {
          stepId: step.id, reportOnlyOf: latest.attemptId, itemIndex: latest.itemIndex, iteration: latest.iteration,
          brief: latest.reportOnly && latest.brief !== undefined
            ? latest.brief
            : planReportOnlyBrief({ finalLeaf, problem: invalidReportProblem(step.id, latest.reportText ?? '', finalLeaf) ?? '' }),
        };
      }
      return { stepId: step.id, itemIndex, iteration };
    });
    // One fenced write creates the whole wave's attempt records (design §3).
    const created = await this.createAttempts(run.ref, run.planId, run.fence, members);
    plan = await this.load(run);
    const briefBase = this.briefFor(plan, step, iteration, finalLeaf);
    const wave: LiveChild[] = [];
    // Task 9a (pause handoff §1): each member runs to its own end. A member
    // that fails in a recoverable way is retried HERE, inside the wave, while
    // its siblings keep running; only a pause for the assistant or the user
    // halts the wave.
    await Promise.race([
      Promise.all(created.attempts.map(({ attemptId }) => this.runMember(run, step, attemptId, briefBase, finalLeaf, wave))),
      run.haltSignal,
    ]);
    if (run.halt) return;
    // Every member is finished and journalled: free their sessions and slots
    // before the next wave or step starts.
    await Promise.all(wave.map((c) => c.handle.dispose()));
    run.live = run.live.filter((c) => !wave.includes(c));
  }

  /** What one launch sends: the brief, the restart turn, or the report-only
   *  message with tools off (Task 9a). */
  private launchBrief(run: ActiveRun, attempt: PlanAttemptRecord, briefBase: (itemIndex: number) => string): { brief: string; toolsDisabled?: true } {
    if (attempt.reportOnly) {
      const message = attempt.brief ?? planReportOnlyBrief({ finalLeaf: false, problem: '' });
      // Review fix 2: already delivered (it paused after sending it) → a
      // short nudge, so the session never holds the message twice.
      const delivered = attempt.childId !== undefined && this.runner.latestUserText?.(run.ref, attempt.childId) === message;
      return { brief: delivered ? PLAN_REPORT_ONLY_RESEND : message, toolsDisabled: true };
    }
    let brief = briefBase(attempt.itemIndex);
    if (attempt.childId) {
      // Review item 3: once the brief has reached the specialist, a restart
      // never sends it again — only the fresh continue turn (naming any
      // action whose outcome is unknown, item 4).
      const verdict = this.runner.inspectTranscript(run.ref, attempt.childId);
      if (!(verdict.kind === 'resumable' && !verdict.briefDelivered)) brief = planRestartBrief(verdict);
    }
    return { brief };
  }

  /** Drop a finished member's specialist before it is restarted (frees its
   *  slot and lets the restart rebuild the session from its transcript). */
  private async retire(run: ActiveRun, wave: LiveChild[], child: LiveChild): Promise<void> {
    await child.handle.dispose();
    run.live = run.live.filter((c) => c !== child);
    const i = wave.indexOf(child);
    if (i >= 0) wave.splice(i, 1);
  }

  /**
   * Review fix 1: register member work that settle must wait for. Everything a
   * wave member does EXCEPT waiting on its specialist's own turn (launching,
   * re-reserving, journalling, retiring a session) is tracked, and settle
   * drains it before it tears anything down — otherwise a pause could be
   * written while a sibling's retry was still reserving or launching, leaving
   * a paused plan holding budget or a specialist nobody disposes.
   */
  private track<T>(run: ActiveRun, work: Promise<T>): Promise<T> {
    const done = work.then(() => undefined, () => undefined);
    run.busy.add(done);
    void done.then(() => run.busy.delete(done));
    return work;
  }

  /**
   * One wave member, from launch to its journalled end (Task 9a). Recoverable
   * failures (pause handoff §1) are retried here once each; everything else
   * halts the plan exactly as before.
   */
  private async runMember(
    run: ActiveRun, step: PlanStepV1, firstAttemptId: string, briefBase: (itemIndex: number) => string,
    finalLeaf: boolean, wave: LiveChild[],
  ): Promise<void> {
    const member: MemberState = { attemptId: firstAttemptId };
    for (;;) {
      const child = await this.track(run, this.memberStart(run, step, member, briefBase, finalLeaf, wave));
      if (!child) return;
      // The one untracked wait: the specialist's own turn. Settle bounds it
      // with its deadline and disposal.
      const outcome = await child.handle.outcome;
      child.outcome = outcome;
      const next = await this.track(run, this.memberEnd(run, step, member, child, outcome, finalLeaf, wave));
      if (next !== 'retry') return;
    }
  }

  /** Launch the member's current attempt (retrying a failed start once).
   *  Resolves to the live child, or undefined when the member is finished. */
  private async memberStart(
    run: ActiveRun, step: PlanStepV1, member: MemberState, briefBase: (itemIndex: number) => string,
    finalLeaf: boolean, wave: LiveChild[],
  ): Promise<LiveChild | undefined> {
    for (;;) {
      const attemptId = member.attemptId;
      try {
        if (run.halt) return undefined;
        const attempt = this.findAttempt(await this.load(run), step.id, attemptId);
        const { brief, toolsDisabled } = this.launchBrief(run, attempt, briefBase);
        if (run.halt) return undefined;
        // Review fix 3: only a retry that really relaunches marks the row.
        const relaunching = member.recovered;
        let handle: PlanChildHandle;
        try {
          handle = await this.runner.launch({
            ref: run.ref, planId: run.planId, fence: run.fence, stepId: step.id, attemptId,
            itemIndex: attempt.itemIndex, iteration: attempt.iteration, specialist: step.specialist, brief,
            ...(attempt.childId ? { resumeChildId: attempt.childId } : {}),
            ...(toolsDisabled ? { toolsDisabled: true } : {}),
            signal: run.launchAbort.signal,
            // T2 (design §3 "Concurrency"): closures over THIS run's shared
            // flags, not the flags themselves — every attempt this wave (and
            // every later wave of the same run) launches gets the SAME `run`
            // object, so one sibling's crossing is visible to every other's
            // own beforeRequest check.
            isLimitReached: () => run.limitReached === true,
            // T3: the synchronous flag first (every sibling's own
            // `beforeRequest` must see it at once), then — once, idempotent —
            // turn the crossing into an actual drain-and-pause. See
            // `requestSpendLimitDrain`'s own WHY comment.
            markLimitReached: () => {
              if (run.limitReached) return;
              run.limitReached = true;
              this.requestSpendLimitDrain(run, step.id);
            },
            isWriteFailed: () => run.spendWriteFailed === true,
            markWriteFailed: () => { run.spendWriteFailed = true; },
            recordChild: (childId, info) => this.journal.mutateFenced(run.ref, run.planId, run.fence, (p) => {
              const a = this.findAttempt(p, step.id, attemptId);
              a.childId = childId;
              // Review R1 fix: this callback is the runner's contractual
              // promise (PlanChildLaunch.recordChild's own doc-comment) that
              // it runs "after the session exists and BEFORE anything is
              // sent" — the earliest point a request could go out. Until now
              // 'prepared' must mean "provably nothing was sent"; from here
              // on it no longer does, so the attempt moves to 'launched' RIGHT
              // HERE, not after the turn resolves. A crash any time after this
              // write therefore always goes through recoverAttempt's
              // transcript classification instead of skipping it (the bug
              // R1 found: phase never left 'prepared', so an unanswered
              // EXTERNAL tool call was silently auto-resumed).
              a.phase = 'launched';
              // Review item 6: what the card's specialist row shows.
              if (info?.title) a.childTitle = info.title;
              a.startedAt = Date.now();
              a.brief = brief;
              // The spawn-time manifest entry actually used (design §2/§5:
              // the binding/pricing slice is keyed by STEP now, not specialist).
              const specialistEntry = p.manifest.specialists[step.specialist];
              const stepEntry = p.manifest.steps[step.id];
              a.manifest = {
                ...p.manifest,
                specialists: specialistEntry ? { [step.specialist]: specialistEntry } : {},
                steps: stepEntry ? { [step.id]: stepEntry } : {},
              };
              if (relaunching) markRelaunched(p, { stepId: step.id, iteration: a.iteration, itemIndex: a.itemIndex }, relaunching);
            }),
          });
        } catch (e) {
          if (isJournalError(e)) { this.onJournalError(run, e); return undefined; }
          if (run.halt) return undefined;
          const drift = e instanceof PlanLaunchDriftError;
          const refused = e instanceof PlanLaunchRefusedError;
          // Task 13 (decision 26): the runner already proved the provider
          // can't run, so there is nothing to ask about and nothing to retry.
          const thrownNotReady = e instanceof PlanNotReadyError ? errorText(e) : undefined;
          const base = `A specialist in step "${step.id}" couldn't start: ${errorText(e)}`;
          const again = drift || refused || thrownNotReady !== undefined
            ? undefined : await this.restartAfter(run, step, attemptId, 'launch-failed');
          if (again === 'retry') { member.recovered = 'launch-failed'; continue; }
          if (again !== 'halted') {
            const notReady = thrownNotReady ?? again?.notReady;
            this.requestHalt(run, {
              kind: 'pause', why: 'launch-failed', stepId: step.id, attemptId,
              // The provider's own sentence is what tells the person what to
              // fix. When the start failed WITH it, it is already here.
              reason: notReady && !base.includes(notReady) ? joinSentences(base, notReady) : base,
              ...(drift ? { launch: 'drift' as const } : refused ? { launch: 'refused' as const }
                : notReady ? { launch: 'not-ready' as const } : {}),
              ...(again?.retried ? { retried: true as const } : {}),
            });
          }
          return undefined;
        }
        member.recovered = undefined;
        const child: LiveChild = { stepId: step.id, attemptId, handle, finalLeaf };
        run.live.push(child);
        wave.push(child);
        const halted = currentHalt(run);
        if (halted) {
          // T3: a DRAIN halt (a spend-limit pause) must not abort this one
          // either — its launch simply landed a little later than the
          // sibling whose crossing started the drain, and it is exactly as
          // "already running" as any other live child at this point. Left
          // alone, it runs its own turn and settle's drain wait covers it
          // like every other one — UNLESS settle's own busy-wait already
          // gave up on it (`run.closed`), which still tears it down below
          // regardless of drain (the same "a start that never comes back
          // must not keep the card from settling" rule non-drain halts use).
          const stillDraining = halted.kind === 'pause' && halted.drain === true && !run.closed;
          if (stillDraining) return child;
          handle.abort();
          // Settle already ran its disposals: nobody else would free this one.
          if (run.closed) {
            await handle.dispose();
            run.live = run.live.filter((c) => c !== child);
          }
          return undefined;
        }
        return child;
      } catch (e) {
        this.memberFailed(run, step.id, attemptId, e);
        return undefined;
      }
    }
  }

  /** A member's own work threw (a journal write while retrying, say): pause on
   *  that specialist with the real message, never an escaped rejection. */
  private memberFailed(run: ActiveRun, stepId: string, attemptId: string, e: unknown): void {
    if (isJournalError(e)) { this.onJournalError(run, e); return; }
    this.requestHalt(run, { kind: 'pause', why: 'unexpected-error', stepId, attemptId, reason: `The plan stopped because of an unexpected problem: ${errorText(e)}` });
  }

  /** Journal what the member's turn produced and decide: done, or retry. */
  private async memberEnd(
    run: ActiveRun, step: PlanStepV1, member: MemberState, child: LiveChild, outcome: PlanChildOutcome,
    finalLeaf: boolean, wave: LiveChild[],
  ): Promise<'retry' | 'done'> {
    const { attemptId } = child;
    if (outcome.kind === 'completed') {
      let invalid: HaltRequest | undefined;
      // Set synchronously: settle commits a finished report itself only when
      // no commit is under way.
      child.commit = (async () => {
        try {
          invalid = await this.commitReport(run, step, attemptId, outcome.report, finalLeaf, child.handle);
        } catch (e) {
          if (!isJournalError(e)) {
            this.requestHalt(run, { kind: 'pause', why: 'unexpected-error', stepId: step.id, attemptId, reason: `A specialist's result couldn't be saved: ${errorText(e)}` });
          } else this.onJournalError(run, e);
        }
      })();
      await child.commit;
      if (!invalid) return 'done';
      // WHY (T2 review S1): only an INVALID REPORT earns the automatic
      // report-only retry. A pause for any other reason — e.g. the spend
      // record couldn't be saved (PLAN_PROGRESS_NOT_SAVED) — must pause for
      // the user as-is, never be fed back to the specialist as "feedback".
      if (run.halt || invalid.kind !== 'pause' || invalid.why !== 'invalid-report') { this.requestHalt(run, invalid); return 'done'; }
      try {
        const next = await this.reportOnlyRetry(run, step, wave, child, invalid, finalLeaf);
        if (next === undefined) return 'done';
        member.attemptId = next;
        member.recovered = 'invalid-report';
        return 'retry';
      } catch (e) {
        this.memberFailed(run, step.id, attemptId, e);
        return 'done';
      }
    }
    try {
      if (run.halt) return 'done';
      if (outcome.kind === 'interrupted') {
        this.requestHalt(run, {
          kind: 'pause', why: 'specialist-stopped', stepId: step.id, attemptId,
          reason: `A specialist in step "${step.id}" was stopped before it finished.`,
        });
        return 'done';
      }
      // A specialist error: its session is dropped first, so its transcript
      // is complete on disk before the routing check reads it.
      await this.retire(run, wave, child);
      const base = `A specialist in step "${step.id}" stopped with an error: ${outcome.detail}`;
      const again = await this.restartAfter(run, step, attemptId, 'specialist-error');
      if (again === 'retry') { member.recovered = 'specialist-error'; return 'retry'; }
      if (again === 'halted') return 'done';
      // Task 13 (decision 26): the card must carry the provider's own sentence
      // about what to fix. In the bug this task exists for the specialist died
      // WITH that sentence, so nothing is added; when the error said something
      // else, the provider's words follow it rather than replace them.
      const notReady = again.notReady;
      const reason = notReady && !base.includes(notReady) ? joinSentences(base, notReady) : base;
      if (again.unanswered) {
        // The error left an outside action with no result: this pause
        // shows it, so Continue restarts with the check-first turn instead
        // of pausing a second time for the same thing.
        const { tool } = again.unanswered;
        this.requestHalt(run, {
          kind: 'pause', why: 'unknown-outcome', stepId: step.id, attemptId, tool, toolEffect: 'external',
          ...(again.retried ? { retried: true as const } : {}),
          ...(notReady ? { launch: 'not-ready' as const } : {}),
          // joinSentences, not `${reason}.`: when the provider's own sentence
          // was appended above it already ends in a full stop (finding 7).
          reason: `${joinSentences(reason, `Its last action (${tool}) has no recorded result, so it isn't known whether it finished.`)} `
            + 'Press Continue to let it check and pick up from what it recorded.',
        });
        return 'done';
      }
      this.requestHalt(run, {
        kind: 'pause', why: 'specialist-error', stepId: step.id, attemptId, reason,
        ...(again.retried ? { retried: true as const } : {}),
        ...(notReady ? { launch: 'not-ready' as const } : {}),
      });
      return 'done';
    } catch (e) {
      // WHY: an unexpected throw here must still end the wave (a pause
      // with the real message), or the plan would wait forever.
      this.memberFailed(run, step.id, attemptId, e);
      return 'done';
    }
  }

  /**
   * Task 9a: may this unfinished attempt be restarted by itself after `cause`?
   * If so, the recovery is journalled (fenced) BEFORE anything else and
   * 'retry' is returned. Otherwise the facts for the pause are returned.
   * WHY no "charge unresolved" step any more (spending rework stage 1,
   * design §3 "Crash safety"): nothing is reserved to release or charge —
   * `afterReply` (T2) already recorded whatever the specialist's last reply
   * actually cost, if any.
   */
  private async restartAfter(
    run: ActiveRun, step: PlanStepV1, attemptId: string, cause: 'launch-failed' | 'specialist-error',
  ): Promise<'retry' | 'halted' | { retried?: true; unanswered?: { tool: string }; notReady?: string }> {
    const loaded = await this.load(run);
    const before = this.findAttempt(loaded, step.id, attemptId);
    const verdict: TranscriptVerdict = before.childId
      ? this.runner.inspectTranscript(run.ref, before.childId)
      : { kind: 'resumable', briefDelivered: false };
    const unanswered = verdict.kind === 'dangling-effect' && verdict.effect === 'external' ? { tool: verdict.tool } : undefined;
    const key = { stepId: step.id, iteration: before.iteration, itemIndex: before.itemIndex };
    // Review fix 1: once the plan is halting, no retry is started (and none
    // is recorded); the settle gives back whatever this attempt holds.
    if (run.halt) return 'halted';
    // Task 13 (decision 26): before ANY automatic retry of a launch failure or
    // a specialist error, ask whether that specialist's provider can still run
    // at all. Destin, 2026-09-18: the plan spent its one retry re-running a
    // launch that had died with "Sign in with ChatGPT…", which could never
    // succeed. This is a fact from the provider registry, never a string match
    // on the error text.
    const notReady = await this.runner.providerNotReady?.(run.ref, loaded, step.specialist);
    const decided = await this.journal.mutateFenced(run.ref, run.planId, run.fence, (plan) => {
      const ctx: PlanPauseContext = {
        unansweredExternal: !!unanswered, alreadyRecovered: hasRecovery(plan, key, cause),
        ...(notReady !== undefined ? { notReady: true } : {}),
      };
      if (routePlanPause(cause, ctx).route !== 'auto') return { auto: false as const, retried: ctx.alreadyRecovered === true };
      // The recovery, journalled before the relaunch, so a crash can't
      // multiply it (design §3).
      recordRecovery(plan, key, cause);
      return { auto: true as const };
    });
    if (!decided.auto) {
      return {
        ...(decided.retried ? { retried: true as const } : {}), ...(unanswered ? { unanswered } : {}),
        ...(notReady !== undefined ? { notReady } : {}),
      };
    }
    // Halted meanwhile: nothing is relaunched (settle handles it).
    return run.halt ? 'halted' : 'retry';
  }

  /**
   * Task 9a: an invalid report is asked for once more, on the same specialist
   * session, with one dedicated message and tools off. Returns the new
   * attempt, or undefined when the plan was halted instead.
   * WHY no funding check any more (spending rework stage 1, decision 34):
   * nothing is rationed per attempt, so a report-only retry is always
   * fundable — `reportOnlyFundable` stays `true` unconditionally below only
   * because `PlanPauseContext` still carries the field (pause-routing.ts).
   */
  private async reportOnlyRetry(
    run: ActiveRun, step: PlanStepV1, wave: LiveChild[], child: LiveChild,
    invalid: Extract<HaltRequest, { kind: 'pause' }>, finalLeaf: boolean,
  ): Promise<string | undefined> {
    await this.retire(run, wave, child);
    const failed = this.findAttempt(await this.load(run), step.id, child.attemptId);
    const verdict: TranscriptVerdict = failed.childId
      ? this.runner.inspectTranscript(run.ref, failed.childId)
      : { kind: 'resumable', briefDelivered: false };
    const key = { stepId: step.id, iteration: failed.iteration, itemIndex: failed.itemIndex };
    const message = planReportOnlyBrief({ finalLeaf, problem: invalid.reason });
    const plan = await this.load(run);
    // Review finding 10 (decision 26): the report-only re-send is a second
    // route to an automatic retry. A provider that cannot run cannot answer a
    // report turn either, so it is asked here too rather than only in
    // restartAfter.
    const notReady = await this.runner.providerNotReady?.(run.ref, plan, step.specialist);
    if (run.halt) { this.requestHalt(run, invalid); return undefined; }
    const decided = await this.journal.mutateFenced(run.ref, run.planId, run.fence, (plan) => {
      const ctx: PlanPauseContext = {
        reportOnlyFundable: true,
        unansweredExternal: verdict.kind === 'dangling-effect' && verdict.effect === 'external',
        alreadyRecovered: hasRecovery(plan, key, 'invalid-report'),
        ...(notReady !== undefined ? { notReady: true } : {}),
      };
      if (routePlanPause('invalid-report', ctx).route !== 'auto') return { auto: false as const, retried: ctx.alreadyRecovered === true };
      recordRecovery(plan, key, 'invalid-report');
      return { auto: true as const };
    });
    if (!decided.auto) {
      this.requestHalt(run, { ...invalid, attemptId: child.attemptId, ...(decided.retried ? { retried: true as const } : {}) });
      return undefined;
    }
    const created = await this.createAttempts(run.ref, run.planId, run.fence, [{
      stepId: step.id, reportOnlyOf: child.attemptId, itemIndex: failed.itemIndex, iteration: failed.iteration,
      brief: message,
    }]);
    return run.halt ? undefined : created.attempts[0].attemptId;
  }

  /**
   * Freeze one finished attempt with the journal's OWN spent count (plan-
   * budget's contract). WHY no "charge unresolved" phase check any more
   * (spending rework stage 1, design §3): a `launched` attempt has no
   * unsettled request state left to resolve — `afterReply` (T2) already
   * journals every reply's real cost as it happens. A repeat's final leaf
   * must also carry a valid decision; a malformed one is kept (as failed)
   * and pauses.
   *
   * T2 (Revision 2 E4 / Revision 3 F2): this is the one function all three
   * commit paths call. `handle` is absent only from the start-time recovery
   * call (`recoverAttempt`'s `terminal` verdict) — that runs before ANY
   * specialist of this run's process is live, so there is no in-flight write
   * to wait for; the other two calls (a member finishing live, and settle
   * picking up a straggler) always have one. `await handle.spendSettled()`
   * first, so a report can never commit ahead of the spend it cost; a
   * recorded write failure (shared across the run — design §3) pauses
   * instead of committing, rather than freezing a report next to an
   * uncertain total.
   */
  private async commitReport(
    run: ActiveRun, step: PlanStepV1, attemptId: string, report: string, finalLeaf: boolean, handle?: PlanChildHandle,
  ): Promise<HaltRequest | undefined> {
    if (handle) await handle.spendSettled();
    if (run.spendWriteFailed) {
      return { kind: 'pause', why: 'unexpected-error', stepId: step.id, attemptId, reason: PLAN_PROGRESS_NOT_SAVED };
    }
    const plan = await this.load(run);
    const attempt = this.findAttempt(plan, step.id, attemptId);
    if (isCommitted(attempt)) return undefined;
    const failure = invalidReportProblem(step.id, report, finalLeaf);
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
    // 0. Review fix 1: members still launching, re-reserving or journalling
    //    finish first (they stop at once now that the plan is halted), so
    //    every specialist they started is in `run.live` and every hold they
    //    took is released below.
    //    Follow-up: bounded by the same settle deadline — a start that never
    //    comes back must not keep the card from settling. Whatever is left is
    //    logged; a hold it takes later is released by recoverAttempt on the
    //    next start, and a specialist it starts later is disposed (run.closed).
    const busyDeadline = Date.now() + this.settleDeadlineMs;
    while (run.busy.size > 0) {
      const left = busyDeadline - Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        Promise.all([...run.busy]).then(() => false),
        new Promise<boolean>((r) => { timer = setTimeout(() => r(true), Math.max(0, left)); }),
      ]);
      if (timer) clearTimeout(timer);
      if (timedOut) {
        console.error(`[plan-executor] settling plan ${run.planId} while ${run.busy.size} specialist start(s) are still busy`);
        break;
      }
    }
    run.closed = true;
    // 1. Everything still running was already asked to stop (requestHalt, or
    //    runWave for a launch that landed after the halt) and gets until the
    //    deadline to finish on its own. T3 (design §3 "Concurrency"): a DRAIN
    //    halt (a spend-limit pause) is the one exception — `requestHalt`
    //    deliberately did NOT abort anyone, so this wait is really "let every
    //    live specialist reach its own next `beforeRequest` and end its turn
    //    there", and it gets the longer drain deadline instead of the normal
    //    settle one.
    const draining = run.halt?.kind === 'pause' && run.halt.drain === true;
    let pending = run.live.filter((c) => !c.outcome);
    if (pending.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(pending.map((c) => c.handle.outcome)),
        new Promise<void>((r) => { timer = setTimeout(r, draining ? this.drainDeadlineMs : this.settleDeadlineMs); }),
      ]);
      if (timer) clearTimeout(timer);
    }
    // 1b. T3: the drain deadline passed with something still going (a stuck
    //     specialist, or one waiting on a permission ask, which never times
    //     out on its own) — abort it now and give it the same window a
    //     non-drain halt already gets, "then aborts as before" (design §3).
    if (draining) {
      pending = run.live.filter((c) => !c.outcome);
      if (pending.length > 0) {
        for (const child of pending) child.handle.abort();
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.all(pending.map((c) => c.handle.outcome)),
          new Promise<void>((r) => { timer = setTimeout(r, this.settleDeadlineMs); }),
        ]);
        if (timer) clearTimeout(timer);
      }
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
        pauseFromCommit ??= await this.commitReport(run, step, child.attemptId, child.outcome.report, child.finalLeaf, child.handle);
      }
      // WHY no "pessimistic settlement" pass any more (spending rework stage
      // 1, design §1/§3): there is no reservation left to charge in full or
      // give back — `afterReply` (T2) already journals real cost as it
      // happens, and a still-`launched` attempt at settle time is simply
      // read again by `recoverAttempt` the next time this plan starts.
      // 5. Only now does the card change — in the same write that drops the lease.
      const final = halt.kind === 'complete' && pauseFromCommit ? pauseFromCommit : halt;
      // Nothing of this run may outlive the visible write below (settle before
      // visible): the heartbeat stops and the run leaves the active set now.
      this.retireRun(run);
      if (final.kind === 'stop') {
        // Review item 8: PlanService's "stopped" edit rides in this same
        // write, so a crash can never leave a released-but-running plan.
        await this.finalWrite(run, (p) => {
          delete p.lease;
          final.finalize?.(p);
        });
        final.applied = final.finalize !== undefined;
        return;
      }
      await this.finalWrite(run, (p) => {
        delete p.lease;
        if (final.kind === 'complete') {
          p.status = 'completed';
          p.endedAt = Date.now();
          for (const s of p.steps) if (s.status !== 'skipped') s.status = 'done';
          return;
        }
        for (const s of p.steps) if (s.status === 'running') s.status = 'paused';
        if (final.kind === 'pause') {
          p.status = 'paused';
          p.paused = {
            stepId: final.stepId, reason: final.reason,
            kind: final.why,
            ...(final.tool ? { tool: final.tool } : {}),
            ...(final.repeat ? { repeat: final.repeat } : {}),
            ...(final.attemptId ? { attemptId: final.attemptId } : {}),
            ...(final.launch ? { launch: final.launch } : {}),
            ...(final.retried ? { retried: true as const } : {}),
            ...(final.toolEffect ? { toolEffect: final.toolEffect } : {}),
            // T3 (design §2/§7): the limit a `spend-limit` pause hit, for the
            // card's "Reached your $X limit." `drain` itself is not stored —
            // it only ever governed HOW this halt settled, not the pause the
            // person ends up seeing.
            ...(final.limit ? { limit: final.limit } : {}),
          };
          const s = p.steps.find((x) => x.id === final.stepId);
          if (s && s.status !== 'done') s.status = 'paused';
          // Review R2: mark the attempt this pause named as acknowledged, in
          // THIS write — the same one that makes the pause visible — so the
          // only way this plan runs again (`PlanService.resume`, i.e. the
          // person's Continue) restarts it with the check-first turn instead
          // of reaching the identical pause a second time. Scoped to
          // `unknown-outcome` (decision 13's "Continue = restart with
          // check-first" cut-off-action case) — every other pause kind keeps
          // showing the same buttons on every Continue, as before.
          if (final.why === 'unknown-outcome' && final.attemptId) {
            const attempt = s?.attempts.find((a) => a.attemptId === final.attemptId);
            if (attempt) attempt.pauseAcknowledged = true;
          }
        } else {
          p.status = 'interrupted';
        }
      });
    } catch (e) {
      if (!this.onJournalError(run, e)) {
        // Final review F2: the run is over, but the journal still says
        // "running" under this process's lease. Remember the real reason and
        // ask the host to run recovery, which shows the plan paused with it
        // and gives back whatever is still held, in its own write.
        // Review fix 2 (Task 12): the card gets the general line — the raw
        // system text ("EIO: …") names nothing a person can act on — and the
        // system text rides along for Report bug / Diagnose only.
        this.orphans.set(run.key, { reason: PLAN_PROGRESS_NOT_SAVED, report: errorText(e) });
        try { this.runner.onOrphaned?.(run.ref, run.planId); } catch (err) {
          console.error('[plan-executor] orphaned-plan listener threw', err);
        }
      }
    }
  }

  /**
   * Final review F2: the write that ends a run, tried again after a
   * transient failure (a held lock, a busy disk). A fence or unreadable-file
   * error is final at once — retrying can't fix either.
   */
  private async finalWrite(run: ActiveRun, fn: (plan: PlanRecord) => void): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.journal.mutateFenced(run.ref, run.planId, run.fence, fn);
        return;
      } catch (e) {
        if (isJournalError(e) || attempt >= this.settleWriteRetryDelaysMs.length) throw e;
        console.error('[plan-executor] the final plan write failed; trying again', e);
        await new Promise((r) => setTimeout(r, this.settleWriteRetryDelaysMs[attempt]));
      }
    }
  }
}
