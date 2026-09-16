// HarnessSession's accepted-history bookkeeping (cache Stage 4, architecture doc
// docs/active/plans/2026-09-09-cache-stage4-architecture.md → "Capture").
//
// These drive a REAL HarnessSession over scripted models, because the thing
// under test is not the bookkeeping class (accepted-history-capture.test.ts pins
// that) but whether the DRIVER calls it at every site that moves history — and
// only a real turn exercises the retry, interrupt, tool, steer, injection and
// compaction paths in the order they actually occur.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { HarnessSession } from '../src/main/harness/harness-session';
import type { TranscriptEvent } from '../src/shared/types';
import type { TriggerIndex } from '../src/main/harness/injection/path-triggers';
import { bindOpenAIContinuationModel } from '../src/main/harness/openai-continuation';
import { drainTurn, fakeTool, makeOpts, makeSession, scriptModel } from './helpers/harness-fakes';
import { finishChunk, reasoningChunks, scriptedModel, stream, textChunks, toolCallChunk } from './helpers/scripted-model';
import type { AskDecision } from '../src/main/harness/permission-broker';

// Watchdog budget for the two tests that need a REAL stall (see
// harness-stall-watchdog.test.ts's STALL_MS note: generous on purpose — nothing
// here asserts on wall-clock, only on which uuids survived).
const STALL_MS = 250;

/** A raw V4 stream that emits its chunks and then never closes — the provider
 *  that goes silent, which is what puts the stalled card (and its Retry) up. */
function hangingStream(...chunks: any[]) {
  return new ReadableStream({
    start(controller) {
      for (const c of [{ type: 'stream-start', warnings: [] }, ...chunks]) controller.enqueue(c);
    },
  });
}
function completingStream(...chunks: any[]) {
  return simulateReadableStream({ chunks: stream(...chunks) });
}
/** One stream per doStream call — attempt 0 gets makers[0], the retry makers[1]. */
function modelFromStreams(makers: Array<() => ReadableStream>) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const make = makers[Math.min(call, makers.length - 1)];
      call++;
      return { stream: make() };
    },
  });
}

function collect(session: HarnessSession): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
  return events;
}

