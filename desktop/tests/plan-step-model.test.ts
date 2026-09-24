// Specialists plans, spending rework T4 — PlanService.setStepModel (design
// §5) against a REAL PlanHostBridge (journal + service + resolveManifest +
// resolveStep + estimateFor, wired exactly as main constructs them), not a
// bare PlanService with hand-built manifests. T5 review H1's own concern —
// "does propose/refreeze/setStepModel actually store a populated `estimate`
// through the REAL service wiring, or just the pure math?" — is exercised
// here as a side effect of testing setStepModel end to end: every plan built
// below goes through the bridge's own `resolveManifest`/`estimateFor`, the
// same call chain `PlanHostBridge`'s constructor wires in the app.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { PlanHostBridge, type PlanHostPort, type PlanRoute } from '../src/main/harness/plans/plan-host-bridge';
import { BUILTIN_ROSTER } from '../src/main/harness/specialists/registry';
import { DelegatedModels } from '../src/main/harness/specialists/delegated-models';
import { CLOUD_DEFAULT } from '../src/main/harness/capability-profile';
import type { PlanDocumentV1 } from '../src/main/harness/plans/schema';
import type { TranscriptEvent } from '../src/shared/types';
import type { ProviderReadiness } from '../src/shared/provider-types';
import type { SpecialistUsageSnapshot } from '../src/main/harness/plans/specialist-usage-history';

