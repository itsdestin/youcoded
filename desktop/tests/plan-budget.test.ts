// Specialists plans, Task 3 — locked reserve/settle/release arithmetic.
// Real filesystem per test (NativeHome in a temp dir), real PlanJournal: every
// number here is read back from the journal file, because "durable" is the
// whole point — a reservation that exists only in memory authorizes nothing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { PlanJournal } from '../src/main/harness/plans/plan-journal';
import {
  PlanBudget, pricingSnapshot, worstCaseUsd, planCeilingUsd, planCeilingTokens, type PlanPricingSnapshot,
} from '../src/main/harness/plans/plan-budget';
import {
  adapterDisabledReason, resetDisabledAdaptersForTests, type PlanBudgetAdapter,
} from '../src/main/harness/plans/budget-adapter';
import type { PlanRecord, PlanRef, PlanEvent, ExecutionManifest } from '../src/main/harness/plans/types';
import type { PlanDocumentV1 } from '../src/main/harness/plans/schema';
import { costForUsage } from '../src/main/harness/pricing';

const REF: PlanRef = { cwd: '/some/project', sessionId: 'parent-1' };
const REVIEWER_RATES = { in: 1, out: 10 };
const WORKER_RATES = { in: 2, out: 4, cacheWrite: 20 };

const DOC: PlanDocumentV1 = {
  goal: 'Review and combine',
  steps: [
    { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Review {item}', budget_tokens: 1000, items: ['a.ts', 'b.ts'] },
    { id: 's2', kind: 'combine', specialist: 'worker', task: 'Combine', budget_tokens: 2000, of: 's1' },
  ],
};

function manifest(reviewer: PlanPricingSnapshot | null, worker: PlanPricingSnapshot | null, setup = { reviewer: 0, worker: 0 }): ExecutionManifest {
  return {
    modelLabel: 'Test model',
    specialists: {
      reviewer: { definitionFingerprint: 'r', binding: { providerId: 'p', modelId: 'm' }, pricing: reviewer, setupTokens: setup.reviewer },
      worker: { definitionFingerprint: 'w', binding: { providerId: 'p', modelId: 'm' }, pricing: worker, setupTokens: setup.worker },
    },
    permissionFingerprint: 'perm',
  };
}
const PRICED = manifest({ kind: 'priced', rates: REVIEWER_RATES }, { kind: 'priced', rates: WORKER_RATES });

function record(over: Partial<PlanRecord> = {}): PlanRecord {
  const m = over.manifest ?? PRICED;
  return {
    planId: 'p1', toolUseId: 'tool-p1', document: DOC, maximumAttempts: 3, maxFanOut: 2,
    ceilingTokens: 4000, ceilingUsd: planCeilingUsd(DOC, m), usedTokens: 0, status: 'running', seq: 1, createdAt: 1,
    manifest: m,
    steps: [{ id: 's1', status: 'pending', attempts: [] }, { id: 's2', status: 'pending', attempts: [] }],
    fenceEpoch: 0,
    ...over,
  };
}

const ADAPTER: PlanBudgetAdapter = { id: 'test-adapter', providerType: 'openrouter', capsOutput: true, inputBound: () => ({ ok: true, tokens: 0 }) };
const SOFT: PlanBudgetAdapter = { id: 'soft-adapter', providerType: 'chatgpt', capsOutput: false, inputBound: () => ({ ok: true, tokens: 0 }) };
const usageOf = (inputTokens: number, outputTokens: number, cacheCreationTokens = 0) =>
  ({ inputTokens, outputTokens, cacheReadTokens: 0, cacheCreationTokens });

let root: string; let home: NativeHome; let journal: PlanJournal; let budget: PlanBudget;
let events: PlanEvent[]; let fence: string; let ids: number;

async function seed(rec: PlanRecord): Promise<void> {
  await journal.mutate(REF, (file) => { file.plans.push(rec); });
  const lease = await journal.acquireLease(REF, rec.planId, { startFrom: [rec.status] });
  if (!lease.ok) throw new Error('lease');
  fence = lease.fence;
  events = [];
}
const plan = async (): Promise<PlanRecord> => (await journal.get(REF, 'p1'))!;
const attempt = async (stepId: string, attemptId: string) =>
  (await plan()).steps.find((s) => s.id === stepId)!.attempts.find((a) => a.attemptId === attemptId)!;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-budget-'));
  home = new NativeHome(root); events = []; ids = 0;
  journal = new PlanJournal({ home, now: () => 5, identity: { instanceId: 'me', pid: 1 }, onEvent: (e) => events.push(e) });
  budget = new PlanBudget({ journal, now: () => 7, newId: () => `id${++ids}` });
  resetDisabledAdaptersForTests();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));

