// Independent correctness audit of the specialists-plans SPENDING math
// (design doc docs/active/design/2026-09-24-specialists-plans-spending-
// backend-design.md, decisions 34-40 in 2026-09-05-specialists-plans/
// decision-log.md). Requested by Destin so he doesn't have to click-test the
// dollar figures himself.
//
// WHY a separate file rather than extending plan-spend-chip-parity.test.ts or
// harness-session-plan-spend.test.ts: those suites prove the JOURNAL and the
// CHIP agree with EACH OTHER (or that a call count is right) — they never
// compare either one against a number computed outside the codebase. A bug
// shared by costForUsage/billedEquivalentTokens and this file's own hand
// arithmetic would still show "agreement" there. Every expected dollar/token
// figure below is a LITERAL, computed by hand from the pricing formula
// (pricing.ts's own doc comment) and the billed-equivalent formula
// (docs/active/investigations/2026-09-19-specialist-usage.py's
// `billed_equiv = unc + cwc + 0.1*crc + out`) — never by importing or calling
// costForUsage/billedEquivalentTokens. If either function's arithmetic ever
// drifts from its own documented formula, this file breaks; the existing
// parity suites would not notice, because both sides of their comparison come
// from the same (possibly wrong) function.
//
// Drives the REAL PlanService + PlanExecutor + NativeSessionHost + PlanJournal
// path, exactly like plans-lifecycle.integration.test.ts (only the language
// model is scripted) — never the mocked PlanSpendHooks the unit suites use.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { NativeHome } from '../src/main/native-home';
import { SessionStore } from '../src/main/harness/session-store';
import { NativeSessionHost } from '../src/main/harness/native-session-host';
import { nativeStoreSlug } from '../src/main/slug-encoding';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { stream, textChunks, toolCallChunk } from './helpers/scripted-model';
import type { CatalogModel } from '../src/shared/provider-types';
import type { ModelPricing } from '../src/main/harness/pricing';

const POLL_TRIES = 1_500;
const NO_CONTEXT = async () => ({ contextLength: null, totalSlots: null });

const SID = 'cost-audit';
const PARENT = { providerId: 'openrouter', modelId: 'parent-model' };
// Catalog-shaped Anthropic-like rates: cacheRead is 1/10th of `in`, cacheWrite
// 1.25x `in` — the real ratios on Claude's rate card, per pricing.ts's own
// cache-token doc comment. $/1e6 tokens, costForUsage's own convention.
const PRICING: ModelPricing = { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const CHATGPT_MODEL = 'gpt-5.6-terra';
// The exact curated ids delegated-models.ts's AUTOMATIC_DELEGATED_MODELS
// falls back to for the (default) 'budget' tier when nothing is designated —
// a specialist with no explicit modelPreference resolves to 'budget', and the
// resolver refuses anything the live catalog can't confirm under THIS exact
// id, never a heuristic guess. Same ids plans-lifecycle.integration.test.ts's
// CATALOG uses, for the same reason.
const OPENROUTER_CHILD = 'deepseek/deepseek-v4-flash-0731';
const CATALOG: CatalogModel[] = [
  { id: OPENROUTER_CHILD, providerId: 'openrouter', label: 'Child' },
  { id: CHATGPT_MODEL, providerId: 'chatgpt', label: 'Terra' },
];

interface ChildCall { prompt: string; providerId: string; modelId: string }
// `after`: the reply is held until that promise resolves — same trick
// plans-lifecycle.integration.test.ts uses to prove/force real concurrency
// (a specialist's `beforeRequest` has already passed and its stream has
// already started before ANY sibling's crossing write can refuse it).
type Reply = { chunks: any[]; after?: Promise<void> } | 'hang';

let root: string;
let host: NativeSessionHost;
let childCalls: ChildCall[];
let childReply: (call: ChildCall, index: number) => Reply;
let events: any[];
let planEvents: Array<{ sessionId: string; plan: any }>;
let openStreams: Array<ReadableStreamDefaultController<any>>;
/** The parent conversation's own scripted turns (propose_plan, then its
 *  wrap-up line) — same convention as plans-lifecycle.integration.test.ts's
 *  `parentSteps`, consumed one array-of-chunks per doStream call. */
let parentSteps: Array<any[]>;

/** One raw LanguageModelV4 finish chunk carrying cache reads/writes AND a
 *  reasoning sub-count (@ai-sdk/provider's LanguageModelV4Usage shape:
 *  inputTokens.{total,noCache,cacheRead,cacheWrite}, outputTokens.{total,
 *  reasoning} — verified against node_modules/@ai-sdk/provider/dist/index.d.ts
 *  and ai/dist/index.js's asLanguageModelUsage). `output` already INCLUDES
 *  the reasoning tokens (that's how a real provider bills them — reasoning is
 *  a sub-count of output, never an extra charge) — the `reasoning` field is
 *  informational only, exactly like a real provider's response. */
function usageFinish(reason: string, u: { input: number; output: number; cacheRead?: number; cacheWrite?: number; reasoning?: number }) {
  const cacheRead = u.cacheRead ?? 0;
  const cacheWrite = u.cacheWrite ?? 0;
  return {
    type: 'finish',
    finishReason: { unified: reason, raw: reason },
    usage: {
      inputTokens: { total: u.input, noCache: u.input - cacheRead - cacheWrite, cacheRead, cacheWrite },
      outputTokens: { total: u.output, reasoning: u.reasoning ?? 0 },
    },
  };
}

function report(text: string, usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number; reasoning?: number }): Reply {
  return { chunks: [...textChunks('r', text), usageFinish('stop', usage)] };
}

