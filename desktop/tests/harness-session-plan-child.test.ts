// Specialists plans, Task 3 — HarnessSession's opt-in plan-child mode.
// A plan specialist's every provider request is a budget authorization: it is
// bounded and durably reserved BEFORE it is sent, sent exactly once, and
// settled afterwards. Nothing in this mode may make a request the plan did
// not reserve: no SDK retry, no harness step retry, no stall re-run, no
// compaction summary, no silent empty-step re-run, and never a park.
// The last block pins that ordinary sessions keep today's behaviour.
import { describe, it, expect, vi, afterEach, type Mock } from 'vitest';
import { APICallError, type ModelMessage } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { HarnessSession } from '../src/main/harness/harness-session';
import type { TranscriptEvent } from '../src/shared/types';
import type { PermissionDecision } from '../src/shared/permission-types';
import type {
  PlanBudgetAdapter, PlanChildRequestGate, PlanChildStop, PlanRequestOutcome, PlanRequestReservation, PlanRequestSettlement, PlanWireRequest,
} from '../src/main/harness/plans/budget-adapter';
import { genericInputBound } from '../src/main/harness/plans/budget-adapter';
import { currentChatGptRequest } from '../src/main/providers/chatgpt-request-diagnostics';
import { textChunks, toolCallChunk, finishChunk, stream } from './helpers/scripted-model';
import { makeOpts, fakeTool } from './helpers/harness-fakes';

vi.setConfig({ testTimeout: 30_000 });

const ALLOW: PermissionDecision = { action: 'allow', denyListed: false };

interface FakeGate extends PlanChildRequestGate {
  log: string[];
  bounds: PlanWireRequest[];
  outcomes: PlanRequestOutcome[];
  reservedNow: () => boolean;
  onStop: Mock<(stop: PlanChildStop) => void>;
}

function fakeGate(over: {
  providerType?: PlanBudgetAdapter['providerType'];
  capsOutput?: boolean;
  bound?: (r: PlanWireRequest) => ReturnType<PlanBudgetAdapter['inputBound']>;
  reserve?: (n: number, call: number) => PlanRequestReservation;
  settle?: (o: PlanRequestOutcome) => PlanRequestSettlement;
} = {}): FakeGate {
  const log: string[] = [];
  const bounds: PlanWireRequest[] = [];
  const outcomes: PlanRequestOutcome[] = [];
  let held = false;
  let reserveCalls = 0;
  return {
    log, bounds, outcomes,
    reservedNow: () => held,
    adapter: {
      id: 'fake-adapter',
      providerType: over.providerType ?? 'openrouter',
      capsOutput: over.capsOutput ?? true,
      inputBound: (r) => { bounds.push(r); log.push('bound'); return over.bound?.(r) ?? { ok: true, tokens: 123 }; },
    },
    async reserve({ inputBoundTokens }) {
      log.push(`reserve:${inputBoundTokens}`);
      // A real reservation is a journal write — let it take a tick.
      await new Promise((r) => setTimeout(r, 1));
      const result = over.reserve?.(inputBoundTokens, reserveCalls++) ?? { ok: true, maxOutputTokens: 777 };
      if (result.ok) held = true;
      return result;
    },
    async settle(outcome) {
      log.push(`settle:${outcome.kind}`);
      outcomes.push(outcome);
      held = false;
      return over.settle?.(outcome) ?? { kind: 'ok', chargedTokens: 1 };
    },
    onStop: vi.fn<(stop: PlanChildStop) => void>(),
  };
}

/** A model that records every provider call and whether a reservation was
 *  held at the moment it was made. */
function recordingModel(gate: FakeGate | undefined, streams: Array<() => ReadableStream | Promise<never>>) {
  const calls: Array<{ options: any; reserved: boolean; chatgpt: ReturnType<typeof currentChatGptRequest> }> = [];
  const model = new MockLanguageModelV4({
    doStream: async (options: any) => {
      calls.push({ options, reserved: gate?.reservedNow() ?? false, chatgpt: currentChatGptRequest() });
      gate?.log.push('fetch');
      const make = streams[Math.min(calls.length - 1, streams.length - 1)];
      const s = make();
      if (s instanceof Promise) return s as never;
      return { stream: s };
    },
  });
  return { model, calls };
}

