// Regression, 2026-09-18 — "tried in two sessions and both failed to make a
// plan" (Destin, live testing; controller decisions 25 and 26).
//
// What actually happened: his specialist tiers resolved to ChatGPT models
// while he was signed OUT of ChatGPT. The app proposed the plan anyway, he
// approved it, and only then did a specialist die with "Sign in with ChatGPT
// in Settings → Model Providers to use this model." The plan then spent its
// ONE automatic retry re-running the identical launch — which could never
// succeed — and paused.
//
// This file drives the real ProviderRegistry (signed out, no network) through
// the real PlanHostBridge, journal, budget and executor, because the bug was
// exactly that those two halves did not talk to each other.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { SecretsStore } from '../src/main/providers/secrets-store';
import { ProviderRegistry } from '../src/main/providers/provider-registry';
import type { ChatGptAuth } from '../src/main/providers/chatgpt-auth';
import { PlanHostBridge, definitionFingerprint, type PlanHostPort } from '../src/main/harness/plans/plan-host-bridge';
import { PlanService, type PlanExecutorHooks } from '../src/main/harness/plans/plan-service';
import { BUILTIN_ROSTER, resolveSpecialist } from '../src/main/harness/specialists/registry';
import { DelegatedModels } from '../src/main/harness/specialists/delegated-models';
import { CLOUD_DEFAULT } from '../src/main/harness/capability-profile';
import { planCeilingTokens } from '../src/main/harness/plans/plan-budget';
import { pausedRouting } from '../src/main/harness/plans/pause-routing';
import type { PlanDocumentV1 } from '../src/main/harness/plans/schema';
import type { ExecutionManifest, PlanRecord, PlanRef } from '../src/main/harness/plans/types';

/** The provider registry's own sentence — copied here so a silent reword in
 *  the registry fails this test instead of quietly changing what the user is
 *  told about a plan that cannot run. */
const SIGN_IN = 'Sign in with ChatGPT in Settings → Model Providers to use this model.';
const SID = 'root';
const REF: PlanRef = { cwd: '/proj', sessionId: SID };
const DOC: PlanDocumentV1 = { goal: 'summarise the repo', steps: [
  { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Review {item}', budget_tokens: 1000, items: ['a'] },
] };

let root: string; let home: NativeHome; let registry: ProviderRegistry;
let startChildCalls = 0;
/** Signed out is the state Destin was in; the Approve/Continue cases below
 *  need a plan proposed while signed IN and pressed after signing out. */
let signedIn = false;

const auth = {
  isSignedIn: () => signedIn,
  status: () => (signedIn ? { state: 'signed-in', email: 'x@y', plan: 'pro', usage: null } : { state: 'signed-out' }),
} as unknown as ChatGptAuth;

function port(): PlanHostPort {
  return {
    home,
    emit: () => {},
    rootCwd: (id) => (id === SID ? '/proj' : undefined),
    parentBinding: () => ({ providerId: 'chatgpt', modelId: 'gpt-parent' }),
    permissionState: () => ({ preset: 'coder', mode: 'ask' }),
    roster: () => BUILTIN_ROSTER,
    designated: new DelegatedModels(home),
    catalog: async () => [{ id: 'gpt-5.6-terra', providerId: 'chatgpt', label: 'Terra' }],
    resolveRoute: async () => ({ providerType: 'chatgpt', profile: CLOUD_DEFAULT, pricing: null, free: false, contextLength: 100_000, totalSlots: null }),
    // The real thing, wired exactly as ipc-handlers wires it.
    credentialReadiness: (binding) => registry.credentialReadiness(binding),
    maxConcurrent: () => 4,
    readChildEvents: () => [],
    queueTurn: () => {},
    currentTurnId: () => undefined,
    noticeRefusal: () => undefined,
    planToolsAvailable: () => true,
    noticeWouldWait: () => false,
    queuePlanNotice: () => false,
    withdrawPlanNotice: () => false,
    startChild: async () => { startChildCalls += 1; throw new Error('a specialist must never be minted for a provider that cannot run'); },
    probeSession: async () => {
      if (!signedIn) throw new Error('nothing may be measured for a specialist that cannot run');
      return {
        session: {
          planSetupRequest: async () => ({ system: 'x'.repeat(500), tools: [] }),
          planNextRequestBound: async () => ({ ok: true, tokens: 500 }),
        } as any,
        dispose: () => {},
      };
    },
  };
}

/** The real PlanService over this bridge — the two real buttons go through it,
 *  which is exactly what the first regression test did not do. */
function service(bridge: PlanHostBridge): PlanService {
  let n = 0;
  return new PlanService({
    journal: bridge.journal, home, now: () => 5000,
    sessionCwd: (id) => (id === SID ? '/proj' : undefined),
    resolveManifest: (input) => bridge.resolveManifest(input),
    queueCommentTurn: async () => {},
    executor: { start: () => {}, stop: async () => {} } as unknown as PlanExecutorHooks,
    newId: () => `id${++n}`,
  });
}

const MANIFEST: ExecutionManifest = {
  modelLabel: 'gpt-5.6-terra',
  specialists: {
    reviewer: {
      definitionFingerprint: definitionFingerprint(resolveSpecialist('reviewer')!),
      binding: { providerId: 'chatgpt', modelId: 'gpt-5.6-terra' },
      pricing: null, setupTokens: 1000, approximateLimit: true,
    },
  },
  permissionFingerprint: 'perm',
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-signed-out-'));
  home = new NativeHome(root);
  registry = new ProviderRegistry(home, new SecretsStore(root), null, auth);
  startChildCalls = 0;
  signedIn = false;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));