// ---------------------------------------------------------------------------
// Shared, hand-computed reply fixtures (scenarios 1 and 2 both use the same
// 3-item map + combine shape). Every cost/token figure is worked out BY HAND
// from pricing.ts's own documented formula and the billed-equivalent formula
// in docs/active/investigations/2026-09-19-specialist-usage.py — never by
// calling costForUsage/billedEquivalentTokens.
//
// costForUsage(usage, PRICING): uncachedIn = input - cacheRead - cacheWrite;
//   cachedRead = min(cacheRead, input); cachedWrite = min(cacheWrite, input - cachedRead);
//   cost = uncachedIn/1e6*in + cachedRead/1e6*cacheRead_rate + output/1e6*out + cachedWrite/1e6*cacheWrite_rate
// billedEquivalentTokens(usage): uncachedIn + cacheWrite + output + ceil(0.1 * cacheRead)
// ---------------------------------------------------------------------------

// REPLY_A (a.ts): input=100_000 (cacheRead=80_000, cacheWrite=10_000 -> uncached=10_000), output=5_000 (2_000 of it reasoning).
//   cost = 10_000/1e6*3 + 80_000/1e6*0.3 + 5_000/1e6*15 + 10_000/1e6*3.75 = 0.03 + 0.024 + 0.075 + 0.0375 = 0.1665
//   billed = 10_000 + 10_000 + 5_000 + ceil(0.1*80_000=8_000) = 33_000
const REPLY_A = { input: 100_000, cacheRead: 80_000, cacheWrite: 10_000, output: 5_000, reasoning: 2_000 };
const COST_A = 0.1665; const BILLED_A = 33_000;
// REPLY_B (b.ts): input=60_000 (cacheRead=50_000, cacheWrite=5_000 -> uncached=5_000), output=3_000 (1_000 reasoning).
//   cost = 5_000/1e6*3 + 50_000/1e6*0.3 + 3_000/1e6*15 + 5_000/1e6*3.75 = 0.015 + 0.015 + 0.045 + 0.01875 = 0.09375
//   billed = 5_000 + 5_000 + 3_000 + ceil(0.1*50_000=5_000) = 18_000
const REPLY_B = { input: 60_000, cacheRead: 50_000, cacheWrite: 5_000, output: 3_000, reasoning: 1_000 };
const COST_B = 0.09375; const BILLED_B = 18_000;
// REPLY_C (c.ts): input=40_000 (cacheRead=30_000, cacheWrite=4_000 -> uncached=6_000), output=2_000 (500 reasoning).
//   cost = 6_000/1e6*3 + 30_000/1e6*0.3 + 2_000/1e6*15 + 4_000/1e6*3.75 = 0.018 + 0.009 + 0.03 + 0.015 = 0.072
//   billed = 6_000 + 4_000 + 2_000 + ceil(0.1*30_000=3_000) = 15_000
const REPLY_C = { input: 40_000, cacheRead: 30_000, cacheWrite: 4_000, output: 2_000, reasoning: 500 };
const COST_C = 0.072; const BILLED_C = 15_000;
// REPLY_COMBINE: input=20_000 (no cache at all), output=3_000 (500 reasoning).
//   cost = 20_000/1e6*3 + 3_000/1e6*15 = 0.06 + 0.045 = 0.105
//   billed = 20_000 + 3_000 = 23_000
const REPLY_COMBINE = { input: 20_000, output: 3_000, reasoning: 500 };
const COST_COMBINE = 0.105; const BILLED_COMBINE = 23_000;