const completing = (...chunks: any[]) => () => simulateReadableStream({ chunks: stream(...chunks) });
const hanging = (...chunks: any[]) => () => new ReadableStream({
  start(c) { for (const x of [{ type: 'stream-start', warnings: [] }, ...chunks]) c.enqueue(x); },
});
const throwing = (err: Error) => () => Promise.reject(err);

function planSession(gate: FakeGate, model: MockLanguageModelV4, over: Parameters<typeof makeOpts>[0] = {}) {
  const session = new HarnessSession(makeOpts({
    isSpecialistChild: true, planChild: gate, systemPrompt: 'You are a reviewer.', providerType: 'openrouter',
    tools: [fakeTool('Read')], decide: async () => ALLOW,
    stallWarningMs: 60, stallCountdownMs: 60, prefillWarningMs: 60,
    ...over,
  }), async () => model as any);
  const events: TranscriptEvent[] = [];
  session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
  return { session, events };
}

const retryable = () => new APICallError({
  message: 'upstream overloaded', url: 'https://x', requestBodyValues: {}, statusCode: 503, isRetryable: true,
});

describe('plan-child mode — reserve before every request', () => {
  it('bounds the COMPLETE request, reserves it durably, then sends exactly once with the exact remaining output', async () => {
    const gate = fakeGate();
    const { model, calls } = recordingModel(gate, [completing(...textChunks('a', 'done'), finishChunk('stop', 40, 5))]);
    const { session } = planSession(gate, model);
    await session.send('Review a.ts');

    expect(gate.log).toEqual(['bound', 'reserve:123', 'fetch', 'settle:reported']);
    expect(calls).toHaveLength(1);
    expect(calls[0].reserved).toBe(true);
    expect(calls[0].options.maxOutputTokens).toBe(777);
    // The adapter saw everything that was sent: system, messages, tool schemas.
    const seen = gate.bounds[0];
    expect(seen.system).toBe('You are a reviewer.');
    expect(JSON.stringify(seen.messages)).toContain('Review a.ts');
    expect(seen.tools.map((t) => t.name)).toEqual(['Read']);
    expect(JSON.stringify(seen.tools[0].inputSchema)).toContain('file_path');
    const sentPrompt = JSON.stringify(calls[0].options.prompt);
    expect(sentPrompt).toContain('Review a.ts');
    expect(calls[0].options.tools.map((t: any) => t.name)).toEqual(['Read']);
    expect(gate.outcomes[0]).toMatchObject({ kind: 'reported', tokens: 45, usage: { inputTokens: 40, outputTokens: 5 } });
  });

  it('the real generic adapter reserves at least one token per byte of everything sent', async () => {
    const gate = fakeGate({ bound: genericInputBound });
    const { model, calls } = recordingModel(gate, [completing(...textChunks('a', 'done'), finishChunk('stop'))]);
    const { session } = planSession(gate, model);
    await session.send('Review a.ts');
    const reserved = Number(gate.log.find((l) => l.startsWith('reserve:'))!.split(':')[1]);
    const sentBytes = Buffer.byteLength(JSON.stringify(calls[0].options.prompt)) + Buffer.byteLength(JSON.stringify(calls[0].options.tools));
    expect(reserved).toBeGreaterThanOrEqual(sentBytes);
  });

  it('each step of a multi-step turn is reserved and settled on its own', async () => {
    const gate = fakeGate();
    const { model, calls } = recordingModel(gate, [
      completing(toolCallChunk('c1', 'Read', { file_path: 'a.ts' }), finishChunk('tool-calls')),
      completing(...textChunks('b', 'report'), finishChunk('stop')),
    ]);
    const { session } = planSession(gate, model);
    await session.send('go');
    expect(gate.log).toEqual(['bound', 'reserve:123', 'fetch', 'settle:reported', 'bound', 'reserve:123', 'fetch', 'settle:reported']);
    expect(calls.every((c) => c.reserved)).toBe(true);
    // The second request's bound included the first step's tool result.
    expect(JSON.stringify(gate.bounds[1].messages)).toContain('Read ran');
  });

  it('zero room sends nothing: the turn ends as budget-exhausted and the executor is told', async () => {
    const gate = fakeGate({ reserve: () => ({ ok: false, kind: 'exhausted', detail: 'only 5 left' }) });
    const { model, calls } = recordingModel(gate, [completing(finishChunk('stop'))]);
    const { session, events } = planSession(gate, model);
    await session.send('go');
    expect(calls).toHaveLength(0);
    expect(gate.log).toEqual(['bound', 'reserve:123']);
    const done = events.find((e) => e.type === 'turn-complete');
    expect(done?.data.stopReason).toBe('plan_budget_exhausted');
    expect(gate.onStop).toHaveBeenCalledWith({ kind: 'exhausted', detail: 'only 5 left' });
  });

  it('exhaustion after a tool step stops before the next request, with history still paired', async () => {
    const gate = fakeGate({ reserve: (_n, call) => (call === 0 ? { ok: true, maxOutputTokens: 50 } : { ok: false, kind: 'exhausted', detail: 'spent' }) });
    const read = fakeTool('Read');
    const { model, calls } = recordingModel(gate, [completing(toolCallChunk('c1', 'Read', { file_path: 'a.ts' }), finishChunk('tool-calls'))]);
    const { session } = planSession(gate, model, { tools: [read] });
    await session.send('go');
    expect(calls).toHaveLength(1);
    expect((read as any).calls).toHaveLength(1);
    const history = (session as any).history as ModelMessage[];
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('a refused reservation (lost fence, disabled adapter) sends nothing and reports the real reason', async () => {
    const gate = fakeGate({ reserve: () => ({ ok: false, kind: 'refused', detail: 'This plan is being run by another YouCoded window.' }) });
    const { model, calls } = recordingModel(gate, [completing(finishChunk('stop'))]);
    const { session, events } = planSession(gate, model);
    await session.send('go');
    expect(calls).toHaveLength(0);
    expect(events.find((e) => e.type === 'session-error')?.data.text).toMatch(/another YouCoded window/);
    expect(gate.onStop).toHaveBeenCalledWith({ kind: 'refused', detail: 'This plan is being run by another YouCoded window.' });
  });

  it('content the adapter cannot bound is refused before any reservation or fetch', async () => {
    const gate = fakeGate({ bound: genericInputBound });
    const { model, calls } = recordingModel(gate, [completing(finishChunk('stop'))]);
    const { session, events } = planSession(gate, model);
    session.seedHistory([{ role: 'user', content: [{ type: 'image', image: new Uint8Array([1, 2]) }] } as ModelMessage]);
    await session.send('look');
    expect(calls).toHaveLength(0);
    expect(gate.log).toEqual(['bound']);
    expect(events.find((e) => e.type === 'session-error')?.data.text).toMatch(/can't measure/);
    expect(gate.onStop).toHaveBeenCalledWith(expect.objectContaining({ kind: 'unsupported-input' }));
  });

  it('saved reasoning and images are never put on a plan request (so they need no bound)', async () => {
    const gate = fakeGate({ bound: genericInputBound });
    const { model, calls } = recordingModel(gate, [completing(...textChunks('a', 'ok'), finishChunk('stop'))]);
    const { session } = planSession(gate, model);
    session.seedHistory([
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'secret thoughts', providerOptions: { openai: { itemId: 'r1' } } }, { type: 'text', text: 'answer' }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'x', toolName: 'Read', output: { type: 'content', value: [{ type: 'file', data: { type: 'data', data: 'aGk=' }, mediaType: 'image/png', filename: 'a.png' }] } }] },
    ] as unknown as ModelMessage[]);
    await session.send('continue');
    expect(calls).toHaveLength(1);
    const sent = JSON.stringify(calls[0].options.prompt);
    expect(sent).not.toContain('secret thoughts');
    expect(sent).not.toContain('aGk=');
    expect(sent).toContain('image omitted');
    // History itself is untouched — only the request copy was adapted.
    expect(JSON.stringify((session as any).history)).toContain('secret thoughts');
  });

  it('runs inside a single-transmission ChatGPT request scope', async () => {
    const gate = fakeGate();
    const { model, calls } = recordingModel(gate, [completing(...textChunks('a', 'x'), finishChunk('stop'))]);
    const { session } = planSession(gate, model);
    await session.send('go');
    expect(calls[0].chatgpt).toMatchObject({ purpose: 'specialist', singleTransmission: true });
  });
});

