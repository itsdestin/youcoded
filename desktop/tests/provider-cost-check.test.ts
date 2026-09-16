// Does our arithmetic agree with the provider's own bill? (Plan Task 27.)
//
// `costForUsage` multiplies tokens by a published rate card. Nothing checked
// that answer against the only authority that matters — what the provider
// actually charged. OpenRouter reports its own per-request figure in the usage
// block of every response, so the app can now check itself.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: an absent provider figure must never
// read as zero, and never as agreement. Only OpenRouter-shaped providers report
// one. A local model, an Anthropic key, a plain OpenAI-compatible endpoint —
// all report nothing, and "nothing" is a different state from "we checked and
// it matched" (the same distinction pricing.ts already draws between null and
// absent).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { streamText } from 'ai';
import { NativeHome } from '../src/main/native-home';
import { SecretsStore } from '../src/main/providers/secrets-store';
import { ProviderRegistry } from '../src/main/providers/provider-registry';
import {
  providerCostFromMetadata, costDisagreement,
  COST_DISAGREEMENT_THRESHOLD, COST_COMPARE_FLOOR_USD,
  addComparableTurn, sessionCostDisagreement, modelCostDisagreements, NO_SESSION_COST_TOTALS,
  COST_GAP_RELOG_FACTOR,
} from '../src/main/harness/pricing';

