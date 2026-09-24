// Specialists plans, Task 4 (spending rework T4) — the plan-specific host
// decisions (plan-host-bridge.ts) against a fake host port: which model a
// plan specialist runs on (per LEAF STEP now — design §5), what is frozen
// into the manifest, and when a launch is refused. The old per-request
// budget-adapter measurement (setup probe, minimum Add budget, soft-route
// overshoot) is gone with the reservation system it belonged to — see this
// file's own WHY comments for what each deleted describe block used to
// cover and why nothing here replaces it 1:1.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { PlanHostBridge, definitionFingerprint, type PlanHostPort, type PlanRoute } from '../src/main/harness/plans/plan-host-bridge';
import { BUILTIN_ROSTER, resolveSpecialist } from '../src/main/harness/specialists/registry';
import { DelegatedModels } from '../src/main/harness/specialists/delegated-models';
import { CLOUD_DEFAULT } from '../src/main/harness/capability-profile';
import type { PlanDocumentV1 } from '../src/main/harness/plans/schema';
import { PlanLaunchDriftError, PlanLaunchRefusedError, PlanNotReadyError } from '../src/main/harness/plans/plan-executor';
import { PlanSpecialistsNotReadyError, type ExecutionManifest, type PlanRecord } from '../src/main/harness/plans/types';
import { PLAN_PAUSE_KINDS } from '../src/shared/types';
import type { TranscriptEvent } from '../src/shared/types';
import type { ProviderReadiness } from '../src/shared/provider-types';

