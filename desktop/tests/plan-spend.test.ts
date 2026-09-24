// PlanSpend — the per-attempt spend recorder (specialists plans, spending
// rework T2; backend design §3). Real filesystem journal, exactly like
// plan-executor.test.ts — PlanSpend's whole job is what it writes there.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { PlanJournal } from '../src/main/harness/plans/plan-journal';
import { PlanSpend, PLAN_LIMIT_REACHED_STOP_REASON, type PlanSpendRunFlags } from '../src/main/harness/plans/plan-spend';
import { costForUsage, billedEquivalentTokens, type ModelPricing } from '../src/main/harness/pricing';
import type { ExecutionManifest, PlanAttemptRecord, PlanRecord, PlanRef } from '../src/main/harness/plans/types';
import type { PlanDocumentV1 } from '../src/main/harness/plans/schema';

const REF: PlanRef = { cwd: '/proj', sessionId: 'parent-1' };
const MANIFEST: ExecutionManifest = {
  modelLabel: 'm', specialists: { reviewer: { definitionFingerprint: 'r' } }, steps: {}, permissionFingerprint: 'perm',
};
const DOC: PlanDocumentV1 = { goal: 'g', steps: [
  { id: 's1', kind: 'map', specialist: 'reviewer', task: 'do it', summary: 'Plain sentence.', items: ['x'] },
] };

function record(over: Partial<PlanRecord> = {}): PlanRecord {
  return {
    planId: 'p1', toolUseId: 'tool-p1', document: DOC, maximumAttempts: 1, maxFanOut: 1,
    usedTokens: 0, status: 'running', seq: 1, createdAt: 1, manifest: MANIFEST,
    steps: [{ id: 's1', status: 'running', attempts: [] }],
    fenceEpoch: 0,
    ...over,
  };
}

const attemptRec = (over: Partial<PlanAttemptRecord> = {}): PlanAttemptRecord => ({
  attemptId: 'a1', itemIndex: 0, iteration: 0, spentTokens: 0, phase: 'launched', ...over,
});

/** A minimal run-flags implementation a real ActiveRun would provide (see
 *  plan-executor.ts's memberStart closures). Records every call so a test can
 *  assert exactly what PlanSpend did with them. */
function runFlags(): PlanSpendRunFlags & { limitCalls: number; writeFailCalls: number } {
  const state = { limitReached: false, writeFailed: false, limitCalls: 0, writeFailCalls: 0 };
  return {
    isLimitReached: () => state.limitReached,
    markLimitReached: () => { state.limitReached = true; state.limitCalls++; },
    isWriteFailed: () => state.writeFailed,
    markWriteFailed: () => { state.writeFailed = true; state.writeFailCalls++; },
    get limitCalls() { return state.limitCalls; },
    get writeFailCalls() { return state.writeFailCalls; },
  } as any;
}

let root: string; let home: NativeHome; let journal: PlanJournal;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-spend-'));
  home = new NativeHome(root);
  journal = new PlanJournal({ home, identity: { instanceId: 'me', pid: 1 } });
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); });

async function seed(rec: PlanRecord): Promise<string> {
  await journal.mutate(REF, (file) => { file.plans.push(rec); });
  const lease = await journal.acquireLease(REF, rec.planId, { startFrom: [rec.status] });
  if (!lease.ok) throw new Error(`lease ${lease.reason}`);
  return lease.fence;
}

function makeSpend(fence: string, flags: PlanSpendRunFlags, attemptId = 'a1'): PlanSpend {
  return new PlanSpend({
    journal, ref: REF, planId: 'p1', stepId: 's1', attemptId, fence,
    isLimitReached: flags.isLimitReached, markLimitReached: flags.markLimitReached,
    isWriteFailed: flags.isWriteFailed, markWriteFailed: flags.markWriteFailed,
  });
}

const PRICING: ModelPricing = { in: 3, out: 15 };

