// Specialists plans, Task 4 — the plan-specific host decisions (plan-host-bridge.ts)
// against a fake host port: which model a plan specialist runs on, what is
// frozen into the manifest, when a launch is refused, and the smallest Add
// budget after a soft (ChatGPT) overshoot.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { PlanHostBridge, definitionFingerprint, PLAN_MINIMUM_ADD_MARGIN_TOKENS, type PlanHostPort, type PlanRoute } from '../src/main/harness/plans/plan-host-bridge';
import { BUILTIN_ROSTER, resolveSpecialist } from '../src/main/harness/specialists/registry';
import { DelegatedModels } from '../src/main/harness/specialists/delegated-models';
import { CLOUD_DEFAULT } from '../src/main/harness/capability-profile';
import { disableAdapterForPlans, resetDisabledAdaptersForTests } from '../src/main/harness/plans/budget-adapter';
import type { PlanDocumentV1 } from '../src/main/harness/plans/schema';
import { PlanLaunchDriftError, PlanLaunchRefusedError } from '../src/main/harness/plans/plan-executor';
import type { PlanRecord } from '../src/main/harness/plans/types';
import type { TranscriptEvent } from '../src/shared/types';

const SID = 'root';
const DOC: PlanDocumentV1 = { goal: 'g', steps: [
  { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Review {item}', budget_tokens: 1000, items: ['a'] },
] };

let root: string; let home: NativeHome; let routeType: PlanRoute['providerType']; let mode: string;
let parentBinding = { providerId: 'openrouter', modelId: 'parent' };
let catalog = [{ id: 'deepseek/deepseek-v4-flash-0731', providerId: 'openrouter', label: 'DS' }, { id: 'gpt-5.6-terra', providerId: 'chatgpt', label: 'Terra' }];
let nextBound = 100;
let childEvents: TranscriptEvent[] = [];

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
    resolveRoute: async () => ({ providerType: routeType, profile: CLOUD_DEFAULT, pricing: { in: 1, out: 2 }, free: false, contextLength: 100_000, totalSlots: null }),
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
    probeSession: () => ({
      session: {
        planSetupRequest: async () => ({ system: 'x'.repeat(500), tools: [] }),
        planNextRequestBound: async () => ({ ok: true, tokens: nextBound }),
      } as any,
      dispose: () => {},
    }),
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-bridge-'));
  home = new NativeHome(root);
  routeType = 'openrouter'; mode = 'ask'; nextBound = 100; childEvents = [];
  parentBinding = { providerId: 'openrouter', modelId: 'parent' };
  resetDisabledAdaptersForTests();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));