const THREE_STEP_DOC = {
  goal: 'Review three files, then sum up',
  steps: [
    { id: 'review', kind: 'map', specialist: 'reviewer', task: 'Review {item}', summary: 'Plain sentence.', items: ['a.ts', 'b.ts', 'c.ts'] },
    { id: 'sum', kind: 'combine', specialist: 'reviewer', task: 'Combine the reviews', summary: 'Plain sentence.', of: 'review' },
  ],
};
const isCombine = (p: string) => p.includes('Combine the reviews');
/** a.ts/b.ts/c.ts -> REPLY_A/B/C; the combine step -> REPLY_COMBINE. */
const threeStepReply = (call: ChildCall): Reply => {
  if (isCombine(call.prompt)) return report('COMBINED', REPLY_COMBINE);
  if (call.prompt.includes('a.ts')) return report('REPORT a', REPLY_A);
  if (call.prompt.includes('b.ts')) return report('REPORT b', REPLY_B);
  return report('REPORT c', REPLY_C);
};
const attemptFor = (attempts: any[], itemIndex: number) => attempts.find((a) => a.itemIndex === itemIndex);

function lastUserText(prompt: any[]): string {
  const users = prompt.filter((m) => m.role === 'user');
  const last = users[users.length - 1];
  if (!last) return '';
  return typeof last.content === 'string' ? last.content : last.content.map((p: any) => p.text ?? '').join('');
}

const proposeStep = (id: string, doc: unknown) => stream(toolCallChunk(id, 'propose_plan', doc), usageFinish('tool-calls', { input: 5, output: 5 }));
const textStep = (t: string) => stream(...textChunks(`t${Math.random()}`, t), usageFinish('stop', { input: 5, output: 5 }));

const factory = async (binding: { modelId: string; providerId: string }) => {
  if (binding.modelId === PARENT.modelId) {
    return new MockLanguageModelV4({
      doStream: async () => {
        const next = parentSteps.shift() ?? textStep('ok');
        return { stream: simulateReadableStream({ chunks: next }) };
      },
    }) as any;
  }
  return new MockLanguageModelV4({
    doStream: async (options: any) => {
      const call: ChildCall = { prompt: lastUserText(options.prompt), providerId: binding.providerId, modelId: binding.modelId };
      childCalls.push(call);
      const reply = childReply(call, childCalls.length);
      if (reply === 'hang') {
        return {
          stream: new ReadableStream({
            start(c) {
              openStreams.push(c);
              c.enqueue({ type: 'stream-start', warnings: [] });
              options.abortSignal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
            },
          }),
        };
      }
      if (reply.after) {
        const gate = reply.after;
        return {
          stream: new ReadableStream({
            async start(c) {
              await gate;
              for (const chunk of stream(...reply.chunks)) c.enqueue(chunk);
              c.close();
            },
          }),
        };
      }
      return { stream: simulateReadableStream({ chunks: stream(...reply.chunks) }) };
    },
  }) as any;
};

function makeHost(): NativeSessionHost {
  const home = new NativeHome(root);
  const h = new NativeSessionHost(
    new SessionStore(home), factory as any, NO_CONTEXT,
    async (binding: { providerId: string }) => (binding.providerId === 'chatgpt' ? 'chatgpt' : 'openrouter'),
    async () => null,
    // ChatGPT has no published rate (design §4/§7, decision 34 Q-1/Q-5);
    // every other provider gets the catalog-shaped rate card above.
    async (binding: { providerId: string }) => (binding.providerId === 'chatgpt' ? null : PRICING),
    undefined, undefined, { modelCatalog: async () => CATALOG },
    undefined, undefined, home, undefined, undefined, {},
    { settleDeadlineMs: 60, heartbeatMs: 5_000, slotPollMs: 5 },
  );
  h.on('transcript-event', (e) => events.push(e));
  h.on('plans-event', (e) => planEvents.push(e));
  return h;
}

const journalPath = () => path.join(root, '.youcoded', 'sessions', nativeStoreSlug(root), `${SID}.plans.json`);
const journal = () => JSON.parse(fs.readFileSync(journalPath(), 'utf8'));
const plan = (planId: string) => journal().plans.find((p: any) => p.planId === planId);