describe('pricing snapshot and dollar limits', () => {
  it('snapshots the three honest states: priced, free, local — and missing is null', () => {
    expect(pricingSnapshot({ pricing: REVIEWER_RATES, free: false, local: false })).toEqual({ kind: 'priced', rates: REVIEWER_RATES });
    expect(pricingSnapshot({ pricing: { in: 0, out: 0 }, free: false, local: false })).toEqual({ kind: 'free' });
    expect(pricingSnapshot({ pricing: null, free: true, local: false })).toEqual({ kind: 'free' });
    expect(pricingSnapshot({ pricing: REVIEWER_RATES, free: true, local: true })).toEqual({ kind: 'local' });
    expect(pricingSnapshot({ pricing: null, free: false, local: false })).toBeNull();
  });

  it('prices every token at the HIGHEST published rate, through costForUsage', () => {
    const worker: PlanPricingSnapshot = { kind: 'priced', rates: WORKER_RATES };
    expect(worstCaseUsd(worker, 1000)).toBe(costForUsage(
      { inputTokens: 0, outputTokens: 1000, cacheReadTokens: 0, cacheCreationTokens: 0 }, { in: 20, out: 20 },
    ));
    expect(worstCaseUsd(worker, 1000)).toBeCloseTo(0.02, 12);
  });

  it('missing price → null; free and local → null (never a fabricated $0.00)', () => {
    expect(worstCaseUsd(null, 1000)).toBeNull();
    expect(worstCaseUsd({ kind: 'free' }, 1000)).toBeNull();
    expect(worstCaseUsd({ kind: 'local' }, 1000)).toBeNull();
    expect(planCeilingUsd(DOC, manifest(null, { kind: 'priced', rates: WORKER_RATES }))).toBeNull();
    expect(planCeilingUsd(DOC, manifest({ kind: 'local' }, { kind: 'local' }))).toBeNull();
    expect(planCeilingUsd(DOC, manifest({ kind: 'free' }, { kind: 'local' }))).toBeNull();
  });

  it('the plan ceiling covers every item at its specialist\'s highest rate', () => {
    // 2 × 1000 reviewer tokens at $10/M + 2000 worker tokens at $20/M.
    expect(planCeilingUsd(DOC, PRICED)).toBeCloseTo(0.02 + 0.04, 12);
    // A free part adds nothing but does not erase the priced part.
    expect(planCeilingUsd(DOC, manifest({ kind: 'local' }, { kind: 'priced', rates: WORKER_RATES }))).toBeCloseTo(0.04, 12);
  });

  it('repeat iterations are all priced', () => {
    const doc: PlanDocumentV1 = { goal: 'g', steps: [
      { id: 'r', kind: 'repeat', specialist: 'worker', task: 'loop', budget_tokens: 500, max_iterations: 3, until: 'done',
        steps: [{ id: 'fix', kind: 'map', specialist: 'worker', task: 'fix', budget_tokens: 700, items: ['x', 'y'] }] },
    ] };
    expect(planCeilingUsd(doc, PRICED)).toBeCloseTo(700 * 2 * 3 * 20 / 1e6, 12);
  });
});

