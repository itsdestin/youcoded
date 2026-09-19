// propose_plan and the pairing invariant (rule native-runtime.md, Task 1b review).
//
// Every tool call has exactly ONE paired result — in live history, in the
// persisted transcript, and in rebuilt history — and live history must equal
// what rebuildHistory produces from the transcript, so the accepted-history
// store can publish. A plan is the one tool whose tool-use shell is emitted
// MID-STREAM (at tool-input-start, so the "writing" card appears at once),
// which opens exit paths no other tool has. Each test below drives a real
// HarnessSession through one of those paths and checks all three views.
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { CLOUD_DEFAULT } from '../src/main/harness/capability-profile';
import { HarnessSession } from '../src/main/harness/harness-session';
import { rebuildHistory } from '../src/main/harness/history-rebuild';
import { SessionStore, type NativeSessionHeader } from '../src/main/harness/session-store';
import { AcceptedHistoryStore } from '../src/main/harness/accepted-history-store';
import { NativeHome } from '../src/main/native-home';
import { BUILTIN_ROSTER } from '../src/main/harness/specialists/registry';
import type { PlanDocumentV1 } from '../src/main/harness/plans/schema';
import { PLAN_INVALID_DETAIL } from '../src/main/harness/tools/propose-plan';
import type { AskDecision } from '../src/main/harness/permission-broker';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { createSessionChatState, type ChatState } from '../src/renderer/state/chat-types';
import { pageEventToAction } from '../src/renderer/state/transcript-page-actions';
import type { PlanView, TranscriptEvent } from '../src/shared/types';
import { EMPTY_SKILL_CATALOG, FAKE_SESSION_CWD, HARNESS, fakeTool } from './helpers/harness-fakes';
import { finishChunk, stream, textChunks, toolCallChunk, toolInputChunks } from './helpers/scripted-model';

const VALID: PlanDocumentV1 = {
  goal: 'Review the source files.',
  // TWO items: decision 33 refuses a plan whose whole worst case is one
  // specialist run, and this document has to be a VALID one.
  steps: [{ id: 'review', kind: 'map', specialist: 'reviewer', task: 'Review {item}.', budget_tokens: 500, summary: 'Plain sentence.', items: ['a.ts', 'b.ts'] }],
};
const BAD: PlanDocumentV1 = { ...VALID, steps: [{ ...VALID.steps[0], specialist: 'missing' }] };

const proposed = (toolUseId: string): PlanView => ({
  planId: 'plan-1', toolUseId, title: VALID.goal, status: 'proposed', steps: [],
  ceilingTokens: 1_000, ceilingUsd: null, model: { label: 'model' }, seq: 1,
});

const STALL_MS = 150;

type StreamMaker = () => ReadableStream<any>;
const scripted = (chunks: any[]): StreamMaker => () => simulateReadableStream({ chunks });
/** A provider that sends these chunks and then goes silent forever. */
const hanging = (...chunks: any[]): StreamMaker => () => new ReadableStream({
  start(controller) { for (const c of [{ type: 'stream-start', warnings: [] }, ...chunks]) controller.enqueue(c); },
});
/** A provider that sends these chunks and then fails without a status code. */
const failing = (...chunks: any[]): StreamMaker => () => new ReadableStream({
  start(controller) { for (const c of [{ type: 'stream-start', warnings: [] }, ...chunks]) controller.enqueue(c); },
  pull(controller) { controller.error(new Error('provider disconnected')); },
});