async function waitFor(cond: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < POLL_TRIES; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function shown(planId: string): any {
  const mine = planEvents.filter((e) => e.sessionId === SID && e.plan.planId === planId).map((e) => e.plan);
  return mine.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))[mine.length - 1];
}
const waitForCard = (planId: string, status: string) => waitFor(() => shown(planId)?.status === status, `the "${status}" card`);

/** Every `subagent-usage` event this run reported to the parent conversation —
 *  the exact events the StatusBar's Cost chip sums (session-totals.ts
 *  addSubagentUsage). Summing these, not re-deriving from the journal, is
 *  what proves the CHIP (not just the journal) shows the hand total. */
function chipEvents(): any[] {
  return events.filter((e) => e.type === 'subagent-usage' && e.sessionId === SID);
}
function chipCostTotal(): number {
  return chipEvents().reduce((sum, e) => sum + (typeof e.data.usage.costUsd === 'number' ? e.data.usage.costUsd : 0), 0);
}

async function propose(doc: unknown, toolUseId = 'call-plan'): Promise<string> {
  await host.create({ sessionId: SID, cwd: root, binding: PARENT });
  const before = fs.existsSync(journalPath()) ? journal().plans.length : 0;
  parentSteps = [proposeStep(toolUseId, doc), textStep('Here is the plan.')];
  host.send(SID, 'Make a plan');
  await waitFor(() => fs.existsSync(journalPath()) && journal().plans.length > before, 'the proposal');
  await waitFor(() => host.isIdle(SID), 'the proposing turn to end');
  return journal().plans[before].planId;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-plan-cost-audit-'));
  events = []; planEvents = []; childCalls = []; openStreams = []; parentSteps = [];
  host = makeHost();
});

afterEach(async () => {
  await host.destroyAll();
  for (const c of openStreams) { try { c.close(); } catch { /* already errored by its abort */ } }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});

describe('a 3-specialist parallel split + a combine step, clean finish', () => {
  it('plan.usedUsd, every attempts spentUsd, and the chip total all equal the hand total', async () => {
    const TOTAL_USD = COST_A + COST_B + COST_C + COST_COMBINE;   // 0.43725
    const TOTAL_TOKENS = BILLED_A + BILLED_B + BILLED_C + BILLED_COMBINE;   // 89_000
    childReply = threeStepReply;

    const planId = await propose(THREE_STEP_DOC);
    // Nothing runs before approval — proving the totals below come from the
    // run this test drives, not from some other leftover state.
    expect(childCalls).toHaveLength(0);
    await host.approvePlan(SID, planId);
    await waitForCard(planId, 'completed');
    const done = plan(planId);

    expect(done.usedUsd).toBeCloseTo(TOTAL_USD, 6);
    expect(done.usedTokens).toBe(TOTAL_TOKENS);

    const mapAttempts = done.steps[0].attempts as any[];
    expect(attemptFor(mapAttempts, 0).spentUsd).toBeCloseTo(COST_A, 6);
    expect(attemptFor(mapAttempts, 0).spentTokens).toBe(BILLED_A);
    expect(attemptFor(mapAttempts, 1).spentUsd).toBeCloseTo(COST_B, 6);
    expect(attemptFor(mapAttempts, 1).spentTokens).toBe(BILLED_B);
    expect(attemptFor(mapAttempts, 2).spentUsd).toBeCloseTo(COST_C, 6);
    expect(attemptFor(mapAttempts, 2).spentTokens).toBe(BILLED_C);
    const combineAttempt = done.steps[1].attempts[0];
    expect(combineAttempt.spentUsd).toBeCloseTo(COST_COMBINE, 6);
    expect(combineAttempt.spentTokens).toBe(BILLED_COMBINE);

    // The conversation's Cost chip (session-totals.ts addSubagentUsage) reads
    // exactly these subagent-usage events — one per specialist attempt.
    expect(chipEvents()).toHaveLength(4);
    expect(chipCostTotal()).toBeCloseTo(TOTAL_USD, 6);
  });
});

