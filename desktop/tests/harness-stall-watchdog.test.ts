// HarnessSession streaming inactivity watchdog (native runtime). Pins the fix
// for the "stuck on Thinking, no error, no response" symptom: a provider that
// holds the socket open but stops emitting (OpenRouter keep-alive pings while an
// upstream stalls, a half-open connection after a suspend) sends no chunk, no
// finish, and no error — so without a watchdog the turn hangs forever with the
// spinner up. The watchdog warns after `stallWarningMs`, then after a further
// `stallCountdownMs` of silence auto-retries ONCE (when nothing had streamed) or
// surfaces a session-error. These use shortened watchdog timings (test hook) +
// REAL timers so there's no fake-timer/microtask juggling against live stream
// reads. "Shortened", NOT tiny — see STALL_MS for why that distinction cost a
// Windows CI run.
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

// One named knob for the watchdog budget, deliberately generous.
//
// This was 15ms, which took Windows CI red on PR #185 with "expected length 1
// but got 2" and then passed on a plain re-run (ROADMAP :176). Nothing here
// asserts on wall-clock — only on the ORDER and COUNT of events — so the budget
// exists purely to be longer than the work, and a tight one buys nothing but
// flakes. Two things made 15ms untenable:
//
//   1. Windows' default timer resolution is ~15.6ms, so a setTimeout(15) fires
//      on the first tick AT OR PAST the budget. The warning timer and the
//      retry's first chunk landed in the same tick and the winner was scheduler
//      noise — hence Windows-only and re-run-green.
//   2. Measured headroom on an idle 32-core Linux box was thin anyway: sweeping
//      the budget, a spurious second warning first appears at 10ms and is the
//      majority outcome by 3ms. 15ms was ~4x the ideal path.
//
// 250ms is ~16x the Windows tick and ~60x the measured ideal path, and costs
// the file well under two seconds. Do NOT tighten these back toward the
// event-loop noise floor to save milliseconds.
const STALL_MS = 250;
// The "keeps emitting" case needs the opposite margin: its chunk SPACING must
// stay far below the window, or a scheduling hiccup between chunks fires the
// watchdog and fails a never-warns assertion. 4ms spacing vs a 400ms window.
const STREAMING_WINDOW_MS = 400;

// Raising the watchdog budgets moved the risk rather than removing it: the
// both-attempts-stall case now spends warn+countdown twice = ~1.0s of REAL time
// against vitest's default 5000ms testTimeout, i.e. ~5x headroom on a file that
// previously had ~300x. That is the same too-tight-budget bet this PR exists to
// kill, just one level up. Bound the test explicitly so only the watchdog
// constants above govern the outcome.
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
    // Real timers (see the file header) with a budget that machine load cannot
    // close — see STALL_MS.
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

// A parked turn's send() promise stays pending BY DESIGN — that is the whole
// feature. Poll the collected events instead of awaiting send(), then end the
// turn explicitly so the promise settles and the test can finish.
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

