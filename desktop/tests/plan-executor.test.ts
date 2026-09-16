// Specialists plans, Task 4 — the plan executor (backend design §3).
// Real filesystem journal + real PlanBudget; only the specialists themselves
// are fakes (a scripted runner). Every assertion about money or phases is read
// back from the journal file, because resume reads nothing else.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { PlanJournal } from '../src/main/harness/plans/plan-journal';
import { PlanBudget, planCeilingTokens } from '../src/main/harness/plans/plan-budget';
import {
  PlanExecutor, PlanLaunchDriftError, PlanLaunchRefusedError, PLAN_DEPENDENCY_REPORT_MAX_CHARS, PLAN_REPORT_ONLY_RESEND, PLAN_RESTART_BRIEF, classifyChildTranscript as classifyWith, planRestartBrief,
  type PlanChildHandle, type PlanChildLaunch, type PlanChildOutcome, type PlanRunner, type TranscriptVerdict,
} from '../src/main/harness/plans/plan-executor';
import { resetDisabledAdaptersForTests, type PlanBudgetAdapter, type PlanChildRequestGate } from '../src/main/harness/plans/budget-adapter';
import type { ExecutionManifest, PlanAttemptRecord, PlanEvent, PlanRecord, PlanRef } from '../src/main/harness/plans/types';
import type { PlanDocumentV1 } from '../src/main/harness/plans/schema';
import type { TranscriptEvent } from '../src/shared/types';
import { nativeToolEffect } from '../src/main/harness/tools';
import { projectPlan } from '../src/main/harness/plans/plan-journal';
import { pausedRouting } from '../src/main/harness/plans/pause-routing';

// Task 9a: the classifier reads each tool's declared effect.
const classifyChildTranscript = (events: TranscriptEvent[]) => classifyWith(events, nativeToolEffect);

const REF: PlanRef = { cwd: '/proj', sessionId: 'parent-1' };
const ADAPTER: PlanBudgetAdapter = { id: 'exec-test', providerType: 'openrouter', capsOutput: true, inputBound: () => ({ ok: true, tokens: 0 }) };
const MANIFEST: ExecutionManifest = {
  modelLabel: 'm',
  specialists: {
    reviewer: { definitionFingerprint: 'r', binding: { providerId: 'p', modelId: 'm' }, pricing: { kind: 'local' }, setupTokens: 0 },
    worker: { definitionFingerprint: 'w', binding: { providerId: 'p', modelId: 'm' }, pricing: { kind: 'local' }, setupTokens: 0 },
    explorer: { definitionFingerprint: 'e', binding: { providerId: 'p', modelId: 'm' }, pricing: { kind: 'local' }, setupTokens: 0 },
  },
  permissionFingerprint: 'perm',
};

function allIds(steps: PlanDocumentV1['steps']): string[] {
  return steps.flatMap((s) => (s.kind === 'repeat' ? [s.id, ...allIds(s.steps!)] : [s.id]));
}

function record(document: PlanDocumentV1, over: Partial<PlanRecord> = {}): PlanRecord {
  return {
    planId: 'p1', toolUseId: 'tool-p1', document, maximumAttempts: 1, maxFanOut: 1,
    ceilingTokens: planCeilingTokens(document, MANIFEST), ceilingUsd: null, usedTokens: 0,
    status: 'proposed', seq: 1, createdAt: 1, manifest: MANIFEST,
    steps: allIds(document.steps).map((id) => ({ id, status: 'pending' as const, attempts: [] })),
    fenceEpoch: 0,
    ...over,
  };
}

const attemptRec = (over: Partial<PlanAttemptRecord>): PlanAttemptRecord => ({
  attemptId: 'a', itemIndex: 0, iteration: 0, baseTokens: 1000, addedTokens: 0, reservedTokens: 0, spentTokens: 0, phase: 'prepared', ...over,
});

// ---- the scripted runner ----

interface ChildCtx { gate: PlanChildRequestGate; signal: AbortSignal; launch: PlanChildLaunch; childId: string }
type Script = (ctx: ChildCtx) => Promise<PlanChildOutcome>;

/** Reserve, report usage, finish with `report`. */
const completes = (report: string, input = 100, output = 50): Script => async ({ gate }) => {
  const r = await gate.reserve({ inputBoundTokens: input });
  if (!r.ok) return { kind: 'stopped', stop: { kind: r.kind === 'exhausted' ? 'exhausted' : 'refused', detail: r.detail } };
  await gate.settle({ kind: 'reported', tokens: input + output, usage: { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheCreationTokens: 0 } });
  return { kind: 'completed', report };
};
/** Sends a request and never hears back. `honorsAbort` → settles on abort (like the harness). */
const hangs = (honorsAbort: boolean): Script => async ({ gate, signal }) => {
  await gate.reserve({ inputBoundTokens: 100 });
  if (!honorsAbort) return new Promise<PlanChildOutcome>(() => {});
  // An abort that already happened counts too (a launch can land after the halt).
  if (!signal.aborted) await new Promise<void>((res) => signal.addEventListener('abort', () => res(), { once: true }));
  await gate.settle({ kind: 'unknown', why: 'interrupted' });
  return { kind: 'interrupted' };
};
const failsWith = (detail: string, delayMs = 0): Script => async () => {
  await new Promise((r) => setTimeout(r, delayMs));
  return { kind: 'failed', detail };
};

