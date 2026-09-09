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
import { finishChunk, reasoningChunks, stream, textChunks } from './helpers/scripted-model';

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

  it('a steer, a status snapshot and a rule injection each bump the revision without adding a uuid', async () => {
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

    const status = [{
      childId: 'child-1', title: 'Nadia', agentType: 'researcher', status: 'running' as const,
      delivered: false, stale: false, startedAt: 1_000,
    }];
    const withStatus = build({ specialistStatus: () => status });
    await withStatus.send('go');
    expect(withStatus.acceptedHistory().eventUuids).toHaveLength(plain.eventUuids.length);
    expect(withStatus.acceptedHistory().revision).toBe(plain.revision + 1);

    const triggers: TriggerIndex = { match: () => [{ id: 'r1', source: '.claude/rules/api.md', body: 'Always validate input.' }] };
    const injected = build({ triggers });
    await injected.send('go');
    expect(injected.acceptedHistory().eventUuids).toHaveLength(plain.eventUuids.length);
    expect(injected.acceptedHistory().revision).toBe(plain.revision + 1);
    expect(JSON.stringify(injected.acceptedHistory().messages)).toContain('Always validate input');
  });

  it('a prune records a pruned transformation; a summary records the compact-summary uuid', async () => {
    const pruned = makeSession({
      contextLength: 8192,
      model: scriptModel([
        { toolCalls: [{ name: 'Read', input: { file_path: 'big.txt' } }], usage: { inputTokens: 7000 } },
        { text: 'done' },
      ]),
    });
    await drainTurn(pruned, 'read the big file');
    expect(pruned.acceptedHistory().transformation).toEqual({ kind: 'pruned' });

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
});