describe('wave reservation — atomic, against spent + reserved', () => {
  it('reserves every member of a wave in ONE journal write', async () => {
    await seed(record());
    const result = await budget.reserveAttempts(REF, 'p1', fence, [
      { stepId: 's1', itemIndex: 0 }, { stepId: 's1', itemIndex: 1 },
    ]);
    expect(result).toEqual({ ok: true, attempts: [
      { stepId: 's1', attemptId: 'id1', reservedTokens: 1000 },
      { stepId: 's1', attemptId: 'id2', reservedTokens: 1000 },
    ] });
    expect(events).toHaveLength(1);
    const s1 = (await plan()).steps[0];
    expect(s1.attempts.map((a) => [a.phase, a.baseTokens, a.addedTokens, a.reservedTokens, a.spentTokens]))
      .toEqual([['prepared', 1000, 0, 1000, 0], ['prepared', 1000, 0, 1000, 0]]);
  });

  it('two concurrent waves cannot both spend the same remaining balance', async () => {
    await seed(record({ ceilingTokens: 3000 }));
    const [a, b] = await Promise.all([
      budget.reserveAttempts(REF, 'p1', fence, [{ stepId: 's1', itemIndex: 0 }, { stepId: 's1', itemIndex: 1 }]),
      budget.reserveAttempts(REF, 'p1', fence, [{ stepId: 's2' }]),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const failed = a.ok ? b : a;
    expect(failed).toMatchObject({ ok: false, reason: 'ceiling-tokens' });
    const p = await plan();
    const reserved = p.steps.flatMap((s) => s.attempts).reduce((n, x) => n + x.reservedTokens, 0);
    expect(reserved).toBe(2000);
  });

  it('already-spent tokens count against the ceiling', async () => {
    await seed(record({ usedTokens: 2500 }));
    const result = await budget.reserveAttempts(REF, 'p1', fence, [{ stepId: 's2' }]);
    expect(result).toMatchObject({ ok: false, reason: 'ceiling-tokens' });
    expect((await plan()).steps[1].attempts).toEqual([]);
  });

  it('the dollar limit is checked at the highest applicable rate', async () => {
    // Tokens fit (2000 ≤ 4000) but 2000 reviewer tokens × $10/M = $0.02 > $0.015.
    await seed(record({ ceilingUsd: 0.015 }));
    const result = await budget.reserveAttempts(REF, 'p1', fence, [{ stepId: 's1', itemIndex: 0 }, { stepId: 's1', itemIndex: 1 }]);
    expect(result).toMatchObject({ ok: false, reason: 'ceiling-usd' });
  });

  it('local specialists share one context pool — live attempts included', async () => {
    const local = manifest({ kind: 'local' }, { kind: 'local' });
    await seed(record({ manifest: local, ceilingUsd: null }));
    const tooBig = await budget.reserveAttempts(REF, 'p1', fence,
      [{ stepId: 's1', itemIndex: 0 }, { stepId: 's1', itemIndex: 1 }], { localPoolTokens: 1500 });
    expect(tooBig).toMatchObject({ ok: false, reason: 'local-pool' });
    const first = await budget.reserveAttempts(REF, 'p1', fence, [{ stepId: 's1', itemIndex: 0 }], { localPoolTokens: 2500 });
    expect(first.ok).toBe(true);
    // The first child is still live (holding 1000): 1000 + 2000 > 2500.
    const second = await budget.reserveAttempts(REF, 'p1', fence, [{ stepId: 's2' }], { localPoolTokens: 2500 });
    expect(second).toMatchObject({ ok: false, reason: 'local-pool' });
  });

  it('a stale executor cannot reserve anything', async () => {
    await seed(record());
    await expect(budget.reserveAttempts(REF, 'p1', 'stale-fence', [{ stepId: 's2' }])).rejects.toThrow(/another YouCoded window|restarted/);
    expect((await plan()).steps[1].attempts).toEqual([]);
  });
});

describe('per-request gate — no provider request without a durable reservation', () => {
  async function reserved(stepId = 's1'): Promise<string> {
    await seed(record());
    const r = await budget.reserveAttempts(REF, 'p1', fence, [{ stepId, itemIndex: 0 }]);
    if (!r.ok) throw new Error(r.detail);
    return r.attempts[0].attemptId;
  }

  it('maxOutputTokens is exactly what remains after the input bound, and the request is journalled first', async () => {
    const id = await reserved();
    const gate = budget.requestGate(REF, 'p1', fence, 's1', id, ADAPTER);
    expect(await gate.reserve({ inputBoundTokens: 300 })).toEqual({ ok: true, maxOutputTokens: 700 });
    const a = await attempt('s1', id);
    expect(a.phase).toBe('request-sent');
    expect(a.reservedTokens).toBe(1000);
  });

  it('one output token of room is enough; zero room sends nothing', async () => {
    const id = await reserved();
    const gate = budget.requestGate(REF, 'p1', fence, 's1', id, ADAPTER);
    expect(await gate.reserve({ inputBoundTokens: 1000 })).toMatchObject({ ok: false, kind: 'exhausted' });
    expect((await attempt('s1', id)).phase).toBe('prepared');
    expect(await gate.reserve({ inputBoundTokens: 999 })).toEqual({ ok: true, maxOutputTokens: 1 });
  });

  it('an unresolved request blocks a second one', async () => {
    const id = await reserved();
    const gate = budget.requestGate(REF, 'p1', fence, 's1', id, ADAPTER);
    await gate.reserve({ inputBoundTokens: 10 });
    expect(await gate.reserve({ inputBoundTokens: 10 })).toMatchObject({ ok: false, kind: 'refused' });
  });

  it('a lost fence refuses the request and writes nothing', async () => {
    const id = await reserved();
    const gate = budget.requestGate(REF, 'p1', 'stale', 's1', id, ADAPTER);
    expect(await gate.reserve({ inputBoundTokens: 10 })).toMatchObject({ ok: false, kind: 'refused' });
    expect((await attempt('s1', id)).phase).toBe('prepared');
  });

  it('authoritative lower usage releases the difference and is priced at the real rates', async () => {
    const id = await reserved();
    const gate = budget.requestGate(REF, 'p1', fence, 's1', id, ADAPTER);
    await gate.reserve({ inputBoundTokens: 300 });
    const usage = { inputTokens: 300, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0 };
    expect(await gate.settle({ kind: 'reported', tokens: 400, usage })).toEqual({ kind: 'ok', chargedTokens: 400 });
    const a = await attempt('s1', id);
    expect([a.phase, a.spentTokens, a.reservedTokens]).toEqual(['response-persisted', 400, 600]);
    const p = await plan();
    expect(p.usedTokens).toBe(400);
    expect(p.usedUsd).toBeCloseTo(costForUsage(usage, REVIEWER_RATES)!, 12);
    // The next request gets everything that is left.
    expect(await gate.reserve({ inputBoundTokens: 100 })).toEqual({ ok: true, maxOutputTokens: 500 });
  });

  it.each(['interrupted', 'error', 'silent'] as const)('%s usage charges the whole reservation', async (why) => {
    const id = await reserved();
    const gate = budget.requestGate(REF, 'p1', fence, 's1', id, ADAPTER);
    await gate.reserve({ inputBoundTokens: 300 });
    expect(await gate.settle({ kind: 'unknown', why })).toEqual({ kind: 'ok', chargedTokens: 1000 });
    const a = await attempt('s1', id);
    expect([a.spentTokens, a.reservedTokens]).toEqual([1000, 0]);
    const p = await plan();
    expect(p.usedTokens).toBe(1000);
    expect(p.usedUsd).toBeCloseTo(worstCaseUsd({ kind: 'priced', rates: REVIEWER_RATES }, 1000)!, 12);
    expect(await gate.reserve({ inputBoundTokens: 1 })).toMatchObject({ ok: false, kind: 'exhausted' });
  });

  it('usage above the reservation disables the adapter for plans and refuses further requests', async () => {
    const id = await reserved();
    const gate = budget.requestGate(REF, 'p1', fence, 's1', id, ADAPTER);
    await gate.reserve({ inputBoundTokens: 300 });
    const usage = { inputTokens: 300, outputTokens: 900, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const settled = await gate.settle({ kind: 'reported', tokens: 1200, usage });
    expect(settled).toMatchObject({ kind: 'over-bound', chargedTokens: 1200 });
    const p = await plan();
    expect(p.usedTokens).toBe(1200); // the real spend is recorded, never hidden
    expect(p.disabledAdapters).toEqual([{ adapterId: 'test-adapter', detail: expect.stringMatching(/1,200.*1,000/) }]);
    expect(adapterDisabledReason('test-adapter')).toBeDefined();
    // The same attempt can send nothing more…
    expect(await gate.reserve({ inputBoundTokens: 0 })).toMatchObject({ ok: false, kind: 'refused' });
    // …and neither can another attempt through the same adapter, even though
    // its own allowance fits (1200 + 2000 ≤ 4000).
    const other = await budget.reserveAttempts(REF, 'p1', fence, [{ stepId: 's2' }]);
    if (!other.ok) throw new Error(other.detail);
    const otherGate = budget.requestGate(REF, 'p1', fence, 's2', other.attempts[0].attemptId, ADAPTER);
    expect(await otherGate.reserve({ inputBoundTokens: 10 })).toMatchObject({ ok: false, kind: 'refused' });
    expect((await attempt('s2', other.attempts[0].attemptId)).phase).toBe('prepared');
  });

  it('local usage is counted in tokens and never priced', async () => {
    await seed(record({ manifest: manifest({ kind: 'local' }, { kind: 'local' }), ceilingUsd: null }));
    const r = await budget.reserveAttempts(REF, 'p1', fence, [{ stepId: 's1', itemIndex: 0 }]);
    if (!r.ok) throw new Error(r.detail);
    const gate = budget.requestGate(REF, 'p1', fence, 's1', r.attempts[0].attemptId, ADAPTER);
    await gate.reserve({ inputBoundTokens: 10 });
    await gate.settle({ kind: 'unknown', why: 'silent' });
    const p = await plan();
    expect(p.usedTokens).toBe(1000);
    expect(p.usedUsd).toBeUndefined();
    expect(p.ceilingUsd).toBeNull();
  });
});

describe('pausing path — pessimistic charge and release', () => {
  it('an unresolved request is charged in full and marked ambiguous', async () => {
    await seed(record());
    const r = await budget.reserveAttempts(REF, 'p1', fence, [{ stepId: 's1', itemIndex: 0 }]);
    if (!r.ok) throw new Error(r.detail);
    const id = r.attempts[0].attemptId;
    await budget.requestGate(REF, 'p1', fence, 's1', id, ADAPTER).reserve({ inputBoundTokens: 5 });
    await budget.chargeUnresolved(REF, 'p1', fence, 's1', id);
    const a = await attempt('s1', id);
    expect([a.phase, a.spentTokens, a.reservedTokens]).toEqual(['ambiguous', 1000, 0]);
    expect((await plan()).usedTokens).toBe(1000);
  });

  it('release drops the held allowance but keeps what was spent', async () => {
    await seed(record());
    const r = await budget.reserveAttempts(REF, 'p1', fence, [{ stepId: 's1', itemIndex: 0 }]);
    if (!r.ok) throw new Error(r.detail);
    const id = r.attempts[0].attemptId;
    const gate = budget.requestGate(REF, 'p1', fence, 's1', id, ADAPTER);
    await gate.reserve({ inputBoundTokens: 250 });
    expect(await gate.settle({ kind: 'reported', tokens: 300, usage: { inputTokens: 250, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 } }))
      .toEqual({ kind: 'ok', chargedTokens: 300 });
    await budget.releaseAttempt(REF, 'p1', fence, 's1', id);
    const a = await attempt('s1', id);
    expect([a.spentTokens, a.reservedTokens]).toEqual([300, 0]);
    // Released allowance is not lost: re-reserving the same attempt gets it back.
    const again = await budget.reserveAttempts(REF, 'p1', fence, [{ stepId: 's1', attemptId: id }]);
    expect(again).toEqual({ ok: true, attempts: [{ stepId: 's1', attemptId: id, reservedTokens: 700 }] });
  });
});

describe('Add budget — an authorization tranche for the paused attempt', () => {
  async function pausedAfterExhaustion(): Promise<string> {
    await seed(record());
    const r = await budget.reserveAttempts(REF, 'p1', fence, [{ stepId: 's1', itemIndex: 0 }]);
    if (!r.ok) throw new Error(r.detail);
    const id = r.attempts[0].attemptId;
    const gate = budget.requestGate(REF, 'p1', fence, 's1', id, ADAPTER);
    await gate.reserve({ inputBoundTokens: 5 });
    await gate.settle({ kind: 'unknown', why: 'error' });
    await budget.releaseAttempt(REF, 'p1', fence, 's1', id);
    await journal.mutateFenced(REF, 'p1', fence, (p) => {
      p.status = 'paused';
      p.paused = { stepId: 's1', reason: 'Out of budget', attemptId: id };
      delete p.lease;
    });
    return id;
  }

  it('lowers the recorded minimum by what was added (Task 4)', async () => {
    await pausedAfterExhaustion();
    await journal.mutate(REF, (file) => { file.plans[0].paused!.minimumAddTokens = 800; });
    const view = await budget.addTokens({ ref: REF, planId: 'p1', stepId: 's1', tokens: 500 });
    expect((await plan()).paused!.minimumAddTokens).toBe(300);
    expect(view.paused!.minimumAddTokens).toBe(300);
    await budget.addTokens({ ref: REF, planId: 'p1', stepId: 's1', tokens: 300 });
    expect((await plan()).paused!.minimumAddTokens).toBeUndefined();
  });

  it('enlarges the paused attempt, the token ceiling and the dollar ceiling', async () => {
    const id = await pausedAfterExhaustion();
    const before = await plan();
    const view = await budget.addTokens({ ref: REF, planId: 'p1', stepId: 's1', tokens: 500 });
    const after = await plan();
    expect(view.ceilingTokens).toBe(before.ceilingTokens + 500);
    expect(after.ceilingUsd).toBeCloseTo(before.ceilingUsd! + 500 * 10 / 1e6, 12);
    expect(view.ceilingUsd).toBe(after.ceilingUsd);
    const a = await attempt('s1', id);
    expect([a.addedTokens, a.spentTokens, a.reservedTokens]).toEqual([500, 1000, 0]);
    expect(after.tranches).toEqual([{ trancheId: expect.any(String), stepId: 's1', attemptId: id, tokens: 500, at: 7 }]);
    // Finished/spent work is unchanged.
    expect(after.usedTokens).toBe(before.usedTokens);
  });

  it('the fresh resume prompt must fit inside the tranche before anything is sent', async () => {
    const id = await pausedAfterExhaustion();
    await budget.addTokens({ ref: REF, planId: 'p1', stepId: 's1', tokens: 500 });
    const lease = await journal.acquireLease(REF, 'p1', { startFrom: ['paused'] });
    if (!lease.ok) throw new Error('lease');
    // A tranche alone authorizes nothing: until the attempt is re-reserved
    // under the plan-wide check, it may not send.
    const early = budget.requestGate(REF, 'p1', lease.fence, 's1', id, ADAPTER);
    expect(await early.reserve({ inputBoundTokens: 1 })).toMatchObject({ ok: false, kind: 'refused' });
    expect((await attempt('s1', id)).phase).toBe('response-persisted');
    const again = await budget.reserveAttempts(REF, 'p1', lease.fence, [{ stepId: 's1', attemptId: id }]);
    expect(again).toEqual({ ok: true, attempts: [{ stepId: 's1', attemptId: id, reservedTokens: 500 }] });
    const gate = budget.requestGate(REF, 'p1', lease.fence, 's1', id, ADAPTER);
    expect(await gate.reserve({ inputBoundTokens: 500 })).toMatchObject({ ok: false, kind: 'exhausted' });
    expect(await gate.reserve({ inputBoundTokens: 400 })).toEqual({ ok: true, maxOutputTokens: 100 });
  });

  it('a tranche for a pause that names no specialist raises only the plan limit (Task 4 review, item 1)', async () => {
    await seed(record());
    await journal.mutateFenced(REF, 'p1', fence, (p) => {
      p.status = 'paused';
      p.paused = { stepId: 's2', reason: 'Out of budget' };
      delete p.lease;
    });
    await budget.addTokens({ ref: REF, planId: 'p1', stepId: 's2', tokens: 300 });
    expect((await plan()).tranches).toEqual([{ trancheId: expect.any(String), stepId: 's2', tokens: 300, at: 7, ceilingOnly: true }]);
    expect((await plan()).ceilingTokens).toBe(4300);
    const lease = await journal.acquireLease(REF, 'p1', { startFrom: ['paused'] });
    if (!lease.ok) throw new Error('lease');
    const r = await budget.reserveAttempts(REF, 'p1', lease.fence, [{ stepId: 's2' }]);
    if (!r.ok) throw new Error(r.detail);
    // WHY not 2,300: an allowance that grows with the ceiling can never clear
    // a ceiling shortfall — the fresh attempt keeps its approved size.
    expect(r.attempts[0].reservedTokens).toBe(2000);
    const p = await plan();
    expect(p.tranches![0].attemptId).toBeUndefined();
    expect(p.steps[1].attempts[0].addedTokens).toBe(0);
  });

  it.each([1, 2])('a plan-limit shortfall pause raises only the limit even with %i unfinished specialist(s) in the step (round 2)', async (open) => {
    const attempts = Array.from({ length: open }, (_, i) => ({
      attemptId: `open${i}`, itemIndex: i, iteration: 0, childId: `kid${i}`, baseTokens: 1000, addedTokens: 0, reservedTokens: 0, spentTokens: 300, phase: 'response-persisted' as const,
    }));
    await seed(record({ steps: [{ id: 's1', status: 'paused', attempts }, { id: 's2', status: 'pending', attempts: [] }] }));
    await journal.mutateFenced(REF, 'p1', fence, (p) => {
      p.status = 'paused';
      p.paused = { stepId: 's1', reason: 'short', minimumAddTokens: 700, ceilingShortfall: true };
      delete p.lease;
    });
    await budget.addTokens({ ref: REF, planId: 'p1', stepId: 's1', tokens: 700 });
    const p = await plan();
    expect(p.ceilingTokens).toBe(4700);
    expect(p.tranches).toEqual([{ trancheId: expect.any(String), stepId: 's1', tokens: 700, at: 7, ceilingOnly: true }]);
    expect(p.steps[0].attempts.map((a) => a.addedTokens)).toEqual(attempts.map(() => 0));
    expect(p.paused!.minimumAddTokens).toBeUndefined();
  });

  it('a ceiling refusal reports the token shortfall (Task 4 review, item 1)', async () => {
    await seed(record({ ceilingTokens: 1500, usedTokens: 1200 }));
    const r = await budget.reserveAttempts(REF, 'p1', fence, [{ stepId: 's1', itemIndex: 0 }]);
    expect(r).toMatchObject({ ok: false, reason: 'ceiling-tokens', shortfallTokens: 700 });
  });

  it('refuses a plan that is not paused, or a different step', async () => {
    await seed(record());
    await expect(budget.addTokens({ ref: REF, planId: 'p1', stepId: 's1', tokens: 5 })).rejects.toThrow(/paused/);
    await journal.mutateFenced(REF, 'p1', fence, (p) => {
      p.status = 'paused'; p.paused = { stepId: 's1', reason: 'x' }; delete p.lease;
    });
    await expect(budget.addTokens({ ref: REF, planId: 'p1', stepId: 's2', tokens: 5 })).rejects.toThrow(/paused step/);
  });

  // Final review F1: a lost reply followed by Retry, or a second press of the
  // same Add budget, must never add the tranche twice.
  it('a repeated Add budget request id is a no-op that returns the current plan (F1)', async () => {
    const id = await pausedAfterExhaustion();
    const before = await plan();
    const first = await budget.addTokens({ ref: REF, planId: 'p1', stepId: 's1', tokens: 500, requestId: 'press-1' });
    const seqAfterFirst = (await plan()).seq;
    const again = await budget.addTokens({ ref: REF, planId: 'p1', stepId: 's1', tokens: 500, requestId: 'press-1' });
    const after = await plan();
    expect(after.ceilingTokens).toBe(before.ceilingTokens + 500);
    expect((await attempt('s1', id)).addedTokens).toBe(500);
    expect(after.tranches).toHaveLength(1);
    // Nothing was written the second time, and the answer is the plan as it stands.
    expect(after.seq).toBe(seqAfterFirst);
    expect(again).toEqual(first);
    // A different press adds again.
    await budget.addTokens({ ref: REF, planId: 'p1', stepId: 's1', tokens: 200, requestId: 'press-2' });
    expect((await plan()).ceilingTokens).toBe(before.ceilingTokens + 700);
  });

  it('a request id from an earlier pause does not block the next pause (F1)', async () => {
    await pausedAfterExhaustion();
    await budget.addTokens({ ref: REF, planId: 'p1', stepId: 's1', tokens: 500, requestId: 'press-1' });
    const ceiling = (await plan()).ceilingTokens;
    // The executor writes a NEW pause object for the next pause.
    await journal.mutate(REF, (file) => { file.plans[0].paused = { stepId: 's1', reason: 'Out of budget again' }; });
    await budget.addTokens({ ref: REF, planId: 'p1', stepId: 's1', tokens: 500, requestId: 'press-1' });
    expect((await plan()).ceilingTokens).toBe(ceiling + 500);
  });

  it('local plans gain tokens only — the dollar ceiling stays absent', async () => {
    await seed(record({ manifest: manifest({ kind: 'local' }, { kind: 'local' }), ceilingUsd: null }));
    await journal.mutateFenced(REF, 'p1', fence, (p) => {
      p.status = 'paused'; p.paused = { stepId: 's2', reason: 'x' }; delete p.lease;
    });
    const view = await budget.addTokens({ ref: REF, planId: 'p1', stepId: 's2', tokens: 100 });
    expect(view.ceilingTokens).toBe(4100);
    expect(view.ceilingUsd).toBeNull();
  });
});

describe('review fixes (round 2)', () => {
  async function reservedAttempt(stepId = 's1', rec = record()): Promise<string> {
    await seed(rec);
    const r = await budget.reserveAttempts(REF, 'p1', fence, [{ stepId, itemIndex: 0 }]);
    if (!r.ok) throw new Error(r.detail);
    return r.attempts[0].attemptId;
  }

  it('reported INPUT above the certified bound is a breach even when the total fits', async () => {
    const id = await reservedAttempt();
    const gate = budget.requestGate(REF, 'p1', fence, 's1', id, ADAPTER);
    await gate.reserve({ inputBoundTokens: 300 });
    expect((await attempt('s1', id)).requestInputBound).toBe(300);
    const settled = await gate.settle({ kind: 'reported', tokens: 500, usage: usageOf(400, 100) });
    expect(settled).toMatchObject({ kind: 'over-bound', chargedTokens: 500, detail: expect.stringMatching(/400.*300/) });
    expect(adapterDisabledReason('test-adapter')).toBeDefined();
    expect((await plan()).disabledAdapters?.[0].adapterId).toBe('test-adapter');
    expect((await attempt('s1', id)).requestInputBound).toBeUndefined();
  });

  it.each([Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY])('an invalid input bound (%s) is refused and nothing is written', async (bad) => {
    const id = await reservedAttempt();
    const gate = budget.requestGate(REF, 'p1', fence, 's1', id, ADAPTER);
    expect(await gate.reserve({ inputBoundTokens: bad })).toMatchObject({ ok: false, kind: 'refused' });
    expect((await attempt('s1', id)).phase).toBe('prepared');
  });

  it('settlement re-checks the dollar limit', async () => {
    const id = await reservedAttempt();
    const gate = budget.requestGate(REF, 'p1', fence, 's1', id, ADAPTER);
    await gate.reserve({ inputBoundTokens: 300 });
    await journal.mutateFenced(REF, 'p1', fence, (p) => { p.ceilingUsd = 0.0000001; });
    const settled = await gate.settle({ kind: 'reported', tokens: 150, usage: usageOf(100, 50) });
    expect(settled).toMatchObject({ kind: 'over-bound', detail: expect.stringMatching(/dollar limit/) });
    // A dollar overrun is not a broken token bound: the adapter stays trusted.
    expect(adapterDisabledReason('test-adapter')).toBeUndefined();
  });

  it('prices cache writes once: the SDK input total already contains them', async () => {
    const id = await reservedAttempt('s2');
    const gate = budget.requestGate(REF, 'p1', fence, 's2', id, ADAPTER);
    await gate.reserve({ inputBoundTokens: 400 });
    await gate.settle({ kind: 'reported', tokens: 350, usage: usageOf(300, 50, 100) });
    // 200 uncached × $2 + 100 written × $20 + 50 out × $4, per million.
    expect((await plan()).usedUsd).toBeCloseTo((200 * 2 + 100 * 20 + 50 * 4) / 1e6, 12);
  });
});

describe('setup cost counted separately (decision 4)', () => {
  const SETUP = { reviewer: 100, worker: 200 };
  const M = manifest({ kind: 'priced', rates: REVIEWER_RATES }, { kind: 'priced', rates: WORKER_RATES }, SETUP);

  it('the ceiling is every attempt\'s setup plus its work budget, dollars included', () => {
    expect(planCeilingTokens(DOC, M)).toBe(2 * (1000 + 100) + (2000 + 200));
    expect(planCeilingUsd(DOC, M)).toBeCloseTo((2 * 1100 * 10 + 2200 * 20) / 1e6, 12);
    const doc: PlanDocumentV1 = { goal: 'g', steps: [
      { id: 'r', kind: 'repeat', specialist: 'worker', task: 'loop', budget_tokens: 500, max_iterations: 3, until: 'done',
        steps: [{ id: 'fix', kind: 'map', specialist: 'worker', task: 'fix', budget_tokens: 700, items: ['x', 'y'] }] },
    ] };
    expect(planCeilingTokens(doc, M)).toBe(2 * 3 * (700 + 200));
  });

  it('an attempt\'s first request is covered by setup + its whole work allowance', async () => {
    await seed(record({ manifest: M, ceilingTokens: planCeilingTokens(DOC, M), ceilingUsd: planCeilingUsd(DOC, M) }));
    const r = await budget.reserveAttempts(REF, 'p1', fence, [{ stepId: 's1', itemIndex: 0 }, { stepId: 's1', itemIndex: 1 }, { stepId: 's2' }]);
    if (!r.ok) throw new Error(r.detail);
    expect(r.attempts.map((a) => a.reservedTokens)).toEqual([1100, 1100, 2200]);
    const gate = budget.requestGate(REF, 'p1', fence, 's1', r.attempts[0].attemptId, ADAPTER);
    // A first request whose bound is exactly setup (100) + a 40-token brief leaves 960 for the reply.
    expect(await gate.reserve({ inputBoundTokens: 140 })).toEqual({ ok: true, maxOutputTokens: 960 });
  });
});

describe('soft limit — no reply cap (decision 5)', () => {
  async function softAttempt(): Promise<string> {
    await seed(record());
    const r = await budget.reserveAttempts(REF, 'p1', fence, [{ stepId: 's1', itemIndex: 0 }]);
    if (!r.ok) throw new Error(r.detail);
    return r.attempts[0].attemptId;
  }

  it('still reserves first and marks the attempt soft-limited', async () => {
    const id = await softAttempt();
    const gate = budget.requestGate(REF, 'p1', fence, 's1', id, SOFT);
    expect(await gate.reserve({ inputBoundTokens: 300 })).toEqual({ ok: true, maxOutputTokens: 700 });
    expect(await attempt('s1', id)).toMatchObject({ phase: 'request-sent', softLimit: true });
    expect(await gate.reserve({ inputBoundTokens: 1000 })).toMatchObject({ ok: false });
  });

  it('one overshooting reply is charged as actually used, then nothing more is sent', async () => {
    const id = await softAttempt();
    const gate = budget.requestGate(REF, 'p1', fence, 's1', id, SOFT);
    await gate.reserve({ inputBoundTokens: 300 });
    const settled = await gate.settle({ kind: 'reported', tokens: 1500, usage: usageOf(250, 1250) });
    expect(settled).toMatchObject({ kind: 'limit-reached', chargedTokens: 1500 });
    const a = await attempt('s1', id);
    expect([a.spentTokens, a.reservedTokens]).toEqual([1500, 0]);
    expect((await plan()).usedTokens).toBe(1500);
    // Overshoot is the documented soft behaviour, not a broken adapter.
    expect(adapterDisabledReason('soft-adapter')).toBeUndefined();
    expect(await gate.reserve({ inputBoundTokens: 1 })).toMatchObject({ ok: false, kind: 'exhausted' });
  });

  it('a reply that exactly uses the allowance also stops further requests', async () => {
    const id = await softAttempt();
    const gate = budget.requestGate(REF, 'p1', fence, 's1', id, SOFT);
    await gate.reserve({ inputBoundTokens: 300 });
    expect(await gate.settle({ kind: 'reported', tokens: 1000, usage: usageOf(250, 750) })).toMatchObject({ kind: 'limit-reached' });
  });

  it('input above the certified bound is still a breach on a soft route', async () => {
    const id = await softAttempt();
    const gate = budget.requestGate(REF, 'p1', fence, 's1', id, SOFT);
    await gate.reserve({ inputBoundTokens: 300 });
    expect(await gate.settle({ kind: 'reported', tokens: 400, usage: usageOf(350, 50) })).toMatchObject({ kind: 'over-bound' });
    expect(adapterDisabledReason('soft-adapter')).toBeDefined();
  });
});

describe('soft plans stop at the PLAN limit, not just the attempt limit (round 3)', () => {
  it('a sibling cannot reserve once another reply pushed the plan past its ceiling', async () => {
    // Ceiling 2,000 = exactly the two s1 attempts; no dollar ceiling.
    await seed(record({ ceilingTokens: 2000, ceilingUsd: null }));
    const r = await budget.reserveAttempts(REF, 'p1', fence, [{ stepId: 's1', itemIndex: 0 }, { stepId: 's1', itemIndex: 1 }]);
    if (!r.ok) throw new Error(r.detail);
    const [a, b] = r.attempts.map((x) => budget.requestGate(REF, 'p1', fence, 's1', x.attemptId, SOFT));
    await a.reserve({ inputBoundTokens: 100 });
    // A overshoots by far more than its own 1,000: the plan is now past 2,000.
    expect(await a.settle({ kind: 'reported', tokens: 2500, usage: usageOf(100, 2400) })).toMatchObject({ kind: 'limit-reached' });
    expect((await plan()).usedTokens).toBe(2500);
    // B still holds its own 1,000, but the plan's limit is gone: nothing is sent.
    expect(await b.reserve({ inputBoundTokens: 100 })).toMatchObject({ ok: false, kind: 'exhausted' });
    expect((await attempt('s1', r.attempts[1].attemptId)).phase).toBe('prepared');
  });

  it('the same holds for a dollar limit that was passed', async () => {
    await seed(record());
    const r = await budget.reserveAttempts(REF, 'p1', fence, [{ stepId: 's1', itemIndex: 0 }]);
    if (!r.ok) throw new Error(r.detail);
    await journal.mutateFenced(REF, 'p1', fence, (p) => { p.usedUsd = p.ceilingUsd! + 0.01; });
    const gate = budget.requestGate(REF, 'p1', fence, 's1', r.attempts[0].attemptId, SOFT);
    expect(await gate.reserve({ inputBoundTokens: 100 })).toMatchObject({ ok: false, kind: 'exhausted' });
  });
});

describe('the plan-wide stop is for soft routes only (round 4)', () => {
  it('a capped plan whose dollars were charged to exactly the ceiling still lets a local specialist with tokens left send', async () => {
    const m = manifest({ kind: 'priced', rates: REVIEWER_RATES }, { kind: 'local' });
    await seed(record({ manifest: m, ceilingUsd: planCeilingUsd(DOC, m) }));
    const r = await budget.reserveAttempts(REF, 'p1', fence, [{ stepId: 's2' }]);
    if (!r.ok) throw new Error(r.detail);
    // Unresolved priced attempts were pessimistically charged to exactly the limit.
    await journal.mutateFenced(REF, 'p1', fence, (p) => { p.usedUsd = p.ceilingUsd!; });
    const gate = budget.requestGate(REF, 'p1', fence, 's2', r.attempts[0].attemptId, ADAPTER);
    expect(await gate.reserve({ inputBoundTokens: 100 })).toEqual({ ok: true, maxOutputTokens: 1900 });
  });

  it('a soft plan exactly AT its dollar limit may still send (only passing it stops)', async () => {
    await seed(record());
    const r = await budget.reserveAttempts(REF, 'p1', fence, [{ stepId: 's1', itemIndex: 0 }]);
    if (!r.ok) throw new Error(r.detail);
    await journal.mutateFenced(REF, 'p1', fence, (p) => { p.usedUsd = p.ceilingUsd!; });
    const gate = budget.requestGate(REF, 'p1', fence, 's1', r.attempts[0].attemptId, SOFT);
    expect(await gate.reserve({ inputBoundTokens: 100 })).toMatchObject({ ok: true });
  });
});

describe('restart recovery for an ownerless plan (Task 4)', () => {
  it('charges an unsettled request in full, gives back every other hold, and needs no lease', async () => {
    await seed(record());
    const r = await budget.reserveAttempts(REF, 'p1', fence, [{ stepId: 's1', itemIndex: 0 }, { stepId: 's1', itemIndex: 1 }]);
    if (!r.ok) throw new Error(r.detail);
    const [sent, held] = r.attempts.map((a) => a.attemptId);
    const gate = budget.requestGate(REF, 'p1', fence, 's1', sent, ADAPTER);
    expect(await gate.reserve({ inputBoundTokens: 100 })).toMatchObject({ ok: true });
    // The process died: recovery marks it interrupted and drops the lease.
    await journal.mutate(REF, (file) => { const p = file.plans[0]; p.status = 'interrupted'; delete p.lease; });
    await budget.settleOwnerless(REF, 'p1');
    const p = await plan();
    expect(p.steps[0].attempts.find((a) => a.attemptId === sent)).toMatchObject({ phase: 'ambiguous', spentTokens: 1000, reservedTokens: 0 });
    expect(p.steps[0].attempts.find((a) => a.attemptId === held)).toMatchObject({ phase: 'prepared', spentTokens: 0, reservedTokens: 0 });
    expect(p.usedTokens).toBe(1000);
    expect(p.usedUsd).toBeCloseTo(worstCaseUsd({ kind: 'priced', rates: REVIEWER_RATES }, 1000)!, 12);
  });

  it('never touches a plan that still has an owner', async () => {
    await seed(record());
    const r = await budget.reserveAttempts(REF, 'p1', fence, [{ stepId: 's1', itemIndex: 0 }]);
    if (!r.ok) throw new Error(r.detail);
    await budget.settleOwnerless(REF, 'p1');
    expect((await plan()).steps[0].attempts[0].reservedTokens).toBe(1000);
  });
});