describe('the frozen manifest', () => {
  it('uses the automatic specialist model and measures the setup with the route\'s adapter', async () => {
    const m = await new PlanHostBridge(port()).resolveManifest({ sessionId: SID, cwd: '/proj', document: DOC });
    expect(m.specialists.reviewer).toEqual({
      definitionFingerprint: definitionFingerprint(resolveSpecialist('reviewer')!),
      binding: { providerId: 'openrouter', modelId: 'deepseek/deepseek-v4-flash-0731' },
      pricing: { kind: 'priced', rates: { in: 1, out: 2 } },
      setupTokens: 500 + 1024,
    });
    expect(m.modelLabel).toBe('deepseek/deepseek-v4-flash-0731');
  });

  it('a ChatGPT specialist marks its entry approximate (soft route)', async () => {
    parentBinding = { providerId: 'chatgpt', modelId: 'gpt-parent' };
    routeType = 'chatgpt';
    const m = await new PlanHostBridge(port()).resolveManifest({ sessionId: SID, cwd: '/proj', document: DOC });
    expect(m.specialists.reviewer).toMatchObject({ binding: { providerId: 'chatgpt', modelId: 'gpt-5.6-terra' }, approximateLimit: true });
  });

  it('refuses with a readable reason when no safe specialist model can be confirmed', async () => {
    catalog = [];
    await expect(new PlanHostBridge(port()).resolveManifest({ sessionId: SID, cwd: '/proj', document: DOC }))
      .rejects.toThrow('couldn\'t confirm a budget model for the "reviewer" specialist');
    catalog = [{ id: 'deepseek/deepseek-v4-flash-0731', providerId: 'openrouter', label: 'DS' }, { id: 'gpt-5.6-terra', providerId: 'chatgpt', label: 'Terra' }];
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

const soft = (over: Partial<PlanRecord> = {}): PlanRecord => ({
  planId: 'p1', toolUseId: 't', document: DOC, maximumAttempts: 1, maxFanOut: 1,
  ceilingTokens: 2000, ceilingUsd: null, usedTokens: 2600, status: 'paused', seq: 3, createdAt: 1,
  manifest: {
    modelLabel: 'x', permissionFingerprint: 'p',
    specialists: { reviewer: { definitionFingerprint: 'd', binding: { providerId: 'chatgpt', modelId: 'm' }, pricing: null, setupTokens: 1000, approximateLimit: true } },
  },
  steps: [{ id: 's1', status: 'paused', attempts: [{
    attemptId: 'a1', itemIndex: 0, iteration: 0, childId: 'kid', baseTokens: 2000, addedTokens: 0, reservedTokens: 0, spentTokens: 2600, phase: 'response-persisted', softLimit: true,
  }] }],
  fenceEpoch: 1,
  ...over,
});
const ev = (type: TranscriptEvent['type'], data: TranscriptEvent['data'] = {}): TranscriptEvent => ({ type, sessionId: 'kid', uuid: `${type}${Math.random()}`, timestamp: 1, data });

describe('the minimum Add budget', () => {
  it('after a soft overshoot covers the resume prompt, what the specialist overshot, and the plan limit', async () => {
    routeType = 'chatgpt';
    nextBound = 300;
    childEvents = [ev('user-message', { text: 'brief' }), ev('assistant-text', { text: 'long' }), ev('turn-complete', { stopReason: 'plan_budget_exhausted' })];
    const bridge = new PlanHostBridge(port()) as any;
    const min = await bridge.minimumAddTokens({ cwd: '/proj', sessionId: SID }, soft(), 'a1');
    // left = 2000 − 2600 = −600 → the resume request needs 300 + 1 + margin + 600.
    expect(min).toBe(300 + 1 + PLAN_MINIMUM_ADD_MARGIN_TOKENS + 600);
    // Review items 3/4: an unexplained action restarts with the tool-naming
    // brief, so that request is measured too.
    childEvents = [ev('user-message', { text: 'brief' }), ev('tool-use', { toolUseId: 'w', toolName: 'Write' })];
    expect(await bridge.minimumAddTokens({ cwd: '/proj', sessionId: SID }, soft(), 'a1')).toBe(300 + 1 + PLAN_MINIMUM_ADD_MARGIN_TOKENS + 600);
    // The plan-wide soft stop alone (nothing measurable) needs used − ceiling + 1.
    childEvents = [];
    expect(await bridge.minimumAddTokens({ cwd: '/proj', sessionId: SID }, soft(), 'a1')).toBe(2600 - 2000 + 1);
  });

  it('review item 2: the plan-wide gap is asked once — a sibling\'s own overshoot is left to its own pause', async () => {
    routeType = 'chatgpt';
    nextBound = 0;
    childEvents = [ev('user-message', { text: 'brief' })];
    const plan = soft({ usedTokens: 6600, ceilingTokens: 4000 });
    plan.document = { goal: 'g', steps: [{ id: 's1', kind: 'map', specialist: 'reviewer', task: 'Review {item}', budget_tokens: 1000, items: ['a', 'b'] }] };
    plan.steps[0].attempts.push({
      attemptId: 'b1', itemIndex: 1, iteration: 0, childId: 'kid-b', baseTokens: 2000, addedTokens: 0, reservedTokens: 0, spentTokens: 4000, phase: 'response-persisted', softLimit: true,
    });
    const bridge = new PlanHostBridge(port()) as any;
    // A: its own need (0 + 1 + margin + its 600 overshoot). Without the fix the
    // whole gap (6600 − 4000 + 1 = 2601, which includes B's 2000) was asked here
    // AND again at B's own pause.
    expect(await bridge.minimumAddTokens({ cwd: '/proj', sessionId: SID }, plan, 'a1')).toBe(1 + PLAN_MINIMUM_ADD_MARGIN_TOKENS + 600);
  });

  it('a capped route has no plan-wide gap; nothing is needed when the allowance already fits', async () => {
    childEvents = [ev('user-message', { text: 'brief' })];
    const bridge = new PlanHostBridge(port()) as any;
    const plan = soft({ usedTokens: 500, manifest: { ...soft().manifest, specialists: { reviewer: { ...soft().manifest.specialists.reviewer, binding: { providerId: 'openrouter', modelId: 'm' }, approximateLimit: undefined } } } });
    plan.steps[0].attempts[0].spentTokens = 500;
    expect(await bridge.minimumAddTokens({ cwd: '/proj', sessionId: SID }, plan, 'a1')).toBeUndefined();
  });
});

describe('launch refusal', () => {
  it('a budget route switched off for plans refuses before anything is reserved', async () => {
    const bridge = new PlanHostBridge(port()) as any;
    expect(await bridge.launchRefusal(soft(), 'reviewer')).toBeUndefined();
    disableAdapterForPlans('generic:openrouter', 'a request read 900 tokens of input');
    expect(await bridge.launchRefusal(soft(), 'reviewer')).toMatch(/switched off.*900 tokens/);
    resetDisabledAdaptersForTests();
    expect(await bridge.launchRefusal(soft({ disabledAdapters: [{ adapterId: 'generic:openrouter', detail: 'in this plan' }] }), 'reviewer'))
      .toMatch(/in this plan/);
  });
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
  const withReviewer = (binding = { providerId: 'openrouter', modelId: 'm' }) => soft({
    manifest: { ...soft().manifest, specialists: { reviewer: {
      definitionFingerprint: definitionFingerprint(resolveSpecialist('reviewer')!), binding, pricing: null, setupTokens: 1000,
    } } },
  });

  it('no approved settings for the specialist → PlanLaunchRefusedError', async () => {
    const bridge = new PlanHostBridge(port()) as any;
    await seedPlan(bridge, withReviewer());
    await expect(bridge.launch(launchInput({ specialist: 'writer' }))).rejects.toBeInstanceOf(PlanLaunchRefusedError);
  });

  it('a route with no budget adapter → PlanLaunchRefusedError', async () => {
    routeType = 'no-such-provider' as any;
    const bridge = new PlanHostBridge(port()) as any;
    await seedPlan(bridge, withReviewer());
    await expect(bridge.launch(launchInput())).rejects.toBeInstanceOf(PlanLaunchRefusedError);
  });

  it('a changed definition stays a drift, not a refusal', async () => {
    const bridge = new PlanHostBridge(port()) as any;
    await seedPlan(bridge, soft());
    const err = await bridge.launch(launchInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanLaunchDriftError);
    expect(err).not.toBeInstanceOf(PlanLaunchRefusedError);
  });
});

describe('review fix 2: the report-only request is measured on the specialist\'s own session', () => {
  it('measures `message` as the next turn of that session, and reads its newest user message', async () => {
    const probes: Array<{ historyFromChildId?: string; text?: string }> = [];
    const p = port();
    p.probeSession = (input) => {
      const rec: { historyFromChildId?: string; text?: string } = { historyFromChildId: input.historyFromChildId };
      probes.push(rec);
      return {
        session: { planNextRequestBound: async (_a: unknown, text: string) => { rec.text = text; return { ok: true, tokens: 4321 }; } } as any,
        dispose: () => {},
      };
    };
    const bridge = new PlanHostBridge(p) as any;
    const runner = bridge.runner();
    const plan = soft({ manifest: { ...soft().manifest, specialists: { reviewer: { ...soft().manifest.specialists.reviewer, binding: { providerId: 'openrouter', modelId: 'm' }, approximateLimit: undefined } } } });
    expect(await runner.reportOnlyInputBound({ cwd: '/proj', sessionId: SID }, plan, 'a1', 'REPORT NOW')).toBe(4321);
    expect(probes).toEqual([{ historyFromChildId: 'kid', text: 'REPORT NOW' }]);
    // Nothing to measure without a specialist session → not fundable.
    plan.steps[0].attempts[0].childId = undefined;
    expect(await runner.reportOnlyInputBound({ cwd: '/proj', sessionId: SID }, plan, 'a1', 'REPORT NOW')).toBeUndefined();
    childEvents = [ev('user-message', { text: 'brief' }), ev('assistant-text', { text: 'x' }), ev('user-message', { text: 'REPORT NOW' }), ev('assistant-text', { text: 'y' })];
    expect(runner.latestUserText({ cwd: '/proj', sessionId: SID }, 'kid')).toBe('REPORT NOW');
    childEvents = [];
    expect(runner.latestUserText({ cwd: '/proj', sessionId: SID }, 'kid')).toBeUndefined();
  });
});

// Task 11 (pause handoff §6, revision 4) — "Ask the assistant": the bridge's
// own decisions. Every rule here came from a review-4 finding.
describe('Ask the assistant', () => {
  const REF = { cwd: '/proj', sessionId: SID };
  const pausedPlan = (over: Partial<NonNullable<PlanRecord['paused']>> = {}): PlanRecord => ({
    planId: 'p-h', toolUseId: 't', document: DOC, maximumAttempts: 1, maxFanOut: 1,
    ceilingTokens: 1000, ceilingUsd: null, usedTokens: 1000, status: 'paused', seq: 1, createdAt: 1,
    manifest: { modelLabel: 'm', specialists: { reviewer: { definitionFingerprint: 'd', binding: { providerId: 'p', modelId: 'm' }, pricing: null, setupTokens: 0 } }, permissionFingerprint: 'x' },
    steps: [{ id: 's1', status: 'paused', attempts: [] }], fenceEpoch: 1,
    paused: { stepId: 's1', reason: 'used it all', kind: 'budget', ...over },
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
    const add = await t.bridge.addBudget(SID, 'p-2', 10);
    expect(add).toMatchObject({ ok: true, plan: { paused: { askUnavailable: true } } });
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
