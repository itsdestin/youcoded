// Specialists plans, Task 14 (decision 27) — changing which model a specialist
// runs on is a clean resume, not a re-proposal.
//
// Destin's words after live testing: "unclear why the assistant would need to
// re-propose a plan just cuz i needed to change my specialists tiers. this
// should've been a clean retry/resume". Approve and Continue CLASSIFY the
// drift: instructions/tools or permissions still refuse exactly as before; a
// change of binding and/or price silently re-freezes and runs (spending
// rework stage 1, design §5 — "no probe, no session... silently re-freeze
// not-started steps and recompute the estimate" — there is no ceiling left
// to ask about, so unlike the old world this never asks first).
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { PlanJournal } from '../src/main/harness/plans/plan-journal';
import { PlanService, type PlanExecutorHooks, type PlanServiceDeps } from '../src/main/harness/plans/plan-service';
import { PlanSpecialistsNotReadyError, type ExecutionManifest, type PlanEvent, type PlanRef } from '../src/main/harness/plans/types';
import type { PlanDocumentV1 } from '../src/main/harness/plans/schema';

const SID = 'parent-1';
const REF: PlanRef = { cwd: '/proj', sessionId: SID };

/** 2 items — one specialist, so one leaf step to change. */
const doc = (): PlanDocumentV1 => ({
  goal: 'Review things',
  steps: [{ id: 's1', kind: 'map', specialist: 'reviewer', task: 'Review {item}', summary: 'Plain sentence.', items: ['a', 'b'] }],
});

/** The plan as approved: a ChatGPT specialist at $3/$15 per million. */
const approved = (): ExecutionManifest => ({
  modelLabel: 'GPT-5',
  specialists: { reviewer: { definitionFingerprint: 'def-1' } },
  steps: { s1: { binding: { providerId: 'chatgpt', modelId: 'gpt-5' }, label: 'GPT-5', pricing: { kind: 'priced', rates: { in: 3, out: 15 } }, source: 'default' } },
  permissionFingerprint: 'perm-1',
});

const withReviewerStep = (over: Partial<ExecutionManifest['steps'][string]>, label?: string): ExecutionManifest => {
  const m = approved();
  m.steps.s1 = { ...m.steps.s1, ...over };
  if (label) m.modelLabel = label;
  return m;
};

const priced = (inRate: number, out: number) => ({ kind: 'priced' as const, rates: { in: inRate, out } });

let root: string; let home: NativeHome; let journal: PlanJournal; let events: PlanEvent[];
let manifest: ExecutionManifest; let ids: number;
let clock: number;
let executor: { start: Mock<PlanExecutorHooks['start']>; stop: Mock<PlanExecutorHooks['stop']> };
let service: PlanService;

