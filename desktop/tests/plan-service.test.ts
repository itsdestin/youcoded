// Tests for PlanService — the propose/action/settings API over PlanJournal
// (specialists plans, Task 2; spending rework T6, design §7/§8). Real
// NativeHome on a temp root; the executor, manifest resolver and comment-turn
// queue are fakes — those belong to other tasks. No PlanBudget/budget-adapter
// any more (spending rework stage 1, design §1): spending is recorded, not
// reserved, so nothing here reserves or tops up an allowance.
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { PlanJournal } from '../src/main/harness/plans/plan-journal';
import { PlanService, type PlanExecutorHooks, type PlanServiceDeps } from '../src/main/harness/plans/plan-service';
import { estimatePlan } from '../src/main/harness/plans/plan-estimate';
import { PlanProposalError } from '../src/main/harness/plans/types';
import type {
  ExecutionManifest, PlanActionResult, PlanAutoApproveRead, PlanEvent, PlanRef, PlanSettingsWriteResult,
} from '../src/main/harness/plans/types';
import type { PlanDocumentV1 } from '../src/main/harness/plans/schema';
import type { ToolServices } from '../src/main/harness/tools/types';

const SID = 'parent-1';
const REF: PlanRef = { cwd: '/proj', sessionId: SID };

const doc = (items = ['a', 'b']): PlanDocumentV1 => ({
  goal: 'Review things',
  steps: [{ id: 's1', kind: 'map', specialist: 'reviewer', task: 'Review {item}', summary: 'Plain sentence.', items }],
});

/** A document with two independent top-level leaf steps (M1: one may start
 *  while the other is still pending). */
