// Task 1 pins the NEW §2.1 budget planner and candidate validation in isolation.
// The driver tests also exercise the live planner: compaction must not silently
// trim a request, and an infeasible summary leaves accepted history intact.
import { describe, it, expect } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { contextBudget, planContextBudget, selectCompactionCut, summarizePrompt, validateCompactionCandidate, UNKNOWN_CLOUD_WINDOW, UNKNOWN_LOCAL_WINDOW } from '../src/main/harness/compaction';
import { resolveProfile } from '../src/main/harness/capability-profile';
import { messagesTokens } from '../src/main/harness/message-size';
import { makeSession, scriptModel, drainTurn, HARNESS, type ScriptStep } from './helpers/harness-fakes';

// The production output reserve. HARNESS's 256 would make the old and new
// arithmetic coincide and the driver tests below prove nothing.
const PRODUCTION_RESERVE = { ...HARNESS, limits: { maxTokens: 16_000 } };

describe('native compaction budget arithmetic', () => {
  it.each([
    [8192, 2000, 2048, 1548, 256, 5376, 844],
    [32768, 8000, 8192, 6192, 1024, 23040, 3760],
    [272000, 8000, 16000, 13107, 2720, 252768, 20000],
    [500000, 8000, 16000, 13107, 5000, 478488, 20000],
    [1000000, 8000, 16000, 13107, 10000, 973488, 20000],
  ])('plans C=%i with fixed cost %i', (contextLength, fixedCost, replyReserve, summaryAllowance, margin, trigger, tail) => {
    expect(planContextBudget({ contextLength, fixedCost, summaryOverhead: 512, maxTokens: 16000 })).toMatchObject({
      replyReserve, summaryAllowance, margin, trigger, tail,
    });
  });
  it('uses an independent fixed reply reserve; honors provider input limits and distinguishes unknown windows', () => {
    expect(planContextBudget({ contextLength: 32768, providerInputLimit: 12000, fixedCost: 1000, summaryOverhead: 512, maxTokens: 64000 }).contextLength).toBe(12000);
    expect(planContextBudget({ contextLength: 32768, fixedCost: 1000, summaryOverhead: 512, maxTokens: 1000 }).replyReserve).toBe(8192);
    expect(planContextBudget({ contextLength: null, fixedCost: 1000, summaryOverhead: 512, maxTokens: 16000 })).toMatchObject({ contextLength: 32768, estimatedWindow: true });
    expect(planContextBudget({ contextLength: null, providerInputLimit: 8192, fixedCost: 1000, summaryOverhead: 512, maxTokens: 16000 })).toMatchObject({ contextLength: 8192, estimatedWindow: true, replyReserve: 2048 });
    expect(planContextBudget({ contextLength: null, providerInputLimit: 65536, fixedCost: 1000, summaryOverhead: 512, maxTokens: 16000 }).contextLength).toBe(32768);
  });
  it('returns cannot-fit for nonpositive budgets and fixed cost beyond the window', () => {
    expect(planContextBudget({ contextLength: 8192, fixedCost: 9000, summaryOverhead: 512, maxTokens: 16000 }).status).toBe('cannot-fit');
  });
  it('does not reduce summary allowance to a smaller reply cap and accepts reasoning allowance', () => {
    const result = planContextBudget({ contextLength: 272000, fixedCost: 8000, summaryOverhead: 512, maxTokens: 1000, reasoningAllowance: 50000 });
    expect(result.summaryAllowance).toBe(13107);
    expect(result.summaryAllowance).toBeGreaterThan(1000);
    // WHY: reasoning allowance is not the ordinary reply cap in §2.1; it must
    // not pull the request's cap below min(configured max, remaining window).
    expect(planContextBudget({ contextLength: 272000, fixedCost: 8000, summaryOverhead: 512, maxTokens: 16000, reasoningAllowance: 1000 }).replyCap).toBe(16000);
  });
  it('caps ordinary reply output to remaining usable context', () => {
    const result = planContextBudget({ contextLength: 8192, fixedCost: 2000, summaryOverhead: 512, maxTokens: 16000, estimatedInput: 5000 });
    expect(result.replyCap).toBe(2936);
  });
});

