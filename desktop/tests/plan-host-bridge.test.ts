// Specialists plans, Task 4 — the plan-specific host decisions (plan-host-bridge.ts)
// against a fake host port: which model a plan specialist runs on, what is
// frozen into the manifest, when a launch is refused, and the smallest Add
// budget after a soft (ChatGPT) overshoot.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { PlanHostBridge, definitionFingerprint, PLAN_MINIMUM_ADD_MARGIN_TOKENS, type PlanHostPort, type PlanRoute } from '../src/main/harness/plans/plan-host-bridge';
import { BUILTIN_ROSTER, resolveSpecialist } from '../src/main/harness/specialists/registry';
import { DelegatedModels } from '../src/main/harness/specialists/delegated-models';
import { CLOUD_DEFAULT } from '../src/main/harness/capability-profile';
import { disableAdapterForPlans, resetDisabledAdaptersForTests } from '../src/main/harness/plans/budget-adapter';
import type { PlanDocumentV1 } from '../src/main/harness/plans/schema';
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
    // The plan-wide soft stop alone would need only used − ceiling + 1.
    childEvents = [ev('user-message', { text: 'brief' }), ev('tool-use', { toolUseId: 'w', toolName: 'Write' })];
    expect(await bridge.minimumAddTokens({ cwd: '/proj', sessionId: SID }, soft(), 'a1')).toBe(2600 - 2000 + 1);
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
