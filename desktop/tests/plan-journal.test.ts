// Tests for PlanJournal — the single writer of sessions/<slug>/<parentId>.plans.json
// (specialists plans, Task 2). Real filesystem per test, same fixture style as
// specialist-delegation-ledger.test.ts: NativeHome(tempRoot), no fs mocking.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import {
  PlanJournal, PlanFenceError, PlanJournalUnreadableError, PlanJournalIntegrityError, projectPlan,
} from '../src/main/harness/plans/plan-journal';
import type { PlanEvent, PlanRecord, PlanRef } from '../src/main/harness/plans/types';
import type { PlanDocumentV1 } from '../src/main/harness/plans/schema';

const REF: PlanRef = { cwd: '/some/project', sessionId: 'parent-1' };

const DOC: PlanDocumentV1 = {
  goal: 'Review the auth module',
  steps: [
    { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Review {item}\nmore detail', budget_tokens: 1000, items: ['a.ts', 'b.ts'] },
    { id: 's2', kind: 'combine', specialist: 'worker', task: 'Combine the reviews', budget_tokens: 2000, of: 's1' },
    { id: 'loop', kind: 'repeat', specialist: 'worker', task: 'Iterate', budget_tokens: 500, max_iterations: 3, until: 'tests pass',
      steps: [{ id: 'fix', kind: 'map', specialist: 'worker', task: 'Fix it', budget_tokens: 700, items: ['x'] }] },
  ],
};

function record(planId: string, overrides: Partial<PlanRecord> = {}): PlanRecord {
  return {
    planId, toolUseId: `tool-${planId}`, document: DOC, maximumAttempts: 6, maxFanOut: 2,
    ceilingTokens: 6100, ceilingUsd: null, usedTokens: 0, status: 'proposed', seq: 1, createdAt: 10,
    manifest: {
      modelLabel: 'Test model',
      specialists: { reviewer: { definitionFingerprint: 'r1', binding: { providerId: 'p', modelId: 'm' }, pricing: null } },
      permissionFingerprint: 'perm-1',
    },
    steps: ['s1', 's2', 'loop', 'fix'].map((id) => ({ id, status: 'pending' as const, attempts: [] })),
    fenceEpoch: 0,
    ...overrides,
  };
}

let root: string; let home: NativeHome; let events: PlanEvent[]; let clock: number;
let alive: Set<number>;
const journalFor = (instanceId: string, pid: number) => new PlanJournal({
  home, now: () => clock, identity: { instanceId, pid }, isProcessAlive: (p) => alive.has(p),
  onEvent: (e) => events.push(e), leaseTtlMs: 1000,
});
let journal: PlanJournal;
const filePath = () => path.join(root, '.youcoded', journal.relPath(REF));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-journal-'));
  home = new NativeHome(root); events = []; clock = 1000; alive = new Set();
  journal = journalFor('inst-a', 111);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

async function seed(...recs: PlanRecord[]): Promise<void> {
  await journal.mutate(REF, (file) => { file.plans.push(...recs); });
  events = [];
}

describe('strict read and quarantine', () => {
  it('a missing journal reads as absent, creates nothing, and initializes lazily on first write', async () => {
    expect(await journal.read(REF)).toEqual({ kind: 'absent' });
    expect(await journal.list(REF)).toEqual([]);
    expect(fs.existsSync(path.join(root, '.youcoded'))).toBe(false);
    await journal.mutate(REF, (file) => { file.plans.push(record('p1')); });
    const onDisk = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    expect(onDisk.v).toBe(1);
    expect(onDisk.plans[0].planId).toBe('p1');
  });

  it.each([
    ['malformed JSON', Buffer.from('{"v":1,"plans":[{"toolUseId":"tool-9" \xff', 'latin1'), /not valid JSON/],
    ['unsupported version', Buffer.from(JSON.stringify({ v: 2, plans: [] })), /version 2/],
    ['wrong shape', Buffer.from(JSON.stringify({ v: 1, plans: [{ planId: 'x' }] })), /expected layout/],
  ])('%s: bytes are quarantined verbatim and every write is refused', async (_label, bytes, detail) => {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), bytes);

    const read = await journal.read(REF);
    expect(read.kind).toBe('invalid');
    if (read.kind !== 'invalid') throw new Error('unreachable');
    expect(read.detail).toMatch(detail);
    expect(fs.readFileSync(read.quarantinePath).equals(bytes)).toBe(true);

    await expect(journal.mutate(REF, (file) => { file.plans.push(record('p1')); })).rejects.toBeInstanceOf(PlanJournalUnreadableError);
    await expect(journal.recoverInterrupted(REF)).rejects.toBeInstanceOf(PlanJournalUnreadableError);
    // Original bytes untouched; exactly one quarantine copy however often we look.
    expect(fs.readFileSync(filePath()).equals(bytes)).toBe(true);
    await journal.read(REF);
    const copies = fs.readdirSync(path.dirname(filePath())).filter((f) => f.includes('.quarantine-'));
    expect(copies).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it('an unreadable journal projects each recoverable card as failed rather than disappearing', async () => {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), '{"v":1,"plans":[{"planId":"p9","toolUseId":"tool-9", oops');
    const views = await journal.list(REF);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ toolUseId: 'tool-9', status: 'failed' });
  });
});

