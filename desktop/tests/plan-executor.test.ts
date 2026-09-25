// Specialists plans, T1 (spending rework stage 1) — the plan executor
// (backend design §3, revised by §3 "Crash safety"). Real filesystem journal;
// only the specialists themselves are fakes (a scripted runner). There is no
// PlanBudget any more — a specialist's spend is not reserved or rationed here
// (T2 wires the real accounting); every assertion below is about ORDER,
// PHASES and PAUSE ROUTING, read back from the journal file, because resume
// reads nothing else.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { PlanJournal, projectPlan } from '../src/main/harness/plans/plan-journal';
import {
  PlanExecutor, PlanLaunchDriftError, PlanLaunchRefusedError, PlanNotReadyError, PLAN_DEPENDENCY_REPORT_MAX_CHARS, PLAN_REPORT_ONLY_RESEND, PLAN_RESTART_BRIEF, classifyChildTranscript as classifyWith, planRestartBrief,
  type PlanChildHandle, type PlanChildLaunch, type PlanChildOutcome, type PlanRunner, type TranscriptVerdict,
} from '../src/main/harness/plans/plan-executor';
import type { ExecutionManifest, PlanAttemptRecord, PlanEvent, PlanRecord, PlanRef } from '../src/main/harness/plans/types';
import type { PlanDocumentV1 } from '../src/main/harness/plans/schema';
import type { TranscriptEvent } from '../src/shared/types';
import { nativeToolEffect } from '../src/main/harness/tools';
import { pausedRouting } from '../src/main/harness/plans/pause-routing';
// T2: renamed from the deleted PLAN_BUDGET_EXHAUSTED_STOP_REASON (design §3).
import { PLAN_LIMIT_REACHED_STOP_REASON } from '../src/main/harness/plans/plan-spend';

// Task 9a: the classifier reads each tool's declared effect.
const classifyChildTranscript = (events: TranscriptEvent[]) => classifyWith(events, nativeToolEffect);

const REF: PlanRef = { cwd: '/proj', sessionId: 'parent-1' };
// Design §2/§5: the manifest's binding/pricing now live per LEAF STEP, not
// per specialist (a per-step model override can freeze two steps naming the
// same specialist to two different bindings). Nothing here exercises T4's
// per-step resolution, so `steps` stays empty — `manifest.specialists` is all
// `createAttempts`/`recordChild` (plan-executor.ts) actually read.
const MANIFEST: ExecutionManifest = {
  modelLabel: 'm',
  specialists: {
    reviewer: { definitionFingerprint: 'r' },
    worker: { definitionFingerprint: 'w' },
    explorer: { definitionFingerprint: 'e' },
  },
  steps: {},
  permissionFingerprint: 'perm',
};

function allIds(steps: PlanDocumentV1['steps']): string[] {
  return steps.flatMap((s) => (s.kind === 'repeat' ? [s.id, ...allIds(s.steps!)] : [s.id]));
}

function record(document: PlanDocumentV1, over: Partial<PlanRecord> = {}): PlanRecord {
  return {
    planId: 'p1', toolUseId: 'tool-p1', document, maximumAttempts: 1, maxFanOut: 1,
    usedTokens: 0,
    status: 'proposed', seq: 1, createdAt: 1, manifest: MANIFEST,
    steps: allIds(document.steps).map((id) => ({ id, status: 'pending' as const, attempts: [] })),
    fenceEpoch: 0,
    ...over,
  };
}

const attemptRec = (over: Partial<PlanAttemptRecord>): PlanAttemptRecord => ({
  attemptId: 'a', itemIndex: 0, iteration: 0, spentTokens: 0, phase: 'prepared', ...over,
});

// ---- the scripted runner ----

interface ChildCtx { signal: AbortSignal; launch: PlanChildLaunch; childId: string }
type Script = (ctx: ChildCtx) => Promise<PlanChildOutcome>;

/** Finish with `report`, after an optional delay (for ordering tests). WHY no
 *  spend accounting (T1, design §1/§3): nothing reserves or prices a request
 *  any more — `input`/`output` are kept only so call sites can still document
 *  "a bigger reply" without asserting a `spentTokens` number T2 will compute. */
const completes = (report: string, input = 100, output = 50): Script => async () => {
  void input; void output;
  return { kind: 'completed', report };
};
/** Never finishes unless aborted. `honorsAbort` → resolves `interrupted` once
 *  the signal fires (like a real specialist session tearing down on abort);
 *  otherwise it hangs forever (settle's deadline must force it). */
const hangs = (honorsAbort: boolean): Script => async ({ signal }) => {
  if (!honorsAbort) return new Promise<PlanChildOutcome>(() => {});
  if (!signal.aborted) await new Promise<void>((res) => signal.addEventListener('abort', () => res(), { once: true }));
  return { kind: 'interrupted' };
};
const failsWith = (detail: string, delayMs = 0): Script => async () => {
  await new Promise((r) => setTimeout(r, delayMs));
  return { kind: 'failed', detail };
};

let root: string; let home: NativeHome; let journal: PlanJournal;
let events: PlanEvent[]; let log: string[];

class FakeRunner implements PlanRunner {
  launches: Array<PlanChildLaunch & { childId: string }> = [];
  disposed: string[] = [];
  aborted: string[] = [];
  live = 0; maxLive = 0; next = 0; cap = 4;
  writers = new Set<string>();
  verdicts = new Map<string, TranscriptVerdict>();
  unreadable: string[] = [];
  /** Snapshot of journal state at each launch, for ordering assertions. */
  planAtLaunch: PlanRecord[] = [];
  constructor(public script: (launch: PlanChildLaunch) => Script) {}
  maxConcurrent(): number { return this.cap; }
  isWriter(_ref: PlanRef, specialist: string): boolean { return this.writers.has(specialist); }
  inspectTranscript(_ref: PlanRef, childId: string): TranscriptVerdict {
    return this.verdicts.get(childId) ?? { kind: 'resumable', briefDelivered: false };
  }
  onUnreadable(_ref: PlanRef, planId: string, detail: string): void { this.unreadable.push(`${planId}:${detail}`); }
  onOrphaned?: (ref: PlanRef, planId: string) => void;
  /** Issue 1 fix: fired once, after the write that marks a plan `completed`. */
  onCompleted?: (ref: PlanRef, planId: string) => void;
  /** Task 13 (decision 26): the provider's own sentence, when it can't run. */
  notReady: string | undefined = undefined;
  notReadyAsked: string[] = [];
  async providerNotReady(_ref: PlanRef, _plan: PlanRecord, specialist: string): Promise<string | undefined> {
    this.notReadyAsked.push(specialist);
    return this.notReady;
  }
  /** Review fix 2: the newest user message each specialist's transcript holds. */
  userTexts = new Map<string, string>();
  latestUserText(_ref: PlanRef, childId: string): string | undefined { return this.userTexts.get(childId); }
  async launch(input: PlanChildLaunch): Promise<PlanChildHandle> {
    const childId = input.resumeChildId ?? `child-${++this.next}`;
    this.planAtLaunch.push((await journal.get(REF, input.planId))!);
    // R1: this is the real contract — recordChild runs BEFORE anything is
    // sent, and is what moves the attempt's phase off 'prepared'.
    await input.recordChild(childId);
    this.launches.push({ ...input, childId });
    this.live += 1; this.maxLive = Math.max(this.maxLive, this.live);
    const ac = new AbortController();
    let markDisposed!: () => void;
    const disposedP = new Promise<void>((r) => { markDisposed = r; });
    const outcome = Promise.race([
      this.script(input)({ signal: ac.signal, launch: input, childId }),
      disposedP.then((): PlanChildOutcome => ({ kind: 'interrupted' })),
    ]).catch((e): PlanChildOutcome => ({ kind: 'failed', detail: String(e) }));
    let gone = false;
    return {
      childId,
      outcome,
      abort: () => { this.aborted.push(childId); ac.abort(); },
      dispose: async () => {
        if (gone) return;
        gone = true;
        this.disposed.push(childId);
        log.push(`dispose:${childId}`);
        this.live -= 1;
        markDisposed();
      },
      // T2: no PlanSpend behind this fake — every attempt's spend settles
      // immediately, exactly as if nothing was ever in flight.
      spendSettled: async () => {},
    };
  }
}

async function seed(rec: PlanRecord): Promise<string> {
  await journal.mutate(REF, (file) => { file.plans.push(rec); });
  const lease = await journal.acquireLease(REF, rec.planId, { startFrom: [rec.status] });
  if (!lease.ok) throw new Error(`lease ${lease.reason}`);
  return lease.fence;
}
const plan = async (): Promise<PlanRecord> => (await journal.get(REF, 'p1'))!;
const stepOf = async (id: string) => (await plan()).steps.find((s) => s.id === id)!;
/** Final review F34: log 'settle-deadline' when the executor's settle
 *  deadline timer (a setTimeout of exactly `ms`) fires.
 *  `awaitFirst` (2026-09-24 flake fix): hold the fire until a real signal
 *  resolves, instead of trusting that `ms` of wall clock is always enough —
 *  see the WHY at this function's one caller that needs it. */
function markDeadline(ms: number, awaitFirst?: Promise<unknown>): { fired: () => boolean } {
  const real = globalThis.setTimeout;
  let fired = false;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...a: unknown[]) => void, delay?: number, ...rest: unknown[]) => real(
    delay === ms
      ? (...a: unknown[]) => {
        const go = () => { fired = true; log.push('settle-deadline'); fn(...a); };
        if (awaitFirst) void awaitFirst.then(go); else go();
      }
      : fn, delay, ...rest,
  )) as typeof setTimeout);
  return { fired: () => fired };
}

function executor(runner: PlanRunner, over: Partial<ConstructorParameters<typeof PlanExecutor>[0]> = {}): PlanExecutor {
  return new PlanExecutor({ journal, runner, settleDeadlineMs: 60, heartbeatMs: 10_000, ...over });
}

