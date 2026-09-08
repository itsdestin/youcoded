import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { NativeHome } from '../src/main/native-home';
import { SessionStore } from '../src/main/harness/session-store';
import { NativeSessionHost, SUBAGENT_DISPLAY_TYPES, mergeChildEvents } from '../src/main/harness/native-session-host';
import { PermissionStore } from '../src/main/harness/permission-store';
import { nativeStoreSlug } from '../src/main/slug-encoding';
import { CROSS_PROJECT_SLUG } from '../src/shared/permission-types';
import type { PermissionRule } from '../src/shared/permission-types';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { scriptedModel, stream, textChunks, toolCallChunk, finishChunk } from './helpers/scripted-model';
import { resolveSpecialist } from '../src/main/harness/specialists/registry';
import { SpecialistCatalog } from '../src/main/harness/specialists/catalog';
import { HOSTED_MAX_CONCURRENT_SPECIALISTS, SPECIALIST_NOTE_MAX_CHARS, SPECIALIST_SPAWN_BUDGET_PER_SESSION } from '../src/main/harness/specialists/limits';
import { OWNER, DelegationLedger } from '../src/main/harness/specialists/delegation-ledger';
import { ModelSearchTool } from '../src/main/harness/tools/model-search';
import type { CatalogModel } from '../src/shared/provider-types';

/** Ceiling for this file's fire-and-forget-write polls, as a tries count at the
 *  10ms interval each loop already uses (1,500 x 10ms = 15s, matching the
 *  vi.waitFor default in tests/setup-waitfor.ts).
 *
 *  These loops DO wait on a real signal — the condition they break on — so the
 *  only thing wrong with them was the ceiling: 50 tries is 500ms, a number that
 *  held on an idle machine and lost on ubuntu CI 2026-08-28
 *  (`expected [] to deep equally contain …` — the permission rule was persisted,
 *  just not within half a second under load). An empty result then reads as
 *  "the feature did not run" rather than "this was slow". */
const POLL_TRIES = 1_500;


/** Remove a temp root a live NativeSessionHost was writing into.
 *
 *  `destroyAll()` does not drain the delegation ledger's writes — they are
 *  fire-and-forget by design (native-session-host.ts documents this: a failed
 *  bookkeeping write must never cost the user their session). So a `mutateJson`
 *  can still land inside `<root>/.youcoded/sessions` a tick after teardown
 *  begins, and a plain recursive remove then dies with
 *  `ENOTEMPTY: directory not empty` — a file appeared during its own walk.
 *  `force: true` does NOT cover that; it only swallows ENOENT.
 *
 *  Observed on ubuntu CI 2026-08-28 (a run otherwise fully green), failing a
 *  test that had already passed, because the teardown throws INTO the test.
 *
 *  maxRetries is Node's own answer: fs.rm retries EBUSY/EMFILE/ENFILE/ENOTEMPTY
 *  /EPERM with a linear backoff. Nothing is masked — a root that is genuinely
 *  un-removable still throws after the retries.
 */
function rmHostRoot(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
}


// One turn, two steps: step 1 calls the (gated) Write tool; step 2 — after the
// tool result — stops with text. A FRESH instance per factory call so the
// per-step counter resets each turn. Write is chosen because it is permission-
// gated in 'ask' mode but auto-allowed in 'full-auto' (rulesForMode).
const writeThenStop = () => scriptedModel([
  stream(toolCallChunk('c1', 'Write', { file_path: 'note.txt', content: 'hi' }), finishChunk('tool-calls')),
  stream(...textChunks('t', 'done'), finishChunk('stop')),
]);
const writeFactory = async () => writeThenStop() as any;
// Resolves with the ask's _requestId the first time the host re-emits a native
// PermissionRequest (broker → host 'hook-event').
function firstAsk(h: NativeSessionHost): Promise<string> {
  return new Promise((res) => {
    const on = (e: any) => { if (e.type === 'PermissionRequest') { h.off('hook-event', on); res(e.payload._requestId); } };
    h.on('hook-event', on);
  });
}

// Task 8: resolves with the first transcript-event matching `match` — used to
// catch a delivered host notice (a synthetic user-message with
// data.injected === 'specialist-report', same shape a background specialist
// report rides in on) without racing the delivery pass's own async timing.
function waitForEvent(h: NativeSessionHost, match: (e: any) => boolean): Promise<any> {
  return new Promise((res) => {
    const on = (e: any) => { if (match(e)) { h.off('transcript-event', on); res(e); } };
    h.on('transcript-event', on);
  });
}

// RAW V4 stream-part shapes (see harness-session.test.ts): deltas carry `delta`, usage is nested.
const CHUNKS = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 'p1' },
  { type: 'text-delta', id: 'p1', delta: 'Hi there' },
  { type: 'text-end', id: 'p1' },
  { type: 'finish', finishReason: { unified: 'stop' }, usage: { inputTokens: { total: 3 }, outputTokens: { total: 2 } } },
];
const factory = async () => new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: CHUNKS }) }) }) as any;

// Fix pass 2 (Task 13): the constructor's 3rd param collapsed from a bare
// contextLengthFor(binding) => Promise<number|null> into ONE closure that
// also answers the engine's slot count (contextAndSlotsFor). Most fixtures
// below don't care about either value — this stub answers "no source could
// tell" for both, matching the old `async () => null`'s intent.
const NO_CONTEXT = async () => ({ contextLength: null, totalSlots: null });

// Task 11 inserted a 6th constructor param (pricingFor) right after the vision
// resolver, so every construction that passes ANYTHING beyond the first five
// now carries an explicit `undefined` in that slot — otherwise permissionStore
// and everything after it would silently shift one position left. `undefined`
// takes the param's own default, which answers "no published price".

// A ReadableStream that trickles chunks with a per-chunk delay so a turn can be
// caught mid-stream (for the destroy-while-streaming test). The enqueue loop is
// guarded so a mid-stream cancel (abort → iterator.return) doesn't surface as an
// unhandled rejection.
function delayedStream(chunks: any[], delayMs: number): ReadableStream {
  return new ReadableStream({
    async start(controller) {
      try {
        for (const c of chunks) {
          await new Promise((r) => setTimeout(r, delayMs));
          controller.enqueue(c);
        }
        controller.close();
      } catch { /* stream cancelled mid-emit — expected on abort */ }
    },
  });
}
const delayedFactory = async () => new MockLanguageModelV4({ doStream: async () => ({ stream: delayedStream(CHUNKS, 15) }) }) as any;

// M1: host.send() is now SYNCHRONOUS (dispatch-only) — it no longer blocks
// until the turn finishes, so tests that need to know a turn actually
// completed must wait on the transcript-event stream instead of on send()'s
// return value. Resolves once N 'turn-complete' events have been observed
// (attach-after-send is safe: JS won't yield to the async turn until the
// current synchronous call stack — including the send() call itself — empties).
function waitForTurnComplete(host: NativeSessionHost, n: number): Promise<void> {
  return new Promise((resolve) => {
    let count = 0;
    const onEvent = (e: any) => {
      if (e.type === 'turn-complete') {
        count += 1;
        if (count >= n) { host.off('transcript-event', onEvent); resolve(); }
      }
    };
    host.on('transcript-event', onEvent);
  });
}

// Resolve once `sessionId`'s turn is genuinely IN FLIGHT — the condition a LIVE
// steer needs (postSteer delivers to a session mid-turn and parks the steer
// otherwise). Waiting on the session's own first transcript event replaces a
// fixed `setTimeout(…, 20)`, which was a guess that the turn had started: on a
// loaded machine it had not, postSteer missed, the steer PARKED, and the
// assertions below then failed as though the live-delivery logic were broken
// (ROADMAP 2026-08-16, "a fixed 20ms delay stands in for a real completion
// signal"). Attaching after send() is safe for the same reason
// waitForTurnComplete documents: the async turn cannot run until the current
// synchronous stack empties.
function waitForTurnInFlight(host: NativeSessionHost, sessionId: string, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEvent = (e: any) => {
      // A child's events reach the host's listeners re-stamped under the
      // PARENT's session id, with `data.agentId` naming the child that spoke
      // (native-session-host.ts, createChild's transcript subscription) — so
      // matching on e.sessionId alone never fires for a child.
      if (e?.sessionId !== sessionId && e?.data?.agentId !== sessionId) return;
      clearTimeout(timer);
      host.off('transcript-event', onEvent);
      resolve();
    };
    const timer = setTimeout(() => {
      host.off('transcript-event', onEvent);
      // Named, not a bare timeout: if this ever fires the turn never started,
      // which is a different bug from the one the test is about.
      reject(new Error(`no transcript event from session ${sessionId} within ${timeoutMs}ms — its turn never started`));
    }, timeoutMs);
    host.on('transcript-event', onEvent);
  });
}

// A ModelFactory whose FIRST call throws (HarnessSession.send() catches this
// inside its try/await and emits session-error, never a rejection) and whose
// every later call succeeds via the plain `factory` stream — proves a
// factory-throw turn doesn't strand the M1 send queue.
function throwOnceFactory() {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1) throw new Error('doomed factory call');
    return factory();
  };
}

