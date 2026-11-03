// Does our arithmetic agree with the provider's own bill? `costForUsage` multiplies tokens by a published rate card; OpenRouter reports its own
// per-request figure in the usage block. THE RULE: an absent provider figure must never read as zero, and never as agreement.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { streamText } from 'ai';
import { NativeHome } from '../src/main/native-home';
import { SecretsStore } from '../src/main/providers/secrets-store';
import { getSecretStorage } from '../src/main/providers/secret-storage';
import { ProviderRegistry } from '../src/main/providers/provider-registry';
import {
  providerCostFromMetadata, costDisagreement,
  COST_DISAGREEMENT_THRESHOLD, COST_COMPARE_FLOOR_USD,
  addComparableTurn, sessionCostDisagreement, modelCostDisagreements, NO_SESSION_COST_TOTALS,
  COST_GAP_RELOG_FACTOR,
} from '../src/main/harness/pricing';

// A streamed OpenRouter response in the documented wire shape. PROVENANCE: the usage block is OpenRouter's own documented example (Usage
// Accounting docs), NOT a capture of a live billed request — it pins that we read the documented shape, not that our dollars match a real bill.
function openRouterSse(
  usage: Record<string, unknown> | null,
  opts: { thenASilentChunk?: boolean } = {},
): string {
  const lines = [
    `data: ${JSON.stringify({ id: 'gen-1', object: 'chat.completion.chunk', model: 'openai/gpt-4o', choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ id: 'gen-1', object: 'chat.completion.chunk', model: 'openai/gpt-4o', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
  ];
  if (usage) {
    // OpenRouter sends usage in its LAST SSE message, in a chunk with an empty choices array — the case a naive extractor skips.
    lines.push(`data: ${JSON.stringify({ id: 'gen-1', object: 'chat.completion.chunk', model: 'openai/gpt-4o', choices: [], usage })}`);
  }
  if (opts.thenASilentChunk) {
    // SYNTHETIC: exercises the extractor's "only a real reading overwrites" guard (a later chunk with no usage must not erase an earlier figure).
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
    reg = new ProviderRegistry(new NativeHome(root), new SecretsStore(root, getSecretStorage()));
    await reg.init();
    await reg.setKey('openrouter', 'sk-or-test');
  });
  afterEach(() => { vi.unstubAllGlobals(); fs.rmSync(root, { recursive: true, force: true }); });

  /** Runs one real streamText turn against a stubbed HTTP response: the only way to express a raw `cost` field, which sits BELOW the SDK-level doStream parts other stubs use. */
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

  // WHY: deleting the "only a real reading overwrites" guard used to turn nothing red.
  it('keeps the figure an earlier chunk carried when a later chunk carries none', async () => {
    const { meta } = await turnAgainst(openRouterSse(RECORDED_USAGE, { thenASilentChunk: true }));
    expect(providerCostFromMetadata(meta)).toBeCloseTo(0.95, 10);
  });

  // WHY: the old guard only checked no `transformRequestBody` hook existed, while the body still carried the inert `stream_options`; assert on the body itself.
  it('asks for the cost in NO request-body parameter — the ones that would are documented no-ops', async () => {
    const { sentBody } = await turnAgainst(openRouterSse(RECORDED_USAGE));
    // OpenRouter's docs call both "deprecated and have no effect"; the read side is the metadataExtractor.
    expect(sentBody.usage).toBeUndefined();
    expect(sentBody.stream_options).toBeUndefined();
    // Non-vacuity: an empty body cannot pass.
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

// COST_COMPARE_FLOOR_USD applied PER TURN never fires on a cheap model (~$0.00034/turn forever), so the session keeps a running pair.
// THE PAIR IS THE POINT: a turn enters BOTH sums or NEITHER, so a partial provider total never sits beside a complete cost total.
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

  // WHY: the session sum stays quiet when a correct model ran most turns, so the per-model pair catches the mis-priced one.
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

// WHY (step-vs-turn trap): the provider reports per REQUEST while `costForUsage` prices a whole TURN of N steps, so a turn where only some steps
// reported a cost must report NO provider figure at all, never compare part of a bill against all of a turn.
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { HarnessSession } from '../src/main/harness/harness-session';
import { makeOpts, fakeTool } from './helpers/harness-fakes';
import { textChunks, stream } from './helpers/scripted-model';
import { log } from '../src/main/logger';

vi.mock('../src/main/logger', () => ({ log: vi.fn(), rotateLog: vi.fn() }));

/** One step's finish part, optionally carrying an OpenRouter cost (`cost: undefined` = a provider that reported nothing). */
function finishWithCost(reason: string, inTok: number, outTok: number, cost?: number) {
  return {
    type: 'finish',
    finishReason: { unified: reason, raw: reason },
    usage: { inputTokens: { total: inTok }, outputTokens: { total: outTok } },
    ...(cost === undefined ? {} : { providerMetadata: { openrouter: { costUsd: cost } } }),
  };
}

/** A model that replays one scripted step per doStream call. */
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

/** Every cost diagnostic logged, split into the per-turn line (localises a fault) and the session line (catches what the per-turn floor hides). */
const costWarnings = () => vi.mocked(log).mock.calls.filter((c) => /cost/i.test(String(c[2])));
const turnWarnings = () => costWarnings().filter((c) => /for this turn/.test(String(c[2])));
const sessionWarnings = () => costWarnings().filter((c) => /across this session/.test(String(c[2])));

describe('the provider’s figure rides the turn beside ours', () => {
  beforeEach(() => { vi.mocked(log).mockClear(); });

  it('sums the provider’s per-request figures across the turn’s steps', async () => {
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
    expect('providerCostUsd' in usage).toBe(false);
  });

  it('keeps a reported zero — a free model that billed nothing DID report', async () => {
    // `free` is resolved by the HOST from the provider type, so the fixture states both.
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
    // One turn is the whole session, so the session line fires too.
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

/** Runs several single-step turns on ONE session (a session accumulator needs one) and returns each turn-complete usage.
 *  `sendCount` < steps.length stages a multi-step turn; `betweenTurns` runs mid-conversation (e.g. /clear). */
async function sessionOfTurns(
  turns: { inTok: number; outTok: number; cost?: number; tool?: boolean }[],
  over: Record<string, unknown> = {},
  betweenTurns?: (session: HarnessSession, justFinished: number) => void,
  sendCount = turns.length,
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
  for (let i = 0; i < sendCount; i++) {
    await session.send(`turn ${i}`);
    betweenTurns?.(session, i);
  }
  return seen.filter((e) => e.type === 'turn-complete').map((e) => e.data.usage);
}
/** Runs ONE turn (possibly several steps) and returns its usage. */
const turnUsage = async (steps: { inTok: number; outTok: number; cost?: number; tool?: boolean }[], over: Record<string, unknown> = {}) =>
  (await sessionOfTurns(steps, over, undefined, 1))[0];

describe('the session sum catches what no single turn could', () => {
  beforeEach(() => { vi.mocked(log).mockClear(); });

  /** A Gemini-Flash-class rate card, in the real units: USD per 1M tokens. */
  const CHEAP = { in: 0.1, out: 0.4 };

  it('never fires per turn on a cheap model, and fires ONCE on the session sum', async () => {
    // 3k in + 100 out at CHEAP: $0.00034 ours vs $0.00017 provider (a 100% systematic error), each a third of the $0.001 floor.
    const turns = Array.from({ length: 8 }, () => ({ inTok: 3000, outTok: 100, cost: 0.00017 }));
    const usage = await sessionOfTurns(turns, { pricing: CHEAP });
    expect(usage).toHaveLength(8);
    expect(usage[0].costUsd).toBeCloseTo(0.00034, 10);
    expect(turnWarnings()).toHaveLength(0);
    // Once, at the sixth turn where the provider's running total first clears the floor; later turns would repeat an identical line.
    expect(sessionWarnings()).toHaveLength(1);
    expect(sessionWarnings()[0][0]).toBe('WARN');
    expect(sessionWarnings()[0][3]).toMatchObject({ comparableTurns: 6, relativeGap: 1 });
  });

  it('never sums a partial provider total against a complete cost total', async () => {
    // Turn two reports nothing and is 100x bigger; summing both of ours ($303) against the provider's one ($3) would fake a 99% gap. The unpaired turn leaves BOTH sums alone.
    await sessionOfTurns([
      { inTok: 1, outTok: 1, cost: 3 },
      { inTok: 100, outTok: 100 },
    ]);
    expect(costWarnings()).toHaveLength(0);
  });

  it('still checks the turns that DID report, dropping the unpaired one from OUR side too', async () => {
    // The logged figures must be exactly $3 and $6; $303 on our side would mean the unpaired turn leaked in.
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

  // WHY: a one-shot line goes permanently deaf on cheap models (per-turn is below the floor forever), so a gap that WORSENS must re-log.
  it('re-logs once the gap has WORSENED by the escalation factor — never deaf, never per-turn', async () => {
    // Turns 1-6: double the provider's charge; first line at turn six (gap 1.0). Turns 7-13: a rate-card regression mid-session; by turn 13 the gap passed 3x the one on record.
    const turns = [
      ...Array.from({ length: 6 }, () => ({ inTok: 3000, outTok: 100, cost: 0.00017 })),
      ...Array.from({ length: 7 }, () => ({ inTok: 3000, outTok: 100, cost: 0.000001 })),
    ];
    await sessionOfTurns(turns, { pricing: CHEAP });
    expect(turnWarnings()).toHaveLength(0);
    expect(sessionWarnings()).toHaveLength(2);
    expect(sessionWarnings()[0][3]).toMatchObject({ comparableTurns: 6, relativeGap: 1 });
    const escalated = sessionWarnings()[1][3] as { comparableTurns: number; relativeGap: number };
    expect(escalated.comparableTurns).toBe(13);
    expect(escalated.relativeGap).toBeGreaterThanOrEqual(1 * COST_GAP_RELOG_FACTOR);
  });

  it('stays on ONE line while the gap worsens by less than the factor', async () => {
    // Stopped one turn earlier the gap is ~2.98: worse, but not the step-change that means something new.
    const turns = [
      ...Array.from({ length: 6 }, () => ({ inTok: 3000, outTok: 100, cost: 0.00017 })),
      ...Array.from({ length: 6 }, () => ({ inTok: 3000, outTok: 100, cost: 0.000001 })),
    ];
    await sessionOfTurns(turns, { pricing: CHEAP });
    expect(sessionWarnings()).toHaveLength(1);
    expect(sessionWarnings()[0][3]).toMatchObject({ comparableTurns: 6, relativeGap: 1 });
  });

  // WHY: /clear is a CONTEXT barrier, not a state reset; these sums measure OUR pricing arithmetic, a property of the code.
  it('/clear does NOT reset the running cost sums', async () => {
    // Resetting on /clear would silence the check at turn six, exactly where it fires.
    const turns = Array.from({ length: 6 }, () => ({ inTok: 3000, outTok: 100, cost: 0.00017 }));
    await sessionOfTurns(turns, { pricing: CHEAP }, (session, justFinished) => {
      if (justFinished === 4) expect(session.clearHistory()).toEqual({ ok: true });
    });
    expect(sessionWarnings()).toHaveLength(1);
    // Six comparable turns, not the one turn since the clear.
    expect(sessionWarnings()[0][3]).toMatchObject({ comparableTurns: 6, relativeGap: 1 });
  });
});