function makeService(overrides: Partial<PlanServiceDeps> = {}): PlanService {
  return new PlanService({
    journal, home, now: () => clock,
    sessionCwd: (sessionId) => (sessionId === SID ? '/proj' : undefined),
    resolveManifest: async () => structuredClone(manifest),
    queueCommentTurn: async () => {},
    executor,
    newId: () => `id${++ids}`,
    ...overrides,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-tier-'));
  home = new NativeHome(root); events = []; clock = 5000;
  journal = new PlanJournal({ home, now: () => 5000, onEvent: (e) => events.push(e) });
  manifest = approved(); ids = 0;
  executor = {
    start: vi.fn<PlanExecutorHooks['start']>(),
    stop: vi.fn<PlanExecutorHooks['stop']>(async ({ ref, planId }) => {
      const plan = await journal.get(ref, planId);
      if (plan?.lease) await journal.releaseLease(ref, planId, plan.lease.fence);
    }),
  };
  service = makeService();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

async function propose(document: PlanDocumentV1 = doc()) {
  return service.propose({
    sessionId: SID, toolUseId: 'tool-1', document, maximumAttempts: 2, maxFanOut: 2,
    signal: new AbortController().signal, commit: () => true,
  });
}

/** Park the plan where a real pause leaves it: no lease, waiting for Continue —
 *  the state Destin was in when he changed his tiers. */
async function park(): Promise<void> {
  await journal.mutate(REF, (file) => {
    const p = file.plans[0];
    p.status = 'paused';
    delete p.lease;
    p.paused = { stepId: 's1', reason: 'the specialist could not start', kind: 'launch-failed', launch: 'not-ready' };
  });
  executor.start.mockClear();
  events = [];
}

/** Approve, then park it. */
async function proposeAndPause(document?: PlanDocumentV1): Promise<string> {
  const view = await propose(document);
  const r = await service.approve(SID, view.planId);
  if (!r.ok) throw new Error(`approve failed: ${JSON.stringify(r)}`);
  await park();
  return view.planId;
}

describe('a specialist tier change is a clean, silent resume (design §5)', () => {
  it('Continue after a switch to a different model runs at once, re-freezes in the SAME write as the status change, and recomputes the estimate', async () => {
    const planId = await proposeAndPause();
    const before = (await journal.get(REF, planId))!.estimate;
    // The fix Destin made: the roster now points at an OpenRouter model.
    manifest = withReviewerStep({ binding: { providerId: 'openrouter', modelId: 'cheap' }, label: 'cheap', pricing: priced(1, 2) }, 'Cheap model');
    const r = await service.resume(SID, planId);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    // No notice, no extra click — decision 34 removed the ceiling there was ever a question about.
    expect(r.plan.status).toBe('running');
    // One journal write: the card moved to running AND carries the new manifest.
    expect(events).toHaveLength(1);
    expect(events[0].plan.status).toBe('running');
    const rec = (await journal.get(REF, planId))!;
    expect(rec.status).toBe('running');
    expect(rec.manifest.steps.s1).toEqual(manifest.steps.s1);
    expect(rec.manifest.modelLabel).toBe('Cheap model');
    // T5: the estimate is recomputed against the NEW frozen price, not left stale.
    expect(rec.estimate).not.toEqual(before);
    expect(executor.start).toHaveBeenCalledTimes(1);
  });

  it('Approve on a proposed plan follows the same rule', async () => {
    const view = await propose();
    manifest = withReviewerStep({ pricing: priced(10, 40) });
    const r = await service.approve(SID, view.planId);
    expect(r.ok).toBe(true);
    const rec = (await journal.get(REF, view.planId))!;
    expect(rec.status).toBe('running');
    expect(rec.manifest.steps.s1.pricing).toEqual(priced(10, 40));
  });

  it('a NOT-STARTED step re-freezes to the new binding; an ALREADY-STARTED one keeps its frozen entry', async () => {
    const twoStep: PlanDocumentV1 = {
      goal: 'g', steps: [
        { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Review {item}', summary: 'Plain sentence.', items: ['a'] },
        { id: 's2', kind: 'map', specialist: 'reviewer', task: 'Review {item} too', summary: 'Plain sentence.', items: ['a'] },
      ],
    };
    manifest = {
      ...approved(),
      steps: { ...approved().steps, s2: { ...approved().steps.s1 } },
    };
    const planId = await proposeAndPause(twoStep);
    const frozen = (await journal.get(REF, planId))!.manifest;
    // s1 already launched a specialist (an attempt exists); s2 never did.
    await journal.mutate(REF, (file) => {
      file.plans[0].steps.find((s) => s.id === 's1')!.attempts.push({
        attemptId: 'a1', itemIndex: 0, iteration: 0, spentTokens: 100, phase: 'launched',
      });
    });
    manifest = {
      ...manifest,
      steps: {
        s1: { binding: { providerId: 'openrouter', modelId: 'new-model' }, label: 'new-model', pricing: priced(1, 2), source: 'default' },
        s2: { binding: { providerId: 'openrouter', modelId: 'new-model' }, label: 'new-model', pricing: priced(1, 2), source: 'default' },
      },
    };
    const r = await service.resume(SID, planId);
    expect(r.ok).toBe(true);
    const rec = (await journal.get(REF, planId))!;
    // s1 (started) kept exactly what it was approved on.
    expect(rec.manifest.steps.s1).toEqual(frozen.steps.s1);
    // s2 (never started) took the new binding.
    expect(rec.manifest.steps.s2).toEqual(manifest.steps.s2);
  });

  it("passes the plan's own stepModels overrides into resolveManifest so a Plan-settings choice survives a re-freeze", async () => {
    const planId = await proposeAndPause();
    await journal.mutate(REF, (file) => { file.plans[0].stepModels = { s1: { providerId: 'openrouter', modelId: 'picked' } }; });
    const seenStepModels: unknown[] = [];
    const spied = makeService({
      resolveManifest: async (input) => { seenStepModels.push(input.stepModels); return structuredClone(manifest); },
    });
    await spied.resume(SID, planId);
    expect(seenStepModels).toEqual([{ s1: { providerId: 'openrouter', modelId: 'picked' } }]);
  });

  it('instructions/tools drift and permission drift still refuse in today\'s exact words', async () => {
    const planId = await proposeAndPause();
    manifest = { ...approved(), specialists: { reviewer: { definitionFingerprint: 'def-2' } } };
    expect(await service.resume(SID, planId)).toEqual({
      ok: false,
      error: "This plan can't run as approved because a specialist's instructions or tools changed since it was proposed. Ask the assistant to propose it again.",
    });
    manifest = { ...approved(), permissionFingerprint: 'perm-2' };
    expect(await service.resume(SID, planId)).toEqual({
      ok: false,
      error: "This plan can't run as approved because the permission settings changed since it was proposed. Ask the assistant to propose it again.",
    });
    expect(executor.start).not.toHaveBeenCalled();
  });

  // Decision 27, Destin's own case: the plan paused because its ChatGPT
  // specialist was signed out; he re-pointed his tiers at OpenRouter models.
  it('the real bug: a plan paused on a signed-out ChatGPT specialist continues after the tiers move to OpenRouter', async () => {
    const planId = await proposeAndPause();
    manifest = withReviewerStep({ binding: { providerId: 'openrouter', modelId: 'qwen3-coder' }, pricing: priced(0.3, 1.2) }, 'Qwen3 Coder');
    const r = await service.resume(SID, planId);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.plan.model.label).toBe('Qwen3 Coder');
    expect(JSON.stringify(r)).not.toMatch(/propose it again/i);
  });

  // Review finding 6 / decision 26: the owner's exact starting state. The plan
  // paused because ChatGPT was signed out; Continue while it still is must keep
  // the provider's own sentence and never claim a plan was being created.
  it('a plan paused on a provider that is not signed in says so, then continues once the tiers move', async () => {
    const planId = await proposeAndPause();
    const signedOut = makeService({
      resolveManifest: async () => {
        throw new PlanSpecialistsNotReadyError([
          { id: 'reviewer', label: 'ChatGPT', message: 'Sign in with ChatGPT in Settings → Model Providers to use this model.' },
        ]);
      },
    });
    expect(await signedOut.resume(SID, planId)).toEqual({
      ok: false,
      error: 'The "reviewer" specialist can\'t run right now: Sign in with ChatGPT in Settings → Model Providers to use this model. The plan can\'t start yet.',
    });
    expect(executor.start).not.toHaveBeenCalled();
    // He re-points his tiers at OpenRouter; the same Continue is the fix.
    manifest = withReviewerStep({ binding: { providerId: 'openrouter', modelId: 'qwen3-coder' }, pricing: priced(0.3, 1.2) }, 'Qwen3 Coder');
    const r = await service.resume(SID, planId);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.plan.status).toBe('running');
  });

  it('an unchanged manifest is a no-op re-freeze: nothing new is written', async () => {
    const planId = await proposeAndPause();
    const before = (await journal.get(REF, planId))!;
    const r = await service.resume(SID, planId);
    expect(r.ok).toBe(true);
    const rec = (await journal.get(REF, planId))!;
    expect(rec.manifest).toEqual(before.manifest);
    expect(rec.estimate).toEqual(before.estimate);
  });
});