describe('a spend limit crossed mid-wave', () => {
  it('pauses once with exactly what was reported (no phantom charges); raising it and continuing finishes with nothing double-counted', async () => {
    const planId = await propose(THREE_STEP_DOC);
    // A limit between cost_A alone (0.1665) and cost_A+cost_B (0.26025): the
    // wave-start check only stops a step's NEXT wave (combine), and each of
    // these three specialists has only ONE reply to begin with — nothing
    // left "running" to overshoot with a SECOND request, so the accepted
    // "one reply per running specialist" overshoot is, for this shape, zero:
    // all three should land, and only combine's wave should be prevented.
    // That guarantee holds only if all three have ALREADY passed their own
    // beforeRequest and started sending before any of their sibling's
    // crossing write can set the shared flag — without this barrier the
    // three replies race the flag (verified: an early run of this exact test
    // non-deterministically dropped the third reply entirely, because it
    // hadn't sent yet when a sibling's write crossed the limit first). Same
    // "hold until all have sent" trick plans-lifecycle.integration.test.ts
    // uses to prove real concurrency.
    let releaseAll!: () => void;
    const allSent = new Promise<void>((r) => { releaseAll = r; });
    let sent = 0;
    childReply = (call) => {
      if (isCombine(call.prompt)) return report('COMBINED', REPLY_COMBINE);
      const held = threeStepReply(call) as { chunks: any[] };
      sent++;
      if (sent === 3) releaseAll();
      return { ...held, after: allSent };
    };
    expect(await host.setPlanLimit(SID, planId, { usd: 0.25 })).toMatchObject({ ok: true });
    await host.approvePlan(SID, planId);
    await waitFor(() => sent === 3, 'all three map specialists to send');
    await waitForCard(planId, 'paused');
    // Paused exactly once — no oscillation between pause and running before
    // the user ever touched it.
    const pausedCards = planEvents.filter((e) => e.plan.planId === planId && e.plan.status === 'paused');
    expect(pausedCards).toHaveLength(1);

    const MAP_TOTAL_USD = COST_A + COST_B + COST_C;       // 0.33225
    const MAP_TOTAL_TOKENS = BILLED_A + BILLED_B + BILLED_C;   // 66_000
    const paused = plan(planId);
    expect(paused.paused.kind).toBe('spend-limit');
    expect(paused.paused.limit).toEqual({ usd: 0.25 });
    // The FULL three-reply total — no more, no less: nothing was charged for
    // work that was never reported, and nothing from the never-started
    // combine step leaked in.
    expect(paused.usedUsd).toBeCloseTo(MAP_TOTAL_USD, 6);
    expect(paused.usedTokens).toBe(MAP_TOTAL_TOKENS);
    expect(paused.usedUsd).toBeGreaterThan(0.25);   // it DID cross — the overshoot is real, not zero
    expect(paused.steps[1].attempts).toHaveLength(0);   // combine's wave never started

    // Continue without raising: refused, still at/past the limit.
    expect(await host.resumePlan(SID, planId)).toMatchObject({ ok: false });

    // Raise it and Continue — combine runs and finishes.
    expect(await host.resumePlan(SID, planId, { usd: 10 })).toMatchObject({ ok: true, plan: { status: 'running' } });
    await waitForCard(planId, 'completed');
    const done = plan(planId);

    // Nothing double-counted: the three map attempts are BYTE-IDENTICAL to
    // what they were at the pause (no re-charge, no re-run).
    expect(done.steps[0].attempts).toEqual(paused.steps[0].attempts);
    const TOTAL_USD = MAP_TOTAL_USD + COST_COMBINE;       // 0.43725
    const TOTAL_TOKENS = MAP_TOTAL_TOKENS + BILLED_COMBINE;   // 89_000
    expect(done.usedUsd).toBeCloseTo(TOTAL_USD, 6);
    expect(done.usedTokens).toBe(TOTAL_TOKENS);
    expect(chipCostTotal()).toBeCloseTo(TOTAL_USD, 6);
  });
});