describe('candidate validation', () => {
  const plan = planContextBudget({ contextLength: 8192, fixedCost: 2000, summaryOverhead: 512, maxTokens: 16000 });
  it('requires measured candidate under trigger minus tail and a real reduction', () => {
    const original = [{ role: 'user', content: 'x'.repeat(24000) }] as any;
    const short = [{ role: 'user', content: 'brief' }] as any;
    expect(validateCompactionCandidate(plan, original, short)).toBe('fits');
    expect(validateCompactionCandidate(plan, short, short)).toBe('cannot-fit');
  });
  it('accepts a compacted candidate even when the original exhausted its reply cap', () => {
    const original = [{ role: 'user', content: 'x'.repeat(28000) }] as any;
    const candidate = [{ role: 'user', content: 'summary' }] as any;
    const exhausted = planContextBudget({ contextLength: 8192, fixedCost: 2000, summaryOverhead: 512, maxTokens: 16000, estimatedInput: 2000 + 7000 });
    expect(exhausted).toMatchObject({ status: 'cannot-fit', replyCap: 0 });
    expect(validateCompactionCandidate(exhausted, original, candidate)).toBe('fits');
    const intrinsic = planContextBudget({ contextLength: 8192, fixedCost: 9000, summaryOverhead: 512, maxTokens: 16000, estimatedInput: 9000 + 7000 });
    expect(validateCompactionCandidate(intrinsic, original, candidate)).toBe('cannot-fit');
    const noOutput = planContextBudget({ contextLength: 8192, fixedCost: 2000, summaryOverhead: 512, maxTokens: 0, estimatedInput: 9000 });
    expect(validateCompactionCandidate(noOutput, original, candidate)).toBe('cannot-fit');
  });
  it('refuses dense fixed cost or oversized newest indivisible tool batch', () => {
    const dense = planContextBudget({ contextLength: 8192, fixedCost: 5000, summaryOverhead: 512, maxTokens: 16000 });
    const original = [{ role: 'user', content: 'x'.repeat(30000) }] as any;
    const large = [
      { role: 'user', content: 'summary' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'one', toolName: 'Read', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'one', toolName: 'Read', output: { type: 'text', value: 'x'.repeat(16000) } }] },
    ] as any;
    expect(validateCompactionCandidate(dense, original, large)).toBe('cannot-fit');
    expect(validateCompactionCandidate(plan, original, large)).toBe('cannot-fit');
  });
});

describe('contextBudget', () => {
  it('32k window, 16k manifest reserve: the trigger sits below the trim budget (the exact case that was inverted)', () => {
    const b = contextBudget({ contextLength: 32_768, maxTokens: 16_000 });
    expect(b).toEqual({ replyReserve: 8192, trimBudget: 23_552, triggerTokens: 21_196 });
    expect(b.triggerTokens).toBeLessThan(b.trimBudget);
  });
  it('8k window: the trim budget is positive, so history no longer collapses to the newest message', () => {
    const b = contextBudget({ contextLength: 8192, maxTokens: 16_000 });
    expect(b).toEqual({ replyReserve: 2048, trimBudget: 5120, triggerTokens: 4608 });
  });
  it('200k window: the cloud trigger is unchanged from today (0.75 × ctx) and the reserve stays the manifest value', () => {
    expect(contextBudget({ contextLength: 200_000, maxTokens: 16_000 })).toEqual({ replyReserve: 16_000, trimBudget: 182_976, triggerTokens: 150_000 });
  });
  it('unknown window: assumed 32k for the budget math, the output cap left to the manifest — so compaction fires at 14,169, not 24,576', () => {
    // A cloud model the catalog could not size used to trim its request from
    // 15,744 tokens while waiting for 24,576 to compact. Pinned exactly so the
    // change is a stated fact, not a side effect (review finding 5).
    expect(contextBudget({ contextLength: null, maxTokens: 16_000 })).toEqual({ replyReserve: 16_000, trimBudget: 15_744, triggerTokens: 14_169 });
  });
});

/** A scripted model that also records every outgoing prompt. */
function promptCapturingModel(steps: ScriptStep[], prompts: any[][]) {
  const inner = scriptModel(steps);
  return new MockLanguageModelV4({
    doStream: async (options: any) => { prompts.push(options.prompt); return inner.doStream(options); },
  });
}