describe('a ChatGPT-bound plan while signed out (decisions 25 + 26)', () => {
  it('is refused before it is ever proposed, in ChatGPT\'s own words', async () => {
    // No network is touched proving it: the whole check is local.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('the proposal check must not use the network'); }));
    try {
      await expect(service(new PlanHostBridge(port())).propose({
        sessionId: SID, toolUseId: 'tool-1', document: DOC, maximumAttempts: 2,
        ceilingTokens: 1000, maxFanOut: 2, signal: new AbortController().signal, commit: () => true,
      })).rejects.toThrow(`The "reviewer" specialist can't run right now: ${SIGN_IN} The plan wasn't created.`);
      expect((globalThis.fetch as any).mock.calls).toHaveLength(0);
    } finally { vi.unstubAllGlobals(); }
  });

  // Review finding 2: the readiness check lives in resolveManifest, which
  // Approve and Continue also reach (via reconcile). Both used to answer with
  // the PROPOSAL's ending — "The plan wasn't created." — about a plan the
  // person is looking at. Decision 26's whole promise is "sign in, then press
  // Continue", so a Continue pressed a moment early must not say the plan is
  // gone.
  it('Approve on a plan whose provider went not-ready says the plan cannot start, not that it was never created', async () => {
    const svc = service(new PlanHostBridge(port()));
    signedIn = true;
    const view = await svc.propose({
      sessionId: SID, toolUseId: 'tool-2', document: DOC, maximumAttempts: 2,
      ceilingTokens: 1000, maxFanOut: 2, signal: new AbortController().signal, commit: () => true,
    });
    expect(view.status).toBe('proposed');
    signedIn = false;                                   // he signs out before pressing Approve
    const res = await svc.approve(SID, view.planId);
    expect(res).toEqual({ ok: false, error: `The "reviewer" specialist can't run right now: ${SIGN_IN} The plan can't start yet.` });
  });

  it('Continue on a paused not-ready plan says the same, and never that the plan was not created', async () => {
    const bridge = new PlanHostBridge(port());
    const svc = service(bridge);
    signedIn = true;
    const view = await svc.propose({
      sessionId: SID, toolUseId: 'tool-3', document: DOC, maximumAttempts: 2,
      ceilingTokens: 1000, maxFanOut: 2, signal: new AbortController().signal, commit: () => true,
    });
    await bridge.journal.mutate(REF, (file) => {
      const p = file.plans.find((x) => x.planId === view.planId)!;
      p.status = 'paused';
      p.paused = { stepId: 's1', kind: 'launch-failed', launch: 'not-ready', reason: `A specialist in step "s1" couldn't start: ${SIGN_IN}` };
    });
    signedIn = false;
    const res = await svc.resume(SID, view.planId);
    expect(res).toEqual({ ok: false, error: `The "reviewer" specialist can't run right now: ${SIGN_IN} The plan can't start yet.` });
  });

  it('if an already-approved plan reaches launch signed out: exactly one pause, zero retries, and Continue is offered', async () => {
    const bridge = new PlanHostBridge(port(), { settleDeadlineMs: 60, heartbeatMs: 10_000 });
    const rec: PlanRecord = {
      planId: 'p1', toolUseId: 'tool-p1', document: DOC, maximumAttempts: 1, maxFanOut: 1,
      ceilingTokens: planCeilingTokens(DOC, MANIFEST), ceilingUsd: null, usedTokens: 0,
      // Approve takes its lease straight from 'proposed' (plan-service
      // startRun), so this is the plan exactly as his press left it.
      status: 'proposed', seq: 1, createdAt: 1, manifest: MANIFEST,
      steps: [{ id: 's1', status: 'pending', attempts: [] }],
      fenceEpoch: 0,
    };
    await bridge.journal.mutate(REF, (file) => { file.plans.push(rec); });
    const lease = await bridge.journal.acquireLease(REF, 'p1', { startFrom: ['proposed'] });
    if (!lease.ok) throw new Error(`lease ${lease.reason}`);
    bridge.executor.start({ ref: REF, planId: 'p1', fence: lease.fence });
    await bridge.executor.settled('p1');

    const p = (await bridge.journal.get(REF, 'p1'))!;
    expect(startChildCalls).toBe(0);              // nothing was ever minted
    expect(p.recoveries).toBeUndefined();         // and nothing was retried
    expect(p.status).toBe('paused');
    expect(p.paused).toMatchObject({ kind: 'launch-failed', launch: 'not-ready' });
    expect(p.paused!.reason).toBe(`A specialist in step "s1" couldn't start: ${SIGN_IN}`);
    // Continue · Stop — signing in IS the fix, so the card must not be
    // Stop-only. The same two buttons after a restart, from the journal alone.
    expect(pausedRouting(p.paused!)).toEqual({ route: 'assistant', actions: ['continue', 'stop'] });
  });
});