describe('the user presses Stop mid-run', () => {
  it('records only what was reported before Stop — nothing for the hanging in-flight reply', async () => {
    const doc = {
      goal: 'One review, then sum up',
      steps: [
        { id: 'review', kind: 'map', specialist: 'reviewer', task: 'Review {item}', summary: 'Plain sentence.', items: ['a.ts'] },
        { id: 'sum', kind: 'combine', specialist: 'reviewer', task: 'Combine the reviews', summary: 'Plain sentence.', of: 'review' },
      ],
    };
    // REPLY_STOP (tool-call step): input=70_000 (cacheRead=60_000, cacheWrite=0 -> uncached=10_000), output=4_000 (1_500 reasoning).
    //   cost = 10_000/1e6*3 + 60_000/1e6*0.3 + 4_000/1e6*15 + 0 = 0.03 + 0.018 + 0.06 = 0.108
    //   billed = 10_000 + 0 + 4_000 + ceil(0.1*60_000=6_000) = 20_000
    const REPLY_STOP = { input: 70_000, cacheRead: 60_000, cacheWrite: 0, output: 4_000, reasoning: 1_500 };
    const COST_STOP = 0.108; const BILLED_STOP = 20_000;

    const planId = await propose(doc);
    childReply = (call, index) => {
      if (isCombine(call.prompt)) return 'hang';
      return index === 1
        ? { chunks: [toolCallChunk('b-1', 'Bash', { command: 'echo hi' }), usageFinish('tool-calls', REPLY_STOP)] }
        : 'hang';   // this specialist's OWN second step (its final report) never arrives either
    };
    await host.approvePlan(SID, planId);
    await waitFor(() => childCalls.length === 2, "the map specialist's second request to be in flight");
    const res = await host.stopPlan(SID, planId);
    expect(res).toMatchObject({ ok: true, plan: { status: 'stopped' } });
    const stopped = plan(planId);

    expect(stopped.usedUsd).toBeCloseTo(COST_STOP, 6);
    expect(stopped.usedTokens).toBe(BILLED_STOP);
    expect(stopped.steps[1].attempts).toHaveLength(0);   // combine never started
    expect(chipCostTotal()).toBeCloseTo(COST_STOP, 6);
    expect(chipEvents()).toHaveLength(1);
  });
});

describe('a provider error mid-turn, then a retried request', () => {
  it("the failed attempt's usage (whatever the provider may have billed) adds nothing to either total — only the two real replies count", async () => {
    const doc = {
      goal: 'One review, then sum up',
      steps: [
        { id: 'review', kind: 'map', specialist: 'reviewer', task: 'Review {item}', summary: 'Plain sentence.', items: ['a.ts'] },
        { id: 'sum', kind: 'combine', specialist: 'reviewer', task: 'Combine the reviews', summary: 'Plain sentence.', of: 'review' },
      ],
    };
    // STEP1 (a tool-call step that succeeds normally): input=50_000 (cacheRead=0, cacheWrite=8_000 -> uncached=42_000), output=2_000.
    //   cost = 42_000/1e6*3 + 0 + 2_000/1e6*15 + 8_000/1e6*3.75 = 0.126 + 0.03 + 0.03 = 0.186
    //   billed = 42_000 + 8_000 + 2_000 + 0 = 52_000
    const STEP1 = { input: 50_000, cacheRead: 0, cacheWrite: 8_000, output: 2_000 };
    const COST_1 = 0.186; const BILLED_1 = 52_000;
    // STEP2 (the retried step's own successful reply): input=30_000 (cacheRead=25_000, cacheWrite=0 -> uncached=5_000), output=1_500 (600 reasoning).
    //   cost = 5_000/1e6*3 + 25_000/1e6*0.3 + 1_500/1e6*15 + 0 = 0.015 + 0.0075 + 0.0225 = 0.045
    //   billed = 5_000 + 0 + 1_500 + ceil(0.1*25_000=2_500) = 9_000
    const STEP2 = { input: 30_000, cacheRead: 25_000, cacheWrite: 0, output: 1_500, reasoning: 600 };
    const COST_2 = 0.045; const BILLED_2 = 9_000;
    // COMBINE: input=10_000 (no cache), output=1_000. cost = 0.03+0.015=0.045; billed=11_000.
    const REPLY_COMBINE2 = { input: 10_000, output: 1_000 };
    const COST_COMBINE2 = 0.045; const BILLED_COMBINE2 = 11_000;

    const TOTAL_USD = COST_1 + COST_2 + COST_COMBINE2;         // 0.276
    const TOTAL_TOKENS = BILLED_1 + BILLED_2 + BILLED_COMBINE2;   // 72_000

    const planId = await propose(doc);
    const retryable = Object.assign(new Error('rejected'), { statusCode: 429 });
    childReply = (call, index) => {
      if (isCombine(call.prompt)) return report('COMBINED', REPLY_COMBINE2);
      if (index === 1) return { chunks: [toolCallChunk('c1', 'Bash', { command: 'echo hi' }), usageFinish('tool-calls', STEP1)] };
      if (index === 2) return { chunks: [{ type: 'error', error: retryable }] };   // fails — no StepResult, nothing to report
      return report('REPORT a', STEP2);   // withRetry's re-send succeeds
    };
    await host.approvePlan(SID, planId);
    await waitForCard(planId, 'completed');
    const done = plan(planId);

    expect(done.usedUsd).toBeCloseTo(TOTAL_USD, 6);
    expect(done.usedTokens).toBe(TOTAL_TOKENS);
    const mapAttempt = done.steps[0].attempts[0];
    expect(mapAttempt.spentUsd).toBeCloseTo(COST_1 + COST_2, 6);
    expect(mapAttempt.spentTokens).toBe(BILLED_1 + BILLED_2);
    expect(chipCostTotal()).toBeCloseTo(TOTAL_USD, 6);
  });
});