// A streamed OpenRouter response, byte-for-byte in the wire shape OpenRouter
// publishes for it. PROVENANCE, stated plainly so no later reader over-trusts
// it: the usage block is OpenRouter's own documented example (Usage Accounting,
// openrouter.ai/docs/use-cases/usage-accounting, fetched 2026-08-27), NOT a
// capture of a live billed request — nobody here has spent real money on a real
// model to record one. It pins that we read the shape OpenRouter documents; it
// does NOT establish that our dollar figure matches a real bill.
function openRouterSse(
  usage: Record<string, unknown> | null,
  opts: { thenASilentChunk?: boolean } = {},
): string {
  const lines = [
    `data: ${JSON.stringify({ id: 'gen-1', object: 'chat.completion.chunk', model: 'openai/gpt-4o', choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ id: 'gen-1', object: 'chat.completion.chunk', model: 'openai/gpt-4o', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
  ];
  if (usage) {
    // OpenRouter sends the usage block in its LAST SSE message, in a chunk with
    // an empty choices array — the case a naive extractor skips.
    lines.push(`data: ${JSON.stringify({ id: 'gen-1', object: 'chat.completion.chunk', model: 'openai/gpt-4o', choices: [], usage })}`);
  }
  if (opts.thenASilentChunk) {
    // SYNTHETIC, said plainly so nobody over-trusts it: nobody here has seen
    // OpenRouter send a chunk AFTER its usage block. This exists to exercise
    // the extractor's "last one wins, but only a real reading overwrites"
    // guard — a figure an earlier chunk carried must survive a later chunk
    // that carries none. Every other fixture puts the usage in the final
    // chunk, so without this the guard is never exercised at all.
    lines.push(`data: ${JSON.stringify({ id: 'gen-1', object: 'chat.completion.chunk', model: 'openai/gpt-4o', choices: [] })}`);
  }
  lines.push('data: [DONE]');
  return lines.map((l) => `${l}\n\n`).join('');
}

/** The full usage block from OpenRouter's documented example. */
const RECORDED_USAGE = {
  completion_tokens: 2,
  completion_tokens_details: { reasoning_tokens: 0 },
  cost: 0.95,
  cost_details: { upstream_inference_cost: 19 },
  prompt_tokens: 194,
  prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 100, audio_tokens: 0 },
  total_tokens: 196,
};

/** A usage block from a plain OpenAI-compatible server: token counts, no cost.
 *  This is the shape EVERY non-OpenRouter provider produces. */
const USAGE_WITHOUT_COST = { completion_tokens: 2, prompt_tokens: 194, total_tokens: 196 };

function sseResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('reading the provider’s own cost off a recorded response', () => {
  let root: string; let reg: ProviderRegistry;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-provcost-'));
    reg = new ProviderRegistry(new NativeHome(root), new SecretsStore(root));
    await reg.init();
    await reg.setKey('openrouter', 'sk-or-test');
  });
  afterEach(() => { vi.unstubAllGlobals(); fs.rmSync(root, { recursive: true, force: true }); });

  /** Runs one real streamText turn against a stubbed HTTP response and returns
   *  what the provider metadata carried. This is the only way to express a raw
   *  `cost` field in a test: every other stub in this repo returns SDK-level
   *  doStream parts, which sit ABOVE where `usage.cost` lives on the wire. */
  async function turnAgainst(body: string): Promise<{ meta: any; sentBody: any }> {
    let sentBody: any;
    vi.stubGlobal('fetch', async (_url: any, init: any) => {
      sentBody = JSON.parse(init.body);
      return sseResponse(body);
    });
    const model = await reg.languageModel({ providerId: 'openrouter', modelId: 'openai/gpt-4o' });
    const result = streamText({ model: model as any, prompt: 'hi' });
    for await (const _ of result.textStream) { /* drain */ }
    return { meta: await result.providerMetadata, sentBody };
  }

  it('surfaces OpenRouter’s own per-request cost as provider metadata', async () => {
    const { meta } = await turnAgainst(openRouterSse(RECORDED_USAGE));
    expect(providerCostFromMetadata(meta)).toBeCloseTo(0.95, 10);
  });

  it('reports NOTHING — not zero — when the response carries no cost field', async () => {
    const { meta } = await turnAgainst(openRouterSse(USAGE_WITHOUT_COST));
    // The distinction this whole file is about: undefined, never 0.
    expect(providerCostFromMetadata(meta)).toBeUndefined();
  });

  it('reports NOTHING when the response carries no usage block at all', async () => {
    const { meta } = await turnAgainst(openRouterSse(null));
    expect(providerCostFromMetadata(meta)).toBeUndefined();
  });

  it('keeps a genuine zero — a :free model billed nothing IS a reported figure', async () => {
    const { meta } = await turnAgainst(openRouterSse({ ...RECORDED_USAGE, cost: 0 }));
    expect(providerCostFromMetadata(meta)).toBe(0);
  });

  // Plan Task 30 item 4. The extractor only overwrites its running figure with
  // a REAL reading; a later chunk with no usage block must leave the earlier
  // one standing. Deleting that guard used to turn nothing red.
  it('keeps the figure an earlier chunk carried when a later chunk carries none', async () => {
    const { meta } = await turnAgainst(openRouterSse(RECORDED_USAGE, { thenASilentChunk: true }));
    expect(providerCostFromMetadata(meta)).toBeCloseTo(0.95, 10);
  });

  // Plan Task 30 items 2 + 3. The old guard for this claim asserted only that
  // no `transformRequestBody` hook was installed — which stayed true while the
  // body itself still carried `stream_options: { include_usage: true }`, the
  // very parameter the code's own comment quotes OpenRouter calling inert.
  // The request body is the thing the claim is about, so assert on the body.
  it('asks for the cost in NO request-body parameter — the ones that would are documented no-ops', async () => {
    const { sentBody } = await turnAgainst(openRouterSse(RECORDED_USAGE));
    // OpenRouter's Usage Accounting docs (fetched 2026-08-27) call both of
    // these "deprecated and have no effect": full usage details are always
    // included now. The read side is the metadataExtractor; the body is left
    // exactly as the SDK builds it.
    expect(sentBody.usage).toBeUndefined();
    expect(sentBody.stream_options).toBeUndefined();
    // Not a body assertion by mistake: the turn really did happen and really
    // did carry a cost, so an empty/undefined body cannot pass this test.
    expect(sentBody.model).toBe('openai/gpt-4o');
  });
});

describe('providerCostFromMetadata', () => {
  it('returns undefined for absent, empty, or non-numeric metadata', () => {
    expect(providerCostFromMetadata(undefined)).toBeUndefined();
    expect(providerCostFromMetadata({})).toBeUndefined();
    expect(providerCostFromMetadata({ openrouter: {} })).toBeUndefined();
    expect(providerCostFromMetadata({ openrouter: { costUsd: 'lots' } } as any)).toBeUndefined();
    expect(providerCostFromMetadata({ openrouter: { costUsd: NaN } })).toBeUndefined();
    // Another provider's metadata is not a cost report.
    expect(providerCostFromMetadata({ anthropic: { costUsd: 3 } } as any)).toBeUndefined();
  });
});

describe('costDisagreement', () => {
  it('is null when the provider reported nothing — absence is never agreement', () => {
    expect(costDisagreement(1, undefined)).toBeNull();
  });

  it('is null when we have no figure of our own (no published rate, or free)', () => {
    expect(costDisagreement(null, 1)).toBeNull();
    expect(costDisagreement(undefined, 1)).toBeNull();
  });

  it('is null below the comparison floor, where rounding dominates the ratio', () => {
    expect(costDisagreement(0, COST_COMPARE_FLOOR_USD / 2)).toBeNull();
    expect(costDisagreement(1, 0)).toBeNull();
  });

  it('is the relative gap against the provider’s figure, which is the authority', () => {
    expect(costDisagreement(0.9, 1)!).toBeCloseTo(0.1, 10);
    expect(costDisagreement(1.1, 1)!).toBeCloseTo(0.1, 10);   // symmetric — over-reporting counts
    expect(costDisagreement(1, 1)).toBe(0);
  });

  it('has a threshold above the few-percent band the two formulas can honestly differ by', () => {
    expect(COST_DISAGREEMENT_THRESHOLD).toBeGreaterThan(0.02);
    expect(COST_DISAGREEMENT_THRESHOLD).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// The session pair (plan Task 30 item 1).
//
// COST_COMPARE_FLOOR_USD applied PER TURN means the check never fires at all on
// a cheap model: a 3k-in / 100-out turn on a Gemini-Flash-class rate card costs
// about $0.00034, a third of the floor, forever. The sums cross the floor long
// before any single turn does — so the session keeps a running pair.
//
// THE PAIR IS THE POINT. A turn enters BOTH sums or NEITHER, so a session where
// some turns had a provider figure and some did not can never put a PARTIAL
// provider total next to a COMPLETE cost total.
// ---------------------------------------------------------------------------
describe('the session pair — both sums always cover the same turns', () => {
  it('folds a turn in only when BOTH figures exist, and then into both sides', () => {
    let t = addComparableTurn(NO_SESSION_COST_TOTALS, 2, 3);
    expect(t).toEqual({ ourUsd: 2, theirUsd: 3, turns: 1, byModel: {} });
    t = addComparableTurn(t, 100, undefined);   // provider reported nothing
    expect(t).toEqual({ ourUsd: 2, theirUsd: 3, turns: 1, byModel: {} });
    t = addComparableTurn(t, null, 100);        // no published rate of ours
    expect(t).toEqual({ ourUsd: 2, theirUsd: 3, turns: 1, byModel: {} });
    t = addComparableTurn(t, undefined, 100);   // a free turn
    expect(t).toEqual({ ourUsd: 2, theirUsd: 3, turns: 1, byModel: {} });
  });

  it('counts a reported zero — it is a reading, not a silence', () => {
    expect(addComparableTurn(NO_SESSION_COST_TOTALS, 0, 0)).toEqual({ ourUsd: 0, theirUsd: 0, turns: 1, byModel: {} });
  });

  it('never mutates the totals it was handed', () => {
    const start = addComparableTurn(NO_SESSION_COST_TOTALS, 2, 3, 'm-a');
    addComparableTurn(start, 5, 5, 'm-a');
    expect(start).toEqual({ ourUsd: 2, theirUsd: 3, turns: 1, byModel: { 'm-a': { ourUsd: 2, theirUsd: 3, turns: 1 } } });
    expect(NO_SESSION_COST_TOTALS).toEqual({ ourUsd: 0, theirUsd: 0, turns: 0, byModel: {} });
  });

  it('is null when nothing was ever comparable — a 0 there would read as agreement', () => {
    expect(sessionCostDisagreement(NO_SESSION_COST_TOTALS)).toBeNull();
  });

  it('is null while the running total is still under the floor', () => {
    expect(sessionCostDisagreement({ ourUsd: 0.0004, theirUsd: 0.0002, turns: 1, byModel: {} })).toBeNull();
  });

  // 2026-09-16 — closing the dilution finding
  // (docs/active/investigations/2026-09-01-cost-self-check-dilutes-across-model-swap.md):
  // the session sum stays quiet when a correctly-priced model ran most of the
  // turns, so the per-model pair is what catches the mis-priced one.
  it('reports a mis-priced model on its own even when the session sum agrees', () => {
    let t = NO_SESSION_COST_TOTALS;
    for (let i = 0; i < 100; i++) t = addComparableTurn(t, 0.01, 0.01, 'model-a');   // exact match
    for (let i = 0; i < 2; i++) t = addComparableTurn(t, 0.004, 0.002, 'model-b');   // we report double
    // The whole session: 1.008 vs 1.004 — well under the 5% threshold. Silent.
    expect(sessionCostDisagreement(t)!).toBeLessThan(0.01);
    // model-b on its own: 0.008 vs 0.004 (above the floor) — a 100% gap.
    const found = modelCostDisagreements(t);
    expect(found.map((f) => f.modelId)).toEqual(['model-b']);
    expect(found[0].gap).toBeCloseTo(1, 6);
    expect(found[0].totals).toEqual({ ourUsd: 0.008, theirUsd: 0.004, turns: 2 });
  });

  it('stays silent per model while that model’s own pair is under the floor, or agrees', () => {
    let t = addComparableTurn(NO_SESSION_COST_TOTALS, 0.0004, 0.0002, 'cheap'); // under the floor
    t = addComparableTurn(t, 1, 1, 'fine');                                       // agrees
    expect(modelCostDisagreements(t)).toEqual([]);
  });

  it('a turn with no model id still enters the session pair, just not a per-model one', () => {
    const t = addComparableTurn(NO_SESSION_COST_TOTALS, 2, 3);
    expect(t.turns).toBe(1);
    expect(t.byModel).toEqual({});
  });

  it('compares once the SUM crosses the floor, where no single turn ever could', () => {
    // A cheap model, in real numbers: ours $0.00034 a turn, the provider's own
    // half of that. Neither figure can ever be compared on its own.
    let t = NO_SESSION_COST_TOTALS;
    for (let i = 0; i < 5; i++) {
      t = addComparableTurn(t, 0.00034, 0.00017);
      expect(sessionCostDisagreement(t)).toBeNull();
    }
    // Six turns is where the provider's running total first clears $0.001.
    t = addComparableTurn(t, 0.00034, 0.00017);
    expect(sessionCostDisagreement(t)!).toBeCloseTo(1, 6);   // we report double
  });
});

// ---------------------------------------------------------------------------
// Threading the provider's figure through a turn, beside the one we compute.
//
// THE STEP-VS-TURN TRAP (named by the plan): the provider reports per REQUEST,
// while `costForUsage` prices a whole TURN of N steps. Summing both sides is
// only honest while the two sums cover the SAME steps. A turn where some steps
// reported a cost and some did not would compare part of a bill against all of
// a turn — silently, and in the cheap direction. The rule pinned below is that
// such a turn reports NO provider figure at all.
// ---------------------------------------------------------------------------
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { HarnessSession } from '../src/main/harness/harness-session';
import { makeOpts, fakeTool } from './helpers/harness-fakes';
import { textChunks, stream } from './helpers/scripted-model';
import { log } from '../src/main/logger';

vi.mock('../src/main/logger', () => ({ log: vi.fn(), rotateLog: vi.fn() }));

/** One step's finish part, optionally carrying an OpenRouter cost the way the
 *  metadataExtractor above delivers it. `cost: undefined` stages a provider
 *  that reported nothing — the common case. */
function finishWithCost(reason: string, inTok: number, outTok: number, cost?: number) {
  return {
    type: 'finish',
    finishReason: { unified: reason, raw: reason },
    usage: { inputTokens: { total: inTok }, outputTokens: { total: outTok } },
    ...(cost === undefined ? {} : { providerMetadata: { openrouter: { costUsd: cost } } }),
  };
}

/** A model that replays one scripted step per doStream call. Each step names
 *  its own token counts and (optionally) the provider's own cost figure. */
function costScriptedModel(steps: { inTok: number; outTok: number; cost?: number; tool?: boolean }[]) {
  let call = 0;
  const scripts = steps.map((s, i) => stream(
    ...textChunks(`t${i}`, 'ok'),
    ...(s.tool ? [{ type: 'tool-call', toolCallId: `c${i}`, toolName: 'Noop', input: JSON.stringify({ file_path: 'f' }) }] : []),
    finishWithCost(s.tool ? 'tool-calls' : 'stop', s.inTok, s.outTok, s.cost),
  ));
  return new MockLanguageModelV4({
    doStream: async () => {
      const chunks = scripts[Math.min(call, scripts.length - 1)];
      call++;
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

/** Runs ONE turn and returns the turn-complete usage payload. */
async function turnUsage(
  steps: { inTok: number; outTok: number; cost?: number; tool?: boolean }[],
  over: Record<string, unknown> = {},
) {
  const model = costScriptedModel(steps);
  const session = new HarnessSession(
    makeOpts({
      tools: [fakeTool('Noop')],
      decide: async () => ({ action: 'allow' }) as any,
      pricing: { in: 1_000_000, out: 2_000_000 },   // $1/token in, $2/token out
      ...over,
    }),
    async () => model as any,
  );
  const seen: any[] = [];
  session.on('transcript-event', (e: any) => seen.push(e));
  await session.send('hello');
  return seen.find((e) => e.type === 'turn-complete')!.data.usage;
}

/** Every cost diagnostic the session logged, and the two kinds separately.
 *  There are now two lines with different jobs — one localises a fault to a
 *  single turn, one catches a systematic error the per-turn floor hides — so a
 *  test that means one must not accidentally count the other. */
const costWarnings = () => vi.mocked(log).mock.calls.filter((c) => /cost/i.test(String(c[2])));
const turnWarnings = () => costWarnings().filter((c) => /for this turn/.test(String(c[2])));
const sessionWarnings = () => costWarnings().filter((c) => /across this session/.test(String(c[2])));

describe('the provider’s figure rides the turn beside ours', () => {
  beforeEach(() => { vi.mocked(log).mockClear(); });

  it('sums the provider’s per-request figures across the turn’s steps', async () => {
    // Two steps, each billed by the provider. Ours: (1+1) in + (1+1) out
    // = $2 + $4 = $6, which is what a 3%-off provider figure is compared to.
    const usage = await turnUsage([
      { inTok: 1, outTok: 1, cost: 3, tool: true },
      { inTok: 1, outTok: 1, cost: 3 },
    ]);
    expect(usage.costUsd).toBeCloseTo(6, 10);
    expect(usage.providerCostUsd).toBeCloseTo(6, 10);
  });

  it('omits the provider figure entirely when the provider reported nothing', async () => {
    const usage = await turnUsage([{ inTok: 1, outTok: 1 }]);
    expect(usage.costUsd).toBeCloseTo(3, 10);
    // Absent, NOT 0 — a provider that said nothing did not say "free".
    expect('providerCostUsd' in usage).toBe(false);
  });

  it('omits it when only SOME steps reported one — never compares a step to a turn', async () => {
    const usage = await turnUsage([
      { inTok: 1, outTok: 1, cost: 3, tool: true },
      { inTok: 1, outTok: 1 },                       // this one reported nothing
    ]);
    expect(usage.costUsd).toBeCloseTo(6, 10);
    // A $3 figure covering one of two steps must not be published beside a
    // $6 figure covering both. Absent is the only honest answer.
    expect('providerCostUsd' in usage).toBe(false);
  });

  it('keeps a reported zero — a free model that billed nothing DID report', async () => {
    // `free` is resolved by the HOST from the provider type, not derived here
    // from the rate card, so the fixture states both the way the host would.
    const usage = await turnUsage([{ inTok: 1, outTok: 1, cost: 0 }], { pricing: { in: 0, out: 0 }, free: true });
    expect(usage.free).toBe(true);
    expect(usage.costUsd).toBeNull();
    expect(usage.providerCostUsd).toBe(0);
  });

  it('logs a diagnostic line when the two figures disagree beyond the threshold', async () => {
    // Ours: $3. Provider: $6 — 50% apart, far above the 5% threshold.
    await turnUsage([{ inTok: 1, outTok: 1, cost: 6 }]);
    const warned = turnWarnings();
    expect(warned).toHaveLength(1);
    expect(warned[0][0]).toBe('WARN');
    // The line must carry BOTH figures — a gap with no numbers is undiagnosable.
    expect(warned[0][3]).toMatchObject({ ourCostUsd: 3, providerCostUsd: 6 });
    // One turn is also the whole session, so the session line fires too, with
    // the same numbers and the count of turns behind them.
    expect(sessionWarnings()).toHaveLength(1);
    expect(sessionWarnings()[0][3]).toMatchObject({ ourCostUsd: 3, providerCostUsd: 6, comparableTurns: 1 });
  });

  it('stays silent when the two agree, and when there is nothing to compare', async () => {
    await turnUsage([{ inTok: 1, outTok: 1, cost: 3 }]);        // exact agreement
    await turnUsage([{ inTok: 1, outTok: 1 }]);                 // provider said nothing
    await turnUsage([{ inTok: 1, outTok: 1, cost: 3 }], { pricing: null });  // we have no rate
    expect(vi.mocked(log).mock.calls.filter((c) => /cost/i.test(String(c[2])))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The same check across the whole SESSION (plan Task 30 item 1).
//
// The per-turn floor is right in itself — below a tenth of a cent the
// provider's own rounding is a large fraction of the figure — but it means the
// check literally never fires on a cheap model. Those turns still add up into
// the figure the status bar shows, so the sums are compared too.
//
// And the step-vs-turn trap repeats here one level up: a session where SOME
// turns published a provider figure and some did not must never sum a partial
// provider total against a complete cost total.
// ---------------------------------------------------------------------------

/** Runs several turns on ONE session and returns each turn-complete usage.
 *  A fresh session per turn cannot exercise a session accumulator, which is
 *  the whole point here. Each entry is one single-step turn. */
async function sessionOfTurns(
  turns: { inTok: number; outTok: number; cost?: number }[],
  over: Record<string, unknown> = {},
  // Runs between turns on the SAME session — the only way to stage something
  // that happens mid-conversation, like /clear, against a running accumulator.
  betweenTurns?: (session: HarnessSession, justFinished: number) => void,
) {
  const model = costScriptedModel(turns);
  const session = new HarnessSession(
    makeOpts({
      tools: [fakeTool('Noop')],
      decide: async () => ({ action: 'allow' }) as any,
      pricing: { in: 1_000_000, out: 2_000_000 },   // $1/token in, $2/token out
      ...over,
    }),
    async () => model as any,
  );
  const seen: any[] = [];
  session.on('transcript-event', (e: any) => seen.push(e));
  for (let i = 0; i < turns.length; i++) {
    await session.send(`turn ${i}`);
    betweenTurns?.(session, i);
  }
  return seen.filter((e) => e.type === 'turn-complete').map((e) => e.data.usage);
}

describe('the session sum catches what no single turn could', () => {
  beforeEach(() => { vi.mocked(log).mockClear(); });

  /** A Gemini-Flash-class rate card, in the real units: USD per 1M tokens. */
  const CHEAP = { in: 0.1, out: 0.4 };

  it('never fires per turn on a cheap model, and fires ONCE on the session sum', async () => {
    // Each turn is 3k in + 100 out — an ordinary turn. At CHEAP that is
    // $0.00034 of ours against $0.00017 of the provider's: we report DOUBLE
    // what was charged, a 100% systematic error. Both figures sit a third of
    // the way to the $0.001 floor, so no single turn can ever be compared.
    const turns = Array.from({ length: 8 }, () => ({ inTok: 3000, outTok: 100, cost: 0.00017 }));
    const usage = await sessionOfTurns(turns, { pricing: CHEAP });
    expect(usage).toHaveLength(8);
    expect(usage[0].costUsd).toBeCloseTo(0.00034, 10);
    // The bug this task is about: with only the per-turn check, this session
    // is silent forever despite being wrong by 100% on every single turn.
    expect(turnWarnings()).toHaveLength(0);
    // Once — not once per turn from there on. The sixth turn is where the
    // provider's running total first clears the floor ($0.00102); turns seven
    // and eight would each repeat an identical line carrying nothing new.
    expect(sessionWarnings()).toHaveLength(1);
    expect(sessionWarnings()[0][0]).toBe('WARN');
    expect(sessionWarnings()[0][3]).toMatchObject({ comparableTurns: 6, relativeGap: 1 });
  });

  it('never sums a partial provider total against a complete cost total', async () => {
    // Turn one: the provider billed $3 and we said $3 — exact agreement.
    // Turn two: the provider reported nothing (a swap to a provider that never
    // does, or a response that omitted the field) and is a hundred times
    // bigger. Summing BOTH of our turns ($303) against the provider's ONE ($3)
    // would read as a 99% disagreement — silently, and always in the direction
    // that says we over-charge. The unpaired turn must leave BOTH sums alone.
    await sessionOfTurns([
      { inTok: 1, outTok: 1, cost: 3 },
      { inTok: 100, outTok: 100 },
    ]);
    expect(costWarnings()).toHaveLength(0);
  });

  it('still checks the turns that DID report, dropping the unpaired one from OUR side too', async () => {
    // Same shape, but now the paired turn genuinely disagrees. The logged
    // figures must be exactly $3 and $6 — that one turn. A $303 on our side
    // would mean the unpaired turn leaked into the sum.
    await sessionOfTurns([
      { inTok: 1, outTok: 1, cost: 6 },
      { inTok: 100, outTok: 100 },
    ]);
    expect(sessionWarnings()).toHaveLength(1);
    expect(sessionWarnings()[0][3]).toMatchObject({
      ourCostUsd: 3, providerCostUsd: 6, comparableTurns: 1,
    });
  });

  it('stays silent across a session whose sums agree', async () => {
    await sessionOfTurns(Array.from({ length: 8 }, () => ({ inTok: 3000, outTok: 100, cost: 0.00034 })), { pricing: CHEAP });
    expect(costWarnings()).toHaveLength(0);
  });

  // A one-shot line would go permanently deaf on exactly the models this check
  // was built for. On an expensive model the per-turn line keeps firing, so a
  // gap that gets worse is still reported turn after turn; on a CHEAP one the
  // per-turn check is below the floor forever, so after that single session
  // line nothing is ever reported again however much worse it gets.
  it('re-logs once the gap has WORSENED by the escalation factor — never deaf, never per-turn', async () => {
    // Turns 1-6: we report double what the provider charged. The sums clear the
    // floor at turn six and the first line fires there, at a gap of 1.0.
    // Turns 7-13: the provider's charge collapses to a rounding-error figure
    // while our rate card keeps charging the old rate — the shape of a
    // rate-card regression landing mid-session. By turn thirteen the gap has
    // passed 3x the gap already on record, which is a different fault from the
    // one that was reported, not a repeat of it.
    const turns = [
      ...Array.from({ length: 6 }, () => ({ inTok: 3000, outTok: 100, cost: 0.00017 })),
      ...Array.from({ length: 7 }, () => ({ inTok: 3000, outTok: 100, cost: 0.000001 })),
    ];
    await sessionOfTurns(turns, { pricing: CHEAP });
    // Nothing here loosens the per-turn floor: every one of these turns is
    // still far too small to compare on its own.
    expect(turnWarnings()).toHaveLength(0);
    expect(sessionWarnings()).toHaveLength(2);
    expect(sessionWarnings()[0][3]).toMatchObject({ comparableTurns: 6, relativeGap: 1 });
    const escalated = sessionWarnings()[1][3] as { comparableTurns: number; relativeGap: number };
    expect(escalated.comparableTurns).toBe(13);
    expect(escalated.relativeGap).toBeGreaterThanOrEqual(1 * COST_GAP_RELOG_FACTOR);
  });

  it('stays on ONE line while the gap worsens by less than the factor', async () => {
    // The same session stopped one turn earlier: twelve turns in, the gap has
    // grown from 1.0 to about 2.98 — worse, but not the step-change that means
    // something new. A line every turn would bury the one that matters.
    const turns = [
      ...Array.from({ length: 6 }, () => ({ inTok: 3000, outTok: 100, cost: 0.00017 })),
      ...Array.from({ length: 6 }, () => ({ inTok: 3000, outTok: 100, cost: 0.000001 })),
    ];
    await sessionOfTurns(turns, { pricing: CHEAP });
    expect(sessionWarnings()).toHaveLength(1);
    expect(sessionWarnings()[0][3]).toMatchObject({ comparableTurns: 6, relativeGap: 1 });
  });

  // /clear is a CONTEXT barrier, not a state reset. These sums measure whether
  // OUR pricing arithmetic matches the provider's bill — a property of the
  // code, not of the conversation the model can still see — so clearing must
  // leave them exactly where they were.
  it('/clear does NOT reset the running cost sums', async () => {
    // Five cheap turns sit under the comparison floor, so nothing has been
    // reported yet; turn six is where the running total first clears it. Reset
    // the sums on /clear and this session goes silent instead — the cheap-model
    // check killed at exactly the point it exists to fire, with the whole suite
    // green.
    const turns = Array.from({ length: 6 }, () => ({ inTok: 3000, outTok: 100, cost: 0.00017 }));
    await sessionOfTurns(turns, { pricing: CHEAP }, (session, justFinished) => {
      if (justFinished === 4) expect(session.clearHistory()).toEqual({ ok: true });
    });
    expect(sessionWarnings()).toHaveLength(1);
    // Six comparable turns, not the one turn since the clear.
    expect(sessionWarnings()[0][3]).toMatchObject({ comparableTurns: 6, relativeGap: 1 });
  });
});