/** X4 (review 2026-09-24, test-suite-hygiene.md "never let a fixed sleep...
 *  stand in for a signal"): a plain externally-resolvable gate, so a
 *  scripted specialist can wait on an event the test controls directly
 *  instead of a `setTimeout` the test hopes was long enough. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-exec-'));
  home = new NativeHome(root); events = []; log = [];
  journal = new PlanJournal({
    home, identity: { instanceId: 'me', pid: 1 },
    onEvent: (e) => { events.push(e); log.push(`event:${e.plan.status}`); },
  });
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); });

const MAP6: PlanDocumentV1 = { goal: 'Six', steps: [
  { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Review {item}', summary: 'Plain sentence.', items: ['a', 'b', 'c', 'd', 'e', 'f'] },
] };

describe('waves', () => {
  it('fans a map out in waves no wider than the resolved cap, and completes', async () => {
    const runner = new FakeRunner(() => async (ctx) => {
      await new Promise((r) => setTimeout(r, 5));
      return completes(`report ${ctx.launch.brief}`)(ctx);
    });
    runner.cap = 4;
    const fence = await seed(record(MAP6));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    expect(runner.maxLive).toBe(4);
    expect(runner.launches).toHaveLength(6);
    // The second wave starts only after the whole first wave is journalled.
    const fifth = runner.planAtLaunch[4];
    expect(fifth.steps[0].attempts.filter((a) => a.phase === 'committed')).toHaveLength(4);
    const p = await plan();
    expect(p.status).toBe('completed');
    expect(p.lease).toBeUndefined();
    expect(p.steps[0].status).toBe('done');
    expect(p.steps[0].attempts.map((a) => a.reportText)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'].map((i) => `report Review ${i}`));
    expect(runner.live).toBe(0);
  });

  // T2 review S1: a spend record that couldn't be saved is a pause for the
  // USER — never mistaken for an invalid report and auto-retried with an
  // internal error fed back to the specialist as "feedback".
  it('a failed spend write pauses the plan and never launches a report-only retry', async () => {
    const runner = new FakeRunner(() => async (ctx) => {
      ctx.launch.markWriteFailed();
      return completes(`report ${ctx.launch.brief}`)(ctx);
    });
    runner.cap = 1;
    const doc: PlanDocumentV1 = { goal: 'one', steps: [
      { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Review {item}', summary: 'Plain sentence.', items: ['a', 'b'] },
    ] };
    const fence = await seed(record(doc));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p = await plan();
    expect(p.status).toBe('paused');
    expect(p.paused).toMatchObject({ kind: 'unexpected-error' });
    expect(p.recoveries ?? []).toEqual([]);
    expect(runner.launches).toHaveLength(1);
  });

  it('a resolved cap below four narrows the waves', async () => {
    const runner = new FakeRunner(() => completes('ok'));
    runner.cap = 2;
    const fence = await seed(record(MAP6));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    expect(runner.maxLive).toBe(2);
    expect((await plan()).status).toBe('completed');
  });

  it('write-capable specialists still serialize', async () => {
    const doc: PlanDocumentV1 = { goal: 'w', steps: [
      { id: 's1', kind: 'map', specialist: 'worker', task: 'Fix {item}', summary: 'Plain sentence.', items: ['a', 'b', 'c'] },
    ] };
    const runner = new FakeRunner(() => async (ctx) => { await new Promise((r) => setTimeout(r, 5)); return completes('ok')(ctx); });
    runner.writers.add('worker');
    const fence = await seed(record(doc));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    expect(runner.maxLive).toBe(1);
    expect(runner.launches).toHaveLength(3);
  });

  it('verify/combine receive only their bounded, labelled dependencies', async () => {
    const long = 'x'.repeat(PLAN_DEPENDENCY_REPORT_MAX_CHARS + 500);
    const doc: PlanDocumentV1 = { goal: 'c', steps: [
      { id: 's0', kind: 'map', specialist: 'explorer', task: 'Unrelated', summary: 'Plain sentence.', items: ['z'] },
      { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Review {item}', summary: 'Plain sentence.', items: ['a.ts', 'b.ts'] },
      { id: 's2', kind: 'combine', specialist: 'reviewer', task: 'Combine the reviews', summary: 'Plain sentence.', of: 's1' },
    ] };
    const runner = new FakeRunner((l) => {
      if (l.stepId === 's0') return completes('SECRET-UNRELATED');
      if (l.stepId === 's1') return completes(l.brief.includes('a.ts') ? 'REPORT-A' : long);
      return completes('combined');
    });
    const fence = await seed(record(doc));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const brief = runner.launches.find((l) => l.stepId === 's2')!.brief;
    expect(brief).toContain('Combine the reviews');
    expect(brief).toContain('REPORT-A');
    expect(brief).toContain('Result 1 of 2');
    expect(brief).toContain('Result 2 of 2');
    expect(brief).toContain('a.ts');
    expect(brief).not.toContain('SECRET-UNRELATED');
    // bounded: the long report is shortened, never passed whole
    expect(brief).not.toContain(long);
    expect(brief.length).toBeLessThan(PLAN_DEPENDENCY_REPORT_MAX_CHARS * 2 + 2_000);
    // map briefs carry no dependencies at all
    expect(runner.launches.filter((l) => l.stepId === 's1').map((l) => l.brief).sort()).toEqual(['Review a.ts', 'Review b.ts']);
  });

  // Decision 39 (the owner's live test, 2026-09-24): three separate
  // single-researcher steps, then a combine step whose `of` could name only
  // ONE earlier step — the combine specialist reported "I only received
  // Result 1 (Mechanical keyboards); the other two research reports aren't
  // included" and the plan "succeeded" with a keyboards-only answer. `of` may
  // now list several earlier steps; this proves every one of them arrives,
  // labelled by its own step id, and that the character budget divides across
  // ALL of them together rather than each source step keeping its own full
  // share (which would let the true total balloon unbounded).
  it('a combine step naming several steps in `of` receives every one of their reports, fairly truncated across all of them', async () => {
    const long = (tag: string) => `${tag}-`.repeat(2_000); // far past PLAN_DEPENDENCY_REPORT_MAX_CHARS
    const doc: PlanDocumentV1 = { goal: 'combine three categories', steps: [
      { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Research {item}', summary: 'Plain sentence.', items: ['keyboards-a', 'keyboards-b'] },
      { id: 's2', kind: 'map', specialist: 'reviewer', task: 'Research {item}', summary: 'Plain sentence.', items: ['mice-a', 'mice-b'] },
      { id: 's3', kind: 'map', specialist: 'reviewer', task: 'Research {item}', summary: 'Plain sentence.', items: ['monitors-a', 'monitors-b'] },
      { id: 's4', kind: 'combine', specialist: 'worker', task: 'Write one report covering all three categories', summary: 'Plain sentence.', of: ['s1', 's2', 's3'] },
    ] };
    const runner = new FakeRunner((l) => (l.stepId === 's4' ? completes('combined') : completes(long(l.stepId))));
    const fence = await seed(record(doc));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const brief = runner.launches.find((l) => l.stepId === 's4')!.brief;
    // All three steps reached the combine step, not just the first-named one.
    for (const id of ['s1', 's2', 's3']) expect(brief).toContain(`from step "${id}"`);
    // 6 reports total (2 items × 3 steps) — none silently dropped.
    expect(brief).toContain('Result 1 of 6');
    expect(brief).toContain('Result 6 of 6');
    // Fair division: 24,000 total ÷ 6 reports = 4,000 each, below the normal
    // 6,000 per-report cap — proving the budget is computed over every named
    // step's reports together, not per source step.
    const bodies = [...brief.matchAll(/---\n([\s\S]*?)\n\[… shortened/g)].map((m) => m[1]);
    expect(bodies).toHaveLength(6);
    for (const body of bodies) expect(body.length).toBe(4_000);
  });
});

const TWO_STEP: PlanDocumentV1 = { goal: 'two', steps: [
  { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Review {item}', summary: 'Plain sentence.', items: ['a', 'b'] },
  { id: 's2', kind: 'combine', specialist: 'reviewer', task: 'Combine', summary: 'Plain sentence.', of: 's1' },
] };

function committed(id: string, itemIndex: number, report: string, spent = 400): PlanAttemptRecord {
  return attemptRec({ attemptId: id, itemIndex, childId: `old-${id}`, spentTokens: spent, phase: 'committed', terminal: 'completed', reportText: report, completedAt: 3 });
}

describe('durable completion and resume', () => {
  it('journals child completion before launching the successor step', async () => {
    const runner = new FakeRunner(() => completes('r'));
    const fence = await seed(record(TWO_STEP));
    // A slow disk: the completion write takes a while to land.
    const commitAttempt = journal.commitAttempt.bind(journal);
    journal.commitAttempt = async (...args) => {
      await new Promise((r) => setTimeout(r, 30));
      return commitAttempt(...args);
    };
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const atS2 = runner.planAtLaunch[runner.launches.findIndex((l) => l.stepId === 's2')];
    const s1 = atS2.steps.find((s) => s.id === 's1')!;
    expect(s1.attempts.every((a) => a.phase === 'committed' && a.terminal === 'completed')).toBe(true);
    expect(s1.status).toBe('done');
  });

  it('a fresh executor skips committed attempts and reads their reports from disk', async () => {
    const rec = record(TWO_STEP, {
      status: 'interrupted', usedTokens: 800,
      steps: [
        { id: 's1', status: 'done', attempts: [committed('c1', 0, 'DISK-A'), committed('c2', 1, 'DISK-B')] },
        { id: 's2', status: 'pending', attempts: [] },
      ],
    });
    const runner = new FakeRunner(() => completes('final'));
    const fence = await seed(rec);
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    expect(runner.launches.map((l) => l.stepId)).toEqual(['s2']);
    expect(runner.launches[0].brief).toContain('DISK-A');
    expect(runner.launches[0].brief).toContain('DISK-B');
    const p = await plan();
    expect(p.status).toBe('completed');
    expect(p.steps[0].attempts).toEqual(rec.steps[0].attempts);
  });

  it('a prepared attempt may restart (same attempt, same specialist session)', async () => {
    const rec = record(TWO_STEP, {
      status: 'interrupted',
      steps: [
        { id: 's1', status: 'paused', attempts: [committed('c1', 0, 'A'), attemptRec({ attemptId: 'p2', itemIndex: 1, childId: 'kid-2', phase: 'prepared' })] },
        { id: 's2', status: 'pending', attempts: [] },
      ],
      usedTokens: 400,
    });
    const runner = new FakeRunner(() => completes('B'));
    const fence = await seed(rec);
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const first = runner.launches[0];
    expect(first).toMatchObject({ stepId: 's1', attemptId: 'p2', resumeChildId: 'kid-2', brief: 'Review b' });
    expect((await stepOf('s1')).attempts.find((a) => a.attemptId === 'p2')).toMatchObject({ phase: 'committed', reportText: 'B' });
    expect((await plan()).status).toBe('completed');
  });

  it('a restart whose brief already reached the specialist sends the fresh continue turn instead', async () => {
    const rec = record(TWO_STEP, {
      status: 'interrupted',
      steps: [
        { id: 's1', status: 'paused', attempts: [committed('c1', 0, 'A'), attemptRec({ attemptId: 'p2', itemIndex: 1, childId: 'kid-2', phase: 'launched', spentTokens: 300 })] },
        { id: 's2', status: 'pending', attempts: [] },
      ],
      usedTokens: 700,
    });
    const runner = new FakeRunner(() => completes('B'));
    runner.verdicts.set('kid-2', { kind: 'resumable', briefDelivered: true });
    const fence = await seed(rec);
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    expect(runner.launches[0]).toMatchObject({ attemptId: 'p2', resumeChildId: 'kid-2', brief: PLAN_RESTART_BRIEF });
  });

  it('a terminal child transcript is committed without any request', async () => {
    const rec = record(TWO_STEP, {
      status: 'interrupted', usedTokens: 700,
      steps: [
        { id: 's1', status: 'paused', attempts: [committed('c1', 0, 'A'), attemptRec({ attemptId: 'p2', itemIndex: 1, childId: 'kid-2', phase: 'launched', spentTokens: 300 })] },
        { id: 's2', status: 'pending', attempts: [] },
      ],
    });
    const runner = new FakeRunner(() => completes('final'));
    runner.verdicts.set('kid-2', { kind: 'terminal', report: 'FROM-TRANSCRIPT' });
    const fence = await seed(rec);
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    expect(runner.launches.map((l) => l.stepId)).toEqual(['s2']);
    const p2 = (await stepOf('s1')).attempts.find((a) => a.attemptId === 'p2')!;
    // WHY spentTokens stays at whatever was already on the attempt (300, not
    // some computed request cost): T1's commitReport commits with the
    // attempt's OWN spentTokens — T2 (afterReply) is what will ever change it.
    expect(p2).toMatchObject({ phase: 'committed', terminal: 'completed', reportText: 'FROM-TRANSCRIPT', spentTokens: 300 });
    expect(runner.launches[0].brief).toContain('FROM-TRANSCRIPT');
  });

  // WHY the old 'an unsettled request …'/'Task 9a: a cut-off request …' ×2
  // tests are GONE (spending rework stage 1, design §3 "Crash safety"): they
  // exercised the deleted 'request-sent' phase, the 'unknown-request'
  // recovery cause and the Add-budget pause — plan children now use the
  // ordinary request path, so an interrupted MODEL REQUEST has no effect
  // outside the computer; there is nothing left to charge, release or pause
  // for. What decision 13's "a cut-off request" case now means is exactly
  // "a `launched` attempt with no dangling tool call" — already covered by
  // 'a restart whose brief already reached the specialist …' above.

  it('an outside action (Bash) with no durable result pauses for the assistant and is not replayed', async () => {
    const rec = record(TWO_STEP, {
      status: 'interrupted', usedTokens: 700,
      steps: [
        { id: 's1', status: 'paused', attempts: [committed('c1', 0, 'A'), attemptRec({ attemptId: 'p2', itemIndex: 1, childId: 'kid-2', phase: 'launched', spentTokens: 300 })] },
        { id: 's2', status: 'pending', attempts: [] },
      ],
    });
    const runner = new FakeRunner(() => completes('x'));
    runner.verdicts.set('kid-2', { kind: 'dangling-effect', tool: 'Bash', effect: 'external' });
    const fence = await seed(rec);
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    expect(runner.launches).toHaveLength(0);
    const p = await plan();
    expect(p.status).toBe('paused');
    expect(p.paused!.reason).toContain('Bash');
    // 5b follow-up: the card reads the kind and the tool, never the sentence.
    expect(p.paused).toMatchObject({ kind: 'unknown-outcome', tool: 'Bash', toolEffect: 'external' });
    expect(p.recoveries).toBeUndefined();
    // R1/R2: the attempt STAYS 'launched' (never silently treated as
    // 'prepared') and is marked acknowledged in the same write, so the next
    // Continue restarts it with the check-first turn instead of re-pausing.
    expect(p.steps[0].attempts[1]).toMatchObject({ phase: 'launched', pauseAcknowledged: true, spentTokens: 300 });
  });
});

// Issue 1 fix: today only a user-requested pause handoff queues a notice
// turn — a COMPLETED plan queues nothing, so the assistant never learns its
// own plan finished and the chat goes silent. `onCompleted` is the executor's
// hook for that (PlanHostBridge implements it — plan-host-bridge.test.ts
// covers the actual notice text/queueing/durability; this only pins WHEN and
// HOW OFTEN the executor calls the hook, and that a hook throwing never
// corrupts the write it fires after).
describe('onCompleted (issue 1 fix)', () => {
  it('fires exactly once, with this run\'s ref and planId, only AFTER the completed write lands', async () => {
    const runner = new FakeRunner(() => completes('ok'));
    const calls: Array<{ ref: PlanRef; planId: string }> = [];
    runner.onCompleted = (ref, planId) => { calls.push({ ref, planId }); };
    const fence = await seed(record(TWO_STEP));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    expect((await plan()).status).toBe('completed');
    expect(calls).toEqual([{ ref: REF, planId: 'p1' }]);
  });

  it('never fires for a pause, a stop, or an interruption — only a real completion', async () => {
    // Pause: one step fails with a Bash call left dangling → unknown-outcome.
    const paused = new FakeRunner(() => failsWith('boom'));
    const pausedCalls: string[] = [];
    paused.onCompleted = (_ref, planId) => { pausedCalls.push(planId); };
    const fence1 = await seed(record(TWO_STEP));
    const exec1 = executor(paused);
    exec1.start({ ref: REF, planId: 'p1', fence: fence1 });
    await exec1.settled('p1');
    expect((await plan()).status).toBe('paused');
    expect(pausedCalls).toEqual([]);
  });

  it('a throwing onCompleted never corrupts the completed write or the settle it followed', async () => {
    const runner = new FakeRunner(() => completes('ok'));
    runner.onCompleted = () => { throw new Error('listener blew up'); };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fence = await seed(record(TWO_STEP));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p = await plan();
    expect(p.status).toBe('completed');
    expect(p.lease).toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
  });
});

// R3(a)-(c),(e) — review R1/R2's promised named tests (Revision 1 D6). R3(d)
// ("Continue on the external pause then restarts it with check-first and
// does not re-pause") lives in describe('Task 9a: automatic recovery …') as
// 'R3(d): a specialist error that left a Bash call unanswered …' — that test
// exercises the FULL real path (settle's finalWrite setting
// `pauseAcknowledged` for a pause that really happened, then a genuine next
// run) rather than a hand-seeded flag, which is the stronger proof.
describe('crash recovery: a launched attempt with a dangling call, by effect', () => {
  it('R3(a): after a crash, a launched attempt whose transcript ends in an unanswered EXTERNAL call is never re-run automatically', async () => {
    const rec = record(TWO_STEP, {
      status: 'interrupted', usedTokens: 0,
      steps: [
        { id: 's1', status: 'paused', attempts: [committed('c1', 0, 'A'), attemptRec({ attemptId: 'p2', itemIndex: 1, childId: 'kid-2', phase: 'launched' })] },
        { id: 's2', status: 'pending', attempts: [] },
      ],
    });
    const runner = new FakeRunner(() => completes('x'));
    runner.verdicts.set('kid-2', { kind: 'dangling-effect', tool: 'Bash', effect: 'external' });
    const fence = await seed(rec);
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    // Nothing was relaunched — the R1 regression this pins: phase never
    // silently skipped as if it were 'prepared'.
    expect(runner.launches).toHaveLength(0);
    const p = await plan();
    expect(p.status).toBe('paused');
    expect(p.paused).toMatchObject({ kind: 'unknown-outcome', tool: 'Bash', toolEffect: 'external' });
    const attempt = p.steps[0].attempts.find((a) => a.attemptId === 'p2')!;
    expect(attempt.phase).toBe('launched');
  });

  it('R3(b): the read variant re-runs by itself with the plain continue turn', async () => {
    const rec = record(TWO_STEP, {
      status: 'interrupted', usedTokens: 0,
      steps: [
        { id: 's1', status: 'paused', attempts: [committed('c1', 0, 'A'), attemptRec({ attemptId: 'p2', itemIndex: 1, childId: 'kid-2', phase: 'launched' })] },
        { id: 's2', status: 'pending', attempts: [] },
      ],
    });
    const runner = new FakeRunner(() => completes('B'));
    runner.verdicts.set('kid-2', { kind: 'dangling-effect', tool: 'Grep', effect: nativeToolEffect('Grep') });
    const fence = await seed(rec);
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    expect(runner.launches[0]).toMatchObject({ attemptId: 'p2', resumeChildId: 'kid-2', brief: PLAN_RESTART_BRIEF });
    expect((await plan()).status).toBe('completed');
  });

  it('R3(c): the local-change variant restarts with the check-first turn', async () => {
    const rec = record(TWO_STEP, {
      status: 'interrupted', usedTokens: 0,
      steps: [
        { id: 's1', status: 'paused', attempts: [committed('c1', 0, 'A'), attemptRec({ attemptId: 'p2', itemIndex: 1, childId: 'kid-2', phase: 'launched' })] },
        { id: 's2', status: 'pending', attempts: [] },
      ],
    });
    const runner = new FakeRunner(() => completes('B'));
    runner.verdicts.set('kid-2', { kind: 'dangling-effect', tool: 'Write', effect: 'local' });
    const fence = await seed(rec);
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    expect(runner.launches[0]).toMatchObject({
      attemptId: 'p2', resumeChildId: 'kid-2',
      brief: planRestartBrief({ kind: 'dangling-effect', tool: 'Write', effect: 'local' }),
    });
    expect(runner.launches[0].brief).toContain('Write');
    expect((await plan()).status).toBe('completed');
  });

  it('R3(e): a prepared attempt that provably never sent anything restarts freshly, without ever reading its transcript', async () => {
    const rec = record(TWO_STEP, {
      status: 'interrupted', usedTokens: 0,
      steps: [
        { id: 's1', status: 'paused', attempts: [committed('c1', 0, 'A'), attemptRec({ attemptId: 'p2', itemIndex: 1, phase: 'prepared' })] },
        { id: 's2', status: 'pending', attempts: [] },
      ],
    });
    const runner = new FakeRunner(() => completes('B'));
    // No childId is seeded, so a spurious inspectTranscript call would find
    // nothing to key off anyway; the real guard is `recoverAttempt`'s own
    // `if (original.phase === 'prepared') return undefined;`, checked BEFORE
    // any transcript read. Spy to prove it is genuinely never reached.
    const inspect = vi.spyOn(runner, 'inspectTranscript');
    const fence = await seed(rec);
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    expect(inspect).not.toHaveBeenCalled();
    // A fresh launch — the FULL brief, never a restart/check-first turn.
    expect(runner.launches[0]).toMatchObject({ attemptId: 'p2', brief: 'Review b' });
    expect(runner.launches[0].resumeChildId).toBeUndefined();
    expect((await plan()).status).toBe('completed');
  });
});

describe('repeat', () => {
  const repeatDoc = (max: number): PlanDocumentV1 => ({ goal: 'loop', steps: [
    { id: 'r', kind: 'repeat', specialist: 'reviewer', task: 'loop', summary: 'Plain sentence.', max_iterations: max, until: 'tests pass',
      steps: [
        { id: 'fix', kind: 'map', specialist: 'reviewer', task: 'Fix {item}', summary: 'Plain sentence.', items: ['x'] },
        { id: 'check', kind: 'verify', specialist: 'reviewer', task: 'Check the fix', summary: 'Plain sentence.', of: 'fix' },
      ] },
  ] });

  it('the final leaf decides with {report, repeatSatisfied}; satisfied ends the loop', async () => {
    let checks = 0;
    const runner = new FakeRunner((l) => {
      if (l.stepId === 'fix') return completes(`fixed in round ${l.iteration}`);
      checks += 1;
      return completes(JSON.stringify({ report: `CHECK-REPORT-${checks}`, repeatSatisfied: checks === 2 }));
    });
    const fence = await seed(record(repeatDoc(3)));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p = await plan();
    expect(p.status).toBe('completed');
    expect(runner.launches.map((l) => `${l.stepId}#${l.iteration}`)).toEqual(['fix#0', 'check#0', 'fix#1', 'check#1']);
    // the final leaf is told how to answer, and sees only this round's fix
    const secondCheck = runner.launches[3].brief;
    expect(secondCheck).toContain('repeatSatisfied');
    expect(secondCheck).toContain('tests pass');
    expect(secondCheck).toContain('fixed in round 1');
    expect(secondCheck).not.toContain('fixed in round 0');
    expect(p.steps.every((s) => s.status === 'done')).toBe(true);
    // Review item 5: from round 2 on, the first step reads the previous
    // round's check (bounded and labelled) so the loop can converge.
    expect(runner.launches[0].brief).toBe('Fix x');
    expect(runner.launches[2].brief).toContain('Fix x');
    expect(runner.launches[2].brief).toContain('CHECK-REPORT-1');
    expect(runner.launches[2].brief).toContain('round 1');
    expect(runner.launches[2].brief).not.toContain('repeatSatisfied');
  });

  it('malformed decision output gets its one automatic report-only retry, then pauses with the real validator detail', async () => {
    const runner = new FakeRunner((l) => completes(l.stepId === 'fix' ? 'fixed' : 'looks good to me'));
    const fence = await seed(record(repeatDoc(3)));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p = await plan();
    expect(p.status).toBe('paused');
    expect(p.paused!.stepId).toBe('check');
    expect(p.paused!.reason).toMatch(/repeatSatisfied/);
    expect(p.paused).toMatchObject({ kind: 'invalid-report', retried: true });
    expect(p.steps.find((s) => s.id === 'check')!.attempts[0]).toMatchObject({ phase: 'committed', terminal: 'failed' });
    // Decision 34: a report-only retry is unconditionally fundable now, so
    // the first invalid decision gets ONE automatic tools-off retry (which
    // is just as invalid, from the same script) before this pause.
    expect(runner.launches).toHaveLength(3);
    expect(runner.launches[2]).toMatchObject({ stepId: 'check', toolsDisabled: true });
  });

  it('max iterations is a hard stop', async () => {
    const runner = new FakeRunner((l) => completes(l.stepId === 'fix'
      ? 'fixed' : JSON.stringify({ report: 'still failing', repeatSatisfied: false })));
    const doc = repeatDoc(2);
    const fence = await seed(record(doc));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p = await plan();
    expect(runner.launches).toHaveLength(4);
    expect(p.status).toBe('paused');
    expect(p.paused!.reason).toMatch(/2 times/);
    // 5b follow-up: the card words this pause from these facts.
    expect(p.paused).toMatchObject({ kind: 'iteration-cap', repeat: { rounds: 2, until: doc.steps.find((x) => x.kind === 'repeat')!.until } });
    // Continue does not run a third round.
    const again = await journal.acquireLease(REF, 'p1', { startFrom: ['paused'] });
    if (!again.ok) throw new Error('lease');
    exec.start({ ref: REF, planId: 'p1', fence: again.fence });
    await exec.settled('p1');
    expect(runner.launches).toHaveLength(4);
    expect((await plan()).status).toBe('paused');
  });
});

describe('pausing, stopping and interruption settle before anything is visible', () => {
  const FOUR: PlanDocumentV1 = { goal: 'four', steps: [
    { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Do {item}', summary: 'Plain sentence.', items: ['fail', 'quick', 'stuck1', 'stuck2'] },
    { id: 's2', kind: 'combine', specialist: 'reviewer', task: 'Combine', summary: 'Plain sentence.', of: 's1' },
  ] };
  const fourScripts = (failFirst: boolean) => (l: PlanChildLaunch): Script => {
    // Task 9a: a specialist error is retried once by itself (same brief — it
    // never got going), so this one fails on both tries.
    if (l.brief === 'Do fail') return failFirst ? failsWith('the provider returned an error', 15) : hangs(true);
    if (l.brief === 'Do quick') return hangs(true);
    return hangs(false);
  };

  it('one failing child aborts three siblings, waits only to the deadline, disposes stragglers, settles, then emits paused', async () => {
    const runner = new FakeRunner(fourScripts(true));
    const fence = await seed(record(FOUR));
    const exec = executor(runner, { settleDeadlineMs: 80 });
    const deadline = markDeadline(80);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    // WHY brief-based lookup, not hardcoded 'child-N' (2026-09-24, same root
    // cause as the deadline fix above): FakeRunner numbers children by real
    // launch-completion order, not by the map's item order, so 'Do fail' can
    // land on ANY of the four ids depending on scheduling. Under load it
    // sometimes drew 'child-3' or 'child-4' — the ids this test used to
    // assume meant "a straggler" — so its own retire()-dispose (immediate by
    // design: it's what causes the halt) was wrongly checked against the
    // settle deadline and failed. A brief names the SAME child regardless of
    // draw order.
    const childOf = (brief: string) => runner.launches.find((x) => x.brief === brief)!.childId;
    const failId = childOf('Do fail'); const quickId = childOf('Do quick');
    const stuck1Id = childOf('Do stuck1'); const stuck2Id = childOf('Do stuck2');
    // The stragglers were held for the whole deadline: they were disposed only
    // after the settle deadline fired (final review F34: an ordering the log
    // records, not a wall-clock lower bound).
    expect(deadline.fired()).toBe(true);
    for (const c of [stuck1Id, stuck2Id]) expect(log.indexOf(`dispose:${c}`)).toBeGreaterThan(log.indexOf('settle-deadline'));
    // all three siblings were aborted; every child was disposed
    expect(runner.aborted.sort()).toEqual(expect.arrayContaining([quickId, stuck1Id, stuck2Id]));
    // the failing child ran twice (the automatic retry continues the same session).
    expect(runner.disposed.sort()).toEqual([failId, failId, quickId, stuck1Id, stuck2Id].sort());
    expect(runner.launches.filter((x) => x.brief === 'Do fail')).toHaveLength(2);
    expect(runner.live).toBe(0);
    // paused is the last visible thing, after every disposal
    const pausedAt = log.indexOf('event:paused');
    expect(pausedAt).toBeGreaterThan(-1);
    for (const c of [failId, quickId, stuck1Id, stuck2Id]) expect(log.indexOf(`dispose:${c}`)).toBeLessThan(pausedAt);
    expect(events.filter((e) => e.plan.status === 'paused')).toHaveLength(1);
    const p = await plan();
    expect(p.status).toBe('paused');
    expect(p.lease).toBeUndefined();
    expect(p.paused!.reason).toContain('the provider returned an error');
    const byBrief = (b: string) => {
      const l = runner.launches.find((x) => x.brief === b)!;
      return p.steps[0].attempts.find((a) => a.attemptId === l.attemptId)!;
    };
    expect(p.paused!.attemptId).toBe(byBrief('Do fail').attemptId);
    // Task 9a: the second failure after an automatic retry is the assistant's.
    expect(p.paused!.retried).toBe(true);
    // WHY no "cut off mid-request"/ambiguous-siblings assertions any more
    // (spending rework stage 1, design §1/§3): settle no longer runs a
    // pessimistic charge-in-full pass over aborted siblings — an outcome of
    // 'interrupted' with no dangling tool call simply leaves the attempt as
    // it was (still 'launched'), read fresh by `recoverAttempt` next start.
    expect(p.paused).toMatchObject({ kind: 'specialist-error' });
    expect(p.steps[1].attempts).toHaveLength(0);
    expect(exec.activeRuns()).toBe(0);
  });

  it('a stopped specialist pauses with its own kind', async () => {
    const runner = new FakeRunner((l) => (l.brief === 'Review a' ? async () => ({ kind: 'interrupted' as const }) : completes('ok')));
    const fence = await seed(record(TWO_STEP));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    expect((await plan()).paused!.kind).toBe('specialist-stopped');
  });

  it('Stop follows the same bounded settle ordering and leaves nothing held', async () => {
    const runner = new FakeRunner(fourScripts(false));
    const fence = await seed(record(FOUR));
    const exec = executor(runner, { settleDeadlineMs: 80 });
    exec.start({ ref: REF, planId: 'p1', fence });
    await vi.waitFor(() => expect(runner.launches.length).toBe(4));
    const deadline = markDeadline(80);
    const releases: unknown[] = [];
    const release = journal.releaseLease.bind(journal);
    journal.releaseLease = async (...a) => { releases.push(a); return release(...a); };
    const applied = await exec.stop({ ref: REF, planId: 'p1', finalize: (p) => { p.status = 'stopped'; } });
    expect(applied).toBe(true);
    expect(releases).toHaveLength(0); // the lease goes in the same write as "stopped"
    log.push('stop-returned');
    // WHY brief-based lookup, not hardcoded 'child-4' (2026-09-24, same class
    // as the settle-deadline fix above): FakeRunner numbers children by real
    // launch-completion order, not by item order, so 'Do stuck2' — the one
    // whose script never honours the abort and so MUST be force-disposed
    // only once the deadline fires — can draw any of the four ids.
    const stuck2Id = runner.launches.find((l) => l.brief === 'Do stuck2')!.childId;
    // F34: the stuck ones were torn down only once the deadline had passed.
    expect(deadline.fired()).toBe(true);
    expect(log.indexOf('settle-deadline')).toBeLessThan(log.indexOf(`dispose:${stuck2Id}`));
    expect(runner.aborted.sort()).toEqual(['child-1', 'child-2', 'child-3', 'child-4']);
    expect(runner.live).toBe(0);
    const p = await plan();
    expect(p.lease).toBeUndefined();
    // PlanService's own "stopped" edit rode in the executor's final write.
    expect(p.status).toBe('stopped');
    expect(log.filter((l) => l === 'event:stopped')).toHaveLength(1);
    expect(log.indexOf(`dispose:${stuck2Id}`)).toBeLessThan(log.indexOf('event:stopped'));
    expect(log.indexOf(`dispose:${stuck2Id}`)).toBeLessThan(log.indexOf('stop-returned'));
    expect(exec.activeRuns()).toBe(0);
  });

  it('destroy / app quit interrupts active plans into recoverable journal state', async () => {
    const runner = new FakeRunner(fourScripts(false));
    const fence = await seed(record(FOUR));
    const exec = executor(runner, { settleDeadlineMs: 40 });
    exec.start({ ref: REF, planId: 'p1', fence });
    await vi.waitFor(() => expect(runner.launches.length).toBe(4));
    await exec.interruptSession('parent-1');
    let p = await plan();
    expect(p.status).toBe('interrupted');
    expect(p.lease).toBeUndefined();
    expect(p.steps[0].status).toBe('paused');
    expect(runner.live).toBe(0);
    expect(exec.activeRuns()).toBe(0);

    // Recoverable: Continue restarts the unfinished attempts (the aborted ones
    // resume their own sessions; the unsettled ones first pause as unclear).
    const again = await journal.acquireLease(REF, 'p1', { startFrom: ['interrupted'] });
    expect(again.ok).toBe(true);
    p = await plan();
    expect(p.status).toBe('running');
  });

  it('app quit interrupts every active plan', async () => {
    const runner = new FakeRunner(() => hangs(true));
    const fence = await seed(record(MAP6));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    while (runner.launches.length < 4) await new Promise((r) => setTimeout(r, 5));
    await exec.interruptAll();
    const p = await plan();
    expect(p.status).toBe('interrupted');
    expect(runner.live).toBe(0);
  });

  it('review fix 7 follow-up: the heartbeat is stopped and the run is gone BEFORE the paused card is emitted', async () => {
    const runner = new FakeRunner((l) => (l.brief === 'Review a' ? failsWith('used up') : completes('ok')));
    const fence = await seed(record(TWO_STEP));
    const timers = { setInterval: () => 'hb', clearInterval: () => { log.push('heartbeat-cleared'); } };
    const exec = executor(runner, { timers });
    const activeAtEvent: number[] = [];
    const seen = events;
    events = Object.assign(seen, {
      push: (...e: PlanEvent[]) => {
        if (e.some((x) => x.plan.status === 'paused')) activeAtEvent.push(exec.activeRuns());
        return Array.prototype.push.apply(seen, e);
      },
    });
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    expect((await plan()).status).toBe('paused');
    expect(log.indexOf('heartbeat-cleared')).toBeGreaterThan(-1);
    expect(log.indexOf('heartbeat-cleared')).toBeLessThan(log.indexOf('event:paused'));
    expect(activeAtEvent).toEqual([0]);
  });

  it('a paused, interrupted or stopped plan owns no timer', async () => {
    const live = new Set<unknown>();
    const timers = {
      setInterval: (fn: () => void, ms: number) => { const h = setInterval(fn, ms); live.add(h); return h; },
      clearInterval: (h: any) => { live.delete(h); clearInterval(h); },
    };
    const runner = new FakeRunner(fourScripts(true));
    const fence = await seed(record(FOUR));
    const exec = executor(runner, { timers });
    exec.start({ ref: REF, planId: 'p1', fence });
    expect(live.size).toBe(1);
    await exec.settled('p1');
    expect((await plan()).status).toBe('paused');
    expect(live.size).toBe(0);
  });
});

describe('the lease', () => {
  it('heartbeats inside the lease and stops when the plan settles', async () => {
    let now = 1_000;
    journal = new PlanJournal({ home, identity: { instanceId: 'me', pid: 1 }, now: () => now, onEvent: (e) => events.push(e) });
    let release!: () => void;
    const gateOpen = new Promise<void>((r) => { release = r; });
    const runner = new FakeRunner(() => async (ctx) => { await gateOpen; return completes('ok')(ctx); });
    const fence = await seed(record(MAP6));
    const exec = executor(runner, { heartbeatMs: 10 });
    exec.start({ ref: REF, planId: 'p1', fence });
    const before = (await plan()).lease!.expiresAt;
    now = 50_000;
    // Wait on the renewed lease itself, not a fixed sleep: a loaded machine
    // can miss a 10 ms tick within 40 ms (failed once under verify load,
    // 2026-09-16; test-suite-hygiene "never a fixed sleep").
    await vi.waitFor(async () => expect((await plan()).lease!.expiresAt).toBe(50_000 + 60_000));
    expect(before).toBe(61_000);
    release();
    await exec.settled('p1');
    expect((await plan()).lease).toBeUndefined();
  });

  it('a lost lease disposes every child and writes nothing more', async () => {
    const runner = new FakeRunner(() => hangs(true));
    const fence = await seed(record(MAP6));
    const exec = executor(runner, { heartbeatMs: 10 });
    exec.start({ ref: REF, planId: 'p1', fence });
    while (runner.launches.length < 4) await new Promise((r) => setTimeout(r, 5));
    // Another window takes over (user-forced recovery).
    const taken = await journal.acquireLease(REF, 'p1', { force: true });
    if (!taken.ok) throw new Error('lease');
    await exec.settled('p1');
    expect(runner.live).toBe(0);
    const p = await plan();
    expect(p.lease?.fence).toBe(taken.fence);
    expect(p.status).toBe('running');
  });

  it('an unreadable journal mid-run is reported so the card can show a failed state', async () => {
    const runner = new FakeRunner(() => async (ctx) => {
      await new Promise((r) => setTimeout(r, 20));
      return completes('ok')(ctx);
    });
    const fence = await seed(record(MAP6));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    while (runner.launches.length < 1) await new Promise((r) => setTimeout(r, 2));
    fs.writeFileSync(path.join(home.root, journal.relPath(REF)), '{ broken');
    await exec.settled('p1');
    expect(runner.unreadable).toHaveLength(1);
    expect(runner.unreadable[0]).toMatch(/^p1:The saved plan file is not valid JSON/);
    expect(runner.live).toBe(0);
    expect(exec.activeRuns()).toBe(0);
  });
});

// Final review F2: the write that ends a run (it drops the lease and shows
// the result) can fail for a moment (a lock, the disk). It is retried; if it
// still fails, recovery shows the plan paused with the real reason instead of
// a "running" card with nothing behind it.
describe('a final write that fails', () => {
  /** Fail every fenced write that would drop the lease, `times` times. */
  function failFinalWrites(times: number): { failures: () => number } {
    const orig = journal.mutateFenced.bind(journal);
    let failures = 0;
    vi.spyOn(journal, 'mutateFenced').mockImplementation(async (ref, planId, fence, fn) => {
      if (failures < times) {
        const probe = structuredClone((await journal.get(ref, planId))!);
        try { fn(probe, { v: 2, plans: [probe] }); } catch { /* the real call reports it */ }
        if (!probe.lease) { failures++; throw new Error('EIO: i/o error, write'); }
      }
      return orig(ref, planId, fence, fn);
    });
    return { failures: () => failures };
  }

  it('is retried, and the plan settles normally', async () => {
    const runner = new FakeRunner(() => completes('ok'));
    const fence = await seed(record(TWO_STEP));
    const failing = failFinalWrites(2);
    const exec = executor(runner, { settleWriteRetryDelaysMs: [0, 0] });
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    expect(failing.failures()).toBe(2);
    const p = await plan();
    expect(p.status).toBe('completed');
    expect(p.lease).toBeUndefined();
    expect(exec.orphanReason(REF, 'p1')).toBeUndefined();
  });

  it('that keeps failing is recovered as paused with the real reason, holding nothing', async () => {
    const runner = new FakeRunner((l) => (l.brief === 'Review a' ? failsWith('boom') : completes('ok')));
    const orphaned: string[] = [];
    runner.onOrphaned = (_ref, planId) => { orphaned.push(planId); };
    const fence = await seed(record(TWO_STEP));
    failFinalWrites(Infinity);
    const exec = executor(runner, { settleWriteRetryDelaysMs: [0, 0] });
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    expect(orphaned).toEqual(['p1']);
    expect(exec.activeRuns()).toBe(0);
    // What the card showed before the fix: running, with this process's lease.
    let p = await plan();
    expect(p.status).toBe('running');
    expect(journal.leaseOwner(p)).toBe('self');
    // Review fix 2 (Task 12): the card gets the general line; the system's
    // own text is kept for the bug report only.
    expect(exec.orphanReason(REF, 'p1')).toEqual({
      reason: "The plan stopped because its progress couldn't be saved.",
      report: expect.stringMatching(/EIO/),
    });
    vi.restoreAllMocks();
    // Recovery without the executor's answer still leaves this process's plan alone.
    expect((await journal.recoverInterrupted(REF)).interrupted).toEqual([]);
    const res = await journal.recoverInterrupted(REF, { orphaned: (id) => exec.orphanReason(REF, id) });
    expect(res.interrupted).toEqual(['p1']);
    p = await plan();
    expect(p.status).toBe('paused');
    expect(p.lease).toBeUndefined();
    expect(p.paused).toMatchObject({ kind: 'unexpected-error', stepId: 's1' });
    expect(p.paused!.reason).toBe("The plan stopped because its progress couldn't be saved.");
    expect(p.paused!.report).toMatch(/EIO/);
    expect(projectPlan(p).paused).toMatchObject({ reason: "The plan stopped because its progress couldn't be saved.", report: expect.stringMatching(/EIO/) });
    expect(projectPlan(p).paused!.reason).not.toMatch(/EIO/);
    exec.clearOrphan(REF, 'p1');
    expect(exec.orphanReason(REF, 'p1')).toBeUndefined();
  });

  it('a plan whose run is still active is never taken by that recovery', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const runner = new FakeRunner(() => async (ctx) => { await gate; return completes('ok')(ctx); });
    const fence = await seed(record(TWO_STEP));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await vi.waitFor(() => expect(runner.launches.length).toBeGreaterThan(0));
    const res = await journal.recoverInterrupted(REF, { orphaned: (id) => exec.orphanReason(REF, id) });
    expect(res.interrupted).toEqual([]);
    expect((await plan()).status).toBe('running');
    release();
    await exec.settled('p1');
  });
});