describe('a mixed plan — one priced step, one ChatGPT (unpriced) step', () => {
  it('dollars count only the priced step; tokens count both; the limit stays in dollars', async () => {
    const doc = {
      goal: 'One priced review, one unpriced combine',
      steps: [
        { id: 'review', kind: 'map', specialist: 'reviewer', task: 'Review {item}', summary: 'Plain sentence.', items: ['a.ts'] },
        { id: 'sum', kind: 'combine', specialist: 'reviewer', task: 'Combine the reviews', summary: 'Plain sentence.', of: 'review' },
      ],
    };
    // REPLY_MIX_MAP (priced, openrouter): input=45_000 (cacheRead=40_007, cacheWrite=0 -> uncached=4_993), output=2_500 (800 reasoning).
    //   A deliberately NON-round cache-read count here (unlike the other
    //   scenarios' round numbers) so this assertion actually distinguishes
    //   Math.ceil from Math.floor/round on the cache-read term — proven by
    //   mutation: swapping pricing.ts's ceil for floor turns this assertion
    //   red (11_494 -> 11_493) while every round-number scenario elsewhere in
    //   this file stays green, since 0.1 * a multiple of 10_000 never has a
    //   fractional remainder to round away.
    //   cost = 4_993/1e6*3 + 40_007/1e6*0.3 + 2_500/1e6*15 + 0 = 0.014979 + 0.0120021 + 0.0375 = 0.0644811
    //   billed = 4_993 + 0 + 2_500 + ceil(0.1*40_007=4_000.7 -> 4_001) = 11_494
    const REPLY_MIX_MAP = { input: 45_000, cacheRead: 40_007, cacheWrite: 0, output: 2_500, reasoning: 800 };
    const COST_MIX_MAP = 0.0644811; const BILLED_MIX_MAP = 11_494;
    // REPLY_MIX_COMBINE (ChatGPT, unpriced): input=15_000, output=2_000. costUsd is null — tokens still count.
    //   billed = 15_000 + 0 + 2_000 + 0 = 17_000
    const REPLY_MIX_COMBINE = { input: 15_000, output: 2_000 };
    const BILLED_MIX_COMBINE = 17_000;

    const planId = await propose(doc);
    // Design §5: an explicit per-step model override, allowed before the step
    // starts. The combine step moves to a ChatGPT binding — no published rate.
    expect(await host.setPlanStepModel(SID, planId, 'sum', { providerId: 'chatgpt', modelId: CHATGPT_MODEL })).toMatchObject({ ok: true });
    // Design §4: a mixed plan's estimate is a DOLLAR range over the priced
    // steps only (never the fully-unpriced {tokens,unpricedNote} shape).
    expect('lowUsd' in plan(planId).estimate).toBe(true);
    // Design §7: the limit stays in dollars because a priced step exists.
    expect(await host.setPlanLimit(SID, planId, { usd: 5 })).toMatchObject({ ok: true });

    childReply = (call) => (isCombine(call.prompt) ? report('COMBINED', REPLY_MIX_COMBINE) : report('REPORT a', REPLY_MIX_MAP));
    await host.approvePlan(SID, planId);
    await waitForCard(planId, 'completed');
    const done = plan(planId);

    // Dollars: ONLY the priced step's cost.
    expect(done.usedUsd).toBeCloseTo(COST_MIX_MAP, 6);
    // Tokens: BOTH steps, regardless of price.
    expect(done.usedTokens).toBe(BILLED_MIX_MAP + BILLED_MIX_COMBINE);
    const mapAttempt = done.steps[0].attempts[0];
    const combineAttempt = done.steps[1].attempts[0];
    expect(mapAttempt.spentUsd).toBeCloseTo(COST_MIX_MAP, 6);
    expect(mapAttempt.spentTokens).toBe(BILLED_MIX_MAP);
    expect(combineAttempt.spentUsd).toBeUndefined();   // never charged
    expect(combineAttempt.spentTokens).toBe(BILLED_MIX_COMBINE);

    // The chip: one priced event, one unpriced (costUsd null) event; only the
    // priced one contributes to the dollar total (session-totals.ts addUsage).
    const mixEvents = chipEvents();
    expect(mixEvents).toHaveLength(2);
    const chatgptEvent = mixEvents.find((e) => e.data.model === CHATGPT_MODEL);
    expect(chatgptEvent.data.usage.costUsd).toBeNull();
    expect(chipCostTotal()).toBeCloseTo(COST_MIX_MAP, 6);
  });
});