describe('plan-child mode — no second transmission, ever', () => {
  it('a retryable provider error is sent once (no SDK retry, no step retry) and charged in full', async () => {
    const gate = fakeGate();
    const { model, calls } = recordingModel(gate, [throwing(retryable())]);
    // Long watchdog budgets: the SDK's own retry waits ~2s before re-sending,
    // and a short stall timer would end the turn first and hide that retry.
    const { session, events } = planSession(gate, model, { stallWarningMs: 20_000, stallCountdownMs: 20_000, prefillWarningMs: 20_000 });
    await session.send('go');
    expect(calls).toHaveLength(1);
    expect(gate.outcomes).toEqual([{ kind: 'unknown', why: 'error' }]);
    expect(events.some((e) => e.type === 'session-error')).toBe(true);
  });

  it('a retryable error part mid-stream is not retried either', async () => {
    const gate = fakeGate();
    const err = Object.assign(new Error('temporary upstream'), { statusCode: 503 });
    const { model, calls } = recordingModel(gate, [completing({ type: 'error', error: err }), completing(finishChunk('stop'))]);
    const { session } = planSession(gate, model);
    await session.send('go');
    expect(calls).toHaveLength(1);
    expect(gate.outcomes).toEqual([{ kind: 'unknown', why: 'error' }]);
  });

  it('a silent stall before any output is not re-run', async () => {
    const gate = fakeGate();
    const { model, calls } = recordingModel(gate, [hanging(), completing(finishChunk('stop'))]);
    const { session, events } = planSession(gate, model);
    await session.send('go');
    expect(calls).toHaveLength(1);
    expect(gate.outcomes).toEqual([{ kind: 'unknown', why: 'error' }]);
    expect(events.some((e) => e.type === 'session-error')).toBe(true);
    const warn = events.find((e) => e.type === 'assistant-thinking' && e.data.stallWarning);
    expect(warn?.data.stallWarning?.willRetry).toBe(false);
  });

  it('a stall after output never parks and never waits for a Retry click', async () => {
    const gate = fakeGate();
    const { model, calls } = recordingModel(gate, [hanging(...textChunks('a', 'half'))]);
    const { session, events } = planSession(gate, model);
    await session.send('go');
    expect(calls).toHaveLength(1);
    expect(events.some((e) => e.type === 'assistant-thinking' && e.data.stalled)).toBe(false);
    expect(session.retryStalledStep()).toBe(false);
    expect(events.some((e) => e.type === 'session-error')).toBe(true);
  });

  it('an empty step is not silently re-run', async () => {
    const gate = fakeGate();
    const { model, calls } = recordingModel(gate, [completing(finishChunk('stop')), completing(...textChunks('a', 'x'), finishChunk('stop'))]);
    const { session, events } = planSession(gate, model);
    await session.send('go');
    expect(calls).toHaveLength(1);
    expect(events.find((e) => e.type === 'turn-complete')?.data.stopReason).toBe('empty_response');
  });

  it('context pressure never triggers a compaction summary call', async () => {
    const gate = fakeGate();
    const { model, calls } = recordingModel(gate, [completing(...textChunks('a', 'ok'), finishChunk('stop', 9000, 5))]);
    const { session, events } = planSession(gate, model, { contextLength: 8192 });
    const bulk = 'x'.repeat(4000);
    session.seedHistory(Array.from({ length: 16 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: bulk }) as ModelMessage));
    await session.send('go');
    expect(calls).toHaveLength(1);
    expect(events.some((e) => e.type === 'compact-summary')).toBe(false);
    expect(await session.compactNow()).toEqual({ ok: false, reason: 'plan-child' });
  });
});