/** A parked turn's send() stays pending by design — poll the events instead. */
async function waitForEvent(events: TranscriptEvent[], pred: (e: TranscriptEvent) => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (events.some(pred)) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for event');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Continuation identities are NUL-joined (architecture doc → "Identity strings"),
 *  which is why every identity literal below carries a NUL escape between its parts. */
const uuidOfText = (events: TranscriptEvent[], text: string) =>
  events.find((e) => e.type === 'assistant-text' && e.data.text === text)!.uuid;

describe('HarnessSession accepted history', () => {
  it('a text + tool-call turn accepts exactly the emitted user/text/tool uuids, in emit order', async () => {
    const events: TranscriptEvent[] = [];
    const session = makeSession({
      onEvent: (e) => events.push(e),
      model: scriptModel([
        { text: 'reading', toolCalls: [{ name: 'Read', input: { file_path: 'a.txt' } }] },
        { text: 'done' },
      ]),
    });
    await drainTurn(session, 'inspect a.txt');

    const accepted = session.acceptedHistory();
    const contentEvents = events.filter((e) =>
      e.type === 'user-message' || e.type === 'assistant-text' || e.type === 'tool-use' || e.type === 'tool-result');
    expect(contentEvents.map((e) => e.type)).toEqual(['user-message', 'assistant-text', 'tool-use', 'tool-result', 'assistant-text']);
    expect(accepted.eventUuids).toEqual(contentEvents.map((e) => e.uuid));
    // The heartbeats/preparing cards on the frozen emit surface are display,
    // not provenance — nothing they carry may enter the accepted list.
    expect(accepted.eventUuids).toHaveLength(5);

    const history = (session as any).history;
    expect(accepted.messages).toEqual(history);
    expect(accepted.messages).not.toBe(history);   // a copy — the host holds it across an await
    expect(accepted.binding).toBe('openrouter\u0000m');
    expect(accepted.transformation).toBeUndefined();
  });

  it('a manual Retry drops the abandoned attempt\'s uuids and accepts the re-run\'s', async () => {
    const model = modelFromStreams([
      () => hangingStream(...textChunks('a', 'abandoned half')),                            // stalls mid-sentence
      () => completingStream(...textChunks('b', 'recovered'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(
      makeOpts({ stallWarningMs: STALL_MS, stallCountdownMs: STALL_MS }),
      async () => model as any,
    );
    const events = collect(session);
    const sent = session.send('go');
    await waitForEvent(events, (e) => e.type === 'assistant-thinking' && e.data.stalled === true);
    expect(session.retryStalledStep()).toBe(true);
    await sent;

    const accepted = session.acceptedHistory();
    expect(accepted.eventUuids).toContain(uuidOfText(events, 'recovered'));
    expect(accepted.eventUuids).not.toContain(uuidOfText(events, 'abandoned half'));
  });

  it('an interrupt mid-text accepts the visible text uuids and never the reasoning ones', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: hangingStream(...reasoningChunks('r', 'thinking out loud'), ...textChunks('a', 'visible partial')),
      }),
    });
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events = collect(session);
    const sent = session.send('go');
    await waitForEvent(events, (e) => e.type === 'assistant-text');
    session.interrupt();
    await sent;

    const accepted = session.acceptedHistory();
    const reasoning = events.find((e) => e.type === 'assistant-thinking' && e.data.text === 'thinking out loud')!;
    expect(accepted.eventUuids).toContain(uuidOfText(events, 'visible partial'));
    expect(accepted.eventUuids).not.toContain(reasoning.uuid);
    expect(accepted.messages.at(-1)).toEqual({ role: 'assistant', content: 'visible partial' });
  });

  it('a steer and a rule injection each bump the revision without adding a uuid', async () => {
    const READ_SUBJECT = fakeTool('Read', { permissionSubject: (a: any) => a.file_path });
    const script = () => scriptModel([
      { toolCalls: [{ name: 'Read', input: { file_path: 'a.txt' } }] },
      { text: 'done' },
    ]);
    const build = (over: Parameters<typeof makeOpts>[0]) => new HarnessSession(
      makeOpts({ tools: [READ_SUBJECT], decide: async () => ({ action: 'allow', denyListed: false }), ...over }),
      async () => script() as any,
    );

    const baseline = build({});
    await baseline.send('go');
    const plain = baseline.acceptedHistory();

    const steered = build({});
    steered.on('transcript-event', (e: TranscriptEvent) => { if (e.type === 'tool-use') steered.postSteer('actually, stop'); });
    await steered.send('go');
    expect(steered.acceptedHistory().eventUuids).toHaveLength(plain.eventUuids.length);
    expect(steered.acceptedHistory().revision).toBe(plain.revision + 1);

    const triggers: TriggerIndex = { match: () => [{ id: 'r1', source: '.claude/rules/api.md', body: 'Always validate input.' }] };
    const injected = build({ triggers });
    await injected.send('go');
    expect(injected.acceptedHistory().eventUuids).toHaveLength(plain.eventUuids.length);
    expect(injected.acceptedHistory().revision).toBe(plain.revision + 1);
    expect(JSON.stringify(injected.acceptedHistory().messages)).toContain('Always validate input');
  });

  it('spliceNotice records the user-message uuid it emitted and advances the revision', async () => {
    // The post-Stop path (NativeSessionHost.drainDeliveries in 'splice' mode)
    // pushes a finished helper's report into history WITHOUT running a turn.
    // That push is byte-identical to the event it emitted, so it must be
    // recorded like beginTurn's — otherwise the store has no anchor for it and
    // falls back to a bounded literal copy of the whole report.
    const session = makeSession({ model: scriptModel([{ text: 'ok' }]) });
    const events: TranscriptEvent[] = [];
    session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
    const before = session.acceptedHistory();

    await session.spliceNotice('[Background specialist] Nadia finished: the answer is 42.');

    const spliced = events.find((e) => e.type === 'user-message' && e.data.injected === 'specialist-report')!;
    expect(spliced).toBeDefined();
    const after = session.acceptedHistory();
    expect(after.eventUuids).toContain(spliced.uuid);
    expect(after.eventUuids).toHaveLength(before.eventUuids.length + 1);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.messages.at(-1)).toEqual({
      role: 'user', content: '[Background specialist] Nadia finished: the answer is 42.',
    });
  });

  it('a prune records a pruned transformation; a summary records the compact-summary uuid', async () => {
    // A tool result big enough to be worth pruning (20k chars = 5k tokens),
    // followed by enough newer text to push it OUT of the protected recent
    // window — without both, pruneToolOutputs hands the history straight back
    // and there is no transformation to record (see the no-op test below).
    const pruned = makeSession({ contextLength: 8192, model: scriptModel([{ text: 'done' }]) });
    pruned.seedHistory([
      { role: 'user', content: 'read the big file' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c0', toolName: 'Read', input: { file_path: 'big.txt' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c0', toolName: 'Read', output: { type: 'text', value: 'y'.repeat(20_000) } }] },
      { role: 'user', content: `recap ${'x'.repeat(16_000)}` },
    ] as any);
    await drainTurn(pruned, 'continue');
    expect(pruned.acceptedHistory().transformation).toEqual({ kind: 'pruned' });
    expect(JSON.stringify(pruned.acceptedHistory().messages)).toContain('pruned —');

    const events: TranscriptEvent[] = [];
    const summarized = makeSession({
      contextLength: 4096, seedBulkHistoryTokens: 6000, onEvent: (e) => events.push(e),
      model: scriptModel([{ text: 'SUMMARY: user wants X; did Y.' }, { text: 'here is the answer' }]),
    });
    await drainTurn(summarized, 'continue');
    const summaryEvent = events.find((e) => e.type === 'compact-summary')!;
    expect(summarized.acceptedHistory().transformation).toEqual({ kind: 'summary', summaryEventUuid: summaryEvent.uuid });
  });

  it('clearHistory empties the accepted list and is itself a durable change', async () => {
    const session = makeSession({ model: scriptModel([{ text: 'ok' }]) });
    await drainTurn(session, 'hello');
    const before = session.acceptedHistory();
    expect(before.eventUuids.length).toBeGreaterThan(0);

    expect(session.clearHistory()).toEqual({ ok: true });
    const cleared = session.acceptedHistory();
    expect(cleared.eventUuids).toEqual([]);
    expect(cleared.revision).toBe(before.revision + 1);
  });

  it('seedHistory restores the accepted list, revision and transformation from a checkpoint', () => {
    const session = makeSession({});
    session.seedHistory([{ role: 'user', content: 'earlier' }] as any, {
      eventUuids: ['e1', 'e2'], revision: 9, transformation: { kind: 'pruned' },
      continuationBinding: 'chatgpt\u0000gpt-test\u0000hashed-account\u0000epoch-1',
    });
    expect(session.acceptedHistory()).toMatchObject({
      eventUuids: ['e1', 'e2'], revision: 9, transformation: { kind: 'pruned' },
      binding: 'chatgpt\u0000gpt-test\u0000hashed-account\u0000epoch-1',
    });
    // No seed → an empty capture at the next revision (the resume-without-a-
    // checkpoint path, which every existing test already takes).
    session.seedHistory([{ role: 'user', content: 'earlier' }] as any);
    expect(session.acceptedHistory()).toMatchObject({ eventUuids: [], revision: 10, transformation: undefined });
  });

  it('a seeded continuation binding fences ciphertext accepted under a different identity', async () => {
    const seeded = (identityNow: string) => {
      const model = bindOpenAIContinuationModel(scriptModel([{ text: 'ok' }]) as any, identityNow);
      const session = new HarnessSession(
        makeOpts({ binding: { providerId: 'chatgpt', modelId: 'gpt-test' } }),
        async () => model as any,
      );
      session.seedHistory([
        { role: 'user', content: 'earlier' },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'private', providerOptions: { openai: { itemId: 'rs-1', reasoningEncryptedContent: 'CIPHERTEXT' } } },
            { type: 'text', text: 'visible', providerOptions: { openai: { itemId: 'msg-1' } } },
          ],
        },
      ] as any, {
        eventUuids: ['u1', 'a1'], revision: 3,
        continuationBinding: 'chatgpt\u0000gpt-test\u0000hashed-account\u0000epoch-1',
      });
      return session;
    };

    const switched = seeded('chatgpt\u0000gpt-test\u0000hashed-account\u0000epoch-2');
    await switched.send('again');
    const afterSwitch = JSON.stringify(switched.acceptedHistory().messages);
    expect(afterSwitch).not.toContain('CIPHERTEXT');
    expect(afterSwitch).toContain('visible');   // ordinary text survives the fence

    const same = seeded('chatgpt\u0000gpt-test\u0000hashed-account\u0000epoch-1');
    await same.send('again');
    expect(JSON.stringify(same.acceptedHistory().messages)).toContain('CIPHERTEXT');
  });

  it('the assembly digest is stable across identical sessions and moves with the system prompt or tool list', () => {
    const base = makeSession({ systemPrompt: 'you are an agent' }).assemblyDigest();
    expect(makeSession({ systemPrompt: 'you are an agent' }).assemblyDigest()).toBe(base);
    expect(makeSession({ systemPrompt: 'you are a different agent' }).assemblyDigest()).not.toBe(base);
    expect(makeSession({
      systemPrompt: 'you are an agent',
      tools: [fakeTool('Read'), fakeTool('Glob', { schema: z.object({ pattern: z.string() }) }), fakeTool('Write')],
    }).assemblyDigest()).not.toBe(base);
  });
  it('a compaction that prunes nothing records no transformation and does not move the fence', async () => {
    // WHY (fix pass, review finding 2): this history is over the compaction
    // trigger, so prune RUNS — but its only tool output is eight characters
    // long, so pruneToolOutputs hands every message back untouched. Tagging that
    // as a transformation would bump the revision and invalidate a published
    // checkpoint for a history that is byte-for-byte what it was.
    const session = makeSession({
      contextLength: 8192,
      model: scriptModel([
        { toolCalls: [{ name: 'Read', input: { file_path: 'big.txt' } }], usage: { inputTokens: 7000 } },
        { text: 'done' },
      ]),
    });
    const events: TranscriptEvent[] = collect(session);
    await drainTurn(session, 'read the big file');

    const accepted = session.acceptedHistory();
    expect(accepted.transformation).toBeUndefined();
    // The fence moved only for the things that really changed history: the user
    // message, the two accepted steps, and the two tool events between them.
    const contentEvents = events.filter((e) =>
      e.type === 'user-message' || e.type === 'assistant-text' || e.type === 'tool-use' || e.type === 'tool-result');
    expect(accepted.revision).toBe(contentEvents.length + 1);   // +1: the second (textless) step's own accept
  });

  it('a model swap after a resume stops reporting the seeded continuation binding', () => {
    // WHY (fix pass, review finding 1): the seeded binding is the identity the
    // RESTORED ciphertext was accepted under. A swap strips that ciphertext and
    // moves the assembly digest to the new model, so continuing to report the
    // old identity would label the checkpoint with an identity its content no
    // longer descends from — and the store would happily replay it there.
    const session = makeSession({});
    session.seedHistory([{ role: 'user', content: 'earlier' }] as any, {
      eventUuids: ['u1'], revision: 4,
      continuationBinding: 'chatgpt\u0000gpt-test\u0000hashed-account\u0000epoch-1',
    });
    expect(session.acceptedHistory().binding).toBe('chatgpt\u0000gpt-test\u0000hashed-account\u0000epoch-1');

    session.setBinding({ providerId: 'openrouter', modelId: 'other-model' });
    expect(session.acceptedHistory().binding).toBe('openrouter\u0000other-model');
  });

  it('a continuation strip moves the fence only when it actually removed something', () => {
    // WHY (fix pass, review finding 3): the strip runs on EVERY identity change,
    // including the first dispatch of a session that never carried a private
    // part. It always allocates a new array, so only a part or a message
    // actually disappearing is a real change.
    const plain = makeSession({});
    plain.seedHistory([
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: [{ type: 'text', text: 'visible' }] },
    ] as any, { eventUuids: ['u1', 'a1'], revision: 5 });
    plain.setBinding({ providerId: 'openrouter', modelId: 'other-model' });
    expect(plain.acceptedHistory().revision).toBe(5);

    // Control: the same swap over a history that DOES carry ciphertext is a real
    // rewrite, and must move the fence.
    const withCiphertext = makeSession({});
    withCiphertext.seedHistory([
      { role: 'user', content: 'earlier' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'private', providerOptions: { openai: { itemId: 'rs-1', reasoningEncryptedContent: 'CIPHERTEXT' } } },
          { type: 'text', text: 'visible', providerOptions: { openai: { itemId: 'msg-1' } } },
        ],
      },
    ] as any, { eventUuids: ['u1', 'a1'], revision: 5 });
    withCiphertext.setBinding({ providerId: 'openrouter', modelId: 'other-model' });
    expect(withCiphertext.acceptedHistory().revision).toBe(6);
    expect(JSON.stringify(withCiphertext.acceptedHistory().messages)).not.toContain('CIPHERTEXT');
  });

  it('a throw before the next step never re-pushes the previous step\'s partial', async () => {
    // WHY this stubs a private method (fix pass, review finding 4): maybeCompact
    // is the only awaited work between accepting step N and starting step N+1,
    // and what is under test is the LOOP's ordering — that the in-flight partial
    // is cleared before anything that can throw runs — not which internal call
    // happens to throw. (In production the reachable throw is a transcript-event
    // listener, i.e. the host's own persistence wire, raising while
    // compact-summary is emitted.)
    const read = fakeTool('Read');
    const events: TranscriptEvent[] = [];
    const session = makeSession({
      onEvent: (e) => events.push(e),
      tools: [read],
      model: scriptModel([
        { text: 'first answer', toolCalls: [{ name: 'Read', input: { file_path: 'a.txt' } }] },
        { text: 'unreached' },
      ]),
    });
    let compactCalls = 0;
    const realCompact = (session as any).maybeCompact.bind(session);
    (session as any).maybeCompact = async (...args: any[]) => {
      compactCalls++;
      if (compactCalls === 2) throw new Error('compaction exploded');
      return realCompact(...args);
    };

    await session.send('go');

    const history = (session as any).history as any[];
    // The step's own assistant message is the ONLY place that text may appear.
    // Pushed twice, the model would read its own answer back as a second turn.
    expect(JSON.stringify(history).match(/first answer/g) ?? []).toHaveLength(1);
    const accepted = session.acceptedHistory();
    expect(accepted.eventUuids.filter((u) => u === uuidOfText(events, 'first answer'))).toHaveLength(1);
    expect(accepted.messages).toEqual(history);
  });

  it('an interrupt during a permission ask records every canceled tool-result uuid', async () => {
    const events: TranscriptEvent[] = [];
    const session = makeSession({
      onEvent: (e) => events.push(e),
      tools: [fakeTool('Write'), fakeTool('Read')],
      decide: async () => ({ action: 'ask', denyListed: false }),
      askUser: async (): Promise<AskDecision> => ({ behavior: 'canceled' }),
      model: scriptModel([{
        text: 'working',
        toolCalls: [
          { name: 'Write', input: { file_path: 'x.ts' } },
          { name: 'Read', input: { file_path: 'y.ts' } },
        ],
      }]),
    });
    await session.send('go');

    // Both calls get a back-filled canceled result (the pairing invariant), and
    // the accepted list must name every one of them — the tool message in
    // history is built from exactly these events.
    expect(events.filter((e) => e.type === 'tool-result')).toHaveLength(2);
    const contentEvents = events.filter((e) =>
      e.type === 'user-message' || e.type === 'assistant-text' || e.type === 'tool-use' || e.type === 'tool-result');
    expect(session.acceptedHistory().eventUuids).toEqual(contentEvents.map((e) => e.uuid));
  });

  it('a dismissed question records both the real result and the not-run sibling', async () => {
    const events: TranscriptEvent[] = [];
    const ask = fakeTool('AskUserQuestion', { interactive: true, schema: z.object({ prompt: z.string() }) });
    const session = makeSession({
      onEvent: (e) => events.push(e),
      tools: [ask, fakeTool('Read')],
      askUser: async (): Promise<AskDecision> => ({ behavior: 'deny', dismissed: true }),
      model: scriptModel([{
        toolCalls: [
          { name: 'AskUserQuestion', input: { prompt: 'which one?' } },
          { name: 'Read', input: { file_path: 'y.ts' } },
        ],
      }, { text: 'never reached' }]),
    });
    await session.send('go');

    const results = events.filter((e) => e.type === 'tool-result');
    expect(results).toHaveLength(2);                       // the dismissal + the not-run sibling
    const contentEvents = events.filter((e) =>
      e.type === 'user-message' || e.type === 'assistant-text' || e.type === 'tool-use' || e.type === 'tool-result');
    expect(session.acceptedHistory().eventUuids).toEqual(contentEvents.map((e) => e.uuid));
  });

  it('a step that throws mid-text accepts its partial exactly once', async () => {
    const events: TranscriptEvent[] = [];
    // A non-retryable error (no status code) mid-stream: withRetry rethrows
    // immediately, so send()'s catch is what pushes the partial.
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: stream(...textChunks('a', 'half an answer'), { type: 'error', error: new Error('provider exploded') }),
        }),
      }),
    });
    const session = makeSession({ onEvent: (e) => events.push(e), model });
    await session.send('go');

    const accepted = session.acceptedHistory();
    expect(events.some((e) => e.type === 'session-error')).toBe(true);
    expect(accepted.messages.at(-1)).toEqual({ role: 'assistant', content: 'half an answer' });
    const contentEvents = events.filter((e) => e.type === 'user-message' || e.type === 'assistant-text');
    expect(accepted.eventUuids).toEqual(contentEvents.map((e) => e.uuid));
  });

  it('an empty step abandons its attempt — only the silent re-run is accepted', async () => {
    const read = fakeTool('Read');
    const model = scriptedModel([
      stream(...textChunks('a', 'reading'), toolCallChunk('c1', 'Read', { file_path: 'x.ts' }), finishChunk('tool-calls')),
      stream(...reasoningChunks('r', 'thinking but silent'), finishChunk('stop')),   // degenerate empty step
      stream(...textChunks('b', 'recovered'), finishChunk('stop')),                  // the silent re-run
    ]);
    const session = new HarnessSession(
      makeOpts({ tools: [read], decide: async () => ({ action: 'allow', denyListed: false }) }),
      async () => model as any,
    );
    const events = collect(session);
    await session.send('go');

    const accepted = session.acceptedHistory();
    // The empty step pushed NOTHING, so its reasoning event backs no message.
    const silent = events.find((e) => e.type === 'assistant-thinking' && e.data.text === 'thinking but silent')!;
    expect(accepted.eventUuids).not.toContain(silent.uuid);
    const contentEvents = events.filter((e) =>
      e.type === 'user-message' || e.type === 'assistant-text' || e.type === 'tool-use' || e.type === 'tool-result');
    expect(contentEvents.map((e) => e.type)).toEqual(['user-message', 'assistant-text', 'tool-use', 'tool-result', 'assistant-text']);
    expect(accepted.eventUuids).toEqual(contentEvents.map((e) => e.uuid));
  });
  it('a summary ACCEPTS the compact-summary event uuid, on both the automatic and the manual path', async () => {
    // WHY (review leftover 1): the transformation names the summary event, but
    // the accepted list is what the store turns into content references. Without
    // the uuid in that list the summary message has no event to point at, so it
    // is persisted as a bounded copy of its own text instead of a reference to
    // the compact-summary event that already holds it.
    const autoEvents: TranscriptEvent[] = [];
    const summarized = makeSession({
      contextLength: 4096, seedBulkHistoryTokens: 6000, onEvent: (e) => autoEvents.push(e),
      model: scriptModel([{ text: 'SUMMARY: user wants X; did Y.' }, { text: 'here is the answer' }]),
    });
    await drainTurn(summarized, 'continue');
    const autoUuid = autoEvents.find((e) => e.type === 'compact-summary')!.uuid;
    expect(summarized.acceptedHistory().eventUuids).toContain(autoUuid);

    // The manual /compact path is a second, independent summary site.
    const manualEvents: TranscriptEvent[] = [];
    const manual = makeSession({
      onEvent: (e) => manualEvents.push(e),
      model: scriptModel([{ text: 'Earlier: user asked about X; we did Y.' }]),
    });
    manual.seedHistory(Array.from({ length: 4 }, (_, i) => [
      { role: 'user', content: `question ${i} ${'x'.repeat(400)}` },
      { role: 'assistant', content: `answer ${i} ${'y'.repeat(400)}` },
    ]).flat() as any);
    expect(await manual.compactNow()).toEqual({ ok: true });
    const manualUuid = manualEvents.find((e) => e.type === 'compact-summary')!.uuid;
    // seedHistory without a seed empties the capture, so the summary uuid is the
    // ONLY thing this session ever accepted — an exact-equality assertion.
    expect(manual.acceptedHistory().eventUuids).toEqual([manualUuid]);
  });

  it('a listener that throws on the tool-use emit never re-pushes the accepted step\'s text', async () => {
    // WHY (review leftover 3): the step's text is pushed and accepted at the top
    // of the loop body, but everything after it — the tool-use emits, a
    // permission ask, the turn-complete emit — can still throw into send()'s
    // catch, which pushes whatever partial is still in hand. A transcript-event
    // listener is the production throw: it is the host's own persistence wire.
    const read = fakeTool('Read');
    const events: TranscriptEvent[] = [];
    const session = makeSession({
      tools: [read],
      model: scriptModel([
        { text: 'first answer', toolCalls: [{ name: 'Read', input: { file_path: 'a.txt' } }] },
        { text: 'unreached' },
      ]),
    });
    let exploded = false;
    session.on('transcript-event', (e: TranscriptEvent) => {
      events.push(e);
      if (e.type === 'tool-use' && !exploded) { exploded = true; throw new Error('persistence wire exploded'); }
    });

    await session.send('go');

    expect(exploded).toBe(true);
    const history = (session as any).history as any[];
    // Pushed twice, the model reads its own answer back as an extra turn.
    expect(JSON.stringify(history).match(/first answer/g) ?? []).toHaveLength(1);
    const accepted = session.acceptedHistory();
    expect(accepted.eventUuids.filter((u) => u === uuidOfText(events, 'first answer'))).toHaveLength(1);
    expect(accepted.messages).toEqual(history);
  });

  it('a same-binding setBinding after a resume keeps the seeded continuation identity', () => {
    // WHY (review leftover 4): ipc-handlers/remote-server re-apply the CURRENT
    // model on ordinary paths. The ciphertext strip is gated on a real change,
    // so it correctly does nothing here — but clearing the seeded identity
    // anyway would downgrade the published binding to the model-only fallback,
    // describing accepted history the checkpoint no longer matches and making
    // the next checkpoint ineligible for replay.
    const identity = ['chatgpt', 'gpt-test', 'hashed-account', 'epoch-1'].join('\u0000');
    const session = new HarnessSession(
      makeOpts({ binding: { providerId: 'chatgpt', modelId: 'gpt-test' } }),
      async () => scriptModel([{ text: 'ok' }]) as any,
    );
    session.seedHistory([{ role: 'user', content: 'earlier' }] as any, { eventUuids: ['u1'], revision: 4, continuationBinding: identity });
    expect(session.acceptedHistory().binding).toBe(identity);

    session.setBinding({ providerId: 'chatgpt', modelId: 'gpt-test' });
    expect(session.acceptedHistory().binding).toBe(identity);
  });
  it('a listener that throws on the user-interrupt emit never re-pushes the interrupted partial', async () => {
    // The interrupt push is the SECOND acceptance site inside the loop, and the
    // user-interrupt emit right after it is reachable throw-territory for the
    // same reason as the tool-use emit above.
    const model = new MockLanguageModelV4({
      doStream: async () => ({ stream: hangingStream(...textChunks('a', 'visible partial')) }),
    });
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events: TranscriptEvent[] = [];
    let exploded = false;
    session.on('transcript-event', (e: TranscriptEvent) => {
      events.push(e);
      // One-shot: send()'s catch emits user-interrupt a second time, and a
      // listener that threw there too would take the whole turn down with it —
      // which is not what this test is about.
      if (e.type === 'user-interrupt' && !exploded) { exploded = true; throw new Error('persistence wire exploded'); }
    });

    const sent = session.send('go');
    await waitForEvent(events, (e) => e.type === 'assistant-text');
    session.interrupt();
    await sent;

    expect(exploded).toBe(true);
    const history = (session as any).history as any[];
    expect(JSON.stringify(history).match(/visible partial/g) ?? []).toHaveLength(1);
    expect(session.acceptedHistory().messages).toEqual(history);
  });
});
