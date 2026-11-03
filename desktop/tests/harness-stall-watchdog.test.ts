// HarnessSession streaming inactivity watchdog (native runtime). WHY: a provider that holds the socket open but stops
// emitting (keep-alive pings over a stalled upstream, a half-open connection after suspend) sends no chunk, finish or
// error, so without a watchdog the turn hangs on "Thinking" forever. It warns after `stallWarningMs`, then after a
// further `stallCountdownMs` auto-retries ONCE (nothing streamed) or surfaces a session-error; once content streamed it
// parks. Shortened timings (test hook) + REAL timers avoid fake-timer juggling against live stream reads.
import { describe, it, expect, vi } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { HarnessSession, type HarnessSessionOpts, StreamStallError } from '../src/main/harness/harness-session';
import type { HarnessManifest } from '../src/shared/harness-manifest';
import { looseData, type TranscriptEvent, type EventOf } from '../src/shared/types';
import { textChunks, finishChunk, stream } from './helpers/scripted-model';

// A raw V4 stream that emits the given chunks then DELIBERATELY never closes —
// the provider-went-silent case the watchdog exists for.
function hangingStream(...chunks: any[]) {
  return new ReadableStream({
    start(controller) {
      for (const c of [{ type: 'stream-start', warnings: [] }, ...chunks]) controller.enqueue(c);
      // no controller.close() — hang until the reader is cancelled.
    },
  });
}
// A normal completing stream from raw chunks.
function completingStream(...chunks: any[]) {
  return simulateReadableStream({ chunks: stream(...chunks) });
}
// A model that returns a DIFFERENT stream per doStream call (one per attempt).
function modelFromStreams(makers: Array<() => ReadableStream>) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const mk = makers[Math.min(call, makers.length - 1)];
      call++;
      return { stream: mk() };
    },
  });
}

// Watchdog budget, deliberately generous: only the ORDER and COUNT of events are asserted, so a tight budget buys only
// flakes (15ms failed Windows CI: its ~15.6ms timer tick let the warning and the retry's first chunk race; 250ms failed at
// load average ~45). Do NOT tighten toward the event-loop noise floor.
const STALL_MS = 750;
// The "keeps emitting" case needs the opposite margin: 4ms chunk spacing must stay far below this window (400ms failed at
// load average ~36). The window only costs time when the watchdog fires, which is the failure.
const STREAMING_WINDOW_MS = 2000;

// WHY: the both-attempts-stall case spends warn+countdown twice in REAL time; bound the test so only the watchdog constants govern the outcome.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const HARNESS: HarnessManifest = {
  schema: 1, id: 'agent', name: 'Agent', systemPrompt: 'sys', tools: [],
  permissionPolicy: 'ask', limits: { maxTokens: 256 },
};
function makeOpts(over: Partial<HarnessSessionOpts>): HarnessSessionOpts {
  return {
    sessionId: 's-1', cwd: 'C:/x', harness: HARNESS,
    binding: { providerId: 'openrouter', modelId: 'm' },
    retryDelays: [1, 1, 1],
    stallWarningMs: STALL_MS, stallCountdownMs: STALL_MS,
    ...over,
  } as HarnessSessionOpts;
}
function collect(session: HarnessSession): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
  return events;
}
const types = (events: TranscriptEvent[]) => events.map((e) => e.type);
const stallWarnings = (events: TranscriptEvent[]) =>
  events.filter((e): e is EventOf<'assistant-thinking'> => e.type === 'assistant-thinking' && !!e.data.stallWarning);
const stalledCards = (events: TranscriptEvent[]) =>
  events.filter((e): e is EventOf<'assistant-thinking'> => e.type === 'assistant-thinking' && e.data.stalled === true);