describe('mutation chokepoint', () => {
  it('every visible mutation bumps that plan\'s seq and emits exactly one projected PlanView', async () => {
    await journal.mutate(REF, (file) => { file.plans.push(record('p1'), record('p2')); });
    expect(events.map((e) => [e.plan.planId, e.plan.seq])).toEqual([['p1', 1], ['p2', 1]]);
    events = [];
    await journal.mutate(REF, (file) => { file.plans[0].status = 'stopped'; });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ sessionId: 'parent-1', plan: projectPlan((await journal.get(REF, 'p1'))!) });
    expect(events[0].plan).toMatchObject({ planId: 'p1', status: 'stopped', seq: 2 });
    // A mutation that changes nothing writes nothing and emits nothing.
    events = [];
    const before = fs.readFileSync(filePath(), 'utf8');
    await journal.mutate(REF, () => {});
    expect(events).toEqual([]);
    expect(fs.readFileSync(filePath(), 'utf8')).toBe(before);
  });

  it('a throwing mutation writes nothing and emits nothing', async () => {
    await seed(record('p1'));
    await expect(journal.mutate(REF, (file) => { file.plans[0].status = 'running'; throw new Error('nope'); })).rejects.toThrow('nope');
    expect((await journal.get(REF, 'p1'))!.status).toBe('proposed');
    expect(events).toEqual([]);
  });

  it('projects top-level rows, repeat bodies with their iteration multiplier, and the card fields', () => {
    const view = projectPlan(record('p1', { status: 'running', usedTokens: 5, startedAt: 20, autoApproved: true }));
    expect(view).toMatchObject({
      planId: 'p1', toolUseId: 'tool-p1', title: 'Review the auth module', status: 'running',
      ceilingTokens: 6100, ceilingUsd: null, model: { label: 'Test model' }, usedTokens: 5, autoApproved: true, seq: 1,
    });
    expect(view.steps.map((s) => [s.id, s.kind, s.fanOut, s.budgetTokens, s.title])).toEqual([
      ['s1', 'map', 2, 1000, 'Review {item}'],
      ['s2', 'combine', 1, 2000, 'Combine the reviews'],
      ['fix', 'repeat', 3, 700, 'Fix it'],
    ]);
    // Σ(fanOut × budget) is the ceiling the validator derived.
    expect(view.steps.reduce((n, s) => n + s.fanOut * s.budgetTokens, 0)).toBe(6100);
  });
});