// Driver coverage: the old budget's trigger is a diagnostic comparison, not
// proof that the new planner can safely summarize an arbitrary retired span.
describe('driver: compaction happens before any request trimming', () => {
  it.each([
    [32_768, 22_000],
    [500_000, 485_000],
  ])('%i window at ~%i of history: one summary, and the request carries the summary plus the kept tail — nothing silently trimmed', async (contextLength, seedBulkHistoryTokens) => {
    const events: any[] = []; const prompts: any[][] = [];
    let compactedHistory: any[] = [];
    const session = makeSession({
      contextLength, seedBulkHistoryTokens, onEvent: (e) => {
        events.push(e);
        if (e.type === 'compact-summary') compactedHistory = [...(session as any).history];
      }, harness: PRODUCTION_RESERVE,
      model: promptCapturingModel([{ text: 'SUMMARY.' }, { text: 'answer' }], prompts),
    });
    const original = [...(session as any).history, { role: 'user', content: 'continue' }];
    const plan = planContextBudget({ contextLength, fixedCost: (session as any).requestFixedCost(),
      summaryOverhead: Math.ceil(summarizePrompt().length / 4), maxTokens: 16_000 });
    await drainTurn(session, 'continue');
    expect(events.filter((e) => e.type === 'compact-summary')).toHaveLength(1);
    // prompts[0] is the summary call; prompts[1] is the turn's request.
    const request = prompts[1].filter((m) => m.role !== 'system');
    expect(request[0].content[0].text).toMatch(/^\[Earlier conversation summary\]/);
    // The tail is bounded by tokens and starts at a safe real-user boundary,
    // not at a fixed two-turn count. Assert the exact selected suffix survived
    // in the outgoing request: a hidden fitToContext trim would drop its front.
    const cut = selectCompactionCut(original, plan.tail);
    expect(cut).toBeGreaterThan(0);
    expect(original[cut].role).toBe('user');
    expect(messagesTokens(original.slice(cut))).toBeLessThanOrEqual(plan.tail);
    expect(request.length).toBeGreaterThan(2); // summary + retained history + current turn
    expect(compactedHistory.map((m) => m.content)).toEqual([
      '[Earlier conversation summary]\nSUMMARY.', ...original.slice(cut).map((m) => m.content),
    ]);
    expect(request.map((m) => m.content[0].text)).toEqual(compactedHistory.map((m) => m.content));
  });

  it('8k window with an unshortenable retired span refuses to lose history', async () => {
    const events: any[] = []; const prompts: any[][] = [];
    // The newest user message is indivisible, and the retired user/assistant
    // seed cannot be shortened for a summary request. A legacy trigger crossing
    // alone does not make a safe compaction possible.
    const currentTurn = `continue ${'x'.repeat(3200)}`;
    const session = makeSession({
      contextLength: 8192, seedBulkHistoryTokens: 4000, onEvent: (e) => events.push(e), harness: PRODUCTION_RESERVE,
      model: promptCapturingModel([{ text: 'SUMMARY.' }, { text: 'answer' }], prompts),
    });
    const original = [...(session as any).history, { role: 'user', content: currentTurn }];
    const budget = contextBudget({ contextLength: 8192, maxTokens: 16_000 });
    expect(messagesTokens(original)).toBeGreaterThan(budget.triggerTokens);
    expect(messagesTokens(original)).toBeLessThan(budget.trimBudget);
    await drainTurn(session, currentTurn);
    expect(events.filter((e) => e.type === 'compact-summary')).toHaveLength(0);
    expect((session as any).history.slice(0, original.length)).toEqual(original);
    // Above the old trigger, but still below the safe request ceiling: send
    // the entire history rather than pretending an infeasible summary worked.
    expect(prompts).toHaveLength(1);
    expect(prompts[0].filter(m => m.role !== 'system').map(m => m.content[0].text))
      .toEqual(original.map(m => m.content));
  });

  it('8k window with a large old tool result compacts using a shortened summary copy, keeping the recent turn intact', async () => {
    const events: any[] = []; const prompts: any[][] = [];
    const session = makeSession({ contextLength: 8192, harness: PRODUCTION_RESERVE,
      onEvent: e => events.push(e),
      model: promptCapturingModel([{ text: 'SUMMARY.' }, { text: 'answer' }], prompts) });
    const output = 'y'.repeat(20_000);
    session.seedHistory([
      { role: 'user', content: 'read the file' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'read', toolName: 'Read', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'read', toolName: 'Read', output: { type: 'text', value: output } }] },
      { role: 'user', content: 'recap briefly' },
    ] as any);
    await drainTurn(session, 'continue');
    expect(events.filter(e => e.type === 'compact-summary')).toHaveLength(1);
    expect(JSON.stringify(prompts[0])).not.toContain(output); // shortened only for summarization
    const request = prompts[1].filter(m => m.role !== 'system');
    expect(request.map(m => m.content[0].text)).toEqual([
      '[Earlier conversation summary]\nSUMMARY.', 'recap briefly', 'continue',
    ]);
  });
});

