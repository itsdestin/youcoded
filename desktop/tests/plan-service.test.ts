// Tests for PlanService — the propose/action/settings API over PlanJournal
// (specialists plans, Task 2). Real NativeHome on a temp root; the executor,
// budget adapter, manifest resolver and comment-turn queue are fakes because
// those belong to Tasks 3–4.
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { PlanJournal } from '../src/main/harness/plans/plan-journal';
import { PlanService, type PlanExecutorHooks, type PlanServiceDeps } from '../src/main/harness/plans/plan-service';
import { PlanProposalError } from '../src/main/harness/plans/types';
import type {
  ExecutionManifest, PlanActionResult, PlanAutoApproveRead, PlanEvent, PlanRef, PlanSettingsWriteResult,
} from '../src/main/harness/plans/types';
import type { PlanDocumentV1 } from '../src/main/harness/plans/schema';
import type { ToolServices } from '../src/main/harness/tools/types';

const SID = 'parent-1';
const REF: PlanRef = { cwd: '/proj', sessionId: SID };

const doc = (budget = 1000, items = ['a', 'b']): PlanDocumentV1 => ({
  goal: 'Review things',
  steps: [{ id: 's1', kind: 'map', specialist: 'reviewer', task: 'Review {item}', budget_tokens: budget, items }],
});

const baseManifest = (): ExecutionManifest => ({
  modelLabel: 'Budget model',
  specialists: { reviewer: { definitionFingerprint: 'def-1', binding: { providerId: 'openai', modelId: 'mini' }, pricing: { input: 1, output: 2 }, setupTokens: 250 } },
  permissionFingerprint: 'perm-1',
});

let root: string; let home: NativeHome; let journal: PlanJournal; let events: PlanEvent[];
let manifest: ExecutionManifest; let ids: number;
let executor: { start: Mock<PlanExecutorHooks['start']>; stop: Mock<PlanExecutorHooks['stop']> };
let queued: Array<{ sessionId: string; turnId: string; planId: string; text: string }>;
let queueFails: boolean;

function makeService(overrides: Partial<PlanServiceDeps> = {}): PlanService {
  return new PlanService({
    journal, home, now: () => 5000,
    sessionCwd: (sessionId) => (sessionId === SID ? '/proj' : undefined),
    resolveManifest: async () => structuredClone(manifest),
    queueCommentTurn: async (turn) => { if (queueFails) throw new Error('the session is closing'); queued.push(turn); },
    executor,
    newId: () => `id${++ids}`,
    ...overrides,
  });
}
let service: PlanService;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-service-'));
  home = new NativeHome(root); events = [];
  journal = new PlanJournal({ home, now: () => 5000, onEvent: (e) => events.push(e) });
  manifest = baseManifest(); ids = 0; queued = []; queueFails = false;
  executor = { start: vi.fn<PlanExecutorHooks['start']>(), stop: vi.fn<PlanExecutorHooks['stop']>(async ({ ref, planId }) => {
    // A real executor settles its children and releases its own lease.
    const plan = await journal.get(ref, planId);
    if (plan?.lease) await journal.releaseLease(ref, planId, plan.lease.fence);
  }) };
  service = makeService();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

async function propose(opts: { toolUseId?: string; turnId?: string; autoStartKey?: string; document?: PlanDocumentV1; ceilingTokens?: number; svc?: PlanService } = {}) {
  const document = opts.document ?? doc();
  const ceiling = opts.ceilingTokens ?? document.steps.reduce((n, s) => n + s.budget_tokens * (s.items?.length ?? 1), 0);
  return (opts.svc ?? service).propose({
    sessionId: SID, toolUseId: opts.toolUseId ?? 'tool-1', document, maximumAttempts: 2, ceilingTokens: ceiling, maxFanOut: 2,
    signal: new AbortController().signal, commit: () => true, turnId: opts.turnId,
    ...(opts.autoStartKey !== undefined ? { autoStartKey: opts.autoStartKey } : {}),
  });
}

/** The journal's link from a plan to the one it revises (final review F32:
 *  the card itself no longer carries it). */
const revisionOf = async (view: { planId: string }) => (await journal.get(REF, view.planId))!.revisionOf;
const okPlan = (r: PlanActionResult) => { if (!r.ok) throw new Error(`expected ok, got ${r.error}`); return r.plan; };