const SID = 'root';
const REF = { cwd: '/proj', sessionId: SID };
const TWO_STEP_DOC: PlanDocumentV1 = { goal: 'g', steps: [
  { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Review {item}', summary: 'Plain sentence.', items: ['a'] },
  { id: 's2', kind: 'map', specialist: 'reviewer', task: 'Review {item} too', summary: 'Plain sentence.', items: ['a'] },
] };

let root: string; let home: NativeHome; let routeType: PlanRoute['providerType'];
let catalog: Array<{ id: string; providerId: string; label: string }>;
let readiness: ProviderReadiness;
let history: SpecialistUsageSnapshot;
let bridge: PlanHostBridge;

function port(): PlanHostPort {
  return {
    home,
    emit: () => {},
    rootCwd: (id) => (id === SID ? '/proj' : undefined),
    parentBinding: () => ({ providerId: 'openrouter', modelId: 'parent' }),
    permissionState: () => ({ preset: 'coder', mode: 'ask' }),
    roster: () => BUILTIN_ROSTER,
    designated: new DelegatedModels(home),
    catalog: async () => catalog,
    resolveRoute: async (binding) => ({
      providerType: routeType, profile: CLOUD_DEFAULT,
      pricing: { in: binding.modelId.includes('costly') ? 20 : 1, out: binding.modelId.includes('costly') ? 80 : 2 },
      free: false, contextLength: 100_000, totalSlots: null,
    }),
    credentialReadiness: async () => readiness,
    maxConcurrent: () => 4,
    readChildEvents: (): TranscriptEvent[] => [],
    queueTurn: () => {},
    currentTurnId: () => undefined,
    noticeRefusal: () => undefined,
    planToolsAvailable: () => true,
    noticeWouldWait: () => false,
    queuePlanNotice: () => false,
    withdrawPlanNotice: () => false,
    startChild: async () => { throw new Error('not exercised in this test — no attempt is ever launched'); },
    specialistUsageHistory: { snapshot: () => history },
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-step-model-'));
  home = new NativeHome(root);
  routeType = 'openrouter';
  catalog = [
    { id: 'deepseek/deepseek-v4-flash-0731', providerId: 'openrouter', label: 'DS (default)' },
    { id: 'picked-model', providerId: 'openrouter', label: 'Picked (OpenRouter)' },
    { id: 'shared-id', providerId: 'openrouter', label: 'Shared (OpenRouter)' },
    { id: 'shared-id', providerId: 'chatgpt', label: 'Shared (ChatGPT)' },
    { id: 'costly-model', providerId: 'openrouter', label: 'Costly' },
  ];
  readiness = { ok: true };
  history = { entries: [] };
  bridge = new PlanHostBridge(port());
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));

async function propose(document: PlanDocumentV1 = TWO_STEP_DOC): Promise<string> {
  const view = await bridge.propose(SID, {
    sessionId: SID, toolUseId: 'tool-1', document, maximumAttempts: 2, maxFanOut: 2, signal: new AbortController().signal, commit: () => true,
  });
  return view.planId;
}

describe('setStepModel — override', () => {
  it('sets a per-step override, re-resolves that step\'s manifest entry, and recomputes the estimate (H1: through the real service wiring)', async () => {
    const planId = await propose();
    const before = (await bridge.journal.get(REF, planId))!;
    expect(before.estimate).toBeDefined(); // populated at propose, not just computed in isolation
    const beforeStepModels = before.stepModels;
    expect(beforeStepModels?.s1).toBeUndefined();

    const res = await bridge.setStepModel(SID, planId, 's1', { providerId: 'openrouter', modelId: 'picked-model' });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    const s1 = res.plan.steps.find((s) => s.id === 's1')!;
    expect(s1.stepModel).toMatchObject({ isDefault: false, providerId: 'openrouter', modelId: 'picked-model', label: 'Picked (OpenRouter)' });
    // s2 is untouched — one step's override never disturbs a sibling's.
    const s2 = res.plan.steps.find((s) => s.id === 's2')!;
    expect(s2.stepModel?.isDefault).toBe(true);

    const rec = (await bridge.journal.get(REF, planId))!;
    expect(rec.stepModels).toEqual({ s1: { providerId: 'openrouter', modelId: 'picked-model' } });
    expect(rec.manifest.steps.s1).toMatchObject({ binding: { providerId: 'openrouter', modelId: 'picked-model' }, source: 'user' });
    // The manifest's OTHER step and the specialists map are untouched.
    expect(rec.manifest.steps.s2).toEqual(before.manifest.steps.s2);
    expect(rec.manifest.specialists).toEqual(before.manifest.specialists);
  });

  it('recomputes the estimate to reflect the new binding\'s price (H1)', async () => {
    const planId = await propose({ goal: 'g', steps: [{ id: 's1', kind: 'map', specialist: 'reviewer', task: 't', summary: 's', items: ['a'] }] });
    const before = (await bridge.journal.get(REF, planId))!.estimate;
    const res = await bridge.setStepModel(SID, planId, 's1', { providerId: 'openrouter', modelId: 'costly-model' });
    expect(res.ok).toBe(true);
    const after = (await bridge.journal.get(REF, planId))!.estimate;
    expect(after).not.toEqual(before);
    if (after && 'lowUsd' in after && before && 'lowUsd' in before) expect(after.lowUsd).toBeGreaterThan(before.lowUsd);
  });

  it('clearing an override (null) falls back to the document/specialist default', async () => {
    const planId = await propose();
    await bridge.setStepModel(SID, planId, 's1', { providerId: 'openrouter', modelId: 'picked-model' });
    const cleared = await bridge.setStepModel(SID, planId, 's1', null);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) throw new Error('unreachable');
    expect(cleared.plan.steps.find((s) => s.id === 's1')!.stepModel?.isDefault).toBe(true);
    const rec = (await bridge.journal.get(REF, planId))!;
    expect(rec.stepModels).toBeUndefined();
    expect(rec.manifest.steps.s1.source).toBe('default');
  });
});

describe('setStepModel — lock after start', () => {
  it('refuses a step with ≥1 attempt, and never touches the journal', async () => {
    const planId = await propose();
    const before = (await bridge.journal.get(REF, planId))!;
    await bridge.journal.mutate(REF, (file) => {
      file.plans[0].steps.find((s) => s.id === 's1')!.attempts.push({ attemptId: 'a1', itemIndex: 0, iteration: 0, spentTokens: 10, phase: 'launched' });
    });
    const res = await bridge.setStepModel(SID, planId, 's1', { providerId: 'openrouter', modelId: 'picked-model' });
    expect(res).toEqual({ ok: false, error: "This specialist has already started, so its model can't be changed." });
    const after = (await bridge.journal.get(REF, planId))!;
    expect(after.manifest.steps.s1).toEqual(before.manifest.steps.s1);
    expect(after.stepModels).toBeUndefined();
  });

  it('a step with a report-only retry (also ≥1 attempt) is just as locked', async () => {
    const planId = await propose();
    await bridge.journal.mutate(REF, (file) => {
      file.plans[0].steps.find((s) => s.id === 's2')!.attempts.push({ attemptId: 'a1', itemIndex: 0, iteration: 0, spentTokens: 10, phase: 'committed', terminal: 'failed' });
    });
    const res = await bridge.setStepModel(SID, planId, 's2', null);
    expect(res).toMatchObject({ ok: false, error: "This specialist has already started, so its model can't be changed." });
  });
});