describe('what a specialist transcript proves', () => {
  let n = 0;
  const ev = (type: TranscriptEvent['type'], data: TranscriptEvent['data'] = {}): TranscriptEvent =>
    ({ type, sessionId: 'kid', uuid: `u${++n}`, timestamp: n, data });

  it('no brief yet → resumable, brief not delivered', () => {
    expect(classifyChildTranscript([])).toEqual({ kind: 'resumable', briefDelivered: false });
  });

  it('a finished turn with a final report → terminal, report = text after the last tool call', () => {
    expect(classifyChildTranscript([
      ev('user-message', { text: 'brief' }),
      ev('assistant-text', { text: 'let me look' }),
      ev('tool-use', { toolUseId: 't1', toolName: 'Read' }),
      ev('tool-result', { toolUseId: 't1', toolResult: 'x' }),
      ev('assistant-text', { text: 'FINAL' }),
      ev('turn-complete', { stopReason: 'end_turn' }),
    ])).toEqual({ kind: 'terminal', report: 'FINAL' });
  });

  it('a limit-stopped or errored turn is not a finished report', () => {
    const base = [ev('user-message', { text: 'b' }), ev('assistant-text', { text: 'partial' })];
    expect(classifyChildTranscript([...base, ev('turn-complete', { stopReason: PLAN_LIMIT_REACHED_STOP_REASON })]))
      .toEqual({ kind: 'resumable', briefDelivered: true });
    expect(classifyChildTranscript([...base, ev('user-interrupt')])).toEqual({ kind: 'resumable', briefDelivered: true });
    expect(classifyChildTranscript([ev('user-message', { text: 'b' }), ev('turn-complete', { stopReason: 'end_turn' })]))
      .toEqual({ kind: 'resumable', briefDelivered: true });
  });

  it('Task 9a: a tool call without a result → dangling, with its declared effect (the widest of several)', () => {
    expect(classifyChildTranscript([
      ev('user-message', { text: 'b' }),
      ev('tool-use', { toolUseId: 'w', toolName: 'Write' }),
    ])).toEqual({ kind: 'dangling-effect', tool: 'Write', effect: 'local' });
    expect(classifyChildTranscript([
      ev('user-message', { text: 'b' }),
      ev('tool-use', { toolUseId: 'r', toolName: 'Grep' }),
    ])).toEqual({ kind: 'dangling-effect', tool: 'Grep', effect: 'read' });
    expect(classifyChildTranscript([
      ev('user-message', { text: 'b' }),
      ev('tool-use', { toolUseId: 'r', toolName: 'Read' }),
      ev('tool-use', { toolUseId: 'x', toolName: 'Bash' }),
      ev('tool-use', { toolUseId: 'e', toolName: 'Edit' }),
    ])).toEqual({ kind: 'dangling-effect', tool: 'Bash', effect: 'external' });
    expect(classifyChildTranscript([
      ev('user-message', { text: 'b' }),
      ev('tool-use', { toolUseId: 'm', toolName: 'mcp__mail__send' }),
    ])).toEqual({ kind: 'dangling-effect', tool: 'mcp__mail__send', effect: 'external' });
    expect(classifyChildTranscript([
      ev('user-message', { text: 'b' }),
      ev('tool-use', { toolUseId: 'b1', toolName: 'Bash' }),
      ev('tool-result', { toolUseId: 'b1', toolResult: 'ok' }),
    ])).toEqual({ kind: 'resumable', briefDelivered: true });
  });

  it('review item 3: a finished report wins over an older dangling call, and calls before the latest turn are covered', () => {
    expect(classifyChildTranscript([
      ev('user-message', { text: 'b' }),
      ev('tool-use', { toolUseId: 'w', toolName: 'Write' }),
      ev('user-message', { text: PLAN_RESTART_BRIEF }),
      ev('assistant-text', { text: 'DONE' }),
      ev('turn-complete', { stopReason: 'end_turn' }),
    ])).toEqual({ kind: 'terminal', report: 'DONE' });
    expect(classifyChildTranscript([
      ev('user-message', { text: 'b' }),
      ev('tool-use', { toolUseId: 'w', toolName: 'Write' }),
      ev('user-message', { text: PLAN_RESTART_BRIEF }),
    ])).toEqual({ kind: 'resumable', briefDelivered: true });
  });

  it('a later restart turn is judged on its own: an older finished turn does not count', () => {
    expect(classifyChildTranscript([
      ev('user-message', { text: 'b' }),
      ev('assistant-text', { text: 'old' }),
      ev('turn-complete', { stopReason: PLAN_LIMIT_REACHED_STOP_REASON }),
      ev('user-message', { text: PLAN_RESTART_BRIEF }),
    ])).toEqual({ kind: 'resumable', briefDelivered: true });
  });
});