describe('propose', () => {
  it('is structurally the ToolServices.plans callback', () => {
    const plans: NonNullable<ToolServices['plans']> = service;
    expect(typeof plans.propose).toBe('function');
  });

  it('journals a proposal with the frozen execution manifest and emits it', async () => {
    const view = await propose();
    // Decision 4: each of the 2 specialists' 250-token setup is counted on top of its work budget.
    expect(view).toMatchObject({ status: 'proposed', toolUseId: 'tool-1', title: 'Review things', ceilingTokens: 2500, ceilingUsd: null, model: { label: 'Budget model' }, seq: 1 });
    expect(view.approximateLimit).toBeUndefined();
    const rec = await journal.get(REF, view.planId);
    expect(rec!.manifest).toEqual(baseManifest());
    expect(rec!.steps).toEqual([{ id: 's1', status: 'pending', attempts: [] }]);
    expect(events.map((e) => e.plan.status)).toEqual(['proposed']);
    expect(executor.start).not.toHaveBeenCalled();
  });

  it('prices the dollar limit from the frozen snapshot at the highest rate (Task 3)', async () => {
    manifest.specialists.reviewer.pricing = { kind: 'priced', rates: { in: 3, out: 15, cacheWrite: 30 } };
    const view = await propose();
    // 2 items × (1,000 work + 250 setup) tokens, every token at $30/M.
    expect(view.ceilingUsd).toBeCloseTo(2500 * 30 / 1e6, 12);
  });

  it('a ChatGPT specialist marks the plan limit as approximate (decision 5)', async () => {
    manifest.specialists.reviewer.approximateLimit = true;
    const view = await propose();
    expect(view.approximateLimit).toBe(true);
    expect((await journal.get(REF, view.planId))!.approximateLimit).toBe(true);
  });

  it('a local or unpriced plan shows tokens only — no fabricated $0.00 (Task 3)', async () => {
    manifest.specialists.reviewer.pricing = { kind: 'local' };
    expect((await propose({ toolUseId: 'local' })).ceilingUsd).toBeNull();
    manifest.specialists.reviewer.pricing = null;
    expect((await propose({ toolUseId: 'unpriced' })).ceilingUsd).toBeNull();
  });

  it('the first proposal on an absent journal takes the one-shot commit latch exactly once', async () => {
    let calls = 0; let latched = false;
    const commit = () => { calls++; if (latched) return false; latched = true; return true; };
    const view = await service.propose({
      sessionId: SID, toolUseId: 't', document: doc(), maximumAttempts: 2, ceilingTokens: 2000, maxFanOut: 2,
      signal: new AbortController().signal, commit,
    });
    expect(view.status).toBe('proposed');
    expect(calls).toBe(1);
    expect((await journal.get(REF, view.planId))!.status).toBe('proposed');
  });

  it('a journal that appears between the dry run and the lock still commits once (latch remembered)', async () => {
    await propose({ toolUseId: 'first' });
    // Pretend the pre-lock check saw no file, forcing the journal to re-run the
    // mutation on the real file under the lock.
    vi.spyOn(home, 'readRawBytes').mockReturnValueOnce(null);
    let latched = false;
    const commit = () => { if (latched) return false; latched = true; return true; };
    const view = await service.propose({
      sessionId: SID, toolUseId: 'second', document: doc(), maximumAttempts: 2, ceilingTokens: 2000, maxFanOut: 2,
      signal: new AbortController().signal, commit,
    });
    expect(view.toolUseId).toBe('second');
    expect((await journal.read(REF) as any).file.plans.map((p: any) => p.toolUseId)).toEqual(['first', 'second']);
  });

  it('writes nothing when the one-shot commit guard refuses (the turn was interrupted)', async () => {
    await expect(service.propose({
      sessionId: SID, toolUseId: 't', document: doc(), maximumAttempts: 2, ceilingTokens: 2000, maxFanOut: 2,
      signal: new AbortController().signal, commit: () => false,
    })).rejects.toThrow();
    expect(await journal.read(REF)).toEqual({ kind: 'absent' });
    expect(events).toEqual([]);
  });

  it('refuses a session it cannot place', async () => {
    await expect(service.propose({
      sessionId: 'ghost', toolUseId: 't', document: doc(), maximumAttempts: 2, ceilingTokens: 2000, maxFanOut: 2,
      signal: new AbortController().signal, commit: () => true,
    })).rejects.toThrow(/plans aren't available/i);
  });
});

describe('manifest drift', () => {
  it.each([
    ['binding', (m: ExecutionManifest) => { m.specialists.reviewer.binding.modelId = 'big'; }, /model a specialist would use/],
    ['pricing', (m: ExecutionManifest) => { m.specialists.reviewer.pricing = { input: 9, output: 9 }; }, /price/],
    ['definition', (m: ExecutionManifest) => { m.specialists.reviewer.definitionFingerprint = 'def-2'; }, /specialist's instructions/],
    ['permissions', (m: ExecutionManifest) => { m.permissionFingerprint = 'perm-2'; }, /permission settings/],
    ['specialist set', (m: ExecutionManifest) => { delete (m.specialists as any).reviewer; }, /specialist's instructions/],
  ])('%s drift blocks Approve and leaves the proposal untouched', async (_label, mutate, words) => {
    const view = await propose();
    mutate(manifest);
    events = [];
    const r = await service.approve(SID, view.planId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(words);
    expect((await journal.get(REF, view.planId))!.status).toBe('proposed');
    expect(executor.start).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('drift blocks Continue on a paused or interrupted plan', async () => {
    const view = await propose();
    okPlan(await service.approve(SID, view.planId));
    await journal.mutate(REF, (file) => { file.plans[0].status = 'interrupted'; delete file.plans[0].lease; });
    manifest.specialists.reviewer.pricing = null;
    const r = await service.resume(SID, view.planId);
    expect(r).toMatchObject({ ok: false });
    expect((await journal.get(REF, view.planId))!.status).toBe('interrupted');
    expect(executor.start).toHaveBeenCalledTimes(1); // only the original approve
  });

  it('a resolver refusal worded for people is reported with its real message, never as success', async () => {
    const view = await propose();
    const svc = makeService({ resolveManifest: async () => { throw new PlanProposalError('No safe budget model is available for this provider.'); } });
    expect(await svc.approve(SID, view.planId)).toEqual({ ok: false, error: 'No safe budget model is available for this provider.' });
  });

  // Final review F11: a system error never reaches the card or Settings as
  // text; the general line carries it in `detail` for the bug report only.
  it('an unexpected error answers the general line and keeps its text for the report', async () => {
    const view = await propose();
    const svc = makeService({ resolveManifest: async () => { throw new Error('EACCES: permission denied'); } });
    expect(await svc.approve(SID, view.planId)).toEqual({ ok: false, error: "Couldn't update the plan. Please try again.", detail: 'EACCES: permission denied' });
    vi.spyOn(home, 'readJson').mockImplementation(() => { throw new Error('EIO: read'); });
    expect(await svc.getAutoApprove()).toEqual({ ok: false, error: "Couldn't read the plan settings. Please try again.", detail: 'EIO: read' });
    vi.spyOn(home, 'mutateJson').mockRejectedValue(new Error('ENOSPC: disk full'));
    expect(await svc.setAutoApprove(10)).toEqual({ ok: false, error: "Couldn't save the plan settings. Please try again.", detail: 'ENOSPC: disk full' });
  });
});

describe('approve, resume, stop', () => {
  it('approve leases and starts the executor in one step; a second approve is refused', async () => {
    const view = await propose();
    const plan = okPlan(await service.approve(SID, view.planId));
    expect(plan).toMatchObject({ status: 'running', startedAt: 5000, seq: 2 });
    const rec = await journal.get(REF, view.planId);
    expect(rec!.lease).toBeDefined();
    expect(executor.start).toHaveBeenCalledWith({ ref: REF, planId: view.planId, fence: rec!.lease!.fence });
    expect(await service.approve(SID, view.planId)).toMatchObject({ ok: false, error: expect.stringMatching(/already running/) });
  });

  it('resume continues an interrupted plan under a new, larger fence', async () => {
    const view = await propose();
    okPlan(await service.approve(SID, view.planId));
    const firstFence = executor.start.mock.calls[0][0].fence;
    await journal.mutate(REF, (file) => { file.plans[0].status = 'interrupted'; delete file.plans[0].lease; });
    const plan = okPlan(await service.resume(SID, view.planId));
    expect(plan.status).toBe('running');
    const secondFence = executor.start.mock.calls[1][0].fence;
    expect(secondFence).not.toBe(firstFence);
    expect((await journal.get(REF, view.planId))!.fenceEpoch).toBe(2);
  });

  it('review fix 4: the user\'s own Continue gives unfinished work its one automatic retry back, in the lease write', async () => {
    const view = await propose();
    okPlan(await service.approve(SID, view.planId));
    const attempt = (over: Record<string, unknown>) => ({
      attemptId: 'x', itemIndex: 0, iteration: 0, baseTokens: 1250, addedTokens: 0, reservedTokens: 0, spentTokens: 10, phase: 'response-persisted', ...over,
    });
    await journal.mutate(REF, (file) => {
      const p = file.plans[0];
      p.status = 'paused'; delete p.lease;
      p.paused = { stepId: 's1', reason: 'x', kind: 'specialist-error', retried: true };
      p.steps[0].attempts = [
        attempt({ attemptId: 'done-a', itemIndex: 0, phase: 'committed', terminal: 'completed', reportText: 'A', completedAt: 1 }),
        attempt({ attemptId: 'open-b', itemIndex: 1 }),
      ] as any;
      p.recoveries = [
        { stepId: 's1', iteration: 0, itemIndex: 0, cause: 'specialist-error', at: 1, relaunched: true },
        { stepId: 's1', iteration: 0, itemIndex: 1, cause: 'specialist-error', at: 2, relaunched: true },
        { stepId: 's1', iteration: 0, itemIndex: 1, cause: 'unknown-request', at: 3 },
      ];
    });
    const seqBefore = (await journal.get(REF, view.planId))!.seq;
    okPlan(await service.resume(SID, view.planId));
    const rec = (await journal.get(REF, view.planId))!;
    // One write: the lease and the reset together.
    expect(rec.seq).toBe(seqBefore + 1);
    expect(rec.lease).toBeDefined();
    // The finished item keeps its record; the resumed one is reset (kept for
    // the card's "Retried" marker, no longer counted).
    expect(rec.recoveries).toEqual([
      { stepId: 's1', iteration: 0, itemIndex: 0, cause: 'specialist-error', at: 1, relaunched: true },
      { stepId: 's1', iteration: 0, itemIndex: 1, cause: 'specialist-error', at: 2, relaunched: true, reset: true },
      { stepId: 's1', iteration: 0, itemIndex: 1, cause: 'unknown-request', at: 3, reset: true },
    ]);
  });

  it('stop settles a running plan through the executor, then journals skipped steps with no lease', async () => {
    const view = await propose();
    okPlan(await service.approve(SID, view.planId));
    const plan = okPlan(await service.stop(SID, view.planId));
    expect(executor.stop).toHaveBeenCalledWith(expect.objectContaining({ ref: REF, planId: view.planId }));
    expect(plan).toMatchObject({ status: 'stopped', endedAt: 5000 });
    expect(plan.steps[0].status).toBe('skipped');
    expect((await journal.get(REF, view.planId))!.lease).toBeUndefined();
    expect(await service.stop(SID, view.planId)).toMatchObject({ ok: false });
  });

  it('stop refuses a plan another live window is running', async () => {
    const view = await propose();
    const other = new PlanJournal({ home, now: () => 5000, identity: { instanceId: 'other', pid: 424242 }, isProcessAlive: () => true });
    await other.acquireLease(REF, view.planId, { startFrom: ['proposed'] });
    expect(await service.stop(SID, view.planId)).toMatchObject({ ok: false, error: expect.stringMatching(/another YouCoded window/) });
    expect(executor.stop).not.toHaveBeenCalled();
  });

  it('actions on an unknown plan or session return an error, not a throw', async () => {
    expect(await service.approve(SID, 'nope')).toMatchObject({ ok: false, error: expect.any(String) });
    expect(await service.stop('ghost', 'nope')).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it('a damaged journal surfaces its real detail through every action', async () => {
    const file = path.join(root, '.youcoded', journal.relPath(REF));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"v": 7, "plans": []}');
    for (const r of [await service.approve(SID, 'p'), await service.stop(SID, 'p'), await service.resume(SID, 'p')]) {
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/version 7/) });
    }
    await expect(propose()).rejects.toThrow(/version 7/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"v": 7, "plans": []}');
  });
});

describe('comment and the trusted revision token', () => {
  it('comment retires the proposal, records a token for its queued turn, and the replacement from that turn consumes it', async () => {
    const old = await propose({ toolUseId: 'tool-old' });
    const retired = okPlan(await service.comment(SID, old.planId, '  make it smaller  '));
    expect(retired).toMatchObject({ status: 'stopped' });
    expect(queued).toEqual([{ sessionId: SID, turnId: expect.any(String), planId: old.planId, text: 'make it smaller' }]);
    const pending = await journal.pendingRevision(REF);
    expect(pending).toMatchObject({ turnId: queued[0].turnId, oldPlanId: old.planId });

    events = [];
    const next = await propose({ toolUseId: 'tool-new', turnId: queued[0].turnId });
    expect(await revisionOf(next)).toBe(old.planId);
    expect((await journal.get(REF, old.planId))!.revisedBy).toBe(next.planId);
    expect(await journal.pendingRevision(REF)).toBeUndefined();
    // One write: both cards update together.
    expect(events.map((e) => e.plan.planId).sort()).toEqual([next.planId, old.planId].sort());

    // The same turn proposing again cannot re-link.
    const again = await propose({ toolUseId: 'tool-again', turnId: queued[0].turnId });
    expect(await revisionOf(again)).toBeUndefined();
    expect((await journal.get(REF, old.planId))!.revisedBy).toBe(next.planId);
  });

  it('an unrelated proposal never consumes the token', async () => {
    const old = await propose({ toolUseId: 'tool-old' });
    okPlan(await service.comment(SID, old.planId, 'change it'));
    const unrelated = await propose({ toolUseId: 'tool-x', turnId: 'some-other-turn' });
    const untagged = await propose({ toolUseId: 'tool-y' });
    expect(await revisionOf(unrelated)).toBeUndefined();
    expect(await revisionOf(untagged)).toBeUndefined();
    expect((await journal.get(REF, old.planId))!.revisedBy).toBeUndefined();
    expect(await journal.pendingRevision(REF)).toMatchObject({ oldPlanId: old.planId });
  });

  it('a later comment supersedes the earlier token, and a repeated comment on a retired card is refused', async () => {
    const a = await propose({ toolUseId: 'tool-a' });
    const b = await propose({ toolUseId: 'tool-b' });
    okPlan(await service.comment(SID, a.planId, 'first'));
    okPlan(await service.comment(SID, b.planId, 'second'));
    expect(await service.comment(SID, a.planId, 'again')).toMatchObject({ ok: false });
    const [turnA, turnB] = queued.map((q) => q.turnId);
    const fromA = await propose({ toolUseId: 'tool-a2', turnId: turnA });
    expect(await revisionOf(fromA)).toBeUndefined();
    const fromB = await propose({ toolUseId: 'tool-b2', turnId: turnB });
    expect(await revisionOf(fromB)).toBe(b.planId);
    expect((await journal.get(REF, a.planId))!.revisedBy).toBeUndefined();
  });

  it('an empty comment is refused; a comment whose turn cannot be queued is rolled back', async () => {
    const view = await propose();
    expect(await service.comment(SID, view.planId, '   ')).toMatchObject({ ok: false });
    queueFails = true;
    const r = await service.comment(SID, view.planId, 'change it');
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('the session is closing') });
    const rec = await journal.get(REF, view.planId);
    expect(rec!.status).toBe('proposed');
    expect(rec!.steps[0].status).toBe('pending');
    expect(await journal.pendingRevision(REF)).toBeUndefined();
  });

  it('a comment on a running plan is refused', async () => {
    const view = await propose();
    okPlan(await service.approve(SID, view.planId));
    expect(await service.comment(SID, view.planId, 'x')).toMatchObject({ ok: false });
    expect(queued).toEqual([]);
  });
});

describe('auto-approve settings', () => {
  const settingsFile = () => path.join(root, '.youcoded', 'plans.json');

  it('defaults off and creates nothing on read', async () => {
    expect(await service.getAutoApprove()).toEqual({ ok: true, underTokens: 0 });
    expect(fs.existsSync(path.join(root, '.youcoded'))).toBe(false);
    const view = await propose({ ceilingTokens: 1 });
    expect(view.status).toBe('proposed');
    expect(executor.start).not.toHaveBeenCalled();
  });

  it.each([[-1], [1.5], ['5000'], [Number.NaN], [Number.POSITIVE_INFINITY], [null], [2 ** 60]])('rejects %p without writing', async (value) => {
    const r = await service.setAutoApprove(value);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/whole number/) });
    expect(fs.existsSync(settingsFile())).toBe(false);
  });

  it('persists through NativeHome, keeps unrelated keys, and can be turned back off', async () => {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({ v: 1, future: 'keep me' }));
    expect(await service.setAutoApprove(5000)).toEqual({ ok: true });
    expect(JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))).toEqual({ v: 1, future: 'keep me', autoApprove: { underTokens: 5000 } });
    expect(await makeService().getAutoApprove()).toEqual({ ok: true, underTokens: 5000 });
    expect(await service.setAutoApprove(0)).toEqual({ ok: true });
    expect(await service.getAutoApprove()).toEqual({ ok: true, underTokens: 0 });
  });

  // Final review F3: one reply can't start plan after plan without a click.
  it('starts at most one plan per turn key (F3)', async () => {
    await service.setAutoApprove(2500);
    const first = await propose({ toolUseId: 'a', document: doc(500), autoStartKey: 'turn-1' });
    const second = await propose({ toolUseId: 'b', document: doc(500), autoStartKey: 'turn-1' });
    const nextTurn = await propose({ toolUseId: 'c', document: doc(500), autoStartKey: 'turn-2' });
    expect([first.status, second.status, nextTurn.status]).toEqual(['running', 'proposed', 'running']);
    expect(second.autoApproved).toBeUndefined();
    expect(executor.start).toHaveBeenCalledTimes(2);
  });

  it('a damaged settings file reads as off', async () => {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({ v: 1, autoApprove: { underTokens: -4 } }));
    expect(await service.getAutoApprove()).toEqual({ ok: true, underTokens: 0 });
  });

  it('runs only a proposal strictly under the limit, after emitting it as a proposal', async () => {
    // Ceilings include 2 × 250 setup tokens (decision 4).
    await service.setAutoApprove(2500);
    const over = await propose({ toolUseId: 'over', document: doc(1500) }); // 3500
    const equal = await propose({ toolUseId: 'equal', document: doc(1000) }); // 2500
    expect(over.status).toBe('proposed');
    expect(equal.status).toBe('proposed');
    expect(executor.start).not.toHaveBeenCalled();

    events = [];
    const under = await propose({ toolUseId: 'under', document: doc(500) }); // 1500
    expect(under).toMatchObject({ status: 'running', autoApproved: true });
    expect(events.map((e) => [e.plan.status, e.plan.autoApproved ?? false])).toEqual([['proposed', false], ['running', true]]);
    expect(executor.start).toHaveBeenCalledTimes(1);
    expect(executor.start.mock.calls[0][0].planId).toBe(under.planId);
  });

  it('does not auto-run when no executor is wired', async () => {
    await service.setAutoApprove(2000);
    const svc = makeService({ executor: undefined });
    const view = await propose({ document: doc(500), svc });
    expect(view.status).toBe('proposed');
  });
});