describe('setStepModel — change while running, on a pending step', () => {
  it('is allowed: a running plan may still have steps that have not started', async () => {
    const planId = await propose();
    // Simulate "running" directly (no real executor is exercised here — this
    // test is about setStepModel's own status gate, not the executor).
    await bridge.journal.mutate(REF, (file) => { file.plans[0].status = 'running'; });
    const res = await bridge.setStepModel(SID, planId, 's2', { providerId: 'openrouter', modelId: 'picked-model' });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.plan.status).toBe('running');
    expect(res.plan.steps.find((s) => s.id === 's2')!.stepModel).toMatchObject({ providerId: 'openrouter', modelId: 'picked-model' });
  });

  it('is refused for a step that already started, even while the plan runs', async () => {
    const planId = await propose();
    await bridge.journal.mutate(REF, (file) => {
      file.plans[0].status = 'running';
      file.plans[0].steps.find((s) => s.id === 's1')!.attempts.push({ attemptId: 'a1', itemIndex: 0, iteration: 0, spentTokens: 10, phase: 'launched' });
    });
    const res = await bridge.setStepModel(SID, planId, 's1', { providerId: 'openrouter', modelId: 'picked-model' });
    expect(res).toMatchObject({ ok: false, error: "This specialist has already started, so its model can't be changed." });
  });
});

describe('setStepModel — providerId disambiguation', () => {
  it('resolves a model id offered by two providers using the given providerId', async () => {
    const planId = await propose();
    const a = await bridge.setStepModel(SID, planId, 's1', { providerId: 'openrouter', modelId: 'shared-id' });
    expect(a.ok).toBe(true);
    if (!a.ok) throw new Error('unreachable');
    expect(a.plan.steps.find((s) => s.id === 's1')!.stepModel).toMatchObject({ providerId: 'openrouter', modelId: 'shared-id', label: 'Shared (OpenRouter)' });
    const b = await bridge.setStepModel(SID, planId, 's2', { providerId: 'chatgpt', modelId: 'shared-id' });
    expect(b.ok).toBe(true);
    if (!b.ok) throw new Error('unreachable');
    expect(b.plan.steps.find((s) => s.id === 's2')!.stepModel).toMatchObject({ providerId: 'chatgpt', modelId: 'shared-id', label: 'Shared (ChatGPT)' });
  });
});

describe('setStepModel — refusal wording from the resolver/provider', () => {
  it('a model the catalog no longer confirms is refused with the resolver\'s own sentence', async () => {
    const planId = await propose();
    const res = await bridge.setStepModel(SID, planId, 's1', { providerId: 'openrouter', modelId: 'retired-model' });
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('"retired-model" is not an available model') });
  });

  it('a provider that is not ready is refused with the provider\'s own sentence, never invented', async () => {
    const planId = await propose();
    readiness = { ok: false, message: 'Sign in with ChatGPT in Settings → Model Providers to use this model.', label: 'ChatGPT Plan' };
    const res = await bridge.setStepModel(SID, planId, 's1', { providerId: 'openrouter', modelId: 'picked-model' });
    expect(res).toEqual({ ok: false, error: 'Sign in with ChatGPT in Settings → Model Providers to use this model.' });
  });

  it('an unknown leaf step is refused plainly', async () => {
    const planId = await propose();
    const res = await bridge.setStepModel(SID, planId, 'ghost', null);
    expect(res).toEqual({ ok: false, error: 'This plan has no such step.' });
  });

  it('an unknown plan is refused plainly', async () => {
    const res = await bridge.setStepModel(SID, 'plan_ghost', 's1', null);
    expect(res).toEqual({ ok: false, error: 'This plan no longer exists.' });
  });
});