const SID = 'root';
// Task 13: the provider registry's own sentence, verbatim — never reworded here.
const SIGN_IN = 'Sign in with ChatGPT in Settings → Model Providers to use this model.';
const DOC: PlanDocumentV1 = { goal: 'g', steps: [
  { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Review {item}', summary: 'Plain sentence.', items: ['a'] },
] };

let root: string; let home: NativeHome; let routeType: PlanRoute['providerType']; let mode: string;
let parentBinding = { providerId: 'openrouter', modelId: 'parent' };
let catalog: Array<{ id: string; providerId: string; label: string }> = [
  { id: 'deepseek/deepseek-v4-flash-0731', providerId: 'openrouter', label: 'DS' },
  { id: 'gpt-5.6-terra', providerId: 'chatgpt', label: 'Terra' },
];
let childEvents: TranscriptEvent[] = [];
// Task 13 (decision 25): what the provider registry says about the binding's
// credentials. Ready unless a test says otherwise.
let readiness: ProviderReadiness = { ok: true };
let readinessAsked: string[] = [];

function port(): PlanHostPort {
  return {
    home,
    emit: () => {},
    rootCwd: (id) => (id === SID ? '/proj' : undefined),
    parentBinding: () => parentBinding,
    permissionState: () => ({ preset: 'coder', mode }),
    roster: () => BUILTIN_ROSTER,
    designated: new DelegatedModels(home),
    catalog: async () => catalog,
    // WHY `free`/`pricing` follow `routeType` (T4 rewrite): the old fake
    // always returned the same priced route no matter the provider, which
    // fit the deleted "soft ChatGPT route" concept but tests nothing real
    // now — a ChatGPT-routed specialist's pricing snapshot is the thing
    // worth pinning (`pricingSnapshot`'s own `free`/`isFreePricing` check).
    resolveRoute: async () => ({
      providerType: routeType, profile: CLOUD_DEFAULT,
      pricing: routeType === 'chatgpt' ? null : { in: 1, out: 2 },
      free: routeType === 'chatgpt', contextLength: 100_000, totalSlots: null,
    }),
    credentialReadiness: async (binding) => { readinessAsked.push(binding.modelId); return readiness; },
    maxConcurrent: () => 4,
    readChildEvents: () => childEvents,
    queueTurn: () => {},
    currentTurnId: () => undefined,
    // Task 11: only the "Ask the assistant" tests below queue a notice.
    noticeRefusal: () => undefined,
    planToolsAvailable: () => true,
    noticeWouldWait: () => false,
    queuePlanNotice: () => false,
    withdrawPlanNotice: () => false,
    startChild: async () => { throw new Error('not in this test'); },
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-bridge-'));
  home = new NativeHome(root);
  routeType = 'openrouter'; mode = 'ask'; childEvents = [];
  readiness = { ok: true }; readinessAsked = [];
  parentBinding = { providerId: 'openrouter', modelId: 'parent' };
  catalog = [
    { id: 'deepseek/deepseek-v4-flash-0731', providerId: 'openrouter', label: 'DS' },
    { id: 'gpt-5.6-terra', providerId: 'chatgpt', label: 'Terra' },
  ];
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));

describe('the frozen manifest — per-leaf-step resolution (design §5)', () => {
  it('uses the automatic specialist default and freezes the CATALOG label, not the bare id', async () => {
    const m = await new PlanHostBridge(port()).resolveManifest({ sessionId: SID, cwd: '/proj', document: DOC });
    expect(m.specialists.reviewer).toEqual({ definitionFingerprint: definitionFingerprint(resolveSpecialist('reviewer')!) });
    expect(m.steps.s1).toEqual({
      binding: { providerId: 'openrouter', modelId: 'deepseek/deepseek-v4-flash-0731' },
      label: 'DS',
      pricing: { kind: 'priced', rates: { in: 1, out: 2 } },
      source: 'default',
    });
    expect(m.modelLabel).toBe('deepseek/deepseek-v4-flash-0731');
  });

  it('a ChatGPT specialist freezes a free pricing snapshot, not a priced one', async () => {
    parentBinding = { providerId: 'chatgpt', modelId: 'gpt-parent' };
    routeType = 'chatgpt';
    const m = await new PlanHostBridge(port()).resolveManifest({ sessionId: SID, cwd: '/proj', document: DOC });
    expect(m.steps.s1).toMatchObject({ binding: { providerId: 'chatgpt', modelId: 'gpt-5.6-terra' }, pricing: { kind: 'free' } });
  });

  it('the document\'s own step `model` wins over the specialist default, and falls back to it when absent', async () => {
    const withModel: PlanDocumentV1 = { goal: 'g', steps: [{ ...DOC.steps[0], model: 'gpt-5.6-terra' }] };
    const m = await new PlanHostBridge(port()).resolveManifest({ sessionId: SID, cwd: '/proj', document: withModel });
    expect(m.steps.s1).toMatchObject({ binding: { providerId: 'chatgpt', modelId: 'gpt-5.6-terra' }, source: 'document' });
    const noModel = await new PlanHostBridge(port()).resolveManifest({ sessionId: SID, cwd: '/proj', document: DOC });
    expect(noModel.steps.s1.source).toBe('default');
  });

  it('a `stepModels` user override wins over both the document\'s model and the default', async () => {
    const withModel: PlanDocumentV1 = { goal: 'g', steps: [{ ...DOC.steps[0], model: 'gpt-5.6-terra' }] };
    const m = await new PlanHostBridge(port()).resolveManifest({
      sessionId: SID, cwd: '/proj', document: withModel,
      stepModels: { s1: { providerId: 'openrouter', modelId: 'deepseek/deepseek-v4-flash-0731' } },
    });
    expect(m.steps.s1).toMatchObject({ binding: { providerId: 'openrouter', modelId: 'deepseek/deepseek-v4-flash-0731' }, source: 'user' });
  });

  it('T4: providerId disambiguates a model id offered by two providers — a bare document `model` refuses instead', async () => {
    catalog = [
      { id: 'shared-id', providerId: 'openrouter', label: 'Shared (OpenRouter)' },
      { id: 'shared-id', providerId: 'chatgpt', label: 'Shared (ChatGPT)' },
    ];
    const withModel: PlanDocumentV1 = { goal: 'g', steps: [{ ...DOC.steps[0], model: 'shared-id' }] };
    // No providerId to disambiguate: the document's own `model` is a bare
    // string, so this refuses exactly like an assistant-typed ambiguous id.
    await expect(new PlanHostBridge(port()).resolveManifest({ sessionId: SID, cwd: '/proj', document: withModel }))
      .rejects.toThrow(/available from multiple providers/);
    // A `stepModels` override carries its own providerId, so it resolves cleanly.
    const m = await new PlanHostBridge(port()).resolveManifest({
      sessionId: SID, cwd: '/proj', document: DOC,
      stepModels: { s1: { providerId: 'chatgpt', modelId: 'shared-id' } },
    });
    expect(m.steps.s1).toMatchObject({ binding: { providerId: 'chatgpt', modelId: 'shared-id' }, label: 'Shared (ChatGPT)' });
  });

  it('a stepModels override the catalog no longer confirms refuses with the resolver\'s own sentence', async () => {
    await expect(new PlanHostBridge(port()).resolveManifest({
      sessionId: SID, cwd: '/proj', document: DOC,
      stepModels: { s1: { providerId: 'openrouter', modelId: 'retired-model' } },
    })).rejects.toThrow(/"retired-model" is not an available model/);
  });

  it('refuses with a readable reason when no safe specialist model can be confirmed', async () => {
    catalog = [];
    await expect(new PlanHostBridge(port()).resolveManifest({ sessionId: SID, cwd: '/proj', document: DOC }))
      .rejects.toThrow('couldn\'t confirm a budget model for the "reviewer" specialist');
  });

  // Task 13 (decision 25), the whole reason for this task: Destin's tiers
  // resolved to ChatGPT models while he was signed out, the app proposed the
  // plan anyway, and it only died after he approved it.
  it('refuses to propose when a specialist\'s provider is not ready, repeating the provider\'s own sentence', async () => {
    const p = port();
    parentBinding = { providerId: 'chatgpt', modelId: 'gpt-parent' };
    routeType = 'chatgpt';
    readiness = { ok: false, message: SIGN_IN, label: 'ChatGPT Plan' };
    // Review finding 2: the sentence carries NO ending about what happened to
    // the plan — each caller adds its own, because Approve and Continue act on
    // a plan that plainly exists.
    const err = await new PlanHostBridge(p).resolveManifest({ sessionId: SID, cwd: '/proj', document: DOC }).catch((e) => e);
    expect(err).toBeInstanceOf(PlanSpecialistsNotReadyError);
    expect((err as Error).message).toBe(`The "reviewer" specialist can't run right now: ${SIGN_IN}`);
    expect((err as PlanSpecialistsNotReadyError).specialists).toEqual([{ id: 'reviewer', label: 'ChatGPT Plan', message: SIGN_IN }]);
    // The check ran on the RESOLVED specialist model, not the parent's.
    expect(readinessAsked).toEqual(['gpt-5.6-terra']);
  });

  it('names every specialist that cannot run, so one trip to Settings fixes them all', async () => {
    // Review finding 9: throwing inside the loop named only the first one, so
    // the person fixed it, asked again and was refused for the second.
    const two: PlanDocumentV1 = { goal: 'g', steps: [
      { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Review {item}', summary: 'Plain sentence.', items: ['a'] },
      { id: 's2', kind: 'map', specialist: 'worker', task: 'Fix {item}', summary: 'Plain sentence.', items: ['a'] },
    ] };
    readiness = { ok: false, message: SIGN_IN, label: 'ChatGPT Plan' };
    await expect(new PlanHostBridge(port()).resolveManifest({ sessionId: SID, cwd: '/proj', document: two }))
      .rejects.toThrow(`The "reviewer" and "worker" specialists can't run right now: ${SIGN_IN}`);
  });

  it('T4: two leaf steps of the SAME specialist, both not ready with the same message, are named once — not twice', async () => {
    const two: PlanDocumentV1 = { goal: 'g', steps: [
      { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Review {item}', summary: 'Plain sentence.', items: ['a'] },
      { id: 's2', kind: 'map', specialist: 'reviewer', task: 'Review {item} too', summary: 'Plain sentence.', items: ['a'] },
    ] };
    readiness = { ok: false, message: SIGN_IN, label: 'ChatGPT Plan' };
    const err = await new PlanHostBridge(port()).resolveManifest({ sessionId: SID, cwd: '/proj', document: two }).catch((e) => e);
    expect((err as PlanSpecialistsNotReadyError).specialists).toEqual([{ id: 'reviewer', label: 'ChatGPT Plan', message: SIGN_IN }]);
  });

  it('gives each different provider problem its own sentence', () => {
    const key = 'My OpenAI needs an API key — add one in Settings → Providers.';
    expect(new PlanSpecialistsNotReadyError([
      { id: 'reviewer', label: 'ChatGPT Plan', message: SIGN_IN },
      { id: 'worker', label: 'My OpenAI', message: key },
      { id: 'explorer', label: 'ChatGPT Plan', message: SIGN_IN },
    ]).message).toBe(
      `The "reviewer" and "explorer" specialists can't run right now: ${SIGN_IN}`
      + ` The "worker" specialist can't run right now: ${key}`,
    );
    expect(new PlanSpecialistsNotReadyError([
      { id: 'a', label: 'L', message: 'M' }, { id: 'b', label: 'L', message: 'M' }, { id: 'c', label: 'L', message: 'M' },
    ]).message).toBe('The "a", "b" and "c" specialists can\'t run right now: M');
  });

  it('the permission fingerprint follows the conversation\'s mode; the definition fingerprint follows its tools', async () => {
    const bridge = new PlanHostBridge(port());
    const a = await bridge.resolveManifest({ sessionId: SID, cwd: '/proj', document: DOC });
    mode = 'full-auto';
    const b = await bridge.resolveManifest({ sessionId: SID, cwd: '/proj', document: DOC });
    expect(a.permissionFingerprint).not.toBe(b.permissionFingerprint);
    const def = resolveSpecialist('reviewer')!;
    expect(definitionFingerprint({ ...def, allowedTools: [...def.allowedTools, 'Bash'] })).not.toBe(definitionFingerprint(def));
  });
});

// T4 (design §5): `PlanService.setStepModel`'s own resolver — behavior
// beyond what `plan-step-model.test.ts` covers through the real service is
// exercised here directly, against the bridge.
describe('resolveStep — the single-leaf resolver behind setStepModel', () => {
  it('resolves one leaf without needing the OTHER leaves\' specialists to be ready', async () => {
    const two: PlanDocumentV1 = { goal: 'g', steps: [
      { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Review {item}', summary: 'Plain sentence.', items: ['a'] },
      { id: 's2', kind: 'map', specialist: 'worker', task: 'Fix {item}', summary: 'Plain sentence.', items: ['a'] },
    ] };
    const p = port();
    p.credentialReadiness = async (binding) => (binding.modelId.includes('deepseek') ? { ok: false, message: 'nope', label: 'X' } : { ok: true });
    const bridge = new PlanHostBridge(p);
    // s2's specialist (worker) resolves to the SAME not-ready model as s1's
    // default — but changing s1 to an explicit, ready override must still
    // succeed: this call names only s1.
    const entry = await bridge.resolveStep({
      sessionId: SID, cwd: '/proj', document: two, stepId: 's1', override: { providerId: 'chatgpt', modelId: 'gpt-5.6-terra' },
    });
    expect(entry).toMatchObject({ binding: { providerId: 'chatgpt', modelId: 'gpt-5.6-terra' }, source: 'user' });
  });

  it('a provider that is not ready is the plain provider sentence, never "the plan wasn\'t created"', async () => {
    readiness = { ok: false, message: SIGN_IN, label: 'ChatGPT Plan' };
    const bridge = new PlanHostBridge(port());
    await expect(bridge.resolveStep({ sessionId: SID, cwd: '/proj', document: DOC, stepId: 's1', override: { providerId: 'chatgpt', modelId: 'gpt-5.6-terra' } }))
      .rejects.toThrow(SIGN_IN);
  });

  it('clearing the override (no `override`) falls back to the document/default, same order as resolveManifest', async () => {
    const withModel: PlanDocumentV1 = { goal: 'g', steps: [{ ...DOC.steps[0], model: 'gpt-5.6-terra' }] };
    const bridge = new PlanHostBridge(port());
    const entry = await bridge.resolveStep({ sessionId: SID, cwd: '/proj', document: withModel, stepId: 's1' });
    expect(entry).toMatchObject({ binding: { providerId: 'chatgpt', modelId: 'gpt-5.6-terra' }, source: 'document' });
  });

  it('an unknown leaf refuses plainly', async () => {
    const bridge = new PlanHostBridge(port());
    await expect(bridge.resolveStep({ sessionId: SID, cwd: '/proj', document: DOC, stepId: 'ghost' })).rejects.toThrow('This plan has no such step.');
  });
});

const manifest = (over: Partial<ExecutionManifest> = {}): ExecutionManifest => ({
  modelLabel: 'm',
  specialists: { reviewer: { definitionFingerprint: 'd' } },
  steps: { s1: { binding: { providerId: 'chatgpt', modelId: 'm' }, label: 'm', pricing: null, source: 'default' } },
  permissionFingerprint: 'x',
  ...over,
});

const pausedRecord = (over: Partial<PlanRecord> = {}): PlanRecord => ({
  planId: 'p1', toolUseId: 't', document: DOC, maximumAttempts: 1, maxFanOut: 1,
  usedTokens: 0, status: 'paused', seq: 3, createdAt: 1,
  manifest: manifest(),
  steps: [{ id: 's1', status: 'paused', attempts: [] }],
  fenceEpoch: 1,
  paused: { stepId: 's1', reason: 'a specialist paused' },
  ...over,
});
describe('review fix 6: starts that can never succeed are refusals', () => {
  const launchInput = (over: Record<string, unknown> = {}) => ({
    ref: { cwd: '/proj', sessionId: SID }, planId: 'p1', fence: 'f', stepId: 's1', attemptId: 'a1',
    itemIndex: 0, iteration: 0, specialist: 'reviewer', brief: 'b', signal: new AbortController().signal,
    recordChild: async () => {}, ...over,
  });
  const seedPlan = async (bridge: any, rec: PlanRecord) => {
    await bridge.journal.mutate({ cwd: '/proj', sessionId: SID }, (file: any) => { file.plans.push(rec); });
  };
  const withReviewer = (binding = { providerId: 'openrouter', modelId: 'm' }) => pausedRecord({
    manifest: manifest({
      specialists: { reviewer: { definitionFingerprint: definitionFingerprint(resolveSpecialist('reviewer')!) } },
      steps: { s1: { binding, label: binding.modelId, pricing: null, source: 'default' } },
    }),
  });

  it('no approved settings for the specialist → PlanLaunchRefusedError', async () => {
    const bridge = new PlanHostBridge(port()) as any;
    await seedPlan(bridge, withReviewer());
    await expect(bridge.launch(launchInput({ specialist: 'writer' }))).rejects.toBeInstanceOf(PlanLaunchRefusedError);
  });

  // Task 13 (decision 26): a provider that cannot run is NOT a refusal —
  // a refusal routes to Stop-only, and here Continue is exactly the fix.
  it('a provider that is not ready → PlanNotReadyError carrying its own sentence, never a refusal', async () => {
    const bridge = new PlanHostBridge(port()) as any;
    await seedPlan(bridge, withReviewer({ providerId: 'chatgpt', modelId: 'gpt-5.6-terra' }));
    readiness = { ok: false, message: SIGN_IN, label: 'ChatGPT Plan' };
    const err = await bridge.launch(launchInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanNotReadyError);
    expect(err).not.toBeInstanceOf(PlanLaunchRefusedError);
    expect(err).not.toBeInstanceOf(PlanLaunchDriftError);
    expect((err as Error).message).toBe(SIGN_IN);
    // The FROZEN per-STEP binding is what was checked, not the parent's.
    expect(readinessAsked).toEqual(['gpt-5.6-terra']);
  });

  it('the runner hook answers with the provider sentence, and undefined when it is ready', async () => {
    const bridge = new PlanHostBridge(port()) as any;
    const runner = bridge.runner();
    const plan = withReviewer();
    expect(await runner.providerNotReady({ cwd: '/proj', sessionId: SID }, plan, 'reviewer')).toBeUndefined();
    readiness = { ok: false, message: SIGN_IN, label: 'ChatGPT Plan' };
    expect(await runner.providerNotReady({ cwd: '/proj', sessionId: SID }, plan, 'reviewer')).toBe(SIGN_IN);
    // A specialist the document never names has no step to look the binding up from.
    expect(await runner.providerNotReady({ cwd: '/proj', sessionId: SID }, plan, 'writer')).toBeUndefined();
  });

  it('a changed definition stays a drift, not a refusal', async () => {
    const bridge = new PlanHostBridge(port()) as any;
    await seedPlan(bridge, pausedRecord());
    const err = await bridge.launch(launchInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanLaunchDriftError);
    expect(err).not.toBeInstanceOf(PlanLaunchRefusedError);
  });
});

// Task 11 (pause handoff §6, revision 4) — "Ask the assistant": the bridge's
// own decisions. Every rule here came from a review-4 finding.
describe('Ask the assistant', () => {
  const REF = { cwd: '/proj', sessionId: SID };
  const pausedPlan = (over: Partial<NonNullable<PlanRecord['paused']>> = {}): PlanRecord => pausedRecord({
    planId: 'p-h', usedTokens: 1000,
    paused: { stepId: 's1', reason: 'used it all', ...over },
  });
  type Notice = Parameters<PlanHostPort['queuePlanNotice']>[1];
  async function setup(over: Partial<PlanHostPort> = {}, opts: { handoffBackstopMs?: number } = {}) {
    const queued: Notice[] = [];
    const withdrawn: string[] = [];
    const emitted: any[] = [];
    const bridge = new PlanHostBridge({
      ...port(),
      emit: (e) => emitted.push(e),
      queuePlanNotice: (_s, n) => { queued.push(n); return true; },
      withdrawPlanNotice: (_s, id) => { withdrawn.push(id); return true; },
      ...over,
    }, opts);
    await bridge.journal.mutate(REF, (file) => { file.plans.push(pausedPlan()); });
    const handoff = async () => (await bridge.journal.get(REF, 'p-h'))!.paused?.handoff;
    return { bridge, queued, withdrawn, emitted, handoff };
  }

  // Final review F27 (R37): "a paused plan never hands itself to the
  // assistant". The card half is tests/plan-card-ask.test.tsx; this is the
  // engine half, for EVERY pause kind — reading the paused card, and the
  // recovery pass a restart runs over it, must queue nothing. The same test
  // then asks once, so a seam that stopped being wired cannot make the
  // negative vacuous.
  it('no pause kind hands itself over: nothing is queued until the user asks', async () => {
    for (const kind of PLAN_PAUSE_KINDS) {
      const t = await setup();
      await t.bridge.journal.mutate(REF, (file) => {
        file.plans[0].paused = { stepId: 's1', reason: `paused: ${kind}`, kind };
      });
      // What a paused plan really goes through with no user press: the card's
      // read, and the restart recovery pass.
      const views = await t.bridge.views(SID);
      expect(views[0], kind).toMatchObject({ status: 'paused' });
      await t.bridge.recover(SID, '/proj');
      expect(t.queued, `${kind} queued a notice by itself`).toEqual([]);
      expect(await t.handoff(), `${kind} recorded a handoff by itself`).toBeUndefined();
      expect((t.bridge as any).handoffs.size, kind).toBe(0);
      // The user presses Ask: this same wiring does queue exactly one notice.
      expect(await t.bridge.askAssistant(SID, 'p-h'), kind).toMatchObject({ ok: true });
      expect(t.queued, kind).toHaveLength(1);
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-bridge-'));
      home = new NativeHome(root);
    }
  });

  it('registers the handoff first, records it pending in the write, then queues the notice (§6, review 4-4)', async () => {
    const order: string[] = [];
    let bridge!: PlanHostBridge;
    const t = await setup({
      queuePlanNotice: (_s, n) => { order.push(`queue:${(bridge as any).handoffs.has(n.handoffId)}`); return true; },
    });
    bridge = t.bridge;
    const realMutate = bridge.journal.mutate.bind(bridge.journal);
    vi.spyOn(bridge.journal, 'mutate').mockImplementation(((ref: any, fn: any) => {
      order.push(`write:${(bridge as any).handoffs.size}`);
      return realMutate(ref, fn);
    }) as any);
    const res = await bridge.askAssistant(SID, 'p-h');
    expect(res).toMatchObject({ ok: true, plan: { paused: { handoff: { state: 'pending' } } } });
    expect(order).toEqual(['write:1', 'queue:true']);
    const h = (await t.handoff())!;
    expect(h).toMatchObject({ state: 'pending', id: expect.any(String), revisionTurnId: expect.any(String) });
    // The notice carries this handoff, its own turn, and the new wording.
    const bridgeQueued = (bridge as any).handoffs.get(h.id);
    expect(bridgeQueued.turnId).toBe(h.revisionTurnId);
    expect((bridge as any).noticeTurns.has(h.revisionTurnId)).toBe(true);
  });

  it('the notice it queues is the one the user asked for', async () => {
    const t = await setup();
    await t.bridge.askAssistant(SID, 'p-h');
    const h = (await t.handoff())!;
    expect(t.queued).toHaveLength(1);
    expect(t.queued[0]).toMatchObject({ planId: 'p-h', handoffId: h.id, turnId: h.revisionTurnId });
    expect(t.queued[0].text.startsWith('[Plan paused] The user asked you about this paused plan.')).toBe(true);
  });

  it('Decision 20: the typed question rides in the notice; an over-long one is refused before anything is held', async () => {
    const t = await setup();
    expect(await t.bridge.askAssistant(SID, 'p-h', 'x'.repeat(1001))).toEqual({ ok: false, error: 'Questions are limited to 1,000 characters.' });
    expect((t.bridge as any).handoffs.size).toBe(0);
    expect(t.queued).toHaveLength(0);
    expect(await t.bridge.askAssistant(SID, 'p-h', ' Can it finish with 5,000 more? ')).toMatchObject({ ok: true });
    expect(t.queued[0].text).toContain("The user's question (their own words):\n<user-question>\nCan it finish with 5,000 more?\n</user-question>");
  });

  it('a conversation that cannot take a notice refuses with the real reason, before any write (§6)', async () => {
    const t = await setup({ noticeRefusal: () => 'You stopped this conversation. Send the assistant a message, then ask again.' });
    const seq = (await t.bridge.journal.get(REF, 'p-h'))!.seq;
    expect(await t.bridge.askAssistant(SID, 'p-h')).toEqual({ ok: false, error: 'You stopped this conversation. Send the assistant a message, then ask again.' });
    expect((await t.bridge.journal.get(REF, 'p-h'))!.seq).toBe(seq);
    expect((t.bridge as any).handoffs.size).toBe(0);
    expect(t.queued).toHaveLength(0);
  });

  it('a model that cannot use tools is refused, and every card it is shown hides Ask (§6, review 4-9)', async () => {
    let tools: boolean | undefined = false;
    const t = await setup({ planToolsAvailable: () => tools });
    expect(await t.bridge.askAssistant(SID, 'p-h')).toEqual({ ok: false, error: "The model in this conversation can't use tools, so it can't look into the plan." });
    expect((await t.handoff())).toBeUndefined();
    // The flag rides every view main hands out: pushes, hydration, action answers.
    const stopped = await t.bridge.stop(SID, 'p-h');
    expect(stopped).toMatchObject({ ok: true });
    await t.bridge.journal.mutate(REF, (file) => { file.plans.push({ ...pausedPlan(), planId: 'p-2' }); });
    const pushed = t.emitted.filter((e) => e.plan.planId === 'p-2').pop();
    expect(pushed.plan.paused.askUnavailable).toBe(true);
    expect((await t.bridge.views(SID)).find((v) => v.planId === 'p-2')!.paused!.askUnavailable).toBe(true);
    // Another action answer (a no-op setStepModel, on this same still-paused
    // plan) — the flag rides it too, not just pushes and hydration.
    const answered = await t.bridge.setStepModel(SID, 'p-2', 's1', null);
    expect(answered).toMatchObject({ ok: true, plan: { paused: { askUnavailable: true } } });
    // Tools available, or not known (the conversation is not open here): Ask shows.
    tools = true;
    expect((await t.bridge.views(SID)).find((v) => v.planId === 'p-2')!.paused!.askUnavailable).toBeUndefined();
    tools = undefined;
    expect((await t.bridge.views(SID)).find((v) => v.planId === 'p-2')!.paused!.askUnavailable).toBeUndefined();
  });

  it('a second press while the first is pending is refused, and only one notice is queued (review 4-3)', async () => {
    const t = await setup();
    const [a, b] = await Promise.all([t.bridge.askAssistant(SID, 'p-h'), t.bridge.askAssistant(SID, 'p-h')]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((r) => !r.ok)).toEqual({ ok: false, error: 'The assistant is already looking into this plan.' });
    expect(t.queued).toHaveLength(1);
    expect((t.bridge as any).handoffs.size).toBe(1);
    expect((t.bridge as any).noticeTurns.size).toBe(1);
  });

  it('a notice that cannot be queued clears the handoff at once and says so on the card', async () => {
    const t = await setup({ queuePlanNotice: () => false });
    expect(await t.bridge.askAssistant(SID, 'p-h')).toEqual({ ok: false, error: "Couldn't ask the assistant: this conversation isn't running here right now." });
    const h = (await t.handoff())!;
    expect(h.state).toBe('answered');
    expect(h.problem).toBeUndefined();
    expect(h.revisionTurnId).toBeUndefined();
    expect((t.bridge as any).handoffs.size).toBe(0);
    expect((t.bridge as any).noticeTurns.size).toBe(0);
  });

  it('a question behind a reply in progress is recorded as waiting; delivery starting clears that (§6, review 4-5)', async () => {
    const t = await setup({ noticeWouldWait: () => true });
    const res = await t.bridge.askAssistant(SID, 'p-h');
    expect(res).toMatchObject({ ok: true, plan: { paused: { handoff: { state: 'pending', waiting: 'reply' } } } });
    t.queued[0].onStart();
    await vi.waitFor(async () => expect((await t.handoff())!.waiting).toBeUndefined());
    expect((await t.handoff())!.state).toBe('pending');
  });

  it('a conversation that turned busy between the check and the queue is corrected to waiting', async () => {
    let busy = false;
    const t = await setup({ noticeWouldWait: () => busy });
    const realMutate = t.bridge.journal.mutate.bind(t.bridge.journal);
    vi.spyOn(t.bridge.journal, 'mutate').mockImplementation(((ref: any, fn: any) => { busy = true; return realMutate(ref, fn); }) as any);
    await t.bridge.askAssistant(SID, 'p-h');
    await vi.waitFor(async () => expect((await t.handoff())!.waiting).toBe('reply'));
  });

  it('the backstop clears a question that never started, withdraws it, and leaves an error with Retry (§6, review 4-5)', async () => {
    const t = await setup({}, { handoffBackstopMs: 20 });
    await t.bridge.askAssistant(SID, 'p-h');
    const id = (await t.handoff())!.id;
    await vi.waitFor(async () => expect((await t.handoff())!.state).toBe('answered'));
    expect((await t.handoff())!.problem).toEqual({ kind: 'no-start' });
    expect(t.withdrawn).toEqual([id]);
    const view = (await t.bridge.views(SID))[0];
    expect(view.paused!.handoff).toEqual({ state: 'answered', problem: { kind: 'no-start' } });
  });

  it('a notice turn that failed leaves the real reason with Retry; one that ended normally leaves the default buttons (review 4-10)', async () => {
    const t = await setup();
    await t.bridge.askAssistant(SID, 'p-h');
    t.queued[0].onStart();
    t.queued[0].onEnd({ failed: 'The provider returned an error (529: overloaded).' });
    await vi.waitFor(async () => expect((await t.handoff())!.state).toBe('answered'));
    expect((await t.handoff())!.problem).toEqual({ kind: 'reply-failed', detail: 'The provider returned an error (529: overloaded).' });
    // Asking again replaces the problem.
    expect(await t.bridge.askAssistant(SID, 'p-h')).toMatchObject({ ok: true });
    expect((await t.handoff())!.problem).toBeUndefined();
    t.queued[1].onStart();
    t.queued[1].onEnd({});
    await vi.waitFor(async () => expect((await t.handoff())!.state).toBe('answered'));
    expect((await t.handoff())!.problem).toBeUndefined();
    expect((t.bridge as any).noticeTurns.size).toBe(0);
  });

  it('Stop on the conversation clears a pending question silently (the user chose it)', async () => {
    const t = await setup();
    await t.bridge.askAssistant(SID, 'p-h');
    t.bridge.conversationStopped(SID);
    await vi.waitFor(async () => expect((await t.handoff())!.state).toBe('answered'));
    expect((await t.handoff())!.problem).toBeUndefined();
    expect(t.withdrawn).toHaveLength(1);
  });

  it('restart recovery keeps a question this process holds (review 4-4)', async () => {
    const t = await setup();
    await t.bridge.askAssistant(SID, 'p-h');
    await t.bridge.recover(SID, '/proj');
    expect((await t.handoff())!.state).toBe('pending');
  });

  it('a Stop that lands during the Ask write never leaves the card greyed (review of Task 11, finding 1)', async () => {
    let bridge!: PlanHostBridge;
    let fired = false;
    const t = await setup({
      // Called after the handoff is registered and before the service write:
      // exactly the window where the clear finds nothing in the journal yet.
      noticeWouldWait: () => { if (!fired) { fired = true; bridge.conversationStopped(SID); } return false; },
      noticeRefusal: () => (fired ? 'You stopped this conversation. Send the assistant a message, then ask again.' : undefined),
      queuePlanNotice: () => false,
    });
    bridge = t.bridge;
    const res = await bridge.askAssistant(SID, 'p-h');
    expect((res as any).plan?.paused?.handoff?.state).not.toBe('pending');
    const h = (await t.handoff())!;
    expect(h.state).toBe('answered');
    expect(h.problem).toBeUndefined();
    expect((bridge as any).handoffs.size).toBe(0);
    expect((bridge as any).noticeTurns.size).toBe(0);
  });

  it('a Stop just before queueing, with the notice refused, leaves the card answered', async () => {
    let bridge!: PlanHostBridge;
    let calls = 0;
    const t = await setup({
      // The second call is inside queueAsk, after the write and its check.
      noticeWouldWait: () => { if (++calls === 2) bridge.conversationStopped(SID); return false; },
      queuePlanNotice: () => false,
    });
    bridge = t.bridge;
    expect(await bridge.askAssistant(SID, 'p-h')).toMatchObject({ ok: false });
    await vi.waitFor(async () => expect((await t.handoff())!.state).toBe('answered'));
    expect((bridge as any).handoffs.size).toBe(0);
  });

  it('a Stop during the Ask write, with the notice still queued, is withdrawn and answered', async () => {
    let bridge!: PlanHostBridge;
    let fired = false;
    const t = await setup({
      noticeWouldWait: () => { if (!fired) { fired = true; bridge.conversationStopped(SID); } return false; },
    });
    bridge = t.bridge;
    await bridge.askAssistant(SID, 'p-h');
    await vi.waitFor(async () => expect((await t.handoff())!.state).toBe('answered'));
    expect((bridge as any).handoffs.size).toBe(0);
    expect((bridge as any).noticeTurns.size).toBe(0);
    if (t.queued.length) expect(t.withdrawn).toContain(t.queued[0].handoffId);
  });

  it('a clear that lands while the notice is being queued withdraws the notice just queued', async () => {
    const log: string[] = [];
    let bridge!: PlanHostBridge;
    const t = await setup({
      queuePlanNotice: (_s, n) => {
        // The clear runs in the middle of queueing (its synchronous part).
        bridge.conversationStopped(SID);
        log.push(`queued:${n.handoffId}`);
        return true;
      },
      withdrawPlanNotice: (_s, id) => { log.push(`withdrawn:${id}`); return true; },
    });
    bridge = t.bridge;
    await bridge.askAssistant(SID, 'p-h');
    await new Promise((r) => setTimeout(r, 20));
    const id = (await t.handoff())!.id;
    expect(log.slice(log.indexOf(`queued:${id}`))).toContain(`withdrawn:${id}`);
    expect((bridge as any).noticeTurns.size).toBe(0);
    expect((bridge as any).handoffs.size).toBe(0);
    expect((await t.handoff())!.state).toBe('answered');
  });
});

// Final review F2: a run whose final write failed leaves a "running" card
// under this process's lease. The bridge runs recovery itself, which shows the
// plan paused with the real reason.
describe('a plan whose final write failed', () => {
  it('is recovered by the bridge as paused with the real reason', async () => {
    const bridge = new PlanHostBridge(port(), { orphanRecoveryDelaysMs: [0] });
    const REF = { cwd: '/proj', sessionId: SID };
    await bridge.journal.mutate(REF, (file) => {
      file.plans.push({
        planId: 'p-o', toolUseId: 't', document: DOC, maximumAttempts: 1, maxFanOut: 1,
        usedTokens: 0, status: 'proposed', seq: 1, createdAt: 1,
        manifest: manifest(),
        steps: [{ id: 's1', status: 'running', attempts: [] }], fenceEpoch: 0,
      });
    });
    // This process leases it, and no run is behind it (the executor's answer).
    expect((await bridge.journal.acquireLease(REF, 'p-o', { startFrom: ['proposed'] })).ok).toBe(true);
    let orphan: { reason: string; report?: string } | undefined = { reason: "The plan stopped because its progress couldn't be saved.", report: 'EIO: i/o error' };
    vi.spyOn(bridge.executor, 'orphanReason').mockImplementation(() => orphan);
    const cleared = vi.spyOn(bridge.executor, 'clearOrphan').mockImplementation(() => { orphan = undefined; });
    // What the executor calls when its final write keeps failing.
    (bridge.executor as unknown as { runner: { onOrphaned(ref: typeof REF, planId: string): void } }).runner.onOrphaned(REF, 'p-o');
    await vi.waitFor(async () => expect((await bridge.journal.get(REF, 'p-o'))!.status).toBe('paused'));
    const rec = (await bridge.journal.get(REF, 'p-o'))!;
    expect(rec.lease).toBeUndefined();
    expect(rec.paused).toMatchObject({ kind: 'unexpected-error', reason: "The plan stopped because its progress couldn't be saved.", report: 'EIO: i/o error' });
    expect(cleared).toHaveBeenCalledWith(REF, 'p-o');
  });
});