describe('result discriminants', () => {
  it('reports unsupported explicitly when the host cannot run or top up plans', async () => {
    const svc = makeService({ executor: undefined, budget: undefined });
    const view = await propose({ svc });
    const approve: PlanActionResult = await svc.approve(SID, view.planId);
    expect(approve).toEqual({ ok: false, unsupported: true, error: expect.any(String) });
    expect(await svc.resume(SID, view.planId)).toMatchObject({ ok: false, unsupported: true });
    expect(await svc.addBudget(SID, view.planId, 1000)).toMatchObject({ ok: false, unsupported: true });
  });

  it('add budget validates its amount and state, then delegates to the budget adapter', async () => {
    const addTokens = vi.fn(async ({ ref, planId }: { ref: PlanRef; planId: string }) => {
      const { projectPlan } = await import('../src/main/harness/plans/plan-journal');
      return projectPlan((await journal.get(ref, planId))!);
    });
    const svc = makeService({ budget: { addTokens } });
    const view = await propose({ svc });
    expect(await svc.addBudget(SID, view.planId, 0)).toMatchObject({ ok: false, error: expect.stringMatching(/whole number/) });
    expect(await svc.addBudget(SID, view.planId, 1000)).toMatchObject({ ok: false, error: expect.stringMatching(/paused/) });
    await journal.mutate(REF, (file) => { file.plans[0].status = 'paused'; file.plans[0].paused = { stepId: 's1', reason: 'limit' }; });
    expect(await svc.addBudget(SID, view.planId, 1000)).toMatchObject({ ok: true, plan: { planId: view.planId } });
    // Task 9b: `edit` answers a pending handoff in the same write.
    expect(addTokens).toHaveBeenCalledWith({ ref: REF, planId: view.planId, stepId: 's1', tokens: 1000, edit: expect.any(Function) });
  });

  // Final review F1: Retry after a lost reply (or a second press) sends the
  // SAME request id; the service answers the plan as it stands and adds nothing.
  it('a repeated Add budget press is answered without adding again, even below a now-lowered minimum (F1)', async () => {
    const { PlanBudget } = await import('../src/main/harness/plans/plan-budget');
    const budget = new PlanBudget({ journal, now: () => 7, newId: () => `t${++ids}` });
    const addTokens = vi.fn((input: Parameters<typeof budget.addTokens>[0]) => budget.addTokens(input));
    const svc = makeService({ budget: { addTokens } });
    const view = await propose({ svc });
    await journal.mutate(REF, (file) => {
      file.plans[0].status = 'paused';
      file.plans[0].paused = { stepId: 's1', reason: 'limit', minimumAddTokens: 2_500 };
    });
    const first = okPlan(await svc.addBudget(SID, view.planId, 3_000, 'press-1'));
    const again = okPlan(await svc.addBudget(SID, view.planId, 3_000, 'press-1'));
    expect(again.ceilingTokens).toBe(first.ceilingTokens);
    expect((await journal.get(REF, view.planId))!.tranches).toHaveLength(1);
    // A malformed id is refused before anything is read or written.
    expect(await svc.addBudget(SID, view.planId, 3_000, 'x'.repeat(200))).toMatchObject({ ok: false });
  });

  it('refuses an Add budget smaller than the recorded minimum, naming that minimum (Task 4)', async () => {
    const addTokens = vi.fn(async ({ ref, planId }: { ref: PlanRef; planId: string }) => {
      const { projectPlan } = await import('../src/main/harness/plans/plan-journal');
      return projectPlan((await journal.get(ref, planId))!);
    });
    const svc = makeService({ budget: { addTokens } });
    const view = await propose({ svc });
    await journal.mutate(REF, (file) => {
      file.plans[0].status = 'paused';
      file.plans[0].paused = { stepId: 's1', reason: 'limit', attemptId: 'a1', minimumAddTokens: 2_500 };
    });
    expect(await svc.addBudget(SID, view.planId, 2_499)).toEqual({ ok: false, error: expect.stringContaining('2,500') });
    expect(addTokens).not.toHaveBeenCalled();
    expect(await svc.addBudget(SID, view.planId, 2_500)).toMatchObject({ ok: true });
    expect(addTokens).toHaveBeenCalledTimes(1);
  });

  it('Stop hands the executor the stopped write, so lease release and "stopped" are one write (review item 8)', async () => {
    const view = await propose();
    await service.approve(SID, view.planId);
    executor.stop.mockImplementation(async ({ ref, planId, finalize }) => {
      const plan = await journal.get(ref, planId);
      await journal.mutateFenced(ref, planId, plan!.lease!.fence, (p) => { delete p.lease; finalize!(p); });
      return true;
    });
    const mutate = vi.spyOn(journal, 'mutate');
    const res = await service.stop(SID, view.planId);
    expect(res).toMatchObject({ ok: true, plan: { status: 'stopped' } });
    expect(mutate.mock.calls.length).toBe(1); // the executor's single fenced write
    const rec = (await journal.get(REF, view.planId))!;
    expect(rec.lease).toBeUndefined();
    expect(rec.steps.map((s) => s.status)).toEqual(['skipped']);
  });

  it('Continue refuses up front when a budget route was switched off for this plan (Task 4)', async () => {
    const view = await propose();
    await journal.mutate(REF, (file) => {
      const p = file.plans[0];
      p.status = 'paused';
      p.paused = { stepId: 's1', reason: 'over' };
      p.disabledAdapters = [{ adapterId: 'generic:openai', detail: 'a request read 900 tokens of input, more than the 800 measured for it' }];
    });
    const res = await service.resume(SID, view.planId);
    expect(res).toEqual({ ok: false, error: expect.stringContaining('more than the 800 measured for it') });
    expect(executor.start).not.toHaveBeenCalled();
  });

  it('settings results use the same three forms', () => {
    const forms: Array<PlanAutoApproveRead | PlanSettingsWriteResult> = [
      { ok: true, underTokens: 0 }, { ok: true }, { ok: false, error: 'x' }, { ok: false, unsupported: true, error: 'y' },
    ];
    expect(forms).toHaveLength(4);
  });
});