describe('a restart mid-plan (recovery)', () => {
  it('the abandoned in-flight request adds no charge; the restart adds only its own real usage', async () => {
    const doc = {
      goal: 'One review, then sum up',
      steps: [
        { id: 'review', kind: 'map', specialist: 'reviewer', task: 'Review {item}', summary: 'Plain sentence.', items: ['a.ts'] },
        { id: 'sum', kind: 'combine', specialist: 'reviewer', task: 'Combine the reviews', summary: 'Plain sentence.', of: 'review' },
      ],
    };
    // REPLY_RECOVER_1 (map, before the quit): input=35_000 (cacheRead=0, cacheWrite=6_000 -> uncached=29_000), output=1_800.
    //   cost = 29_000/1e6*3 + 0 + 1_800/1e6*15 + 6_000/1e6*3.75 = 0.087 + 0.027 + 0.0225 = 0.1365
    //   billed = 29_000 + 6_000 + 1_800 + 0 = 36_800
    const REPLY_RECOVER_1 = { input: 35_000, cacheRead: 0, cacheWrite: 6_000, output: 1_800 };
    const COST_R1 = 0.1365; const BILLED_R1 = 36_800;
    // REPLY_RECOVER_2 (combine, after the restart): input=18_000 (cacheRead=15_000, cacheWrite=0 -> uncached=3_000), output=1_200 (400 reasoning).
    //   cost = 3_000/1e6*3 + 15_000/1e6*0.3 + 1_200/1e6*15 + 0 = 0.009 + 0.0045 + 0.018 = 0.0315
    //   billed = 3_000 + 0 + 1_200 + ceil(0.1*15_000=1_500) = 5_700
    const REPLY_RECOVER_2 = { input: 18_000, cacheRead: 15_000, cacheWrite: 0, output: 1_200, reasoning: 400 };
    const COST_R2 = 0.0315; const BILLED_R2 = 5_700;

    const planId = await propose(doc);
    // Keyed by CALL INDEX, not prompt content: a resumed specialist's restart
    // brief (plan-executor.ts's PLAN_RESTART_BRIEF) never repeats the original
    // task text, so matching on the prompt string would silently misclassify
    // the post-restart request as the map step's own — call 1 is the map
    // specialist's only reply, call 2 is combine's first (hanging) request,
    // call 3 is combine's restart after reopening.
    childReply = (_call, index) => (index === 1 ? report('REPORT a', REPLY_RECOVER_1) : 'hang');
    await host.approvePlan(SID, planId);
    await waitFor(() => childCalls.length === 2, 'the combine specialist to send');
    const beforeQuit = plan(planId);
    expect(beforeQuit.usedUsd).toBeCloseTo(COST_R1, 6);   // combine's hanging request reported nothing yet

    // App quit mid-plan: the combine specialist's request was in flight and
    // never got a usage report.
    await host.destroyAll();
    expect(plan(planId).status).toBe('interrupted');

    // Reopen and Continue: nothing was ever reserved against the cut-off
    // request, so there is nothing to recover except restarting it.
    host = makeHost();
    expect(await host.resume(SID, root)).toBe(true);
    childReply = () => report('COMBINED', REPLY_RECOVER_2);   // combine's restart (call 3)
    expect(await host.resumePlan(SID, planId)).toMatchObject({ ok: true, plan: { status: 'running' } });
    await waitForCard(planId, 'completed');
    const done = plan(planId);

    const TOTAL_USD = COST_R1 + COST_R2;         // 0.168
    const TOTAL_TOKENS = BILLED_R1 + BILLED_R2;   // 42_500
    expect(done.usedUsd).toBeCloseTo(TOTAL_USD, 6);
    expect(done.usedTokens).toBe(TOTAL_TOKENS);
    // Combine has exactly ONE attempt — it continued the same specialist
    // session, not a fresh charge stacked on top of a phantom first one.
    expect(done.steps[1].attempts).toHaveLength(1);
    expect(done.steps[1].attempts[0].spentUsd).toBeCloseTo(COST_R2, 6);
    expect(chipCostTotal()).toBeCloseTo(TOTAL_USD, 6);
  });
});