const twoStepDoc = (): PlanDocumentV1 => ({
  goal: 'Review two things',
  steps: [
    { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Review {item}', summary: 'Plain sentence.', items: ['a'] },
    { id: 's2', kind: 'map', specialist: 'reviewer', task: 'Review {item}', summary: 'Plain sentence.', items: ['b'] },
  ],
});

const PRICED = { kind: 'priced' as const, rates: { in: 3, out: 15 } };

const baseManifest = (): ExecutionManifest => ({
  modelLabel: 'Budget model',
  specialists: { reviewer: { definitionFingerprint: 'def-1' } },
  steps: { s1: { binding: { providerId: 'openai', modelId: 'mini' }, label: 'mini', pricing: PRICED, source: 'default' } },
  permissionFingerprint: 'perm-1',
});

const twoStepManifest = (): ExecutionManifest => ({
  modelLabel: 'Budget model',
  specialists: { reviewer: { definitionFingerprint: 'def-1' } },
  steps: {
    s1: { binding: { providerId: 'openai', modelId: 'mini' }, label: 'mini', pricing: PRICED, source: 'default' },
    s2: { binding: { providerId: 'openai', modelId: 'mini' }, label: 'mini', pricing: PRICED, source: 'default' },
  },
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

async function propose(opts: { toolUseId?: string; turnId?: string; autoStartKey?: string; document?: PlanDocumentV1; svc?: PlanService } = {}) {
  const document = opts.document ?? doc();
  return (opts.svc ?? service).propose({
    sessionId: SID, toolUseId: opts.toolUseId ?? 'tool-1', document, maximumAttempts: 2, maxFanOut: 2,
    signal: new AbortController().signal, commit: () => true, turnId: opts.turnId,
    ...(opts.autoStartKey !== undefined ? { autoStartKey: opts.autoStartKey } : {}),
  });
}

/** The journal's link from a plan to the one it revises (final review F32:
 *  the card itself no longer carries it). */
const revisionOf = async (view: { planId: string }) => (await journal.get(REF, view.planId))!.revisionOf;
const okPlan = (r: PlanActionResult) => { if (!r.ok) throw new Error(`expected ok, got ${'error' in r ? r.error : r.notice}`); return r.plan; };

describe('propose', () => {
  it('is structurally the ToolServices.plans callback', () => {
    const plans: NonNullable<ToolServices['plans']> = service;
    expect(typeof plans.propose).toBe('function');
  });

  it('journals a proposal with the frozen execution manifest, its estimate, and emits it', async () => {
    const view = await propose();
    expect(view).toMatchObject({ status: 'proposed', toolUseId: 'tool-1', title: 'Review things', model: { label: 'Budget model' }, seq: 1 });
    expect(view.estimate && 'highUsd' in view.estimate).toBe(true);
    const rec = await journal.get(REF, view.planId);
    expect(rec!.manifest).toEqual(baseManifest());
    expect(rec!.steps).toEqual([{ id: 's1', status: 'pending', attempts: [] }]);
    expect(events.map((e) => e.plan.status)).toEqual(['proposed']);
    expect(executor.start).not.toHaveBeenCalled();
  });

  it('a local or unpriced plan shows a token estimate, never a fabricated dollar figure', async () => {
    manifest.steps.s1.pricing = { kind: 'local' };
    const local = await propose({ toolUseId: 'local' });
    expect(local.estimate && 'tokens' in local.estimate).toBe(true);
    manifest.steps.s1.pricing = null;
    const unpriced = await propose({ toolUseId: 'unpriced' });
    expect(unpriced.estimate && 'tokens' in unpriced.estimate).toBe(true);
  });

  it('the first proposal on an absent journal takes the one-shot commit latch exactly once', async () => {
    let calls = 0; let latched = false;
    const commit = () => { calls++; if (latched) return false; latched = true; return true; };
    const view = await service.propose({
      sessionId: SID, toolUseId: 't', document: doc(), maximumAttempts: 2, maxFanOut: 2,
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
      sessionId: SID, toolUseId: 'second', document: doc(), maximumAttempts: 2, maxFanOut: 2,
      signal: new AbortController().signal, commit,
    });
    expect(view.toolUseId).toBe('second');
    expect((await journal.read(REF) as any).file.plans.map((p: any) => p.toolUseId)).toEqual(['first', 'second']);
  });

  it('writes nothing when the one-shot commit guard refuses (the turn was interrupted)', async () => {
    await expect(service.propose({
      sessionId: SID, toolUseId: 't', document: doc(), maximumAttempts: 2, maxFanOut: 2,
      signal: new AbortController().signal, commit: () => false,
    })).rejects.toThrow();
    expect(await journal.read(REF)).toEqual({ kind: 'absent' });
    expect(events).toEqual([]);
  });

  it('refuses a session it cannot place', async () => {
    await expect(service.propose({
      sessionId: 'ghost', toolUseId: 't', document: doc(), maximumAttempts: 2, maxFanOut: 2,
      signal: new AbortController().signal, commit: () => true,
    })).rejects.toThrow(/plans aren't available/i);
  });
});

describe('manifest drift and silent re-freeze (Task 14, decision 27; design §5)', () => {
  it.each([
    ['definition', (m: ExecutionManifest) => { m.specialists.reviewer.definitionFingerprint = 'def-2'; }, /specialist's instructions/],
    ['permissions', (m: ExecutionManifest) => { m.permissionFingerprint = 'perm-2'; }, /permission settings/],
    ['specialist set', (m: ExecutionManifest) => { delete (m.specialists as any).reviewer; }, /specialist's instructions/],
  ])('%s drift blocks Approve and leaves the proposal untouched', async (_label, mutate, words) => {
    const view = await propose();
    mutate(manifest);
    events = [];
    const r = await service.approve(SID, view.planId);
    expect(r.ok).toBe(false);
    if (!r.ok && 'error' in r) expect(r.error).toMatch(words);
    expect((await journal.get(REF, view.planId))!.status).toBe('proposed');
    expect(executor.start).not.toHaveBeenCalled();
    expect(events).toEqual([]);
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

  // T4 review M2: a re-freeze must never price a STARTED step at the new
  // manifest's rate — refreeze keeps that step's frozen entry, and the
  // estimate it recomputes must be over the MERGED steps (old s1, new s2),
  // never blindly over `current`.
  it('M2: the re-frozen estimate reflects the MERGED manifest, not the raw new one, when a started step\'s price changed', async () => {
    manifest = twoStepManifest();
    const view = await propose({ document: twoStepDoc() });
    okPlan(await service.approve(SID, view.planId));
    const rec = await journal.get(REF, view.planId);
    const fence = rec!.lease!.fence;
    // s1 "started" (design §5: ≥1 attempt), s2 still pending.
    await journal.mutateFenced(REF, view.planId, fence, (plan) => {
      plan.steps.find((s) => s.id === 's1')!.attempts.push({ attemptId: 'att-1', itemIndex: 0, iteration: 0, spentTokens: 0, phase: 'launched' });
    });
    await journal.mutate(REF, (file) => { file.plans[0].status = 'interrupted'; delete file.plans[0].lease; });
    const frozenS1 = (await journal.get(REF, view.planId))!.manifest.steps.s1;

    // Prices diverge for both steps at Continue time.
    manifest.steps.s1.pricing = { kind: 'priced', rates: { in: 100, out: 200 } };
    manifest.steps.s2.pricing = { kind: 'priced', rates: { in: 9, out: 27 } };
    manifest.steps.s2.binding = { providerId: 'openai', modelId: 'other' };

    okPlan(await service.resume(SID, view.planId));
    const after = (await journal.get(REF, view.planId))!;
    // s1 kept exactly the entry it had — never repriced out from under a
    // specialist that already spent tokens on it.
    expect(after.manifest.steps.s1).toEqual(frozenS1);
    // s2, never started, takes the new manifest's entry.
    expect(after.manifest.steps.s2).toEqual(manifest.steps.s2);

    // The stored estimate is computed over exactly this merged shape — proven
    // by recomputing it the SAME way (estimateFor's own function, T5) and
    // checking it differs from naively using `current` (unmerged) for s1.
    const merged = { s1: frozenS1, s2: manifest.steps.s2 };
    const expected = estimatePlan(twoStepDoc(), merged, { entries: [] });
    const naive = estimatePlan(twoStepDoc(), manifest.steps, { entries: [] });
    expect(after.estimate).toEqual(expected);
    expect(after.estimate).not.toEqual(naive);
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
      attemptId: 'x', itemIndex: 0, iteration: 0, spentTokens: 10, phase: 'launched', ...over,
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

describe('auto-start settings (design §8, decision 34 Q-6)', () => {
  const settingsFile = () => path.join(root, '.youcoded', 'plans.json');

  it('defaults off and creates nothing on read', async () => {
    expect(await service.getAutoApprove()).toEqual({ ok: true, underUsd: 0 });
    expect(fs.existsSync(path.join(root, '.youcoded'))).toBe(false);
    const view = await propose();
    expect(view.status).toBe('proposed');
    expect(executor.start).not.toHaveBeenCalled();
  });

  it.each([[-1], ['5000'], [Number.NaN], [Number.POSITIVE_INFINITY], [null], [1001]])('rejects %p without writing', async (value) => {
    const r = await service.setAutoApprove(value);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/dollar amount/) });
    expect(fs.existsSync(settingsFile())).toBe(false);
  });

  it('persists through NativeHome, keeps unrelated keys, reads an old underTokens as off, and can be turned back off', async () => {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({ v: 1, future: 'keep me', autoApprove: { underTokens: 5000 } }));
    // WHY the old field reads as off (design §8, "the safe direction"): before
    // any write, the damaged/old shape must never silently start spending.
    expect(await service.getAutoApprove()).toEqual({ ok: true, underUsd: 0 });
    expect(await service.setAutoApprove(1.5)).toEqual({ ok: true });
    expect(JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))).toEqual({ v: 1, future: 'keep me', autoStart: { underUsd: 1.5 } });
    expect(await makeService().getAutoApprove()).toEqual({ ok: true, underUsd: 1.5 });
    expect(await service.setAutoApprove(0)).toEqual({ ok: true });
    expect(await service.getAutoApprove()).toEqual({ ok: true, underUsd: 0 });
  });

  // Final review F3: one reply can't start plan after plan without a click.
  it('starts at most one plan per turn key (F3)', async () => {
    await service.setAutoApprove(1000);
    const first = await propose({ toolUseId: 'a', autoStartKey: 'turn-1' });
    const second = await propose({ toolUseId: 'b', autoStartKey: 'turn-1' });
    const nextTurn = await propose({ toolUseId: 'c', autoStartKey: 'turn-2' });
    expect([first.status, second.status, nextTurn.status]).toEqual(['running', 'proposed', 'running']);
    expect(second.autoApproved).toBeUndefined();
    expect(executor.start).toHaveBeenCalledTimes(2);
  });

  it('a damaged settings file reads as off', async () => {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({ v: 1, autoStart: { underUsd: -4 } }));
    expect(await service.getAutoApprove()).toEqual({ ok: true, underUsd: 0 });
  });

  it('runs only a proposal strictly under the limit (its p90/highUsd — decision 34 Q-6), after emitting it as a proposal', async () => {
    // 1 item's highUsd ≈ $3.72, 2 items' ≈ $7.45 (plan-estimate.ts's own
    // built-in reviewer default, priced at PRICED) — $5 sits strictly between.
    await service.setAutoApprove(5);
    const over = await propose({ toolUseId: 'over', document: doc(['a', 'b']) });
    expect(over.status).toBe('proposed');
    expect(executor.start).not.toHaveBeenCalled();

    events = [];
    const under = await propose({ toolUseId: 'under', document: doc(['a']) });
    expect(under).toMatchObject({ status: 'running', autoApproved: true });
    expect(events.map((e) => [e.plan.status, e.plan.autoApproved ?? false])).toEqual([['proposed', false], ['running', true]]);
    expect(executor.start).toHaveBeenCalledTimes(1);
    expect(executor.start.mock.calls[0][0].planId).toBe(under.planId);
  });

  it('an unpriced plan never auto-starts, however low the setting (design §8)', async () => {
    manifest.steps.s1.pricing = null;
    await service.setAutoApprove(1000);
    const view = await propose({ document: doc(['a']) });
    expect(view.status).toBe('proposed');
    expect(executor.start).not.toHaveBeenCalled();
  });

  it('does not auto-run when no executor is wired', async () => {
    await service.setAutoApprove(1000);
    const svc = makeService({ executor: undefined });
    const view = await propose({ document: doc(['a']), svc });
    expect(view.status).toBe('proposed');
  });
});

describe('setLimit (T6, design §7)', () => {
  it('sets a dollar limit on a priced plan (unit follows the plan\'s own pricing class)', async () => {
    const view = await propose();
    const res = await service.setLimit(SID, view.planId, 5);
    expect(res).toMatchObject({ ok: true, plan: { spendLimit: { usd: 5 } } });
    expect((await journal.get(REF, view.planId))!.spendLimit).toEqual({ usd: 5 });
  });

  it('sets a token limit on an unpriced plan', async () => {
    manifest.steps.s1.pricing = null;
    const view = await propose();
    const res = await service.setLimit(SID, view.planId, 50_000);
    expect(res).toMatchObject({ ok: true, plan: { spendLimit: { tokens: 50_000 } } });
  });

  it('null clears the limit', async () => {
    const view = await propose();
    okPlan(await service.setLimit(SID, view.planId, 5));
    const res = await service.setLimit(SID, view.planId, null);
    expect(res.ok && res.plan.spendLimit).toBeUndefined();
    expect((await journal.get(REF, view.planId))!.spendLimit).toBeUndefined();
  });

  it('refuses a value at or below what has already been spent, in that unit, with a plain sentence', async () => {
    const view = await propose();
    await journal.mutate(REF, (file) => { file.plans[0].usedUsd = 3.104; });
    expect(await service.setLimit(SID, view.planId, 3.1)).toEqual({ ok: false, error: 'Set a limit above the $3.10 already spent.' });
    expect(await service.setLimit(SID, view.planId, 3)).toEqual({ ok: false, error: 'Set a limit above the $3.10 already spent.' });
    expect(await service.setLimit(SID, view.planId, 3.11)).toMatchObject({ ok: true });
  });

  it('refuses a token value at or below tokens already spent, on an unpriced plan', async () => {
    manifest.steps.s1.pricing = null;
    const view = await propose();
    await journal.mutate(REF, (file) => { file.plans[0].usedTokens = 1000; });
    expect(await service.setLimit(SID, view.planId, 1000)).toEqual({ ok: false, error: 'Set a limit above the 1,000 tokens already spent.' });
    expect(await service.setLimit(SID, view.planId, 1001)).toMatchObject({ ok: true });
  });

  it.each([[0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY]])('rejects a non-positive limit %p', async (value) => {
    const view = await propose();
    expect(await service.setLimit(SID, view.planId, value)).toMatchObject({ ok: false, error: expect.stringMatching(/positive number/) });
  });

  it('works on any unfinished plan: proposed, running, paused, interrupted', async () => {
    const view = await propose();
    expect(await service.setLimit(SID, view.planId, 5)).toMatchObject({ ok: true });
    okPlan(await service.approve(SID, view.planId));
    expect(await service.setLimit(SID, view.planId, 6)).toMatchObject({ ok: true }); // running
    await journal.mutate(REF, (file) => { file.plans[0].status = 'paused'; file.plans[0].paused = { stepId: 's1', reason: 'x', kind: 'unexpected-error' }; delete file.plans[0].lease; });
    expect(await service.setLimit(SID, view.planId, 7)).toMatchObject({ ok: true }); // paused
    await journal.mutate(REF, (file) => { file.plans[0].status = 'interrupted'; delete file.plans[0].paused; });
    expect(await service.setLimit(SID, view.planId, 8)).toMatchObject({ ok: true }); // interrupted
  });

  it('refuses on a finished plan', async () => {
    const view = await propose();
    okPlan(await service.approve(SID, view.planId));
    okPlan(await service.stop(SID, view.planId));
    expect(await service.setLimit(SID, view.planId, 5)).toMatchObject({ ok: false, error: expect.stringMatching(/already stopped/) });
  });

  it('does not supersede a pending handoff (design §7 — resume/stop still do)', async () => {
    const view = await propose();
    okPlan(await service.approve(SID, view.planId));
    await journal.mutate(REF, (file) => {
      const p = file.plans[0];
      p.status = 'paused'; delete p.lease;
      p.paused = { stepId: 's1', reason: 'x', kind: 'unexpected-error', handoff: { id: 'h-1', state: 'pending', at: 1 } };
    });
    let superseded: unknown[] = [];
    const svc = makeService({ handoffs: { superseded: (_ref, planId, handoffId) => { superseded.push({ planId, handoffId }); } } });
    expect(await svc.setLimit(SID, view.planId, 5)).toMatchObject({ ok: true });
    expect((await journal.get(REF, view.planId))!.paused!.handoff!.state).toBe('pending');
    expect(superseded).toEqual([]);
  });
});

describe('resume refuses at an already-reached limit, for any pause kind, and can raise it atomically (T6, design §7)', () => {
  async function pausedWithLimit(kind: string, spendLimit: { usd: number } | { tokens: number }, usedUsd?: number, usedTokens = 0): Promise<{ planId: string }> {
    const view = await propose();
    okPlan(await service.approve(SID, view.planId));
    await journal.mutate(REF, (file) => {
      const p = file.plans[0];
      p.status = 'paused'; delete p.lease;
      p.spendLimit = spendLimit;
      p.usedTokens = usedTokens;
      if (usedUsd !== undefined) p.usedUsd = usedUsd;
      p.paused = { stepId: 's1', reason: 'x', kind: kind as any };
    });
    // The approve() above already called executor.start once; tests below
    // assert what resume itself does, not the setup.
    executor.start.mockClear();
    return { planId: view.planId };
  }

  it.each(['spend-limit', 'specialist-error', 'unexpected-error'])('refuses a plain Continue at the limit regardless of the pause kind (%s)', async (kind) => {
    const { planId } = await pausedWithLimit(kind, { usd: 5 }, 5);
    const res = await service.resume(SID, planId);
    expect(res).toEqual({ ok: false, error: 'This plan already reached its $5.00 limit. Raise it to continue.' });
    expect((await journal.get(REF, planId))!.status).toBe('paused');
    expect(executor.start).not.toHaveBeenCalled();
  });

  it('refuses when used is past the limit, not only exactly at it', async () => {
    const { planId } = await pausedWithLimit('spend-limit', { usd: 5 }, 5.2);
    expect(await service.resume(SID, planId)).toMatchObject({ ok: false });
  });

  it('a token-unit limit refuses and words the sentence in tokens', async () => {
    const { planId } = await pausedWithLimit('spend-limit', { tokens: 20_000 }, undefined, 20_000);
    expect(await service.resume(SID, planId)).toEqual({ ok: false, error: 'This plan already reached its 20,000-token limit. Raise it to continue.' });
  });

  it('resumes normally under a limit not yet reached', async () => {
    const { planId } = await pausedWithLimit('spend-limit', { usd: 5 }, 4.99);
    expect(await service.resume(SID, planId)).toMatchObject({ ok: true, plan: { status: 'running' } });
  });

  it('an optional new limit lands in the SAME lease-taking write, lifting the refusal atomically', async () => {
    const { planId } = await pausedWithLimit('spend-limit', { usd: 5 }, 5);
    const seqBefore = (await journal.get(REF, planId))!.seq;
    const res = await service.resume(SID, planId, 10);
    expect(res).toMatchObject({ ok: true, plan: { status: 'running', spendLimit: { usd: 10 } } });
    const rec = (await journal.get(REF, planId))!;
    expect(rec.seq).toBe(seqBefore + 1); // one write: limit change + lease + start
    expect(rec.spendLimit).toEqual({ usd: 10 });
  });

  it('a new limit that is still not above what was spent is refused — the whole resume, atomically', async () => {
    const { planId } = await pausedWithLimit('spend-limit', { usd: 5 }, 5);
    const res = await service.resume(SID, planId, 5);
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('$5.00 already spent') });
    expect((await journal.get(REF, planId))!.status).toBe('paused');
    expect((await journal.get(REF, planId))!.spendLimit).toEqual({ usd: 5 }); // untouched
  });

  it('null on resume clears the limit and lifts the refusal', async () => {
    const { planId } = await pausedWithLimit('spend-limit', { usd: 5 }, 5);
    const res = await service.resume(SID, planId, null);
    expect(res.ok && res.plan.status).toBe('running');
    expect(res.ok && res.plan.spendLimit).toBeUndefined();
  });

  it('rejects a non-positive new limit before touching the journal', async () => {
    const { planId } = await pausedWithLimit('spend-limit', { usd: 5 }, 1);
    const seqBefore = (await journal.get(REF, planId))!.seq;
    expect(await service.resume(SID, planId, -1)).toMatchObject({ ok: false, error: expect.stringMatching(/positive number/) });
    expect((await journal.get(REF, planId))!.seq).toBe(seqBefore);
    expect(executor.start).not.toHaveBeenCalled();
  });
});

describe('M1 (T4 review): setStepModel races createAttempts\' own locked write, using the real journal', () => {
  it('a step with a concurrently-created attempt refuses; an untouched sibling step still succeeds', async () => {
    manifest = twoStepManifest();
    const resolveStep = vi.fn(async ({ stepId }: { stepId: string }) => ({
      binding: { providerId: 'openai', modelId: 'other' }, label: 'other', pricing: PRICED, source: 'user' as const,
    }));
    const svc = makeService({ resolveStep });
    const view = await svc.propose({
      sessionId: SID, toolUseId: 't', document: twoStepDoc(), maximumAttempts: 2, maxFanOut: 2,
      signal: new AbortController().signal, commit: () => true,
    });
    okPlan(await svc.approve(SID, view.planId));
    const rec = await journal.get(REF, view.planId);
    const fence = rec!.lease!.fence;

    // The exact write createAttempts makes (design §3: "one fenced append of
    // attempt records") — s1 becomes "started" under the plan's own lock,
    // exactly like a real executor wave would, while s2 is left alone.
    await journal.mutateFenced(REF, view.planId, fence, (plan) => {
      plan.steps.find((s) => s.id === 's1')!.attempts.push({ attemptId: 'att-1', itemIndex: 0, iteration: 0, spentTokens: 0, phase: 'launched' });
    });

    const onStarted = await svc.setStepModel(SID, view.planId, 's1', { providerId: 'openai', modelId: 'other' });
    expect(onStarted).toMatchObject({ ok: false, error: expect.stringMatching(/already started/) });

    const onPending = await svc.setStepModel(SID, view.planId, 's2', { providerId: 'openai', modelId: 'other' });
    expect(onPending).toMatchObject({ ok: true });
    const after = await journal.get(REF, view.planId);
    expect(after!.stepModels).toEqual({ s2: { providerId: 'openai', modelId: 'other' } });
    expect(after!.manifest.steps.s1.source).toBe('default'); // untouched — the race won
    expect(after!.manifest.steps.s2.source).toBe('user'); // the override took
  });
});

describe('result discriminants', () => {
  it('reports unsupported explicitly when the host cannot run plans', async () => {
    const svc = makeService({ executor: undefined });
    const view = await propose({ svc });
    const approve: PlanActionResult = await svc.approve(SID, view.planId);
    expect(approve).toEqual({ ok: false, unsupported: true, error: expect.any(String) });
    expect(await svc.resume(SID, view.planId)).toMatchObject({ ok: false, unsupported: true });
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

  it('settings results use the same three forms', () => {
    const forms: Array<PlanAutoApproveRead | PlanSettingsWriteResult> = [
      { ok: true, underUsd: 0 }, { ok: true }, { ok: false, error: 'x' }, { ok: false, unsupported: true, error: 'y' },
    ];
    expect(forms).toHaveLength(4);
  });
});