// A parked turn's send() promise stays pending BY DESIGN: poll the collected events, then end the turn explicitly.
async function waitForEvent(
  events: TranscriptEvent[],
  pred: (e: TranscriptEvent) => boolean,
  timeoutMs = 30_000,
): Promise<TranscriptEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = events.find(pred);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error('timed out waiting for event');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const isStalled = (e: TranscriptEvent) => e.type === 'assistant-thinking' && e.data.stalled === true;
/** A session over scripted streams (one per attempt) with its event log. */
function newSession(makers: Array<() => ReadableStream>, over: Partial<HarnessSessionOpts> = {}) {
  const model = modelFromStreams(makers);
  const session = new HarnessSession(makeOpts(over), async () => model as any);
  return { session, events: collect(session) };
}
/** Resolves which way a turn ended, failing fast instead of hanging if it parked. */
const endedOrParked = (events: TranscriptEvent[]) => Promise.race([
  waitForEvent(events, (e) => e.type === 'session-error', 5_000).then(() => 'session-error' as const),
  waitForEvent(events, isStalled, 5_000).then(() => 'parked' as const),
]);
/** A stream that emits a partial sentence, then can be woken on the SAME connection. */
function wakeableStream() {
  let controller!: ReadableStreamDefaultController<any>;
  const stream0 = new ReadableStream({
    start(c) {
      controller = c;
      for (const chunk of [{ type: 'stream-start', warnings: [] }, ...textChunks('a', 'half ')]) c.enqueue(chunk);
    },
  });
  return { controller: () => controller, make: () => stream0 };
}

