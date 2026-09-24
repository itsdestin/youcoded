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
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'util';
import type { NativeHome } from '../../native-home';
// nativeStoreSlug (not the CC-mirroring slug): an app-private sidecar beside
// the delegation ledger, under the same frozen native-store directory.
import { nativeStoreSlug } from '../../slug-encoding';
import type { PlanChildView, PlanStepView, PlanView } from '../../../shared/types';
import type { PlanStepV1 } from './schema';
import { pausedRouting } from './pause-routing';
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
const RETRIED_AFTER_ERROR: ReadonlySet<string> = new Set(['launch-failed', 'specialist-error', 'invalid-report']);

function childView(plan: PlanRecord, step: PlanStepV1, stepStatus: string, a: PlanAttemptRecord): PlanChildView {
  // Design §5: binding is frozen per STEP now, not per specialist (two steps
  // naming the same specialist may run different models).
  const binding = plan.manifest.steps[step.id]?.binding;
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
    // 5b follow-up: `prepared` = its first request was never sent, the one
    // fact that lets the card say "Not started" without guessing.
    phase: a.phase,
  };
  // Task 9a: the plan restarted this specialist by itself after an error.
  // Review fix 3: only an ERROR retry (start error, specialist error, invalid
  // report) that actually relaunched — a restart after Continue is not one.
  if ((plan.recoveries ?? []).some((r) => r.stepId === step.id && r.iteration === a.iteration && r.itemIndex === a.itemIndex
    && r.relaunched && RETRIED_AFTER_ERROR.has(r.cause))) {
    view.retried = true;
  }
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
 * WHY a repeat is ONE row carrying its body (decision 33, 2026-09-18): the
 * projection used to flatten a repeat into one row per body step, each labelled
 * `repeat`, which left the loop itself, the round count and the stop condition
 * with nowhere to appear — the card showed two independent-looking steps and
 * never said they repeated, how many times, or when they would stop. The body
 * rows are still built exactly as before: the wrapper carries a `fanOut` that
 * is the same total number of specialist runs the flattened rows summed to.
 * WHY it no longer also carries a worst-case token sum (spending rework stage
 * 1, decision 34): that figure was `Σ(budgetTokens + setupTokens) × fanOut`
 * over the body, and neither addend exists in the grammar any more —
 * `estimate`/`spendLimit` on the PLAN are what the card reads instead.
 */
// WHY `pausedMinimum` is GONE (spending rework stage 1, design §1, decision
// 34): it computed the smallest Add budget that would let a paused
// specialist continue — `paused.minimumAddTokens`/`warmMinimum`. Nothing is
// reserved per request any more, so there is no minimum top-up to compute;
// a `spend-limit` pause carries the limit it hit instead (`paused.limit`).

/** `now` — kept for callers (`list()`/`emit()` already pass a clock through)
 *  even though this projection no longer needs one itself: the warm-minimum
 *  timer it used to time was retired with Add budget (spending rework stage
 *  1, decision 34). A future per-view "as of" figure has a clock ready. */