describe('plan-child mode — settlement', () => {
  it('a response with no usage report is charged in full', async () => {
    const gate = fakeGate();
    const silent = { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: undefined }, outputTokens: { total: undefined } } };
    const { model } = recordingModel(gate, [completing(...textChunks('a', 'x'), silent)]);
    const { session } = planSession(gate, model);
    await session.send('go');
    expect(gate.outcomes).toEqual([{ kind: 'unknown', why: 'silent' }]);
  });

  it('an interrupted request is charged in full', async () => {
    const gate = fakeGate();
    const { model } = recordingModel(gate, [hanging(...textChunks('a', 'partial'))]);
    const { session, events } = planSession(gate, model, { stallWarningMs: 10_000, stallCountdownMs: 10_000, prefillWarningMs: 10_000 });
    const done = session.send('go');
    // Wait on the stream's own output, not a timer: the request is mid-flight.
    await vi.waitFor(() => expect(events.some((e) => e.type === 'assistant-text')).toBe(true));
    session.interrupt();
    await done;
    expect(gate.outcomes).toEqual([{ kind: 'unknown', why: 'interrupted' }]);
  });

  it('usage over the bound stops the turn before any returned tool runs, and the executor is told', async () => {
    const gate = fakeGate({ settle: () => ({ kind: 'over-bound', chargedTokens: 5000, detail: 'used 5,000 of 900' }) });
    const read = fakeTool('Read');
    const { model, calls } = recordingModel(gate, [completing(toolCallChunk('c1', 'Read', { file_path: 'a.ts' }), finishChunk('tool-calls', 4000, 1000))]);
    const { session, events } = planSession(gate, model, { tools: [read] });
    await session.send('go');
    expect(calls).toHaveLength(1);
    expect((read as any).calls).toHaveLength(0);
    expect(events.some((e) => e.type === 'tool-use')).toBe(false);
    expect(events.find((e) => e.type === 'session-error')?.data.text).toMatch(/5,000/);
    expect(gate.onStop).toHaveBeenCalledWith({ kind: 'over-bound', detail: 'used 5,000 of 900' });
    // Nothing dangling in model memory: no unpaired tool call.
    expect(JSON.stringify((session as any).history)).not.toContain('tool-call');
  });
});