describe('HarnessSession — streaming inactivity watchdog', () => {
  it('silent stall with nothing streamed: warns (willRetry) then AUTO-RETRIES and completes', async () => {
    const { session, events } = newSession([
      () => hangingStream(),                                           // attempt 0: stalls silently
      () => completingStream(...textChunks('a', 'recovered'), finishChunk('stop')), // retry: succeeds
    ]);
    await session.send('go');

    // A stall warning was surfaced, promising a retry.
    const warns = stallWarnings(events);
    expect(warns).toHaveLength(1);
    expect(warns[0].data.stallWarning).toEqual({ retryInMs: STALL_MS, willRetry: true });
    // The retry produced the real answer and the turn completed normally.
    const text = events.find((e) => e.type === 'assistant-text');
    expect(text && looseData(text).text).toBe('recovered');
    expect(types(events)).toContain('turn-complete');
    expect(types(events)).not.toContain('session-error');
  });

  it('stall on BOTH the first attempt and the retry: second warning is non-retry, ends in session-error', async () => {
    const { session, events } = newSession([() => hangingStream(), () => hangingStream(), () => hangingStream()]);
    await session.send('go');

    const warns = stallWarnings(events);
    expect(warns).toHaveLength(2);
    expect(warns[0].data.stallWarning!.willRetry).toBe(true);   // first: retry promised
    expect(warns[1].data.stallWarning!.willRetry).toBe(false);  // retry also stalled: no more retries
    const errs = events.filter((e) => e.type === 'session-error');
    expect(errs).toHaveLength(1);
    // Nothing ever streamed, so the model never began; "stopped responding" would send the user hunting a provider fault (usually just a long prompt on a local model).
    expect(errs[0].data.text).toMatch(/didn't begin responding/i);
    expect(errs[0].data.text).not.toMatch(/stopped responding/i);
    expect(types(events)).not.toContain('turn-complete');
  });

  it('a stall with NOTHING ever streamed still ENDS the turn — Clock 1 is out of scope', async () => {
    // Both attempts hang with zero chunks (Clock 1: nothing arrived yet). Park is scoped to Clock 2 (arrived, then went
    // quiet), so once the one silent auto-retry is spent the turn must END with "didn't begin responding", not park. Raced
    // with a bound so a regression fails fast instead of at the 120s testTimeout.
    const { session, events } = newSession([() => hangingStream(), () => hangingStream()]);
    void session.send('go');
    const outcome = await endedOrParked(events);
    expect(outcome, 'expected the turn to end, but it parked').toBe('session-error');

    expect(types(events)).toContain('session-error');
    expect(stalledCards(events)).toHaveLength(0);
  });

  it('a stall AFTER output has started still says the model STOPPED responding', () => {
    // Once parts have flowed, silence means something went wrong mid-stream. Asserted on the error class directly (a real mid-stream stall would hang the test).
    const err = new StreamStallError(75_000, 'streaming');
    expect(err.message).toMatch(/stopped responding/i);
    expect(err.message).not.toMatch(/didn't begin responding/i);
  });

  it('stall AFTER content already streamed: PARKS the turn instead of erroring', async () => {
    // One text delta lands, THEN silence: raises the stalled card and the turn stays alive (it used to end in a session-error).
    const { session, events } = newSession([() => hangingStream(...textChunks('a', 'partial answer'))]);
    const sent = session.send('go');

    await waitForEvent(events, isStalled);
    // Partial text still on screen, no retry promised, nothing ended the turn.
    expect(events.find((e): e is EventOf<'assistant-text'> => e.type === 'assistant-text')?.data.text).toBe('partial answer');
    expect(stallWarnings(events)).toHaveLength(1);
    expect(stallWarnings(events)[0].data.stallWarning!.willRetry).toBe(false);
    expect(stalledCards(events)).toHaveLength(1);
    expect(types(events)).not.toContain('session-error');
    expect(types(events)).not.toContain('turn-complete');

    // Only the user ends it.
    session.interrupt();
    await sent;
    expect(types(events)).toContain('user-interrupt');
  });

  it('a SPECIALIST CHILD never parks — the identical stall ends its turn instead', async () => {
    // WHY a child must not park: its heartbeats are filtered out of the parent's view (only tool-use / tool-result /
    // assistant-text are re-emitted), so a parked child shows the user NOTHING while the parent's Task call waits forever.
    // Ending with the stall error is what the Task tool recovers from. Both halves use ONE stream shape (one text delta,
    // then silence), so the contrast can only come from the flag.
    const stalling = () => hangingStream(...textChunks('a', 'partial answer'));

    const { session: child, events: childEvents } = newSession([stalling], { isSpecialistChild: true });
    void child.send('go');
    const outcome = await endedOrParked(childEvents);
    expect(outcome, 'expected the child to END its turn, but it parked').toBe('session-error');
    expect(stalledCards(childEvents)).toHaveLength(0);
    const errs = childEvents.filter((e) => e.type === 'session-error');
    expect(errs).toHaveLength(1);
    // Content DID stream before the silence, so this is the mid-stream wording.
    expect(errs[0].data.text).toMatch(/stopped responding/i);

    // The SAME stream in a ROOT session parks and stays alive.
    const { session: root, events: rootEvents } = newSession([stalling]);
    const sent = root.send('go');
    await waitForEvent(rootEvents, isStalled);
    expect(types(rootEvents)).not.toContain('session-error');
    root.interrupt();
    await sent;
  });

  it('a stream that keeps emitting (slower than the warn window) NEVER trips the watchdog', async () => {
    // Chunks 4ms apart against a wide window: the watchdog is re-armed on every chunk and never fires.
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunkDelayInMs: 4,
          chunks: stream(...textChunks('a', 'one'), ...textChunks('b', 'two'), finishChunk('stop')),
        }),
      }),
    });
    const session = new HarnessSession(makeOpts({ stallWarningMs: STREAMING_WINDOW_MS, stallCountdownMs: STREAMING_WINDOW_MS }), async () => model as any);
    const events = collect(session);
    await session.send('go');

    expect(stallWarnings(events)).toHaveLength(0);
    expect(types(events)).toContain('turn-complete');
    expect(types(events)).not.toContain('session-error');
  });

  it('a chunk arriving AFTER the card clears it and the turn completes normally', async () => {
    // Emits, goes quiet past warn+countdown, then wakes up on the SAME connection.
    const w = wakeableStream();
    const { session, events } = newSession([w.make]);
    const sent = session.send('go');

    await waitForEvent(events, isStalled);
    for (const c of stream(...textChunks('a', 'a sentence'), finishChunk('stop'))) w.controller().enqueue(c);
    w.controller().close();

    await sent;
    expect(types(events)).toContain('turn-complete');
    expect(types(events)).not.toContain('session-error');
    // The clearing heartbeat (no stalled, no stallWarning) followed the card.
    const cardIdx = events.findIndex((e) => e.type === 'assistant-thinking' && e.data.stalled === true);
    const cleared = events.slice(cardIdx + 1).find(
      (e) => e.type === 'assistant-thinking' && !e.data.stalled && !e.data.stallWarning && !e.data.text,
    );
    expect(cleared).toBeDefined();
  });

  it('Retry erases the abandoned text, re-runs the step, and completes', async () => {
    const { session, events } = newSession([
      () => hangingStream(...textChunks('a', 'Now I will dispatch')),          // stalls mid-sentence
      () => completingStream(...textChunks('a', 'recovered'), finishChunk('stop')),
    ]);
    const sent = session.send('go');

    await waitForEvent(events, isStalled);
    expect(session.retryStalledStep()).toBe(true);
    await sent;

    // The abandoned part was explicitly dropped before the re-run...
    const drop = events.find((e): e is EventOf<'assistant-thinking'> => e.type === 'assistant-thinking' && !!e.data.dropPart);
    expect(drop).toBeDefined();
    expect(drop!.data.dropPart!.partIds).toContain('a');
    // The drop must precede the retry's first text, or the renderer would erase the new answer.
    const dropIdx = events.indexOf(drop!);
    const recoveredIdx = events.findIndex((e) => e.type === 'assistant-text' && e.data.text === 'recovered');
    expect(dropIdx).toBeLessThan(recoveredIdx);
    expect(types(events)).toContain('turn-complete');
    expect(types(events)).not.toContain('session-error');
  });

  it("Retry erases the abandoned sentence from the MODEL's memory, not just the screen", async () => {
    // Third leg of the three-place erase (screen dropPart, store buffer, model history): send()'s catch pushes the running
    // assistant text into history on an abnormal end, and the Retry branch's `reportPartial('')` is the ONLY thing that
    // clears it. Deleting that line breaks nothing visible; the model would silently re-read an erased sentence. The re-run
    // hits a PROVIDER ERROR (not another stall, which would just park again) because that is the reachable way to end through the catch.
    const { session, events } = newSession([
      () => hangingStream(...textChunks('a', 'Now I will dispatch')), // stalls mid-sentence
      () => completingStream({ type: 'error', error: new Error('upstream 502 from the provider') }),
    ]);
    const sent = session.send('go');

    await waitForEvent(events, isStalled);
    expect(session.retryStalledStep()).toBe(true);
    await sent;
    expect(types(events)).toContain('session-error');

    const history = (session as any).history as any[];
    const assistantText = history
      .filter((m) => m.role === 'assistant')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    expect(assistantText).not.toContain('Now I will dispatch');
  });

  it('Retry is a no-op when nothing is parked', async () => {
    const { session } = newSession([() => completingStream(...textChunks('a', 'fine'), finishChunk('stop'))]);
    await session.send('go');
    expect(session.retryStalledStep()).toBe(false);
  });

  it('a retried step that stalls again PARKS again — it never dies on its own', async () => {
    // Both attempts hang; the second is a first-byte (Clock 1) wait, but once the user has seen the card (turnEverParked) the step can no longer end the turn itself.
    const { session, events } = newSession([
      () => hangingStream(...textChunks('a', 'first try')),
      () => hangingStream(),
    ], { prefillWarningMs: STALL_MS });
    const sent = session.send('go');

    await waitForEvent(events, isStalled);
    session.retryStalledStep();
    // Wait on the stalled-card COUNT: a predicate comparing against the dropPart index races (dropPart is not emitted yet, so the first card satisfies it).
    await waitForEvent(events, () => stalledCards(events).length >= 2);
    expect(stalledCards(events).length).toBeGreaterThanOrEqual(2);
    expect(types(events)).not.toContain('session-error');

    session.interrupt();
    await sent;

    // Checked after the turn settles: the SECOND stalled card must follow the dropPart that erased the first attempt's text.
    const dropIdx = events.findIndex((e) => e.type === 'assistant-thinking' && e.data.dropPart);
    expect(dropIdx).toBeGreaterThanOrEqual(0);
    const secondStalledIdx = events.indexOf(stalledCards(events)[1]);
    expect(secondStalledIdx).toBeGreaterThan(dropIdx);
  });

  it('Retry is a no-op once a real chunk has un-parked the stream — it must not tear down a live stream', async () => {
    // WHY: retryStalledStep() only tears down the stream while `resolveRetry` is live. If the un-park branch stopped
    // clearing it, a stale Retry click would kill a stream actively producing GOOD text. Park, let a real chunk un-park it
    // on the SAME connection, then a Retry click must return false and emit no dropPart.
    const w = wakeableStream();
    const { session, events } = newSession([w.make]);
    const sent = session.send('go');

    await waitForEvent(events, isStalled);
    for (const c of stream(...textChunks('a', 'a sentence'))) w.controller().enqueue(c);
    await waitForEvent(events, (e) => e.type === 'assistant-text' && e.data.text === 'a sentence');

    expect(session.retryStalledStep()).toBe(false);
    expect(events.find((e) => e.type === 'assistant-thinking' && e.data.dropPart)).toBeUndefined();

    w.controller().enqueue(finishChunk('stop'));
    w.controller().close();
    await sent;
    expect(types(events)).toContain('turn-complete');
    expect(types(events)).not.toContain('session-error');
  });
});
