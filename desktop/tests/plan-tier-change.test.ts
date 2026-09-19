// Specialists plans, Task 14 (decision 27) — changing which model a specialist
// runs on is a clean resume, not a re-proposal.
//
// Destin's words after live testing: "unclear why the assistant would need to
// re-propose a plan just cuz i needed to change my specialists tiers. this
// should've been a clean retry/resume". So Approve and Continue now CLASSIFY
// the drift: instructions/tools or permissions still refuse exactly as before;
// a change of binding and/or price re-freezes the plan to the current models
// and runs it — silently when the new worst case is provably not more, and
// after ONE ask otherwise.
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { PlanJournal } from '../src/main/harness/plans/plan-journal';
import { PLAN_LIMIT_ASK_MS, PlanService, type PlanExecutorHooks, type PlanServiceDeps } from '../src/main/harness/plans/plan-service';
import { PlanBudget, ceilingDidNotRise, planApproximateLimit, usdText } from '../src/main/harness/plans/plan-budget';
import { PlanSpecialistsNotReadyError, type ExecutionManifest, type PlanActionResult, type PlanEvent, type PlanRef } from '../src/main/harness/plans/types';
import type { PlanDocumentV1 } from '../src/main/harness/plans/schema';

const SID = 'parent-1';
const REF: PlanRef = { cwd: '/proj', sessionId: SID };

/** 2 items × (1,000 work + setup) — one specialist, so one tier to change. */
const doc = (): PlanDocumentV1 => ({
  goal: 'Review things',
  steps: [{ id: 's1', kind: 'map', specialist: 'reviewer', task: 'Review {item}', budget_tokens: 1000, summary: 'Plain sentence.', items: ['a', 'b'] }],
});

/** The plan as approved: a ChatGPT specialist at $3/$15 per million. */
const approved = (): ExecutionManifest => ({
  modelLabel: 'GPT-5',
  specialists: {
    reviewer: {
      definitionFingerprint: 'def-1',
      binding: { providerId: 'chatgpt', modelId: 'gpt-5' },
      pricing: { kind: 'priced', rates: { in: 3, out: 15 } },
      setupTokens: 250,
    },
  },
  permissionFingerprint: 'perm-1',
});

const withReviewer = (over: Partial<ExecutionManifest['specialists'][string]>, label?: string): ExecutionManifest => {
  const m = approved();
  m.specialists.reviewer = { ...m.specialists.reviewer, ...over };
  if (label) m.modelLabel = label;
  return m;
};

const priced = (inRate: number, out: number) => ({ kind: 'priced' as const, rates: { in: inRate, out } });

let root: string; let home: NativeHome; let journal: PlanJournal; let events: PlanEvent[];
let manifest: ExecutionManifest; let ids: number;
/** The service's clock, so a test can let an armed ask time out. */
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