describe('ordinary sessions are unchanged', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a retryable provider error is still retried (SDK + step retry)', async () => {
    const { model, calls } = recordingModel(undefined, [throwing(retryable()), completing(...textChunks('a', 'ok'), finishChunk('stop'))]);
    const session = new HarnessSession(makeOpts({ tools: [fakeTool('Read')], decide: async () => ALLOW }), async () => model as any);
    await session.send('go');
    expect(calls.length).toBeGreaterThan(1);
  });

  it('keeps its own reply cap and default request scope', async () => {
    const { model, calls } = recordingModel(undefined, [completing(...textChunks('a', 'ok'), finishChunk('stop'))]);
    const session = new HarnessSession(makeOpts({ isSpecialistChild: true }), async () => model as any);
    await session.send('go');
    expect(calls[0].options.maxOutputTokens).not.toBe(777);
    expect(calls[0].chatgpt?.singleTransmission).toBeUndefined();
    expect(calls[0].chatgpt?.purpose).toBe('specialist');
  });

  it('an empty step still gets its one silent re-run', async () => {
    const { model, calls } = recordingModel(undefined, [completing(finishChunk('stop')), completing(...textChunks('a', 'x'), finishChunk('stop'))]);
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    await session.send('go');
    expect(calls).toHaveLength(2);
  });
});