describe('NativeSessionHost', () => {
  let root: string; let host: NativeSessionHost;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-host-'));
    host = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null);
  });
  afterEach(async () => { await host.destroyAll(); rmHostRoot(root); });

  it('pendingAskEventsFor delegates to the broker for one session', () => {
    // Task 0 (ROADMAP #permissions): TRANSCRIPT_REPLAY needs a host-level
    // method to re-send open asks after a reload — this just proves the host
    // forwards to the broker rather than re-implementing the lookup.
    const emitted: any[] = [];
    host.on('hook-event', (e) => emitted.push(e));
    // Seed two pending asks straight through the broker — the public
    // askPermission delegate was deleted (ROADMAP 2026-08-12: zero production
    // callers; the shipped path is the askUser closure, which also threads
    // permissionMode). This test only proves pendingAskEventsFor forwards to
    // the broker, so seeding at the broker is the honest fixture.
    void (host as any).broker.ask({ sessionId: 's1', toolName: 'Bash', toolInput: { command: 'npm test' }, denyListed: false });
    void (host as any).broker.ask({ sessionId: 's2', toolName: 'Read', toolInput: {}, denyListed: false });
    const events = host.pendingAskEventsFor('s1');
    expect(events).toHaveLength(1);
    expect(events[0].sessionId).toBe('s1');
    expect(events[0].type).toBe('PermissionRequest');
    expect(events[0].payload._requestId).toBe(emitted[0].payload._requestId);
  });

  it('create → send → events forwarded AND persisted; getHistory replays them', async () => {
    const seen: any[] = [];
    host.on('transcript-event', (e) => seen.push(e));
    await host.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    host.send('s-1', 'hello');       // M1: dispatch-only — wait for the turn separately
    await waitForTurnComplete(host, 1);
    await host.drain('s-1');   // wait for the append chain to settle
    expect(seen.map((e) => e.type)).toContain('turn-complete');
    const history = host.getHistory('s-1');
    expect(history).not.toBeNull();
    expect(history!.map((e) => e.type)).toEqual(['user-message', 'assistant-text', 'turn-complete']);
    expect(history![1].data.text).toBe('Hi there');   // coalesced on disk
  });

  it('resume rebuilds a live session whose history includes the stored exchange', async () => {
    await host.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    host.send('s-1', 'hello');       // M1: dispatch-only — wait for the turn separately
    await waitForTurnComplete(host, 1);
    await host.drain('s-1');
    await host.destroyAll();

    const host2 = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null);
    const resumed = await host2.resume('s-1', root);
    expect(resumed).toBe(true);
    expect(host2.getHistory('s-1')!.length).toBe(3);
    host2.send('s-1', 'again');
    await waitForTurnComplete(host2, 1);
    await host2.drain('s-1');
    // Two full turns now on disk: 2 × (user-message, assistant-text, turn-complete).
    expect(host2.getHistory('s-1')!.length).toBe(6);
    await host2.destroyAll();
  });

  // Task 6: resume() takes an optional bindingOverride — the RESUME-TIME model
  // selector's pick, which must win over the persisted header binding. Ordering
  // matters: ipc-handlers.ts reads nativeHost.modelForSession() for the eager
  // loadModel() call the instant resume() returns, so the override has to be
  // applied INSIDE resume() (constructing the HarnessSession with it) rather
  // than via a post-hoc setBinding, which would race that read and load the
  // header's (possibly-absent) model instead.
  it('resume applies a binding override before anything reads the model', async () => {
    await host.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'ulid-A', modelId: 'model-A' } });
    await host.destroy('s-1');

    const host2 = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null);
    const resumed = await host2.resume('s-1', root, { providerId: 'local', modelId: 'model-B' });
    expect(resumed).toBe(true);
    expect(host2.modelForSession('s-1')).toBe('model-B');
    expect(host2.getBinding('s-1')).toEqual({ providerId: 'local', modelId: 'model-B' });
    await host2.destroyAll();
  });

  it('resume WITHOUT an override still uses the header binding (no local match ⇒ no substitution)', async () => {
    await host.create({ sessionId: 's-2', cwd: root, binding: { providerId: 'openrouter', modelId: 'header-model' } });
    await host.destroy('s-2');

    const host2 = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null);
    const resumed = await host2.resume('s-2', root);
    expect(resumed).toBe(true);
    expect(host2.modelForSession('s-2')).toBe('header-model');
    await host2.destroyAll();
  });

  it('list() surfaces sessions for the Resume Browser with provider tag', async () => {
    await host.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const rows = host.list();
    expect(rows[0]).toMatchObject({ sessionId: 's-1', provider: 'native' });
  });

  it('getHistory returns null for unknown/non-native sessions (replay falls through to CC)', () => {
    expect(host.getHistory('nope')).toBeNull();
  });

  // M1: send() is now synchronous and returns a NativeSendResult (not a
  // Promise<boolean>) — 'not-live' replaces the old bare `false`.
  it('send to an unknown session returns failed/not-live, does not throw', () => {
    expect(host.send('ghost', 'x')).toEqual({ status: 'failed', reason: 'not-live' });
  });

  // ── A message typed while the session is still STARTING (2026-09-06) ───────
  //
  // Destin made a session on a local model and typed straight away. The app told
  // him "This session is no longer running. Start or resume it to send messages."
  // Both halves were false — the session had never run, the engine was loading a
  // 29 GB model, and a minute later the same session answered him normally.
  // send() had ONE reason code for "not in the live map", covering both a session
  // that has ENDED and one that has not STARTED. These four pin the split and the
  // holding queue that makes the refusal unnecessary in the first place.

  it('a message typed while the session is still starting is HELD, not refused', async () => {
    // create() is async; this is the real window, entered before its first await
    // settles — exactly where Destin's message landed.
    const creating = host.create({ sessionId: 's-warmup', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const ack = host.send('s-warmup', 'hello from the starting gate');
    expect(ack.status, 'held, not refused').toBe('queued');
    const turns: string[] = [];
    host.on('transcript-event', (e) => { if (e.type === 'turn-complete') turns.push('t'); });
    await creating;
    await waitForTurnComplete(host, 1);
    await host.drain('s-warmup');
    // Delivered — and delivered ONCE. The settle window matters: a duplicate
    // sits in the send queue and only runs AFTER the first turn completes, so
    // reading the transcript the instant turn 1 lands cannot see it. Held open
    // until the queue has had every chance to produce a second turn.
    await new Promise((r) => setTimeout(r, 300));
    await host.drain('s-warmup');
    expect(turns.length, 'exactly one turn ran').toBe(1);
    const history = host.getHistory('s-warmup')!;
    const typed = history.filter((e) => e.type === 'user-message');
    expect(typed).toHaveLength(1);
    expect(typed[0].data.text).toBe('hello from the starting gate');
    expect(history.map((e) => e.type)).toEqual(['user-message', 'assistant-text', 'turn-complete']);
  });

  it('several messages typed during startup arrive in the order they were typed', async () => {
    const creating = host.create({ sessionId: 's-warmup2', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    expect(host.send('s-warmup2', 'first').status).toBe('queued');
    expect(host.send('s-warmup2', 'second').status).toBe('queued');
    await creating;
    await waitForTurnComplete(host, 2);
    await host.drain('s-warmup2');
    const typed = host.getHistory('s-warmup2')!.filter((e) => e.type === 'user-message').map((e) => e.data.text);
    expect(typed).toEqual(['first', 'second']);
  });

  it('a session that has ENDED still gets the ended message, not the starting one', async () => {
    // The whole point of the split: this must NOT become "starting".
    await host.create({ sessionId: 's-gone', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    await host.destroy('s-gone');
    expect(host.send('s-gone', 'x')).toEqual({ status: 'failed', reason: 'not-live' });
    // And an id nothing ever created is the same case.
    expect(host.send('never-existed', 'x')).toEqual({ status: 'failed', reason: 'not-live' });
  });

  it('startup refuses with its OWN reason once ten messages are already waiting', async () => {
    const creating = host.create({ sessionId: 's-warmup3', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    for (let i = 0; i < 10; i++) expect(host.send('s-warmup3', `m${i}`).status).toBe('queued');
    // The eleventh cannot be held — and it must say "starting", never
    // "no longer running", because the session is starting.
    expect(host.send('s-warmup3', 'm10')).toEqual({ status: 'failed', reason: 'starting' });
    await creating;
    await host.destroy('s-warmup3');
  });

  it('a message still waiting for the session to start can be taken back', async () => {
    const creating = host.create({ sessionId: 's-warmup4', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const ack = host.send('s-warmup4', 'oops, wrong thing') as { status: 'queued'; queueId: string };
    expect(host.removeQueued('s-warmup4', ack.queueId), 'Cancel reaches a held message').toBe(true);
    await creating;
    await host.drain('s-warmup4');
    expect(host.getHistory('s-warmup4')!.filter((e) => e.type === 'user-message')).toHaveLength(0);
    await host.destroy('s-warmup4');
  });

  it('a session that never comes up does not hold the message for ever', async () => {
    // A failed create must release what it was holding — otherwise a typed
    // message sits in memory for the life of the app, attached to nothing.
    const store = new SessionStore(new NativeHome(root));
    vi.spyOn(store, 'create').mockRejectedValue(new Error('disk is full'));
    const doomed = new NativeSessionHost(store, factory, NO_CONTEXT, async () => null, async () => null);
    const creating = doomed.create({ sessionId: 's-doomed', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    expect(doomed.send('s-doomed', 'held').status).toBe('queued');
    await expect(creating).rejects.toThrow();
    // Back to the honest answer for a session that is not coming.
    expect(doomed.send('s-doomed', 'again')).toEqual({ status: 'failed', reason: 'not-live' });
    await doomed.destroyAll();
  });

  // The old 'overlapping send() does not reject: second resolves false' pin is
  // superseded by the M1 send queue below ('overlapping send queues FIFO and
  // both turns complete in order') — an overlapping send is now FIFO'd, not
  // dropped, so that assertion no longer describes the contract.

  it('destroy() while a stream is mid-emit: no throw, coherent prefix persisted', async () => {
    const store = new SessionStore(new NativeHome(root));
    const midHost = new NativeSessionHost(store, delayedFactory, NO_CONTEXT, async () => null, async () => null);
    const gotDelta = new Promise<void>((res) => {
      midHost.on('transcript-event', (e) => { if (e.type === 'assistant-text') res(); });
    });
    await midHost.create({ sessionId: 's-mid', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    // M1: send() dispatches synchronously now — 'sent' just means the turn
    // started, so the "no throw on destroy mid-stream" story moves to destroy().
    expect(midHost.send('s-mid', 'hi')).toEqual({ status: 'sent' });
    await gotDelta;                          // stream is now mid-emit (delta out, no finish yet)
    await expect(midHost.destroy('s-mid')).resolves.toBeUndefined(); // stop the source, drain, flush — no throw
    // A coherent prefix is on disk — no torn/partial turn, no premature turn-complete.
    const events = store.readEvents('s-mid', root);
    expect(events.map((e) => e.type)).toEqual(['user-message', 'assistant-text']);
    await midHost.destroyAll();
  });

  // SINGLE-WRITER GUARD (2026-07-18, investigation Break 4). resume() used to
  // wire a fresh HarnessSession without touching an existing live one. wire()
  // overwrites this.live's entry, but the ORPHAN's transcript-event listener
  // closes over the OLD entry — so it kept appending to the same JSONL, giving
  // two writers unordered against each other (native-home.ts:5-7 says session
  // files are single-writer by design, which is why they carry no file lock).
  //
  // Asserts on APPEND CALLS, not on map state: the map entry is not what keeps
  // the orphan alive, so a map-shaped assertion would pass on the broken code.
  it('resume() on an id that is still live destroys the orphan — no second writer', async () => {
    const store = new SessionStore(new NativeHome(root));
    const appends: string[] = [];
    const realAppend = store.append.bind(store);
    vi.spyOn(store, 'append').mockImplementation(async (cwd, event) => {
      appends.push(event.type);
      return realAppend(cwd, event);
    });
    // delayedFactory trickles chunks, so the first turn is genuinely mid-stream
    // when resume lands — the exact window where an orphan does its damage.
    const orphanHost = new NativeSessionHost(store, delayedFactory, NO_CONTEXT, async () => null, async () => null);
    const gotDelta = new Promise<void>((res) => {
      orphanHost.on('transcript-event', (e) => { if (e.type === 'assistant-text') res(); });
    });
    await orphanHost.create({ sessionId: 's-orphan', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    // M1: send() dispatches synchronously — 'sent' means the turn started, not
    // that resume() below is racing a still-pending promise.
    expect(orphanHost.send('s-orphan', 'hi')).toEqual({ status: 'sent' }); // resume mid-stream
    await gotDelta;

    // Resume the SAME id while it is live. This is what a takeover-orphaned
    // session did on the next open. resume() awaits destroy() of the orphan
    // underneath it, so the interrupted turn settles cleanly with no throw.
    const resumed = await orphanHost.resume('s-orphan', root);
    expect(resumed).toBe(true);

    // Everything the old session could still have written must already be done:
    // resume() awaits destroy(), which aborts the stream, drains the append chain
    // and flushes the open part. Give the old stream's remaining chunk delays
    // (15ms each) generous room to fire if the abort did NOT take.
    const afterResume = appends.length;
    await new Promise((r) => setTimeout(r, 120));
    expect(appends.length).toBe(afterResume); // the orphan wrote nothing more

    // And the file is a coherent single-writer transcript, not an interleave.
    const events = store.readEvents('s-orphan', root);
    expect(events.map((e) => e.type)).toEqual(['user-message', 'assistant-text']);
    await orphanHost.destroyAll();
  });

  it('a failed append does not wedge the chain — later events still persist', async () => {
    const store = new SessionStore(new NativeHome(root));
    const realAppend = store.append.bind(store);
    let threw = false;
    // Reject exactly once, on the assistant-text append; everything after must
    // still reach disk.
    vi.spyOn(store, 'append').mockImplementation(async (cwd, event) => {
      if (!threw && event.type === 'assistant-text') { threw = true; throw new Error('disk hiccup'); }
      return realAppend(cwd, event);
    });
    const failHost = new NativeSessionHost(store, factory, NO_CONTEXT, async () => null, async () => null);
    await failHost.create({ sessionId: 's-f', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    failHost.send('s-f', 'hello');       // M1: dispatch-only — wait for the turn separately
    await waitForTurnComplete(failHost, 1);
    await failHost.drain('s-f');
    expect(threw).toBe(true);
    const types = failHost.getHistory('s-f')!.map((e) => e.type);
    expect(types).toContain('user-message');   // persisted before the failure
    expect(types).toContain('turn-complete');  // chain kept going after the failure
    await failHost.destroyAll();
  });

  // ---- model ref-count (#1: unload a model when no session uses it) ----
  describe('model ref-count', () => {
    it('fires onModelReleased ONLY when the last session for a model is destroyed', async () => {
      const released: string[] = [];
      host.setModelReleasedHandler((id) => released.push(id));
      await host.create({ sessionId: 'a', cwd: root, binding: { providerId: 'local', modelId: 'M1' } });
      await host.create({ sessionId: 'b', cwd: root, binding: { providerId: 'local', modelId: 'M1' } });
      expect(host.sessionsForModel('M1').sort()).toEqual(['a', 'b']);

      await host.destroy('a');            // one of two → M1 still in use
      expect(released).toEqual([]);
      expect(host.sessionsForModel('M1')).toEqual(['b']);

      await host.destroy('b');            // last one → release M1
      expect(released).toEqual(['M1']);
      expect(host.sessionsForModel('M1')).toEqual([]);
    });

    it('setBinding swaps the ref-count: releases the old model, retains the new', async () => {
      const released: string[] = [];
      host.setModelReleasedHandler((id) => released.push(id));
      await host.create({ sessionId: 's', cwd: root, binding: { providerId: 'local', modelId: 'OLD' } });
      expect(host.modelForSession('s')).toBe('OLD');

      await host.setBinding('s', { providerId: 'local', modelId: 'NEW' });
      expect(released).toEqual(['OLD']);           // OLD had no other session → released
      expect(host.modelForSession('s')).toBe('NEW');
      expect(host.sessionsForModel('NEW')).toEqual(['s']);
    });

    it('modelForSession is null for an unknown session', () => {
      expect(host.modelForSession('nope')).toBeNull();
    });
  });

  // ---- Task 4: the host tears down the pooled MCP connections at the SAME
  // app-quit path as its own sessions (destroyAll() is confirmed the real
  // teardown method — invoked by ipc-handlers.ts cleanup() from main.ts's
  // window-all-closed handler). Without this, an MCP server subprocess would
  // outlive the app.
  describe('MCP teardown (Task 4)', () => {
    it('destroyAll() also tears down the pooled MCP connections', async () => {
      const mcpDestroyAll = vi.fn(async () => {});
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined,
        { destroyAll: mcpDestroyAll },
      );
      await h.destroyAll();
      expect(mcpDestroyAll).toHaveBeenCalledTimes(1);
    });

    it('destroyAll() works fine with no mcpManager wired (pre-Task-6 wiring)', async () => {
      const h = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null);
      await expect(h.destroyAll()).resolves.toBeUndefined();
    });
  });

  // ---- Task 6: the host is the ONE production caller of McpManager's
  // acquire()/release() — create()/resume() acquire this session's servers
  // and thread them into the HarnessSession; destroy() releases the hold. ----
  describe('MCP session wiring (Task 6)', () => {
    const fakeServer = (id: string) => ({
      id, label: id, tools: [], call: async () => ({ text: 'ok', isError: false }),
    });

    // A lease whose release() is a spy — the manager's release is no longer a
    // method on the manager, so the host can only give a hold back through the
    // object acquire() returned. See McpLease in mcp-manager.ts.
    const fakeLease = (servers: any[], release = vi.fn(async () => {})) => ({ servers, release });

    it('create() acquires this session\'s MCP servers and threads them into the session', async () => {
      const wanted = [fakeServer('srv0')];
      const acquire = vi.fn(async () => fakeLease(wanted));
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined,
        { destroyAll: async () => {}, acquire },
      );
      await h.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      expect(acquire).toHaveBeenCalledWith('s-1');
      const session = (h as any).live.get('s-1').session;
      expect(session.opts.mcpServers).toBe(wanted);
    });

    it('resume() acquires MCP servers for the resumed session', async () => {
      const wanted = [fakeServer('srv1')];
      const acquire = vi.fn(async () => fakeLease(wanted));
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined,
        { destroyAll: async () => {}, acquire },
      );
      await h.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      h.send('s-1', 'hello');
      await waitForTurnComplete(h, 1);
      await h.drain('s-1');
      await h.destroyAll();
      acquire.mockClear();

      const h2 = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined,
        { destroyAll: async () => {}, acquire },
      );
      const resumed = await h2.resume('s-1', root);
      expect(resumed).toBe(true);
      expect(acquire).toHaveBeenCalledWith('s-1');
      const session = (h2 as any).live.get('s-1').session;
      expect(session.opts.mcpServers).toBe(wanted);
      await h2.destroyAll();
    });

    it('destroy() releases this session\'s hold on MCP servers', async () => {
      const release = vi.fn(async () => {});
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined,
        { destroyAll: async () => {}, acquire: async () => fakeLease([], release) },
      );
      await h.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      await h.destroy('s-1');
      expect(release).toHaveBeenCalledTimes(1);
    });

    // Destroy → resume → destroy across two generations of ONE session id:
    // each destroy releases exactly one lease, the right one, exactly once.
    //
    // WHAT THIS DOES NOT PROVE: it does not discriminate a per-entry lease from
    // a sessionId-keyed "most recent lease" map — that mutation was run and
    // this test still passed, because sequentially the most-recent lease IS the
    // correct one. The generation-discrimination that IS load-bearing lives in
    // McpManager and is mutation-tested there (mcp-manager.test.ts, "the
    // outgoing generation of a resumed session..."). What this pins is the
    // plainer contract: a resume acquires a FRESH lease rather than reusing the
    // old one, and no generation's lease is ever released twice or skipped.
    it('each generation of a resumed session releases its own lease exactly once', async () => {
      const releaseA = vi.fn(async () => {});
      const releaseB = vi.fn(async () => {});
      const leases = [fakeLease([fakeServer('srv')], releaseA), fakeLease([fakeServer('srv')], releaseB)];
      let n = 0;
      const acquire = vi.fn(async () => leases[n++]);
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined,
        { destroyAll: async () => {}, acquire },
      );
      await h.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      h.send('s-1', 'hello');
      await waitForTurnComplete(h, 1);
      await h.drain('s-1');
      // Generation 1 goes away; generation 2 resumes under the SAME id.
      await h.destroy('s-1');
      expect(releaseA).toHaveBeenCalledTimes(1);
      expect(releaseB).not.toHaveBeenCalled();

      await h.resume('s-1', root);
      // Tearing generation 2 down must release ITS lease, and must not touch
      // generation 1's again.
      await h.destroy('s-1');
      expect(releaseB).toHaveBeenCalledTimes(1);
      expect(releaseA).toHaveBeenCalledTimes(1);
    });

    it('a registry-wide acquire failure does not block session creation — the session just opens with no MCP servers', async () => {
      const acquire = vi.fn(async () => { throw new Error('registry file corrupt'); });
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined,
        { destroyAll: async () => {}, acquire },
      );
      await expect(h.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } })).resolves.toBeUndefined();
      const session = (h as any).live.get('s-1').session;
      expect(session.opts.mcpServers).toBeUndefined();
    });
  });

  // ---- Task 6 review fix 2: the per-parent slot/writer bookkeeping had zero
  // host-level tests before this — everything exercising it went through
  // tools/task.ts's fakes (task-tool.test.ts), which never touch the REAL host
  // methods. Drives reserveSpecialist/releaseReservation directly, keyed by an
  // arbitrary parent id (no live session needed — these are pure bookkeeping
  // over host-owned Maps, enforced independently of whether a parent session
  // actually exists).
  //
  // Task 1 (plan 1b): tryReserveSpecialistSlot/releaseSpecialistSlot are gone
  // — reserveSpecialist folds the slot check AND the writer-busy check into
  // ONE synchronous call, so a throw or an await between "checked" and "set"
  // can no longer let two parallel Task calls both win the same reservation.
  // ----
  describe('specialist slot + writer-lock bookkeeping (Task 6)', () => {
    it('ceiling: HOSTED_MAX_CONCURRENT_SPECIALISTS reserves succeed for one parent, the next is refused', () => {
      for (let i = 0; i < HOSTED_MAX_CONCURRENT_SPECIALISTS; i++) {
        expect(host.reserveSpecialist('A', { writer: false }).ok).toBe(true);
      }
      // Task 13: no live session under 'A' → maxSpecialistsFor's defensive
      // fallback (HOSTED_MAX_CONCURRENT_SPECIALISTS), carried on the refusal
      // as `max` so tools/task.ts can render the REAL resolved number.
      expect(host.reserveSpecialist('A', { writer: false })).toEqual({ ok: false, reason: 'at-capacity', max: HOSTED_MAX_CONCURRENT_SPECIALISTS });
    });

    it('per-parent isolation: an UNRELATED parent is unaffected by A being at capacity', () => {
      for (let i = 0; i < HOSTED_MAX_CONCURRENT_SPECIALISTS; i++) host.reserveSpecialist('A', { writer: false });
      expect(host.reserveSpecialist('A', { writer: false }).ok).toBe(false);   // A is full
      expect(host.reserveSpecialist('B', { writer: false }).ok).toBe(true);    // B's own ceiling is untouched
    });

    it('release: freeing one slot lets A reserve again; releasing to zero drops the map entry', () => {
      const tokens: any[] = [];
      for (let i = 0; i < HOSTED_MAX_CONCURRENT_SPECIALISTS; i++) {
        const r = host.reserveSpecialist('A', { writer: false });
        if (r.ok) tokens.push(r.token);
      }
      expect(host.reserveSpecialist('A', { writer: false }).ok).toBe(false);
      host.releaseReservation(tokens.pop());
      const refilled = host.reserveSpecialist('A', { writer: false });    // one freed → one more fits
      expect(refilled.ok).toBe(true);
      if (refilled.ok) tokens.push(refilled.token);
      // Release every reservation currently held (back at the ceiling after the
      // line above) down to zero — the map entry must not linger at 0 forever
      // (releaseReservation's own header: "so a parent that never delegates
      // again doesn't linger in the map").
      for (const t of tokens) host.releaseReservation(t);
      expect((host as any).specialistSlots.has('A')).toBe(false);
    });

    it('releasing a token for a parent with no live reservation is a harmless no-op', () => {
      expect(() => host.releaseReservation({ parentId: 'never-reserved', writer: false })).not.toThrow();
      expect((host as any).specialistSlots.has('never-reserved')).toBe(false);
    });

    it('writer lock: busy only for the parent that holds it, never an unrelated parent; clearing it frees the parent up', () => {
      // WHY read the map directly rather than through a query method:
      // isSpecialistWriterBusy was removed as dead production code (nothing
      // outside tests ever called it — reserveSpecialist inlines the same
      // check). No public setter exists either — spawnSpecialist/
      // bindReservation is the only production writer, and it always tears
      // the lock back down before ever returning. Reaching the Map directly
      // is how a sibling Task call's in-flight writer lock — read while it is
      // still IN FLIGHT — actually gets pinned at the host level rather than
      // only through task-tool.test.ts's fakes.
      expect((host as any).activeWriterChild.has('A')).toBe(false);
      (host as any).activeWriterChild.set('A', 'child-x');
      expect((host as any).activeWriterChild.has('A')).toBe(true);
      expect((host as any).activeWriterChild.has('B')).toBe(false);     // per-parent isolation
      (host as any).activeWriterChild.delete('A');
      expect((host as any).activeWriterChild.has('A')).toBe(false);
    });

    // ---- Task 1 (plan 1b): the actual fix. 1a's writer-lock gate was a
    // check-then-set split across an await (tools/task.ts checked
    // isWriterBusy(), native-session-host.ts's spawnSpecialist set the lock
    // AFTER await createChild(...)) — safe only because the driver ran one
    // tool at a time. Two Task calls issued in the SAME parallel tool-call
    // step interleave at that await, and both could see "not busy" before
    // either set the lock. reserveSpecialist closes that window by doing the
    // check AND the set in one synchronous call. ----
    it('reserves slot and writer atomically — two synchronous writer reservations, second refused', () => {
      const a = host.reserveSpecialist('parent-1', { writer: true });
      const b = host.reserveSpecialist('parent-1', { writer: true });
      expect(a.ok).toBe(true);
      expect(b).toEqual({ ok: false, reason: 'writer-busy' });
    });

    it('a released writer reservation frees the writer lock even when no child was ever bound', () => {
      const a = host.reserveSpecialist('parent-1', { writer: true });
      if (!a.ok) throw new Error('unexpected');
      host.releaseReservation(a.token);
      expect(host.reserveSpecialist('parent-1', { writer: true }).ok).toBe(true);
    });

    it('readers do not consume the writer lock and cap at the profile max', () => {
      for (let i = 0; i < 4; i++) expect(host.reserveSpecialist('parent-1', { writer: false }).ok).toBe(true);
      expect(host.reserveSpecialist('parent-1', { writer: false })).toEqual({ ok: false, reason: 'at-capacity', max: HOSTED_MAX_CONCURRENT_SPECIALISTS });
    });
  });

  // ---- Task 13: maxSpecialistsFor now resolves the PARENT'S OWN live
  // CapabilityProfile snapshot (capability-profile.ts's maxConcurrentSpecialists)
  // instead of the flat HOSTED_MAX_CONCURRENT_SPECIALISTS constant — a local
  // session's real ceiling can be smaller than hosted's. The fallback constant
  // above still applies whenever no live session backs the parent id (the
  // 'never created' cases in the describe block above). ----
  describe('specialist concurrency cap follows the profile (Task 13)', () => {
    const providerTypeFor = async (b: any) => (b.providerId === 'local' ? 'local-engine' : 'openrouter');
    // Fix pass 2: contextLengthFor collapsed into contextAndSlotsFor — this
    // fixture doesn't care about slots (totalSlots: null keeps the Layer 3
    // fallback/unknown-model floor of 1 in play for the first two tests).
    const contextAndSlotsFor = async (b: any) => ({ contextLength: b.providerId === 'local' ? 8192 : 200_000, totalSlots: null });

    it('a local-engine parent (unknown model → Layer 3 fallback) caps reservations at 1, not the hosted constant', async () => {
      const h = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, contextAndSlotsFor as any, providerTypeFor as any, async () => null);
      await h.create({ sessionId: 'local-parent', cwd: root, binding: { providerId: 'local', modelId: 'mystery-3b' } });
      expect(h.reserveSpecialist('local-parent', { writer: false }).ok).toBe(true);
      expect(h.reserveSpecialist('local-parent', { writer: false })).toEqual({ ok: false, reason: 'at-capacity', max: 1 });
      await h.destroyAll();
    });

    it('a cloud/hosted parent is unaffected — still caps at HOSTED_MAX_CONCURRENT_SPECIALISTS', async () => {
      const h = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, contextAndSlotsFor as any, providerTypeFor as any, async () => null);
      await h.create({ sessionId: 'cloud-parent', cwd: root, binding: { providerId: 'openrouter', modelId: 'gpt-4o' } });
      for (let i = 0; i < HOSTED_MAX_CONCURRENT_SPECIALISTS; i++) {
        expect(h.reserveSpecialist('cloud-parent', { writer: false }).ok).toBe(true);
      }
      expect(h.reserveSpecialist('cloud-parent', { writer: false })).toEqual({ ok: false, reason: 'at-capacity', max: HOSTED_MAX_CONCURRENT_SPECIALISTS });
      await h.destroyAll();
    });

    // Fix pass (gap the review found): DiscoveredModel.totalSlots was built and
    // tested at the capability-profile.ts layer, but nothing threaded a REAL
    // engine reading into it — every local session silently fell back to the
    // conservative floor of 1, a regression from the pre-Task-13 flat cap of 4.
    // This is the closing link: a contextAndSlotsFor closure that answers a
    // live 2-slot reading for a KNOWN local model (qwen3.6-35b-moe matches
    // KNOWN_MODELS, 'full' tier, same modelId capability-profile.test.ts
    // already proves clamps to a live reading) must make the HOST actually
    // enforce 2, not 1 and not the hosted 4. Fix pass 2 folds the old separate
    // slotCountFor closure into this same one — see the constructor param's
    // comment for why that removes the shared-state race this test's sibling
    // (below, "no cross-talk") now covers directly.
    it('a KNOWN local model with a live 2-slot engine reading caps reservations at 2', async () => {
      const localTwoSlots = async (b: any) => ({ contextLength: b.providerId === 'local' ? 8192 : 200_000, totalSlots: b.providerId === 'local' ? 2 : null });
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, localTwoSlots as any, providerTypeFor as any, async () => null,
      );
      await h.create({ sessionId: 'local-parent-2', cwd: root, binding: { providerId: 'local', modelId: 'qwen3.6-35b-moe-q4' } });
      expect(h.reserveSpecialist('local-parent-2', { writer: false }).ok).toBe(true);
      expect(h.reserveSpecialist('local-parent-2', { writer: false }).ok).toBe(true);
      expect(h.reserveSpecialist('local-parent-2', { writer: false })).toEqual({ ok: false, reason: 'at-capacity', max: 2 });
      await h.destroyAll();
    });

    // Fix pass 2 concurrency regression: the OLD design shared one /props
    // reading between two closures (contextLengthFor, slotCountFor) through a
    // variable scoped at the ipc-handlers.ts wiring site — correct only if
    // every resolveContextAndProfile call awaited both closures back-to-back
    // with nothing else able to run in between. Two local-engine sessions
    // starting while the OTHER is still mid-resolution is exactly the
    // interleaving that variable could not survive. The new design has no
    // shared state to interleave: this drives two overlapping create() calls
    // for two DIFFERENT local bindings with two DIFFERENT slot counts and
    // proves each session's resolved cap is its own — never the other's,
    // never zeroed by the other landing in between.
    it('two overlapping local-engine session starts each resolve their OWN slot count — no cross-talk', async () => {
      let releaseA: () => void;
      const stallA = new Promise<void>((res) => { releaseA = res; });
      // Both ids must match a KNOWN_MODELS entry — an unknown local model hits
      // the Layer 3 fallback, which floors to 1 UNCONDITIONALLY regardless of
      // totalSlots (capability-profile.ts's localFallback), which would mask
      // the exact cross-talk this test exists to catch. 'model-a' hits the
      // Qwen 3.6 MoE entry, 'model-b' the Qwen 3.5 9B entry — different
      // families, so a mix-up between them is unambiguous.
      //
      // model-a's read stalls mid-flight (simulating its /props round trip
      // still being in the air) until the test explicitly releases it —
      // model-b's read resolves immediately, landing WHILE model-a is still
      // pending. The old shared-variable design could not tell these apart.
      const contextAndSlotsFor = async (b: any) => {
        if (b.modelId === 'model-a-qwen3.6-35b-moe') { await stallA; return { contextLength: 8192, totalSlots: 2 }; }
        return { contextLength: 8192, totalSlots: 4 };
      };
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, contextAndSlotsFor as any, providerTypeFor as any, async () => null,
      );

      const createA = h.create({ sessionId: 'race-a', cwd: root, binding: { providerId: 'local', modelId: 'model-a-qwen3.6-35b-moe' } });
      // Started WHILE createA is still stalled inside its own contextAndSlotsFor
      // await — the exact overlap the review flagged.
      await h.create({ sessionId: 'race-b', cwd: root, binding: { providerId: 'local', modelId: 'model-b-qwen3.5-9b' } });
      releaseA!();
      await createA;

      // race-a's own reading (2 slots) — NOT 4 (race-b's), NOT 1 (floored by
      // a stale/null read).
      expect(h.reserveSpecialist('race-a', { writer: false }).ok).toBe(true);
      expect(h.reserveSpecialist('race-a', { writer: false }).ok).toBe(true);
      expect(h.reserveSpecialist('race-a', { writer: false })).toEqual({ ok: false, reason: 'at-capacity', max: 2 });

      // race-b's own reading (4 slots) — unaffected by race-a's later resolve.
      for (let i = 0; i < 4; i++) expect(h.reserveSpecialist('race-b', { writer: false }).ok).toBe(true);
      expect(h.reserveSpecialist('race-b', { writer: false })).toEqual({ ok: false, reason: 'at-capacity', max: 4 });

      await h.destroyAll();
    });
  });

  // ---- Task 5: the host resolves + threads a CapabilityProfile per binding ----
  describe('capability profile threading', () => {
    // Binding-aware fakes: a 'local' provider is a small local engine; anything
    // else is a cloud provider. Reach into the live session's resolved profile.
    const providerTypeFor = async (b: any) => (b.providerId === 'local' ? 'local-engine' : 'openrouter');
    const contextAndSlotsFor = async (b: any) => ({ contextLength: b.providerId === 'local' ? 8192 : 200_000, totalSlots: null });
    const profileOf = (h: NativeSessionHost, id: string) => ((h as any).live.get(id).session as any).profile;

    it('a small local-engine binding yields a simplified profile; a swap to cloud re-resolves to full', async () => {
      const h = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, contextAndSlotsFor as any, providerTypeFor as any, async () => null);
      await h.create({ sessionId: 's', cwd: root, binding: { providerId: 'local', modelId: 'mystery-3b' } });
      expect(profileOf(h, 's').maxToolPresentation).toBe('simplified');
      expect(profileOf(h, 's').promptVariant).toBe('local-small');
      expect(profileOf(h, 's').doomLoopThreshold).toBe(2);

      // Swap to a cloud model — the re-resolved profile must flip to full posture.
      await h.setBinding('s', { providerId: 'openrouter', modelId: 'gpt-4o' });
      expect(profileOf(h, 's').maxToolPresentation).toBe('full');
      expect(profileOf(h, 's').doomLoopThreshold).toBe(3);
      await h.destroyAll();
    });

    // Task 6c: the visionSupportFor closure's discovered value must actually
    // reach the resolved profile — this is the step that turns the catalog
    // plumbing (CatalogModel.supportsVision, DiscoveredModel.supportsVision,
    // visionFor()'s precedence) from dead fields into the real fix. A cloud
    // OpenRouter binding has no VISION_PROVIDERS default (openrouter is a
    // transport), so `true` from the closure is the ONLY way this profile
    // could come out true — pinning that a bare provider-default read would
    // fail this exact assertion.
    it('a discovered supportsVision:true from visionSupportFor reaches the resolved profile', async () => {
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, contextAndSlotsFor as any, providerTypeFor as any,
        async () => true,
      );
      await h.create({ sessionId: 'v', cwd: root, binding: { providerId: 'openrouter', modelId: 'vision-model' } });
      expect(profileOf(h, 'v').supportsVision).toBe(true);
      await h.destroyAll();
    });

    // T18 / design §E5 — the same wiring, now for a LOCAL model. This is the
    // whole point of the task: a local model that ships a vision projector must
    // reach a session with supportsVision: true, exactly as an OpenRouter
    // vision model does. local-engine is deliberately NOT in VISION_PROVIDERS
    // (it is a transport — the same engine serves vision and text-only GGUFs),
    // and 'mystery-3b' matches no KNOWN_MODELS entry, so the closure's `true`
    // is the ONLY thing in the system that can make this assertion pass.
    it('a discovered supportsVision:true reaches the profile of a LOCAL-ENGINE binding too (T18)', async () => {
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, contextAndSlotsFor as any, providerTypeFor as any,
        async () => true,
      );
      await h.create({ sessionId: 'lv', cwd: root, binding: { providerId: 'local', modelId: 'mystery-3b' } });
      expect(profileOf(h, 'lv').supportsVision).toBe(true);
      await h.destroyAll();
    });

    // And the text-only half: a local model whose router row said `["text"]`
    // resolves to a hard false, so the harness tells it the picture cannot be
    // delivered rather than sending bytes the model cannot read.
    it('a discovered supportsVision:false keeps a LOCAL-ENGINE profile text-only (T18)', async () => {
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, contextAndSlotsFor as any, providerTypeFor as any,
        async () => false,
      );
      await h.create({ sessionId: 'lt', cwd: root, binding: { providerId: 'local', modelId: 'mystery-3b' } });
      expect(profileOf(h, 'lt').supportsVision).toBe(false);
      await h.destroyAll();
    });

    // The other half of the same wiring: a closure that can't answer (null —
    // "no source could answer", e.g. an OpenRouter cache miss or a non-OpenRouter
    // provider) must leave the profile EXACTLY as it resolved before this task —
    // openrouter has no VISION_PROVIDERS default, so this pins supportsVision: false.
    it('visionSupportFor returning null leaves the profile exactly as it was before this task', async () => {
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, contextAndSlotsFor as any, providerTypeFor as any,
        async () => null,
      );
      await h.create({ sessionId: 'v2', cwd: root, binding: { providerId: 'openrouter', modelId: 'unknown-model' } });
      expect(profileOf(h, 'v2').supportsVision).toBe(false);
      await h.destroyAll();
    });

    // FIX-3 (whole-branch review): the registry context ceiling is a LOCAL concern.
    // matchKnownModel keys only on the model-id regex, so a HOSTED model whose id
    // matches a local family (OpenRouter `qwen/qwen3.5-9b` → the local Qwen 3.5 9B
    // entry, ceiling 262144) must NOT be clamped — its real cloud window (1M here)
    // passes through untouched. The identical id on a local-engine binding IS clamped.
    const contextOf = (h: NativeSessionHost, id: string) => ((h as any).live.get(id).session as any).opts.contextLength;

    it('a NON-local binding matching a registry family is NOT clamped to the registry ceiling', async () => {
      // Same model id, same raw 1M window; only the provider TYPE differs.
      const bigWindow = async () => ({ contextLength: 1_000_000, totalSlots: null });
      const typeFor = async (b: any) => (b.providerId === 'local' ? 'local-engine' : 'openrouter');
      const h = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, bigWindow as any, typeFor as any, async () => null);

      // Hosted (OpenRouter): real 1M window survives — no local registry clamp.
      await h.create({ sessionId: 'cloud', cwd: root, binding: { providerId: 'openrouter', modelId: 'qwen/qwen3.5-9b' } });
      expect(contextOf(h, 'cloud')).toBe(1_000_000);

      // Local-engine, same id: clamped down to the registry's trained ceiling.
      await h.create({ sessionId: 'local', cwd: root, binding: { providerId: 'local', modelId: 'qwen/qwen3.5-9b' } });
      expect(contextOf(h, 'local')).toBe(262144);
      await h.destroyAll();
    });
  });

  // ---- Task 12: per-session permission mode + remembered rules ----
  describe('permission mode + remembered rules', () => {
    // A host wired with a REAL PermissionStore (over the temp home) + an injected
    // app version, driving the Write-then-stop turn.
    const permHost = () => new NativeSessionHost(
      new SessionStore(new NativeHome(root)), writeFactory, NO_CONTEXT, async () => null, async () => null, undefined,
      new PermissionStore(new NativeHome(root)), '9.9.9',
    );

    it('setPermissionMode returns the applied mode; rejects unknown modes loudly', () => {
      expect(host.setPermissionMode('s', 'auto-edit')).toBe('auto-edit');
      expect(host.setPermissionMode('s', 'full-auto')).toBe('full-auto');
      // An unknown mode string is a renderer/wiring bug — throw, don't store garbage.
      expect(() => host.setPermissionMode('s', 'bogus' as any)).toThrow(/Unknown native permission mode/);
    });

    it('destroy resets the per-session mode: a resumed same-id session is back to ask', async () => {
      const p = permHost();
      await p.create({ sessionId: 's', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      p.setPermissionMode('s', 'full-auto');
      p.send('s', 'seed a turn so there is a stored header to resume');  // full-auto → no ask
      await waitForTurnComplete(p, 1);
      await p.drain('s');
      await p.destroy('s');   // must drop the mode entry, not leak it

      // Resume the SAME id: mode must be back to the default 'ask', so the Write
      // call raises a permission ask (it would NOT under a stale full-auto).
      const p2 = permHost();
      const ask = firstAsk(p2);   // resolves with the ask's _requestId
      const resumed = await p2.resume('s', root);
      expect(resumed).toBe(true);
      const seen: any[] = []; p2.on('transcript-event', (e) => seen.push(e));
      const turnDone = waitForTurnComplete(p2, 1);
      p2.send('s', 'write a file');
      const requestId = await ask;   // resolves ONLY if the resumed session is back to 'ask'
      expect(seen.map((e) => e.type)).not.toContain('turn-complete');  // paused on the ask
      p2.respondPermission(requestId, { decision: { behavior: 'deny' } });
      await turnDone;
      await p.destroyAll();
      await p2.destroyAll();
    });

    it('full-auto auto-allows a gated tool (decide reflects the mode — no ask fires)', async () => {
      const p = permHost();
      const asks: any[] = []; p.on('hook-event', (e) => { if (e.type === 'PermissionRequest') asks.push(e); });
      const seen: any[] = []; p.on('transcript-event', (e) => seen.push(e));
      await p.create({ sessionId: 's', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      expect(p.setPermissionMode('s', 'full-auto')).toBe('full-auto');
      p.send('s', 'write a file');   // no ask to wait on
      await waitForTurnComplete(p, 1);
      expect(asks).toHaveLength(0);                                  // full-auto → no permission ask
      expect(seen.map((e) => e.type)).toContain('turn-complete');
      await p.destroyAll();
    });

    it('a mode flip does NOT disturb a pending ask; it resolves by its own respond()', async () => {
      const p = permHost();
      const seen: any[] = []; p.on('transcript-event', (e) => seen.push(e));
      await p.create({ sessionId: 's', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      // Default mode 'ask' → the Write call raises an ask and the turn pauses.
      // Don't await send() — it won't resolve until we respond.
      const ask = firstAsk(p);
      const turnDone = waitForTurnComplete(p, 1);
      p.send('s', 'write a file');
      const requestId = await ask;
      expect(seen.map((e) => e.type)).not.toContain('turn-complete');   // paused on the ask
      // Flip the mode mid-ask. The pending ask must be UNTOUCHED (spec pending-ask
      // ruling) — decide() only re-reads the mode on the NEXT tool.
      p.setPermissionMode('s', 'full-auto');
      await new Promise((r) => setTimeout(r, 20));
      expect(seen.map((e) => e.type)).not.toContain('turn-complete');   // still pending after the flip
      // The ORIGINAL ask resolves by its own respond(), not by the mode flip.
      expect(p.respondPermission(requestId, { decision: { behavior: 'allow' } })).toBe(true);
      await turnDone;
      expect(seen.map((e) => e.type)).toContain('turn-complete');
      await p.destroyAll();
    });

    it('stamps the CURRENT permission mode on each ask — a full-auto deny-listed ask carries full-auto', async () => {
      // A model that calls deny-listed Bash: the ONLY ask full-auto still
      // raises, and exactly the renderer's safety-stop condition
      // (permissionMode === 'full-auto' && denyListed). Mode is flipped AFTER
      // create(), so a wiring-time snapshot would report 'ask' — this pins the
      // read-at-ask-time behavior.
      const bashFactory = async () => scriptedModel([
        stream(toolCallChunk('c1', 'Bash', { command: 'git push origin master' }), finishChunk('tool-calls')),
        stream(...textChunks('t', 'done'), finishChunk('stop')),
      ]) as any;
      const p = new NativeSessionHost(
        // 3rd arg must be NO_CONTEXT (an object-returning stub), not a bare
        // `async () => null` — the constructor's 3rd param answers BOTH
        // context length and slot count in one closure (Task 13), so a plain
        // null return fails the destructure in resolveContextAndProfile.
        new SessionStore(new NativeHome(root)), bashFactory, NO_CONTEXT, async () => null, async () => null, undefined,
        new PermissionStore(new NativeHome(root)), '9.9.9',
      );
      const asks: any[] = [];
      p.on('hook-event', (e) => { if (e.type === 'PermissionRequest') asks.push(e); });
      await p.create({ sessionId: 's', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      p.setPermissionMode('s', 'full-auto');
      const ask = firstAsk(p);
      const turnDone = waitForTurnComplete(p, 1);
      p.send('s', 'push it');
      const requestId = await ask;
      expect(asks[0].payload.permissionMode).toBe('full-auto');
      expect(asks[0].payload.denyListed).toBe(true);
      p.respondPermission(requestId, { decision: { behavior: 'deny' } });   // finish the turn, run nothing
      await turnDone;
      await p.destroyAll();
    });

    it('Always allow persists a remembered rule via PermissionStore (host owns cwd scoping)', async () => {
      const store = new PermissionStore(new NativeHome(root));
      const p = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), writeFactory, NO_CONTEXT, async () => null, async () => null, undefined,
        store, '9.9.9',
      );
      await p.create({ sessionId: 's', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const ask = firstAsk(p);
      const turnDone = waitForTurnComplete(p, 1);
      p.send('s', 'write a file');
      const requestId = await ask;
      // "Always allow": non-empty updatedPermissions signals the remember.
      p.respondPermission(requestId, { decision: { behavior: 'allow' }, updatedPermissions: [{ tool: 'Write' }] });
      await turnDone;
      // remember() is fire-and-forget off the turn (mutateJson under a file lock);
      // poll until the persisted rule appears.
      let rules: any[] = [];
      for (let i = 0; i < POLL_TRIES; i++) {
        rules = await store.rulesFor(root);
        if (rules.some((r) => r.tool === 'Write' && r.action === 'allow')) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(rules.some((r) => r.tool === 'Write' && r.action === 'allow')).toBe(true);
      await p.destroyAll();
    });

    it('Always-allow sticks in-session even when the disk persist never resolves (in-memory union)', async () => {
      // A store whose remember() NEVER resolves (persist hang/failure) and whose
      // rulesFor never reflects the rule — so ONLY the in-memory union can make
      // the Always-allow stick.
      const hangingStore = {
        rulesFor: async () => [] as any[],
        remember: () => new Promise<void>(() => { /* never resolves */ }),
        // Present only to satisfy RememberedRuleStore, which the revocation task
        // widened with remove/removeProject. Never called in this test.
        remove: async () => false,
        removeProject: async () => false,
      };
      const p = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), writeFactory, NO_CONTEXT, async () => null, async () => null, undefined,
        hangingStore, '9.9.9',
      );
      const asks: any[] = []; p.on('hook-event', (e) => { if (e.type === 'PermissionRequest') asks.push(e); });
      await p.create({ sessionId: 's', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      // Turn 1 (mode 'ask'): the Write raises ONE ask; respond Always-allow.
      const ask1 = firstAsk(p);
      const t1Done = waitForTurnComplete(p, 1);
      p.send('s', 'write once');
      p.respondPermission(await ask1, { decision: { behavior: 'allow' }, updatedPermissions: [{ tool: 'Write' }] });
      await t1Done;
      expect(asks).toHaveLength(1);

      // Turn 2: the SAME gated call must NOT ask — the in-memory remembered rule
      // held even though the disk persist (remember) never resolved.
      const seen: any[] = []; p.on('transcript-event', (e) => seen.push(e));
      p.send('s', 'write again');   // no ask to wait on
      await waitForTurnComplete(p, 1);
      expect(asks).toHaveLength(1);       // still just the first ask (no re-ask)
      expect(seen.map((e) => e.type)).toContain('turn-complete');
      await p.destroyAll();
    });
  });

  // ---- M5 2a Task 7: revocation that reaches a LIVE session ----
  // The whole feature rests on this. buildDecide() unions the on-disk rules with
  // the per-session `rememberedFor` map on EVERY permission decision, so deleting
  // a rule from disk alone leaves a running session still granting exactly what
  // the user just revoked. These tests drive REAL turns (writeFactory builds a
  // fresh scripted model per turn, so every turn genuinely re-attempts the gated
  // Write) and assert on whether the session asks again — the only observable
  // that proves the revoke actually landed.
  describe('revokeRule / revokeProject', () => {
    const binding = { providerId: 'openrouter', modelId: 'm' } as const;

    /** A host wired to the given remembered-rule store, driving the Write-then-stop turn. */
    const revokeHost = (permStore: any) => new NativeSessionHost(
      new SessionStore(new NativeHome(root)), writeFactory, NO_CONTEXT, async () => null, async () => null, undefined,
      permStore, '9.9.9',
    );

    /** Drive one whole turn whose gated Write is answered with "Always allow".
     *  Sequential by construction — firstAsk/waitForTurnComplete are host-wide,
     *  not per-session, so two of these must never overlap. */
    async function alwaysAllowTurn(p: NativeSessionHost, sessionId: string, text: string): Promise<void> {
      const ask = firstAsk(p);
      const done = waitForTurnComplete(p, 1);
      p.send(sessionId, text);
      p.respondPermission(await ask, { decision: { behavior: 'allow' }, updatedPermissions: [{ tool: 'Write' }] });
      await done;
    }

    /** Drive one whole turn and report whether it raised a permission ask.
     *  Answers any ask with a deny so the turn always finishes — a firstAsk()
     *  await would hang forever on the (expected) no-ask path. */
    async function turnAsked(p: NativeSessionHost, sessionId: string, text: string): Promise<boolean> {
      let asked = false;
      const onHook = (e: any) => {
        if (e.type !== 'PermissionRequest' || asked) return;
        asked = true;
        p.respondPermission(e.payload._requestId, { decision: { behavior: 'deny' } });
      };
      p.on('hook-event', onHook);
      const done = waitForTurnComplete(p, 1);
      p.send(sessionId, text);
      await done;
      p.off('hook-event', onHook);
      return asked;
    }

    /** The disk persist behind "Always allow" is fire-and-forget (mutateJson under
     *  a file lock), so wait for it to land before revoking — otherwise remove()
     *  could run BEFORE the write and report a miss that is really a race. */
    async function waitForStoredRule(store: PermissionStore, cwd: string): Promise<PermissionRule> {
      for (let i = 0; i < POLL_TRIES; i++) {
        const hit = (await store.rulesFor(cwd)).find((r) => r.tool === 'Write' && r.action === 'allow');
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('the remembered Write rule never reached disk');
    }

    it('stops a live session granting the revoked rule', async () => {
      const store = new PermissionStore(new NativeHome(root));
      const p = revokeHost(store);
      await p.create({ sessionId: 's', cwd: root, binding });

      await alwaysAllowTurn(p, 's', 'write once');
      expect(await turnAsked(p, 's', 'write again')).toBe(false);   // remembered — no ask

      // Pass the rule AS STORED, which carries a grantedAt key the in-memory copy
      // never had. Matching must be on the (tool, pattern, action) TRIPLE — a
      // whole-object comparison would silently stop dropping the in-memory rule.
      const stored = await waitForStoredRule(store, root);
      expect((stored as any).grantedAt).toBeTypeOf('string');
      await expect(p.revokeRule(nativeStoreSlug(root), stored)).resolves.toBe(true);

      // Disk is clear AND the SAME still-running session asks again. If revokeRule
      // had only touched disk, rememberedFor would still grant and this stays false.
      expect(await store.rulesFor(root)).toEqual([]);
      expect(await turnAsked(p, 's', 'write a third time')).toBe(true);
      await p.destroyAll();
    });

    it('clears sessions whose cwd differs in spelling but shares the slug', async () => {
      // nativeStoreSlug collapses spaces to '-' exactly as it does '/', so these
      // two REAL, distinct directories genuinely share one entry on disk.
      const spacedCwd = path.join(root, 'my project');
      const dashedCwd = path.join(root, 'my-project');
      fs.mkdirSync(spacedCwd); fs.mkdirSync(dashedCwd);
      expect(nativeStoreSlug(spacedCwd)).toBe(nativeStoreSlug(dashedCwd));   // the premise

      // A store that never grants and never persists: rulesFor is always [], so
      // the ONLY thing that can make either session grant is its in-memory copy —
      // which is precisely what a slug-keyed drop has to clear in BOTH sessions.
      // (A real store would also mean the first session's disk write silently
      // pre-granted the second one, so it could never build an in-memory copy.)
      const memoryOnlyStore = {
        rulesFor: async () => [] as any[],
        remember: async () => { /* no-op */ },
        remove: async () => true,
        removeProject: async () => true,
      };
      const p = revokeHost(memoryOnlyStore);
      await p.create({ sessionId: 'spaced', cwd: spacedCwd, binding });
      await p.create({ sessionId: 'dashed', cwd: dashedCwd, binding });
      await alwaysAllowTurn(p, 'spaced', 'write once');
      await alwaysAllowTurn(p, 'dashed', 'write once');
      expect(await turnAsked(p, 'spaced', 'again')).toBe(false);
      expect(await turnAsked(p, 'dashed', 'again')).toBe(false);

      await p.revokeRule(nativeStoreSlug(spacedCwd), { tool: 'Write', pattern: 'note.txt', action: 'allow' });

      // Path equality would have cleared at most one of these.
      expect(await turnAsked(p, 'spaced', 'after revoke')).toBe(true);
      expect(await turnAsked(p, 'dashed', 'after revoke')).toBe(true);
      await p.destroyAll();
    });

    it('leaves an unrelated project untouched', async () => {
      const mineCwd = path.join(root, 'mine');
      const otherCwd = path.join(root, 'other');
      fs.mkdirSync(mineCwd); fs.mkdirSync(otherCwd);
      const memoryOnlyStore = {
        rulesFor: async () => [] as any[],
        remember: async () => { /* no-op */ },
        remove: async () => true,
        removeProject: async () => true,
      };
      const p = revokeHost(memoryOnlyStore);
      await p.create({ sessionId: 'mine', cwd: mineCwd, binding });
      await p.create({ sessionId: 'other', cwd: otherCwd, binding });
      await alwaysAllowTurn(p, 'mine', 'write once');
      await alwaysAllowTurn(p, 'other', 'write once');

      await p.revokeRule(nativeStoreSlug(mineCwd), { tool: 'Write', pattern: 'note.txt', action: 'allow' });

      expect(await turnAsked(p, 'mine', 'after revoke')).toBe(true);
      expect(await turnAsked(p, 'other', 'after revoke')).toBe(false);   // untouched
      await p.destroyAll();
    });

    it('revokes only the matching QUAD from a live session', async () => {
      // Two grants that differ ONLY in `match`. Under the old triple identity the
      // in-memory filter dropped both, so revoking the wide one from Settings
      // silently took the exact one with it.
      const store = new PermissionStore(new NativeHome(root));
      const exact = { tool: 'Write', pattern: 'note.txt', action: 'allow' as const, match: 'exact' as const };
      const wide = { tool: 'Write', pattern: 'note.txt', action: 'allow' as const, match: 'glob' as const };
      await store.remember(root, exact);
      await store.remember(root, wide);

      const p = revokeHost(store);
      await p.create({ sessionId: 'quad', cwd: root, binding });
      expect(await turnAsked(p, 'quad', 'write once')).toBe(false);   // granted by both

      await expect(p.revokeRule(nativeStoreSlug(root), wide)).resolves.toBe(true);

      // The exact grant survives on disk AND in the still-running session.
      expect(await store.rulesFor(root)).toMatchObject([{ pattern: 'note.txt', match: 'exact' }]);
      expect(await turnAsked(p, 'quad', 'write again')).toBe(false);
      await p.destroyAll();
    });

    it('returns false when the store matched nothing', async () => {
      const p = revokeHost(new PermissionStore(new NativeHome(root)));
      await expect(
        p.revokeRule('-never-granted', { tool: 'Bash', pattern: 'ls', action: 'allow' }),
      ).resolves.toBe(false);
      await p.destroyAll();
    });

    it('revokeProject clears the whole slice on disk AND in the live session', async () => {
      const store = new PermissionStore(new NativeHome(root));
      const p = revokeHost(store);
      await p.create({ sessionId: 's', cwd: root, binding });
      await alwaysAllowTurn(p, 's', 'write once');
      await waitForStoredRule(store, root);
      expect(await turnAsked(p, 's', 'write again')).toBe(false);

      await expect(p.revokeProject(nativeStoreSlug(root))).resolves.toBe(true);

      expect(await store.list()).toEqual([]);
      expect(await turnAsked(p, 's', 'after revoke')).toBe(true);
      await p.destroyAll();
    });

    it('revokeProject returns false for a slug with nothing stored', async () => {
      const p = revokeHost(new PermissionStore(new NativeHome(root)));
      await expect(p.revokeProject('-never-granted')).resolves.toBe(false);
      await p.destroyAll();
    });

    // D2 (2026-08-26) — the cross-project bucket. A grant on a specialist the
    // user defined in a folder THEY own is promised, on the card and in
    // Settings, to apply "in every project". It only does if the store files it
    // under CROSS_PROJECT_SLUG and every project's decide unions that in — and
    // if revoking reaches every live session, since no session's cwd slugs to a
    // key containing a space. These drive the REAL buildDecide, so the whole
    // union (disk bucket + this session's memory) is what answers.
    describe('a grant that applies in every project', () => {
      // The exact subject shapes tools/task.ts builds. `fp` is the definition
      // file's content hash: edit the file and the subject changes, which is
      // what makes the standing grant stop matching.
      const SUBJECT = 'read-write:file:docs-writer@a1b2c3d4e5f6';
      const EDITED_SUBJECT = 'read-write:file:docs-writer@ffffffffffff';
      const userRule: PermissionRule = { tool: 'Task', pattern: SUBJECT, action: 'allow', match: 'exact' };
      const memoryOnlyStore = () => ({
        rulesFor: async () => [] as any[],
        remember: async () => { /* no-op */ },
        remove: async () => true,
        removeProject: async () => true,
      });

      /** Two real, distinct project folders under the temp root. */
      function twoProjects(): [string, string] {
        const a = path.join(root, 'alpha'); const b = path.join(root, 'beta');
        fs.mkdirSync(a, { recursive: true }); fs.mkdirSync(b, { recursive: true });
        return [a, b];
      }

      it('approved in one project, in force in another — and an EDITED file still asks', async () => {
        const store = new PermissionStore(new NativeHome(root));
        const [cwdA, cwdB] = twoProjects();
        const p = revokeHost(store);
        await p.create({ sessionId: 'a', cwd: cwdA, binding });

        // Exactly what the "Always allow" path does (host owns the scoping).
        (p as any).rememberRule('a', cwdA, userRule);
        // The persist is fire-and-forget, so wait for it to land before reading
        // from a session that has no in-memory copy of its own.
        for (let i = 0; i < 100 && (await store.rulesFor(cwdB)).length === 0; i++) {
          await new Promise((r) => setTimeout(r, 10));
        }

        const decideB = (p as any).buildDecide('b', cwdB, []);
        expect((await decideB('Task', SUBJECT)).action).toBe('allow');
        // The other half of the promise the card makes: edit the file and you
        // are asked again, in every project, because the subject moved.
        expect((await decideB('Task', EDITED_SUBJECT)).action).toBe('ask');
        await p.destroyAll();
      });

      it('revoking the bucket clears it from a live session whose cwd is a real folder', async () => {
        // Memory-only store: the ONLY thing that can still grant after the disk
        // delete is the session's in-memory copy — which a cwd-slug comparison
        // would never have reached, because no cwd slugs to 'all projects'.
        const [cwdA] = twoProjects();
        const p = revokeHost(memoryOnlyStore());
        await p.create({ sessionId: 'a', cwd: cwdA, binding });
        (p as any).rememberRule('a', cwdA, userRule);

        const decideA = (p as any).buildDecide('a', cwdA, []);
        expect((await decideA('Task', SUBJECT)).action).toBe('allow');

        await p.revokeRule(CROSS_PROJECT_SLUG, userRule);
        expect((await decideA('Task', SUBJECT)).action).toBe('ask');
        await p.destroyAll();
      });

      it("clearing the whole bucket leaves that session's own project grants alone", async () => {
        const [cwdA] = twoProjects();
        const p = revokeHost(memoryOnlyStore());
        await p.create({ sessionId: 'a', cwd: cwdA, binding });
        const projectGrant: PermissionRule = { tool: 'Write', pattern: 'note.txt', action: 'allow', match: 'exact' };
        (p as any).rememberRule('a', cwdA, userRule);
        (p as any).rememberRule('a', cwdA, projectGrant);

        await p.revokeProject(CROSS_PROJECT_SLUG);

        const decideA = (p as any).buildDecide('a', cwdA, []);
        expect((await decideA('Task', SUBJECT)).action).toBe('ask');       // the bucket went
        // Deleting the session's whole memory here would have taken this with
        // it — a grant the user never asked to revoke, still listed in Settings
        // under its own folder.
        expect((await decideA('Write', 'note.txt')).action).toBe('allow');
        await p.destroyAll();
      });
    });
  });

  // ---- Task 13: preset selection + seeding + legacy 'chat' mapping ----
  describe('preset wiring', () => {
    const binding = { providerId: 'openrouter', modelId: 'm' } as const;

    it('create stamps the chosen preset in the header and seeds its default mode', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(store, factory, NO_CONTEXT, async () => null, async () => null);
      await h.create({ sessionId: 's1', cwd: root, binding, presetId: 'coder' });
      expect(store.readHeader('s1', root)?.harnessId).toBe('coder');
      expect(h.getPermissionMode('s1')).toBe('auto-edit');
      await h.destroyAll();
    });

    it('create defaults to assistant when no preset is given', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(store, factory, NO_CONTEXT, async () => null, async () => null);
      await h.create({ sessionId: 's2', cwd: root, binding });
      expect(store.readHeader('s2', root)?.harnessId).toBe('assistant');
      expect(h.getPermissionMode('s2')).toBe('ask');
      await h.destroyAll();
    });

    it("resume maps a legacy 'chat' header to assistant wiring without rewriting the header", async () => {
      // Seed a stored session whose header has the legacy harnessId:'chat'.
      const store = new SessionStore(new NativeHome(root));
      await store.create({ v: 1, sessionId: 'legacy1', harnessId: 'chat', binding, cwd: root, createdAt: Date.now() });

      const h = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null);
      expect(await h.resume('legacy1', root)).toBe(true);
      expect(h.getHarnessId('legacy1')).toBe('assistant');
      expect(store.readHeader('legacy1', root)?.harnessId).toBe('chat'); // header untouched — mapping is read-side
      await h.destroyAll();
    });

    it('an explicit user mode flip still beats the preset default', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(store, factory, NO_CONTEXT, async () => null, async () => null);
      await h.create({ sessionId: 's3', cwd: root, binding, presetId: 'coder' });
      h.setPermissionMode('s3', 'ask');
      expect(h.getPermissionMode('s3')).toBe('ask');
      await h.destroyAll();
    });
  });

  // ---- M1: per-session FIFO send queue + honest sent/queued/failed result ----
  describe('send queue (M1)', () => {
    // A fresh host per test, driven by delayedFactory (15ms/chunk) so a turn
    // stays genuinely in flight across several synchronous send() calls —
    // that's the window these tests exercise (queueing, the cap, interrupt,
    // destroy). Note send() itself sets entry.inFlight = true SYNCHRONOUSLY
    // before returning, so the queueing behavior below would hold even against
    // the fast `factory`; delayedFactory is used because it's what the brief
    // that authored these scenarios specifies and it makes the in-flight
    // window robust against future timing changes.
    let host: NativeSessionHost;
    let id: string;

    beforeEach(async () => {
      host = new NativeSessionHost(new SessionStore(new NativeHome(root)), delayedFactory, NO_CONTEXT, async () => null, async () => null);
      id = 'q-1';
      await host.create({ sessionId: id, cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    });
    afterEach(async () => { await host.destroyAll(); });

    it('send to an unknown session returns failed/not-live', () => {
      expect(host.send('ghost', 'x')).toEqual({ status: 'failed', reason: 'not-live' });
    });

    it('overlapping send queues FIFO and both turns complete in order', async () => {
      const events: string[] = [];
      host.on('transcript-event', (e) => { if (e.type === 'user-message') events.push(e.data.text); });
      const r1 = host.send(id, 'first');
      const r2 = host.send(id, 'second');
      expect(r1).toEqual({ status: 'sent' });
      // Cancel/edit (M1 follow-up): a queued ack now carries a host-minted id
      // so the renderer can target this exact entry with removeQueued() later.
      expect(r2.status).toBe('queued');
      expect(typeof (r2 as { queueId: string }).queueId).toBe('string');
      expect((r2 as { queueId: string }).queueId.length).toBeGreaterThan(0);
      await waitForTurnComplete(host, 2);
      expect(events).toEqual(['first', 'second']); // user-message for 'second' fires only when drained
    });

    it('refuses honestly past the queue cap', () => {
      host.send(id, 'turn'); // in flight
      for (let i = 0; i < 10; i++) expect(host.send(id, `q${i}`).status).toBe('queued');
      expect(host.send(id, 'overflow')).toEqual({ status: 'failed', reason: 'queue-full' });
    });

    // ---- Cancel/edit queued messages (Task 11) ----
    describe('removeQueued', () => {
      it('removes a queued entry mid-queue — the drain skips it and it never emits user-message', async () => {
        const events: string[] = [];
        host.on('transcript-event', (e) => { if (e.type === 'user-message') events.push(e.data.text); });
        host.send(id, 'first');                                  // dispatched now
        const rA = host.send(id, 'a') as { status: 'queued'; queueId: string };
        const rB = host.send(id, 'b') as { status: 'queued'; queueId: string };
        expect(host.removeQueued(id, rA.queueId)).toBe(true);
        await waitForTurnComplete(host, 2);                      // 'first' + 'b' — 'a' was cut
        expect(events).toEqual(['first', 'b']);
        expect(rB.queueId).not.toBe(rA.queueId);
      });

      it('returns false for an id that already drained (shift() beat the removal)', async () => {
        host.send(id, 'first');
        const rA = host.send(id, 'a') as { status: 'queued'; queueId: string };
        await waitForTurnComplete(host, 2); // both turns finish — 'a' has been shift()'d and sent
        expect(host.removeQueued(id, rA.queueId)).toBe(false);
      });

      it('returns false on a dead/unknown session — never throws', () => {
        expect(host.removeQueued('ghost-session', 'whatever')).toBe(false);
      });

      it('returns false for an id that was never queued', () => {
        host.send(id, 'first'); // in flight, nothing queued yet
        expect(host.removeQueued(id, 'not-a-real-id')).toBe(false);
      });
    });

    it('interrupt aborts the current turn only — the queue still drains (pinned semantics)', async () => {
      const events: any[] = [];
      host.on('transcript-event', (e) => events.push(e));
      host.send(id, 'long');           // delayedFactory turn
      host.send(id, 'queued-survivor');
      // M1 ordering fix (2026-07-22): send() now defers the turn dispatch one
      // macrotask (setImmediate) so the invoke reply beats the transcript
      // event. Interrupting in the SAME tick as send() would race that gap
      // and no-op (the abort controller doesn't exist until the deferred turn
      // actually starts — see the WHY comment on send()); a real user's stop
      // click is always at least one tick after their send, so wait a
      // macrotask before interrupting so the turn is genuinely in flight.
      await new Promise((r) => setImmediate(r));
      host.interrupt(id);
      await waitForTurnComplete(host, 1);    // survivor's turn
      // Transcript contains user-interrupt for turn 1, then user-message 'queued-survivor'.
      const types = events.map((e) => e.type);
      expect(types).toContain('user-interrupt');
      expect(types).toContain('turn-complete');
      const interruptIdx = types.indexOf('user-interrupt');
      const survivorMsgIdx = events.findIndex((e) => e.type === 'user-message' && e.data.text === 'queued-survivor');
      expect(survivorMsgIdx).toBeGreaterThan(interruptIdx); // the queue only drains AFTER the interrupt settles turn 1
    });

    it('a failed turn (factory throw) does not strand the queue', async () => {
      const errHost = new NativeSessionHost(new SessionStore(new NativeHome(root)), throwOnceFactory(), NO_CONTEXT, async () => null, async () => null);
      await errHost.create({ sessionId: 'e-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const types: string[] = [];
      errHost.on('transcript-event', (e) => types.push(e.type));
      const r1 = errHost.send('e-1', 'doomed');
      const r2 = errHost.send('e-1', 'after-error');
      expect(r1).toEqual({ status: 'sent' });
      expect(r2.status).toBe('queued'); // queueId is a fresh randomUUID — not asserted verbatim here
      await waitForTurnComplete(errHost, 1); // 'after-error' produced a turn-complete despite turn 1 erroring
      expect(types).toContain('session-error'); // turn 1 (doomed) errored, not stranded the queue
      expect(types).toContain('turn-complete');  // turn 2 (after-error) still ran and completed
      await errHost.destroyAll();
    });

    it('destroy mid-turn drops queued sends without unhandled rejection', async () => {
      const events: any[] = [];
      host.on('transcript-event', (e) => events.push(e));
      host.send(id, 'long');
      host.send(id, 'never-sent');
      await expect(host.destroy(id)).resolves.toBeUndefined(); // no throw
      expect(events.some((e) => e.type === 'user-message' && e.data.text === 'never-sent')).toBe(false);
    });

    // Fix for the ack-vs-transcript ordering race: send() now defers runTurns()
    // one macrotask (setImmediate) past its synchronous return so the invoke
    // reply beats the transcript-event. This opens a one-tick gap where a
    // destroy() landing in the SAME tick as send() (before the setImmediate
    // callback fires) races the still-scheduled turn: destroy() removes the
    // session's listeners synchronously, so when runTurns eventually calls
    // entry.session.send() the turn still runs (see the WHY comment on
    // send()) but is a zombie — no listener is left to forward or persist
    // anything. Must not throw and must not emit for the dropped text.
    it('destroy in the same tick as send() drops the turn without unhandled rejection', async () => {
      const events: any[] = [];
      host.on('transcript-event', (e) => events.push(e));
      host.send(id, 'same-tick');
      await expect(host.destroy(id)).resolves.toBeUndefined(); // no throw, no unhandled rejection
      // Give the deferred runTurns (setImmediate) + the now-zombie turn's
      // delayed stream room to play out in the background — it must stay
      // silent (destroy() already tore down the session's listeners).
      await new Promise((r) => setTimeout(r, 150));
      expect(events.some((e) => e.type === 'user-message' && e.data.text === 'same-tick')).toBe(false);
    });
  });

  // ---- Task 9: quiesce (takeover/teardown) ----
  // quiesce is deliberately STRONGER than interrupt(): interrupt aborts only the
  // current turn and lets the M1 FIFO queue keep draining (pinned above:
  // "interrupt aborts the current turn only"). For a takeover that is WRONG — a
  // queued message would start a NEW turn AFTER the flush and append past it,
  // corrupting the transcript the requester is about to pull. quiesce guarantees
  // the opposite: after it resolves, NO further appends happen until a new send.
  describe('quiesce (Task 9 — takeover/teardown)', () => {
    it('quiesce clears the queue, aborts mid-stream, and no appends occur after it resolves', async () => {
      const store = new SessionStore(new NativeHome(root));
      const appendSpy = vi.spyOn(store, 'append');
      const qHost = new NativeSessionHost(store, delayedFactory, NO_CONTEXT, async () => null, async () => null);
      await qHost.create({ sessionId: 'qz', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      qHost.send('qz', 'long');              // slow (delayedFactory) turn in flight
      qHost.send('qz', 'queued-survivor');   // FIFO'd behind it — must NEVER run
      await new Promise((r) => setImmediate(r)); // let the first turn genuinely start

      await qHost.quiesce('qz');
      const appendsAtQuiesce = appendSpy.mock.calls.length;
      await new Promise((r) => setTimeout(r, 80)); // the queue would have drained by now
      expect(appendSpy.mock.calls.length).toBe(appendsAtQuiesce); // queued-survivor never ran

      // The survivor's user-message never reached disk (its turn was cut before it started).
      const survivorMsgs = store.readEvents('qz', root)
        .filter((e) => e.type === 'user-message' && e.data.text === 'queued-survivor');
      expect(survivorMsgs).toHaveLength(0);
      await qHost.destroyAll();
    });

    it('quiesce catches a same-tick send (setImmediate defer) — the turn is aborted, never completed', async () => {
      const store = new SessionStore(new NativeHome(root));
      const appendSpy = vi.spyOn(store, 'append');
      const qHost = new NativeSessionHost(store, delayedFactory, NO_CONTEXT, async () => null, async () => null);
      await qHost.create({ sessionId: 'qz2', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      // send() and quiesce() in the SAME synchronous tick. send() defers its
      // runTurns dispatch one macrotask (setImmediate), so an interrupt that ran
      // in this same tick would MISS the turn (the AbortController doesn't exist
      // until runTurns actually starts it). quiesce awaits one macrotask FIRST, so
      // it catches the just-dispatched turn and aborts it.
      qHost.send('qz2', 'same-tick');
      await qHost.quiesce('qz2');

      const appendsAtQuiesce = appendSpy.mock.calls.length;
      await new Promise((r) => setTimeout(r, 80));
      expect(appendSpy.mock.calls.length).toBe(appendsAtQuiesce); // no post-quiesce appends
      // Aborted mid-stream: the turn must NOT have reached turn-complete.
      const types = store.readEvents('qz2', root).map((e) => e.type);
      expect(types).not.toContain('turn-complete');
      await qHost.destroyAll();
    });
  });

  // ---- Specialists (plan 1a, Task 5): createChild mints a CHILD session —
  // an ordinary HarnessSession marked by parentage, cold-started, with a
  // charter-capped tool + permission surface and no route to a user ask.
  describe('specialist children (Task 5)', () => {
    const EXPLORER = resolveSpecialist('explorer')!;
    // Boot a host we hold the store handle for (the suite's shared `host`
    // builds its store inline) so a test can read the child's header back.
    function bootHost(modelFactory: any = factory, skillCatalog?: any) {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, modelFactory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, skillCatalog,
      );
      return { store, h };
    }
    async function withParent(modelFactory: any = factory, skillCatalog?: any) {
      const { store, h } = bootHost(modelFactory, skillCatalog);
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      return { store, h };
    }
    // Task 8: a host whose specialistAskHoldMs is overridden to a small,
    // real (not fake-timer) delay — see the constructor param's own WHY for
    // why tests prefer this over vi.useFakeTimers() against a file this
    // heavy in setImmediate-driven async machinery.
    async function withParentFastAskHold(askHoldMs: number, modelFactory: any = factory) {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, modelFactory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, askHoldMs,
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      return { store, h };
    }
    // The child's live HarnessSession — Task 7 reaches it the same way (through
    // the host's live map); here it is the only route to the child's tool surface.
    const childSession = (h: NativeSessionHost, id: string) => (h as any).live.get(id).session;
    const toolNames = (h: NativeSessionHost, id: string) => Object.keys(childSession(h, id).buildAiTools());

    it('createChild mints a child session with parent header fields and restricted tools', async () => {
      const { store, h } = await withParent();
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'find the config loader', workDir: root, parentToolCallId: 'tc-1',
      });
      const header = store.readHeader(childId, root);
      expect(header?.parentSessionId).toBe('root-1');
      expect(header?.sessionKind).toBe('specialist');
      expect(header?.agentType).toBe('explorer');
      expect(header?.cwd).toBe(root);
      expect(header?.binding).toEqual({ providerId: 'openrouter', modelId: 'm' });   // inherits the parent's model
      // Task 8: the child's assigned fun name lands in the header's existing
      // `title` field — the transcript header/list machinery renders it for
      // free, no new plumbing needed beyond this write.
      expect(header?.title).toMatch(/^\w+ the \w+ (Explorer|Researcher|Reviewer|Worker)$/);
      // Exactly the definition's allowlist — no Write/Edit/Bash/TodoWrite/AskUserQuestion.
      expect(toolNames(h, childId).sort()).toEqual([...EXPLORER.allowedTools].sort());
      // WHY: specialist children are lifecycle-bounded by their parent rather than
      // an arbitrary child action count; their selected preset stays unmodified.
      expect((childSession(h, childId) as any).opts.harness.limits?.maxSteps).toBeUndefined();
      await h.destroyAll();
    });

    // Task 14: opts.binding, when tools/task.ts already resolved an override
    // (a designated tier or a validated specific id), is what the CHILD
    // actually launches on — not the parent's own binding. Every field that
    // reads `binding` downstream (the header, retainModel's ref-count, the
    // child's own HarnessSession) must agree on the OVERRIDE, not silently
    // fall back to the parent's.
    it('createChild launches on opts.binding when one is given, not the parent\'s own model', async () => {
      const { store, h } = await withParent();
      const override = { providerId: 'anthropic', modelId: 'claude-opus-5' };
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'find the config loader', workDir: root, parentToolCallId: 'tc-1',
        binding: override,
      });
      const header = store.readHeader(childId, root);
      expect(header?.binding).toEqual(override);                 // NOT the parent's { providerId: 'openrouter', modelId: 'm' }
      expect(h.modelForSession(childId)).toBe('claude-opus-5');   // retainModel ref-counted the RESOLVED model
      expect(h.sessionsForModel('claude-opus-5')).toEqual([childId]);
      expect(h.sessionsForModel('m')).toEqual(['root-1']);        // the parent's own ref is untouched
      await h.destroyAll();
    });

    it('createChild falls back to the parent\'s binding when opts.binding is omitted (pre-Task-14 default, unchanged)', async () => {
      const { store, h } = await withParent();
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'find the config loader', workDir: root, parentToolCallId: 'tc-1',
      });
      const header = store.readHeader(childId, root);
      expect(header?.binding).toEqual({ providerId: 'openrouter', modelId: 'm' });
      await h.destroyAll();
    });

    it('createChild rejects a workDir outside the parent cwd', async () => {
      const { h } = await withParent();
      await expect(h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: '/etc', parentToolCallId: 'tc-1',
      })).rejects.toThrow(/inside the parent/i);
      await h.destroyAll();
    });

    it('createChild accepts a subdirectory of the parent cwd (a narrower jail is fine)', async () => {
      const { store, h } = await withParent();
      const sub = path.join(root, 'sub');
      fs.mkdirSync(sub, { recursive: true });
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: sub, parentToolCallId: 'tc-1',
      });
      expect(store.readHeader(childId, sub)?.cwd).toBe(sub);
      await h.destroyAll();
    });

    it('createChild refuses a parent that is not live — never a child with no owner', async () => {
      const { h } = await withParent();
      await expect(h.createChild('ghost', {
        specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      })).rejects.toThrow(/ghost/);
      await h.destroyAll();
    });

    it('a child session has no Skill tool and no Task tool (cold-start contract, depth 1)', async () => {
      // The host IS given a populated catalog, so the parent gets the Skill tool
      // — that is what makes the child's absence meaningful rather than an
      // artifact of the sandboxed HOME (tests/global-setup.ts) finding no skills.
      const catalog = { list: () => [{ id: 'journal', description: 'Write a journal entry' }], load: (id: string) => ({ id, displayName: id, description: 'd', body: 'b' }) };
      const { h } = await withParent(factory, catalog);
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      expect(toolNames(h, 'root-1')).toContain('Skill');   // the parent can reach skills…
      const names = toolNames(h, childId);
      expect(names).not.toContain('Skill');                // …the child cannot
      expect(names).not.toContain('Task');                 // depth 1 by toolset omission
      // Explicit-suppression pin: the child was HANDED an empty catalog rather
      // than left to fall back to createSkillCatalog(). Both look identical in
      // this suite (the sandboxed HOME has no skills either), so only reading
      // back what was injected can tell them apart — and in production that is
      // the difference between "no skills" and "the user's whole library".
      const injected = (childSession(h, childId) as any).opts.skillCatalog;
      expect(injected.list()).toEqual([]);
      expect(() => injected.load('journal')).toThrow(/No skill named/);
      // Same for MCP: no lease is acquired for a child, so no servers ride along.
      expect((childSession(h, childId) as any).opts.mcpServers).toBeUndefined();
      await h.destroyAll();
    });

    it('children are hidden from the Resume Browser list', async () => {
      const { h } = await withParent();
      await h.createChild('root-1', { specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1' });
      expect(h.list().map((r) => r.sessionId)).toEqual(['root-1']);
      await h.destroyAll();
    });

    it("a child's events persist under its OWN id and never reach the host emitter (display copies are Task 7)", async () => {
      const { store, h } = await withParent();
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      const onHost: any[] = [];
      h.on('transcript-event', (e) => onHost.push(e));
      await childSession(h, childId).send('go');
      await h.drain(childId);
      // Persisted to the child's own JSONL...
      expect(store.readEvents(childId, root).map((e) => e.type)).toEqual(['user-message', 'assistant-text', 'turn-complete']);
      // ...and NOT forwarded raw to the renderer: an un-stamped child event
      // would mint a conversation record for a session no window owns.
      expect(onHost.filter((e) => e.sessionId === childId)).toEqual([]);
      await h.destroyAll();
    });

    it("the child runs inside the launch envelope: a parent 'ask' for an in-charter tool never prompts", async () => {
      // Worker charter is read-write and lists Write; the parent sits in the
      // default 'ask' mode, where Write would normally raise a permission ask.
      // The envelope (the user's approval at spawn) converts that to an allow —
      // and no ask may reach the broker, because a child has no user.
      const WORKER = resolveSpecialist('worker')!;
      const writeOnce = () => scriptedModel([
        stream(toolCallChunk('c1', 'Write', { file_path: 'child-note.txt', content: 'hi' }), finishChunk('tool-calls')),
        stream(...textChunks('t', 'done'), finishChunk('stop')),
      ]) as any;
      const { h } = await withParent(async () => writeOnce());
      const { childId } = await h.createChild('root-1', {
        specialist: WORKER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      const asks: any[] = [];
      h.on('hook-event', (e) => asks.push(e));
      await childSession(h, childId).send('go');
      expect(asks).toEqual([]);                                           // no ask was raised
      expect(fs.existsSync(path.join(root, 'child-note.txt'))).toBe(true); // the tool actually ran
      await h.destroyAll();
    });

    it("the destructive deny-list cuts through the envelope, but now ROUTES to the parent instead of hard-denying (Task 8)", async () => {
      // Critical review fix (plan 1a): launch consent (the envelope) is consent
      // for the specialist's CHARTER of work, not for `rm -rf` — spec §5 says no
      // charter or envelope overrides the destructive deny-list. Worker is
      // read-write and has Bash, and the parent sits in the default 'ask' mode
      // where the deny-list layer marks `rm *` denyListed. Plan 1b Task 8 flips
      // the OUTCOME of that (a real user can now approve it) without touching
      // the invariant itself (the envelope still never silently overrides it).
      const WORKER = resolveSpecialist('worker')!;
      fs.writeFileSync(path.join(root, 'marker.txt'), 'do not delete me');
      const rmOnce = () => scriptedModel([
        stream(toolCallChunk('c1', 'Bash', { command: 'rm -rf marker.txt' }), finishChunk('tool-calls')),
        stream(...textChunks('t', 'done'), finishChunk('stop')),
      ]) as any;
      const { h } = await withParent(async () => rmOnce());
      const { childId } = await h.createChild('root-1', {
        specialist: WORKER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      const asks: any[] = [];
      const events: any[] = [];
      h.on('hook-event', (e) => asks.push(e));
      childSession(h, childId).on('transcript-event', (e: any) => events.push(e));
      const askArrived = firstAsk(h);
      const sendPromise = childSession(h, childId).send('go');
      const requestId = await askArrived;
      // The ask reaches the host under the PARENT's id (root-1), with the
      // specialist labelled — not the child's own id, which no window owns.
      const ask = asks.find((e) => e.type === 'PermissionRequest')!;
      expect(ask.sessionId).toBe('root-1');
      expect(ask.payload.denyListed).toBe(true);
      expect(ask.payload.specialist).toMatchObject({ childId, agentType: 'worker' });
      expect(fs.existsSync(path.join(root, 'marker.txt'))).toBe(true); // still hasn't run — awaiting an answer
      // A real user answers (deny) within the window — real declines get the
      // plain copy, no redirect wording.
      expect(h.respondPermission(requestId, { behavior: 'deny' })).toBe(true);
      await sendPromise;
      const res = events.find((e) => e.type === 'tool-result')!;
      expect(res.data.isError).toBe(true);
      expect(res.data.toolResult).toMatch(/user declined/i);
      expect(res.data.toolResult).not.toMatch(/pending on their screen/i); // not the timeout redirect
      expect(fs.existsSync(path.join(root, 'marker.txt'))).toBe(true);     // never ran
      await h.destroyAll();
    });

    it('an unanswered destructive-action ask times out into the redirect, and the ask stays answerable after', async () => {
      const WORKER = resolveSpecialist('worker')!;
      const rmOnce = () => scriptedModel([
        stream(toolCallChunk('c1', 'Bash', { command: 'rm -rf marker.txt' }), finishChunk('tool-calls')),
        stream(...textChunks('t', 'done'), finishChunk('stop')),
      ]) as any;
      const { h } = await withParentFastAskHold(20, async () => rmOnce());
      const { childId } = await h.createChild('root-1', {
        specialist: WORKER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      const asks: any[] = [];
      const events: any[] = [];
      h.on('hook-event', (e) => asks.push(e));
      childSession(h, childId).on('transcript-event', (e: any) => events.push(e));
      const askArrived = firstAsk(h);
      await childSession(h, childId).send('go'); // resolves once the (timed-out) turn settles
      const requestId = await askArrived;
      const res = events.find((e) => e.type === 'tool-result')!;
      expect(res.data.isError).toBe(true);
      expect(res.data.toolResult).toMatch(/pending on their screen/i);
      expect(res.data.toolResult).toMatch(/Do NOT attempt the blocked action by any other means/);
      // Nothing expired the card — no PermissionExpired for this id, so it is
      // exactly what "the entry stays answerable" means.
      expect(asks.some((e) => e.type === 'PermissionExpired' && e.payload._requestId === requestId)).toBe(false);
      expect(h.respondPermission(requestId, { behavior: 'allow' })).toBe(true); // still findable
      await h.destroyAll();
    });

    it('a late APPROVE while the child is still live arrives as a steer naming the tool', async () => {
      const WORKER = resolveSpecialist('worker')!;
      const rmOnce = () => scriptedModel([
        stream(toolCallChunk('c1', 'Bash', { command: 'rm -rf marker.txt' }), finishChunk('tool-calls')),
        stream(...textChunks('t', 'done'), finishChunk('stop')),
      ]) as any;
      const { h } = await withParentFastAskHold(20, async () => rmOnce());
      const { childId } = await h.createChild('root-1', {
        specialist: WORKER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      const askArrived = firstAsk(h);
      const child = childSession(h, childId);
      const steerSpy = vi.spyOn(child, 'postSteer');
      await child.send('go'); // times out into the redirect; the child stays LIVE (never destroy()'d here)
      const requestId = await askArrived;
      expect(h.respondPermission(requestId, { behavior: 'allow' })).toBe(true);
      expect(steerSpy).toHaveBeenCalledTimes(1);
      const [text] = steerSpy.mock.calls[0];
      expect(text).toMatch(/Bash/);
      expect(text).toMatch(/APPROVED — you may do it now/);
      await h.destroyAll();
    });

    it('a late DENY while the child is still live arrives as a steer naming the tool, denied', async () => {
      const WORKER = resolveSpecialist('worker')!;
      const rmOnce = () => scriptedModel([
        stream(toolCallChunk('c1', 'Bash', { command: 'rm -rf marker.txt' }), finishChunk('tool-calls')),
        stream(...textChunks('t', 'done'), finishChunk('stop')),
      ]) as any;
      const { h } = await withParentFastAskHold(20, async () => rmOnce());
      const { childId } = await h.createChild('root-1', {
        specialist: WORKER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      const askArrived = firstAsk(h);
      const child = childSession(h, childId);
      const steerSpy = vi.spyOn(child, 'postSteer');
      await child.send('go');
      const requestId = await askArrived;
      expect(h.respondPermission(requestId, { behavior: 'deny' })).toBe(true);
      const [text] = steerSpy.mock.calls[0];
      expect(text).toMatch(/DENIED — do not attempt it/);
      await h.destroyAll();
    });

    // ---- Fix pass, Finding 2: a LATE "Always allow" must persist too, not
    // just steer/notify. Before this fix onLateResponse never read
    // decision.always at all — it only ever steered the live child or queued
    // a host notice, so "Always allow" answered after the timeout silently
    // dropped the "and remember this" half, reachable through a second door
    // beyond child-ask-router.ts's in-time path. ----
    it('a LATE "Always allow" while the child is still live BOTH steers AND persists a specialist-keyed rule (Fix 2)', async () => {
      const WORKER = resolveSpecialist('worker')!;
      const rmOnce = () => scriptedModel([
        stream(toolCallChunk('c1', 'Bash', { command: 'rm -rf marker.txt' }), finishChunk('tool-calls')),
        stream(...textChunks('t', 'done'), finishChunk('stop')),
      ]) as any;
      const store = new PermissionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), async () => rmOnce(), NO_CONTEXT, async () => null, async () => null, undefined,
        store, undefined, undefined, undefined, undefined, undefined, 20,
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const { childId } = await h.createChild('root-1', {
        specialist: WORKER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      const askArrived = firstAsk(h);
      const child = childSession(h, childId);
      const steerSpy = vi.spyOn(child, 'postSteer');
      await child.send('go'); // times out into the redirect; child stays live
      const requestId = await askArrived;
      // Same "Always allow" payload shape the in-time router test uses.
      expect(h.respondPermission(requestId, { decision: { behavior: 'allow' }, updatedPermissions: [{ tool: 'Bash' }] })).toBe(true);
      expect(steerSpy).toHaveBeenCalledTimes(1); // the steer still happens — this fix must not regress it

      let rules: any[] = [];
      for (let i = 0; i < POLL_TRIES; i++) {
        rules = await store.rulesFor(root);
        if (rules.some((r) => r.specialist === 'worker')) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(rules).toContainEqual(expect.objectContaining({
        tool: 'Bash', pattern: 'rm -rf marker.txt', action: 'allow', specialist: 'worker',
      }));
      await h.destroyAll();
    });

    it('a LATE "Always allow" after the child already ended ALSO persists a specialist-keyed rule (Fix 2)', async () => {
      const WORKER = resolveSpecialist('worker')!;
      let calls = 0;
      const rmThenText = async () => {
        calls += 1;
        if (calls === 1) {
          return scriptedModel([
            stream(toolCallChunk('c1', 'Bash', { command: 'rm -rf marker.txt' }), finishChunk('tool-calls')),
            stream(...textChunks('t', 'done'), finishChunk('stop')),
          ]) as any;
        }
        return factory();
      };
      const store = new PermissionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), rmThenText, NO_CONTEXT, async () => null, async () => null, undefined,
        store, undefined, undefined, undefined, undefined, undefined, 20,
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const { childId } = await h.createChild('root-1', {
        specialist: WORKER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      const askArrived = firstAsk(h);
      await childSession(h, childId).send('go'); // times out into the redirect
      const requestId = await askArrived;
      await h.destroy(childId); // normal teardown AFTER the ask already timed out
      const noticeArrived = waitForEvent(h, (e) => e.sessionId === 'root-1' && e.type === 'user-message' && e.data.injected === 'specialist-report');
      expect(h.respondPermission(requestId, { decision: { behavior: 'allow' }, updatedPermissions: [{ tool: 'Bash' }] })).toBe(true);
      await noticeArrived; // the host-notice half still fires — this fix must not regress it

      let rules: any[] = [];
      for (let i = 0; i < POLL_TRIES; i++) {
        rules = await store.rulesFor(root);
        if (rules.some((r) => r.specialist === 'worker')) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(rules).toContainEqual(expect.objectContaining({
        tool: 'Bash', pattern: 'rm -rf marker.txt', action: 'allow', specialist: 'worker',
      }));
      await h.destroyAll();
    });

    // Fix (Important 6, final review): onLateResponse used to hand-build its
    // own rule object, discarding decision.grantScope entirely — an exact
    // rule was stored no matter what width the user picked. Same command
    // shape (git push origin feat/x) the root-session-level rememberedRuleFor
    // test suite already pins for the 'wide' grant, driven through the LATE
    // routed path this time.
    it('a LATE "Always allow" persists the DERIVED WIDE rule when the user picked that width, not an exact-match rule', async () => {
      const WORKER = resolveSpecialist('worker')!;
      let calls = 0;
      const pushThenText = async () => {
        calls += 1;
        if (calls === 1) {
          return scriptedModel([
            stream(toolCallChunk('c1', 'Bash', { command: 'git push origin feat/x' }), finishChunk('tool-calls')),
            stream(...textChunks('t', 'done'), finishChunk('stop')),
          ]) as any;
        }
        return factory();
      };
      const store = new PermissionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), pushThenText, NO_CONTEXT, async () => null, async () => null, undefined,
        store, undefined, undefined, undefined, undefined, undefined, 20,
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const { childId } = await h.createChild('root-1', {
        specialist: WORKER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      const askArrived = firstAsk(h);
      await childSession(h, childId).send('go'); // times out into the redirect
      const requestId = await askArrived;
      await h.destroy(childId); // normal teardown AFTER the ask already timed out
      const noticeArrived = waitForEvent(h, (e) => e.sessionId === 'root-1' && e.type === 'user-message' && e.data.injected === 'specialist-report');
      expect(h.respondPermission(requestId, { decision: { behavior: 'allow' }, updatedPermissions: [{ tool: 'Bash' }], grantScope: 'wide' })).toBe(true);
      await noticeArrived;

      let rules: any[] = [];
      for (let i = 0; i < POLL_TRIES; i++) {
        rules = await store.rulesFor(root);
        if (rules.some((r) => r.specialist === 'worker')) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(rules).toContainEqual(expect.objectContaining({
        tool: 'Bash', pattern: 'git push*origin feat/x', match: 'glob', action: 'allow', specialist: 'worker',
      }));
      // The forbidden shape (what the bug produced): an exact-match rule
      // storing the literal command instead of the derived wide pattern.
      expect(rules).not.toContainEqual(expect.objectContaining({
        tool: 'Bash', pattern: 'git push origin feat/x', specialist: 'worker',
      }));
      await h.destroyAll();
    });

    it('a late APPROVE after the child ended queues a parent delivery naming task_id', async () => {
      const WORKER = resolveSpecialist('worker')!;
      // First factory call (the child's turn) attempts the destructive Bash
      // call; every later call (the parent's own turns, including the
      // injected notice's turn) gets the plain text-only model.
      let calls = 0;
      const rmThenText = async () => {
        calls += 1;
        if (calls === 1) {
          return scriptedModel([
            stream(toolCallChunk('c1', 'Bash', { command: 'rm -rf marker.txt' }), finishChunk('tool-calls')),
            stream(...textChunks('t', 'done'), finishChunk('stop')),
          ]) as any;
        }
        return factory();
      };
      const { h } = await withParentFastAskHold(20, rmThenText);
      const { childId } = await h.createChild('root-1', {
        specialist: WORKER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      const askArrived = firstAsk(h);
      await childSession(h, childId).send('go'); // times out into the redirect
      const requestId = await askArrived;
      await h.destroy(childId); // the specialist's own normal teardown, AFTER its ask already timed out
      const noticeArrived = waitForEvent(h, (e) => e.sessionId === 'root-1' && e.type === 'user-message' && e.data.injected === 'specialist-report');
      expect(h.respondPermission(requestId, { behavior: 'allow' })).toBe(true);
      const notice = await noticeArrived;
      expect(notice.data.text).toMatch(/^\[Specialist follow-up\]/);
      expect(notice.data.text).toMatch(/approved/i);
      expect(notice.data.text).toMatch(/Bash/);
      expect(notice.data.text).toContain(childId); // task_id, so the parent can name what to resume
      await h.destroyAll();
    });

    it('destroy(childId) cancels a routed ask registered under the parent id (raisedBy match) while still within its window', async () => {
      const WORKER = resolveSpecialist('worker')!;
      const rmOnce = () => scriptedModel([
        stream(toolCallChunk('c1', 'Bash', { command: 'rm -rf marker.txt' }), finishChunk('tool-calls')),
        stream(...textChunks('t', 'done'), finishChunk('stop')),
      ]) as any;
      const { h } = await withParent(async () => rmOnce()); // real 5-minute hold — never lets the timeout race this test
      const { childId } = await h.createChild('root-1', {
        specialist: WORKER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      const asks: any[] = [];
      h.on('hook-event', (e) => asks.push(e));
      const askArrived = firstAsk(h);
      const sendPromise = childSession(h, childId).send('go');
      await askArrived;
      await h.destroy(childId); // torn down WHILE the ask is still pending, not yet timed out
      await sendPromise; // the child's own turn unwinds via the 'canceled' interrupt path
      expect(asks.some((e) => e.type === 'PermissionExpired')).toBe(true); // card cleared
      await h.destroyAll();
    });

    // ---- Task 11: the dropped-decision finding (previous task's review) ----
    // A routed child ask's "Always allow" used to vanish: HarnessSession emits
    // 'remember-rule' on ITSELF regardless of root/child, but createChild
    // deliberately never wire()s a child (see createChild's own "NOT wire()"
    // comment) — so nothing was ever listening. The fix routes persistence
    // through child-ask-router.ts instead, scoped to the specialist's
    // agentType so the grant can never widen the root session's own
    // permissions or leak to a different specialist type.
    describe('"Always allow" on a routed child ask (Task 11 dropped-decision fix)', () => {
      const rmOnce = () => scriptedModel([
        stream(toolCallChunk('c1', 'Bash', { command: 'rm -rf marker.txt' }), finishChunk('tool-calls')),
        stream(...textChunks('t', 'done'), finishChunk('stop')),
      ]) as any;

      it('persists a SPECIALIST-KEYED rule via the router, against the PARENT\'s cwd', async () => {
        const WORKER = resolveSpecialist('worker')!;
        const store = new PermissionStore(new NativeHome(root));
        const h = new NativeSessionHost(
          new SessionStore(new NativeHome(root)), async () => rmOnce(), NO_CONTEXT, async () => null, async () => null, undefined,
          store, '9.9.9',
        );
        await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
        const { childId } = await h.createChild('root-1', {
          specialist: WORKER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
        });
        const askArrived = firstAsk(h);
        const sendPromise = childSession(h, childId).send('go');
        const requestId = await askArrived;
        // "Always allow", exactly the same payload shape a root-session card sends.
        expect(h.respondPermission(requestId, { decision: { behavior: 'allow' }, updatedPermissions: [{ tool: 'Bash' }] })).toBe(true);
        await sendPromise;

        // Fire-and-forget disk persist (same contract as the root path) — poll.
        let rules: any[] = [];
        for (let i = 0; i < POLL_TRIES; i++) {
          rules = await store.rulesFor(root);          // the PARENT's cwd, never the child's workDir
          if (rules.some((r) => r.specialist === 'worker')) break;
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(rules).toContainEqual(expect.objectContaining({
          tool: 'Bash', pattern: 'rm -rf marker.txt', action: 'allow', specialist: 'worker',
        }));
        await h.destroyAll();
      });

      it('sticks for the SAME child\'s next identical command (in-memory, not just disk)', async () => {
        const WORKER = resolveSpecialist('worker')!;
        // A FRESH scripted instance per factory call, same reasoning as
        // writeFactory at the top of this file — each send() needs its own
        // per-step counter.
        const rmEachTime = async () => rmOnce();
        const h = new NativeSessionHost(
          new SessionStore(new NativeHome(root)), rmEachTime, NO_CONTEXT, async () => null, async () => null,
        );
        await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
        const { childId } = await h.createChild('root-1', {
          specialist: WORKER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
        });
        const asks: any[] = []; h.on('hook-event', (e) => { if (e.type === 'PermissionRequest') asks.push(e); });
        const askArrived = firstAsk(h);
        const sendPromise = childSession(h, childId).send('go');
        const requestId = await askArrived;
        h.respondPermission(requestId, { decision: { behavior: 'allow' }, updatedPermissions: [{ tool: 'Bash' }] });
        await sendPromise;
        expect(asks).toHaveLength(1);

        // Same child, same command again — must NOT re-ask: the in-memory
        // rememberedFor bucket (not just the fire-and-forget disk write) is what
        // guarantees this sticks for the rest of THIS run, exactly as the root
        // session's own "Always-allow sticks in-session" test proves.
        await childSession(h, childId).send('go again');
        await h.drain(childId);
        expect(asks).toHaveLength(1);
        await h.destroyAll();
      });

      it('never widens the ROOT session\'s own permissions', async () => {
        const WORKER = resolveSpecialist('worker')!;
        const store = new PermissionStore(new NativeHome(root));
        const h = new NativeSessionHost(
          new SessionStore(new NativeHome(root)), async () => rmOnce(), NO_CONTEXT, async () => null, async () => null, undefined,
          store, '9.9.9',
        );
        await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
        const { childId } = await h.createChild('root-1', {
          specialist: WORKER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
        });
        const askArrived = firstAsk(h);
        const sendPromise = childSession(h, childId).send('go');
        h.respondPermission(await askArrived, { decision: { behavior: 'allow' }, updatedPermissions: [{ tool: 'Bash' }] });
        await sendPromise;
        for (let i = 0; i < POLL_TRIES; i++) {
          if ((await store.rulesFor(root)).some((r) => r.specialist === 'worker')) break;
          await new Promise((r) => setTimeout(r, 10));
        }

        // The ROOT session itself attempts the EXACT same command — must still ask.
        const asks: any[] = []; h.on('hook-event', (e) => { if (e.type === 'PermissionRequest') asks.push(e); });
        const rootAsk = firstAsk(h);
        const rootSend = childSession(h, 'root-1').send('go');
        const rootRequestId = await rootAsk;
        h.respondPermission(rootRequestId, { decision: { behavior: 'deny' } });
        await rootSend;
        expect(asks.some((e) => e.type === 'PermissionRequest')).toBe(true);
        await h.destroyAll();
      });

      it('never leaks to a DIFFERENT specialist type (buildDecide scope filter, direct)', async () => {
        // Drives the actual filtering logic buildDecide applies, independent of
        // any one specialist's tool charter — the built-in roster has only ONE
        // read-write specialist (worker), so a full end-to-end run with a
        // second, differently-typed specialist attempting Bash isn't possible;
        // this is the mechanism the end-to-end tests above rely on, isolated.
        const store = {
          rulesFor: async () => [{ tool: 'Bash', pattern: 'rm -rf marker.txt', action: 'allow', specialist: 'worker' }],
          remember: async () => { /* no-op */ }, remove: async () => false, removeProject: async () => false,
        };
        const h = new NativeSessionHost(
          new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null, undefined, store,
        );
        await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

        const decideRoot = (h as any).buildDecide('root-1', root, []);
        expect((await decideRoot('Bash', 'rm -rf marker.txt')).action).toBe('ask');       // invisible to root

        const decideOtherSpecialist = (h as any).buildDecide('root-1', root, [], { specialistScope: 'reviewer' });
        expect((await decideOtherSpecialist('Bash', 'rm -rf marker.txt')).action).toBe('ask'); // invisible to a different agentType

        const decideSameSpecialist = (h as any).buildDecide('root-1', root, [], { specialistScope: 'worker' });
        expect((await decideSameSpecialist('Bash', 'rm -rf marker.txt')).action).toBe('allow'); // visible to the SAME agentType

        await h.destroyAll();
      });

      it('checklist 9b: an Always-allow remembered for Worker in a folder does not satisfy code-reviewer in the SAME folder — through memory AND through disk', async () => {
        // The 1c testing checklist's check 9b (the "security-relevant one"):
        // hire Worker in folder F, click Always allow, then hire a DIFFERENT
        // read-write helper in the same F — it must be asked again. The test
        // above drives the scope filter with a pre-keyed fake store; this one
        // pins the whole LOOKUP the way the app actually writes and reads it:
        // the real Always-allow write path (rememberRule, the exact call
        // native-session-host makes with `specialist: agentType`), a real
        // PermissionStore filed under F, and buildDecide reading back BOTH
        // sources it unions — the parent session's in-memory copy (what
        // answers for the rest of this run) and the disk record (what answers
        // after a restart, checked via a second host with no memory at all).
        const F = path.join(root, 'project-f');
        fs.mkdirSync(F, { recursive: true });
        const store = new PermissionStore(new NativeHome(root));
        // Review fix (2026-09-04, F4): the memory leg used to read the REAL
        // store too, and rememberRule kicks off the disk persist before the
        // first ask() — so the "memory" assertions could be satisfied by the
        // disk record alone. This host now writes through to disk (the disk
        // leg below still needs the real persist) but is BLIND to it on read:
        // rulesFor is always empty, so only the in-memory copy can answer.
        const memoryOnlyStore = {
          rulesFor: async () => [] as any[],
          remember: (cwd: string, rule: PermissionRule) => store.remember(cwd, rule),
          remove: async () => false,
          removeProject: async () => false,
        };
        const h = new NativeSessionHost(
          new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null, undefined, memoryOnlyStore,
        );
        await h.create({ sessionId: 'root-1', cwd: F, binding: { providerId: 'openrouter', modelId: 'm' } });

        // Exactly what an Always-allow on Worker's routed ask persists (:1620).
        const workerGrant: PermissionRule = { tool: 'Bash', pattern: 'rm -rf marker.txt', action: 'allow', match: 'exact', specialist: 'worker' };
        (h as any).rememberRule('root-1', F, workerGrant);

        const ask = async (host: NativeSessionHost, scope?: string) =>
          (await (host as any).buildDecide('root-1', F, [], scope ? { specialistScope: scope } : undefined)('Bash', 'rm -rf marker.txt')).action;

        // Memory path (this run): Worker is covered, code-reviewer and root are not.
        expect(await ask(h, 'worker')).toBe('allow');
        expect(await ask(h, 'code-reviewer')).toBe('ask');
        expect(await ask(h)).toBe('ask');

        // Disk path (next run): wait for the fire-and-forget persist, then read
        // it back through a host that holds NOTHING in memory for this session.
        for (let i = 0; i < 100 && !(await store.rulesFor(F)).some((r) => r.specialist === 'worker'); i++) {
          await new Promise((r) => setTimeout(r, 10));
        }
        expect((await store.rulesFor(F)).some((r) => r.specialist === 'worker')).toBe(true);
        const restarted = new NativeSessionHost(
          new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null, undefined, store,
        );
        expect(await ask(restarted, 'worker')).toBe('allow');
        expect(await ask(restarted, 'code-reviewer')).toBe('ask');
        expect(await ask(restarted)).toBe('ask');

        await h.destroyAll();
        await restarted.destroyAll();
      });
    });

    it("an external-directory Write is declined instantly, factually, by the wired ask router — not the config-error stub (mutation-proof pin for createChild's askUser wiring)", async () => {
      // Important review fix: the earlier max_steps pin exercised askUser only
      // through the removed child budget gate, which short-circuited identically
      // whether `askUser: childAskRouter(...)` is wired or deleted from createChild
      // — so that pin alone cannot catch the wiring being dropped. This drives a
      // DIFFERENT askUser call site: the external-directory forced ask
      // (harness-session.ts checkPathGuard 'external' verdict). The vehicle is a
      // WRITE, and must stay one: since 2026-09-05 a read outside the workspace
      // raises no ask at all (READ_ONLY_PATH_TOOLS), so a Read here would pin
      // nothing — it would pass with the router wired OR deleted. With
      // the router wired, it denies this instantly (never reaching the broker —
      // see child-ask-router.ts) with FACTUAL copy naming the real constraint —
      // Task 8 deliberately dropped the old "user declined" wording here since no
      // user was ever asked (error-message-standards.md: never blame a user for a
      // decision they never made). With askUser undefined, harness-session's own
      // guard answers first with the "No approval handler is wired... configuration
      // error" copy instead — the two are mutually exclusive, so asserting the
      // router's copy AND the absence of the config-error copy discriminates
      // router-wired from router-missing.
      const external = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-external-'));
      const outsideFile = path.join(external, 'planted.txt');
      const writeOutside = () => scriptedModel([
        stream(toolCallChunk('c1', 'Write', { file_path: outsideFile, content: 'x' }), finishChunk('tool-calls')),
        stream(...textChunks('t', 'done'), finishChunk('stop')),
      ]) as any;
      const { h } = await withParent(async () => writeOutside());
      const { childId } = await h.createChild('root-1', {
        // WORKER, not EXPLORER: the read-only charter does not attach Write at all,
        // so the call would die as an unknown tool before reaching the ask router.
        specialist: resolveSpecialist('worker')!, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      const asks: any[] = [];
      h.on('hook-event', (e) => asks.push(e));
      const events: any[] = [];
      childSession(h, childId).on('transcript-event', (e: any) => events.push(e));
      await childSession(h, childId).send('go');
      const res = events.find((e) => e.type === 'tool-result')!;
      expect(res.data.isError).toBe(true);
      expect(res.data.toolResult).toMatch(/work directory/i);
      expect(res.data.toolResult).not.toMatch(/user declined|dismissed/i); // no user was ever asked
      expect(res.data.toolResult).not.toMatch(/No approval handler is wired/i);
      expect(asks).toEqual([]); // never reached the broker/card at all — an instant, local deny
      fs.rmSync(external, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
      await h.destroyAll();
    });

    const writesOnce = (file: string) => async () => scriptedModel([
      stream(toolCallChunk('c1', 'Write', { file_path: file, content: 'x' }), finishChunk('tool-calls')),
      stream(...textChunks('t', 'done'), finishChunk('stop')),
    ]) as any;

    it('a tool the specialist does not have is refused by omission, naming what it DOES have', async () => {
      // Explorer is read-only and has no Write, so Write is never attached — the
      // driver's unknown-tool result answers first and the charter cap in
      // buildChildDecide is never consulted. That IS the contract: the outer
      // layer already names the available tools, so the model gets a next step
      // rather than retrying the same call.
      const { h } = await withParent(writesOnce('nope.txt'));
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      const events: any[] = [];
      childSession(h, childId).on('transcript-event', (e: any) => events.push(e));
      await childSession(h, childId).send('go');
      const res = events.find((e) => e.type === 'tool-result')!;
      expect(res.data.isError).toBe(true);
      expect(res.data.toolResult).toMatch(/Unknown tool Write/);
      expect(res.data.toolResult).toMatch(/Read, Glob, Grep/);
      expect(fs.existsSync(path.join(root, 'nope.txt'))).toBe(false);
      expect(events.some((e) => e.type === 'turn-complete')).toBe(true);   // refusal, not a crash
      await h.destroyAll();
    });

    it('the read-only charter still refuses a write tool a definition wrongly listed', async () => {
      // The second cap earns its keep here: a definition that lists Write under a
      // read-only charter DOES get the tool attached, so the tool filter can no
      // longer help — decide() is what stops it, with a reason that says why.
      // (The same layer is what would catch a dynamically-attached tool, since
      // Skill and MCP tools are attached inside HarnessSession, not from `tools`.)
      const MISDECLARED = { ...EXPLORER, allowedTools: [...EXPLORER.allowedTools, 'Write'] };
      const { h } = await withParent(writesOnce('charter.txt'));
      const { childId } = await h.createChild('root-1', {
        specialist: MISDECLARED, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      const events: any[] = [];
      childSession(h, childId).on('transcript-event', (e: any) => events.push(e));
      await childSession(h, childId).send('go');
      const res = events.find((e) => e.type === 'tool-result')!;
      expect(res.data.isError).toBe(true);
      expect(res.data.toolResult).toMatch(/read-only charter/i);
      expect(fs.existsSync(path.join(root, 'charter.txt'))).toBe(false);
      await h.destroyAll();
    });

    it("the child's permissions are keyed to the PARENT's project, not its work subdirectory", async () => {
      // buildDecide looks remembered "Always allow" rules up by cwd. A child
      // narrowed to a subdirectory must still read the rules the user granted
      // for the PROJECT — grants follow the project, not the subtree — so the
      // lookup has to use the parent's cwd even though the child runs in `sub`.
      const rulesFor = vi.fn(async () => []);
      const store = new SessionStore(new NativeHome(root));
      const globOnce = async () => scriptedModel([
        stream(toolCallChunk('c1', 'Glob', { pattern: '*.ts' }), finishChunk('tool-calls')),
        stream(...textChunks('t', 'done'), finishChunk('stop')),
      ]) as any;
      const h = new NativeSessionHost(store, globOnce, NO_CONTEXT, async () => null, async () => null, undefined,
        { rulesFor, remember: async () => { /* no-op */ } });
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const sub = path.join(root, 'sub-perms');
      fs.mkdirSync(sub, { recursive: true });
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: sub, parentToolCallId: 'tc-1',
      });
      rulesFor.mockClear();
      await childSession(h, childId).send('go');
      expect(rulesFor).toHaveBeenCalled();                                  // the child DID consult them
      expect(rulesFor.mock.calls.map((c) => c[0])).toEqual([root]);         // ...under the parent's cwd
      await h.destroyAll();
    });

    it('destroying the parent destroys its children and releases their model ref', async () => {
      const { h } = await withParent();
      const released: string[] = [];
      h.setModelReleasedHandler((id) => released.push(id));
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      expect(h.sessionsForModel('m').sort()).toEqual([childId, 'root-1'].sort());

      await h.destroy('root-1');
      expect(h.isNative(childId)).toBe(false);          // the child went with its parent
      expect(h.sessionsForModel('m')).toEqual([]);      // ...and gave back its model ref
      expect(released).toEqual(['m']);
      await h.destroyAll();
    });

    // ---- Task 6 review fix 1 (kept, retargeted at Task 7's real run loop):
    // spawnSpecialist's finally block once released only the writer lock,
    // leaving the child createChild() minted (live entry, disk header,
    // retainModel ref, childrenOf registration) alive forever on EVERY Task
    // call. Mirrors "destroying the parent destroys its children and releases
    // their model ref" above, but drives the teardown through spawnSpecialist
    // directly rather than through destroy(). The FAILED-run half of the same
    // guard lives in specialist-run.test.ts. --
    it('a completed spawnSpecialist run does not leak the minted child (leak guard)', async () => {
      const { store, h } = await withParent();
      const released: string[] = [];
      h.setModelReleasedHandler((id) => released.push(id));

      // The suite's default `factory` answers with one text step ("Hi there"),
      // which IS this child's report — a one-shot specialist that says its
      // piece and is torn down.
      const { childId, report } = await h.spawnSpecialist('root-1', {
        specialist: EXPLORER, prompt: 'find the config loader', workDir: root, parentToolCallId: 'tc-1',
        // Task 1 (plan 1b): spawnSpecialist now binds a caller-supplied
        // reservation rather than reserving one itself — this test drives the
        // run loop directly (below tools/task.ts), so it hands a plain reader
        // token rather than going through reserveSpecialist.
        token: { parentId: 'root-1', writer: false },
      });
      expect(report).toContain('Hi there');

      // The persisted record still names it as this parent's child.
      const childRow = store.list({ includeChildren: true }).find((r) => r.parentSessionId === 'root-1');
      expect(childRow?.sessionId).toBe(childId);

      // No live child entry survives the run — the leak guard's whole point.
      expect((h as any).live.has(childId)).toBe(false);
      expect(h.isNative(childId)).toBe(false);
      // De-registered from the parent's live children set too (destroy() does
      // this; a leaked child would still show up here).
      expect((h as any).childrenOf.get('root-1')?.has(childId)).toBeFalsy();
      // store.list() still carries the REAL persisted record (the child did
      // genuinely exist for a moment) but exactly once — no duplicate, no
      // dangling live-only phantom with no matching header.
      expect(store.list({ includeChildren: true }).filter((r) => r.sessionId === childId)).toHaveLength(1);

      // The child's model ref did NOT leak: destroying the parent (its only
      // remaining user of 'm') now fully releases the model. Before this fix,
      // the leaked child's retainModel() ref would keep 'm' referenced
      // forever even after the parent was gone — exactly "a local model could
      // never unload" from the review finding.
      await h.destroy('root-1');
      expect(released).toEqual(['m']);
      await h.destroyAll();
    });

    it('interrupting the parent interrupts its running children', async () => {
      const { h } = await withParent(delayedFactory);
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      const events: any[] = [];
      childSession(h, childId).on('transcript-event', (e: any) => events.push(e));
      const turn = childSession(h, childId).send('go');   // slow (delayedFactory) turn
      // Wait for the turn to be genuinely in flight instead of guessing 20ms —
      // the same substitution youcoded#363 made for the steer test in this file.
      // On a loaded machine 20ms was not enough and the assertion below failed as
      // though the interrupt/quiesce/steer logic were broken.
      await waitForTurnInFlight(h, childId);
      h.interrupt('root-1');
      await turn;                                         // settles — no hang
      expect(events.some((e) => e.type === 'user-interrupt')).toBe(true);
      expect(events.some((e) => e.type === 'turn-complete')).toBe(false);
      await h.destroyAll();
    });

    // Task 2 (plan 1b), Step 4: interrupt(parentId) — the Stop button — must
    // NOT cascade to a BACKGROUND child (deliberate 1b change from the test
    // above, which pins the FOREGROUND case). spawnSpecialist itself only
    // ever records background: false (Task 2's own scope is the foreground
    // flow; a real background-spawn path is a later task), so this test
    // reaches the private ledger directly to stamp a background: true record
    // — same pattern this suite already uses for other private state
    // ((host as any).live, .childrenOf, etc).
    it('interrupt(parentId) does NOT cascade to a BACKGROUND specialist child — it keeps working', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, delayedFactory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      await (h as any).ledger.recordStart(root, 'root-1', {
        childId, parentToolCallId: 'tc-1', agentType: EXPLORER.id, title: 'Bg the Explorer',
        workDir: root, description: EXPLORER.description, background: true,
        status: 'running', startedAt: Date.now(), delivered: false, owner: OWNER, missedSteers: [],
      });

      const events: any[] = [];
      childSession(h, childId).on('transcript-event', (e: any) => events.push(e));
      const turn = childSession(h, childId).send('go'); // slow (delayedFactory) turn

      // In flight for real, not 20ms of hope: if the turn had not started, the
      // interrupt below could not have reached it either way and the assertion
      // that it was NOT interrupted would pass for the wrong reason.
      await waitForTurnInFlight(h, childId);
      h.interrupt('root-1'); // Stop button — must NOT reach the background child

      // The child was never told to stop, and it's still live.
      expect(events.some((e) => e.type === 'user-interrupt')).toBe(false);
      expect((h as any).live.has(childId)).toBe(true);
      await turn; // let its turn settle naturally, undisturbed

      const rec = (h as any).ledger.listFor(root, 'root-1');
      expect(rec.find((r: any) => r.childId === childId)?.status).toBe('running');

      // Teardown is still stronger than interrupt — destroy takes it down
      // regardless of foreground/background (spec §1 cascade-cancel).
      await h.destroyAll();
      expect((h as any).live.has(childId)).toBe(false);
    });

    // Task 15 pin (1a handoff, asked for explicitly): quiesce() is the
    // takeover/teardown path (native-session-host.ts:3263) — deliberately
    // STRONGER than interrupt(), and 1b reworked both teardown paths (Task 2
    // made interrupt(parentId) skip background children on purpose — the
    // test above). This pins that quiesce was NOT weakened the same way: it
    // must still cascade-destroy every live specialist child (foreground or
    // background) and leave an honest 'interrupted' ledger record behind,
    // never a silently orphaned child or a ledger row still claiming 'running'.
    it('quiesce(parentId) destroys running children and their ledger records read interrupted', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, delayedFactory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      // Stamp the ledger row a real spawnSpecialist would have (createChild
      // alone doesn't) — same pattern the background-cascade test above uses.
      await (h as any).ledger.recordStart(root, 'root-1', {
        childId, parentToolCallId: 'tc-1', agentType: EXPLORER.id, title: 'Q the Explorer',
        workDir: root, description: EXPLORER.description, background: false,
        status: 'running', startedAt: Date.now(), delivered: false, owner: OWNER, missedSteers: [],
      });

      const turn = childSession(h, childId).send('go'); // slow (delayedFactory) turn, genuinely still running
      // Wait for the turn to be genuinely in flight instead of guessing 20ms —
      // the same substitution youcoded#363 made for the steer test in this file.
      // On a loaded machine 20ms was not enough and the assertion below failed as
      // though the interrupt/quiesce/steer logic were broken.
      await waitForTurnInFlight(h, childId);

      await h.quiesce('root-1'); // NOT interrupt() — the takeover/teardown path this pin guards
      await turn; // settles — quiesce's own cascade aborts it, never leaves it hanging

      // Destroyed, not merely interrupted-in-place: a running child must not
      // survive a whole-parent quiesce.
      expect((h as any).live.has(childId)).toBe(false);
      // The ledger write is fire-and-forget (destroyChildrenOf's own WHY —
      // a lock-contended write must never make teardown appear to hang), so
      // poll for it to land rather than assuming it's synchronous with quiesce.
      let rec: any;
      for (let i = 0; i < POLL_TRIES; i++) {
        rec = (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId);
        if (rec?.status === 'interrupted') break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(rec?.status).toBe('interrupted');

      await h.destroyAll();
    });

    // Fix (Critical 3, final review): destroyChildrenOf's own comment used to
    // claim "any child still in childrenOf is, by construction, still
    // 'running' in the ledger" — true for a FOREGROUND child (spawnSpecialist
    // de-registers it synchronously with its own completion write) but false
    // for a BACKGROUND one: runDelegation's completion write lands, and the
    // child is only removed from childrenOf a few microtasks later. A
    // whole-parent quiesce()/destroy() racing that exact gap fires its own
    // fire-and-forget `{status:'interrupted'}` write, which — before this fix
    // — would land AFTER the completion write and silently overwrite it.
    // Reproduced directly: the ledger record is set to 'completed' (as if
    // runDelegation's write already landed) while the child is STILL present
    // in childrenOf (as if its de-registration hasn't happened yet) — exactly
    // the race window. The outcome that matters: the report survives as
    // 'completed' and remains claimable, not merely that some field held
    // steady.
    it('quiesce() must not clobber a specialist whose ledger record already reads completed (regression — the teardown-after-completion race)', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      // The ledger already reflects a genuine, successful completion — as if
      // runDelegation's own completion write had already landed — while the
      // child is STILL in childrenOf (createChild alone never removes it),
      // reproducing the exact gap the finding describes.
      await (h as any).ledger.recordStart(root, 'root-1', {
        childId, parentToolCallId: 'tc-1', agentType: EXPLORER.id, title: 'Race the Explorer',
        workDir: root, description: EXPLORER.description, background: true,
        status: 'completed', startedAt: Date.now() - 1000, endedAt: Date.now(), steps: 2,
        rawReport: 'the real, already-finished report', delivered: false, owner: OWNER, missedSteers: [],
      });
      expect((h as any).childrenOf.get('root-1')?.has(childId)).toBe(true); // still in the set — the race window

      await h.quiesce('root-1');

      const rec = (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId);
      expect(rec?.status).toBe('completed');                              // NOT clobbered to 'interrupted'
      expect(rec?.rawReport).toBe('the real, already-finished report');
      // The outcome that matters: the report is still reachable through the
      // real delivery path, not stranded behind a status claimUndelivered
      // never looks at.
      const claimed = await (h as any).ledger.claimUndelivered(root, 'root-1');
      expect(claimed?.childId).toBe(childId);

      await h.destroyAll();
    });

    // Same race, the OTHER call site: an explicit task_id interrupt
    // (interruptSpecialist) instead of a whole-parent quiesce/destroy. Same
    // fix (updateUnlessCompleted), same outcome bar.
    it('an explicit task_id interrupt must not clobber a specialist whose ledger record already reads completed', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      await (h as any).ledger.recordStart(root, 'root-1', {
        childId, parentToolCallId: 'tc-1', agentType: EXPLORER.id, title: 'Race the Explorer',
        workDir: root, description: EXPLORER.description, background: true,
        status: 'completed', startedAt: Date.now() - 1000, endedAt: Date.now(), steps: 2,
        rawReport: 'the real, already-finished report', delivered: false, owner: OWNER, missedSteers: [],
      });

      const result = h.interruptSpecialist('root-1', childId);
      expect(result.status).toBe('ok'); // the interrupt call itself still succeeds — only the ledger write is guarded

      // The ledger write is fire-and-forget — poll for it, then assert it
      // never actually clobbered the completed row. (The comment said "poll"
      // and the code slept 30ms; a slow machine reached the assertion before
      // the guarded write had run at all, which passes for the wrong reason.)
      let rec: any;
      await vi.waitFor(() => {
        rec = (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId);
        expect(rec).toBeTruthy();
      });
      expect(rec?.status).toBe('completed');
      const claimed = await (h as any).ledger.claimUndelivered(root, 'root-1');
      expect(claimed?.childId).toBe(childId);

      await h.destroyAll();
    });
  });

  // Task 6 — the task_id management surface's two host-level invariants the
  // plan calls out explicitly: a specialist header can never re-enter through
  // the ROOT resume() path, and a steer that misses its window is never
  // silently lost. steerSpecialist/interruptSpecialist/resumeSpecialist's own
  // dispatch logic (refusal wording, reservation sizing) is exercised through
  // the Task tool instead — task-tool.test.ts — since that's the surface a
  // model actually calls; these two are host-internal invariants.
  describe('task_id management (Task 6)', () => {
    const EXPLORER = resolveSpecialist('explorer')!;

    it('resume() refuses a specialist header — children re-enter only through resumeSpecialist', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(store, factory, NO_CONTEXT, async () => null, async () => null);
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      // Tear the child down first so resume()'s own single-writer guard
      // (destroy-the-orphan-then-continue) isn't what this test is exercising
      // — the header's sessionKind check below is.
      await h.destroy(childId);
      const ok = await h.resume(childId, root);
      expect(ok).toBe(false);
      expect((h as any).live.has(childId)).toBe(false); // never re-entered as a root session
      await h.destroyAll();
    });

    it('a steer posted between child iterations lands in missedSteers and is prepended to the resumed brief', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const { childId, title } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      // Stamp the ledger row a real spawnSpecialist would have (createChild
      // alone doesn't — same pattern the background-cascade test above uses).
      await (h as any).ledger.recordStart(root, 'root-1', {
        childId, parentToolCallId: 'tc-1', agentType: EXPLORER.id, title, workDir: root,
        description: EXPLORER.description, background: false, status: 'running', startedAt: Date.now(),
        delivered: false, owner: OWNER, missedSteers: [],
      });

      // The child is live but has never been sent a turn — postSteer's own
      // in-flight check (this.abort !== null) is false, so this IS the
      // "between iterations" miss steerSpecialist is documented to record
      // rather than lose.
      const steerResult = h.steerSpecialist('root-1', childId, 'focus on auth.ts instead');
      expect(steerResult.status).toBe('ok');
      // The ledger write is fire-and-forget (steerSpecialist's own WHY —
      // never blocks the caller on disk I/O), so poll for it to land rather
      // than assuming it's synchronous.
      let recBefore: any;
      for (let i = 0; i < POLL_TRIES; i++) {
        recBefore = (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId);
        if (recBefore?.missedSteers?.length > 0) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(recBefore.missedSteers).toEqual(['focus on auth.ts instead']);

      // Tear the child down (without going through a normal completion —
      // this test only needs "not live, own ledger record", exactly
      // resumeSpecialist's own eligibility check) and resume it.
      await h.destroy(childId);
      const reservation = h.reserveSpecialist('root-1', { writer: false });
      if (!reservation.ok) throw new Error('unreachable — no capacity/writer conflict in this test');
      const result = await h.resumeSpecialist('root-1', {
        childId, prompt: 'continue the investigation', background: false,
        parentToolCallId: 'tc-2', reservation: reservation.token,
      });
      expect(result.status).toBe('ok');

      // The resumed child's first turn is the REAL proof: read its own
      // persisted transcript and confirm the missed steer was prepended,
      // not silently dropped.
      const events = store.readEvents(childId, root);
      const userMessages = events.filter((e: any) => e.type === 'user-message');
      const resumedMsg = userMessages[userMessages.length - 1] as any;
      expect(resumedMsg.data.text).toContain('<steer>\nfocus on auth.ts instead\n</steer>');
      expect(resumedMsg.data.text).toContain('continue the investigation');

      // And the ledger's missedSteers is cleared once folded in — a second
      // resume of the same child must not replay it again.
      const recAfter = (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId);
      expect(recAfter.missedSteers).toEqual([]);

      await h.destroyAll();
    });

    // External review, Important finding: steerSpecialist's miss-write used
    // to compute its patch (`[...record.missedSteers, text]`) from a ledger
    // snapshot read OUTSIDE the lock, then fire a fixed-array update(). If the
    // child's run completed in the same narrow window, runDelegation's own
    // completion write — its `missedSteers` drained from the CHILD's live
    // pendingSteers queue, a source the miss above never touched — could land
    // AFTER and silently overwrite the just-recorded steer with `[]`. This
    // test forces exactly that ordering (steer write observed landed FIRST,
    // then the completion write runs), which is the case the finding names:
    // "If the child's run completes in that narrow window, the completion
    // write's missedSteers: [] ... can land after and silently erase the
    // steer just recorded." A test that only fires both writes concurrently
    // via Promise.all would be flaky (real mkdir-lock scheduling decides the
    // winner); sequencing it explicitly is what makes this deterministic
    // while still reproducing the true bug (the completion write's patch is
    // computed independently of the ledger, so ordering — not concurrency
    // per se — is what causes the loss).
    it('a completion write landing after a recorded miss must not clobber it (regression — the clobber race)', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const { childId, title } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'find the config loader', workDir: root, parentToolCallId: 'tc-1',
      });
      await (h as any).ledger.recordStart(root, 'root-1', {
        childId, parentToolCallId: 'tc-1', agentType: EXPLORER.id, title, workDir: root,
        description: EXPLORER.description, background: false, status: 'running', startedAt: Date.now(),
        delivered: false, owner: OWNER, missedSteers: [],
      });

      // Miss the steer's window exactly like the sibling test above — the
      // child is live but has never taken a turn, so postSteer's in-flight
      // check is false and the miss is recorded to the ledger instead. Poll
      // for the fire-and-forget write to actually land before moving on, so
      // the ordering below is real, not assumed.
      const steerResult = h.steerSpecialist('root-1', childId, 'focus on auth.ts instead');
      expect(steerResult.status).toBe('ok');
      let recBefore: any;
      for (let i = 0; i < POLL_TRIES; i++) {
        recBefore = (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId);
        if (recBefore?.missedSteers?.length > 0) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(recBefore.missedSteers).toEqual(['focus on auth.ts instead']);

      // NOW run the child's delegation to completion directly through
      // runDelegation (the same private method spawnSpecialist/
      // resumeSpecialist call) — the "child's run completes in that narrow
      // window" half of the race. Its own `missedSteers` drains the child's
      // pendingSteers queue, which the miss above never touched (postSteer
      // returned false, so nothing was ever pushed to it) — so this is
      // genuinely a [] from an unrelated source landing after a real steer.
      const reservation = h.reserveSpecialist('root-1', { writer: false });
      if (!reservation.ok) throw new Error('unreachable — no capacity/writer conflict in this test');
      await (h as any).runDelegation('root-1', childId, title, {
        specialist: EXPLORER, prompt: 'find the config loader', workDir: root, parentToolCallId: 'tc-1',
        token: reservation.token, description: EXPLORER.description,
      }, reservation.token);

      const recAfter = (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId);
      expect(recAfter.status).toBe('completed');
      // The proof: the completion write (which landed second) must not have
      // erased the steer the miss-write (which landed first) recorded.
      expect(recAfter.missedSteers).toEqual(['focus on auth.ts instead']);

      await h.destroyAll();
    });

    // External review, Important finding (fix pass 2): the fix above closed
    // the clobber race by making the end-of-run ledger write into TWO
    // separate awaited calls — `update()`/`updateIfRunning()` for status,
    // then a SEPARATE `appendMissedSteers()` call. That is itself two
    // independent lock acquisitions: if the first (status) landed and the
    // second (steers) then threw, the record was durably 'completed' while
    // this run's own drained steers were silently dropped — log-only, never
    // retried. This test reproduces exactly that: it lets the FIRST
    // mutateJson call for this record's completion write succeed, then
    // forces the SECOND one to throw. Against the two-call shape this is the
    // real bug (status commits, steers vanish); against a genuinely single
    // atomic write there is no second call for this to ever hit, so the
    // whole write lands together or not at all.
    it('a completion write that fails partway must not durably commit status while silently dropping that run\'s own missed steers (regression — the split-write gap)', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const { childId, title } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'find the config loader', workDir: root, parentToolCallId: 'tc-1',
      });
      await (h as any).ledger.recordStart(root, 'root-1', {
        childId, parentToolCallId: 'tc-1', agentType: EXPLORER.id, title, workDir: root,
        description: EXPLORER.description, background: false, status: 'running', startedAt: Date.now(),
        delivered: false, owner: OWNER, missedSteers: [],
      });

      // Simulate a steer that got queued into the child's own LIVE
      // pendingSteers queue but never applied before the run ends — the
      // exact source runDelegation's completion write drains
      // (drainUnappliedSteers' own doc comment: "posted during a turn's
      // FINAL step, after the last iteration-boundary check already ran").
      // Stubbing drainUnappliedSteers() directly, rather than pushing into
      // the private pendingSteers queue before the run starts — pushing
      // early would let the turn loop's own iteration-boundary check drain
      // and genuinely APPLY it as a normal steer (harness-session.ts's own
      // per-iteration drain), leaving nothing "missed" for runDelegation to
      // find afterward. This test is about the LEDGER WRITE split, not
      // about racing the turn loop, so it isolates that half directly.
      const liveSession = (h as any).live.get(childId).session;
      vi.spyOn(liveSession, 'drainUnappliedSteers').mockReturnValue(['focus on auth.ts instead']);

      // Force the ledger's underlying NativeHome.mutateJson to fail on the
      // SECOND call that touches THIS record after this point — reproducing
      // the exact shape the split-write bug needs: one call for the status
      // patch, a separate one right after for the steer append. Scoped to
      // this record's own file so an unrelated write (e.g. a different
      // parent/child's ledger row) can't accidentally consume the count.
      const ledgerHome = (h as any).ledger.home as NativeHome;
      const originalMutateJson = ledgerHome.mutateJson.bind(ledgerHome);
      let call = 0;
      const spy = vi.spyOn(ledgerHome, 'mutateJson').mockImplementation(async (...args: any[]) => {
        const rel = args[0];
        if (typeof rel === 'string' && rel.includes('root-1.delegations.json')) {
          call++;
          if (call === 2) throw new Error('simulated ledger write failure');
        }
        return originalMutateJson(...(args as [any, any, any?]));
      });

      const reservation = h.reserveSpecialist('root-1', { writer: false });
      if (!reservation.ok) throw new Error('unreachable — no capacity/writer conflict in this test');
      await (h as any).runDelegation('root-1', childId, title, {
        specialist: EXPLORER, prompt: 'find the config loader', workDir: root, parentToolCallId: 'tc-1',
        token: reservation.token, description: EXPLORER.description,
      }, reservation.token);

      spy.mockRestore();

      // Final-review fix (Finding 5): without this, the `else` branch below
      // "passes" identically whether the completion write genuinely ran (and
      // rolled back cleanly) or never ran AT ALL — e.g. a regression that
      // skips the `if (this.ledger && parentCwd)` gate, or swallows a throw
      // before it ever reaches mutateJson. Both leave status 'running' and
      // missedSteers empty, so the old else branch blessed "the completion
      // write never happened" as an equally valid pass. Proving `call >= 1`
      // means mutateJson really was invoked for this record — the write was
      // attempted, whatever the outcome.
      expect(call).toBeGreaterThanOrEqual(1);

      const recAfter = (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId);
      // The forbidden state: status durably flipped to 'completed' while the
      // steer this run genuinely drained is nowhere on the record — the
      // exact inconsistent split a two-call write can produce and a
      // one-call write cannot (either both land, or the record stays
      // 'running' with nothing appended — log-only failure, same contract
      // this ledger has always had for a bookkeeping write that fails).
      if (recAfter.status === 'completed') {
        expect(recAfter.missedSteers).toContain('focus on auth.ts instead');
      } else {
        expect(recAfter.status).toBe('running');
        expect(recAfter.missedSteers).toEqual([]);
      }

      await h.destroyAll();
    });

    // External review, Important finding (fix pass 2) — the reviewer's other
    // ask: verify the resume-time CLEAR of missedSteers, which wasn't in the
    // reviewed diff. resumeSpecialist used to read `record.missedSteers`
    // from a snapshot taken well before wireChildLive() made the child live
    // again, then LATER fire a blind `missedSteers: []` clear — two
    // independent operations with an unlocked gap between them. A steer
    // landing in that gap is silently wiped, never delivered to the resumed
    // brief and never left on the ledger for a later resume either — genuine
    // loss, of a steer the user just gave.
    //
    // Deterministic sequencing (not a real Promise.all race, same reason the
    // clobber-race test above avoids one): this hooks the ONE ledger call
    // resumeSpecialist makes to read-clear-and-flip the record back to
    // 'running', and injects a genuinely-landed (fully awaited) concurrent
    // append immediately before letting that read-and-clear proceed.
    // "Concurrent" here means "landed in the real gap", not "maybe won a
    // race". Retargeted in fix pass 3: this used to hook
    // `DelegationLedger.prototype.update` (the status-flip write that used
    // to be separate from the take) — fix pass 3 folded that write INTO
    // takeMissedSteers, so the call carrying the 'running' patch is now
    // takeMissedSteers itself; hooking the old call site would leave
    // `injected` permanently false and the test would no longer exercise
    // anything.
    it('a steer appended concurrently with a resume-time clear is neither lost nor delivered twice (regression — the resume-clear race)', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const { childId, title } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      await (h as any).ledger.recordStart(root, 'root-1', {
        childId, parentToolCallId: 'tc-1', agentType: EXPLORER.id, title, workDir: root,
        description: EXPLORER.description, background: false, status: 'running', startedAt: Date.now(),
        delivered: false, owner: OWNER, missedSteers: [],
      });
      // Not live, own ledger record — resumeSpecialist's own eligibility bar
      // (same pattern the sibling tests in this describe block use).
      await h.destroy(childId);

      const originalTake = DelegationLedger.prototype.takeMissedSteers;
      let injected = false;
      const spy = vi.spyOn(DelegationLedger.prototype, 'takeMissedSteers').mockImplementation(
        async function (this: DelegationLedger, ...args: Parameters<DelegationLedger['takeMissedSteers']>) {
          const [pCwd, pId, cId, patch] = args;
          if (!injected && cId === childId && (patch as any)?.status === 'running') {
            injected = true;
            await this.appendMissedSteers(pCwd, pId, cId, ['a fresh steer landing mid-resume']);
          }
          return originalTake.apply(this, args);
        },
      );

      const reservation = h.reserveSpecialist('root-1', { writer: false });
      if (!reservation.ok) throw new Error('unreachable — no capacity/writer conflict in this test');
      const result = await h.resumeSpecialist('root-1', {
        childId, prompt: 'continue the investigation', background: false,
        parentToolCallId: 'tc-2', reservation: reservation.token,
      });
      expect(result.status).toBe('ok');
      spy.mockRestore();

      const events = store.readEvents(childId, root);
      const userMessages = events.filter((e: any) => e.type === 'user-message');
      const resumedMsg = userMessages[userMessages.length - 1] as any;
      const inPrompt = resumedMsg.data.text.includes('a fresh steer landing mid-resume') ? 1 : 0;

      const recAfter = (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId);
      const inLedger = (recAfter.missedSteers ?? []).filter((s: string) => s === 'a fresh steer landing mid-resume').length;

      // Exactly once — never 0 (lost) and never 2 (delivered to this
      // resume's brief AND left behind to be delivered again next time).
      expect(inPrompt + inLedger).toBe(1);

      await h.destroyAll();
    });

    // External review, Important finding (fix pass 3) — the split-write gap
    // survives in the resume path too. Fix pass 2 folded the read-and-clear
    // of missedSteers into ONE atomic takeMissedSteers() call, but the
    // status flip that used to follow it stayed a SEPARATE, later
    // `ledger.update()` — still two lock acquisitions. If the take landed
    // (steers cleared on disk) and that following write then threw, the
    // catch tore the freshly-wired child down and rethrew before it ever got
    // a turn: the resumed brief carrying those steers was never delivered,
    // and the steers were already wiped from the ledger by the take. Lost,
    // with no retry.
    //
    // Final-review fix (Finding 5): the previous version of this test made
    // `DelegationLedger.prototype.update`/`takeMissedSteers` THROW directly
    // for matching args, instead of exercising the real methods at all. That
    // proves nothing about takeMissedSteers' own atomicity — the mock
    // intercepts the call before any disk I/O runs, so "the steer survives"
    // held simply because NEITHER method ever got a chance to touch disk;
    // re-splitting takeMissedSteers back into two separate writes (patch,
    // then a second clear) would still pass, since the mock would keep
    // intercepting the whole method either way, before either write ran.
    //
    // Retargeted to the SAME technique the split-write-gap test above uses:
    // hook the ledger's underlying NativeHome.mutateJson (the ONE primitive
    // every ledger write bottoms out in) and fail the SECOND call this hook
    // sees against this record, exactly as that test does — not the first.
    // Failing the first call can't distinguish "one atomic write failed"
    // from "the first of two writes never even ran"; failing the SECOND is
    // what actually exercises the partial-commit shape a re-split would
    // introduce. By the time this hook is installed (right before resume),
    // recordStart and steerSpecialist's appendMissedSteers have already
    // landed via the real, unhooked mutateJson, so THIS hook's own call
    // count starts fresh at resume. Today takeMissedSteers makes exactly ONE
    // call for this record (call === 1) — but "call === 2" is NOT dead: this
    // resume is FOREGROUND (background: false below), so resumeSpecialist
    // itself awaits runDelegation to completion before returning, and
    // runDelegation's own completion write (`ledger.update(...status:
    // 'completed'...)`, native-session-host.ts) is the SECOND lock-guarded
    // write this hook sees against this record. That write IS the one being
    // sabotaged here, and it does throw — but runDelegation wraps it in its
    // own log-only try/catch (a bookkeeping failure must never fail the run
    // or discard the report), so the throw never reaches resumeSpecialist:
    // resumeError stays null and the record on disk is left exactly as
    // takeMissedSteers' own patch (call 1) wrote it — status 'running',
    // missedSteers cleared — because the completion write that would have
    // changed either never landed. That is why the dual-branch assertion
    // below lands in its ELSE branch today: the verdict ("resume completes
    // normally, steer folded in and cleared") is right, it just isn't
    // because takeMissedSteers' own write was never split — it's because a
    // DIFFERENT write got sabotaged and was swallowed where it stood. If
    // takeMissedSteers were ever re-split into two mutateJson calls, THIS
    // hook's "call === 2" would fire on the second HALF OF THAT WRITE instead
    // (shifting the already-sabotaged completion write to call 3, which this
    // hook lets through untouched) — forcing the exact partial-commit shape
    // (first write's half landed, second one didn't) the comment above
    // describes, which the assertion below rejects.
    it('a taken steer must not be lost when the resume\'s own status-flip write fails (regression — the resume split-write gap)', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const { childId, title } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      await (h as any).ledger.recordStart(root, 'root-1', {
        childId, parentToolCallId: 'tc-1', agentType: EXPLORER.id, title, workDir: root,
        description: EXPLORER.description, background: false, status: 'running', startedAt: Date.now(),
        delivered: false, owner: OWNER, missedSteers: [],
      });

      // Real ledger path, not the live pendingSteers queue — same reason the
      // sibling tests above stub drainUnappliedSteers directly instead of
      // pushing into the queue: the child hasn't taken a turn yet, so
      // postSteer's in-flight check is false and the miss is recorded via
      // steerSpecialist's own ledger write, exactly what a real between-
      // iterations steer would produce. Poll for it to land before moving on
      // so the ordering below is real, not assumed.
      const steerResult = h.steerSpecialist('root-1', childId, 'focus on auth.ts instead');
      expect(steerResult.status).toBe('ok');
      let recBefore: any;
      for (let i = 0; i < POLL_TRIES; i++) {
        recBefore = (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId);
        if (recBefore?.missedSteers?.length > 0) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(recBefore.missedSteers).toEqual(['focus on auth.ts instead']);

      await h.destroy(childId);
      const reservation = h.reserveSpecialist('root-1', { writer: false });
      if (!reservation.ok) throw new Error('unreachable — no capacity/writer conflict in this test');

      const ledgerHome = (h as any).ledger.home as NativeHome;
      const originalMutateJson = ledgerHome.mutateJson.bind(ledgerHome);
      let call = 0;
      const spy = vi.spyOn(ledgerHome, 'mutateJson').mockImplementation(async (...args: any[]) => {
        const rel = args[0];
        if (typeof rel === 'string' && rel.includes('root-1.delegations.json')) {
          call++;
          if (call === 2) throw new Error('simulated ledger write failure (resume status flip)');
        }
        return originalMutateJson(...(args as [any, any, any?]));
      });

      let resumeError: unknown = null;
      try {
        await h.resumeSpecialist('root-1', {
          childId, prompt: 'continue the investigation', background: false,
          parentToolCallId: 'tc-2', reservation: reservation.token,
        });
      } catch (err) {
        resumeError = err;
      }
      spy.mockRestore();

      const recAfter = (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId);
      // Same dual-branch shape as the split-write-gap test above, and for
      // the identical reason: today's atomic single-call takeMissedSteers
      // never reaches "call === 2" for this record, so the real write
      // succeeds and resume completes normally (steer folded into the
      // resumed brief and cleared from the ledger). The forbidden state — a
      // re-split write leaves the steer gone from the ledger WHILE the
      // resume itself also failed, meaning it was never delivered (no turn
      // ever read it) and never recoverable (wiped from the ledger too) — is
      // what the else branch rejects; a real two-call split hits exactly
      // that branch, and the injected failure at "call === 2" is what would
      // put it there.
      if (resumeError) {
        expect(recAfter.missedSteers).toEqual(['focus on auth.ts instead']);
        expect(recAfter.status).toBe('running');
      } else {
        expect(recAfter.missedSteers).toEqual([]);
        expect(recAfter.status).toBe('running'); // takeMissedSteers' own patch restores 'running'
      }

      await h.destroyAll();
    });

    // Fix (Critical 2, final review): resumeSpecialist's takeMissedSteers patch
    // reset status/startedAt/endedAt/failureText/delivered/background but left
    // injectionAttempted (and reportPath/rawReport/steps) at whatever RUN 1
    // left behind. Run 1 in the background delivers successfully — which
    // durably stamps injectionAttempted: true on this childId's ONE ledger
    // row (fix pass 5's marker; there is only ever one row per childId).
    // Resuming the SAME child for a second background run reused that row: if
    // the stale injectionAttempted survives the resume, claimUndelivered's
    // `!d.injectionAttempted` bar (delegation-ledger.ts) can never pass again
    // for this childId, so run 2's real report is claimed by nobody, forever
    // — not the ledger lane, not the in-memory fallback (which was never
    // stashed, since run 2's completion write succeeds), not reconcile, not a
    // restart. This drives BOTH runs through the real background chain
    // (spawnSpecialistBackground, then resumeSpecialist with background:true)
    // and asserts the OUTCOME: run 2's own report text actually reaches the
    // parent's conversation as a second injected notice, not that a field was
    // merely set.
    it('a SECOND background run after a resume still gets delivered, carrying its OWN report (regression — stale injectionAttempted)', async () => {
      const home = new NativeHome(root);
      const store = new SessionStore(home);
      // Call 1 is the child's run-1 turn; call 3 is the child's run-2 turn
      // (after resume); every other call (the parent's own turns, including
      // both injected-notice turns) gets the suite's default text-only model.
      let calls = 0;
      const seqFactory = async () => {
        calls += 1;
        if (calls === 1) return scriptedModel([stream(...textChunks('t', 'FIRST REPORT'), finishChunk('stop'))]) as any;
        if (calls === 3) return scriptedModel([stream(...textChunks('t', 'SECOND REPORT'), finishChunk('stop'))]) as any;
        return factory();
      };
      const h = new NativeSessionHost(
        store, seqFactory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, home,
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      const events: any[] = [];
      h.on('transcript-event', (e) => events.push(e));

      const reservation1 = h.reserveSpecialist('root-1', { writer: false });
      if (!reservation1.ok) throw new Error('unreachable — no capacity/writer conflict in this test');
      const { childId } = await h.spawnSpecialistBackground('root-1', {
        specialist: EXPLORER, prompt: 'find the config loader', workDir: root, parentToolCallId: 'tc-1',
        token: reservation1.token, description: EXPLORER.description,
      });

      // Run 1's report lands as the first injected notice — proves
      // injectionAttempted really did get stamped for this childId (fix pass
      // 5's marker), the precondition for the bug this test pins.
      await vi.waitFor(() => {
        expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(1);
      });
      expect(events.find((e) => e.data?.injected === 'specialist-report')!.data.text).toContain('FIRST REPORT');
      // `delivered` is flipped by a LATER, separate async disk write
      // (DelegationLedger.confirmDelivered -> a real mkdir-based file lock)
      // that the transcript event above is deliberately fired BEFORE, not
      // gated on. Poll for it instead of reading it once right after the
      // event resolves, or this races under machine load (see
      // ci-race-fix-report.md for the reproduction).
      await vi.waitFor(() => {
        const rec = (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId);
        expect(rec.delivered).toBe(true);
      });
      const recAfterRun1 = (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId);
      expect(recAfterRun1.injectionAttempted).toBe(true);

      // Resume the SAME child in the background — reuses the SAME ledger row.
      const reservation2 = h.reserveSpecialist('root-1', { writer: false });
      if (!reservation2.ok) throw new Error('unreachable — no capacity/writer conflict in this test');
      const resumeResult = await h.resumeSpecialist('root-1', {
        childId, prompt: 'now check the loader for edge cases', background: true,
        parentToolCallId: 'tc-2', reservation: reservation2.token,
      });
      expect(resumeResult.status).toBe('ok-background');

      // The outcome that matters: run 2's OWN report reaches the parent as a
      // SECOND injected notice — not silently stuck forever behind run 1's
      // stale injectionAttempted marker.
      await vi.waitFor(() => {
        expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(2);
      });
      const secondNotice = events.filter((e) => e.data?.injected === 'specialist-report')[1];
      expect(secondNotice.data.text).toContain('SECOND REPORT');
      // Also proves the (b) half of the finding: run 2's own report, not a
      // stale reportPath/rawReport copy of run 1's body.
      expect(secondNotice.data.text).not.toContain('FIRST REPORT');

      // See the same-shaped comment above run 1's check: `delivered` is an
      // async disk write, not synchronous with the transcript event.
      await vi.waitFor(() => {
        const rec = (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId);
        expect(rec.delivered).toBe(true);
      });
      const recAfterRun2 = (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId);
      expect(recAfterRun2.rawReport).toContain('SECOND REPORT');

      await h.destroyAll();
    });

    // Fix pass, Finding 2 (final review): `rg "Background specialist failed"
    // tests` returned NOTHING before this test — every existing status-block
    // test synthesizes a 'failed' ledger row directly via recordStart and
    // only asserts the status-line WORDING (see "specialist status block"
    // below), never driving a real child through death and confirming the
    // typed failure notice actually reaches the parent's conversation as an
    // injected turn. This drives the real chain end to end: a model factory
    // that throws on the child's own turn -> runDelegation's catch writes
    // 'failed' to the ledger -> runBackgroundDelegation's .finally calls
    // queueDelivery -> claimUndelivered (widened, per Important 4, to also
    // claim 'failed' records) -> formatDelivery's failed branch -> runNotice
    // injects "[Background specialist failed] ..." as a real parent turn.
    it('a background specialist that dies delivers a typed "[Background specialist failed]" notice to the parent', async () => {
      const home = new NativeHome(root);
      const store = new SessionStore(home);
      // Call 1 is the child's own first (and only) turn; every later call —
      // including the parent's turn that receives the injected failure
      // notice — gets the suite's default text-only model.
      let calls = 0;
      const seqFactory = async () => {
        calls += 1;
        if (calls === 1) throw new Error('scripted specialist crash');
        return factory();
      };
      const h = new NativeSessionHost(
        store, seqFactory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, home,
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      const events: any[] = [];
      h.on('transcript-event', (e) => events.push(e));

      const reservation = h.reserveSpecialist('root-1', { writer: false });
      if (!reservation.ok) throw new Error('unreachable — no capacity/writer conflict in this test');
      const { childId } = await h.spawnSpecialistBackground('root-1', {
        specialist: EXPLORER, prompt: 'find the config loader', workDir: root, parentToolCallId: 'tc-1',
        token: reservation.token, description: EXPLORER.description,
      });

      await vi.waitFor(() => {
        expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(1);
      });
      const notice = events.find((e) => e.data?.injected === 'specialist-report')!;
      expect(notice.data.text).toContain('[Background specialist failed]');
      expect(notice.data.text).toContain('scripted specialist crash');

      const rec = (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId);
      expect(rec.status).toBe('failed');
      // `delivered` is set by a later, separate async disk write
      // (confirmDelivered's mkdir-based file lock) that the transcript event
      // above is deliberately not gated on — poll instead of racing it.
      await vi.waitFor(() => {
        const recNow = (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId);
        expect(recNow.delivered).toBe(true);
      });

      await h.destroyAll();
    });

    // ---- D2 (2026-08-26, review Critical): a resume rebuilds the child from
    // the definition file AS IT IS NOW (buildSpecialistSession reads
    // specialist.allowedTools / charter / systemPrompt), while the consent the
    // user gave was for the file as it was at the hire. A task_id call carries
    // no work_dir, so it has no permission subject, so no consent card can
    // render for it — under auto-edit the pattern-less Task allow answers
    // first. Without the fingerprint check, editing a read-only helper to add
    // Bash and then resuming it ran write-capable with no consent at all.
    //
    // The comparison is deliberately narrow: only two fingerprints that are
    // BOTH present and DIFFERENT refuse. Either side absent means "no claim to
    // check" — built-ins have nothing on disk, and rows written before this
    // field existed have nothing recorded — and refusing those would make
    // every pre-existing hire unresumable. All four combinations are pinned. ----
    describe('resume refuses a definition file that changed since the hire (D2)', () => {
      let projectDir: string;
      beforeEach(() => { projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-resume-fp-')); });
      afterEach(() => { fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); });

      /** A real project-shipped helper file, so its fingerprint is the REAL
       *  content hash the loader stamps — never a hand-written string that
       *  could agree with a broken loader. */
      function writeHelperFile(): void {
        const dir = path.join(projectDir, '.claude', 'agents');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'doc-helper.md'),
          '---\nname: Doc Helper\ndescription: A project-defined helper.\ntools: [Read]\n---\nHelp with reading files.\n',
        );
      }

      async function boot(catalog: SpecialistCatalog) {
        const home = new NativeHome(projectDir);
        const h = new NativeSessionHost(
          new SessionStore(home), factory, NO_CONTEXT, async () => null, async () => null,
          undefined, undefined, undefined, undefined, undefined, undefined, home, undefined, catalog,
        );
        // create() awaits catalog.ensureFresh(cwd), so the roster below is
        // loaded by the time any test reads it.
        await h.create({ sessionId: 'root-1', cwd: projectDir, binding: { providerId: 'openrouter', modelId: 'm' } });
        return h;
      }

      /** Hire `specialist`, stamp its ledger row with `recordedFingerprint`,
       *  tear the child down (not live + own ledger row IS resumeSpecialist's
       *  whole eligibility bar), then try to resume it. */
      async function hireThenResume(h: NativeSessionHost, specialist: any, recordedFingerprint: string | undefined) {
        const { childId, title } = await h.createChild('root-1', {
          specialist, prompt: 'p', workDir: projectDir, parentToolCallId: 'tc-1',
        });
        await (h as any).ledger.recordStart(projectDir, 'root-1', {
          childId, parentToolCallId: 'tc-1', agentType: specialist.id, title, workDir: projectDir,
          description: specialist.description, background: false, status: 'running', startedAt: Date.now(),
          delivered: false, owner: OWNER, missedSteers: [], definitionFingerprint: recordedFingerprint,
        });
        await h.destroy(childId);
        const reservation = h.reserveSpecialist('root-1', { writer: false });
        if (!reservation.ok) throw new Error('unreachable — no capacity/writer conflict in this test');
        const result = await h.resumeSpecialist('root-1', {
          childId, prompt: 'continue the investigation', background: false,
          parentToolCallId: 'tc-2', reservation: reservation.token,
        });
        return { result, childId };
      }

      /** Did the resumed brief actually reach the child? The child's OWN
       *  transcript is the only honest answer — a status code alone would not
       *  prove the run never started. */
      function briefDelivered(h: NativeSessionHost, childId: string): boolean {
        return (h as any).store.readEvents(childId, projectDir)
          .some((e: any) => e.type === 'user-message' && String(e.data?.text ?? '').includes('continue the investigation'));
      }

      // The other half of the fix, and the one that makes the rest reachable at
      // all: the HIRE has to record which version of the file was consented to.
      // Without this write every record's fingerprint is absent, which the
      // comparison correctly reads as "no claim to check" — so no resume could
      // ever be refused, and the four cases below would all pass vacuously.
      it('the hire records WHICH version of the definition file was consented to', async () => {
        writeHelperFile();
        const catalog = new SpecialistCatalog({ claudeUserDir: null });
        const h = await boot(catalog);
        const helper = catalog.roster(projectDir).list().find((d) => d.fingerprint)!;
        const reservation = h.reserveSpecialist('root-1', { writer: false });
        if (!reservation.ok) throw new Error('unreachable — no capacity/writer conflict in this test');
        const { childId } = await h.spawnSpecialist('root-1', {
          specialist: helper, prompt: 'find the config loader', workDir: projectDir,
          parentToolCallId: 'tc-1', token: reservation.token, description: helper.description,
        });
        const rec = (h as any).ledger.listFor(projectDir, 'root-1').find((r: any) => r.childId === childId);
        expect(rec.definitionFingerprint).toBe(helper.fingerprint);
        await h.destroyAll();
      });

      it('refuses when the recorded fingerprint and the file\'s current one differ — and never resumes', async () => {
        writeHelperFile();
        const catalog = new SpecialistCatalog({ claudeUserDir: null });
        const h = await boot(catalog);
        const helper = catalog.roster(projectDir).list().find((d) => d.fingerprint)!;
        expect(helper.fingerprint).toBeTruthy();   // sanity: the file loader always stamps one

        const { result, childId } = await hireThenResume(h, helper, 'aaaaaaaaaaaa');
        expect(result).toEqual({ status: 'definition-changed', agentType: helper.id });
        expect((h as any).live.has(childId)).toBe(false);   // no session was rebuilt
        expect(briefDelivered(h, childId)).toBe(false);     // and the brief never ran
        await h.destroyAll();
      });

      it('a legacy row with no recorded fingerprint is NOT refused — every pre-existing hire stays resumable', async () => {
        writeHelperFile();
        const catalog = new SpecialistCatalog({ claudeUserDir: null });
        const h = await boot(catalog);
        const helper = catalog.roster(projectDir).list().find((d) => d.fingerprint)!;
        const { result, childId } = await hireThenResume(h, helper, undefined);
        expect(result.status).toBe('ok');
        expect(briefDelivered(h, childId)).toBe(true);
        await h.destroyAll();
      });

      it('a built-in (nothing on disk to change) is NOT refused, even against a recorded fingerprint', async () => {
        const catalog = new SpecialistCatalog({ claudeUserDir: null });
        const h = await boot(catalog);
        const builtin = catalog.roster(projectDir).resolve('explorer')!;
        expect(builtin.fingerprint).toBeUndefined();   // sanity: this is the "specialist side absent" case
        const { result, childId } = await hireThenResume(h, builtin, 'aaaaaaaaaaaa');
        expect(result.status).toBe('ok');
        expect(briefDelivered(h, childId)).toBe(true);
        await h.destroyAll();
      });

      it('an unchanged file resumes normally — the check costs nothing when nothing changed', async () => {
        writeHelperFile();
        const catalog = new SpecialistCatalog({ claudeUserDir: null });
        const h = await boot(catalog);
        const helper = catalog.roster(projectDir).list().find((d) => d.fingerprint)!;
        const { result, childId } = await hireThenResume(h, helper, helper.fingerprint);
        expect(result.status).toBe('ok');
        expect(briefDelivered(h, childId)).toBe(true);
        await h.destroyAll();
      });
    });
  });

  // Task 5 (plan 1c) — the ledger's own change listener (wired once at
  // construction, native-session-host.ts) turning every ledger write into a
  // 'specialists-event' the renderer will eventually consume (Task 10), plus
  // the user-facing note/stop surface (steerFromUser/interruptFromUser) and
  // the spawn-time model landing on the record. Deliberately does NOT
  // re-test steerSpecialist's own miss/deliver dispatch logic (task_id
  // management (Task 6) above already covers postSteer's in-flight branch) —
  // these tests are about the NOTE recording and the EVENT feed layered on
  // top of it.
  describe('user-facing steer/stop + specialists-event feed (Task 5, plan 1c)', () => {
    const EXPLORER = resolveSpecialist('explorer')!;

    function bootHostWithLedger(modelFactory: any = factory) {
      const home = new NativeHome(root);
      const store = new SessionStore(home);
      const h = new NativeSessionHost(
        store, modelFactory, NO_CONTEXT, async () => null, async () => null,
        undefined, undefined, undefined, undefined, undefined, undefined, home,
      );
      return { home, store, h };
    }
    const childSession = (h: NativeSessionHost, id: string) => (h as any).live.get(id).session;

    it('ledger changes surface as specialists-event {kind:run} with a SpecialistRunView (no delivery bookkeeping fields)', async () => {
      const { h } = bootHostWithLedger();
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      const events: any[] = [];
      h.on('specialists-event', (e) => events.push(e));

      const reservation = h.reserveSpecialist('root-1', { writer: false });
      if (!reservation.ok) throw new Error('unreachable — no capacity/writer conflict in this test');
      const { childId } = await h.spawnSpecialistBackground('root-1', {
        specialist: EXPLORER, prompt: 'find the config loader', workDir: root, parentToolCallId: 'tc-1',
        token: reservation.token, description: EXPLORER.description,
      });

      // recordDelegationStart is awaited inside spawnSpecialistBackground
      // before it returns, so the FIRST event is guaranteed to already be
      // sitting in `events` by the time we get here — no polling needed.
      expect(events.length).toBeGreaterThan(0);
      const first = events[0];
      expect(first.kind).toBe('run');
      expect(first.sessionId).toBe('root-1');
      expect(first.run.childId).toBe(childId);
      expect(first.run.status).toBe('running');
      expect(first.run.agentType).toBe(EXPLORER.id);
      // The run view is the RENDERER's shape — never the host's own delivery
      // bookkeeping (toRunView's own comment lists exactly this set).
      const bookkeepingFields = ['delivered', 'injectionAttempted', 'claimedBy', 'claimedAt', 'owner', 'missedSteers', 'rawReport', 'reportPath'];
      for (const f of bookkeepingFields) expect(first.run).not.toHaveProperty(f);

      await h.destroyAll();
    });

    it('steerSpecialist appends the note to the record for a LIVE delivery (one write) and for a PARKED steer (the same write as the parked steer) — the run event carries it either way', async () => {
      const { h } = bootHostWithLedger(delayedFactory);
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      // Child A: mid-turn (delayedFactory trickles chunks), so postSteer
      // delivers live and the note is a plain appendNote — ONE write.
      const { childId: liveChildId, title: liveTitle } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      await (h as any).ledger.recordStart(root, 'root-1', {
        childId: liveChildId, parentToolCallId: 'tc-1', agentType: EXPLORER.id, title: liveTitle,
        workDir: root, description: EXPLORER.description, background: false,
        status: 'running', startedAt: Date.now(), delivered: false, owner: OWNER, missedSteers: [],
      });
      const turn = childSession(h, liveChildId).send('go');
      await waitForTurnInFlight(h, liveChildId);

      const events: any[] = [];
      h.on('specialists-event', (e) => events.push(e));

      const liveResult = h.steerSpecialist('root-1', liveChildId, 'focus on auth.ts instead', 'user');
      expect(liveResult.status).toBe('ok');

      // The ledger write is fire-and-forget — poll for it to land. Wait for
      // the EVENT as well as the record: they come from the same mutateJson
      // call but reach us by different routes (a direct read vs. an emitter),
      // so polling only the record could exit while the event was still in
      // flight, and the "exactly one event" assertion below then read an empty
      // array. Green on Linux for months; ubuntu CI lost the race 2026-08-28.
      let liveRec: any;
      for (let i = 0; i < POLL_TRIES; i++) {
        liveRec = (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === liveChildId);
        if (liveRec?.notes?.length > 0 && events.some((e) => e.run.childId === liveChildId)) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(liveRec.notes).toEqual([{ text: 'focus on auth.ts instead', from: 'user', at: expect.any(Number) }]);
      expect(liveRec.missedSteers).toEqual([]); // delivered live, never parked
      // ONE ledger write for the live delivery → exactly one emitted event
      // for this child (proves appendNote, not a second write anywhere).
      expect(events.filter((e) => e.run.childId === liveChildId)).toHaveLength(1);
      expect(events.find((e) => e.run.childId === liveChildId)!.run.notes).toEqual([
        { text: 'focus on auth.ts instead', from: 'user', at: expect.any(Number) },
      ]);

      await turn; // let the delayed stream settle before moving on

      // Child B: never sent a turn, so postSteer misses and the steer parks.
      const { childId: parkedChildId, title: parkedTitle } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p2', workDir: root, parentToolCallId: 'tc-2',
      });
      await (h as any).ledger.recordStart(root, 'root-1', {
        childId: parkedChildId, parentToolCallId: 'tc-2', agentType: EXPLORER.id, title: parkedTitle,
        workDir: root, description: EXPLORER.description, background: false,
        status: 'running', startedAt: Date.now(), delivered: false, owner: OWNER, missedSteers: [],
      });
      events.length = 0;

      const parkedResult = h.steerSpecialist('root-1', parkedChildId, 'check config.ts instead', 'assistant');
      expect(parkedResult.status).toBe('ok');

      // Same two-signal wait as the live case above — record AND event.
      let parkedRec: any;
      for (let i = 0; i < POLL_TRIES; i++) {
        parkedRec = (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === parkedChildId);
        if (parkedRec?.missedSteers?.length > 0 && events.some((e) => e.run.childId === parkedChildId)) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(parkedRec.missedSteers).toEqual(['check config.ts instead']);
      expect(parkedRec.notes).toEqual([{ text: 'check config.ts instead', from: 'assistant', at: expect.any(Number) }]);
      // The parked steer and its note commit in the SAME mutateJson call
      // (appendMissedSteers' `note` param) — never two independent writes —
      // so this child gets exactly ONE event, carrying the note already.
      const parkedEvents = events.filter((e) => e.run.childId === parkedChildId);
      expect(parkedEvents).toHaveLength(1);
      expect(parkedEvents[0].run.notes).toEqual([{ text: 'check config.ts instead', from: 'assistant', at: expect.any(Number) }]);

      await h.destroyAll();
    });

    it('steerFromUser: empty → error, 2001 chars → error naming the limit and the length, foreign childId → error, ok → {ok:true}', async () => {
      const { h } = bootHostWithLedger();
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      await (h as any).ledger.recordStart(root, 'root-1', {
        childId, parentToolCallId: 'tc-1', agentType: EXPLORER.id, title: 'The Explorer',
        workDir: root, description: EXPLORER.description, background: false,
        status: 'running', startedAt: Date.now(), delivered: false, owner: OWNER, missedSteers: [],
      });

      expect(h.steerFromUser('root-1', childId, '   ')).toEqual({ ok: false, error: 'The note is empty.' });

      const tooLong = 'a'.repeat(2001);
      expect(h.steerFromUser('root-1', childId, tooLong)).toEqual({
        ok: false,
        error: 'Notes are limited to 2,000 characters — this one is 2,001.',
      });

      expect(h.steerFromUser('root-1', 'not-a-real-child', 'hello')).toEqual({
        ok: false, error: 'That helper isn’t part of this conversation.',
      });

      expect(h.steerFromUser('root-1', childId, 'a real note')).toEqual({ ok: true });

      await h.destroyAll();
    });

    // Review finding fix (plan 1c, Task 5): SPECIALIST_NOTE_MAX_CHARS was only
    // enforced in steerFromUser (the human's send-a-note box). The model's own
    // task_id steer reaches steerSpecialist directly with no cap at all, and
    // every accepted steer is now a PERMANENT ledger entry (read-modify-write
    // WHOLE on every access) — so an unbounded model-written note grows that
    // file without limit, the same cost class RAW_REPORT_CAP_CHARS already
    // guards against on the report side. The cap now lives INSIDE
    // steerSpecialist so it holds no matter which path reaches it.
    it('an over-cap ASSISTANT steer is delivered to the helper in full, but the note recorded on the ledger is clamped and says so', async () => {
      const { h } = bootHostWithLedger(delayedFactory);
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      // Mid-turn child (delayedFactory trickles chunks) so postSteer delivers
      // live — proves the DELIVERY path never sees the clamp.
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      await (h as any).ledger.recordStart(root, 'root-1', {
        childId, parentToolCallId: 'tc-1', agentType: EXPLORER.id, title: 'The Explorer',
        workDir: root, description: EXPLORER.description, background: false,
        status: 'running', startedAt: Date.now(), delivered: false, owner: OWNER, missedSteers: [],
      });
      const session = childSession(h, childId);
      const postSteerSpy = vi.spyOn(session, 'postSteer');
      const turn = session.send('go');
      // Wait for the turn to be genuinely in flight instead of guessing 20ms —
      // the same substitution youcoded#363 made for the steer test in this file.
      // On a loaded machine 20ms was not enough and the assertion below failed as
      // though the interrupt/quiesce/steer logic were broken.
      await waitForTurnInFlight(h, childId);

      const longText = 'x'.repeat(SPECIALIST_NOTE_MAX_CHARS + 500);
      const result = h.steerSpecialist('root-1', childId, longText, 'assistant');
      expect(result.status).toBe('ok');

      // Delivery is untouched: postSteer received the FULL, unclamped text.
      expect(postSteerSpy).toHaveBeenCalledWith(longText);
      expect(postSteerSpy.mock.calls[0][0]).toHaveLength(longText.length);

      // The RECORDED note is clamped and visibly marked as cut, not silently
      // truncated (the chat card renders note.text verbatim).
      let rec: any;
      for (let i = 0; i < POLL_TRIES; i++) {
        rec = (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId);
        if (rec?.notes?.length > 0) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(rec.notes).toHaveLength(1);
      const recordedText: string = rec.notes[0].text;
      expect(recordedText.length).toBeLessThanOrEqual(SPECIALIST_NOTE_MAX_CHARS);
      expect(recordedText).not.toBe(longText);
      expect(recordedText.startsWith('x'.repeat(100))).toBe(true); // real content survives, just cut
      expect(recordedText.toLowerCase()).toMatch(/cut|long|short|trim/); // visibly marked, not an invisible cut
      expect(recordedText.toLowerCase()).not.toContain('subagent');
      expect(recordedText.toLowerCase()).not.toContain('spawn');

      // missedSteers is untouched by the clamp too — never parked here since
      // this was a live delivery, but nothing here should have populated it.
      expect(rec.missedSteers).toEqual([]);

      await turn;
      await h.destroyAll();
    });

    it('an under-cap ASSISTANT steer is recorded byte-for-byte unchanged', async () => {
      const { h } = bootHostWithLedger(delayedFactory);
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      await (h as any).ledger.recordStart(root, 'root-1', {
        childId, parentToolCallId: 'tc-1', agentType: EXPLORER.id, title: 'The Explorer',
        workDir: root, description: EXPLORER.description, background: false,
        status: 'running', startedAt: Date.now(), delivered: false, owner: OWNER, missedSteers: [],
      });
      const turn = childSession(h, childId).send('go');
      // Wait for the turn to be genuinely in flight instead of guessing 20ms —
      // the same substitution youcoded#363 made for the steer test in this file.
      // On a loaded machine 20ms was not enough and the assertion below failed as
      // though the interrupt/quiesce/steer logic were broken.
      await waitForTurnInFlight(h, childId);

      const shortText = 'focus on auth.ts instead';
      const result = h.steerSpecialist('root-1', childId, shortText, 'assistant');
      expect(result.status).toBe('ok');

      let rec: any;
      for (let i = 0; i < POLL_TRIES; i++) {
        rec = (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId);
        if (rec?.notes?.length > 0) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(rec.notes).toEqual([{ text: shortText, from: 'assistant', at: expect.any(Number) }]);

      await turn;
      await h.destroyAll();
    });

    it('steerFromUser still REJECTS an over-cap note rather than clamping it — the assistant-path clamp does not leak into the user-facing surface', async () => {
      const { h } = bootHostWithLedger();
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      await (h as any).ledger.recordStart(root, 'root-1', {
        childId, parentToolCallId: 'tc-1', agentType: EXPLORER.id, title: 'The Explorer',
        workDir: root, description: EXPLORER.description, background: false,
        status: 'running', startedAt: Date.now(), delivered: false, owner: OWNER, missedSteers: [],
      });

      const tooLong = 'a'.repeat(SPECIALIST_NOTE_MAX_CHARS + 1);
      const result = h.steerFromUser('root-1', childId, tooLong);
      expect(result).toEqual({
        ok: false,
        error: `Notes are limited to ${SPECIALIST_NOTE_MAX_CHARS.toLocaleString()} characters — this one is ${(SPECIALIST_NOTE_MAX_CHARS + 1).toLocaleString()}.`,
      });

      // Rejected before it ever reached steerSpecialist — no note recorded at all.
      const rec = (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId);
      expect(rec.notes ?? []).toEqual([]);

      await h.destroyAll();
    });

    it('interruptFromUser mirrors the outcome mapping', async () => {
      const { h } = bootHostWithLedger();
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      await (h as any).ledger.recordStart(root, 'root-1', {
        childId, parentToolCallId: 'tc-1', agentType: EXPLORER.id, title: 'The Explorer',
        workDir: root, description: EXPLORER.description, background: false,
        status: 'running', startedAt: Date.now(), delivered: false, owner: OWNER, missedSteers: [],
      });

      expect(h.interruptFromUser('root-1', 'not-a-real-child')).toEqual({
        ok: false, error: 'That helper isn’t part of this conversation.',
      });

      expect(h.interruptFromUser('root-1', childId)).toEqual({ ok: true });

      // Already finished — destroy() drops it from childrenOf, but the
      // ledger's own (own child, not live) record is still there.
      await h.destroy(childId);
      expect(h.interruptFromUser('root-1', childId)).toEqual({
        ok: false, error: 'This helper has already finished.',
      });

      await h.destroyAll();
    });

    it('the spawn-time model lands on the record and in the run view', async () => {
      const { h } = bootHostWithLedger();
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      const events: any[] = [];
      h.on('specialists-event', (e) => events.push(e));

      const reservation = h.reserveSpecialist('root-1', { writer: false });
      if (!reservation.ok) throw new Error('unreachable — no capacity/writer conflict in this test');
      const { childId } = await h.spawnSpecialistBackground('root-1', {
        specialist: EXPLORER, prompt: 'find the config loader', workDir: root, parentToolCallId: 'tc-1',
        token: reservation.token, description: EXPLORER.description,
        model: { label: 'anthropic/claude-opus-5', via: 'named', fallback: false },
      });

      const rec = (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId);
      expect(rec.model).toEqual({ label: 'anthropic/claude-opus-5', via: 'named', fallback: false });

      const runEvent = events.find((e) => e.run.childId === childId);
      expect(runEvent.run.model).toEqual({ label: 'anthropic/claude-opus-5', via: 'named', fallback: false });

      await h.destroyAll();
    });
  });

  // Fix (Important 5, final review): the internalReadRoots exemption used to
  // cover the ENTIRE sessions/<slug>/ directory — every conversation's own
  // transcript .jsonl AND the delegation ledger sidecars, not just the
  // specialist-report spill files it exists for. Narrowed to a dedicated
  // sessions/<slug>/specialist-reports/ subdirectory both writeSessionArtifact
  // writes into and toolWiring exempts.
  //
  // These cases assert checkPathGuard's VERDICT, which 2026-09-05 did not
  // change. What changed is the price of an 'external' verdict: for Read/Grep/
  // Glob it is now zero (READ_ONLY_PATH_TOOLS in harness-session.ts), so the
  // scoping below no longer keeps another conversation's transcript unreadable
  // — it keeps the exemption honest, and keeps a write-shaped tool fenced.
  describe('specialist report spill scoping (Important 5, final review)', () => {
    it('the wired internalReadRoots is the specialist-reports subdirectory, not the whole per-project sessions dir', async () => {
      const home = new NativeHome(root);
      const store = new SessionStore(home);
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, home,
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      const session = (h as any).live.get('root-1').session;
      const roots: string[] = session.opts.internalReadRoots;
      expect(roots).toHaveLength(1);
      const slug = nativeStoreSlug(root);
      expect(roots[0]).toBe(path.join(home.root, 'sessions', slug, 'specialist-reports'));
      // Not the bare per-project sessions directory — that's the shape being fixed.
      expect(roots[0]).not.toBe(path.join(home.root, 'sessions', slug));

      await h.destroyAll();
    });

    it('a real oversized-report spill lands under specialist-reports/, so this OWN session can still read it without an ask', async () => {
      const home = new NativeHome(root);
      const store = new SessionStore(home);
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, home,
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      const { RAW_REPORT_CAP_CHARS } = await import('../src/main/harness/specialists/delegation-ledger');
      const huge = 'x'.repeat(RAW_REPORT_CAP_CHARS + 5_000);
      const spillPath = home.writeSessionArtifact(nativeStoreSlug(root), path.join('specialist-reports', 'child-x.report.md'), huge);
      expect(spillPath).toContain(`${path.sep}specialist-reports${path.sep}`);

      const { checkPathGuard } = await import('../src/main/harness/tools/guards');
      const session = (h as any).live.get('root-1').session;
      const verdict = checkPathGuard(spillPath, root, session.opts.internalReadRoots);
      expect(verdict.kind).toBe('ok'); // no external_directory ask for this session's own spill

      await h.destroyAll();
    });

    it('a SIBLING file in the same per-project sessions directory (another conversation transcript, or the ledger sidecar) is NOT covered by the exemption', async () => {
      // A SEPARATE home dir from the project cwd — matching production
      // reality, where ~/.youcoded is never nested inside a project
      // directory. (The other two tests above reuse `root` for both, purely
      // for convenience; here the distinction is the whole point — a sibling
      // path only proves anything about the EXEMPTION, not about "is it under
      // cwd anyway", if it genuinely sits outside the project cwd.)
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-home-'));
      const home = new NativeHome(homeDir);
      const store = new SessionStore(home);
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, home,
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      const slug = nativeStoreSlug(root);
      // A DIFFERENT conversation's own transcript, living in the SAME
      // per-project sessions/<slug>/ directory the old (too-wide) exemption
      // covered — this must still come back 'external', i.e. outside the jail
      // and never silently exempt. (A Read of it no longer costs a card; a
      // write-shaped tool still does. See the describe comment above.)
      const otherTranscript = path.join(home.root, 'sessions', slug, 'some-other-session-id.jsonl');
      const { checkPathGuard } = await import('../src/main/harness/tools/guards');
      const session = (h as any).live.get('root-1').session;
      const verdict = checkPathGuard(otherTranscript, root, session.opts.internalReadRoots);
      expect(verdict.kind).toBe('external');

      fs.rmSync(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });

      await h.destroyAll();
    });
  });

  // Task 5 (plan 1b): the per-turn specialist status block. wire() attaches
  // opts.specialistStatus to every ROOT session; this suite pins what that
  // callback reports given a stamped ledger, reaching the private ledger
  // directly (same pattern the Task 2 tests above use) rather than driving a
  // real specialist run end-to-end.
  describe('specialist status block (Task 5, plan 1b)', () => {
    it('the host status block lists running and undelivered-finished specialists and omits delivered ones', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      await (h as any).ledger.recordStart(root, 'root-1', {
        childId: 'child-running', parentToolCallId: 'tc-1', agentType: 'explorer', title: 'Nadia',
        workDir: root, description: 'd', background: true,
        status: 'running', startedAt: Date.now(), delivered: false, owner: OWNER, missedSteers: [],
      });
      await (h as any).ledger.recordStart(root, 'root-1', {
        childId: 'child-finished', parentToolCallId: 'tc-2', agentType: 'researcher', title: 'Otis',
        workDir: root, description: 'd', background: true,
        status: 'completed', startedAt: Date.now(), endedAt: Date.now(), delivered: false, owner: OWNER, missedSteers: [],
      });
      await (h as any).ledger.recordStart(root, 'root-1', {
        childId: 'child-delivered', parentToolCallId: 'tc-3', agentType: 'writer', title: 'Priya',
        workDir: root, description: 'd', background: true,
        status: 'completed', startedAt: Date.now(), endedAt: Date.now(), delivered: true, owner: OWNER, missedSteers: [],
      });

      const rootSession = (h as any).live.get('root-1').session;
      const status: string | null = rootSession.opts.specialistStatus?.();

      expect(status).toBeTruthy();
      expect(status).toContain('Nadia');
      expect(status).toContain('running');
      expect(status).toContain('Otis');
      expect(status).toContain('report delivery pending');
      // Delivered specialist never appears.
      expect(status).not.toContain('Priya');

      await h.destroyAll();
    });

    it('returns null (and wires nothing to inject) when the session has no delegations at all', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      const rootSession = (h as any).live.get('root-1').session;
      expect(rootSession.opts.specialistStatus?.()).toBeNull();

      await h.destroyAll();
    });

    // Fix pass, Finding 1: DelegationRecord.steps is only ever written AT
    // COMPLETION (spawnSpecialist's success-path patch) — recordStart never
    // sets it, so a RUNNING record's `steps` is always undefined. The old
    // `r.steps ?? 0` rendered a permanently-wrong "step 0" for the entire
    // life of every running child. Pin that the running line never claims a
    // step count it doesn't have.
    it('a running specialist with no live step count omits the step clause instead of claiming "step 0"', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      await (h as any).ledger.recordStart(root, 'root-1', {
        childId: 'child-running', parentToolCallId: 'tc-1', agentType: 'explorer', title: 'Nadia',
        workDir: root, description: 'd', background: true,
        status: 'running', startedAt: Date.now(), delivered: false, owner: OWNER, missedSteers: [],
      });

      const rootSession = (h as any).live.get('root-1').session;
      const status: string | null = rootSession.opts.specialistStatus?.();

      expect(status).toBeTruthy();
      expect(status).not.toContain('step 0');
      expect(status).not.toMatch(/step \d/);

      await h.destroyAll();
    });

    // Fix pass, Finding 2: `stale` only ever means "at least SPECIALIST_IDLE_
    // STALE_MS has elapsed" (setStale in this file never fires sooner) — the
    // real elapsed time can be far larger (e.g. the 5m in-tool threshold, or
    // just more wall-clock time). The old wording ("no activity for 2m") read
    // as an exact measurement. Pin that the floor is now stated as a floor.
    it('a stale running specialist reports the idle threshold as an "at least" floor, not a measurement', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      await (h as any).ledger.recordStart(root, 'root-1', {
        childId: 'child-stale', parentToolCallId: 'tc-1', agentType: 'explorer', title: 'Nadia',
        workDir: root, description: 'd', background: true,
        status: 'running', startedAt: Date.now(), delivered: false, owner: OWNER, missedSteers: [], stale: true,
      });

      const rootSession = (h as any).live.get('root-1').session;
      const status: string | null = rootSession.opts.specialistStatus?.();

      expect(status).toContain('no activity for at least 2m');

      await h.destroyAll();
    });

    // Fix pass, Finding 3 (original): 'interrupted' records never get
    // delivered (a parent teardown killed the child — nothing is left to
    // claim them), so they keep their own honest "no report will arrive"
    // line, distinct from the running-record's "finished — report delivery
    // pending" wording.
    //
    // Final-review fix (Finding 1): 'failed' is NOT like 'interrupted' — the
    // ledger's own claimUndelivered() eligibility was later widened
    // (Important 4) to claim 'completed' OR 'failed' records, so a background
    // child's death DOES eventually deliver a typed
    // "[Background specialist failed] ..." notice (see the end-to-end test
    // above). "no report will arrive" for 'failed' was therefore a stale
    // claim once that widening landed. 'failed' now gets the SAME "delivery
    // pending" framing as 'completed', naming the real failureText inline
    // (never a guessed cause — error-message-standards.md); only
    // 'interrupted' keeps "no report will arrive".
    it('failed specialists get an honest "delivery pending" line (they DO get claimed); interrupted specialists still say no report will arrive', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      await (h as any).ledger.recordStart(root, 'root-1', {
        childId: 'child-failed', parentToolCallId: 'tc-1', agentType: 'debugger', title: 'Fiona',
        workDir: root, description: 'd', background: true,
        status: 'failed', startedAt: Date.now(), endedAt: Date.now(), delivered: false, owner: OWNER,
        missedSteers: [], failureText: 'ENOENT: no such file or directory',
      });
      await (h as any).ledger.recordStart(root, 'root-1', {
        childId: 'child-interrupted', parentToolCallId: 'tc-2', agentType: 'writer', title: 'Greg',
        workDir: root, description: 'd', background: true,
        status: 'interrupted', startedAt: Date.now(), endedAt: Date.now(), delivered: false, owner: OWNER,
        missedSteers: [],
      });

      const rootSession = (h as any).live.get('root-1').session;
      const status: string | null = rootSession.opts.specialistStatus?.();
      const lines = (status ?? '').split('\n');

      const failedLine = lines.find((l) => l.startsWith('Fiona'));
      expect(failedLine).toBe('Fiona (debugger): failed — ENOENT: no such file or directory — report delivery pending');
      expect(failedLine).not.toContain('no report will arrive');

      const interruptedLine = lines.find((l) => l.startsWith('Greg'));
      expect(interruptedLine).toBe('Greg (writer): interrupted — no report will arrive');
      expect(interruptedLine).not.toContain('delivery pending');

      await h.destroyAll();
    });
  });

  // Fix pass, Finding 1: toolWiring() used to hardcode `catalog: async () =>
  // null` unconditionally, so ModelSearch and a per-hire specific-model-id
  // override could NEVER see a real catalog even when one was available —
  // every specific id was refused regardless of whether it existed. This
  // proves the fix: when the constructor's `toolServices` param carries a
  // `modelCatalog` closure (exactly how ipc-handlers.ts wires it — see its
  // own construction site), the session's assembled services.models.catalog()
  // resolves to REAL rows, and ModelSearch reports actual matches instead of
  // the "catalog not loaded" fallback.
  describe('a real catalog reaches services.models.catalog() (Task 14 fix pass, Finding 1)', () => {
    const CATALOG: CatalogModel[] = [
      { id: 'anthropic/claude-opus-5', providerId: 'openrouter', label: 'Claude Opus 5', pricing: { in: 15, out: 75 }, contextLength: 200_000 },
    ];

    it('services.models.catalog() resolves to the injected modelCatalog closure\'s rows, not null', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined,
        { modelCatalog: async () => CATALOG },
        undefined, undefined,
        new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const session = (h as any).live.get('root-1').session;
      const catalog = await session.opts.toolServices.models.catalog();
      expect(catalog).toEqual(CATALOG);
      await h.destroyAll();
    });

    it('ModelSearch, run through the real wiring, returns actual matches instead of the "catalog not loaded" refusal', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined,
        { modelCatalog: async () => CATALOG },
        undefined, undefined,
        new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const session = (h as any).live.get('root-1').session;
      const ctx = {
        sessionId: 'root-1', cwd: root, signal: new AbortController().signal,
        readRegistry: new Map(), todos: [] as any[], services: session.opts.toolServices,
      };
      const result = await ModelSearchTool.execute({ query: 'claude' } as any, ctx as any);
      expect(result.isError).toBeUndefined();
      expect(result.text).toContain('anthropic/claude-opus-5');
      expect(result.text).not.toContain('Model list is unavailable right now (catalog not loaded)');
      await h.destroyAll();
    });

    it('without a modelCatalog closure, the catalog stays null (unchanged pre-fix-pass default — no behavior change)', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined,
        new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const session = (h as any).live.get('root-1').session;
      const catalog = await session.opts.toolServices.models.catalog();
      expect(catalog).toBeNull();
      await h.destroyAll();
    });
  });

  // Task 8 (plan 1c) — Settings' two model-tier rows, via the SAME
  // toolServices.modelCatalog wiring the describe block just above proved
  // reaches the session. setDelegatedModel must refuse (and never write) a
  // binding the live catalog doesn't recognize — a stale/unconfirmed model
  // would let a helper spawn on something that no longer exists with nothing
  // on screen explaining why.
  describe('getDelegatedModels / setDelegatedModel (Task 8)', () => {
    const CATALOG: CatalogModel[] = [
      { id: 'claude-opus-5', providerId: 'anthropic', label: 'Claude Opus 5' },
    ];

    it('setDelegatedModel refuses an id absent from the catalog and never writes', async () => {
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null,
        undefined, undefined, undefined,
        { modelCatalog: async () => CATALOG },
        undefined, undefined,
        new NativeHome(root),
      );
      const result = await h.setDelegatedModel('budget', { providerId: 'openrouter', modelId: 'ghost-model' });
      expect(result).toEqual({ ok: false, error: '"ghost-model" isn’t in the model list right now — pick it from the list.' });
      // Never written: a fresh read still reports nothing designated.
      const view = await h.getDelegatedModels();
      expect(view.budget).toBeNull();
      await h.destroyAll();
    });

    it('setDelegatedModel writes a binding that IS in the catalog, and getDelegatedModels reads its label back', async () => {
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null,
        undefined, undefined, undefined,
        { modelCatalog: async () => CATALOG },
        undefined, undefined,
        new NativeHome(root),
      );
      const result = await h.setDelegatedModel('frontier', { providerId: 'anthropic', modelId: 'claude-opus-5' });
      expect(result).toEqual({ ok: true });
      const view = await h.getDelegatedModels();
      expect(view.frontier).toEqual({ providerId: 'anthropic', modelId: 'claude-opus-5', label: 'Claude Opus 5' });
      await h.destroyAll();
    });

    it('clears with null', async () => {
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null,
        undefined, undefined, undefined,
        { modelCatalog: async () => CATALOG },
        undefined, undefined,
        new NativeHome(root),
      );
      await h.setDelegatedModel('frontier', { providerId: 'anthropic', modelId: 'claude-opus-5' });
      expect((await h.getDelegatedModels()).frontier).not.toBeNull();
      const result = await h.setDelegatedModel('frontier', null);
      expect(result).toEqual({ ok: true });
      expect((await h.getDelegatedModels()).frontier).toBeNull();
      await h.destroyAll();
    });

    it('without a nativeHome, getDelegatedModels reports nothing designated instead of throwing', async () => {
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null,
      );
      await expect(h.getDelegatedModels()).resolves.toEqual({ budget: null, frontier: null });
      await h.destroyAll();
    });
  });

  // Task 9 (plan 1c) — run replay on attach. A DIFFERENT "Task 9" from the
  // "restart recovery + subagent-card replay (Task 9, plan 1b)" describe
  // just below (that comment already flags the reused number; same reason
  // applies here — not renamed to avoid an unrelated diff).
  describe('specialistRunsFor (Task 9, plan 1c — run replay on attach)', () => {
    it('returns toRunView of every ledger record for the live parent, and [] for an unknown session', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null,
        undefined, undefined, undefined, undefined, undefined, undefined, new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      await (h as any).ledger.recordStart(root, 'root-1', {
        childId: 'child-a', parentToolCallId: 'tc-1', agentType: 'explorer', title: 'Nadia',
        workDir: root, description: 'd', background: true,
        status: 'running', startedAt: Date.now(), delivered: false, owner: OWNER, missedSteers: [],
      });
      await (h as any).ledger.recordStart(root, 'root-1', {
        childId: 'child-b', parentToolCallId: 'tc-2', agentType: 'researcher', title: 'Otis',
        workDir: root, description: 'd', background: true,
        status: 'completed', startedAt: Date.now(), endedAt: Date.now(), delivered: true, owner: OWNER, missedSteers: [],
      });

      const runs = h.specialistRunsFor('root-1');
      expect(runs).toHaveLength(2);
      expect(runs.map((r) => r.childId).sort()).toEqual(['child-a', 'child-b']);
      // toRunView strips delivery bookkeeping — the host's own business, never the card's.
      expect((runs.find((r) => r.childId === 'child-a') as any).owner).toBeUndefined();
      expect((runs.find((r) => r.childId === 'child-a') as any).claimedBy).toBeUndefined();

      // Unknown/non-live session: no crash, no cards — matches getHistory()'s
      // own "null for non-live" contract (see that method's WHY comment).
      expect(h.specialistRunsFor('does-not-exist')).toEqual([]);

      await h.destroyAll();
    });

    it('caps replay at SPECIALIST_SPAWN_BUDGET_PER_SESSION records', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null,
        undefined, undefined, undefined, undefined, undefined, undefined, new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      // One more record than the lifetime spawn budget allows. In production
      // the ledger can never actually hold more than the budget for one
      // parent (trySpendSpecialistSpawnBudget gates every spawn BEFORE
      // recordStart ever runs) — this proves the defensive cap holds even so.
      for (let i = 0; i < SPECIALIST_SPAWN_BUDGET_PER_SESSION + 1; i++) {
        await (h as any).ledger.recordStart(root, 'root-1', {
          childId: `child-${i}`, parentToolCallId: `tc-${i}`, agentType: 'explorer', title: `T${i}`,
          workDir: root, description: 'd', background: true,
          status: 'running', startedAt: Date.now(), delivered: false, owner: OWNER, missedSteers: [],
        });
      }

      expect(h.specialistRunsFor('root-1')).toHaveLength(SPECIALIST_SPAWN_BUDGET_PER_SESSION);

      await h.destroyAll();
    });
  });

  // Task 9 (plan 1b) — restart recovery + subagent-card replay. Unrelated to
  // the "Task 9" label on the `quiesce` describe above (Phase 1 Plan A used
  // its own numbering) — both names are pinned in their own commit history,
  // not renamed here to avoid an unrelated diff.
  //
  // Reconcile needs a REAL ledger (a NativeHome pointed at the test's tmp
  // root), same as the Task 4 background-delivery suite in
  // specialist-run.test.ts — the delivery loop and reconcile both read/write
  // it directly, so a fake would just be reimplementing the real thing.
  describe('restart recovery + subagent-card replay (Task 9, plan 1b)', () => {
    const EXPLORER = resolveSpecialist('explorer')!;

    function bootHost(home: NativeHome, store: SessionStore, modelFactory: any = factory) {
      return new NativeSessionHost(
        store, modelFactory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, home,
      );
    }

    it('resuming a parent marks dead-owner running children as interrupted, honestly — and leaves a live owner\'s record untouched', async () => {
      const home = new NativeHome(root);
      const store = new SessionStore(home);
      const h = bootHost(home, store);
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      // A record whose owner is a process that does not exist — the shape a
      // real crash-and-restart leaves behind (nothing ever marked it
      // 'interrupted' because the process that would have died mid-flight).
      await (h as any).ledger.recordStart(root, 'root-1', {
        childId: 'child-dead', parentToolCallId: 'tc-1', agentType: 'explorer', title: 'Nadia',
        workDir: root, description: 'd', background: true,
        status: 'running', startedAt: Date.now(), delivered: false,
        owner: { pid: 999999, instanceId: 'dead-instance' }, missedSteers: [],
      });
      // A record owned by THIS process (OWNER is a module singleton, so it
      // reads as alive to every host built in this test file) — reconcile
      // must never touch a live owner's record.
      await (h as any).ledger.recordStart(root, 'root-1', {
        childId: 'child-alive', parentToolCallId: 'tc-2', agentType: 'explorer', title: 'Otis',
        workDir: root, description: 'd', background: true,
        status: 'running', startedAt: Date.now(), delivered: false,
        owner: OWNER, missedSteers: [],
      });
      await h.destroy('root-1'); // parent goes away without ever marking either child

      const h2 = bootHost(home, store);
      const resumed = await h2.resume('root-1', root);
      expect(resumed).toBe(true);

      const records = (h2 as any).ledger.listFor(root, 'root-1');
      const dead = records.find((r: any) => r.childId === 'child-dead');
      expect(dead?.status).toBe('interrupted'); // honest — the child really did stop
      expect(dead?.endedAt).toBeDefined();

      const alive = records.find((r: any) => r.childId === 'child-alive');
      expect(alive?.status).toBe('running'); // untouched — its owner is still around

      await h2.destroyAll();
    });

    it('an undelivered background report from before the restart is delivered at the first idle boundary', async () => {
      const home = new NativeHome(root);
      const store = new SessionStore(home);
      const h = bootHost(home, store);
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      await (h as any).ledger.recordStart(root, 'root-1', {
        childId: 'child-done', parentToolCallId: 'tc-1', agentType: 'explorer', title: 'Nadia',
        workDir: root, description: 'find the config loader', background: true,
        status: 'completed', startedAt: Date.now() - 60_000, endedAt: Date.now(), steps: 3,
        rawReport: 'REPORT: found it in src/config.ts', delivered: false, owner: OWNER, missedSteers: [],
      });
      await h.destroy('root-1');

      const h2 = bootHost(home, store);
      const events: any[] = [];
      h2.on('transcript-event', (e) => events.push(e));
      const resumed = await h2.resume('root-1', root);
      expect(resumed).toBe(true);

      await vi.waitFor(() => {
        expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(1);
      });
      const injected = events.find((e) => e.data?.injected === 'specialist-report')!;
      expect(injected.type).toBe('user-message');
      expect(injected.data.text).toContain('REPORT: found it in src/config.ts');

      // `delivered` is set by a later, separate async disk write
      // (confirmDelivered's mkdir-based file lock) that the transcript event
      // above is deliberately not gated on — poll instead of racing it.
      await vi.waitFor(() => {
        const rec = (h2 as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === 'child-done');
        expect(rec?.delivered).toBe(true);
      });

      await h2.destroyAll();
    });

    // Fix (Important 4, final review): claimUndelivered's own eligibility
    // (delegation-ledger.ts) covers 'completed' OR 'failed' — a dead
    // background child still owes the parent a typed failure notice. Before
    // this fix, reconcileDelegations' own "has undelivered" flag only fired
    // for 'completed', so a parent whose ONLY undelivered record was 'failed'
    // never got queued for delivery after a restart — the failure notice
    // never arrived, even though claimUndelivered was willing to hand it
    // over. Same shape as the sibling test above, but the pre-restart record
    // is 'failed', not 'completed'.
    it('an undelivered FAILURE notice from before the restart is also delivered at the first idle boundary', async () => {
      const home = new NativeHome(root);
      const store = new SessionStore(home);
      const h = bootHost(home, store);
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      await (h as any).ledger.recordStart(root, 'root-1', {
        childId: 'child-failed', parentToolCallId: 'tc-1', agentType: 'explorer', title: 'Nadia',
        workDir: root, description: 'find the config loader', background: true,
        status: 'failed', startedAt: Date.now() - 60_000, endedAt: Date.now(),
        failureText: 'ENOENT: no such file or directory', delivered: false, owner: OWNER, missedSteers: [],
      });
      await h.destroy('root-1');

      const h2 = bootHost(home, store);
      const events: any[] = [];
      h2.on('transcript-event', (e) => events.push(e));
      const resumed = await h2.resume('root-1', root);
      expect(resumed).toBe(true);

      await vi.waitFor(() => {
        expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(1);
      });
      const injected = events.find((e) => e.data?.injected === 'specialist-report')!;
      expect(injected.type).toBe('user-message');
      expect(injected.data.text).toContain('ENOENT: no such file or directory');

      // `delivered` is set by a later, separate async disk write
      // (confirmDelivered's mkdir-based file lock) that the transcript event
      // above is deliberately not gated on — poll instead of racing it.
      await vi.waitFor(() => {
        const rec = (h2 as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === 'child-failed');
        expect(rec?.delivered).toBe(true);
      });

      await h2.destroyAll();
    });

    // The finding this test pins (external review 2026-08-13): a FOREGROUND
    // specialist's failure already reached the model as the Task tool's own
    // `isError` result (tools/task.ts) the instant spawnSpecialist rejected —
    // spawnSpecialist only ever calls confirmDelivered on the SUCCESS path
    // (native-session-host.ts, spawnSpecialist), so a foreground failure's
    // ledger row is stuck 'failed'/delivered:false forever, identically to a
    // genuine undelivered background failure. Before this fix,
    // reconcileDelegations' hasUndelivered check (and claimUndelivered's own
    // eligibility filter) had no `background` gate, so reopening this
    // conversation queued this already-seen failure for delivery and injected
    // it a SECOND time, mislabeled "[Background specialist failed]" even
    // though it never ran in the background. Sibling test above
    // ("an undelivered FAILURE notice...") pins that a GENUINE background
    // failure still gets exactly one delivery through this same restart path.
    it('a foreground specialist\'s failure is never re-delivered as a "[Background specialist failed]" notice after the conversation is reopened', async () => {
      const home = new NativeHome(root);
      const store = new SessionStore(home);
      const h = bootHost(home, store);
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      // The exact shape spawnSpecialist's own throw path leaves behind: a
      // FOREGROUND ('background: false') record, terminal 'failed', and
      // still undelivered — because confirmDelivered is only ever reached on
      // the success branch, and the failure already went back to the model
      // inline as the tool result (tools/task.ts's catch).
      await (h as any).ledger.recordStart(root, 'root-1', {
        childId: 'child-fg-failed', parentToolCallId: 'tc-1', agentType: 'explorer', title: 'Nadia',
        workDir: root, description: 'find the config loader', background: false,
        status: 'failed', startedAt: Date.now() - 60_000, endedAt: Date.now(),
        failureText: 'ENOENT: no such file or directory', delivered: false, owner: OWNER, missedSteers: [],
      });
      await h.destroy('root-1');

      const h2 = bootHost(home, store);
      const events: any[] = [];
      h2.on('transcript-event', (e) => events.push(e));
      const resumed = await h2.resume('root-1', root);
      expect(resumed).toBe(true);

      // No positive event to wait for here — the whole point is that nothing
      // fires. Wait past the delivery pass's own async hops (same margin the
      // rest of this file's negative-assertion tests use, e.g. the send-queue
      // survivor check above) rather than asserting immediately after resume.
      await new Promise((r) => setTimeout(r, 150));
      expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(0);

      // Not merely "we didn't wait long enough" — the record itself was
      // never touched by the delivery lane: no lease taken, never marked
      // delivered.
      const rec = (h2 as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === 'child-fg-failed');
      expect(rec?.delivered).toBe(false);
      expect(rec?.claimedBy).toBeUndefined();

      await h2.destroyAll();
    });

    it('a report CLAIMED by a dead instance but never confirmed is re-delivered after restart', async () => {
      const home = new NativeHome(root);
      const store = new SessionStore(home);
      const h = bootHost(home, store);
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      await (h as any).ledger.recordStart(root, 'root-1', {
        childId: 'child-claimed', parentToolCallId: 'tc-1', agentType: 'explorer', title: 'Nadia',
        workDir: root, description: 'find the config loader', background: true,
        status: 'completed', startedAt: Date.now() - 60_000, endedAt: Date.now(), steps: 2,
        rawReport: 'REPORT: config lives in src/config.ts', delivered: false, owner: OWNER,
        missedSteers: [], claimedBy: { pid: 999999, instanceId: 'gone' }, claimedAt: Date.now() - 30_000,
      });
      await h.destroy('root-1');

      const h2 = bootHost(home, store);
      const events: any[] = [];
      h2.on('transcript-event', (e) => events.push(e));
      const resumed = await h2.resume('root-1', root);
      expect(resumed).toBe(true);

      await vi.waitFor(() => {
        expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(1);
      });
      // Settle a bit longer — a duplicate delivery (the bug this reconcile
      // pass exists to prevent) would show up as a SECOND injected event.
      await new Promise((r) => setTimeout(r, 30));
      expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(1);

      // `delivered` is set by a later, separate async disk write
      // (confirmDelivered's mkdir-based file lock) that the transcript event
      // above is deliberately not gated on — poll instead of racing it. (The
      // 30ms settle above is a separate concern: giving a possible duplicate
      // delivery time to show up as a second event.)
      await vi.waitFor(() => {
        const rec = (h2 as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === 'child-claimed');
        expect(rec?.delivered).toBe(true);
      });

      await h2.destroyAll();
    });

    it('getHistory splices stamped child events immediately after the parent Task tool-use', async () => {
      const home = new NativeHome(root);
      const store = new SessionStore(home);
      const h = bootHost(home, store);
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      // What a real turn produces when the model calls Task (task.ts): a
      // tool-use event on the PARENT's own transcript, then a tool-result once
      // the specialist's report comes back. Appended directly rather than
      // driven through a scripted Task tool-call — the Task tool's own
      // execute() path is exercised in task-tool.test.ts; this test only needs
      // the parent-side shape getHistory splices against.
      await store.append(root, {
        type: 'tool-use', sessionId: 'root-1', uuid: 'u-tool-use', timestamp: Date.now(),
        data: { toolUseId: 'tc-1', toolName: 'Task', toolInput: { agent: 'explorer' } },
      });

      const { childId, report } = await h.spawnSpecialist('root-1', {
        specialist: EXPLORER, prompt: 'find the config loader', workDir: root, parentToolCallId: 'tc-1',
        token: { parentId: 'root-1', writer: false },
      });
      expect(report).toContain('Hi there'); // the suite's default `factory`'s one text step

      await store.append(root, {
        type: 'tool-result', sessionId: 'root-1', uuid: 'u-tool-result', timestamp: Date.now(),
        data: { toolUseId: 'tc-1', toolResult: report },
      });

      await h.destroy('root-1');

      const h2 = bootHost(home, store);
      const resumed = await h2.resume('root-1', root);
      expect(resumed).toBe(true);

      const events = h2.getHistory('root-1')!;
      const taskIdx = events.findIndex((e) => e.type === 'tool-use' && e.data.toolName === 'Task');
      expect(taskIdx).toBeGreaterThanOrEqual(0);
      // Immediately after — not just "somewhere after".
      expect(events[taskIdx + 1].data.agentId).toBe(childId);
      expect(events[taskIdx + 1].data.parentAgentToolUseId).toBe(events[taskIdx].data.toolUseId);
      // Every stamped (agentId-bearing) event is display-safe — nothing else
      // rode along under the parent's id.
      //
      // 'subagent-usage' is excluded because it is NOT a stamped copy of a
      // child event: it is the PARENT's own bookkeeping event (the finished
      // specialist's total spend), emitted on the parent's stream and written
      // to the parent's own file. It carries agentId only to name which child
      // the money belongs to. Its own coverage is in
      // tests/subagent-usage-event.test.ts.
      const stamped = events.filter((e) => e.data.agentId && e.type !== 'subagent-usage');
      expect(stamped.length).toBeGreaterThan(0);
      expect(stamped.every((e) => SUBAGENT_DISPLAY_TYPES.has(e.type))).toBe(true);
      // …and that bookkeeping event really is on the parent's record exactly once.
      expect(events.filter((e) => e.type === 'subagent-usage')).toHaveLength(1);

      await h2.destroyAll();
    });

    it('replayed stamped events preserve partId so the reducer coalesces deltas identically', async () => {
      const home = new NativeHome(root);
      const store = new SessionStore(home);
      const h = bootHost(home, store);
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      await store.append(root, {
        type: 'tool-use', sessionId: 'root-1', uuid: 'u-tool-use', timestamp: Date.now(),
        data: { toolUseId: 'tc-1', toolName: 'Task', toolInput: { agent: 'explorer' } },
      });

      await h.spawnSpecialist('root-1', {
        specialist: EXPLORER, prompt: 'find the config loader', workDir: root, parentToolCallId: 'tc-1',
        token: { parentId: 'root-1', writer: false },
      });

      // The child's own persisted assistant-text event, straight off disk —
      // this is the source of truth the replay must match, not a guess.
      const childHeader = store.list({ includeChildren: true }).find((r) => r.parentSessionId === 'root-1')!;
      const childOwnEvents = store.readEvents(childHeader.sessionId, root);
      const originalText = childOwnEvents.find((e) => e.type === 'assistant-text')!;
      expect(originalText.data.partId).toBeTruthy(); // sanity: the fixture really does carry one

      await h.destroy('root-1');

      const h2 = bootHost(home, store);
      await h2.resume('root-1', root);

      const events = h2.getHistory('root-1')!;
      const replayedText = events.find((e) => e.type === 'assistant-text' && e.data.agentId === childHeader.sessionId)!;
      expect(replayedText.data.partId).toBe(originalText.data.partId);

      await h2.destroyAll();
    });
  });

  // mergeChildEvents (Task 9, plan 1b) — the pure splice function, tested
  // directly per the brief rather than only through getHistory() above.
  describe('mergeChildEvents (pure function)', () => {
    const rec = (over: Partial<any> = {}) => ({
      childId: 'child-1', parentToolCallId: 'tc-1', agentType: 'explorer', title: 'Nadia',
      workDir: '/x', description: 'd', background: false, status: 'completed',
      startedAt: 0, delivered: true, owner: OWNER, missedSteers: [], ...over,
    });
    const ev = (type: string, over: Partial<any> = {}): any => ({
      type, sessionId: 'child-1', uuid: `u-${Math.random()}`, timestamp: 0, data: {}, ...over,
    });

    it('splices the stamped block immediately after the matching parent Task tool-use event', () => {
      const parentEvents = [
        ev('user-message', { sessionId: 'root-1' }),
        ev('tool-use', { sessionId: 'root-1', data: { toolUseId: 'tc-1', toolName: 'Task' } }),
        ev('turn-complete', { sessionId: 'root-1' }),
      ];
      const childEvents = [ev('assistant-text', { data: { text: 'child said this' } })];
      const merged = mergeChildEvents('root-1', parentEvents, [{ record: rec(), events: childEvents }]);
      expect(merged).toHaveLength(4);
      expect(merged[1].type).toBe('tool-use');
      expect(merged[2].type).toBe('assistant-text');
      expect(merged[2].sessionId).toBe('root-1');
      expect(merged[2].data.agentId).toBe('child-1');
      expect(merged[2].data.parentAgentToolUseId).toBe('tc-1');
      expect(merged[3].type).toBe('turn-complete');
    });

    it('filters child events down to the display-safe subset — turn-complete/user-message never ride along', () => {
      const parentEvents = [ev('tool-use', { sessionId: 'root-1', data: { toolUseId: 'tc-1' } })];
      const childEvents = [
        ev('user-message', { data: { text: 'the brief' } }),
        ev('assistant-text', { data: { text: 'ok' } }),
        ev('turn-complete', {}),
      ];
      const merged = mergeChildEvents('root-1', parentEvents, [{ record: rec(), events: childEvents }]);
      expect(merged.map((e) => e.type)).toEqual(['tool-use', 'assistant-text']);
    });

    // Explicit requirement (brief): a crash between minting the child and
    // appending the parent's own Task tool-use event leaves a ledger record
    // with no matching parent event — must be skipped, never guessed at.
    it('skips a record defensively when its parentToolCallId has no matching parent tool-use event', () => {
      const parentEvents = [ev('user-message', { sessionId: 'root-1' })];
      const childEvents = [ev('assistant-text', { data: { text: 'orphaned' } })];
      const merged = mergeChildEvents('root-1', parentEvents, [{ record: rec(), events: childEvents }]);
      expect(merged).toEqual(parentEvents); // untouched — no guess, no drop of parent events
    });

    it('splices multiple children after their OWN respective parent tool-use events, in order', () => {
      const parentEvents = [
        ev('tool-use', { sessionId: 'root-1', data: { toolUseId: 'tc-1' } }),
        ev('tool-use', { sessionId: 'root-1', data: { toolUseId: 'tc-2' } }),
      ];
      const children = [
        { record: rec({ childId: 'child-1', parentToolCallId: 'tc-1' }), events: [ev('assistant-text', { data: { text: 'from child 1' } })] },
        { record: rec({ childId: 'child-2', parentToolCallId: 'tc-2' }), events: [ev('assistant-text', { data: { text: 'from child 2' } })] },
      ];
      const merged = mergeChildEvents('root-1', parentEvents, children);
      expect(merged.map((e) => `${e.type}:${e.data.agentId ?? e.data.toolUseId}`)).toEqual([
        'tool-use:tc-1', 'assistant-text:child-1', 'tool-use:tc-2', 'assistant-text:child-2',
      ]);
    });

    // Task 7 (plan 1c): replay must match the live-copy guard's widened
    // predicate exactly — a text-bearing assistant-thinking event splices in
    // stamped (same as any other display-safe type), while the three
    // NON-text-bearing shapes (heartbeat/stallWarning/toolPreparing) never do.
    // Asserted against an in-memory events array rather than round-tripping
    // through SessionStore: the store already drops payload-less thinking
    // events before they ever reach disk (session-store.ts), so a disk
    // round-trip would pass this test for the wrong reason — it wouldn't
    // prove the FILTER excludes them, only that the store never persisted
    // them in the first place.
    it('mergeChildEvents replays text-bearing thinking, never heartbeats', () => {
      const parentEvents = [ev('tool-use', { sessionId: 'root-1', data: { toolUseId: 'tc-1' } })];
      const childEvents = [
        ev('assistant-thinking', { data: {} }), // payload-less heartbeat
        ev('assistant-thinking', { data: { text: 'thinking it through', partId: 'r1' } }),
        ev('assistant-thinking', { data: { stallWarning: { retryInMs: 1000, willRetry: true } } }),
        ev('assistant-thinking', { data: { toolPreparing: { toolCallId: 'x', toolName: 'Glob', chars: 1 } } }),
        ev('assistant-text', { data: { text: 'ok' } }),
      ];
      const merged = mergeChildEvents('root-1', parentEvents, [{ record: rec(), events: childEvents }]);
      expect(merged.map((e) => e.type)).toEqual(['tool-use', 'assistant-thinking', 'assistant-text']);
      expect(merged[1].data.text).toBe('thinking it through');
      expect(merged[1].sessionId).toBe('root-1');
      expect(merged[1].data.agentId).toBe('child-1');
      expect(merged[1].data.parentAgentToolUseId).toBe('tc-1');
    });
  });

  // ---------------------------------------------------------------------
  // Task 4 (plan 1c) — the catalog is loaded before the Task tool exists,
  // re-read at the start of every root turn when a file changed, and the
  // Task tool is rebuilt from the in-memory roster every turn (never once).
  // ---------------------------------------------------------------------
  describe('specialist catalog wiring (Task 4, plan 1c)', () => {
    let projectDir: string;

    function ccFile(name: string): string {
      return `---\nname: ${name}\ndescription: A project-defined helper.\ntools: [Read]\n---\nHelp with reading files.\n`;
    }
    function projectAgentsDir(): string {
      return path.join(projectDir, '.claude', 'agents');
    }
    function bootWithCatalog(catalog: SpecialistCatalog) {
      return new NativeSessionHost(
        new SessionStore(new NativeHome(projectDir)), factory, NO_CONTEXT, async () => null, async () => null,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, catalog,
      );
    }
    // waitForTurnComplete alone isn't enough between TWO sends on the SAME
    // host: 'turn-complete' fires inside HarnessSession's own driver, before
    // runTurns' drainDeliveries + its finally clears entry.inFlight — so a
    // send() issued the instant waitForTurnComplete resolves can race that
    // window and get QUEUED (drained inside the SAME runTurns pass) instead
    // of dispatched as its own pass, silently skipping that turn's own
    // ensureFresh() call. Awaiting entry.running (settles only once runTurns
    // itself has fully returned) closes that window.
    async function sendAndSettle(h: NativeSessionHost, sessionId: string, text: string): Promise<void> {
      h.send(sessionId, text);
      await waitForTurnComplete(h, 1);
      await (h as any).live.get(sessionId).running;
    }

    beforeEach(() => { projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-cat-proj-')); });
    afterEach(() => { fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); });

    it("create() loads the catalog for the cwd BEFORE the Task tool is built — a personal file present at create time is in the first turn's Task description", async () => {
      fs.mkdirSync(projectAgentsDir(), { recursive: true });
      fs.writeFileSync(path.join(projectAgentsDir(), 'foo-helper.md'), ccFile('Foo Helper'));
      // claudeUserDir: null — no ~/.claude/agents source in this test process;
      // only the project's own .claude/agents (read regardless of `home`).
      const catalog = new SpecialistCatalog({ claudeUserDir: null });
      const h = bootWithCatalog(catalog);
      await h.create({ sessionId: 'root-1', cwd: projectDir, binding: { providerId: 'openrouter', modelId: 'm' } });
      h.send('root-1', 'hi');
      await waitForTurnComplete(h, 1);
      const taskTool = (h as any).live.get('root-1').session.toolByName.get('Task');
      // Present on the VERY FIRST turn — proves ensureFresh(cwd) was awaited
      // BEFORE toolWiring() built this tool, not raced against it.
      expect(taskTool.description).toContain('foo-helper');
      await h.destroyAll();
    });

    // D2 (2026-08-26, review Major) — the WIRING half of "work_dir resolves
    // against the session folder": task.ts can only do it if harness-session.ts
    // actually hands createTaskTool the session's cwd. Driven through a real
    // session so a dropped argument fails HERE, rather than silently in
    // production, where the remembered rule would name the Electron process's
    // own directory — a folder the user was never in.
    it("the Task tool's permission subject resolves work_dir against the SESSION's folder, never process.cwd()", async () => {
      const catalog = new SpecialistCatalog({ claudeUserDir: null });
      const h = bootWithCatalog(catalog);
      await h.create({ sessionId: 'root-1', cwd: projectDir, binding: { providerId: 'openrouter', modelId: 'm' } });
      h.send('root-1', 'hi');
      await waitForTurnComplete(h, 1);
      const taskTool = (h as any).live.get('root-1').session.toolByName.get('Task');
      const posix = projectDir.replace(/\\/g, '/');
      expect(taskTool.permissionSubject({ agent: 'explorer', work_dir: '.' })).toBe(`read-only:${posix}`);
      expect(taskTool.permissionSubject({ agent: 'explorer', work_dir: 'sub' })).toBe(`read-only:${posix}/sub`);
      // The bug this pins: the subject used to be built from the Electron
      // process's own directory, which has nothing to do with this session.
      expect(taskTool.permissionSubject({ agent: 'explorer', work_dir: '.' }))
        .not.toContain(process.cwd().replace(/\\/g, '/'));
      await h.destroyAll();
    });

    it('a turn dispatched after a file changed sees the new roster (ensureFresh runs before the turn); an unchanged folder costs no re-read', async () => {
      const catalog = new SpecialistCatalog({ claudeUserDir: null });
      const ensureFreshSpy = vi.spyOn(catalog, 'ensureFresh');
      const h = bootWithCatalog(catalog);
      await h.create({ sessionId: 'root-1', cwd: projectDir, binding: { providerId: 'openrouter', modelId: 'm' } });
      // create() itself already called ensureFresh once (Task 4 — before the
      // Task tool is ever built) — the empty project folder's first-ever read.
      expect(ensureFreshSpy).toHaveBeenCalledTimes(1);
      expect(await ensureFreshSpy.mock.results[0].value).toBe(true); // never-seen cwd — first read

      // Turn 1: nothing changed since create() read it a moment ago.
      await sendAndSettle(h, 'root-1', 't1');
      expect(ensureFreshSpy).toHaveBeenCalledTimes(2);
      expect(await ensureFreshSpy.mock.results[1].value).toBe(false); // unchanged — cheap fingerprint check only
      let taskTool = (h as any).live.get('root-1').session.toolByName.get('Task');
      expect(taskTool.description).not.toContain('bar-helper');

      // A file lands in the project's agents folder between turns.
      fs.mkdirSync(projectAgentsDir(), { recursive: true });
      fs.writeFileSync(path.join(projectAgentsDir(), 'bar-helper.md'), ccFile('Bar Helper'));

      // Turn 2: ensureFresh runs again — this time BEFORE the turn — and the
      // roster it hands the Task tool has changed.
      await sendAndSettle(h, 'root-1', 't2');
      expect(ensureFreshSpy).toHaveBeenCalledTimes(3);
      expect(await ensureFreshSpy.mock.results[2].value).toBe(true); // the new file changed the fingerprint
      taskTool = (h as any).live.get('root-1').session.toolByName.get('Task');
      expect(taskTool.description).toContain('bar-helper');

      // Turn 3: nothing changed since turn 2 — ensureFresh still runs (every
      // turn re-checks), but reports no change, i.e. no re-read of the folder.
      await sendAndSettle(h, 'root-1', 't3');
      expect(ensureFreshSpy).toHaveBeenCalledTimes(4);
      expect(await ensureFreshSpy.mock.results[3].value).toBe(false); // unchanged — cheap fingerprint check only

      await h.destroyAll();
    });

    it("the Task tool is rebuilt at turn start: after the roster changes, the next turn's tools list carries the new description", async () => {
      const catalog = new SpecialistCatalog({ claudeUserDir: null });
      const h = bootWithCatalog(catalog);
      await h.create({ sessionId: 'root-1', cwd: projectDir, binding: { providerId: 'openrouter', modelId: 'm' } });

      await sendAndSettle(h, 'root-1', 't1');
      const taskV1 = (h as any).live.get('root-1').session.toolByName.get('Task');

      await sendAndSettle(h, 'root-1', 't2');
      const taskV1b = (h as any).live.get('root-1').session.toolByName.get('Task');
      // No has()-guard for Task (unlike ModelSearch/Skill): rebuilt every
      // turn even when the roster hasn't changed — a NEW object each time...
      expect(taskV1b).not.toBe(taskV1);
      // ...but an IDENTICAL description, since the roster it was built from
      // didn't change — no prompt-cache cost from the rebuild itself.
      expect(taskV1b.description).toBe(taskV1.description);

      fs.mkdirSync(projectAgentsDir(), { recursive: true });
      fs.writeFileSync(path.join(projectAgentsDir(), 'zed-helper.md'), ccFile('Zed Helper'));

      await sendAndSettle(h, 'root-1', 't3');
      const taskV2 = (h as any).live.get('root-1').session.toolByName.get('Task');
      expect(taskV2.description).toContain('zed-helper');
      expect(taskV2.description).not.toBe(taskV1b.description);

      await h.destroyAll();
    });
  });
});

// Task 11 — the price a turn ran at, stamped in main.
//
// WHY main and not the renderer: only main knows which provider a binding
// belongs to, so only main can tell "runs free on your own machine" from
// "metered, but nobody published a rate". Those two produce very different
// sentences in the status bar, and the renderer has no way to tell them apart
// on its own (SessionInfo carries no provider type).
describe('NativeSessionHost per-turn pricing', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-host-price-')); });
  afterEach(() => rmHostRoot(root));

  // The scripted stream reports 3 input + 2 output tokens (CHUNKS, top of file).
  async function firstTurnUsage(opts: {
    providerType: string | null;
    pricing: { in: number; out: number; cacheRead?: number; cacheWrite?: number } | null;
  }): Promise<any> {
    const h = new NativeSessionHost(
      new SessionStore(new NativeHome(root)), factory, NO_CONTEXT,
      async () => opts.providerType as any,
      async () => null,
      async () => opts.pricing,
    );
    const seen: any[] = [];
    h.on('transcript-event', (e) => seen.push(e));
    await h.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'p', modelId: 'm' } });
    h.send('s-1', 'hello');
    await waitForTurnComplete(h, 1);
    await h.drain('s-1');
    await h.destroyAll();
    return seen.find((e) => e.type === 'turn-complete')!.data.usage;
  }

  it('stamps the dollars a metered turn cost, priced at the bound model', async () => {
    // $1/token in, $2/token out expressed per 1M: 3 in + 2 out = $3 + $4.
    const usage = await firstTurnUsage({ providerType: 'openrouter', pricing: { in: 1_000_000, out: 2_000_000 } });
    expect(usage.costUsd).toBeCloseTo(7, 10);
    expect(usage.free).toBe(false);
  });

  it('stamps costUsd null — never 0 — for a metered model with no published rate', async () => {
    const usage = await firstTurnUsage({ providerType: 'openai-compatible', pricing: null });
    expect(usage.costUsd).toBeNull();
    expect(usage.free).toBe(false);   // metered-but-unknown is NOT free
  });

  it('stamps free for a local-engine turn, which costs nothing to run', async () => {
    const usage = await firstTurnUsage({ providerType: 'local-engine', pricing: null });
    expect(usage.free).toBe(true);
    expect(usage.costUsd).toBeNull();
  });

  it('stamps free for a metered provider whose published rates are all zero', async () => {
    // An OpenRouter ':free' model. A rate card of zeroes must not read as a
    // priced session that happened to cost $0.00.
    const usage = await firstTurnUsage({ providerType: 'openrouter', pricing: { in: 0, out: 0 } });
    expect(usage.free).toBe(true);
    expect(usage.costUsd).toBeNull();
  });

  // Task 22 item 1. `free` and `costUsd` are computed from two independent
  // sources — the provider TYPE and the rate card — so nothing stopped them
  // contradicting each other. A local-engine binding whose price resolver
  // happens to answer with a rate (the resolver keys on the model id and has
  // no idea where the model runs) produced {"costUsd":7,"free":true}: a turn
  // billed $7 and simultaneously declared free. The status bar has to trust
  // one of those. Production only avoided it because the wiring short-circuits
  // local-engine before the catalog is asked — the invariant belonged where
  // the number is stamped, not in the wiring.
  it('never stamps a positive cost on a turn it also reports as free', async () => {
    const usage = await firstTurnUsage({
      providerType: 'local-engine', pricing: { in: 1_000_000, out: 2_000_000 },
    });
    expect(usage.free).toBe(true);
    expect(usage.costUsd).toBeNull();
  });

  // Task 22 item 2. Spec 5: "a price is attached to each turn as it completes
  // ... never applied retroactively to already-counted work." Deleting
  // setBinding's pricing re-apply left the whole suite green, because every
  // pricing test until now ran exactly one turn on one model. Two turns across
  // a mid-session swap is the smallest shape that can tell the two apart.
  it('prices each turn at the model that ran it, across a mid-session model swap', async () => {
    // The scripted stream is 3 input + 2 output tokens either way, so the ONLY
    // thing that can move the figure is which rate card was in force.
    const rates: Record<string, { in: number; out: number }> = {
      'm-cheap': { in: 1_000_000, out: 2_000_000 },     // 3 in + 2 out = $7
      'm-dear': { in: 10_000_000, out: 20_000_000 },    // the same turn = $70
    };
    const h = new NativeSessionHost(
      new SessionStore(new NativeHome(root)), factory, NO_CONTEXT,
      async () => 'openrouter' as any,
      async () => null,
      async (b: any) => rates[b.modelId] ?? null,
    );
    const turns: any[] = [];
    h.on('transcript-event', (e) => { if (e.type === 'turn-complete') turns.push(e); });
    await h.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'p', modelId: 'm-cheap' } });

    h.send('s-1', 'hello');
    await waitForTurnComplete(h, 1);
    expect(await h.setBinding('s-1', { providerId: 'p', modelId: 'm-dear' })).toBe(true);
    h.send('s-1', 'hello again');
    await waitForTurnComplete(h, 1);
    await h.drain('s-1');
    await h.destroyAll();

    expect(turns).toHaveLength(2);
    // Turn 2 ran on the expensive model and must be billed at it — without the
    // re-apply this is still $7, priced at a model that had already been left.
    expect(turns[1].data.usage.costUsd).toBeCloseTo(70, 10);
    // Turn 1 keeps the price it ran at. Task 24 — be exact about what this
    // half pins and what it does not. turn-complete builds `data.usage` as a
    // fresh object at emit time and hands it straight to the listeners, so once
    // a turn has been reported there is nothing left in-process that could
    // rewrite it: this assertion is close to tautological and stands as a
    // regression floor, NOT as proof of spec 5's "never applied retroactively".
    //
    // The shape that genuinely is at risk is a swap that lands while a turn is
    // still STREAMING — setBinding writes opts immediately, so the in-flight
    // turn gets stamped with the new model's name and billed at the new model's
    // rate although the old model generated every token. Measured 2026-08-27
    // on the delayedFactory rig: a turn generated on m-cheap came back
    // {model: 'm-dear', costUsd: 70}. That is a separate defect whose fix is a
    // production change (snapshot the price card at turn START), so it is left
    // unpinned here on purpose rather than frozen at its current wrong answer.
    expect(turns[0].data.usage.costUsd).toBeCloseTo(7, 10);
    expect(turns[0].data.model).toBe('m-cheap');
    expect(turns[1].data.model).toBe('m-dear');
  });

  // Task 24. The line directly BELOW the one the test above pins —
  // `if (free !== undefined) this.opts.free = free;` in HarnessSession.setBinding —
  // was itself unguarded: with that line deleted the ENTIRE suite stays green
  // EXCEPT this one test — measured 2026-08-27 across the whole desktop suite,
  // in a copy of this branch at HEAD outside the worktree: 1 failed / 6,250
  // passed, against a 0 failed / 6,251 passed baseline. (Task 28 item 1 — the
  // earlier wording here, "deleting it left 151 tests green", named a count no
  // scope reproduces; a bare test count depends on which files you ran, so it
  // rots. The claim above does not.) Nothing else catches it because every
  // other pricing test runs all of its turns on ONE side of the free/metered
  // line. It stopped being cosmetic when costUsd became
  // `this.opts.free ? null : costForUsage(...)` (Task 22 item 1): a STALE
  // `free` no longer merely mislabels a turn, it suppresses the bill outright.
  // What the user would see: swap mid-session from a local model to an
  // OpenRouter one and the Cost chip reports the session as free forever
  // after, while OpenRouter bills every turn. Mutation-proved — with that line
  // deleted turn 2 comes back {costUsd: null, free: true}.
  it('re-reads whether the new model is free, across a local-engine to metered swap', async () => {
    const h = new NativeSessionHost(
      new SessionStore(new NativeHome(root)), factory, NO_CONTEXT,
      // The provider TYPE is what makes a turn free, and it is what the swap
      // changes — a rate card alone cannot tell these two turns apart.
      async (b: any) => (b.providerId === 'local' ? 'local-engine' : 'openrouter') as any,
      async () => null,
      // Same scripted 3 in + 2 out either way: $1/token in + $2/token out = $7.
      async (b: any) => (b.providerId === 'local' ? null : { in: 1_000_000, out: 2_000_000 }),
    );
    const turns: any[] = [];
    h.on('transcript-event', (e) => { if (e.type === 'turn-complete') turns.push(e); });
    await h.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'local', modelId: 'm-local' } });

    h.send('s-1', 'hello');
    await waitForTurnComplete(h, 1);
    expect(await h.setBinding('s-1', { providerId: 'openrouter', modelId: 'm-hosted' })).toBe(true);
    h.send('s-1', 'hello again');
    await waitForTurnComplete(h, 1);
    await h.drain('s-1');
    await h.destroyAll();

    expect(turns).toHaveLength(2);
    // Turn 1 ran on the local engine: free to run, and never a false $0.00.
    expect(turns[0].data.usage.free).toBe(true);
    expect(turns[0].data.usage.costUsd).toBeNull();
    // Turn 2 ran on OpenRouter and must be BILLED. Without the re-apply the
    // session still carries free: true, which forces costUsd to null here.
    expect(turns[1].data.usage.free).toBe(false);
    expect(turns[1].data.usage.costUsd).toBeCloseTo(7, 10);
  });
});