describe('lease and fencing', () => {
  it('lease acquisition is compare-and-swap: a second live claimant is refused', async () => {
    await seed(record('p1'));
    const a = await journal.acquireLease(REF, 'p1', { startFrom: ['proposed'] });
    expect(a).toMatchObject({ ok: true, epoch: 1 });
    expect((await journal.get(REF, 'p1'))!.status).toBe('running');
    const b = await journalFor('inst-b', 222).acquireLease(REF, 'p1');
    expect(b).toEqual({ ok: false, reason: 'held' });
  });

  it('a live foreign lease cannot be stolen even after expiry while its process lives', async () => {
    await seed(record('p1'));
    const other = journalFor('inst-b', 222);
    expect((await other.acquireLease(REF, 'p1', { startFrom: ['proposed'] })).ok).toBe(true);
    alive.add(222);
    clock += 5000; // well past expiry
    expect(await journal.acquireLease(REF, 'p1')).toEqual({ ok: false, reason: 'held' });
    expect(await journal.recoverInterrupted(REF)).toEqual([]);
    expect((await journal.get(REF, 'p1'))!.status).toBe('running');
  });

  it('an unexpired lease is authoritative even if the liveness probe fails', async () => {
    await seed(record('p1'));
    await journalFor('inst-b', 222).acquireLease(REF, 'p1', { startFrom: ['proposed'] });
    expect(await journal.acquireLease(REF, 'p1')).toEqual({ ok: false, reason: 'held' });
  });

  it('stale executors are fenced out after a takeover', async () => {
    await seed(record('p1'));
    const other = journalFor('inst-b', 222);
    const stale = await other.acquireLease(REF, 'p1', { startFrom: ['proposed'] });
    if (!stale.ok) throw new Error('setup');
    clock += 5000; // expired, and pid 222 is dead
    const fresh = await journal.acquireLease(REF, 'p1');
    if (!fresh.ok) throw new Error('takeover should succeed');
    expect(fresh.epoch).toBe(2);
    await expect(other.mutateFenced(REF, 'p1', stale.fence, (plan) => { plan.usedTokens = 99; })).rejects.toBeInstanceOf(PlanFenceError);
    await expect(other.heartbeat(REF, 'p1', stale.fence)).rejects.toBeInstanceOf(PlanFenceError);
    await journal.mutateFenced(REF, 'p1', fresh.fence, (plan) => { plan.usedTokens = 7; });
    expect((await journal.get(REF, 'p1'))!.usedTokens).toBe(7);
  });

  it('an explicit user-forced recovery may take over a live lease, with a larger epoch', async () => {
    await seed(record('p1'));
    await journalFor('inst-b', 222).acquireLease(REF, 'p1', { startFrom: ['proposed'] });
    alive.add(222);
    const forced = await journal.acquireLease(REF, 'p1', { force: true });
    expect(forced).toMatchObject({ ok: true, epoch: 2 });
  });

  it('epochs keep rising across release, and release clears the lease silently', async () => {
    await seed(record('p1'));
    const first = await journal.acquireLease(REF, 'p1', { startFrom: ['proposed'] });
    if (!first.ok) throw new Error('setup');
    events = [];
    await journal.heartbeat(REF, 'p1', first.fence);
    await journal.releaseLease(REF, 'p1', first.fence);
    // Lease bookkeeping is not a visible change — no seq bump, no card event.
    expect(events).toEqual([]);
    expect((await journal.get(REF, 'p1'))!.lease).toBeUndefined();
    const second = await journal.acquireLease(REF, 'p1');
    expect(second).toMatchObject({ ok: true, epoch: 2 });
    if (first.ok) await expect(journal.mutateFenced(REF, 'p1', first.fence, () => {})).rejects.toBeInstanceOf(PlanFenceError);
  });

  it('heartbeat extends the lease so it does not expire under a working executor', async () => {
    await seed(record('p1'));
    const l = await journal.acquireLease(REF, 'p1', { startFrom: ['proposed'] });
    if (!l.ok) throw new Error('setup');
    clock += 900; await journal.heartbeat(REF, 'p1', l.fence);
    clock += 900; // 1800 > ttl since acquisition, but only 900 since heartbeat
    expect(await journalFor('inst-b', 222).acquireLease(REF, 'p1')).toEqual({ ok: false, reason: 'held' });
  });

  it('refuses to lease a plan that is not in an allowed state', async () => {
    await seed(record('p1'), record('p2', { status: 'completed' }));
    expect(await journal.acquireLease(REF, 'p1')).toEqual({ ok: false, reason: 'wrong-status' });
    expect(await journal.acquireLease(REF, 'p2', { startFrom: ['paused'] })).toEqual({ ok: false, reason: 'wrong-status' });
    expect(await journal.acquireLease(REF, 'nope', { startFrom: ['proposed'] })).toEqual({ ok: false, reason: 'missing' });
  });

  it('recovery turns running plans with no valid owner into interrupted and frees them', async () => {
    const leaseFor = (instanceId: string, pid: number, expiresAt: number) =>
      ({ instanceId, pid, heartbeatAt: 0, expiresAt, epoch: 1, fence: `f-${instanceId}` });
    await seed(
      record('noLease', { status: 'running', steps: [{ id: 's1', status: 'running', attempts: [] }] }),
      record('deadExpired', { status: 'running', fenceEpoch: 1, lease: leaseFor('old', 333, 500) }),
      record('samePidOtherInstance', { status: 'running', fenceEpoch: 1, lease: leaseFor('prev-run', 111, 99_999) }),
      record('liveForeign', { status: 'running', fenceEpoch: 1, lease: leaseFor('b', 222, 99_999) }),
      record('mine', { status: 'running', fenceEpoch: 1, lease: leaseFor('inst-a', 111, 500) }),
      record('proposed'),
    );
    alive.add(222);
    const interrupted = await journal.recoverInterrupted(REF);
    expect(interrupted.sort()).toEqual(['deadExpired', 'noLease', 'samePidOtherInstance']);
    const byId = Object.fromEntries((await journal.read(REF) as any).file.plans.map((p: PlanRecord) => [p.planId, p]));
    expect(byId.noLease.status).toBe('interrupted');
    expect(byId.noLease.lease).toBeUndefined();
    expect(byId.noLease.steps[0].status).toBe('paused');
    expect(byId.deadExpired.lease).toBeUndefined();
    expect(byId.deadExpired.fenceEpoch).toBe(1);
    expect(byId.liveForeign.status).toBe('running');
    expect(byId.mine.status).toBe('running');
    expect(events.map((e) => e.plan.status)).toEqual(['interrupted', 'interrupted', 'interrupted']);
  });
});