describe('PlanSpend', () => {
  it('afterReply prices exactly like costForUsage with the childs price card', async () => {
    const fence = await seed(record({ steps: [{ id: 's1', status: 'running', attempts: [attemptRec()] }] }));
    const flags = runFlags();
    const spend = makeSpend(fence, flags);
    const usage = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const costUsd = costForUsage(usage, PRICING);
    spend.afterReply({ usage, costUsd });
    await spend.spendSettled();
    const p = (await journal.get(REF, 'p1'))!;
    const attempt = p.steps[0].attempts[0];
    expect(attempt.spentUsd).toBeCloseTo(costUsd!, 10);
    expect(p.usedUsd).toBeCloseTo(costUsd!, 10);
    expect(attempt.spentTokens).toBe(billedEquivalentTokens(usage));
    expect(p.usedTokens).toBe(billedEquivalentTokens(usage));
  });

  it('missing usage (all zeros, no cost) adds nothing', async () => {
    const fence = await seed(record({ steps: [{ id: 's1', status: 'running', attempts: [attemptRec()] }] }));
    const flags = runFlags();
    const spend = makeSpend(fence, flags);
    spend.afterReply({ usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, costUsd: null });
    await spend.spendSettled();
    const p = (await journal.get(REF, 'p1'))!;
    expect(p.usedTokens).toBe(0);
    expect(p.usedUsd).toBeUndefined();
    expect(p.steps[0].attempts[0].spentTokens).toBe(0);
    expect(p.steps[0].attempts[0].spentUsd).toBeUndefined();
  });

  it('crosses the limit and marks the run — beforeRequest then refuses', async () => {
    const fence = await seed(record({
      spendLimit: { usd: 1 },
      steps: [{ id: 's1', status: 'running', attempts: [attemptRec()] }],
    }));
    const flags = runFlags();
    const spend = makeSpend(fence, flags);
    const usage = { inputTokens: 500_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const costUsd = costForUsage(usage, PRICING);   // 500_000/1e6 * 3 = $1.50 — crosses $1
    expect(costUsd).toBeGreaterThan(1);
    spend.afterReply({ usage, costUsd });
    await spend.spendSettled();
    expect(flags.limitCalls).toBe(1);
    const stopped = await spend.beforeRequest();
    expect(stopped).toBe(PLAN_LIMIT_REACHED_STOP_REASON);
  });

  it('a limit changed mid-run is honoured by the very next write', async () => {
    const fence = await seed(record({
      spendLimit: { usd: 10 },   // generous; the first reply must not cross it
      steps: [{ id: 's1', status: 'running', attempts: [attemptRec()] }],
    }));
    const flags = runFlags();
    const spend = makeSpend(fence, flags);
    const usage = { inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const costUsd = costForUsage(usage, PRICING);   // $0.30
    spend.afterReply({ usage, costUsd });
    await spend.spendSettled();
    expect(flags.limitCalls).toBe(0);
    // The limit changes underneath this attempt — a settings write, a
    // sibling's own action, anything else that touches the same journal.
    await journal.mutateFenced(REF, 'p1', fence, (plan) => { plan.spendLimit = { usd: 0.1 }; });
    // The SECOND reply's write re-reads spendLimit fresh, not a value cached
    // at construction — this is the whole point of design §3's "Concurrency".
    spend.afterReply({ usage, costUsd });
    await spend.spendSettled();
    expect(flags.limitCalls).toBe(1);
  });

  it('4 concurrent writers (siblings of one run) sum exactly, with no lost update', async () => {
    const attempts = ['a1', 'a2', 'a3', 'a4'].map((id) => attemptRec({ attemptId: id }));
    const fence = await seed(record({ steps: [{ id: 's1', status: 'running', attempts } ] }));
    const flags = runFlags();   // ONE shared run-flags object — siblings of the same run
    const usage = { inputTokens: 10_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const costUsd = costForUsage(usage, PRICING);
    const spends = attempts.map((a) => makeSpend(fence, flags, a.attemptId));
    // Each writer fires several replies, all racing each other's journal write.
    for (const s of spends) { s.afterReply({ usage, costUsd }); s.afterReply({ usage, costUsd }); }
    await Promise.all(spends.map((s) => s.spendSettled()));
    const p = (await journal.get(REF, 'p1'))!;
    const perReply = billedEquivalentTokens(usage);
    expect(p.usedTokens).toBe(perReply * 2 * 4);
    expect(p.usedUsd).toBeCloseTo(costUsd! * 2 * 4, 6);
    for (const a of p.steps[0].attempts) {
      expect(a.spentTokens).toBe(perReply * 2);
      expect(a.spentUsd).toBeCloseTo(costUsd! * 2, 6);
    }
  });

  it('a last-write failure is caught and recorded — never an unhandled rejection', async () => {
    const fence = await seed(record({ steps: [{ id: 's1', status: 'running', attempts: [attemptRec()] }] }));
    const flags = runFlags();
    const spend = makeSpend(fence, flags);
    const usage = { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    vi.spyOn(journal, 'mutateFenced').mockRejectedValueOnce(new Error('lock exhausted'));
    spend.afterReply({ usage, costUsd: 0.01 });
    // Resolves — never rejects — even though the underlying write failed.
    await expect(spend.spendSettled()).resolves.toBeUndefined();
    expect(flags.writeFailCalls).toBe(1);
    const stopped = await spend.beforeRequest();
    expect(stopped).toBe(PLAN_LIMIT_REACHED_STOP_REASON);
  });

  it('spendSettled waits for a third replys slow write, not just the first two', async () => {
    const fence = await seed(record({ steps: [{ id: 's1', status: 'running', attempts: [attemptRec()] }] }));
    const flags = runFlags();
    const spend = makeSpend(fence, flags);
    const usage = { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const real = journal.mutateFenced.bind(journal);
    let call = 0;
    let releaseThird!: () => void;
    const thirdGate = new Promise<void>((r) => { releaseThird = r; });
    vi.spyOn(journal, 'mutateFenced').mockImplementation(async (...args: any[]) => {
      call++;
      if (call === 3) await thirdGate;
      return (real as any)(...args);
    });
    spend.afterReply({ usage, costUsd: 0.01 });
    spend.afterReply({ usage, costUsd: 0.01 });
    spend.afterReply({ usage, costUsd: 0.01 });   // the slow one
    let settled = false;
    const wait = spend.spendSettled().then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);   // still waiting on the third write
    releaseThird();
    await wait;
    expect(settled).toBe(true);
    const p = (await journal.get(REF, 'p1'))!;
    expect(p.usedTokens).toBe(billedEquivalentTokens(usage) * 3);
  });
});

// T2 review S2: the formula itself, pinned with literal numbers (never by
// calling the function under test). inputTokens is the WHOLE prompt, cache
// reads and writes included: 10,000 in = 1,500 uncached + 2,000 written +
// 6,500 read back. Billed-equivalent = 1,500 + 2,000 + 400 out + ceil(650).
describe('billedEquivalentTokens', () => {
  it('counts uncached input, cache writes and output in full, cache reads at a tenth (rounded up)', () => {
    expect(billedEquivalentTokens({ inputTokens: 10_000, outputTokens: 400, cacheReadTokens: 6_500, cacheCreationTokens: 2_000 })).toBe(4_550);
    expect(billedEquivalentTokens({ inputTokens: 5, outputTokens: 0, cacheReadTokens: 5, cacheCreationTokens: 0 })).toBe(1);
    expect(billedEquivalentTokens({ inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 })).toBe(1_050);
  });
});