// WHY describe('a specialist whose budget route cannot be used', …) is GONE:
// superseded exactly by 'review fix 6: a start the runner refuses …' below,
// which throws PlanLaunchRefusedError directly from runner.launch — the real
// T1 mechanism (nothing refuses a launch for BUDGET reasons any more).
//
// WHY describe('review fixes (Task 4 review 1)', …)'s first two tests
// ('item 1: …Add budget…', 'round 2: …shortfall…') are GONE: Add budget and
// the ceiling shortfall pause no longer exist (decision 34). Its third test
// ('items 3 and 4: an acknowledged dangling action restarts …') is superseded
// by 'a specialist error that left a Bash call unanswered …' below, which
// exercises the SAME check-first restart end to end through a real pause
// write (settle's finalWrite setting `pauseAcknowledged`) rather than a
// hand-seeded flag — see describe('Task 9a: automatic recovery …').

describe('Task 9a: automatic recovery (pause handoff §1)', () => {
  const THREE: PlanDocumentV1 = { goal: 'three', steps: [
    { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Do {item}', summary: 'Plain sentence.', items: ['flaky', 'b', 'c'] },
  ] };
  const slowCompletes = (ms: number): Script => async (ctx) => {
    await new Promise((r) => setTimeout(r, ms));
    return completes(`done ${ctx.launch.brief}`)(ctx);
  };
  const failsOnce = (): ((l: PlanChildLaunch) => Script) => {
    let failed = false;
    return (l) => {
      if (l.brief !== 'Do flaky') return slowCompletes(60);
      if (!failed) { failed = true; return failsWith('the provider hiccupped'); }
      return completes('flaky done');
    };
  };

  it('a specialist error retries that one member inside the wave: siblings keep running and are not charged', async () => {
    const runner = new FakeRunner(failsOnce());
    const fence = await seed(record(THREE));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p = await plan();
    expect(p.status).toBe('completed');
    expect(events.some((e) => e.plan.status === 'paused')).toBe(false);
    // Nobody was stopped; the flaky one ran twice on the same session.
    expect(runner.aborted).toEqual([]);
    // WHY brief-based lookup, not hardcoded 'child-1' (2026-09-24, same class
    // as the settle-deadline fix above): FakeRunner numbers children by real
    // launch-completion order, not by item order, so 'Do flaky' can draw any
    // of the three ids depending on scheduling.
    const flaky = runner.launches.filter((l) => l.brief === 'Do flaky');
    expect(flaky).toHaveLength(2);
    expect(flaky[1]).toMatchObject({ resumeChildId: flaky[0].childId, attemptId: flaky[0].attemptId });
    expect(runner.launches.filter((l) => l.brief === 'Do b')).toHaveLength(1);
    expect(runner.launches.filter((l) => l.brief === 'Do c')).toHaveLength(1);
    // The siblings were still running when the retry launched.
    const atRetry = runner.planAtLaunch[3];
    expect(atRetry.steps[0].attempts.filter((a) => a.phase === 'committed')).toHaveLength(0);
    // The recovery was journalled BEFORE the relaunch.
    expect(atRetry.recoveries).toEqual([expect.objectContaining({ stepId: 's1', iteration: 0, itemIndex: 0, cause: 'specialist-error' })]);
    expect(p.steps[0].attempts).toHaveLength(3);
    // The card: one row per specialist, the retried one says so.
    const rows = projectPlan(p).steps[0].children!;
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.childId === flaky[0].childId)!.retried).toBe(true);
    expect(rows.filter((r) => r.retried)).toHaveLength(1);
  });

  it('a crash between the recovery write and the relaunch never yields a second automatic retry', async () => {
    // The journal exactly as the recovery write left it: recovery recorded,
    // hold given back, nothing relaunched yet — then the app died.
    const rec = record(THREE, {
      status: 'interrupted', usedTokens: 100,
      recoveries: [{ stepId: 's1', iteration: 0, itemIndex: 0, cause: 'specialist-error', at: 1 }],
      steps: [{ id: 's1', status: 'paused', attempts: [
        attemptRec({ attemptId: 'f', itemIndex: 0, childId: 'kid-f', phase: 'launched', spentTokens: 100 }),
        committed('c1', 1, 'B'), committed('c2', 2, 'C'),
      ] }],
    });
    const runner = new FakeRunner(() => failsWith('the provider hiccupped again'));
    runner.verdicts.set('kid-f', { kind: 'resumable', briefDelivered: true });
    const fence = await seed(rec);
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p = await plan();
    // Continue restarted it once (the person's Continue, not an automatic
    // retry); its failure is the assistant's.
    expect(runner.launches).toHaveLength(1);
    expect(p.status).toBe('paused');
    expect(p.paused).toMatchObject({ kind: 'specialist-error', attemptId: 'f', retried: true });
    expect(p.recoveries).toHaveLength(1);
  });

  it('review fix 4: a recovery the user\'s Continue reset does not count — the next hiccup is retried by itself again', async () => {
    const rec = record(THREE, {
      status: 'interrupted', usedTokens: 100,
      recoveries: [{ stepId: 's1', iteration: 0, itemIndex: 0, cause: 'specialist-error', at: 1, relaunched: true, reset: true }],
      steps: [{ id: 's1', status: 'paused', attempts: [
        attemptRec({ attemptId: 'f', itemIndex: 0, childId: 'kid-f', phase: 'launched', spentTokens: 100 }),
        committed('c1', 1, 'B'), committed('c2', 2, 'C'),
      ] }],
    });
    let failed = false;
    const runner = new FakeRunner(() => {
      if (failed) return completes('ok');
      failed = true;
      return failsWith('hiccup');
    });
    runner.verdicts.set('kid-f', { kind: 'resumable', briefDelivered: true });
    const fence = await seed(rec);
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p = await plan();
    expect(runner.launches).toHaveLength(2);
    expect(p.status).toBe('completed');
    expect(p.recoveries).toHaveLength(2);
    expect(p.recoveries![1]).toMatchObject({ cause: 'specialist-error', relaunched: true });
    expect(p.recoveries![1].reset).toBeUndefined();
  });

  it('review fix 3: a restart after Continue (a cut-off local call) is not "Retried after an error"', async () => {
    await resumeWithTool('Write');
    const p = await plan();
    expect(p.recoveries).toHaveLength(1);
    expect(projectPlan(p).steps[0].children!.some((c) => c.retried)).toBe(false);
  });

  it('review fix 3: a recovery recorded before a crash (never relaunched automatically) does not mark the row', async () => {
    const rec = record(THREE, {
      status: 'interrupted', usedTokens: 100,
      recoveries: [{ stepId: 's1', iteration: 0, itemIndex: 0, cause: 'specialist-error', at: 1 }],
      steps: [{ id: 's1', status: 'paused', attempts: [
        attemptRec({ attemptId: 'f', itemIndex: 0, childId: 'kid-f', phase: 'launched', spentTokens: 100 }),
        committed('c1', 1, 'B'), committed('c2', 2, 'C'),
      ] }],
    });
    expect(projectPlan(rec).steps[0].children!.find((c) => c.childId === 'kid-f')!.retried).toBeUndefined();
  });

  it('R3(d): a specialist error that left a Bash call unanswered goes to the assistant; Continue then restarts it with the check-first turn and does not re-pause', async () => {
    const runner = new FakeRunner((l) => (l.brief === 'Do flaky' ? failsWith('lost the connection') : slowCompletes(5)));
    // WHY inspectTranscript keyed by brief, not `verdicts.set('child-1', …)`
    // (2026-09-24, same class as the settle-deadline fix above): FakeRunner
    // numbers children by real launch-completion order, not by item order,
    // so 'Do flaky' can draw any of the three ids and a fixed 'child-1'
    // verdict would silently land on the wrong (or no) child.
    runner.inspectTranscript = (_ref, childId) => {
      const l = runner.launches.find((x) => x.childId === childId);
      if (l?.brief === 'Do flaky') return { kind: 'dangling-effect', tool: 'Bash', effect: 'external' };
      return { kind: 'resumable', briefDelivered: false };
    };
    const fence = await seed(record(THREE));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    let p = await plan();
    expect(runner.launches.filter((l) => l.brief === 'Do flaky')).toHaveLength(1);
    const flakyId = runner.launches.find((l) => l.brief === 'Do flaky')!.childId;
    expect(p.paused).toMatchObject({ kind: 'unknown-outcome', tool: 'Bash', toolEffect: 'external' });
    expect(p.paused!.reason).toContain('lost the connection');
    expect(p.paused!.retried).toBeUndefined();
    expect(p.recoveries).toBeUndefined();
    // R1/R2: the attempt stays 'launched' (never treated as 'prepared'), and
    // is marked acknowledged in the SAME write that wrote this pause — the
    // ONLY way this plan runs again is a real Continue.
    const flakyAttempt = p.steps[0].attempts.find((a) => a.childId === flakyId)!;
    expect(flakyAttempt).toMatchObject({ phase: 'launched', pauseAcknowledged: true });

    // R3(d): Continue — a bare re-acquire of the lease, exactly what
    // PlanService.resume() does — restarts it with the check-first turn and
    // does NOT show the identical pause again.
    runner.script = () => completes('checked and done');
    const before = runner.launches.length;
    const again = await journal.acquireLease(REF, 'p1', { startFrom: ['paused'] });
    if (!again.ok) throw new Error('lease');
    exec.start({ ref: REF, planId: 'p1', fence: again.fence });
    await exec.settled('p1');
    p = await plan();
    const restart = runner.launches.slice(before).find((l) => l.resumeChildId === flakyId);
    expect(restart).toMatchObject({ resumeChildId: flakyId, brief: planRestartBrief({ kind: 'dangling-effect', tool: 'Bash', effect: 'external' }) });
    expect(p.status).toBe('completed');
    // The flag was consumed — not left around to bypass a FUTURE dangling call.
    expect(p.steps[0].attempts.find((a) => a.childId === flakyId)!.pauseAcknowledged).toBeUndefined();
  });

  it.each(['BashOutput', 'WebSearch'])('a specialist error that left a %s call unanswered is still retried by itself', async (tool) => {
    const runner = new FakeRunner(failsOnce());
    // WHY inspectTranscript keyed by brief — see the WHY two tests above.
    runner.inspectTranscript = (_ref, childId) => {
      const l = runner.launches.find((x) => x.childId === childId);
      if (l?.brief === 'Do flaky') return { kind: 'dangling-effect', tool, effect: nativeToolEffect(tool) };
      return { kind: 'resumable', briefDelivered: false };
    };
    const fence = await seed(record(THREE));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p = await plan();
    expect(p.status).toBe('completed');
    const flakyId = runner.launches.find((l) => l.brief === 'Do flaky')!.childId;
    // A cut-off read is simply re-run: the plain continue turn.
    expect(runner.launches.find((l) => l.resumeChildId === flakyId)!.brief).toBe(PLAN_RESTART_BRIEF);
  });

  const resumeWith = (tool: string) => resumeWithTool(tool);
  async function resumeWithTool(tool: string) {
    const rec = record(TWO_STEP, {
      status: 'interrupted', usedTokens: 700,
      steps: [
        { id: 's1', status: 'paused', attempts: [committed('c1', 0, 'A'), attemptRec({ attemptId: 'p2', itemIndex: 1, childId: 'kid-2', phase: 'launched', spentTokens: 300 })] },
        { id: 's2', status: 'pending', attempts: [] },
      ],
    });
    const runner = new FakeRunner(() => completes('B'));
    runner.verdicts.set('kid-2', { kind: 'dangling-effect', tool, effect: nativeToolEffect(tool) });
    const fence = await seed(rec);
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    return runner;
  }

  it.each(['BashOutput', 'WebSearch', 'Read'])('a cut-off %s call is re-run by itself on Continue', async (tool) => {
    const runner = await resumeWith(tool);
    expect(runner.launches[0]).toMatchObject({ attemptId: 'p2', brief: PLAN_RESTART_BRIEF });
    const p = await plan();
    expect(p.status).toBe('completed');
    expect(p.recoveries).toEqual([expect.objectContaining({ itemIndex: 1, cause: 'unknown-outcome' })]);
  });

  it.each(['Write', 'Edit'])('a cut-off %s call restarts by itself with the brief that says to check first', async (tool) => {
    const runner = await resumeWith(tool);
    expect(runner.launches[0].brief).toBe(planRestartBrief({ kind: 'dangling-effect', tool, effect: 'local' }));
    expect(runner.launches[0].brief).toContain(tool);
    expect((await plan()).status).toBe('completed');
  });

  it.each(['Bash', 'WebFetch', 'mcp__mail__send', 'SomethingUnclassified'])('a cut-off %s call goes to the assistant', async (tool) => {
    const runner = await resumeWith(tool);
    expect(runner.launches).toHaveLength(0);
    expect((await plan()).paused).toMatchObject({ kind: 'unknown-outcome', tool, toolEffect: 'external' });
  });

  it('a start error is retried once; a second one goes to the assistant', async () => {
    const runner = new FakeRunner(() => completes('ok'));
    const real = runner.launch.bind(runner);
    let throws = 2;
    runner.launch = async (input) => {
      if (input.brief === 'Do flaky' && throws-- > 0) throw new Error('the model service refused the connection');
      return real(input);
    };
    const fence = await seed(record(THREE));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p = await plan();
    expect(throws).toBe(0);
    expect(p.paused).toMatchObject({ kind: 'launch-failed', retried: true });
    expect(p.paused!.reason).toContain('refused the connection');
    expect(p.recoveries).toEqual([expect.objectContaining({ itemIndex: 0, cause: 'launch-failed' })]);
  });

  it('a start error once is recovered and the plan completes', async () => {
    const runner = new FakeRunner(() => completes('ok'));
    const real = runner.launch.bind(runner);
    let throws = 1;
    runner.launch = async (input) => {
      if (input.brief === 'Do flaky' && throws-- > 0) throw new Error('temporary');
      return real(input);
    };
    const fence = await seed(record(THREE));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    expect((await plan()).status).toBe('completed');
  });

  // Task 13 (decision 26) — an error that cannot heal itself is never retried.
  // Destin, 2026-09-18: "the plan burned its one automatic retry on 'Sign in
  // with ChatGPT…', which could never succeed."
  describe('a provider that is not ready', () => {
    const SIGN_IN = 'Sign in with ChatGPT in Settings → Model Providers to use this model.';

    it('takes NO automatic retry after a start failure, and records the not-ready fact', async () => {
      const runner = new FakeRunner(() => completes('ok'));
      runner.notReady = SIGN_IN;
      const real = runner.launch.bind(runner);
      let calls = 0;
      runner.launch = async (input) => {
        if (input.brief === 'Do flaky') { calls++; throw new Error('the model service refused the connection'); }
        return real(input);
      };
      const fence = await seed(record(THREE));
      const exec = executor(runner);
      exec.start({ ref: REF, planId: 'p1', fence });
      await exec.settled('p1');
      const p = await plan();
      expect(calls).toBe(1);                       // exactly one launch, zero retries
      expect(p.recoveries).toBeUndefined();        // no recovery was journalled
      expect(p.paused).toMatchObject({ kind: 'launch-failed', launch: 'not-ready' });
      // Review finding 7: the provider's sentence FOLLOWS the failure text as
      // its own sentence. The start error rarely ends in a full stop, and
      // running the two together read as one garbled line on the card.
      expect(p.paused!.reason).toBe(
        `A specialist in step "s1" couldn't start: the model service refused the connection. ${SIGN_IN}`,
      );
      expect(runner.notReadyAsked).toContain('reviewer');
      // Review finding 3: the guarded fact is `launch: 'not-ready'` above — it
      // is what reaches PlanView and what PlanCard's fallback reads. These two
      // buttons are NOT proof of it: an unrecognised pause falls back to the
      // same pair (pause-routing.ts). The live routing rule is guarded in
      // plan-pause-routing.test.ts, the card's reading of the value in
      // plan-card-final-review.test.tsx.
      expect(pausedRouting(p.paused!).actions).toEqual(['continue', 'stop']);
    });

    it('takes NO automatic retry after a specialist error, and the card keeps Continue', async () => {
      const runner = new FakeRunner((l) => (l.brief === 'Do flaky' ? failsWith(SIGN_IN) : completes('ok')));
      runner.notReady = SIGN_IN;
      const fence = await seed(record(THREE));
      const exec = executor(runner);
      exec.start({ ref: REF, planId: 'p1', fence });
      await exec.settled('p1');
      const p = await plan();
      expect(runner.launches.filter((l) => l.brief === 'Do flaky')).toHaveLength(1);
      expect(p.recoveries).toBeUndefined();
      expect(p.paused).toMatchObject({ kind: 'specialist-error', launch: 'not-ready' });
      // The sentence the specialist died with is already the provider's own —
      // it is not repeated twice.
      expect(p.paused!.reason).toBe(`A specialist in step "s1" stopped with an error: ${SIGN_IN}`);
      // See finding 3 above: the buttons are not what this proves.
      expect(pausedRouting(p.paused!).actions).toEqual(['continue', 'stop']);
    });

    it('a launch refused by the readiness check itself is a pause, never a retry and never Stop-only', async () => {
      const runner = new FakeRunner(() => completes('ok'));
      const real = runner.launch.bind(runner);
      let calls = 0;
      runner.launch = async (input) => {
        if (input.brief === 'Do flaky') { calls++; throw new PlanNotReadyError(SIGN_IN); }
        return real(input);
      };
      const fence = await seed(record(THREE));
      const exec = executor(runner);
      exec.start({ ref: REF, planId: 'p1', fence });
      await exec.settled('p1');
      const p = await plan();
      expect(calls).toBe(1);
      expect(p.recoveries).toBeUndefined();
      expect(p.paused).toMatchObject({ kind: 'launch-failed', launch: 'not-ready' });
      expect(p.paused!.reason).toBe(`A specialist in step "s1" couldn't start: ${SIGN_IN}`);
      // See finding 3 above: the buttons are not what this proves.
      expect(pausedRouting(p.paused!).actions).toEqual(['continue', 'stop']);
    });

    it('does not spend the report-only turn on a specialist whose provider cannot answer', async () => {
      // Review finding 10: the report-only re-send is a second route to an
      // automatic retry, and it did not ask. A provider that is signed out
      // cannot answer the report turn either.
      const BIG: PlanDocumentV1 = { goal: 'big', steps: [
        { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Write it up {item}', summary: 'Plain sentence.', items: ['x'] },
      ] };
      const runner = new FakeRunner(() => completes('   ', 1000, 500));
      runner.notReady = SIGN_IN;
      const fence = await seed(record(BIG));
      const exec = executor(runner);
      exec.start({ ref: REF, planId: 'p1', fence });
      await exec.settled('p1');
      const p = await plan();
      expect(runner.launches.filter((l) => l.stepId === 's1')).toHaveLength(1); // no report-only re-send
      expect(p.recoveries).toBeUndefined();
      expect(p.paused).toMatchObject({ kind: 'invalid-report' });
      expect(runner.notReadyAsked).toContain('reviewer');
    });

    it('still takes its one retry when the provider IS ready', async () => {
      const runner = new FakeRunner(failsOnce());
      runner.notReady = undefined;
      const fence = await seed(record(THREE));
      const exec = executor(runner);
      exec.start({ ref: REF, planId: 'p1', fence });
      await exec.settled('p1');
      expect((await plan()).status).toBe('completed');
      expect(runner.notReadyAsked).toEqual(['reviewer']);
      // Both the original launch and the retry keep brief 'Do flaky' (the
      // verdict stays the default resumable/not-yet-delivered), so a brief
      // filter alone finds both regardless of which id either one drew.
      expect(runner.launches.filter((l) => l.brief === 'Do flaky')).toHaveLength(2);
    });
  });

  it('a specialist that changed since approval (drift) is never retried', async () => {
    const runner = new FakeRunner(() => completes('ok'));
    const real = runner.launch.bind(runner);
    let calls = 0;
    runner.launch = async (input) => {
      if (input.brief === 'Do flaky') { calls++; throw new PlanLaunchDriftError('its instructions changed'); }
      return real(input);
    };
    const fence = await seed(record(THREE));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p = await plan();
    expect(calls).toBe(1);
    expect(p.paused).toMatchObject({ kind: 'launch-failed', launch: 'drift' });
    expect(p.recoveries).toBeUndefined();
  });

  it('review fix 1: a pause never settles while a sibling\'s retry is still journalling its recovery', async () => {
    // flaky fails at once → restartAfter's own recovery write (recordRecovery,
    // BEFORE the relaunch) is what this test delays. b's launch is refused
    // outright (never retried), which requests the pause almost immediately —
    // proving settle must still wait for flaky's in-flight write before
    // tearing anything down. c honours the abort.
    // b's refusal waits until flaky's retry write has actually started (a
    // signal, not a sleep, so the order holds under any load) — otherwise it
    // can race ahead and halt the run before 'Do c' even launches.
    let retryWriting!: () => void;
    const retryWritingSeen = new Promise<void>((r) => { retryWriting = r; });
    let halted!: () => void;
    const haltSeen = new Promise<void>((r) => { halted = r; });
    const runner = new FakeRunner((l) => (l.brief === 'Do flaky' ? failsWith('hiccup') : hangs(true)));
    const real = runner.launch.bind(runner);
    runner.launch = async (input) => {
      if (input.brief === 'Do b') { await retryWritingSeen; throw new PlanLaunchRefusedError('nothing was sent'); }
      return real(input);
    };
    const fence = await seed(record(THREE));
    // The settle's wait for member work is bounded by its deadline (follow-up
    // 1); this test's retry write takes 100 ms on purpose, so the deadline is longer.
    const exec = executor(runner, { settleDeadlineMs: 2_000 });
    const realHalt = (exec as any).requestHalt.bind(exec);
    (exec as any).requestHalt = (run: unknown, req: { kind: string }) => { realHalt(run, req); if (req.kind === 'pause') halted(); };
    const realMutate = journal.mutateFenced.bind(journal);
    vi.spyOn(journal, 'mutateFenced').mockImplementation(async (ref: any, planId: any, fence2: any, fn: any) => {
      // Probe (same trick as `failFinalWrites` above): is this write ABOUT TO
      // add a recovery — i.e. is it restartAfter's own record-before-relaunch
      // write? Only that one write is delayed.
      const probe = structuredClone((await journal.get(ref, planId))!);
      const before = probe.recoveries?.length ?? 0;
      try { fn(probe); } catch { /* the real call reports it */ }
      const isRetryWrite = (probe.recoveries?.length ?? 0) > before;
      if (isRetryWrite) { retryWriting(); await haltSeen; await new Promise((r) => setTimeout(r, 100)); }
      const out = await realMutate(ref, planId, fence2, fn);
      if (isRetryWrite) log.push('retry-reserved');
      return out;
    });
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p = await plan();
    expect(p.status).toBe('paused');
    expect(p.paused).toMatchObject({ kind: 'launch-failed', launch: 'refused' });
    // WHY brief-based lookup, not hardcoded 'child-N' (2026-09-24, same class
    // as the settle-deadline fix): FakeRunner numbers children by real
    // launch-completion order, not by item order, so 'c' (the one that
    // honours the abort and is the last live sibling disposed) can draw any
    // of the three ids depending on scheduling.
    const cId = runner.launches.find((l) => l.brief === 'Do c')!.childId;
    const flakyId = runner.launches.find((l) => l.brief === 'Do flaky')!.childId;
    // The retry's write landed before settle tore anything down …
    expect(log.indexOf('retry-reserved')).toBeGreaterThan(-1);
    expect(log.indexOf('retry-reserved')).toBeLessThan(log.indexOf(`dispose:${cId}`));
    // … and, because the plan was already halting by the time that write
    // resolved, restartAfter still reports 'halted': nothing was relaunched.
    expect(runner.launches.filter((l) => l.resumeChildId === flakyId)).toHaveLength(0);
    expect(runner.live).toBe(0);
    expect(exec.activeRuns()).toBe(0);
  });

  it('review fix 1: a journal failure while a start error is being retried pauses on that specialist (never an escaped error)', async () => {
    const runner = new FakeRunner(() => slowCompletes(5));
    const real = runner.launch.bind(runner);
    runner.launch = async (input) => {
      if (input.brief === 'Do flaky') throw new Error('could not start');
      return real(input);
    };
    const fence = await seed(record(THREE));
    const realMutate = journal.mutateFenced.bind(journal);
    vi.spyOn(journal, 'mutateFenced').mockImplementation(async (ref: any, planId: any, fence2: any, fn: any) => {
      // Same probe as above: is this write about to record a recovery?
      const probe = structuredClone((await journal.get(ref, planId))!);
      const before = probe.recoveries?.length ?? 0;
      try { fn(probe); } catch { /* the real call reports it */ }
      if ((probe.recoveries?.length ?? 0) > before) throw new Error('disk full');
      return realMutate(ref, planId, fence2, fn);
    });
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p = await plan();
    const flaky = p.steps[0].attempts.find((a) => a.itemIndex === 0)!;
    expect(p.paused).toMatchObject({ kind: 'unexpected-error', attemptId: flaky.attemptId });
    expect(p.paused!.reason).toContain('disk full');
    expect(runner.live).toBe(0);
  });

  it('follow-up 1: a member stuck in its launch holds the settle only until the deadline; a late launch is torn down', async () => {
    const runner = new FakeRunner(() => completes('ok'));
    const real = runner.launch.bind(runner);
    let lateStart!: () => void;
    const stuck = new Promise<void>((r) => { lateStart = r; });
    let lateHandle: PlanChildHandle | undefined;
    // WHY 'Do b' waits for 'Do flaky' to have actually entered its launch
    // (found flaky, 2026-09-24, while verifying an unrelated change — fixed
    // per the "a flaky test is fixed when found" rule): both members' own
    // `memberStart` calls read the journal (real fs) independently before
    // either reaches `runner.launch`, so which one's read resolves first is
    // not guaranteed. If 'b's rejection (and the halt it requests) lands
    // before 'flaky' calls `runner.launch`, the `if (run.halt) return
    // undefined` guard at the top of `memberStart`'s loop makes 'flaky' bail
    // WITHOUT ever calling launch — so it never actually gets stuck, and the
    // "still busy" assertion below flakes under load. This signal makes the
    // ordering the test needs explicit instead of incidental.
    let flakyEntered!: () => void;
    const flakyEntered$ = new Promise<void>((r) => { flakyEntered = r; });
    runner.launch = async (input) => {
      if (input.brief === 'Do b') { await flakyEntered$; throw new PlanLaunchRefusedError('nothing was sent'); }
      if (input.brief === 'Do flaky') {
        flakyEntered();
        await stuck;   // ignores the abort — a start that never comes back in time
        // (A real host's own fenced journal write would already refuse here,
        // since the lease is gone; skipping it exercises the executor's own
        // teardown of a start that lands after settle.)
        lateHandle = await real({ ...input, recordChild: async () => {} });
        return lateHandle;
      }
      return real(input);
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fence = await seed(record(THREE));
    const exec = executor(runner, { settleDeadlineMs: 60 });
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p = await plan();
    expect(p.status).toBe('paused');
    expect(p.lease).toBeUndefined();
    expect(errors.mock.calls.some((c) => String(c[0]).includes('still busy'))).toBe(true);
    // The start comes back after the plan settled: it is disposed, never run.
    lateStart();
    await vi.waitFor(() => expect(lateHandle).toBeDefined());
    await vi.waitFor(() => expect(runner.disposed).toContain(lateHandle!.childId));
    expect(runner.live).toBe(0);
    errors.mockRestore();
  });

  it('follow-up 2: a run finishing late never drops the NEXT run of the same plan from the executor\'s books', async () => {
    const runner = new FakeRunner(() => completes('ok'));
    runner.launch = async () => { throw new PlanLaunchRefusedError('no'); };
    const fence = await seed(record(THREE));
    const exec = executor(runner);
    const key = `${REF.sessionId}\u0000p1`;
    const finishing = (exec as any).finishing as Map<string, unknown>;
    const realSettle = (exec as any).settle.bind(exec);
    let calls = 0;
    let releaseSecondWrite!: () => void;
    const secondWriteGate = new Promise<void>((r) => { releaseSecondWrite = r; });
    let secondRun: unknown;
    // Hold the SECOND run's final write while it is in `finishing`.
    const realMutate = journal.mutateFenced.bind(journal);
    vi.spyOn(journal, 'mutateFenced').mockImplementation(async (...args: any[]) => {
      if (secondRun && finishing.get(key) === secondRun) await secondWriteGate;
      return (realMutate as any)(...args);
    });
    (exec as any).settle = async (run: unknown) => {
      const n = ++calls;
      await realSettle(run);
      if (n !== 1) return;
      // Run A has written "paused"; before its bookkeeping ends, the user
      // presses Continue and run B reaches its own final write.
      const again = await journal.acquireLease(REF, 'p1', { startFrom: ['paused'] });
      if (!again.ok) throw new Error('lease');
      exec.start({ ref: REF, planId: 'p1', fence: again.fence });
      secondRun = (exec as any).runs.get(key);
      await vi.waitFor(() => expect(finishing.get(key)).toBe(secondRun));
    };
    exec.start({ ref: REF, planId: 'p1', fence });
    const firstRun = (exec as any).runs.get(key);
    await vi.waitFor(() => expect(secondRun).toBeDefined());
    await firstRun.done;
    // Run A's cleanup left run B's entry alone …
    expect(finishing.get(key)).toBe(secondRun);
    // … so waiting for the plan still waits for B.
    let settled = false;
    const waiting = exec.settled('p1').then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    releaseSecondWrite();
    await waiting;
    expect(finishing.size).toBe(0);
    expect((await plan()).lease).toBeUndefined();
  });

  it('review fix 6: a start the runner refuses (no approved settings, unusable budget route) is never retried and is Stop-only', async () => {
    const runner = new FakeRunner(() => completes('ok'));
    const real = runner.launch.bind(runner);
    let calls = 0;
    runner.launch = async (input) => {
      if (input.brief === 'Do flaky') { calls++; throw new PlanLaunchRefusedError('the plan has no approved settings for the "reviewer" specialist'); }
      return real(input);
    };
    const fence = await seed(record(THREE));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p = await plan();
    expect(calls).toBe(1);
    expect(p.paused).toMatchObject({ kind: 'launch-failed', launch: 'refused' });
    expect(p.recoveries).toBeUndefined();
    expect(pausedRouting(p.paused!)).toEqual({ route: 'assistant', actions: ['stop'] });
  });

  describe('the report-only turn after an invalid report', () => {
    const BIG: PlanDocumentV1 = { goal: 'big', steps: [
      { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Write it up {item}', summary: 'Plain sentence.', items: ['x'] },
      { id: 's2', kind: 'combine', specialist: 'reviewer', task: 'Combine', summary: 'Plain sentence.', of: 's1' },
    ] };

    it('asks the same specialist once more, tools off, from the failed attempt\'s unspent share', async () => {
      let first = true;
      const runner = new FakeRunner((l) => {
        if (l.stepId !== 's1') return completes('combined');
        if (first) { first = false; return completes('   '); }
        return completes('THE REPORT');
      });
      const fence = await seed(record(BIG));
      const exec = executor(runner);
      exec.start({ ref: REF, planId: 'p1', fence });
      await exec.settled('p1');
      const p = await plan();
      expect(p.status).toBe('completed');
      const [a, b] = runner.launches.filter((l) => l.stepId === 's1');
      // T2 fix (found in the T1 fix round): `createAttempts`'s `reportOnlyOf`
      // branch now copies the failed attempt's `childId` onto the new
      // report-only attempt, so this retry CONTINUES the same specialist
      // session — matching `PlanAttemptRecord.reportOnly`'s own doc-comment
      // ("continues the failed attempt's specialist session") and the card's
      // "one row per specialist" projection (plan-journal.ts's per-child
      // grouping, Task 4 review item 6).
      expect(b.resumeChildId).toBe(a.childId);
      expect(b.toolsDisabled).toBe(true);
      expect(a.toolsDisabled).toBeUndefined();
      expect(b.attemptId).not.toBe(a.attemptId);
      expect(b.brief).toMatch(/switched off/);
      expect(b.brief).toMatch(/report/);
      const attempts = p.steps[0].attempts;
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toMatchObject({ terminal: 'failed' });
      expect(attempts[1]).toMatchObject({ reportOnly: true, terminal: 'completed', reportText: 'THE REPORT', childId: a.childId });
      expect(p.recoveries).toEqual([expect.objectContaining({ stepId: 's1', cause: 'invalid-report' })]);
      // The combine step read the report-only answer.
      expect(runner.launches.find((l) => l.stepId === 's2')!.brief).toContain('THE REPORT');
      // Same session continued the whole way: one row, not two.
      const rows = projectPlan(p).steps[0].children!;
      expect(rows).toHaveLength(1);
      expect(rows.find((r) => r.childId === b.childId)).toMatchObject({ status: 'completed' });
    });

    it('a repeat check answers in the required form on its report-only turn', async () => {
      const doc: PlanDocumentV1 = { goal: 'loop', steps: [
        { id: 'r', kind: 'repeat', specialist: 'reviewer', task: 'loop', summary: 'Plain sentence.', max_iterations: 2, until: 'tests pass',
          steps: [
            { id: 'fix', kind: 'map', specialist: 'reviewer', task: 'Fix {item}', summary: 'Plain sentence.', items: ['x'] },
            { id: 'check', kind: 'verify', specialist: 'reviewer', task: 'Check the fix', summary: 'Plain sentence.', of: 'fix' },
          ] },
      ] };
      let checks = 0;
      const runner = new FakeRunner((l) => (l.stepId === 'fix' ? completes('fixed')
        : ++checks === 1 ? completes('looks good to me') : completes(JSON.stringify({ report: 'ok', repeatSatisfied: true }))));
      const fence = await seed(record(doc));
      const exec = executor(runner);
      exec.start({ ref: REF, planId: 'p1', fence });
      await exec.settled('p1');
      expect((await plan()).status).toBe('completed');
      const retry = runner.launches[2];
      expect(retry).toMatchObject({ stepId: 'check', toolsDisabled: true });
      expect(retry.brief).toContain('repeatSatisfied');
      expect(retry.brief).toContain("didn't answer in the required form");
    });

    // WHY 'review fix 2: the re-sent transcript counts …'/'…exactly enough
    // (measured input + 2,000) is fundable'/'…a request that cannot be
    // measured is not fundable'/'less than the report allowance left …' are
    // ALL GONE (spending rework stage 1, decision 34): reportOnlyRetry's own
    // WHY comment says a report-only retry is now unconditionally fundable —
    // there is no measured input bound left to be short of, or unable to
    // measure. The pause those cases produced no longer exists.

    it('a Continue after the report-only message was delivered never sends that message twice', async () => {
      const rec = record(BIG, {
        status: 'paused', paused: { stepId: 's1', reason: 'x', kind: 'invalid-report', attemptId: 'ro' }, usedTokens: 1500,
        recoveries: [{ stepId: 's1', iteration: 0, itemIndex: 0, cause: 'invalid-report', at: 1, relaunched: true }],
        steps: [
          { id: 's1', status: 'paused', attempts: [
            attemptRec({ attemptId: 'bad', childId: 'kid-s', spentTokens: 1500, phase: 'committed', terminal: 'failed', reportText: '', completedAt: 2 }),
            attemptRec({ attemptId: 'ro', childId: 'kid-s', phase: 'prepared', reportOnly: true, brief: 'REPORT NOW' }),
          ] },
          { id: 's2', status: 'pending', attempts: [] },
        ],
      });
      const runner = new FakeRunner(() => completes('R'));
      runner.verdicts.set('kid-s', { kind: 'resumable', briefDelivered: true });
      runner.userTexts.set('kid-s', 'REPORT NOW');
      const fence = await seed(rec);
      const exec = executor(runner);
      exec.start({ ref: REF, planId: 'p1', fence });
      await exec.settled('p1');
      expect(runner.launches[0]).toMatchObject({ attemptId: 'ro', resumeChildId: 'kid-s', brief: PLAN_REPORT_ONLY_RESEND, toolsDisabled: true });
      expect(PLAN_REPORT_ONLY_RESEND).not.toBe('REPORT NOW');
      expect((await plan()).status).toBe('completed');
    });

    it('a second invalid report goes to the assistant', async () => {
      const runner = new FakeRunner((l) => (l.stepId === 's1' ? completes('') : completes('x')));
      const fence = await seed(record(BIG));
      const exec = executor(runner);
      exec.start({ ref: REF, planId: 'p1', fence });
      await exec.settled('p1');
      const p = await plan();
      expect(runner.launches).toHaveLength(2);
      expect(p.paused).toMatchObject({ kind: 'invalid-report', retried: true });
    });

    // Final review F4: Continue on an invalid-report pause asks the SAME
    // specialist for its report with tools off. A fresh full run would repeat
    // every command and edit the first one already made.
    it('F4: Continue after a second invalid report nudges the same specialist, tools off — the original task brief is never sent again', async () => {
      const runner = new FakeRunner((l) => (l.stepId === 's1' ? completes('') : completes('x')));
      const fence = await seed(record(BIG));
      const exec = executor(runner);
      exec.start({ ref: REF, planId: 'p1', fence });
      await exec.settled('p1');
      expect((await plan()).paused).toMatchObject({ kind: 'invalid-report', retried: true });
      const [first, reportTurn] = runner.launches;
      runner.script = (l) => (l.stepId === 's1' ? completes('THE REPORT') : completes('combined'));
      const again = await journal.acquireLease(REF, 'p1', { startFrom: ['paused'] });
      if (!again.ok) throw new Error('lease');
      exec.start({ ref: REF, planId: 'p1', fence: again.fence });
      await exec.settled('p1');
      const resumed = runner.launches.slice(2).filter((l) => l.stepId === 's1');
      expect(resumed).toHaveLength(1);
      // T2 fix: this Continue's own report-only retry also continues the
      // SAME specialist session (not a fresh one) — the childId chain never
      // breaks across a second invalid report and its own Continue.
      expect(resumed[0]).toMatchObject({ toolsDisabled: true, brief: reportTurn.brief, resumeChildId: first.childId });
      // The original task brief (the one that runs tools) is never sent again.
      expect(runner.launches.filter((l) => l.brief === first.brief)).toHaveLength(1);
      const p = await plan();
      expect(p.status).toBe('completed');
      expect(p.steps[0].attempts.at(-1)).toMatchObject({ reportOnly: true, terminal: 'completed', reportText: 'THE REPORT' });
    });

    // WHY 'F4: Continue after an unfunded invalid report …'/'F4: a
    // report-only Continue with too little allowance pauses for Add budget
    // …' are ALSO GONE: both existed only to test the funding gate report-
    // only no longer has (see the WHY above).

    it('a crash before the report-only turn was sent sends exactly that turn on Continue, tools still off', async () => {
      const rec = record(BIG, {
        status: 'interrupted', usedTokens: 1500,
        recoveries: [{ stepId: 's1', iteration: 0, itemIndex: 0, cause: 'invalid-report', at: 1 }],
        steps: [
          { id: 's1', status: 'paused', attempts: [
            attemptRec({ attemptId: 'bad', childId: 'kid-s', spentTokens: 1500, phase: 'committed', terminal: 'failed', reportText: '', completedAt: 2 }),
            attemptRec({ attemptId: 'ro', childId: 'kid-s', phase: 'prepared', reportOnly: true, brief: 'REPORT NOW' }),
          ] },
          { id: 's2', status: 'pending', attempts: [] },
        ],
      });
      const runner = new FakeRunner(() => completes('R'));
      // The finished (invalid) first turn is what the transcript shows.
      runner.verdicts.set('kid-s', { kind: 'terminal', report: 'not it' });
      const fence = await seed(rec);
      const exec = executor(runner);
      exec.start({ ref: REF, planId: 'p1', fence });
      await exec.settled('p1');
      expect(runner.launches[0]).toMatchObject({ attemptId: 'ro', resumeChildId: 'kid-s', brief: 'REPORT NOW', toolsDisabled: true });
      expect((await plan()).status).toBe('completed');
    });
  });
});

// T3 (design §3 "Concurrency" / §7, decision 37 R-4): the plan's own optional
// spend limit. `plan-spend.test.ts` covers the journal-write half (crossing,
// concurrent writers, the shared flag); everything below is what the
// EXECUTOR does once that flag is set — pause once, drain instead of
// aborting, and never start a wave that is already past the limit.
describe('spend limit: wave-start check', () => {
  const SPEND2: PlanDocumentV1 = { goal: 'spend', steps: [
    { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Do {item}', summary: 'Plain sentence.', items: ['a', 'b'] },
  ] };

  it("a wave never starts once used has already reached the plan's own spend limit (tokens)", async () => {
    const runner = new FakeRunner(() => completes('ok'));
    const fence = await seed(record(SPEND2, { usedTokens: 500, spendLimit: { tokens: 500 } }));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    expect(runner.launches).toHaveLength(0);
    const p = await plan();
    expect(p.status).toBe('paused');
    expect(p.paused).toMatchObject({ kind: 'spend-limit', limit: { tokens: 500 } });
    // Nothing was even created for work that would never launch.
    expect(p.steps[0].attempts).toEqual([]);
  });

  it('the same check applies to a dollar limit, read from usedUsd', async () => {
    const runner = new FakeRunner(() => completes('ok'));
    const fence = await seed(record(SPEND2, { usedTokens: 100, usedUsd: 5, spendLimit: { usd: 5 } }));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    expect(runner.launches).toHaveLength(0);
    expect((await plan()).paused).toMatchObject({ kind: 'spend-limit', limit: { usd: 5 } });
  });

  it('raising the limit above used lets Continue start the wave without an immediate re-pause', async () => {
    const runner = new FakeRunner(() => completes('ok'));
    const rec = record(SPEND2, {
      status: 'paused', usedTokens: 500, spendLimit: { tokens: 5_000 },
      paused: { stepId: 's1', reason: 'Reached your 500-token limit.', kind: 'spend-limit', limit: { tokens: 500 } },
      steps: [{ id: 's1', status: 'paused', attempts: [] }],
    });
    // Simulates Continue after T6's setLimit raised it: the resume REFUSAL
    // while used is still ≥ limit belongs to that service layer, not here —
    // the executor's own contract is simply "don't re-pause once it isn't".
    const fence = await seed(rec);
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    expect(runner.launches.map((l) => l.brief).sort()).toEqual(['Do a', 'Do b']);
    expect((await plan()).status).toBe('completed');
  });
});

describe('spend limit: drain halt', () => {
  const TWO_ITEMS: PlanDocumentV1 = { goal: 'two', steps: [
    { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Do {item}', summary: 'Plain sentence.', items: ['a', 'b'] },
  ] };
  const LIMIT = { tokens: 999_999 };

  it('a crossing write drains: siblings finish their own in-flight reply, the plan pauses once, and nothing is aborted before the deadline', async () => {
    // X4 fix (review 2026-09-24, test-suite-hygiene.md): gates the test
    // controls directly, not fixed sleeps hoping both children are still
    // genuinely in flight when the crossing lands.
    const aFinish = deferred(); const bFinish = deferred();
    const runner = new FakeRunner((l) => async (ctx) => {
      if (l.brief === 'Do a') {
        // Stands in for T2's PlanSpend calling this from inside a reply's
        // journal write — the crossing itself, mid-turn.
        ctx.launch.markLimitReached(LIMIT);
        // The crossing reply's OWN tools still run (design §3): this
        // specialist keeps going until the test lets it, and still finishes
        // for real.
        await aFinish.promise;
        return { kind: 'completed' as const, report: 'A done' };
      }
      // The sibling is never asked to stop — it simply finishes its own
      // reply whenever the test lets it, proving the crossing (which
      // already happened by the time either gate is released) never
      // touched it.
      await bFinish.promise;
      return { kind: 'completed' as const, report: 'B done' };
    });
    const fence = await seed(record(TWO_ITEMS, { spendLimit: LIMIT }));
    const exec = executor(runner, { drainDeadlineMs: 5_000 });
    const drainDeadline = markDeadline(5_000);
    exec.start({ ref: REF, planId: 'p1', fence });
    await vi.waitFor(() => expect(runner.launches.length).toBe(2));
    aFinish.resolve(); bFinish.resolve();
    await exec.settled('p1');
    // Neither sibling was ever aborted, and the (generous) drain deadline
    // never had to fire — both ended on their own.
    expect(runner.aborted).toEqual([]);
    expect(drainDeadline.fired()).toBe(false);
    const p = await plan();
    expect(p.status).toBe('paused');
    expect(p.paused).toMatchObject({ kind: 'spend-limit' });
    expect(events.filter((e) => e.plan.status === 'paused')).toHaveLength(1);
    // Both in-flight replies landed for real — the crossing one AND its
    // sibling — neither was abandoned mid-turn.
    expect(p.steps[0].attempts.filter((a) => a.terminal === 'completed').map((a) => a.reportText).sort())
      .toEqual(['A done', 'B done']);
  });

  it('a child stuck past the drain deadline (e.g. a permission ask, which never times out) is aborted, then the plan still pauses once', async () => {
    const stayUntilAborted = async (ctx: ChildCtx): Promise<PlanChildOutcome> => {
      if (!ctx.signal.aborted) await new Promise<void>((res) => ctx.signal.addEventListener('abort', () => res(), { once: true }));
      return { kind: 'interrupted' };
    };
    // X4 fix: the crossing fires the instant this child launches — no sleep
    // needed at all; what this test is actually proving (the abort waits
    // for the drain deadline) doesn't depend on when the crossing lands.
    const runner = new FakeRunner((l) => async (ctx) => {
      if (l.brief === 'Do a') ctx.launch.markLimitReached(LIMIT);
      return stayUntilAborted(ctx);
    });
    const fence = await seed(record(TWO_ITEMS, { spendLimit: LIMIT }));
    // A settle deadline far bigger than the drain one: once aborted, these
    // children resolve almost at once (they honor the signal), so this
    // second timer is only a safety net and must not itself decide anything.
    const exec = executor(runner, { drainDeadlineMs: 40, settleDeadlineMs: 5_000 });
    const drainDeadline = markDeadline(40);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    expect(drainDeadline.fired()).toBe(true);
    // Both were left running until the drain deadline forced the abort — never before it.
    expect(runner.aborted.length).toBe(2);
    for (const id of runner.aborted) expect(log.indexOf(`dispose:${id}`)).toBeGreaterThan(log.indexOf('settle-deadline'));
    const p = await plan();
    expect(p.status).toBe('paused');
    expect(p.paused).toMatchObject({ kind: 'spend-limit' });
    expect(events.filter((e) => e.plan.status === 'paused')).toHaveLength(1);
  });

  // X1 (review 2026-09-24, docs/active/reviews/2026-09-24-plans-spending-T3-
  // review.md): a drain halt used to lose the "first reason wins" race to a
  // sibling's unrelated halt landing in the async gap `requestSpendLimitDrain`
  // used to have between "limit crossed" (synchronous) and its own
  // `requestHalt` call (behind an awaited journal re-read). This reproduces
  // that race deterministically: sibling 'a' crosses the limit as the very
  // first thing its turn does (fully synchronous now — no gap to land in),
  // then, in the SAME synchronous turn, releases sibling 'b' to become
  // 'interrupted' (memberEnd's own synchronous requestHalt for
  // 'specialist-stopped', once b's outcome promise resolves). Before the
  // fix, b's halt request would very plausibly win — its own requestHalt is
  // reached after only a couple of microtask hops, while the crossing's was
  // stuck behind a REAL journal file read. After the fix there is no gap at
  // all: 'a' claims the halt before 'b' even resumes.
  it('a crossing that happens first always wins the pause reason, even against a sibling halting in the very same turn', async () => {
    const bTrigger = deferred();
    const runner = new FakeRunner((l) => async (ctx) => {
      if (l.brief === 'Do a') {
        ctx.launch.markLimitReached(LIMIT);
        // Still fully synchronous relative to the call above — no `await`
        // separates them.
        bTrigger.resolve();
        return { kind: 'completed' as const, report: 'A done' };
      }
      await bTrigger.promise;
      return { kind: 'interrupted' as const };
    });
    const fence = await seed(record(TWO_ITEMS, { spendLimit: LIMIT }));
    const exec = executor(runner, { drainDeadlineMs: 5_000 });
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p = await plan();
    expect(p.status).toBe('paused');
    expect(p.paused).toMatchObject({ kind: 'spend-limit', limit: LIMIT });
    expect(events.filter((e) => e.plan.status === 'paused')).toHaveLength(1);
  });

  it('a user Stop overrides an in-progress spend-limit drain (Stop is the users explicit choice)', async () => {
    // `exec.stop()` is called INSIDE the script, synchronously, in the very
    // same tick as the crossing right above it — no `await` separates
    // them — so this exercises `requestHalt`'s own precedence decision
    // directly, never a race against `settle()` possibly having already
    // moved on by the time a separately-scheduled Stop call landed.
    let exec!: PlanExecutor;
    const aFinish = deferred();
    const runner = new FakeRunner((l) => async (ctx) => {
      if (l.brief !== 'Do a') return completes('B done')(ctx);
      ctx.launch.markLimitReached(LIMIT);
      void exec.stop({ ref: REF, planId: 'p1', finalize: (p) => { p.status = 'stopped'; } });
      await aFinish.promise;
      return { kind: 'completed' as const, report: 'A done' };
    });
    const fence = await seed(record(TWO_ITEMS, { spendLimit: LIMIT }));
    exec = executor(runner, { drainDeadlineMs: 5_000, settleDeadlineMs: 60 });
    exec.start({ ref: REF, planId: 'p1', fence });
    aFinish.resolve();
    await exec.settled('p1');
    const p = await plan();
    // A plain drain never produces 'stopped' — only a Stop request does
    // (the two prior tests in this block, hit by the identical crossing
    // with no Stop, both end 'paused' with kind 'spend-limit'). Landing
    // here as 'stopped' proves the override actually took effect.
    expect(p.status).toBe('stopped');
    expect(p.lease).toBeUndefined();
  });
});

// T3 (design §3 "Concurrency", Revision 2 E2/E3): a headcount cap, not the
// deleted token-math one — the local engine's one shared context pool means
// at most ONE local-engine plan specialist may run at a time.
describe('local engine: at most one plan specialist at a time', () => {
  it('a 4-item local split step on a cloud-model parent never runs two local children at once', async () => {
    const doc: PlanDocumentV1 = { goal: 'local', steps: [
      { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Do {item}', summary: 'Plain sentence.', items: ['a', 'b', 'c', 'd'] },
    ] };
    const runner = new FakeRunner(() => async (ctx) => { await new Promise((r) => setTimeout(r, 5)); return completes('ok')(ctx); });
    // A generous cap: proves the local rule serializes on its own, not
    // because the cap happened to already be 1.
    runner.cap = 4;
    const manifest: ExecutionManifest = {
      ...MANIFEST,
      steps: { s1: { binding: { providerId: 'local-engine', modelId: 'llama' }, label: 'llama', pricing: { kind: 'local' }, source: 'default' } },
    };
    const fence = await seed(record(doc, { manifest }));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    expect(runner.maxLive).toBe(1);
    expect(runner.launches).toHaveLength(4);
    expect((await plan()).status).toBe('completed');
  });

  // X5 (review 2026-09-24, docs/active/reviews/2026-09-24-plans-spending-T3-
  // review.md): the commit message claimed a retry and a repeat body were
  // "included" in T3's local-engine coverage; only a bare `map` was actually
  // tested. The mechanism was already sound by construction (`local`/`width`
  // are recomputed fresh from a freshly-loaded plan at the top of every
  // `runStep` call — verified in the review), so these pin that claim rather
  // than fix a defect.
  it('a retried local-engine item never overlaps its sibling, even across the automatic relaunch', async () => {
    const doc: PlanDocumentV1 = { goal: 'local', steps: [
      { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Do {item}', summary: 'Plain sentence.', items: ['flaky', 'steady'] },
    ] };
    let flakyAttempts = 0;
    const runner = new FakeRunner((l) => async (ctx) => {
      await new Promise((r) => setTimeout(r, 5));
      if (l.brief === 'Do flaky') {
        flakyAttempts += 1;
        if (flakyAttempts === 1) return { kind: 'failed' as const, detail: 'the provider hiccupped' };
      }
      return completes('ok')(ctx);
    });
    runner.cap = 4;   // generous — the local rule alone must serialize
    const manifest: ExecutionManifest = {
      ...MANIFEST,
      steps: { s1: { binding: { providerId: 'local-engine', modelId: 'llama' }, label: 'llama', pricing: { kind: 'local' }, source: 'default' } },
    };
    const fence = await seed(record(doc, { manifest }));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    expect(runner.maxLive).toBe(1);
    // Confirms the automatic relaunch actually happened (this isn't just a
    // 2-item wave that happened to stay serial) — same specialist error
    // recovery every other test in this file already exercises.
    expect(flakyAttempts).toBe(2);
    expect((await plan()).status).toBe('completed');
  });

  it("a repeat body's local-engine map step never overlaps its own items, across every round", async () => {
    const doc: PlanDocumentV1 = { goal: 'loop', steps: [
      { id: 'r', kind: 'repeat', specialist: 'reviewer', task: 'loop', summary: 'Plain sentence.', max_iterations: 2, until: 'tests pass',
        steps: [
          { id: 'fix', kind: 'map', specialist: 'reviewer', task: 'Fix {item}', summary: 'Plain sentence.', items: ['x', 'y'] },
          { id: 'check', kind: 'verify', specialist: 'reviewer', task: 'Check the fix', summary: 'Plain sentence.', of: 'fix' },
        ] },
    ] };
    let checks = 0;
    const runner = new FakeRunner((l) => async (ctx) => {
      await new Promise((r) => setTimeout(r, 5));
      if (l.stepId === 'fix') return completes(`fixed in round ${l.iteration}`)(ctx);
      checks += 1;
      return completes(JSON.stringify({ report: `CHECK-${checks}`, repeatSatisfied: checks === 2 }))(ctx);
    });
    runner.cap = 4;   // generous — the local rule alone must serialize
    const manifest: ExecutionManifest = {
      ...MANIFEST,
      // Only 'fix' is local-bound — 'check' (a single-item verify step that
      // always runs after 'fix' anyway) is untouched, exactly like design
      // §5's per-LEAF-STEP binding.
      steps: { fix: { binding: { providerId: 'local-engine', modelId: 'llama' }, label: 'llama', pricing: { kind: 'local' }, source: 'default' } },
    };
    const fence = await seed(record(doc, { manifest }));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    expect(runner.maxLive).toBe(1);
    // Two rounds, two 'fix' items each: proves the check is still enforced
    // on round 2, not just remembered from round 1.
    expect(runner.launches.filter((l) => l.stepId === 'fix')).toHaveLength(4);
    expect((await plan()).status).toBe('completed');
  });
});

describe('recovery charges nothing (design §3 "Crash safety")', () => {
  it("a restarted attempt keeps its already-recorded spend; nothing in the recovery/restart path adds to it", async () => {
    const rec = record(TWO_STEP, {
      status: 'interrupted', usedTokens: 700, usedUsd: 0.42,
      steps: [
        { id: 's1', status: 'paused', attempts: [
          committed('c1', 0, 'A'),
          attemptRec({ attemptId: 'p2', itemIndex: 1, childId: 'kid-2', phase: 'launched', spentTokens: 300, spentUsd: 0.12 }),
        ] },
        { id: 's2', status: 'pending', attempts: [] },
      ],
    });
    const runner = new FakeRunner(() => completes('B'));
    runner.verdicts.set('kid-2', { kind: 'resumable', briefDelivered: true });
    const fence = await seed(rec);
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p2 = (await stepOf('s1')).attempts.find((a) => a.attemptId === 'p2')!;
    expect(p2).toMatchObject({ spentTokens: 300, spentUsd: 0.12, phase: 'committed', reportText: 'B' });
    // The plan's own running totals are untouched by recovery/restart/commit
    // too — only a real reply's afterReply (T2, not exercised by this
    // FakeRunner) ever changes them.
    expect((await plan()).usedTokens).toBe(700);
    expect((await plan()).usedUsd).toBe(0.42);
  });
});

// WHY 'the report-only turn's reply is capped at its fixed allowance' is GONE:
// it called `budget.requestGate(...)` directly (PlanBudget, deleted). Nothing
// caps a report-only reply's size any more — decision 34 dropped every
// per-request allowance, report-only included.