export function projectPlan(plan: PlanRecord, now: number = Date.now()): PlanView {
  void now;
  const row = (step: PlanStepV1, kind: PlanStepView['kind'], multiplier: number): PlanStepView => {
    const rec = plan.steps.find((s) => s.id === step.id);
    const attempts = rec?.attempts ?? [];
    const manifestStep = plan.manifest.steps[step.id];
    const out: PlanStepView = {
      id: step.id,
      kind,
      title: stepTitle(step.task),
      // WHY the whole brief travels beside its one-line title: the row can only
      // ever show the first line, so without this the user approves spending on
      // instructions he cannot finish reading (Destin, 2026-09-18). Sent as the
      // model wrote it — the card neither trims nor reflows it.
      task: step.task,
      specialist: step.specialist,
      fanOut: (step.kind === 'map' ? step.items!.length : 1) * multiplier,
      status: rec?.status ?? 'pending',
    };
    // Design §5: real stepModel — `isDefault` from the manifest's own
    // resolution source, `locked` once the step has ANY attempt (design §5's
    // "Started" definition — the lock check runs inside the same locked
    // write as attempt creation, so this is never racy with a Plan settings
    // change). Absent only for a journal written before the manifest carried
    // per-step entries (a v1 journal, already retired — see types.ts).
    if (manifestStep) {
      const isDefault = manifestStep.source === 'default';
      out.stepModel = {
        label: manifestStep.label,
        isDefault,
        ...(attempts.length > 0 ? { locked: true } : {}),
        // Design §5: an explicit binding — whether from the document's own
        // `model` or a Plan settings override — carries its identity; the
        // default carries only its label.
        ...(isDefault ? {} : { providerId: manifestStep.binding.providerId, modelId: manifestStep.binding.modelId }),
      };
    }
    // WHY the assistant's own sentence travels (decision 30, 2026-09-18): the
    // row was `title` — the first line of a prompt written for a specialist,
    // not for the person approving real spending. Absent on every plan written
    // before the field existed, and the card falls back to `title` then.
    if (step.summary) out.summary = step.summary;
    // WHY the item labels travel: they are what each child of a fan-out step
    // actually gets, and the card could only ever say how MANY children there
    // were. Only a top-level map — a repeat-body row's fan-out is its items
    // times its rounds, so the labels would not match the count beside them.
    if (kind === 'map' && step.items && step.items.length > 0) out.items = [...step.items];
    // WHY the reference travels (decision 31): `of` is the plan's OWN edge —
    // the earlier step whose reports the executor feeds in as this step's
    // input (dependencyReports). It is the only place the flow between steps
    // is written down, and the card had never been given it, so the reader
    // could not see how one step fed the next. Passed as the document's step
    // id; turning that into "step 2" is the card's job, because only the card
    // knows which rows it drew.
    if ((step.kind === 'verify' || step.kind === 'combine') && step.of) out.of = step.of;
    if (attempts.length > 0) {
      out.done = attempts.filter((a) => isCommitted(a) && a.terminal === 'completed').length;
      out.usedTokens = attempts.reduce((n, a) => n + a.spentTokens, 0);
      // Task 4 review item 6: one row per specialist this step launched, from
      // durable state (the renderer adds the live activity to it).
      // Task 9a: a report-only retry continues the SAME specialist session as
      // the attempt it follows, so only the newest attempt per session is a
      // row (the card keys rows by session id, and it is one specialist).
      const latestPerChild = new Map<string, PlanAttemptRecord>();
      for (const a of attempts) if (a.childId) latestPerChild.set(a.childId, a);
      const children = attempts.filter((a) => a.childId && latestPerChild.get(a.childId) === a).map((a) => childView(plan, step, rec!.status, a));
      if (children.length > 0) out.children = children;
    }
    return out;
  };
  const rows: PlanStepView[] = [];
  for (const step of plan.document.steps) {
    if (step.kind !== 'repeat') {
      rows.push(row(step, step.kind, 1));
      continue;
    }
    // The body rows are built EXACTLY as the flattened projection built them —
    // fan-out multiplied by the round cap, no item labels (their count would
    // not match a fan-out that counts rounds too) — so every figure on them is
    // the figure that shipped. Only their home changed: they now hang off the
    // repeat's own row instead of standing beside it.
    const body = step.steps!.map((inner) => row(inner, inner.kind, step.max_iterations!));
    const wrapper = row(step, 'repeat', 1);
    wrapper.body = body;
    wrapper.rounds = step.max_iterations!;
    if (step.until) wrapper.until = step.until;
    // The specialist count the card reads off the row, preserved exactly:
    // Σ fan-out. WHY no worst-case token sum any more (spending rework stage
    // 1, decision 34): there is no per-step token budget left to sum.
    wrapper.fanOut = body.reduce((n, b) => n + b.fanOut, 0);
    // A repeat launches no specialist of its own, so its progress and spend are
    // its body's. Without this the row would read "0 of 9 done · 0 tokens"
    // while its own body rows showed real work.
    if (body.some((b) => b.done !== undefined)) wrapper.done = body.reduce((n, b) => n + (b.done ?? 0), 0);
    if (body.some((b) => b.usedTokens !== undefined)) wrapper.usedTokens = body.reduce((n, b) => n + (b.usedTokens ?? 0), 0);
    rows.push(wrapper);
  }

  const view: PlanView = {
    planId: plan.planId,
    toolUseId: plan.toolUseId,
    title: plan.document.goal,
    status: plan.status,
    steps: rows,
    // WHY no ceilingTokens/ceilingUsd (spending rework stage 1, decision 34):
    // the record no longer carries either — `estimate`/`spendLimit` below are
    // what the card reads.
    model: { label: plan.manifest.modelLabel },
    usedTokens: plan.usedTokens,
    seq: plan.seq,
  };
  if (plan.usedUsd !== undefined) view.usedUsd = plan.usedUsd;
  if (plan.estimate) view.estimate = plan.estimate;
  if (plan.spendLimit) view.spendLimit = plan.spendLimit;
  if (plan.autoApproved) view.autoApproved = true;
  // Only the card's two fields: the attempt id is executor bookkeeping.
  if (plan.paused) {
    view.paused = { stepId: plan.paused.stepId, reason: plan.paused.reason };
    // Design §2/§7: the spend limit this pause hit ("Reached your $5 limit.").
    if (plan.paused.limit) view.paused.limit = plan.paused.limit;
    // Review fix 2: the system text for the bug report (the card never draws it).
    if (plan.paused.report) view.paused.report = plan.paused.report;
    // 5b follow-up: why it paused, so the card never reads `reason` for it.
    if (plan.paused.kind) view.paused.kind = plan.paused.kind;
    if (plan.paused.tool) view.paused.tool = plan.paused.tool;
    if (plan.paused.repeat) view.paused.repeat = { ...plan.paused.repeat };
    if (plan.paused.note) view.paused.note = plan.paused.note;
    // Task 9a: what pause-routing.ts needs to route this pause again.
    if (plan.paused.launch) view.paused.launch = plan.paused.launch;
    if (plan.paused.retried) view.paused.retried = true;
    if (plan.paused.toolEffect) view.paused.toolEffect = plan.paused.toolEffect;
    // Task 9b (pause handoff §2 step 7): the default buttons, from the same
    // table that decides what the assistant may recommend.
    view.paused.actions = [...pausedRouting(plan.paused).actions];
    const handoff = plan.paused.handoff;
    if (handoff) {
      // Only what the card shows: the id and the revision turn are the host's
      // bookkeeping and never leave the main process.
      view.paused.handoff = { state: handoff.state };
      if (handoff.recommendation) view.paused.handoff.recommendation = { ...handoff.recommendation };
      // Task 11 (§6): what the greyed card and its error line say.
      if (handoff.waiting) view.paused.handoff.waiting = handoff.waiting;
      if (handoff.question) view.paused.handoff.question = handoff.question;
      if (handoff.problem) view.paused.handoff.problem = { ...handoff.problem };
    }
  }
  if (plan.revisedOnPause) view.revisedOnPause = true;
  // Final review F32: `revisionOf` stays in the journal (the service links
  // revisions with it) but no card reads it, so it is not projected.
  if (plan.revisedBy) view.revisedBy = plan.revisedBy;
  if (plan.startedAt !== undefined) view.startedAt = plan.startedAt;
  if (plan.endedAt !== undefined) view.endedAt = plan.endedAt;
  // WHY no approximateLimit (spending rework stage 1): retired along with
  // decision 5's uncapped-route warning — see shared/types.ts's matching note.
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
      // T7 (design §2): `ceilingTokens`/`ceilingUsd` are retired from
      // PlanView entirely — this salvage view carries no price signal at
      // all now, same as any other record with no `estimate` (PlanCard.tsx
      // `unpriced()` reads that as unpriced, never a false "$0.00").
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
    const bytes = await this.home.readRawBytesAsync(rel) ?? Buffer.alloc(0);
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    const quarantineRel = `${rel}.quarantine-${digest}`;
    await this.home.createFileExclusive(quarantineRel, bytes);
    return path.join(this.home.root, quarantineRel);
  }

  /**
   * The one place every entry point reads a journal's raw bytes. A v1
   * journal is not damaged — it is a shape this build no longer reads
   * (spending rework stage 1, design §2, decision 33.4 / open question 7
   * "resolved here": "v1 journals retired silently"). It is retired BEFORE
   * the strict version check ever sees it: archived byte-for-byte at
   * `<rel>.v1-retired` (idempotent — `createFileExclusive` leaves an
   * existing copy alone if another process already retired it) and removed,
   * so every caller below sees exactly what an absent journal looks like and
   * never manufactures a failed card the way a genuinely unreadable file
   * does (decision 33's "all of the existing plans are demos" — Destin
   * accepted losing them for this rework).
   */
  private async readRawRetiringV1(rel: string): Promise<Buffer | null> {
    const bytes = await this.home.readRawBytesAsync(rel);
    if (bytes === null) return null;
    let json: unknown;
    try {
      json = JSON.parse(bytes.toString('utf8'));
    } catch {
      return bytes; // not valid JSON at all — the strict reader's own quarantine path handles it
    }
    if ((json as { v?: unknown } | null)?.v !== 1) return bytes;
    await this.home.createFileExclusive(`${rel}.v1-retired`, bytes);
    try {
      await fs.promises.unlink(path.join(this.home.root, rel));
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
    }
    return null;
  }

  async read(ref: PlanRef): Promise<JournalReadResult> {
    const bytes = await this.readRawRetiringV1(this.relPath(ref));
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

  /**
   * Task 5a: a synchronous, read-only look at the plan records, for history
   * replay (NativeSessionHost.getHistory is synchronous, like the ledger read
   * it sits beside). WHY no quarantine here: a damaged file is reported and set
   * aside by the async paths (`read`/`list`) that own the failed card; replay
   * only decorates history, so it treats damage as "no plan activity" rather
   * than writing anything from a read.
   */
  peekRecords(ref: PlanRef): PlanRecord[] {
    const bytes = this.home.readRawBytes(this.relPath(ref));
    if (bytes === null) return [];
    const parsed = parseJournal(bytes.toString('utf8'));
    return parsed.ok ? parsed.file.plans : [];
  }

  /** Current card projections, for hydration/replay. Never throws for damage. */
  async list(ref: PlanRef): Promise<PlanView[]> {
    const result = await this.read(ref);
    if (result.kind === 'absent') return [];
    if (result.kind === 'valid') return result.file.plans.map((p) => projectPlan(p, this.now()));
    return salvagedFailedViews((await this.home.readRawBytesAsync(this.relPath(ref)))?.toString('utf8') ?? '', result.detail);
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
    if (await this.readRawRetiringV1(rel) === null) {
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
      this.onEvent({ sessionId: ref.sessionId, plan: projectPlan(plan, this.now()) });
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
    // Task 11 (review 4-2): `onStart` is also told the pause this write
    // replaces, so Continue reads the handoff to withdraw inside its OWN
    // write rather than from an earlier read an Ask could have overtaken.
    opts: { startFrom?: JournalPlanStatus[]; force?: boolean; onStart?: (plan: PlanRecord, replaced: { paused?: PlanRecord['paused'] }) => void } = {},
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
      const replaced = { paused: plan.paused };
      if (plan.status !== 'running') {
        plan.status = 'running';
        delete plan.paused;
      }
      opts.onStart?.(plan, replaced);
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
      // WHY no reservedTokens reset (spending rework stage 1, decision 34):
      // the field is gone — nothing is reserved against an attempt any more.
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
    // Final review F2: `orphaned` answers, for a plan THIS process leases,
    // why nothing is running it (its final write failed) — or undefined when
    // a run is active. Such a plan is paused with that reason.
    // Review fix 2: `reason` is the card's general line; `report` the
    // system's own text, kept for the bug report only.
    opts: { onInterrupt?: (plan: PlanRecord) => void; orphaned?: (planId: string) => { reason: string; report?: string } | undefined } = {},
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
        let orphanReason: { reason: string; report?: string } | undefined;
        if (plan.lease) {
          const owner = this.ownerState(plan.lease);
          if (owner === 'self') {
            orphanReason = opts.orphaned?.(plan.planId);
            if (orphanReason === undefined) continue;
          } else if (owner === 'live') {
            if (plan.lease.expiresAt > now) recheckAt = Math.min(recheckAt ?? Infinity, plan.lease.expiresAt);
            continue;
          }
        }
        delete plan.lease;
        // The step the card shows as stuck: the one that was running, else
        // the first unfinished one.
        const stuck = plan.steps.find((s) => s.status === 'running') ?? plan.steps.find((s) => s.status !== 'done') ?? plan.steps[0];
        for (const step of plan.steps) if (step.status === 'running') step.status = 'paused';
        if (orphanReason !== undefined) {
          // Not "the app closed" (it didn't): an unexpected-problem pause
          // with the real reason, which offers Continue and Stop.
          plan.status = 'paused';
          plan.paused = {
            stepId: stuck?.id ?? '', reason: orphanReason.reason, kind: 'unexpected-error',
            ...(orphanReason.report ? { report: orphanReason.report } : {}),
          };
        } else {
          plan.status = 'interrupted';
        }
        opts.onInterrupt?.(plan);
        interrupted.push(plan.planId);
      }
      return recheckAt === undefined ? { interrupted } : { interrupted, recheckAt };
    });
  }
}