async function propose() {
  return service.propose({
    sessionId: SID, toolUseId: 'tool-1', document: doc(), maximumAttempts: 2, ceilingTokens: 2000, maxFanOut: 2,
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
async function proposeAndPause(): Promise<string> {
  const view = await propose();
  const r = await service.approve(SID, view.planId);
  if (!r.ok) throw new Error(`approve failed: ${JSON.stringify(r)}`);
  await park();
  return view.planId;
}

const notice = (r: PlanActionResult): string => {
  if (r.ok || !('notice' in r) || typeof r.notice !== 'string') throw new Error(`expected a notice, got ${JSON.stringify(r)}`);
  return r.notice;
};

// ---- the pure comparison ----------------------------------------------------

describe('ceilingDidNotRise (decision 27, "provably not more")', () => {
  const cmp = (frozen: ExecutionManifest, current: ExecutionManifest) => ceilingDidNotRise(doc(), frozen, current);

  it('an identical manifest is provably not more', () => {
    expect(cmp(approved(), approved()).notMore).toBe(true);
  });

  it('a cheaper model at the same size is provably not more', () => {
    expect(cmp(approved(), withReviewer({ binding: { providerId: 'openrouter', modelId: 'cheap' }, pricing: priced(1, 2) })).notMore).toBe(true);
  });

  it('more tokens is MORE, even at a lower price', () => {
    const r = cmp(approved(), withReviewer({ setupTokens: 900, pricing: priced(1, 2) }));
    expect(r).toMatchObject({ notMore: false, why: 'tokens', newTokens: 3800, oldTokens: 2500 });
  });

  it('a dearer model at the same size is MORE, and carries both dollar figures', () => {
    const r = cmp(approved(), withReviewer({ pricing: priced(10, 40) }));
    expect(r).toMatchObject({ notMore: false, why: 'usd' });
    if (r.notMore) throw new Error('unreachable');
    expect(r.newUsd).toBeCloseTo(2500 * 40 / 1e6, 12);
    expect(r.oldUsd).toBeCloseTo(2500 * 15 / 1e6, 12);
  });

  it('a newly approximate limit is MORE at the very same numbers (a weaker promise)', () => {
    expect(cmp(approved(), withReviewer({ approximateLimit: true }))).toMatchObject({ notMore: false, why: 'approximate' });
  });

  it('an approximate limit that was ALREADY approximate is not a change', () => {
    const before = withReviewer({ approximateLimit: true });
    expect(cmp(before, withReviewer({ approximateLimit: true, pricing: priced(1, 2) })).notMore).toBe(true);
  });

  it('a current model with no published price is never provable — the null is read from the snapshot', () => {
    expect(cmp(approved(), withReviewer({ pricing: null }))).toMatchObject({ notMore: false, why: 'unknown-price' });
    // An unparseable snapshot (an older build, a hand edit) reads the same way.
    expect(cmp(approved(), withReviewer({ pricing: { input: 1, output: 2 } }))).toMatchObject({ notMore: false, why: 'unknown-price' });
  });

  it('a plan whose specialists are all free or local is provably not more — the OTHER meaning of a null dollar ceiling', () => {
    expect(cmp(approved(), withReviewer({ pricing: { kind: 'free' } })).notMore).toBe(true);
    expect(cmp(approved(), withReviewer({ pricing: { kind: 'local' } })).notMore).toBe(true);
  });

  it('a priced model where the approved one cost nothing is MORE', () => {
    const free = withReviewer({ pricing: { kind: 'local' } });
    expect(cmp(free, approved())).toMatchObject({ notMore: false, why: 'now-priced' });
  });

  it('a priced model where the approved one had no published price is MORE (nothing to compare)', () => {
    const unpriced = withReviewer({ pricing: null });
    expect(cmp(unpriced, approved())).toMatchObject({ notMore: false, why: 'unknown-approved' });
  });

  // Review finding 3: the card prints both figures rounded to the cent, so a
  // difference that disappears at that precision cannot be stated as "more
  // than" without contradicting itself — and is not worth an ask.
  it('a rise too small to print at the cent it is shown in is not worth an ask', () => {
    // $0.0375 → $0.0376: both print "~$0.04".
    expect(cmp(approved(), withReviewer({ pricing: priced(3, 15.04) })).notMore).toBe(true);
    // Sub-cent both sides: both print "less than a cent".
    const tiny = withReviewer({ pricing: priced(0.3, 1.2) });
    expect(cmp(tiny, withReviewer({ pricing: priced(0.3, 1.25) })).notMore).toBe(true);
    // A rise that IS visible at that precision still asks.
    expect(cmp(approved(), withReviewer({ pricing: priced(3, 20) })).notMore).toBe(false);
  });

  // Review finding 9: an approximate limit is the disclosure that matters most,
  // so a bigger number must never hide it.
  it('a change that raises the tokens AND makes the limit uncappable reports both', () => {
    const r = cmp(approved(), withReviewer({ setupTokens: 900, approximateLimit: true, pricing: priced(1, 2) }));
    expect(r).toMatchObject({ notMore: false, why: 'tokens', newlyApproximate: true, newTokens: 3800, oldTokens: 2500 });
  });

  // Review finding 5: an Add budget already granted is part of the limit, so
  // both sides of the comparison must count it.
  it('an Add budget already granted counts on both sides of the comparison', () => {
    const tranches = [{ stepId: 's1', tokens: 5000 }];
    const r = ceilingDidNotRise(doc(), approved(), withReviewer({ pricing: priced(10, 40) }), tranches);
    expect(r).toMatchObject({ notMore: false, why: 'usd', newTokens: 7500, oldTokens: 7500 });
    if (r.notMore) throw new Error('unreachable');
    expect(r.newUsd).toBeCloseTo(7500 * 40 / 1e6, 12);
    expect(r.oldUsd).toBeCloseTo(7500 * 15 / 1e6, 12);
  });
});

// Review finding 3: the function's own comment forbids a false $0.00, and it
// was printing one.
describe('usdText', () => {
  it('never prints a $0.00 the plan does not have', () => {
    expect(usdText(0)).toBe('nothing');
    expect(usdText(-1)).toBe('nothing');
    expect(usdText(0.001)).toBe('less than a cent');
    expect(usdText(0.0375)).toBe('~$0.04');
    expect(usdText(0.1)).toBe('~$0.10');
  });
});

// Review finding 10: the tilde on the card and the comparison must read the
// same specialists — the ones the document actually runs.
describe('planApproximateLimit', () => {
  it('reads only the specialists the document runs, not every entry in the roster', () => {
    const roster = withReviewer({});
    roster.specialists.unused = {
      definitionFingerprint: 'def-x', binding: { providerId: 'openrouter', modelId: 'other' },
      pricing: priced(1, 2), setupTokens: 0, approximateLimit: true,
    };
    expect(planApproximateLimit(doc(), roster)).toBe(false);
    expect(planApproximateLimit(doc(), withReviewer({ approximateLimit: true }))).toBe(true);
  });
});

// ---- Approve / Continue -----------------------------------------------------

describe('a specialist tier change is a clean resume', () => {
  it('Continue after a switch to a cheaper model runs, says nothing, and re-freezes in the SAME write as the status change', async () => {
    const planId = await proposeAndPause();
    // The fix Destin made: the roster now points at an OpenRouter model.
    manifest = withReviewer({ binding: { providerId: 'openrouter', modelId: 'cheap' }, pricing: priced(1, 2), setupTokens: 100 }, 'Cheap model');
    const r = await service.resume(SID, planId);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    // No notice, no extra click.
    expect(r.plan.status).toBe('running');
    // One journal write: the card moved to running AND carries the new manifest.
    expect(events).toHaveLength(1);
    expect(events[0].plan.status).toBe('running');
    const rec = (await journal.get(REF, planId))!;
    expect(rec.status).toBe('running');
    expect(rec.manifest).toEqual(manifest);
    // 2 × (1,000 + 100) at the new model's size.
    expect(rec.ceilingTokens).toBe(2200);
    expect(rec.ceilingUsd).toBeCloseTo(2200 * 2 / 1e6, 12);
    expect(events[0].plan.ceilingTokens).toBe(2200);
    expect(executor.start).toHaveBeenCalledTimes(1);
  });

  it('Continue after a switch to a pricier model asks ONCE, then runs at the new limit', async () => {
    const planId = await proposeAndPause();
    manifest = withReviewer({ binding: { providerId: 'openrouter', modelId: 'big' }, pricing: priced(10, 40) }, 'Big model');
    const first = await service.resume(SID, planId);
    const text = notice(first);
    // Both figures, in the card's tilde style, and the button that says it again.
    expect(text).toContain('~$0.10');
    expect(text).toContain('~$0.04');
    expect(text).toContain('Press Continue again');
    expect(text).not.toMatch(/propose it again/i);
    // Nothing ran, nothing was written.
    expect(executor.start).not.toHaveBeenCalled();
    expect((await journal.get(REF, planId))!.status).toBe('paused');
    expect((await journal.get(REF, planId))!.manifest).toEqual(approved());
    expect(events).toEqual([]);

    // The SAME button again: it runs at the new limit.
    const second = await service.resume(SID, planId);
    expect(second.ok).toBe(true);
    const rec = (await journal.get(REF, planId))!;
    expect(rec.status).toBe('running');
    expect(rec.manifest).toEqual(manifest);
    expect(rec.ceilingUsd).toBeCloseTo(2500 * 40 / 1e6, 12);
  });

  it('a LATER, different change asks again with the new numbers', async () => {
    const planId = await proposeAndPause();
    manifest = withReviewer({ pricing: priced(10, 40) });
    expect(notice(await service.resume(SID, planId))).toContain('~$0.10');
    // Changed again before the second press — a different manifest, so it asks
    // again rather than running at a limit nobody saw.
    manifest = withReviewer({ pricing: priced(20, 80) });
    expect(notice(await service.resume(SID, planId))).toContain('~$0.20');
    expect(executor.start).not.toHaveBeenCalled();
    // And the third press, unchanged, runs it.
    expect((await service.resume(SID, planId)).ok).toBe(true);
    expect(executor.start).toHaveBeenCalledTimes(1);
  });

  it('Approve on a proposed plan follows the same rule, in its own words', async () => {
    const view = await propose();
    manifest = withReviewer({ pricing: priced(10, 40) });
    const text = notice(await service.approve(SID, view.planId));
    expect(text).toContain('Press Approve again');
    expect((await journal.get(REF, view.planId))!.status).toBe('proposed');
    expect((await service.approve(SID, view.planId)).ok).toBe(true);
  });

  it('instructions/tools drift and permission drift still refuse in today\'s exact words', async () => {
    const planId = await proposeAndPause();
    manifest = withReviewer({ definitionFingerprint: 'def-2', pricing: priced(1, 2) });
    expect(await service.resume(SID, planId)).toEqual({
      ok: false,
      error: "This plan can't run as approved because a specialist's instructions or tools changed since it was proposed. Ask the assistant to propose it again.",
    });
    manifest = approved(); manifest.permissionFingerprint = 'perm-2';
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
    manifest = withReviewer(
      { binding: { providerId: 'openrouter', modelId: 'qwen3-coder' }, pricing: priced(0.3, 1.2) },
      'Qwen3 Coder',
    );
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
    manifest = withReviewer({ binding: { providerId: 'openrouter', modelId: 'qwen3-coder' }, pricing: priced(0.3, 1.2) }, 'Qwen3 Coder');
    const r = await service.resume(SID, planId);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.plan.status).toBe('running');
  });

  // Deliberately allowed: a cheaper model leaves less room, and the ORDINARY
  // budget pause handles it — nothing new is built for this case.
  it('re-freezing to a smaller model can leave too little room, and that is the ordinary budget pause', async () => {
    const planId = await proposeAndPause();
    await journal.mutate(REF, (file) => { file.plans[0].usedTokens = 2000; });
    manifest = withReviewer({ binding: { providerId: 'openrouter', modelId: 'cheap' }, pricing: priced(1, 2), setupTokens: 50 });
    expect((await service.resume(SID, planId)).ok).toBe(true);
    // The plan's limit came down with the model: 2 × (1,000 + 50).
    expect((await journal.get(REF, planId))!.ceilingTokens).toBe(2100);
    const fence = executor.start.mock.calls[0][0].fence;
    const budget = new PlanBudget({ journal, now: () => 5000, newId: () => 'att-1' });
    const res = await budget.reserveAttempts(REF, planId, fence, [{ stepId: 's1' }]);
    expect(res).toMatchObject({ ok: false, reason: 'ceiling-tokens', shortfallTokens: 950 });
  });
});

// The ask is a QUESTION, not a grant. Review finding 1 found the opposite: the
// fingerprint was written by the press that SHOWED the notice, and nothing ever
// removed it, so a question nobody answered authorised that limit forever.
describe('the new-limit question arms exactly one press', () => {
  const dearer = () => withReviewer({ binding: { providerId: 'openrouter', modelId: 'big' }, pricing: priced(10, 40) }, 'Big model');

  it('a question the user walked away from never counts as an answer', async () => {
    const planId = await proposeAndPause();
    manifest = dearer();
    expect(notice(await service.resume(SID, planId))).toContain('~$0.10');
    // He does not press again — he puts his tiers back, and it runs.
    manifest = approved();
    expect((await service.resume(SID, planId)).ok).toBe(true);
    expect((await journal.get(REF, planId))!.ceilingUsd).toBeCloseTo(2500 * 15 / 1e6, 12);
    // The plan pauses again and he moves to the dear model once more. This must
    // ASK — the question from before was never answered.
    await park();
    manifest = dearer();
    expect(notice(await service.resume(SID, planId))).toContain('~$0.10');
    expect(executor.start).not.toHaveBeenCalled();
    expect((await journal.get(REF, planId))!.ceilingUsd).toBeCloseTo(2500 * 15 / 1e6, 12);
  });

  it('a press that refuses in between clears the question', async () => {
    const planId = await proposeAndPause();
    manifest = dearer();
    expect(notice(await service.resume(SID, planId))).toContain('~$0.10');
    // A refusal is not an answer to the money question.
    manifest = withReviewer({ definitionFingerprint: 'def-2', pricing: priced(10, 40) });
    expect(await service.resume(SID, planId)).toMatchObject({ ok: false, error: expect.stringContaining('propose it again') });
    manifest = dearer();
    expect(notice(await service.resume(SID, planId))).toContain('~$0.10');
    expect(executor.start).not.toHaveBeenCalled();
  });

  // Review finding 2: the notice lives in the card, which dies on a conversation
  // switch, a reload or a second device's refresh, while main's memory does not.
  it('a question goes stale, so a press that could not have read it asks again', async () => {
    const planId = await proposeAndPause();
    manifest = dearer();
    expect(notice(await service.resume(SID, planId))).toContain('~$0.10');
    clock += PLAN_LIMIT_ASK_MS + 1;
    expect(notice(await service.resume(SID, planId))).toContain('~$0.10');
    expect(executor.start).not.toHaveBeenCalled();
    // Answered inside the window, it still runs on the very next press.
    expect((await service.resume(SID, planId)).ok).toBe(true);
    expect((await journal.get(REF, planId))!.ceilingUsd).toBeCloseTo(2500 * 40 / 1e6, 12);
  });
});

// The money stop is the promise behind the question. Review findings 4 and 5.
describe('what the plan is really limited to afterwards', () => {
  it('models with no published price say the dollar limit is going away, and name what is left', async () => {
    const planId = await proposeAndPause();
    manifest = withReviewer({ binding: { providerId: 'openrouter', modelId: 'mystery' }, pricing: null }, 'Mystery');
    const text = notice(await service.resume(SID, planId));
    expect(text).toContain('no published price');
    expect(text).toContain("the plan's ~$0.04 dollar limit no longer applies");
    expect(text).toContain('~2,500 tokens');
    // Never a figure the app does not have.
    expect(text).not.toMatch(/\$0\.00/);
    expect((await service.resume(SID, planId)).ok).toBe(true);
    const rec = (await journal.get(REF, planId))!;
    expect(rec.ceilingUsd).toBeNull();
    expect(rec.ceilingTokens).toBe(2500);
  });

  it('an Add budget the user granted survives a round trip through a free tier, in both currencies', async () => {
    const planId = await proposeAndPause();
    const budget = new PlanBudget({ journal, now: () => 5000, newId: () => 'tranche-1' });
    await budget.addTokens({ ref: REF, planId, stepId: 's1', tokens: 5000 });
    let rec = (await journal.get(REF, planId))!;
    expect(rec.ceilingTokens).toBe(7500);
    expect(rec.ceilingUsd).toBeCloseTo(7500 * 15 / 1e6, 12);

    // To the user's own local engine: nothing costs money, so tokens alone.
    manifest = withReviewer({ binding: { providerId: 'local', modelId: 'qwen' }, pricing: { kind: 'local' } }, 'Local');
    expect((await service.resume(SID, planId)).ok).toBe(true);
    rec = (await journal.get(REF, planId))!;
    expect(rec.ceilingTokens).toBe(7500);
    expect(rec.ceilingUsd).toBeNull();

    // Back to the very model the plan was approved on: the top-up comes back
    // in dollars too, or the plan trips its dollar stop at a third of what he
    // authorised.
    await park();
    manifest = approved();
    expect(notice(await service.resume(SID, planId))).toContain('cost money now');
    expect((await service.resume(SID, planId)).ok).toBe(true);
    rec = (await journal.get(REF, planId))!;
    expect(rec.ceilingTokens).toBe(7500);
    expect(rec.ceilingUsd).toBeCloseTo(7500 * 15 / 1e6, 12);
  });

  it('the question quotes the limit the plan really has, top-up included', async () => {
    const planId = await proposeAndPause();
    const budget = new PlanBudget({ journal, now: () => 5000, newId: () => 'tranche-1' });
    await budget.addTokens({ ref: REF, planId, stepId: 's1', tokens: 5000 });
    manifest = withReviewer({ pricing: priced(10, 40) });
    const text = notice(await service.resume(SID, planId));
    // 7,500 tokens at $40 and at $15 per million — not the 2,500-token base.
    expect(text).toContain('~$0.30');
    expect(text).toContain('~$0.11');
  });

  it('a limit that becomes uncappable says so even when the token count also rose', async () => {
    const planId = await proposeAndPause();
    manifest = withReviewer({ setupTokens: 900, approximateLimit: true, pricing: priced(1, 2) });
    const text = notice(await service.resume(SID, planId));
    expect(text).toContain('~3,800 tokens');
    expect(text).toContain("can't cap its replies");
  });
});