describe('review round 2 — route checks, soft limit, no thinking budget', () => {
  it('refuses an adapter certified for a different provider route (nothing reserved or sent)', async () => {
    const gate = fakeGate({ providerType: 'openrouter' });
    const { model, calls } = recordingModel(gate, [completing(finishChunk('stop'))]);
    const { session, events } = planSession(gate, model, { providerType: 'chatgpt' });
    await session.send('go');
    expect(calls).toHaveLength(0);
    expect(gate.log).toEqual([]);
    expect(events.some((e) => e.type === 'session-error')).toBe(true);
    expect(gate.onStop).toHaveBeenCalledWith(expect.objectContaining({ kind: 'refused' }));
  });

  it('refuses when the session does not know its provider route', async () => {
    const gate = fakeGate();
    const { model, calls } = recordingModel(gate, [completing(finishChunk('stop'))]);
    const { session } = planSession(gate, model, { providerType: undefined });
    await session.send('go');
    expect(calls).toHaveLength(0);
  });

  it('a soft (ChatGPT) route is still reserved and sent once, but without a reply cap', async () => {
    const gate = fakeGate({ providerType: 'chatgpt', capsOutput: false });
    const { model, calls } = recordingModel(gate, [completing(...textChunks('a', 'ok'), finishChunk('stop'))]);
    const { session } = planSession(gate, model, { providerType: 'chatgpt' });
    await session.send('go');
    expect(gate.log).toEqual(['bound', 'reserve:123', 'fetch', 'settle:reported']);
    expect(calls[0].options.maxOutputTokens).toBeUndefined();
    expect(calls[0].chatgpt).toMatchObject({ singleTransmission: true });
  });

  it('a reply that reaches the soft limit stops before its tools run and before any further request', async () => {
    const gate = fakeGate({
      providerType: 'chatgpt', capsOutput: false,
      settle: () => ({ kind: 'limit-reached', chargedTokens: 2000, detail: 'used 2,000 of 1,000' }),
    });
    const read = fakeTool('Read');
    const { model, calls } = recordingModel(gate, [completing(...textChunks('a', 'reading'), toolCallChunk('c1', 'Read', { file_path: 'a.ts' }), finishChunk('tool-calls'))]);
    const { session, events } = planSession(gate, model, { providerType: 'chatgpt', tools: [read] });
    await session.send('go');
    expect(calls).toHaveLength(1);
    expect((read as any).calls).toHaveLength(0);
    expect(events.some((e) => e.type === 'tool-use')).toBe(false);
    expect(events.find((e) => e.type === 'turn-complete')?.data.stopReason).toBe('plan_budget_exhausted');
    expect(gate.onStop).toHaveBeenCalledWith({ kind: 'exhausted', detail: 'used 2,000 of 1,000' });
    const history = (session as any).history as ModelMessage[];
    expect(JSON.stringify(history)).not.toContain('tool-call');
    expect(history.at(-1)).toEqual({ role: 'assistant', content: 'reading' });
  });

  it.each([['openrouter', true], ['anthropic', true], ['chatgpt', false]] as const)(
    'plan requests never ask for a thinking/reasoning budget (%s) — it would add on top of the reply cap',
    async (providerType, capsOutput) => {
      const gate = fakeGate({ providerType, capsOutput });
      const { model, calls } = recordingModel(gate, [completing(...textChunks('a', 'ok'), finishChunk('stop'))]);
      const { session } = planSession(gate, model, { providerType });
      await session.send('go');
      expect(JSON.stringify(calls[0].options.providerOptions ?? {})).not.toMatch(/thinking|reasoning|budget/i);
    },
  );
});