describe('G-1 background Bash — registry lifetime and finished notices', () => {
  const posix = process.platform !== 'win32';
  let root: string;
  let store: SessionStore;
  let host: NativeSessionHost;
  const BASH = { shellCmd: '/bin/bash', shellArgs: ['-c'] };
  // A parent whose every turn is one plain text step — the notice turn included.
  const chatty = async () => scriptedModel([stream(...textChunks('t', 'ok'), finishChunk('stop'))]) as any;
  const binding = { providerId: 'openrouter', modelId: 'm' };
  function reg(id: string) { return (host as any).shellRegistries.get(id); }
  function startIn(id: string, command: string, toolUseId = 'tu') {
    const r = reg(id).start({ toolUseId, command, cwd: root, ...BASH, env: { ...process.env } });
    if (!r.ok) throw new Error('start failed');
    return r.run;
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-shell-host-'));
    store = new SessionStore(new NativeHome(root));
    host = new NativeSessionHost(store, chatty, NO_CONTEXT, async () => null, async () => null);
    await host.create({ sessionId: 'p1', cwd: root, binding });
  });
  afterEach(async () => { await host.destroyAll(); rmHostRoot(root); });

  it('every live session has a registry, reachable by the tool as ctx.shells', () => {
    expect(reg('p1')).toBeTruthy();
    expect((host as any).live.get('p1').session.opts.shells).toBe(reg('p1'));
  });

  it.skipIf(!posix)('a finished run is injected ONCE as a user turn with injected: shell-complete and shell meta', async () => {
    const notice = waitForEvent(host, (e) => e.type === 'user-message' && e.data.injected === 'shell-complete');
    const run = startIn('p1', 'echo done; exit 2', 'toolu_x');
    const e = await notice;
    expect(e.data.text).toMatch(new RegExp(`^\\[Background command ${run.shellId} finished · exit 2 · \\d+s\\]\\n\\$ echo done; exit 2\\ndone\\nFull log: `));
    expect(e.data.injectedMeta).toEqual({ kind: 'shell', runs: [{ shellId: run.shellId, toolUseId: 'toolu_x', exitCode: 2, stopReason: undefined, elapsedMs: expect.any(Number), logPath: run.logPath }] });
    expect(run.reported).toBe(true);
    await host.drain('p1');
    const all = store.readEvents('p1', root).filter((ev: any) => ev.type === 'user-message' && ev.data.injected === 'shell-complete');
    expect(all).toHaveLength(1);
  });

  it.skipIf(!posix)('several runs finishing while the parent is busy go out as ONE turn (D8)', async () => {
    // Hold the parent mid-turn so both exits queue before any delivery pass.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    const factory2 = async () => new MockLanguageModelV4({
      doStream: async () => {
        if (first) { first = false; await gate; }
        return { stream: simulateReadableStream({ chunks: stream(...textChunks('t', 'ok'), finishChunk('stop')) }) };
      },
    }) as any;
    await host.destroyAll();
    host = new NativeSessionHost(store, factory2, NO_CONTEXT, async () => null, async () => null);
    await host.create({ sessionId: 'p2', cwd: root, binding });
    host.send('p2', 'busy');
    const a = startIn('p2', 'echo a', 'ta');
    const b = startIn('p2', 'echo b', 'tb');
    await a.exited; await b.exited;
    await new Promise((r) => setTimeout(r, 50));
    const notices: any[] = [];
    host.on('transcript-event', (e: any) => { if (e.type === 'user-message' && e.data.injected === 'shell-complete') notices.push(e); });
    release();
    await host.drain('p2');
    await new Promise((r) => setTimeout(r, 50));
    await host.drain('p2');
    expect(notices).toHaveLength(1);
    expect(notices[0].data.injectedMeta.runs.map((r: any) => r.toolUseId).sort()).toEqual(['ta', 'tb']);
    expect(notices[0].data.text).toContain(`[Background command ${a.shellId} finished`);
    expect(notices[0].data.text).toContain(`[Background command ${b.shellId} finished`);
  });

  it.skipIf(!posix)('a run the model stopped (KillShell) sends no notice; a run the USER stopped does', async () => {
    const seen: any[] = [];
    host.on('transcript-event', (e: any) => { if (e.data?.injected === 'shell-complete') seen.push(e); });
    const a = startIn('p1', 'sleep 5', 'ta');
    await reg('p1').kill(a.shellId, 'assistant');
    const b = startIn('p1', 'sleep 5', 'tb');
    const r = await host.killShell('p1', b.shellId);
    expect(r).toEqual({ ok: true });
    await host.drain('p1');
    await new Promise((res) => setTimeout(res, 50));
    await host.drain('p1');
    expect(seen).toHaveLength(1);
    expect(seen[0].data.text).toMatch(new RegExp(`^\\[Background command ${b.shellId} stopped by you · after`));
    expect(await host.killShell('p1', b.shellId)).toEqual({ ok: false, reason: 'not-running' });
    expect(await host.killShell('p1', 'sh-nope')).toEqual({ ok: false, reason: 'unknown-shell' });
    expect(await host.killShell('nope', 'sh-1')).toEqual({ ok: false, reason: 'not-live' });
  });

  it.skipIf(!posix)("destroy() kills with 'conversation-closed'; destroy({keepShells}) leaves the run; destroyAll kills orphans with 'app-quit'", async () => {
    const a = startIn('p1', 'sleep 5', 'ta');
    await host.create({ sessionId: 'p3', cwd: root, binding });
    const b = startIn('p3', 'sleep 5', 'tb');
    await host.destroy('p1');
    // destroy() records the reason synchronously but does NOT await the exit —
    // closing a tab must never stall on a stubborn process.
    expect(a.stopReason).toBe('conversation-closed');
    await a.exited;
    expect(a.status).toBe('stopped');
    expect(reg('p1')).toBeUndefined();
    await host.destroy('p3', { keepShells: true });
    expect(b.status).toBe('running');
    expect(reg('p3')).toBeTruthy();             // orphaned but still owned
    await host.destroyAll();
    await b.exited;
    expect(b.stopReason).toBe('app-quit');
  });

  it.skipIf(!posix)('a conversation closed seconds before app quit still has its command killed', async () => {
    // destroy() escalates SIGTERM->SIGKILL after 2 s and drops the registry from
    // the live map at once; without the draining set, quitting inside that
    // window left a SIGTERM-ignoring process with nothing able to reach it.
    // The group gets SIGTERM, which kills each transient `sleep` — but bash
    // ignores it and loops, so the run is still alive when the app quits.
    const a = startIn('p1', "trap '' TERM; while true; do sleep 0.2; done", 'ta');
    await host.destroy('p1');
    expect(a.stopReason).toBe('conversation-closed');   // reason recorded at once
    expect(a.status).toBe('running');                   // but the process is still up
    expect((host as any).shellRegistries.has('p1')).toBe(false);
    expect((host as any).drainingShellRegistries.size).toBe(1);   // still reachable
    await host.destroyAll();
    await a.exited;                                     // SIGKILL from the quit sweep
    expect(a.status).toBe('stopped');
  }, 15_000);

  it.skipIf(!posix)('interrupt() leaves background runs alone', async () => {
    const a = startIn('p1', 'sleep 5', 'ta');
    host.interrupt('p1');
    await new Promise((r) => setTimeout(r, 100));
    expect(a.status).toBe('running');
  });

  it.skipIf(!posix)('a run finishing after its session was destroyed is dropped with the shell log line, not the permission one', async () => {
    // logger.ts writes one JSON line per log() via fs.promises.appendFile —
    // spying there sees the message without touching ~/.claude/desktop.log.
    const spy = vi.spyOn(fs.promises, 'appendFile').mockResolvedValue(undefined);
    const a = startIn('p1', 'sleep 0.3', 'ta');
    await host.destroy('p1', { keepShells: true });
    await a.exited;
    await new Promise((r) => setTimeout(r, 50));
    const written = spy.mock.calls.map((c) => String(c[1]));
    expect(written.some((l) => l.includes('a background command finished after its conversation was closed'))).toBe(true);
    expect(written.some((l) => l.includes('late permission answer'))).toBe(false);
    spy.mockRestore();
  });

  it.skipIf(!posix)('shell-event fires with the ShellRunView and shellRunsFor replays it', async () => {
    const views: any[] = [];
    host.on('shell-event', (e: any) => views.push(e));
    const a = startIn('p1', 'echo hi', 'ta');
    await a.exited;
    await new Promise((r) => setTimeout(r, 300));
    expect(views[views.length - 1]).toEqual({ sessionId: 'p1', run: expect.objectContaining({ shellId: a.shellId, status: 'exited', exitCode: 0, tail: 'hi' }) });
    expect(host.shellRunsFor('p1').map((v: any) => v.shellId)).toEqual([a.shellId]);
    expect(host.shellRunsFor('nope')).toEqual([]);
  });

  it.skipIf(!posix)('END TO END: the model starts a background command and gets its finished notice on the right card', async () => {
    // The one test that crosses every seam at once. Every other test here
    // builds one layer's input by hand — this one lets the real Bash tool mint
    // the run, so the chain nothing else covers is exercised: ctx.toolCallId ->
    // run.toolUseId -> the toolUseId the card is keyed by, and the
    // ShellRunView the renderer receives. A break anywhere in it means the card
    // silently never updates, which no unit test would notice.
    await host.destroyAll();
    const bashThenStop = async () => scriptedModel([
      stream(toolCallChunk('c1', 'Bash', { command: 'echo hello-e2e; exit 5', run_in_background: true }), finishChunk('tool-calls')),
      stream(...textChunks('t', 'started'), finishChunk('stop')),
      stream(...textChunks('t2', 'noted'), finishChunk('stop')),   // the notice turn
    ]) as any;
    host = new NativeSessionHost(store, bashThenStop, NO_CONTEXT, async () => null, async () => null);
    await host.create({ sessionId: 'e2e', cwd: root, binding });
    host.setPermissionMode('e2e', 'full-auto');   // Bash is not deny-listed, so no ask

    const views: any[] = [];
    host.on('shell-event', (e: any) => views.push(e));
    const notice = waitForEvent(host, (e) => e.type === 'user-message' && e.data.injected === 'shell-complete');
    const startResult = waitForEvent(host, (e) => e.type === 'tool-result' && e.data.toolName === 'Bash');

    host.send('e2e', 'start it');
    const res = await startResult;
    expect(res.data.toolResult).toMatch(/^Started in the background \(shell id sh-[0-9a-f]{4}\)\./);
    const shellId = /shell id (sh-[0-9a-f]{4})/.exec(res.data.toolResult)![1];

    const e = await notice;
    expect(e.data.text).toContain(`[Background command ${shellId} finished · exit 5`);
    expect(e.data.text).toContain('hello-e2e');
    // The whole point: the meta's toolUseId is the id of the Bash tool-use
    // event, so the reducer can find the card this notice belongs to.
    const meta = e.data.injectedMeta;
    expect(meta.kind).toBe('shell');
    expect(meta.runs).toHaveLength(1);
    expect(meta.runs[0]).toMatchObject({ shellId, exitCode: 5 });
    expect(meta.runs[0].toolUseId).toBe(res.data.toolUseId);
    // And the live push carries the same id, on the same card.
    expect(views.some((v) => v.sessionId === 'e2e' && v.run.shellId === shellId && v.run.toolUseId === res.data.toolUseId)).toBe(true);
  }, 20_000);
});