function planSession(makers: StreamMaker[], over: Record<string, unknown> = {}) {
  let call = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => ({ stream: makers[Math.min(call++, makers.length - 1)]() }),
  });
  const events: TranscriptEvent[] = [];
  const propose = vi.fn(async ({ toolUseId, commit }: { toolUseId: string; commit(): boolean }) => {
    if (!commit()) throw new Error('commit refused');
    return proposed(toolUseId);
  });
  const session = new HarnessSession({
    sessionId: 's-1', cwd: FAKE_SESSION_CWD, harness: HARNESS,
    binding: { providerId: 'openrouter', modelId: 'model' }, providerType: 'openrouter',
    profile: CLOUD_DEFAULT, tools: [], skillCatalog: EMPTY_SKILL_CATALOG, mcpServers: [],
    specialistRoster: BUILTIN_ROSTER, toolServices: { plans: { propose } },
    decide: async () => ({ action: 'allow', denyListed: false }), retryDelays: [],
    ...over,
  } as any, async () => model as any);
  session.on('transcript-event', (event: TranscriptEvent) => events.push(event));
  return { session, events, propose, calls: () => call };
}

const HEADER: NativeSessionHeader = {
  v: 1, sessionId: 's-1', harnessId: 'chat',
  binding: { providerId: 'openrouter', modelId: 'model' }, cwd: FAKE_SESSION_CWD, createdAt: 1,
};

/** Persist through a REAL SessionStore (what resume reads), rebuild, and run a
 *  real accepted-history publish + restore against the same transcript. */