let root: string; let home: NativeHome; let journal: PlanJournal; let budget: PlanBudget;
let events: PlanEvent[]; let log: string[]; let ids: number;

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
  async localPoolTokens(): Promise<number | undefined> { return undefined; }
  inspectTranscript(_ref: PlanRef, childId: string): TranscriptVerdict {
    return this.verdicts.get(childId) ?? { kind: 'resumable', briefDelivered: false };
  }
  onUnreadable(_ref: PlanRef, planId: string, detail: string): void { this.unreadable.push(`${planId}:${detail}`); }
  refusal: string | undefined = undefined;
  async launchRefusal(): Promise<string | undefined> { return this.refusal; }
  /** Review fix 2: the measured input of a report-only request. */
  reportBound: number | undefined = 100;
  reportBoundAsked: Array<{ attemptId: string; message: string }> = [];
  async reportOnlyInputBound(_ref: PlanRef, _plan: PlanRecord, attemptId: string, message: string): Promise<number | undefined> {
    this.reportBoundAsked.push({ attemptId, message });
    return this.reportBound;
  }
  /** Review fix 2: the newest user message each specialist's transcript holds. */
  userTexts = new Map<string, string>();
  latestUserText(_ref: PlanRef, childId: string): string | undefined { return this.userTexts.get(childId); }
  minimumAsked: string[] = [];
  minimum: number | undefined = undefined;
  async minimumAddTokens(_ref: PlanRef, _plan: PlanRecord, attemptId: string): Promise<number | undefined> {
    this.minimumAsked.push(attemptId);
    return this.minimum;
  }
  async launch(input: PlanChildLaunch): Promise<PlanChildHandle> {
    const childId = input.resumeChildId ?? `child-${++this.next}`;
    this.planAtLaunch.push((await journal.get(REF, input.planId))!);
    await input.recordChild(childId);
    this.launches.push({ ...input, childId });
    this.live += 1; this.maxLive = Math.max(this.maxLive, this.live);
    const ac = new AbortController();
    let markDisposed!: () => void;
    const disposedP = new Promise<void>((r) => { markDisposed = r; });
    const gate = budget.requestGate(input.ref, input.planId, input.fence, input.stepId, input.attemptId, ADAPTER);
    const outcome = Promise.race([
      this.script(input)({ gate, signal: ac.signal, launch: input, childId }),
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
const reservedTotal = (p: PlanRecord) => p.steps.flatMap((s) => s.attempts).reduce((n, a) => n + a.reservedTokens, 0);

function executor(runner: PlanRunner, over: Partial<ConstructorParameters<typeof PlanExecutor>[0]> = {}): PlanExecutor {
  return new PlanExecutor({ journal, budget, runner, settleDeadlineMs: 60, heartbeatMs: 10_000, ...over });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-exec-'));
  home = new NativeHome(root); events = []; log = []; ids = 0;
  journal = new PlanJournal({
    home, identity: { instanceId: 'me', pid: 1 },
    onEvent: (e) => { events.push(e); log.push(`event:${e.plan.status}`); },
  });
  budget = new PlanBudget({ journal, newId: () => `att${++ids}` });
  resetDisabledAdaptersForTests();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));

const MAP6: PlanDocumentV1 = { goal: 'Six', steps: [
  { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Review {item}', budget_tokens: 1000, items: ['a', 'b', 'c', 'd', 'e', 'f'] },
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
      { id: 's1', kind: 'map', specialist: 'worker', task: 'Fix {item}', budget_tokens: 1000, items: ['a', 'b', 'c'] },
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
      { id: 's0', kind: 'map', specialist: 'explorer', task: 'Unrelated', budget_tokens: 1000, items: ['z'] },
      { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Review {item}', budget_tokens: 1000, items: ['a.ts', 'b.ts'] },
      { id: 's2', kind: 'combine', specialist: 'reviewer', task: 'Combine the reviews', budget_tokens: 1000, of: 's1' },
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
});

const TWO_STEP: PlanDocumentV1 = { goal: 'two', steps: [
  { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Review {item}', budget_tokens: 1000, items: ['a', 'b'] },
  { id: 's2', kind: 'combine', specialist: 'reviewer', task: 'Combine', budget_tokens: 1000, of: 's1' },
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
        { id: 's1', status: 'paused', attempts: [committed('c1', 0, 'A'), attemptRec({ attemptId: 'p2', itemIndex: 1, childId: 'kid-2', phase: 'response-persisted', spentTokens: 300 })] },
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
        { id: 's1', status: 'paused', attempts: [committed('c1', 0, 'A'), attemptRec({ attemptId: 'p2', itemIndex: 1, childId: 'kid-2', phase: 'response-persisted', spentTokens: 300 })] },
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
    expect(p2).toMatchObject({ phase: 'committed', terminal: 'completed', reportText: 'FROM-TRANSCRIPT', spentTokens: 300 });
    expect(runner.launches[0].brief).toContain('FROM-TRANSCRIPT');
  });

  it('an unsettled request with a terminal transcript is charged in full, then committed without a request', async () => {
    const rec = record(TWO_STEP, {
      status: 'interrupted', usedTokens: 400,
      steps: [
        { id: 's1', status: 'paused', attempts: [committed('c1', 0, 'A'), attemptRec({ attemptId: 'p2', itemIndex: 1, childId: 'kid-2', phase: 'request-sent', reservedTokens: 1000, requestInputBound: 100 })] },
        { id: 's2', status: 'pending', attempts: [] },
      ],
    });
    const runner = new FakeRunner(() => completes('final'));
    runner.verdicts.set('kid-2', { kind: 'terminal', report: 'DONE-B' });
    const fence = await seed(rec);
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p2 = (await stepOf('s1')).attempts.find((a) => a.attemptId === 'p2')!;
    expect(p2).toMatchObject({ phase: 'committed', reportText: 'DONE-B', spentTokens: 1000, reservedTokens: 0 });
    expect(runner.launches.map((l) => l.attemptId)).not.toContain('p2');
  });

  it('Task 9a: a cut-off request is picked up by itself once — here its charged-in-full allowance makes that a budget pause, never a replay', async () => {
    const rec = record(TWO_STEP, {
      status: 'interrupted', usedTokens: 400,
      steps: [
        { id: 's1', status: 'paused', attempts: [committed('c1', 0, 'A'), attemptRec({ attemptId: 'p2', itemIndex: 1, childId: 'kid-2', phase: 'request-sent', reservedTokens: 1000, requestInputBound: 100 })] },
        { id: 's2', status: 'pending', attempts: [] },
      ],
    });
    const runner = new FakeRunner(() => completes('x'));
    runner.verdicts.set('kid-2', { kind: 'resumable', briefDelivered: true });
    const fence = await seed(rec);
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    expect(runner.launches).toHaveLength(0);
    let p = await plan();
    expect(p.status).toBe('paused');
    expect(p.lease).toBeUndefined();
    // The automatic recovery is recorded; restarting then needs budget.
    expect(p.recoveries).toEqual([expect.objectContaining({ stepId: 's1', iteration: 0, itemIndex: 1, cause: 'unknown-request' })]);
    expect(p.paused).toMatchObject({ stepId: 's1', attemptId: 'p2', kind: 'budget' });
    expect(p.steps[0].attempts[1]).toMatchObject({ phase: 'response-persisted', spentTokens: 1000, reservedTokens: 0 });
    expect(p.steps[0].attempts[1].ambiguityReported).toBeUndefined();

    await budget.addTokens({ ref: REF, planId: 'p1', stepId: 's1', tokens: 500 });
    const again = await journal.acquireLease(REF, 'p1', { startFrom: ['paused'] });
    if (!again.ok) throw new Error('lease');
    exec.start({ ref: REF, planId: 'p1', fence: again.fence });
    await exec.settled('p1');
    expect(runner.launches[0]).toMatchObject({ attemptId: 'p2', resumeChildId: 'kid-2', brief: PLAN_RESTART_BRIEF });
    expect((await plan()).status).toBe('completed');
  });

  it('Task 9a: a second cut-off request on the same item goes to the assistant and is never replayed', async () => {
    const rec = record(TWO_STEP, {
      status: 'interrupted', usedTokens: 400,
      recoveries: [{ stepId: 's1', iteration: 0, itemIndex: 1, cause: 'unknown-request', at: 1 }],
      steps: [
        { id: 's1', status: 'paused', attempts: [committed('c1', 0, 'A'), attemptRec({ attemptId: 'p2', itemIndex: 1, childId: 'kid-2', phase: 'request-sent', reservedTokens: 1000, requestInputBound: 100 })] },
        { id: 's2', status: 'pending', attempts: [] },
      ],
    });
    const runner = new FakeRunner(() => completes('x'));
    runner.verdicts.set('kid-2', { kind: 'resumable', briefDelivered: true });
    const fence = await seed(rec);
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    expect(runner.launches).toHaveLength(0);
    const p = await plan();
    expect(p.paused).toMatchObject({ stepId: 's1', attemptId: 'p2', kind: 'unknown-request', retried: true });
    expect(p.paused!.reason).toMatch(/isn't known whether/);
    expect(p.paused!.tool).toBeUndefined();
    expect(p.steps[0].attempts[1]).toMatchObject({ phase: 'ambiguous', ambiguityReported: true, spentTokens: 1000, reservedTokens: 0 });
    expect(p.recoveries).toHaveLength(1);
  });

  it('an outside action (Bash) with no durable result pauses for the assistant and is not replayed', async () => {
    const rec = record(TWO_STEP, {
      status: 'interrupted', usedTokens: 700,
      steps: [
        { id: 's1', status: 'paused', attempts: [committed('c1', 0, 'A'), attemptRec({ attemptId: 'p2', itemIndex: 1, childId: 'kid-2', phase: 'response-persisted', spentTokens: 300 })] },
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
    expect(p.steps[0].attempts[1]).toMatchObject({ phase: 'ambiguous', ambiguityReported: true, spentTokens: 300 });
  });

  it('restart charges exactly one fresh prompt per restarting specialist and never a finished step', async () => {
    const rec = record(TWO_STEP, {
      status: 'interrupted', usedTokens: 1100,
      steps: [
        { id: 's1', status: 'done', attempts: [committed('c1', 0, 'A'), committed('c2', 1, 'B')] },
        { id: 's2', status: 'paused', attempts: [attemptRec({ attemptId: 'r', childId: 'kid-r', phase: 'response-persisted', spentTokens: 300 })] },
      ],
    });
    // The restarted specialist's ONE request: its whole transcript + the fresh turn.
    const runner = new FakeRunner(() => completes('combined', 450, 50));
    runner.verdicts.set('kid-r', { kind: 'resumable', briefDelivered: true });
    const fence = await seed(rec);
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p = await plan();
    expect(runner.launches.map((l) => l.attemptId)).toEqual(['r']);
    expect(p.steps[0].attempts).toEqual(rec.steps[0].attempts);
    expect(p.steps[1].attempts[0]).toMatchObject({ phase: 'committed', spentTokens: 300 + 500 });
    expect(p.usedTokens).toBe(1100 + 500);
  });
});

describe('repeat', () => {
  const repeatDoc = (max: number): PlanDocumentV1 => ({ goal: 'loop', steps: [
    { id: 'r', kind: 'repeat', specialist: 'reviewer', task: 'loop', budget_tokens: 500, max_iterations: max, until: 'tests pass',
      steps: [
        { id: 'fix', kind: 'map', specialist: 'reviewer', task: 'Fix {item}', budget_tokens: 1000, items: ['x'] },
        { id: 'check', kind: 'verify', specialist: 'reviewer', task: 'Check the fix', budget_tokens: 1000, of: 'fix' },
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

  it('malformed decision output pauses with the real validator detail', async () => {
    const runner = new FakeRunner((l) => completes(l.stepId === 'fix' ? 'fixed' : 'looks good to me'));
    const fence = await seed(record(repeatDoc(3)));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p = await plan();
    expect(p.status).toBe('paused');
    expect(p.paused!.stepId).toBe('check');
    expect(p.paused!.reason).toMatch(/repeatSatisfied/);
    expect(p.paused!.kind).toBe('invalid-report');
    expect(p.steps.find((s) => s.id === 'check')!.attempts[0]).toMatchObject({ phase: 'committed', terminal: 'failed' });
    expect(runner.launches).toHaveLength(2);
  });

  it('max iterations is a hard stop, and every iteration fits inside the approved ceiling', async () => {
    const runner = new FakeRunner((l) => completes(l.stepId === 'fix'
      ? 'fixed' : JSON.stringify({ report: 'still failing', repeatSatisfied: false }), 400, 600));
    const doc = repeatDoc(2);
    const fence = await seed(record(doc));
    expect((await plan()).ceilingTokens).toBe(2 * (1000 + 1000));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p = await plan();
    expect(runner.launches).toHaveLength(4);
    expect(p.status).toBe('paused');
    expect(p.paused!.reason).toMatch(/2 times/);
    // 5b follow-up: the card words this pause from these facts.
    expect(p.paused).toMatchObject({ kind: 'iteration-cap', repeat: { rounds: 2, until: doc.steps.find((x) => x.kind === 'repeat')!.until } });
    // Every attempt spent its whole allowance and the ceiling still held.
    expect(p.usedTokens).toBe(p.ceilingTokens);
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
    { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Do {item}', budget_tokens: 1000, items: ['fail', 'quick', 'stuck1', 'stuck2'] },
    { id: 's2', kind: 'combine', specialist: 'reviewer', task: 'Combine', budget_tokens: 1000, of: 's1' },
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
    // WHY 750 ms: the cooperative sibling needs one journal write to settle
    // after its abort. Under a loaded full-suite run (verify.sh, 2026-09-16)
    // that write missed an 80 ms deadline — correct behaviour (it was then
    // charged in full) but not what this test pins. The stuck two still wait
    // the whole deadline, so this is the test's cost.
    const exec = executor(runner, { settleDeadlineMs: 750 });
    const t0 = Date.now();
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const elapsed = Date.now() - t0;
    // A lower bound only: the stragglers were held for the whole deadline.
    expect(elapsed).toBeGreaterThanOrEqual(750);
    // all three siblings were aborted; every child was disposed
    expect(runner.aborted.sort()).toEqual(expect.arrayContaining(['child-2', 'child-3', 'child-4']));
    // child-1 ran twice (the automatic retry continues the same session).
    expect(runner.disposed.sort()).toEqual(['child-1', 'child-1', 'child-2', 'child-3', 'child-4']);
    expect(runner.launches.filter((x) => x.brief === 'Do fail')).toHaveLength(2);
    expect(runner.live).toBe(0);
    // paused is the last visible thing, after every disposal
    const pausedAt = log.indexOf('event:paused');
    expect(pausedAt).toBeGreaterThan(-1);
    for (const c of ['child-1', 'child-2', 'child-3', 'child-4']) expect(log.indexOf(`dispose:${c}`)).toBeLessThan(pausedAt);
    expect(events.filter((e) => e.plan.status === 'paused')).toHaveLength(1);
    const p = await plan();
    expect(p.status).toBe('paused');
    expect(p.lease).toBeUndefined();
    expect(reservedTotal(p)).toBe(0);
    expect(p.paused!.reason).toContain('the provider returned an error');
    const byBrief = (b: string) => {
      const l = runner.launches.find((x) => x.brief === b)!;
      return p.steps[0].attempts.find((a) => a.attemptId === l.attemptId)!;
    };
    expect(p.paused!.attemptId).toBe(byBrief('Do fail').attemptId);
    // Task 9a: the second failure after an automatic retry is the assistant's.
    expect(p.paused!.retried).toBe(true);
    // the stragglers' unsettled requests were charged in full (pessimistic)
    expect(byBrief('Do stuck1')).toMatchObject({ phase: 'ambiguous', spentTokens: 1000 });
    expect(byBrief('Do stuck2')).toMatchObject({ phase: 'ambiguous', spentTokens: 1000 });
    // Review item 7: the user is told about the cut-off siblings in this same
    // pause, so Continue does not pause again for each of them.
    expect(byBrief('Do stuck1').ambiguityReported).toBe(true);
    expect(byBrief('Do stuck2').ambiguityReported).toBe(true);
    expect(p.paused!.reason).toBe('A specialist in step "s1" stopped with an error: the provider returned an error. '
      + '2 other specialists in step "s1" were cut off mid-request, and it isn\'t known whether those requests finished; '
      + 'Continue lets them pick up from what they recorded.');
    // 5b follow-up: the kind, and the cut-off note on its own for the card.
    expect(p.paused).toMatchObject({
      kind: 'specialist-error',
      note: '2 other specialists in step "s1" were cut off mid-request, and it isn\'t known whether those requests finished; '
        + 'Continue lets them pick up from what they recorded.',
    });
    // the sibling that honoured the abort settled itself
    expect(byBrief('Do quick')).toMatchObject({ phase: 'response-persisted', spentTokens: 1000 });
    expect(p.steps[1].attempts).toHaveLength(0);
    expect(exec.activeRuns()).toBe(0);
  });

  it('budget exhaustion pauses on the attempt that ran out, so Add budget targets it', async () => {
    const runner = new FakeRunner((l) => (l.brief === 'Review a'
      ? async () => ({ kind: 'stopped', stop: { kind: 'exhausted', detail: 'This specialist has used its whole budget.' } })
      : completes('ok')));
    const fence = await seed(record(TWO_STEP));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p = await plan();
    const l = runner.launches.find((x) => x.brief === 'Review a')!;
    expect(p.status).toBe('paused');
    expect(p.paused).toEqual({ stepId: 's1', attemptId: l.attemptId, reason: 'This specialist has used its whole budget.', kind: 'budget' });
  });

  it.each([
    ['a refused request', { kind: 'stopped', stop: { kind: 'refused', detail: 'nothing was sent' } }, 'budget-refused'],
    ['a stopped specialist', { kind: 'interrupted' }, 'specialist-stopped'],
  ] as const)('5b follow-up: %s pauses with its own kind', async (_name, outcome, kind) => {
    const runner = new FakeRunner((l) => (l.brief === 'Review a' ? async () => outcome as any : completes('ok')));
    const fence = await seed(record(TWO_STEP));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    expect((await plan()).paused!.kind).toBe(kind);
  });

  it('5b review: an attempt-exhausted refusal is a budget pause even when no attempt is named', async () => {
    const runner = new FakeRunner(() => completes('ok'));
    const fence = await seed(record(TWO_STEP));
    vi.spyOn(budget, 'reserveAttempts').mockResolvedValueOnce({ ok: false, reason: 'attempt-exhausted', detail: 'used up' } as any);
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p = await plan();
    expect(runner.launches).toHaveLength(0);
    expect(p.paused).toMatchObject({ kind: 'budget', reason: 'used up' });
    expect(p.paused!.attemptId).toBeUndefined();
  });

  it('a wave that does not fit the ceiling pauses with the budget detail and launches nothing', async () => {
    const runner = new FakeRunner(() => completes('ok'));
    const fence = await seed(record(TWO_STEP, { ceilingTokens: 1500 }));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p = await plan();
    expect(runner.launches).toHaveLength(0);
    expect(p.status).toBe('paused');
    expect(p.paused!.reason).toMatch(/needs 2,000 tokens/);
    expect(p.paused!.kind).toBe('ceiling-shortfall');
  });

  it('Stop follows the same bounded settle ordering and leaves nothing held', async () => {
    const runner = new FakeRunner(fourScripts(false));
    const fence = await seed(record(FOUR));
    const exec = executor(runner, { settleDeadlineMs: 80 });
    exec.start({ ref: REF, planId: 'p1', fence });
    while (runner.launches.length < 4 || reservedTotal(await plan()) === 0 || (await plan()).steps[0].attempts.filter((a) => a.phase === 'request-sent').length < 4) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const t0 = Date.now();
    const releases: unknown[] = [];
    const release = journal.releaseLease.bind(journal);
    journal.releaseLease = async (...a) => { releases.push(a); return release(...a); };
    const applied = await exec.stop({ ref: REF, planId: 'p1', finalize: (p) => { p.status = 'stopped'; } });
    expect(applied).toBe(true);
    expect(releases).toHaveLength(0); // the lease goes in the same write as "stopped"
    log.push('stop-returned');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(80);
    expect(runner.aborted.sort()).toEqual(['child-1', 'child-2', 'child-3', 'child-4']);
    expect(runner.live).toBe(0);
    const p = await plan();
    expect(p.lease).toBeUndefined();
    expect(reservedTotal(p)).toBe(0);
    expect(p.steps[0].attempts.filter((a) => a.phase === 'ambiguous')).toHaveLength(2);
    // PlanService's own "stopped" edit rode in the executor's final write.
    expect(p.status).toBe('stopped');
    expect(log.filter((l) => l === 'event:stopped')).toHaveLength(1);
    expect(log.indexOf('dispose:child-4')).toBeLessThan(log.indexOf('event:stopped'));
    expect(log.indexOf('dispose:child-4')).toBeLessThan(log.indexOf('stop-returned'));
    expect(exec.activeRuns()).toBe(0);
  });

  it('destroy / app quit interrupts active plans into recoverable journal state', async () => {
    const runner = new FakeRunner(fourScripts(false));
    const fence = await seed(record(FOUR));
    const exec = executor(runner, { settleDeadlineMs: 40 });
    exec.start({ ref: REF, planId: 'p1', fence });
    while ((await plan()).steps[0].attempts.filter((a) => a.phase === 'request-sent').length < 4) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await exec.interruptSession('parent-1');
    let p = await plan();
    expect(p.status).toBe('interrupted');
    expect(p.lease).toBeUndefined();
    expect(p.steps[0].status).toBe('paused');
    expect(reservedTotal(p)).toBe(0);
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
    expect(reservedTotal(p)).toBe(0);
    expect(runner.live).toBe(0);
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
    budget = new PlanBudget({ journal, newId: () => `att${++ids}` });
    let release!: () => void;
    const gateOpen = new Promise<void>((r) => { release = r; });
    const runner = new FakeRunner(() => async (ctx) => { await gateOpen; return completes('ok')(ctx); });
    const fence = await seed(record(MAP6));
    const exec = executor(runner, { heartbeatMs: 10 });
    exec.start({ ref: REF, planId: 'p1', fence });
    const before = (await plan()).lease!.expiresAt;
    now = 50_000;
    await new Promise((r) => setTimeout(r, 40));
    expect((await plan()).lease!.expiresAt).toBe(50_000 + 60_000);
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

describe('the minimum Add budget amount', () => {
  it('a pause on a specific specialist records the smallest tranche that lets it continue', async () => {
    const runner = new FakeRunner((l) => (l.brief === 'Review a'
      ? async () => ({ kind: 'stopped', stop: { kind: 'exhausted', detail: 'This specialist has used its whole budget.' } })
      : completes('ok')));
    runner.minimum = 1_234;
    const fence = await seed(record(TWO_STEP));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p = await plan();
    const stopped = runner.launches.find((l) => l.brief === 'Review a')!;
    expect(p.paused).toMatchObject({ attemptId: stopped.attemptId, minimumAddTokens: 1_234 });
    expect(runner.minimumAsked).toEqual([stopped.attemptId]);
  });

  it('a plan-limit pause that names no specialist records the shortfall itself (review item 1)', async () => {
    const runner = new FakeRunner(() => completes('ok'));
    runner.minimum = 99;
    const fence = await seed(record(TWO_STEP, { ceilingTokens: 1500 }));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    // Needs 2,000 with 1,500 left → 500 short; the runner is not asked.
    expect((await plan()).paused!.minimumAddTokens).toBe(500);
    expect(runner.minimumAsked).toEqual([]);
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

  it('a budget-stopped or errored turn is not a finished report', () => {
    const base = [ev('user-message', { text: 'b' }), ev('assistant-text', { text: 'partial' })];
    expect(classifyChildTranscript([...base, ev('turn-complete', { stopReason: 'plan_budget_exhausted' })]))
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
      ev('turn-complete', { stopReason: 'plan_budget_exhausted' }),
      ev('user-message', { text: PLAN_RESTART_BRIEF }),
    ])).toEqual({ kind: 'resumable', briefDelivered: true });
  });
});

describe('a specialist whose budget route cannot be used', () => {
  it('pauses with the real reason before anything is reserved or launched', async () => {
    const runner = new FakeRunner(() => completes('ok'));
    runner.refusal = 'Plan budgets are switched off for this model after a request went over its limit: x';
    const fence = await seed(record(TWO_STEP));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p = await plan();
    expect(runner.launches).toHaveLength(0);
    expect(p.steps[0].attempts).toHaveLength(0);
    expect(p).toMatchObject({ status: 'paused', paused: { stepId: 's1', reason: runner.refusal, kind: 'launch-failed', launch: 'refused' } });
    // Task 9a: a refusal would only repeat — never retried.
    expect(p.recoveries).toBeUndefined();
  });
});

describe('review fixes (Task 4 review 1)', () => {
  it('item 1: a failed step can be retried once Add budget covers the recorded shortfall', async () => {
    const doc: PlanDocumentV1 = { goal: 'one', steps: [
      { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Review {item}', budget_tokens: 1500, items: ['a'] },
    ] };
    const failedAttempt = attemptRec({
      attemptId: 'old', childId: 'kid-old', spentTokens: 1200, baseTokens: 1500, phase: 'committed', terminal: 'failed', reportText: '', completedAt: 2,
    });
    const rec = record(doc, { status: 'paused', paused: { stepId: 's1', reason: 'x' }, usedTokens: 1200, steps: [{ id: 's1', status: 'paused', attempts: [failedAttempt] }] });
    const runner = new FakeRunner(() => completes('ok'));
    const fence = await seed(rec);
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    let p = await plan();
    expect(runner.launches).toHaveLength(0);
    expect(p.paused).toMatchObject({ stepId: 's1', minimumAddTokens: 1200 });
    expect(p.paused!.attemptId).toBeUndefined();
    await budget.addTokens({ ref: REF, planId: 'p1', stepId: 's1', tokens: 1200 });
    const again = await journal.acquireLease(REF, 'p1', { startFrom: ['paused'] });
    if (!again.ok) throw new Error('lease');
    exec.start({ ref: REF, planId: 'p1', fence: again.fence });
    await exec.settled('p1');
    p = await plan();
    expect(runner.launches).toHaveLength(1);
    expect(p.status).toBe('completed');
    expect(p.ceilingTokens).toBe(2700);
  });

  it('round 2: a shortfall pause stays fundable when the step still has an unfinished specialist', async () => {
    const doc: PlanDocumentV1 = { goal: 'two', steps: [
      { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Review {item}', budget_tokens: 1500, items: ['a', 'b'] },
    ] };
    const failed = attemptRec({ attemptId: 'fa', itemIndex: 0, childId: 'kid-a', baseTokens: 1500, spentTokens: 1200, phase: 'committed', terminal: 'failed', reportText: '', completedAt: 2 });
    const open = attemptRec({ attemptId: 'ob', itemIndex: 1, childId: 'kid-b', baseTokens: 1500, spentTokens: 300, phase: 'response-persisted' });
    const rec = record(doc, { status: 'paused', paused: { stepId: 's1', reason: 'x' }, usedTokens: 1500, steps: [{ id: 's1', status: 'paused', attempts: [failed, open] }] });
    const runner = new FakeRunner(() => completes('ok'));
    runner.verdicts.set('kid-b', { kind: 'resumable', briefDelivered: true });
    const fence = await seed(rec);
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    let p = await plan();
    // fresh a (1,500) + restart b (1,200) on 1,500 used vs 3,000 → 1,200 short.
    expect(p.paused).toMatchObject({ stepId: 's1', minimumAddTokens: 1200, ceilingShortfall: true });
    await budget.addTokens({ ref: REF, planId: 'p1', stepId: 's1', tokens: 1200 });
    expect((await plan()).steps[0].attempts.find((a) => a.attemptId === 'ob')!.addedTokens).toBe(0);
    const again = await journal.acquireLease(REF, 'p1', { startFrom: ['paused'] });
    if (!again.ok) throw new Error('lease');
    exec.start({ ref: REF, planId: 'p1', fence: again.fence });
    await exec.settled('p1');
    p = await plan();
    expect(p.status).toBe('completed');
    expect(runner.launches).toHaveLength(2);
  });

  it('items 3 and 4: an acknowledged dangling action restarts with a brief that names it — never the full brief again', async () => {
    const rec = record(TWO_STEP, {
      status: 'paused', paused: { stepId: 's1', reason: 'x' }, usedTokens: 700,
      steps: [
        { id: 's1', status: 'paused', attempts: [committed('c1', 0, 'A'), attemptRec({ attemptId: 'p2', itemIndex: 1, childId: 'kid-2', phase: 'ambiguous', ambiguityReported: true, spentTokens: 300 })] },
        { id: 's2', status: 'pending', attempts: [] },
      ],
    });
    const runner = new FakeRunner(() => completes('B'));
    runner.verdicts.set('kid-2', { kind: 'dangling-effect', tool: 'Bash', effect: 'external' });
    const fence = await seed(rec);
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const first = runner.launches[0];
    expect(first).toMatchObject({ attemptId: 'p2', resumeChildId: 'kid-2' });
    expect(first.brief).toBe(planRestartBrief({ kind: 'dangling-effect', tool: 'Bash', effect: 'external' }));
    expect(first.brief).toContain('Bash');
    expect(first.brief).toMatch(/check/i);
    expect(first.brief).not.toContain('Review b');
    expect((await plan()).status).toBe('completed');
  });
});

describe('Task 9a: automatic recovery (pause handoff §1)', () => {
  const THREE: PlanDocumentV1 = { goal: 'three', steps: [
    { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Do {item}', budget_tokens: 1000, items: ['flaky', 'b', 'c'] },
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
    const flaky = runner.launches.filter((l) => l.brief === 'Do flaky' || l.resumeChildId === 'child-1');
    expect(flaky).toHaveLength(2);
    expect(flaky[1]).toMatchObject({ resumeChildId: 'child-1', attemptId: flaky[0].attemptId });
    expect(runner.launches.filter((l) => l.brief === 'Do b')).toHaveLength(1);
    expect(runner.launches.filter((l) => l.brief === 'Do c')).toHaveLength(1);
    // The siblings were still running when the retry launched.
    const atRetry = runner.planAtLaunch[3];
    expect(atRetry.steps[0].attempts.filter((a) => a.phase === 'committed')).toHaveLength(0);
    // The recovery was journalled BEFORE the relaunch.
    expect(atRetry.recoveries).toEqual([expect.objectContaining({ stepId: 's1', iteration: 0, itemIndex: 0, cause: 'specialist-error' })]);
    // Siblings are charged only their own request.
    const byItem = (i: number) => p.steps[0].attempts.find((a) => a.itemIndex === i)!;
    expect(byItem(1).spentTokens).toBe(150);
    expect(byItem(2).spentTokens).toBe(150);
    expect(p.steps[0].attempts).toHaveLength(3);
    // The card: one row per specialist, the retried one says so.
    const rows = projectPlan(p).steps[0].children!;
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.childId === 'child-1')!.retried).toBe(true);
    expect(rows.filter((r) => r.retried)).toHaveLength(1);
  });

  it('a crash between the recovery write and the relaunch never yields a second automatic retry', async () => {
    // The journal exactly as the recovery write left it: recovery recorded,
    // hold given back, nothing relaunched yet — then the app died.
    const rec = record(THREE, {
      status: 'interrupted', usedTokens: 100,
      recoveries: [{ stepId: 's1', iteration: 0, itemIndex: 0, cause: 'specialist-error', at: 1 }],
      steps: [{ id: 's1', status: 'paused', attempts: [
        attemptRec({ attemptId: 'f', itemIndex: 0, childId: 'kid-f', phase: 'response-persisted', spentTokens: 100 }),
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
        attemptRec({ attemptId: 'f', itemIndex: 0, childId: 'kid-f', phase: 'response-persisted', spentTokens: 100 }),
        committed('c1', 1, 'B'), committed('c2', 2, 'C'),
      ] }],
    });
    let failed = false;
    const runner = new FakeRunner(() => (failed ? completes('ok') : (failed = true, failsWith('hiccup'))));
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

  it('a retry that cannot be funded becomes a budget pause on that specialist', async () => {
    const runner = new FakeRunner((l) => (l.brief === 'Do flaky'
      ? async ({ gate }) => {
        await gate.reserve({ inputBoundTokens: 100 });
        await gate.settle({ kind: 'reported', tokens: 1000, usage: { inputTokens: 100, outputTokens: 900, cacheReadTokens: 0, cacheCreationTokens: 0 } });
        return { kind: 'failed', detail: 'boom' };
      }
      : slowCompletes(5)));
    const fence = await seed(record(THREE));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p = await plan();
    const flaky = runner.launches.find((l) => l.brief === 'Do flaky')!;
    expect(runner.launches.filter((l) => l.attemptId === flaky.attemptId)).toHaveLength(1);
    expect(p.paused).toMatchObject({ kind: 'budget', attemptId: flaky.attemptId });
    expect(p.recoveries).toHaveLength(1);
    expect(reservedTotal(p)).toBe(0);
    // Review fix 3: the retry never ran, so the row does not claim it did.
    expect(projectPlan(p).steps[0].children!.some((c) => c.retried)).toBe(false);
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
        attemptRec({ attemptId: 'f', itemIndex: 0, childId: 'kid-f', phase: 'response-persisted', spentTokens: 100 }),
        committed('c1', 1, 'B'), committed('c2', 2, 'C'),
      ] }],
    });
    expect(projectPlan(rec).steps[0].children!.find((c) => c.childId === 'kid-f')!.retried).toBeUndefined();
  });

  it('a specialist error that left a Bash call unanswered goes to the assistant; Continue then restarts it with the check-first turn', async () => {
    const runner = new FakeRunner((l) => (l.brief === 'Do flaky' ? failsWith('lost the connection') : slowCompletes(5)));
    runner.verdicts.set('child-1', { kind: 'dangling-effect', tool: 'Bash', effect: 'external' });
    const fence = await seed(record(THREE));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    let p = await plan();
    expect(runner.launches.filter((l) => l.brief === 'Do flaky')).toHaveLength(1);
    expect(p.paused).toMatchObject({ kind: 'unknown-outcome', tool: 'Bash', toolEffect: 'external' });
    expect(p.paused!.reason).toContain('lost the connection');
    expect(p.paused!.retried).toBeUndefined();
    expect(p.recoveries).toBeUndefined();
    const flakyAttempt = p.steps[0].attempts.find((a) => a.childId === 'child-1')!;
    expect(flakyAttempt).toMatchObject({ phase: 'ambiguous', ambiguityReported: true });

    runner.script = () => completes('checked and done');
    const before = runner.launches.length;
    const again = await journal.acquireLease(REF, 'p1', { startFrom: ['paused'] });
    if (!again.ok) throw new Error('lease');
    exec.start({ ref: REF, planId: 'p1', fence: again.fence });
    await exec.settled('p1');
    p = await plan();
    const restart = runner.launches.slice(before).find((l) => l.resumeChildId === 'child-1');
    expect(restart).toMatchObject({ resumeChildId: 'child-1', brief: planRestartBrief({ kind: 'dangling-effect', tool: 'Bash', effect: 'external' }) });
    expect(p.status).toBe('completed');
  });

  it.each(['BashOutput', 'WebSearch'])('a specialist error that left a %s call unanswered is still retried by itself', async (tool) => {
    const runner = new FakeRunner(failsOnce());
    runner.verdicts.set('child-1', { kind: 'dangling-effect', tool, effect: nativeToolEffect(tool) });
    const fence = await seed(record(THREE));
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p = await plan();
    expect(p.status).toBe('completed');
    // A cut-off read is simply re-run: the plain continue turn.
    expect(runner.launches.find((l) => l.resumeChildId === 'child-1')!.brief).toBe(PLAN_RESTART_BRIEF);
  });

  const resumeWith = (tool: string) => resumeWithTool(tool);
  async function resumeWithTool(tool: string) {
    const rec = record(TWO_STEP, {
      status: 'interrupted', usedTokens: 700,
      steps: [
        { id: 's1', status: 'paused', attempts: [committed('c1', 0, 'A'), attemptRec({ attemptId: 'p2', itemIndex: 1, childId: 'kid-2', phase: 'response-persisted', spentTokens: 300 })] },
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
    expect(reservedTotal(p)).toBe(0);
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

  it('review fix 1: a pause never settles while a sibling\'s retry is still re-reserving; the plan ends holding nothing', async () => {
    // flaky fails at once (→ automatic retry); b stops on a refused request
    // (→ the pause) only once flaky's retry is re-reserving — a signal, not a
    // sleep, so the order holds under any load; c honours the abort.
    let retryReserving!: () => void;
    const reservingSeen = new Promise<void>((r) => { retryReserving = r; });
    const runner = new FakeRunner((l) => (l.brief === 'Do flaky' ? failsWith('hiccup')
      : l.brief === 'Do b' ? async () => { await reservingSeen; return { kind: 'stopped', stop: { kind: 'refused', detail: 'nothing was sent' } }; }
      : hangs(true)));
    const fence = await seed(record(THREE));
    const exec = executor(runner);
    // The retry's re-reservation waits until the pause has been requested,
    // then takes a while longer than everything else in the settle.
    let halted!: () => void;
    const haltSeen = new Promise<void>((r) => { halted = r; });
    const realHalt = (exec as any).requestHalt.bind(exec);
    (exec as any).requestHalt = (run: unknown, req: { kind: string }) => { realHalt(run, req); if (req.kind === 'pause') halted(); };
    const realReserve = budget.reserveAttempts.bind(budget);
    vi.spyOn(budget, 'reserveAttempts').mockImplementation(async (...args) => {
      const retry = args[3].length === 1 && args[3][0].attemptId !== undefined;
      // The 100 ms only widens the old race (so the test fails without the
      // fix); with the fix, settle waits for this whatever the timing.
      if (retry) { retryReserving(); await haltSeen; await new Promise((r) => setTimeout(r, 100)); }
      const out = await realReserve(...args);
      if (retry) log.push('retry-reserved');
      return out;
    });
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p = await plan();
    expect(p.status).toBe('paused');
    expect(p.paused).toMatchObject({ kind: 'budget-refused' });
    // The retry's write landed before settle tore anything down …
    expect(log.indexOf('retry-reserved')).toBeGreaterThan(-1);
    expect(log.indexOf('retry-reserved')).toBeLessThan(log.indexOf('dispose:child-3'));
    // … so the paused plan holds nothing, nothing was relaunched after the
    // pause, and no specialist is left alive.
    expect(reservedTotal(p)).toBe(0);
    expect(runner.launches.filter((l) => l.resumeChildId === 'child-1')).toHaveLength(0);
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
    const realReserve = budget.reserveAttempts.bind(budget);
    vi.spyOn(budget, 'reserveAttempts').mockImplementation(async (...args) => {
      if (args[3].length === 1 && args[3][0].attemptId !== undefined) throw new Error('disk full');
      return realReserve(...args);
    });
    const exec = executor(runner);
    exec.start({ ref: REF, planId: 'p1', fence });
    await exec.settled('p1');
    const p = await plan();
    const flaky = p.steps[0].attempts.find((a) => a.itemIndex === 0)!;
    expect(p.paused).toMatchObject({ kind: 'unexpected-error', attemptId: flaky.attemptId });
    expect(p.paused!.reason).toContain('disk full');
    expect(reservedTotal(p)).toBe(0);
    expect(runner.live).toBe(0);
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
      { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Write it up {item}', budget_tokens: 6000, items: ['x'] },
      { id: 's2', kind: 'combine', specialist: 'reviewer', task: 'Combine', budget_tokens: 1000, of: 's1' },
    ] };

    it('asks the same specialist once more, tools off, from the failed attempt\'s unspent share', async () => {
      let first = true;
      const runner = new FakeRunner((l) => {
        if (l.stepId !== 's1') return completes('combined');
        if (first) { first = false; return completes('   ', 1000, 500); }
        return completes('THE REPORT', 1200, 300);
      });
      const fence = await seed(record(BIG));
      const ceiling = (await plan()).ceilingTokens;
      const exec = executor(runner);
      exec.start({ ref: REF, planId: 'p1', fence });
      await exec.settled('p1');
      const p = await plan();
      expect(p.status).toBe('completed');
      expect(p.ceilingTokens).toBe(ceiling);
      const [a, b] = runner.launches.filter((l) => l.stepId === 's1');
      expect(b).toMatchObject({ resumeChildId: a.childId, toolsDisabled: true });
      expect(a.toolsDisabled).toBeUndefined();
      expect(b.attemptId).not.toBe(a.attemptId);
      expect(b.brief).toMatch(/switched off/);
      expect(b.brief).toMatch(/report/);
      const attempts = p.steps[0].attempts;
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toMatchObject({ terminal: 'failed', spentTokens: 1500 });
      expect(attempts[1]).toMatchObject({ reportOnly: true, childId: a.childId, baseTokens: 6000 - 1500, terminal: 'completed', reportText: 'THE REPORT' });
      expect(p.recoveries).toEqual([expect.objectContaining({ stepId: 's1', cause: 'invalid-report' })]);
      // The combine step read the report-only answer.
      expect(runner.launches.find((l) => l.stepId === 's2')!.brief).toContain('THE REPORT');
      // One row for that specialist, marked retried.
      const rows = projectPlan(p).steps[0].children!;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ childId: a.childId, retried: true, status: 'completed' });
    });

    it('a repeat check answers in the required form on its report-only turn', async () => {
      const doc: PlanDocumentV1 = { goal: 'loop', steps: [
        { id: 'r', kind: 'repeat', specialist: 'reviewer', task: 'loop', budget_tokens: 500, max_iterations: 2, until: 'tests pass',
          steps: [
            { id: 'fix', kind: 'map', specialist: 'reviewer', task: 'Fix {item}', budget_tokens: 1000, items: ['x'] },
            { id: 'check', kind: 'verify', specialist: 'reviewer', task: 'Check the fix', budget_tokens: 5000, of: 'fix' },
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

    it('review fix 2: the re-sent transcript counts — unspent below its measured input + 2,000 → the assistant', async () => {
      const runner = new FakeRunner((l) => (l.stepId === 's1' ? completes('   ', 1000, 500) : completes('x')));
      runner.reportBound = 3000;   // 4,500 unspent < 3,000 + 2,000
      const fence = await seed(record(BIG));
      const exec = executor(runner);
      exec.start({ ref: REF, planId: 'p1', fence });
      await exec.settled('p1');
      const p = await plan();
      expect(runner.launches).toHaveLength(1);
      expect(p.paused).toMatchObject({ kind: 'invalid-report', stepId: 's1' });
      expect(p.recoveries).toBeUndefined();
      // Measured with exactly the message the turn would send.
      expect(runner.reportBoundAsked).toHaveLength(1);
      expect(runner.reportBoundAsked[0].message).toMatch(/switched off/);
      expect(pausedRouting(p.paused!).route).toBe('assistant');
    });

    it('review fix 2: exactly enough (measured input + 2,000) is fundable', async () => {
      const runner = new FakeRunner((l) => (l.stepId === 's1' && l.toolsDisabled === undefined ? completes('   ', 1000, 500) : completes('R')));
      runner.reportBound = 2500;   // 4,500 = 2,500 + 2,000
      const fence = await seed(record(BIG));
      const exec = executor(runner);
      exec.start({ ref: REF, planId: 'p1', fence });
      await exec.settled('p1');
      expect((await plan()).status).toBe('completed');
    });

    it('review fix 2: a request that cannot be measured is not fundable', async () => {
      const runner = new FakeRunner((l) => (l.stepId === 's1' ? completes('') : completes('x')));
      runner.reportBound = undefined;
      const fence = await seed(record(BIG));
      const exec = executor(runner);
      exec.start({ ref: REF, planId: 'p1', fence });
      await exec.settled('p1');
      expect(runner.launches).toHaveLength(1);
      expect((await plan()).paused).toMatchObject({ kind: 'invalid-report' });
    });

    it('review fix 2: a Continue after the report-only message was delivered never sends that message twice', async () => {
      const rec = record(BIG, {
        status: 'paused', paused: { stepId: 's1', reason: 'x', kind: 'budget', attemptId: 'ro' }, usedTokens: 1500,
        recoveries: [{ stepId: 's1', iteration: 0, itemIndex: 0, cause: 'invalid-report', at: 1, relaunched: true }],
        steps: [
          { id: 's1', status: 'paused', attempts: [
            attemptRec({ attemptId: 'bad', childId: 'kid-s', baseTokens: 6000, spentTokens: 1500, phase: 'committed', terminal: 'failed', reportText: '', completedAt: 2 }),
            attemptRec({ attemptId: 'ro', childId: 'kid-s', baseTokens: 4500, phase: 'prepared', reportOnly: true, brief: 'REPORT NOW' }),
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

    it('less than the report allowance left → the assistant, no second request', async () => {
      const runner = new FakeRunner((l) => (l.stepId === 's1' ? completes('', 4000, 500) : completes('x')));
      const fence = await seed(record(BIG));
      const exec = executor(runner);
      exec.start({ ref: REF, planId: 'p1', fence });
      await exec.settled('p1');
      const p = await plan();
      expect(runner.launches).toHaveLength(1);
      expect(p.paused).toMatchObject({ kind: 'invalid-report', stepId: 's1' });
      expect(p.recoveries).toBeUndefined();
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
      expect(reservedTotal(p)).toBe(0);
    });

    it('a crash before the report-only turn was sent sends exactly that turn on Continue, tools still off', async () => {
      const rec = record(BIG, {
        status: 'interrupted', usedTokens: 1500,
        recoveries: [{ stepId: 's1', iteration: 0, itemIndex: 0, cause: 'invalid-report', at: 1 }],
        steps: [
          { id: 's1', status: 'paused', attempts: [
            attemptRec({ attemptId: 'bad', childId: 'kid-s', baseTokens: 6000, spentTokens: 1500, phase: 'committed', terminal: 'failed', reportText: '', completedAt: 2 }),
            attemptRec({ attemptId: 'ro', childId: 'kid-s', baseTokens: 4500, phase: 'prepared', reservedTokens: 4500, reportOnly: true, brief: 'REPORT NOW' }),
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

  it('the report-only turn\'s reply is capped at its fixed allowance', async () => {
    const rec = record(TWO_STEP, { status: 'running', steps: [
      { id: 's1', status: 'running', attempts: [attemptRec({ attemptId: 'ro', baseTokens: 9000, reservedTokens: 9000, reportOnly: true, childId: 'k' })] },
      { id: 's2', status: 'pending', attempts: [] },
    ] });
    const fence = await seed({ ...rec, status: 'proposed' });
    await journal.mutate(REF, (f) => { f.plans[0].steps = rec.steps; });
    const gate = budget.requestGate(REF, 'p1', fence, 's1', 'ro', ADAPTER);
    expect(await gate.reserve({ inputBoundTokens: 3000 })).toEqual({ ok: true, maxOutputTokens: 2000 });
  });
});