describe('committed reports', () => {
  async function leased(): Promise<string> {
    await seed(record('p1'));
    const l = await journal.acquireLease(REF, 'p1', { startFrom: ['proposed'] });
    if (!l.ok) throw new Error('setup');
    await journal.mutateFenced(REF, 'p1', l.fence, (plan) => {
      plan.steps[0].attempts.push({
        attemptId: 'a1', itemIndex: 0, iteration: 0, baseTokens: 1000, addedTokens: 0,
        reservedTokens: 1000, spentTokens: 0, phase: 'response-persisted',
      });
    });
    return l.fence;
  }

  it('commitAttempt stamps the report once and later writes cannot alter it', async () => {
    const fence = await leased();
    await journal.commitAttempt(REF, 'p1', fence, 's1', 'a1', { terminal: 'completed', reportText: 'all good', spentTokens: 400 });
    const attempt = (await journal.get(REF, 'p1'))!.steps[0].attempts[0];
    expect(attempt).toMatchObject({ phase: 'committed', terminal: 'completed', reportText: 'all good', spentTokens: 400, reservedTokens: 0, completedAt: 1000 });
    expect(projectPlan((await journal.get(REF, 'p1'))!).steps[0]).toMatchObject({ done: 1, usedTokens: 400 });

    await expect(journal.commitAttempt(REF, 'p1', fence, 's1', 'a1', { terminal: 'completed', reportText: 'rewritten', spentTokens: 1 }))
      .rejects.toBeInstanceOf(PlanJournalIntegrityError);
    await expect(journal.mutateFenced(REF, 'p1', fence, (plan) => { plan.steps[0].attempts[0].reportText = 'tampered'; }))
      .rejects.toBeInstanceOf(PlanJournalIntegrityError);
    await expect(journal.mutate(REF, (file) => { file.plans[0].steps[0].attempts = []; }))
      .rejects.toBeInstanceOf(PlanJournalIntegrityError);
    expect((await journal.get(REF, 'p1'))!.steps[0].attempts[0].reportText).toBe('all good');
  });

  it('commitAttempt is fenced', async () => {
    await leased();
    await expect(journal.commitAttempt(REF, 'p1', 'forged', 's1', 'a1', { terminal: 'completed', reportText: 'x', spentTokens: 1 }))
      .rejects.toBeInstanceOf(PlanFenceError);
  });
});