describe('HarnessSession — streaming inactivity watchdog', () => {
  it('silent stall with nothing streamed: warns (willRetry) then AUTO-RETRIES and completes', async () => {
    const model = modelFromStreams([
      () => hangingStream(),                                           // attempt 0: stalls silently
      () => completingStream(...textChunks('a', 'recovered'), finishChunk('stop')), // retry: succeeds
    ]);
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events = collect(session);
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
    const model = modelFromStreams([() => hangingStream(), () => hangingStream(), () => hangingStream()]);
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events = collect(session);
    await session.send('go');

    const warns = stallWarnings(events);
    expect(warns).toHaveLength(2);
    expect(warns[0].data.stallWarning!.willRetry).toBe(true);   // first: retry promised
    expect(warns[1].data.stallWarning!.willRetry).toBe(false);  // retry also stalled: no more retries
    const errs = events.filter((e) => e.type === 'session-error');
    expect(errs).toHaveLength(1);
    // WORDING CHANGED 2026-07-26, deliberately. Every attempt here uses
    // hangingStream(), so the model never produced a single part — it did not
    // "stop responding", it never began. Claiming otherwise sends the user
    // hunting a provider fault that isn't there, and on a local model the real
    // cause is usually just a long prompt. The mid-stream phrasing is still
    // pinned by the test below.
    expect(errs[0].data.text).toMatch(/didn't begin responding/i);
    expect(errs[0].data.text).not.toMatch(/stopped responding/i);
    expect(types(events)).not.toContain('turn-complete');
  });

  it('a stall with NOTHING ever streamed still ENDS the turn — Clock 1 is out of scope', async () => {
    // Two attempts, both hangingStream() with zero chunks — every wait here is
    // Clock 1 ("nothing has arrived yet", still reading the prompt), never
    // Clock 2 ("arrived, then went quiet"). This project's park behavior is
    // deliberately scoped to Clock 2 only: a model that never sent a single
    // byte hasn't "stalled" in the sense this card means, it just never began,
    // so once the one silent auto-retry is spent, the turn must still END with
    // the honest "didn't begin responding" error — not park and hang forever.
    const model = modelFromStreams([() => hangingStream(), () => hangingStream()]);
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events = collect(session);
    // Don't await send() directly: a parked turn's promise stays pending BY
    // DESIGN (see waitForEvent's own comment), so if the Clock-1 guard were
    // ever widened back to also park here, awaiting send() would sit until
    // this file's 120s testTimeout and report a bare "test timed out" —
    // two minutes of red CI naming nothing. Race the two possible outcomes
    // instead, bounded well above the ~500ms this genuinely needs (the
    // watchdog budget in this file is STALL_MS=250ms, two attempts), so a
    // regression fails FAST with the real cause. Do not remove this bound.
    void session.send('go');
    const outcome = await Promise.race([
      waitForEvent(events, (e) => e.type === 'session-error', 5_000).then(() => 'session-error' as const),
      waitForEvent(events, (e) => e.type === 'assistant-thinking' && e.data.stalled === true, 5_000).then(() => 'parked' as const),
    ]);
    expect(outcome, 'expected the turn to end, but it parked').toBe('session-error');

    expect(types(events)).toContain('session-error');
    expect(stalledCards(events)).toHaveLength(0);
  });

  it('a stall AFTER output has started still says the model STOPPED responding', () => {
    // The complement of the case above: once parts have flowed, silence really
    // does mean something went wrong mid-stream, and the wording must say so.
    // Asserted on the error class directly — driving a real mid-stream stall
    // needs a provider that emits and then hangs forever, which makes the test
    // itself hang rather than prove anything extra.
    const err = new StreamStallError(75_000, 'streaming');
    expect(err.message).toMatch(/stopped responding/i);
    expect(err.message).not.toMatch(/didn't begin responding/i);
  });

  it('stall AFTER content already streamed: PARKS the turn instead of erroring', async () => {
    // One text delta lands, THEN the stream goes silent. This used to be a
    // session-error that ended the turn; now it raises the stalled card and the
    // turn stays alive with the reader still open.
    const model = modelFromStreams([() => hangingStream(...textChunks('a', 'partial answer'))]);
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events = collect(session);
    const sent = session.send('go');

    await waitForEvent(events, (e) => e.type === 'assistant-thinking' && e.data.stalled === true);
    // The partial text is still on screen, the warning did NOT promise a retry,
    // and NOTHING has ended the turn.
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
    // Fix C1 (whole-branch review 2026-08-16), previously untested: deleting the
    // `!this.opts.isSpecialistChild` clause from the park guard left the whole
    // suite green.
    //
    // WHY a child must not park: its heartbeats are filtered out of the parent's
    // view (wireChildLive re-emits only tool-use / tool-result / assistant-text),
    // and the parked signal rides assistant-thinking. So a parked child shows the
    // user NOTHING — no card, no Retry, no Stop — while its send() never settles
    // and the parent's Task call waits on it forever. Ending with the stall error
    // is the behavior the parent's Task tool already knows how to recover from.
    //
    // Both halves are asserted from ONE stream shape, so the contrast can only
    // come from the flag: emit one text delta, then go silent forever.
    const stalling = () => hangingStream(...textChunks('a', 'partial answer'));

    const childModel = modelFromStreams([stalling]);
    const child = new HarnessSession(makeOpts({ isSpecialistChild: true }), async () => childModel as any);
    const childEvents = collect(child);
    // Don't await send() bare: if the guard regresses, the child PARKS and its
    // promise never settles — the test would sit until this file's 120s timeout
    // and report a bare "test timed out", naming nothing. Race the two possible
    // outcomes so a regression fails fast with the real cause.
    void child.send('go');
    const outcome = await Promise.race([
      waitForEvent(childEvents, (e) => e.type === 'session-error', 5_000).then(() => 'session-error' as const),
      waitForEvent(childEvents, (e) => e.type === 'assistant-thinking' && e.data.stalled === true, 5_000)
        .then(() => 'parked' as const),
    ]);
    expect(outcome, 'expected the child to END its turn, but it parked').toBe('session-error');
    expect(stalledCards(childEvents)).toHaveLength(0);
    const errs = childEvents.filter((e) => e.type === 'session-error');
    expect(errs).toHaveLength(1);
    // Content DID stream before the silence, so this is the mid-stream wording.
    expect(errs[0].data.text).toMatch(/stopped responding/i);

    // The SAME stream in a ROOT session parks and stays alive.
    const rootModel = modelFromStreams([stalling]);
    const root = new HarnessSession(makeOpts({}), async () => rootModel as any);
    const rootEvents = collect(root);
    const sent = root.send('go');
    await waitForEvent(rootEvents, (e) => e.type === 'assistant-thinking' && e.data.stalled === true);
    expect(types(rootEvents)).not.toContain('session-error');
    root.interrupt();
    await sent;
  });

  it('a stream that keeps emitting (slower than the warn window) NEVER trips the watchdog', async () => {
    // Chunks spaced 4ms apart, warn window 400ms → the watchdog is re-armed on
    // every chunk and never fires. No stall warning, clean completion.
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
    // A stream that emits, goes quiet past warn+countdown, then wakes up.
    let controller: ReadableStreamDefaultController<any>;
    const wakeable = new ReadableStream({
      start(c) {
        controller = c;
        for (const chunk of [{ type: 'stream-start', warnings: [] }, ...textChunks('a', 'half ')]) c.enqueue(chunk);
      },
    });
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: wakeable }) });
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events = collect(session);
    const sent = session.send('go');

    await waitForEvent(events, (e) => e.type === 'assistant-thinking' && e.data.stalled === true);
    // The provider wakes up on the SAME connection.
    for (const c of stream(...textChunks('a', 'a sentence'), finishChunk('stop'))) controller!.enqueue(c);
    controller!.close();

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
    const model = modelFromStreams([
      () => hangingStream(...textChunks('a', 'Now I will dispatch')),          // stalls mid-sentence
      () => completingStream(...textChunks('a', 'recovered'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events = collect(session);
    const sent = session.send('go');

    await waitForEvent(events, (e) => e.type === 'assistant-thinking' && e.data.stalled === true);
    expect(session.retryStalledStep()).toBe(true);
    await sent;

    // The abandoned part was explicitly dropped before the re-run...
    const drop = events.find((e): e is EventOf<'assistant-thinking'> => e.type === 'assistant-thinking' && !!e.data.dropPart);
    expect(drop).toBeDefined();
    expect(drop!.data.dropPart!.partIds).toContain('a');
    // ...and the drop came BEFORE the retry's first text, or the renderer would
    // erase the new answer instead of the old one.
    const dropIdx = events.indexOf(drop!);
    const recoveredIdx = events.findIndex((e) => e.type === 'assistant-text' && e.data.text === 'recovered');
    expect(dropIdx).toBeLessThan(recoveredIdx);
    expect(types(events)).toContain('turn-complete');
    expect(types(events)).not.toContain('session-error');
  });

  it("Retry erases the abandoned sentence from the MODEL's memory, not just the screen", async () => {
    // The third leg of the "three-place erase" (spec §4): the screen (dropPart),
    // the store's buffered part (session-store), and — here — the model's own
    // conversation history. send() keeps the running assistant text in
    // `partialAssistantText`, and its catch pushes that text into this.history
    // as a real assistant message when the turn ends abnormally. The Retry
    // branch's `reportPartial('')` is the ONLY thing that clears it.
    //
    // Deleting that one line breaks nothing visible: the screen is still
    // correct, no test fails, no error appears. The model just silently
    // re-reads a sentence the user was told had been erased. This test is the
    // only thing standing between that line and a silent regression.
    // The re-run hits a PROVIDER ERROR rather than another stall. That matters:
    // the interrupt path returns a StepResult instead of throwing, so it never
    // reaches the catch, and a second stall would just park again (the turn has
    // already parked, so it can no longer die on its own). A provider error is
    // the reachable way this turn ends through the catch.
    const model = modelFromStreams([
      () => hangingStream(...textChunks('a', 'Now I will dispatch')), // stalls mid-sentence
      () => completingStream({ type: 'error', error: new Error('upstream 502 from the provider') }),
    ]);
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events = collect(session);
    const sent = session.send('go');

    await waitForEvent(events, (e) => e.type === 'assistant-thinking' && e.data.stalled === true);
    expect(session.retryStalledStep()).toBe(true);
    await sent;
    // The re-run failed, so the turn ended through send()'s catch — the one
    // place that pushes in-flight partial text into history.
    expect(types(events)).toContain('session-error');

    const history = (session as any).history as any[];
    const assistantText = history
      .filter((m) => m.role === 'assistant')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    expect(assistantText).not.toContain('Now I will dispatch');
  });

  it('Retry is a no-op when nothing is parked', async () => {
    const model = modelFromStreams([() => completingStream(...textChunks('a', 'fine'), finishChunk('stop'))]);
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    await session.send('go');
    expect(session.retryStalledStep()).toBe(false);
  });

  it('a retried step that stalls again PARKS again — it never dies on its own', async () => {
    // Both attempts hang AFTER emitting, so willRetry is false on both, and the
    // second attempt is a first-byte (Clock 1) wait. turnEverParked forces the
    // park anyway: once the user has seen the card, the step stops being able
    // to end the turn by itself.
    const model = modelFromStreams([
      () => hangingStream(...textChunks('a', 'first try')),
      () => hangingStream(),
    ]);
    const session = new HarnessSession(makeOpts({ prefillWarningMs: STALL_MS }), async () => model as any);
    const events = collect(session);
    const sent = session.send('go');

    await waitForEvent(events, (e) => e.type === 'assistant-thinking' && e.data.stalled === true);
    session.retryStalledStep();
    // NOTE: the brief's original predicate here was
    // `e.data.stalled === true && events.indexOf(e) > events.findIndex(dropPart)`,
    // intended to wait for a SECOND stalled card (one after the drop). It races:
    // retryStalledStep() resolves synchronously and waitForEvent's first check
    // runs before any microtask from that resolution has flushed, so at that
    // instant dropPart hasn't been emitted yet, findIndex(dropPart) is -1, and
    // the FIRST (already-present) stalled card satisfies "index > -1" trivially
    // — the wait resolves immediately on the wrong card. Waiting on the COUNT
    // instead has no such window.
    await waitForEvent(events, () => stalledCards(events).length >= 2);
    expect(stalledCards(events).length).toBeGreaterThanOrEqual(2);
    expect(types(events)).not.toContain('session-error');

    session.interrupt();
    await sent;

    // Ordering, checked now that the turn has settled (avoids the race the NOTE
    // above describes): the SECOND stalled card must come AFTER the dropPart
    // that erased the first attempt's text, or the renderer would show the
    // retry's own stall before ever clearing the abandoned one.
    const dropIdx = events.findIndex((e) => e.type === 'assistant-thinking' && e.data.dropPart);
    expect(dropIdx).toBeGreaterThanOrEqual(0);
    const secondStalledIdx = events.indexOf(stalledCards(events)[1]);
    expect(secondStalledIdx).toBeGreaterThan(dropIdx);
  });

  it('Retry is a no-op once a real chunk has un-parked the stream — it must not tear down a live stream', async () => {
    // Regression coverage for the guard: `retryStalledStep()` only tears down
    // the stream when `resolveRetry` is still live. Deleting the
    // `this.resolveRetry = null` in runStreamOnce's un-park branch (the "warned
    // || parked" real-chunk handler) leaves the OLD resolver alive after the
    // turn has already moved on — a stale Retry click would then kill a stream
    // that is actively producing GOOD text. Parks, lets a real chunk arrive (so
    // the turn un-parks and keeps streaming on the SAME connection), then
    // proves a Retry click at that point is inert: it returns false and emits
    // no dropPart.
    let controller: ReadableStreamDefaultController<any>;
    const wakeable = new ReadableStream({
      start(c) {
        controller = c;
        for (const chunk of [{ type: 'stream-start', warnings: [] }, ...textChunks('a', 'half ')]) c.enqueue(chunk);
      },
    });
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: wakeable }) });
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events = collect(session);
    const sent = session.send('go');

    await waitForEvent(events, (e) => e.type === 'assistant-thinking' && e.data.stalled === true);
    // The provider wakes up on the SAME connection — this un-parks the step and
    // resolveRetry should be cleared as part of that.
    for (const c of stream(...textChunks('a', 'a sentence'))) controller!.enqueue(c);
    await waitForEvent(events, (e) => e.type === 'assistant-text' && e.data.text === 'a sentence');

    // A Retry click landing NOW (after the resume) must be a no-op — the resumed
    // stream must not be torn down and its good text must not be erased.
    expect(session.retryStalledStep()).toBe(false);
    expect(events.find((e) => e.type === 'assistant-thinking' && e.data.dropPart)).toBeUndefined();

    controller!.enqueue(finishChunk('stop'));
    controller!.close();
    await sent;
    expect(types(events)).toContain('turn-complete');
    expect(types(events)).not.toContain('session-error');
  });
});