describe('an unknown window uses the assumption it is given', () => {
  const base = { contextLength: null, fixedCost: 2_000, summaryOverhead: 200, maxTokens: 4_096 };
  it('defaults to the local assumption, as before', () => {
    expect(planContextBudget(base).contextLength).toBe(UNKNOWN_LOCAL_WINDOW);
    expect(contextBudget({ contextLength: null, maxTokens: 4_096 }).trimBudget).toBe(UNKNOWN_LOCAL_WINDOW - 4_096 - 1024);
  });
  it('a cloud assumption plans a 250k window and still reports it as estimated', () => {
    const plan = planContextBudget({ ...base, assumedWindow: UNKNOWN_CLOUD_WINDOW });
    expect(plan.contextLength).toBe(250_000);
    expect(plan.estimatedWindow).toBe(true);
    expect(contextBudget({ contextLength: null, maxTokens: 4_096, assumedWindow: UNKNOWN_CLOUD_WINDOW }).trimBudget).toBe(250_000 - 4_096 - 1024);
  });
  it('a known window always wins over the assumption', () => {
    expect(planContextBudget({ ...base, contextLength: 128_000, assumedWindow: UNKNOWN_CLOUD_WINDOW }).contextLength).toBe(128_000);
  });
});

describe('a session with an unknown window budgets with its profile’s assumption', () => {
  // ~22k tokens of history: past a 32k window's trigger (with the 16k reply reserve), far inside 250k.
  const run = async (onThisComputer: boolean) => {
    const events: any[] = []; const prompts: any[][] = [];
    const profile = resolveProfile({ providerType: 'openai-compatible', modelId: 'm', contextLength: null, onThisComputer });
    const session = makeSession({ profile, seedBulkHistoryTokens: 22_000, harness: PRODUCTION_RESERVE,
      onEvent: (e) => events.push(e), model: promptCapturingModel([{ text: 'SUMMARY.' }, { text: 'answer' }], prompts) });
    await drainTurn(session, 'continue');
    return { summaries: events.filter((e) => e.type === 'compact-summary').length, calls: prompts.length };
  };
  it('in the cloud (250k assumed): the conversation is sent as it is, with no summary first', async () => {
    expect(await run(false)).toEqual({ summaries: 0, calls: 1 });
  });
  it('on this computer (32k assumed): the same conversation is summarised before it is sent', async () => {
    expect(await run(true)).toEqual({ summaries: 1, calls: 2 });
  });  it('in the cloud, the request keeps its full reply allowance (the pre-request plan uses 250k too)', async () => {
    const opts: any[] = [];
    const inner = scriptModel([{ text: 'answer' }]);
    const model = new MockLanguageModelV4({ doStream: async (o: any) => { opts.push(o); return inner.doStream(o); } });
    const profile = resolveProfile({ providerType: 'openai-compatible', modelId: 'm', contextLength: null, onThisComputer: false });
    const session = makeSession({ profile, seedBulkHistoryTokens: 20_000, harness: PRODUCTION_RESERVE, model });
    await drainTurn(session, 'continue');
    // A 32k plan would leave well under 16k for the reply after ~20k of history.
    expect(opts[0].maxOutputTokens).toBe(16_000);
  });
});