async function persistedViews(session: HarnessSession, events: TranscriptEvent[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-plan-pairing-'));
  try {
    const store = new SessionStore(new NativeHome(path.join(root, 'home')));
    await store.create(HEADER);
    for (const e of events) await store.append(HEADER.cwd, { ...e, sessionId: 's-1' } as any);
    const accepted = session.acceptedHistory();
    const refs = await store.flushReferences('s-1', accepted.eventUuids);
    await store.flushAll();
    const persisted = await store.readEvents('s-1', HEADER.cwd);
    const durable = new AcceptedHistoryStore(path.join(root, 'userdata'));
    const transcriptPath = store.transcriptPath('s-1', HEADER.cwd);
    const published = refs.ok
      ? await durable.publish({
        sessionId: 's-1', transcriptPath, binding: accepted.binding, assemblyDigest: accepted.assemblyDigest,
        revision: durable.currentRevision('s-1'), references: refs.references, messages: accepted.messages,
      })
      : { ok: false as const, reason: refs.reason };
    const restored = durable.restore({ sessionId: 's-1', transcriptPath, binding: accepted.binding, assemblyDigest: accepted.assemblyDigest });
    return { rebuilt: rebuildHistory(persisted), published, restored };
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
}

const liveHistory = (session: HarnessSession) => (session as any).history as any[];
const activePlans = (session: HarnessSession) => [...((session as any).activeWritingPlanIds as Set<string>)];
const resultsFor = (events: TranscriptEvent[], id: string) => events.filter((e) => e.type === 'tool-result' && e.data.toolUseId === id);
const callIds = (history: any[]) => history
  .filter((m) => m.role === 'assistant' && Array.isArray(m.content))
  .flatMap((m) => m.content.filter((p: any) => p.type === 'tool-call').map((p: any) => p.toolCallId));

/** Every tool-call id in history appears once, and its result sits in the very next message. */
function expectPaired(history: any[]) {
  const ids = callIds(history);
  expect(new Set(ids).size).toBe(ids.length);
  history.forEach((m, i) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return;
    const calls = m.content.filter((p: any) => p.type === 'tool-call').map((p: any) => p.toolCallId);
    if (calls.length === 0) return;
    const next = history[i + 1];
    expect(next?.role).toBe('tool');
    expect(next.content.map((p: any) => p.toolCallId).sort()).toEqual([...calls].sort());
  });
}

/** Everything the three views must agree on, in one assertion block. */
async function expectAllViewsAgree(session: HarnessSession, events: TranscriptEvent[]) {
  const live = liveHistory(session);
  expectPaired(live);
  const { rebuilt, published, restored } = await persistedViews(session, events);
  expect(rebuilt).toEqual(live);
  expect(published).toEqual({ ok: true });
  expect(restored).toMatchObject({ ok: true });
  if (restored.ok) expect(restored.messages).toEqual(live);
}

function replayIntoReducer(events: TranscriptEvent[]): ChatState {
  let state: ChatState = new Map([['s-1', createSessionChatState()]]);
  for (const event of events) {
    const action = pageEventToAction({ ...event, sessionId: 's-1' });
    if (action) state = chatReducer(state, action);
  }
  return state;
}

describe('propose_plan: completed calls are persisted with their real arguments (finding 1)', () => {
  it('a proposal turn: transcript carries the document, rebuild == live, publish round-trips, ONE card', async () => {
    const { session, events } = planSession([
      scripted(stream(...toolInputChunks('pc', 'propose_plan', JSON.stringify(VALID)), toolCallChunk('pc', 'propose_plan', VALID), finishChunk('tool-calls'))),
      scripted(stream(...textChunks('t', 'Plan ready.'), finishChunk('stop'))),
    ]);
    await session.send('plan');

    const uses = events.filter((e) => e.type === 'tool-use' && e.data.toolUseId === 'pc');
    expect(uses.at(-1)?.data.toolInput).toEqual(VALID);
    await expectAllViewsAgree(session, events);

    const card = replayIntoReducer(events).get('s-1')!;
    const groups = [...card.toolGroups.values()].filter((g) => g.toolIds.includes('pc'));
    expect(groups).toHaveLength(1);
    expect(groups[0].toolIds.filter((id) => id === 'pc')).toHaveLength(1);
    expect(card.toolCalls.get('pc')).toMatchObject({ input: VALID, plan: { status: 'proposed' } });
  });

  it('an invalid-argument call and its repair: rebuild == live and publish round-trips', async () => {
    const { session, events } = planSession([
      scripted(stream(...toolInputChunks('bad', 'propose_plan', '{}'), toolCallChunk('bad', 'propose_plan', BAD), finishChunk('tool-calls'))),
      scripted(stream(...toolInputChunks('good', 'propose_plan', '{}'), toolCallChunk('good', 'propose_plan', VALID), finishChunk('tool-calls'))),
      scripted(stream(...textChunks('t', 'Plan ready.'), finishChunk('stop'))),
    ]);
    await session.send('plan');
    expect(events.filter((e) => e.type === 'tool-use' && e.data.toolUseId === 'bad').at(-1)?.data.toolInput).toEqual(BAD);
    await expectAllViewsAgree(session, events);
  });

  it('text streamed on both sides of the plan shell still rebuilds to the live message', async () => {
    const { session, events } = planSession([
      scripted(stream(
        { type: 'text-start', id: 'a' }, { type: 'text-delta', id: 'a', delta: 'Before. ' },
        ...toolInputChunks('pc', 'propose_plan', '{}'),
        { type: 'text-delta', id: 'a', delta: 'After.' }, { type: 'text-end', id: 'a' },
        toolCallChunk('pc', 'propose_plan', VALID), finishChunk('tool-calls'),
      )),
      scripted(stream(...textChunks('t', 'Plan ready.'), finishChunk('stop'))),
    ]);
    await session.send('plan');
    expect(liveHistory(session)[1]).toEqual({ role: 'assistant', content: [
      { type: 'text', text: 'Before. After.' },
      { type: 'tool-call', toolCallId: 'pc', toolName: 'propose_plan', input: VALID },
    ] });
    await expectAllViewsAgree(session, events);
  });
});

describe('propose_plan: a plan shell never survives an empty step (finding 2)', () => {
  it('an orderly finish with only an unfinished plan closes the card and does not retry silently', async () => {
    const { session, events, calls } = planSession([
      scripted(stream(...toolInputChunks('bp', 'propose_plan', '{"goal":'), finishChunk('tool-calls'))),
      scripted(stream(...textChunks('t', 'done'), finishChunk('stop'))),
    ]);
    await session.send('plan');
    expect(calls()).toBe(1);
    expect(resultsFor(events, 'bp')).toHaveLength(1);
    expect(resultsFor(events, 'bp')[0].data).toMatchObject({ isError: true, plan: { status: 'failed' } });
    expect(activePlans(session)).toEqual([]);
    expect(callIds(liveHistory(session))).toEqual(['bp']);
    await expectAllViewsAgree(session, events);
  });
});

describe('propose_plan: stall retries close the writing card (finding 3)', () => {
  it('an automatic stall retry pairs the abandoned plan before re-running', async () => {
    const { session, events, calls } = planSession([
      hanging(...toolInputChunks('stalled', 'propose_plan', '{"goal":')),
      scripted(stream(...toolInputChunks('fresh', 'propose_plan', '{}'), toolCallChunk('fresh', 'propose_plan', VALID), finishChunk('tool-calls'))),
      scripted(stream(...textChunks('t', 'Plan ready.'), finishChunk('stop'))),
    ], { stallWarningMs: STALL_MS, stallCountdownMs: STALL_MS });
    await session.send('plan');
    expect(calls()).toBe(3);
    expect(resultsFor(events, 'stalled')).toHaveLength(1);
    expect(resultsFor(events, 'stalled')[0].data).toMatchObject({ isError: true, plan: { status: 'failed' } });
    expect(resultsFor(events, 'fresh')[0].data.plan).toMatchObject({ status: 'proposed' });
    expect(activePlans(session)).toEqual([]);
    await expectAllViewsAgree(session, events);
  }, 20_000);

  it('a manual Retry pairs the abandoned plan and keeps the text shown before it', async () => {
    const { session, events } = planSession([
      hanging(
        { type: 'text-start', id: 'a' }, { type: 'text-delta', id: 'a', delta: 'Let me plan.' },
        ...toolInputChunks('stalled', 'propose_plan', '{"goal":'),
        { type: 'text-delta', id: 'a', delta: ' Half' },
      ),
      scripted(stream(...textChunks('t', 'Recovered.'), finishChunk('stop'))),
    ], { stallWarningMs: STALL_MS, stallCountdownMs: STALL_MS });
    const sent = session.send('plan');
    const deadline = Date.now() + 15_000;
    while (!events.some((e) => e.type === 'assistant-thinking' && e.data.stalled === true)) {
      if (Date.now() > deadline) throw new Error('never parked');
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(session.retryStalledStep()).toBe(true);
    await sent;
    expect(resultsFor(events, 'stalled')).toHaveLength(1);
    expect(resultsFor(events, 'stalled')[0].data).toMatchObject({ isError: true, plan: { status: 'failed' } });
    expect(activePlans(session)).toEqual([]);
    expect(liveHistory(session)[1]).toEqual({ role: 'assistant', content: [
      { type: 'text', text: 'Let me plan.' },
      { type: 'tool-call', toolCallId: 'stalled', toolName: 'propose_plan', input: {} },
    ] });
    await expectAllViewsAgree(session, events);
  }, 20_000);
});

describe('propose_plan: every result for a plan id leaves the writing set (findings 4 and 7)', () => {
  it('an interrupt during a sibling ask stops the plan card and never pairs it a second time', async () => {
    const { session, events } = planSession([
      scripted(stream(
        toolCallChunk('w', 'Write', { file_path: 'x.ts' }),
        ...toolInputChunks('pc', 'propose_plan', '{}'), toolCallChunk('pc', 'propose_plan', VALID),
        finishChunk('tool-calls'),
      )),
      failing(),
    ], {
      tools: [fakeTool('Write')],
      decide: async () => ({ action: 'ask', denyListed: false }),
      askUser: async (): Promise<AskDecision> => ({ behavior: 'canceled' }),
    });
    await session.send('plan');
    expect(resultsFor(events, 'pc')).toHaveLength(1);
    expect(resultsFor(events, 'pc')[0].data).toMatchObject({ isError: true, plan: { status: 'stopped' } });
    expect(activePlans(session)).toEqual([]);

    // A later turn that fails must not pair the old id again.
    await session.send('again');
    expect(resultsFor(events, 'pc')).toHaveLength(1);
    expectPaired(liveHistory(session));
    await expectAllViewsAgree(session, events);
  });

  it('a dismissed question stops a not-run plan sibling', async () => {
    const ask = fakeTool('AskUserQuestion', { interactive: true, schema: z.object({ prompt: z.string() }) });
    const { session, events } = planSession([
      scripted(stream(
        toolCallChunk('q', 'AskUserQuestion', { prompt: 'which?' }),
        ...toolInputChunks('pc', 'propose_plan', '{}'), toolCallChunk('pc', 'propose_plan', VALID),
        finishChunk('tool-calls'),
      )),
      failing(),
    ], {
      tools: [ask],
      askUser: async (): Promise<AskDecision> => ({ behavior: 'deny', dismissed: true }),
    });
    await session.send('plan');
    expect(resultsFor(events, 'pc')).toHaveLength(1);
    expect(resultsFor(events, 'pc')[0].data).toMatchObject({ isError: true, plan: { status: 'stopped' } });
    expect(activePlans(session)).toEqual([]);
    await session.send('again');
    expect(resultsFor(events, 'pc')).toHaveLength(1);
    await expectAllViewsAgree(session, events);
  });

  it('a sibling skipped by repair exhaustion leaves the writing set', async () => {
    const { session, events } = planSession([
      scripted(stream(...toolInputChunks('bad-1', 'propose_plan', '{}'), toolCallChunk('bad-1', 'propose_plan', BAD), finishChunk('tool-calls'))),
      scripted(stream(
        ...toolInputChunks('bad-2', 'propose_plan', '{}'), toolCallChunk('bad-2', 'propose_plan', BAD),
        ...toolInputChunks('sib', 'propose_plan', '{}'), toolCallChunk('sib', 'propose_plan', VALID),
        finishChunk('tool-calls'),
      )),
      failing(),
    ]);
    await session.send('plan');
    expect(resultsFor(events, 'sib')).toHaveLength(1);
    expect(resultsFor(events, 'sib')[0].data).toMatchObject({ isError: true, plan: { status: 'failed' } });
    expect(activePlans(session)).toEqual([]);
    await session.send('again');
    expect(resultsFor(events, 'sib')).toHaveLength(1);
    await expectAllViewsAgree(session, events);
  });

  it('seedHistory and clearHistory forget writing plans from the replaced history', () => {
    const { session } = planSession([scripted(stream(finishChunk('stop')))]);
    (session as any).activeWritingPlanIds.add('stale-a');
    session.seedHistory([]);
    expect(activePlans(session)).toEqual([]);
    (session as any).activeWritingPlanIds.add('stale-b');
    expect(session.clearHistory()).toEqual({ ok: true });
    expect(activePlans(session)).toEqual([]);
  });

  it('a listener throw after the plan step was pushed never pushes a second call for the same id', async () => {
    const { session, events } = planSession([
      scripted(stream(...toolInputChunks('pc', 'propose_plan', '{}'), toolCallChunk('pc', 'propose_plan', VALID), finishChunk('tool-calls'))),
      scripted(stream(...textChunks('t', 'Plan ready.'), finishChunk('stop'))),
    ]);
    let thrown = false;
    session.on('transcript-event', (e: TranscriptEvent) => {
      // The completed-call re-emit is the first tool-use for pc carrying input.
      if (!thrown && e.type === 'tool-use' && e.data.toolUseId === 'pc' && Object.keys(e.data.toolInput ?? {}).length > 0) {
        thrown = true;
        throw new Error('persistence wire failed');
      }
    });
    await session.send('plan');
    expect(thrown).toBe(true);
    expect(callIds(liveHistory(session)).filter((id) => id === 'pc')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'session-error')).toHaveLength(1);
  });
});

describe('propose_plan: a truncated plan after text pushes the text once (finding 5)', () => {
  it('pushes ONE assistant message holding the text and the failed plan call', async () => {
    const { session, events } = planSession([
      scripted(stream(...textChunks('t', 'I will plan.'), ...toolInputChunks('tp', 'propose_plan', '{"goal":'), finishChunk('length'))),
    ]);
    await session.send('plan');
    expect(liveHistory(session).slice(1)).toEqual([
      { role: 'assistant', content: [
        { type: 'text', text: 'I will plan.' },
        { type: 'tool-call', toolCallId: 'tp', toolName: 'propose_plan', input: {} },
      ] },
      { role: 'tool', content: [expect.objectContaining({ type: 'tool-result', toolCallId: 'tp' })] },
    ]);
    await expectAllViewsAgree(session, events);
  });
});

// Merge with master (2026-09-16, #487/#491): master attaches an abandoned
// turn's completed-step spend to the terminal `session-error` /
// `user-interrupt` event; the branch's catch pairs a writing plan card before
// that event goes out. Both must happen on the same path: the card closes,
// history stays paired, and the steps that already ran still report their cost.
describe('propose_plan: a provider failure mid-proposal still reports what the turn spent', () => {
  it('closes the writing card, keeps pairing, and carries the earlier step\'s usage on session-error', async () => {
    const { session, events } = planSession([
      scripted(stream(toolCallChunk('r1', 'Read', { file_path: 'a.ts' }), finishChunk('tool-calls', 300, 10))),
      failing(...textChunks('t', 'Planning now.'), ...toolInputChunks('pw', 'propose_plan', '{"goal":')),
    ], { tools: [fakeTool('Read')] });
    await session.send('plan');
    expect(resultsFor(events, 'pw')).toHaveLength(1);
    expect(resultsFor(events, 'pw')[0].data).toMatchObject({ isError: true, plan: { status: 'failed' } });
    expect(activePlans(session)).toEqual([]);
    const errors = events.filter((e) => e.type === 'session-error');
    expect(errors).toHaveLength(1);
    expect(errors[0].data.usage).toMatchObject({ inputTokens: 300, outputTokens: 10 });
    await expectAllViewsAgree(session, events);
  });
});

// Decision 28: a plan failure the assistant fixes BY ITSELF, in the same turn,
// is never shown. The transcript still records every attempt — a persisted
// event is never retracted — but the conversation a reader sees carries AT
// MOST ONE plan card for the assistant's plan writing. These drive a real
// session, then replay its PERSISTED events through the reducer exactly the
// way re-opening the conversation page does (pageEventToAction).
describe('propose_plan: a turn shows one plan card for the assistant\'s plan writing', () => {
  const cardsOf = (state: ChatState) => [...state.get('s-1')!.toolCalls.values()].filter((t) => t.toolName === 'propose_plan');
  const placedIds = (state: ChatState) => [...state.get('s-1')!.toolGroups.values()].flatMap((g) => g.toolIds);
  const emptyGroups = (state: ChatState) => [...state.get('s-1')!.toolGroups.values()].filter((g) => g.toolIds.length === 0);

  it('a failed attempt the assistant repairs in the same turn leaves no card, no group slot and no failure', async () => {
    const { session, events } = planSession([
      scripted(stream(...toolInputChunks('bad', 'propose_plan', '{}'), toolCallChunk('bad', 'propose_plan', BAD), finishChunk('tool-calls'))),
      scripted(stream(...toolInputChunks('good', 'propose_plan', '{}'), toolCallChunk('good', 'propose_plan', VALID), finishChunk('tool-calls'))),
      scripted(stream(...textChunks('t', 'Plan ready.'), finishChunk('stop'))),
    ]);
    await session.send('plan');
    // The transcript keeps both calls and both results — nothing is retracted.
    expect(resultsFor(events, 'bad')).toHaveLength(1);
    expect(resultsFor(events, 'bad')[0].data).toMatchObject({ plan: { status: 'failed' } });

    const state = replayIntoReducer(events);
    expect(cardsOf(state).map((t) => [t.toolUseId, t.plan?.status])).toEqual([['good', 'proposed']]);
    expect(placedIds(state)).not.toContain('bad');
    expect(emptyGroups(state)).toEqual([]);
  });

  it('a repair that also fails shows exactly one failure, the one that says why', async () => {
    const { session, events } = planSession([
      scripted(stream(...toolInputChunks('bad-1', 'propose_plan', '{}'), toolCallChunk('bad-1', 'propose_plan', BAD), finishChunk('tool-calls'))),
      scripted(stream(
        ...toolInputChunks('bad-2', 'propose_plan', '{}'), toolCallChunk('bad-2', 'propose_plan', BAD),
        ...toolInputChunks('sib', 'propose_plan', '{}'), toolCallChunk('sib', 'propose_plan', VALID),
        finishChunk('tool-calls'),
      )),
      failing(),
    ]);
    await session.send('plan');
    const state = replayIntoReducer(events);
    expect(cardsOf(state).map((t) => t.toolUseId)).toEqual(['bad-2']);
    expect(cardsOf(state)[0].plan).toMatchObject({ status: 'failed', failure: { detail: PLAN_INVALID_DETAIL } });
    expect(emptyGroups(state)).toEqual([]);
  });

  it('two plans sent at once, then a repair: only the repaired plan is drawn', async () => {
    const { session, events } = planSession([
      scripted(stream(
        ...toolInputChunks('bad-a', 'propose_plan', '{}'), toolCallChunk('bad-a', 'propose_plan', BAD),
        ...toolInputChunks('sib-a', 'propose_plan', '{}'), toolCallChunk('sib-a', 'propose_plan', VALID),
        finishChunk('tool-calls'),
      )),
      scripted(stream(...toolInputChunks('good', 'propose_plan', '{}'), toolCallChunk('good', 'propose_plan', VALID), finishChunk('tool-calls'))),
      scripted(stream(...textChunks('t', 'Plan ready.'), finishChunk('stop'))),
    ]);
    await session.send('plan');
    const state = replayIntoReducer(events);
    expect(cardsOf(state).map((t) => [t.toolUseId, t.plan?.status])).toEqual([['good', 'proposed']]);
    expect(emptyGroups(state)).toEqual([]);
  });

  it('a plan abandoned mid-write and re-written in the same turn leaves one card', async () => {
    const { session, events } = planSession([
      hanging(...toolInputChunks('stalled', 'propose_plan', '{"goal":')),
      scripted(stream(...toolInputChunks('fresh', 'propose_plan', '{}'), toolCallChunk('fresh', 'propose_plan', VALID), finishChunk('tool-calls'))),
      scripted(stream(...textChunks('t', 'Plan ready.'), finishChunk('stop'))),
    ], { stallWarningMs: STALL_MS, stallCountdownMs: STALL_MS });
    await session.send('plan');
    const state = replayIntoReducer(events);
    expect(cardsOf(state).map((t) => [t.toolUseId, t.plan?.status])).toEqual([['fresh', 'proposed']]);
    expect(emptyGroups(state)).toEqual([]);
  }, 20_000);

  it('a first failure the user had to ask again about is a new turn, so it stays', async () => {
    const { session, events } = planSession([
      scripted(stream(...toolInputChunks('bp', 'propose_plan', '{"goal":'), finishChunk('tool-calls'))),
      scripted(stream(...toolInputChunks('later', 'propose_plan', '{}'), toolCallChunk('later', 'propose_plan', VALID), finishChunk('tool-calls'))),
      scripted(stream(...textChunks('t2', 'Plan ready.'), finishChunk('stop'))),
    ]);
    await session.send('plan');
    await session.send('try again');
    const state = replayIntoReducer(events);
    expect(cardsOf(state).map((t) => [t.toolUseId, t.plan?.status])).toEqual([['bp', 'failed'], ['later', 'proposed']]);
  });
});
