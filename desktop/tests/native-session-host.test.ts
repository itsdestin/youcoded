import { deadPid } from './helpers/dead-pid';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import fsModule from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { NativeHome } from '../src/main/native-home';
import { SessionStore } from '../src/main/harness/session-store';
import { NativeSessionHost, SUBAGENT_DISPLAY_TYPES, TRANSCRIPT_UNREADABLE_MESSAGE, mergeChildEvents } from '../src/main/harness/native-session-host';
import { PermissionStore } from '../src/main/harness/permission-store';
import { PermissionModeStore } from '../src/main/harness/permission-mode-store';
import { nativeStoreSlug } from '../src/main/slug-encoding';
import { CROSS_PROJECT_SLUG } from '../src/shared/permission-types';
import type { PermissionRule } from '../src/shared/permission-types';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { scriptedModel, stream, textChunks, toolCallChunk, finishChunk } from './helpers/scripted-model';
import { resolveSpecialist } from '../src/main/harness/specialists/registry';
import { SpecialistCatalog } from '../src/main/harness/specialists/catalog';
import { formatLongRunningNotice } from '../src/main/harness/shell-registry';
import { HOSTED_MAX_CONCURRENT_SPECIALISTS, SPECIALIST_NOTE_MAX_CHARS, SPECIALIST_SPAWN_BUDGET_PER_SESSION } from '../src/main/harness/specialists/limits';
import type { DelegationRecord } from '../src/main/harness/specialists/delegation-ledger';
import { OWNER, DelegationLedger } from '../src/main/harness/specialists/delegation-ledger';
import { ModelSearchTool } from '../src/main/harness/tools/model-search';
import type { CatalogModel } from '../src/shared/provider-types';
import { pngHeader, providerFileBytes } from './helpers/image-fixtures';
import { looseData } from '../src/shared/transcript-event-types';

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

/** Re-read `read()` every 10ms until `done(value)` (or POLL_TRIES); returns the last value so the caller's own expect names the failure. */
async function pollFor<T>(read: () => T | Promise<T>, done: (v: T) => boolean): Promise<T> {
  let v = await read();
  for (let i = 0; i < POLL_TRIES && !done(v); i++) { await new Promise((r) => setTimeout(r, 10)); v = await read(); }
  return v;
}


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

/** destroyAll(), then wait for the ledger writes it starts without waiting.
 *  WHY: tearing down a parent marks each still-running helper 'interrupted' in
 *  the ledger FIRE-AND-FORGET (native-session-host.ts destroyChildrenOf — by
 *  design, so a slow ledger lock never hangs a teardown). A test that recorded
 *  a running helper and then let afterEach delete the folder raced that write:
 *  rmdir hit ENOTEMPTY on '.youcoded/sessions' in CI (youcoded#533, Linux),
 *  even with rmHostRoot's retries. Waiting on the row itself is the signal. */
async function destroyAllAndSettle(h: any, cwd: string, parentId = 'root-1'): Promise<void> {
  const ledger = h.ledger;
  const running = (ledger?.listFor(cwd, parentId) ?? [])
    // Only a helper that is actually live gets the teardown write; a row a
    // test wrote as 'running' with no live child is never touched.
    .filter((r: any) => r.status === 'running' && h.live?.has(r.childId)).map((r: any) => r.childId);
  await h.destroyAll();
  if (running.length === 0) return;
  await vi.waitFor(() => {
    const rows = ledger.listFor(cwd, parentId);
    expect(running.every((id: string) => rows.find((r: any) => r.childId === id)?.status !== 'running')).toBe(true);
  });
}


// Turn = Write tool call then text. Fresh instance per call (step counter resets). Write is gated in 'ask' but auto-allowed in 'full-auto'.
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

// First transcript-event matching `match` (e.g. an injected specialist-report notice) without racing delivery timing.
function waitForEvent(h: NativeSessionHost, match: (e: any) => boolean): Promise<any> {
  return new Promise((res) => {
    const on = (e: any) => { if (match(e)) { h.off('transcript-event', on); res(e); } };
    h.on('transcript-event', on);
  });
}

// RAW V4 stream-part shapes (see harness-session.test.ts): deltas carry `delta`, usage is nested.
// WHY the cast: the finish part is deliberately minimal (no `raw` finish reason, no cache/text token
// split) — the host must cope with exactly this sparse shape, so the fixture is not padded to the full type.
const CHUNKS = ([
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 'p1' },
  { type: 'text-delta', id: 'p1', delta: 'Hi there' },
  { type: 'text-end', id: 'p1' },
  { type: 'finish', finishReason: { unified: 'stop' }, usage: { inputTokens: { total: 3 }, outputTokens: { total: 2 } } },
] as unknown) as LanguageModelV4StreamPart[];
const factory = async () => new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: CHUNKS }) }) }) as any;

// The constructor's 3rd param answers context length AND slot count; most fixtures need neither, so this says "unknown" for both.
const NO_CONTEXT = async () => ({ contextLength: null, totalSlots: null });


// Trickles chunks so a turn can be caught mid-stream; the loop swallows the abort so a cancel is not an unhandled rejection.
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

// send() is dispatch-only, so wait on the event stream. Attaching after send() is safe: the turn cannot run until the sync stack empties.
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

// Resolves once the session's turn is IN FLIGHT (what a live steer needs) — replaces a fixed 20ms guess that parked the steer on a loaded machine.
function waitForTurnInFlight(host: NativeSessionHost, sessionId: string, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEvent = (e: any) => {
      // A child's events arrive re-stamped under the PARENT's sessionId with data.agentId naming the child.
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

// First factory call throws (becomes session-error), later calls succeed — proves a throwing turn does not strand the send queue.
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

  it('awaits project skill discovery before creating and resuming a session', async () => {
    const catalog = { list: () => [{ id: 'project-skill', description: 'Project skill' }], load: vi.fn() };
    const discover = vi.fn(async (_cwd: string) => catalog);
    host = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, NO_CONTEXT,
      async () => null, async () => null, undefined, undefined, undefined, undefined, discover);
    await host.create({ sessionId: 'discovery', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    expect(discover).toHaveBeenCalledWith(root);
    expect((host as any).live.get('discovery').session.opts.skillCatalog).toBe(catalog);
    await host.destroy('discovery');
    await host.resume('discovery', root);
    expect(discover).toHaveBeenCalledTimes(2);
    expect((host as any).live.get('discovery').session.opts.skillCatalog).toBe(catalog);
  });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-host-'));
    host = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null);
  });
  afterEach(async () => { await host.destroyAll(); rmHostRoot(root); });

  it('releases continuation cache only after the append chain drains on destroy', async () => {
    await host.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    let unblock!: () => void;
    const entry = (host as any).live.get('s-1');
    entry.appendChain = new Promise<void>(resolve => { unblock = resolve; });
    const releaseSession = vi.fn(async () => {});
    (host as any).continuation = { acceptedHistory: { releaseSession }, continuationIdentityFor: () => 'identity' };
    const destroying = host.destroy('s-1');
    await vi.waitFor(() => expect(entry.session.listenerCount('transcript-event')).toBe(0));
    expect(releaseSession).not.toHaveBeenCalled();
    unblock();
    await destroying;
    expect(releaseSession).toHaveBeenCalledWith('s-1');
  });

  it('refuses handoff evidence after a swallowed append failure even when destroy and dispose succeed', async () => {
    const store = new SessionStore(new NativeHome(root));
    const append = store.append.bind(store);
    let failed = false;
    vi.spyOn(store, 'append').mockImplementation(async (cwd, event) => {
      if (!failed) { failed = true; throw new Error('disk unavailable'); }
      return append(cwd, event);
    });
    const dispose = vi.spyOn(store, 'dispose');
    host = new NativeSessionHost(store, factory, NO_CONTEXT, async () => null, async () => null);
    await host.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const captured = host.captureHandoffWriter('s-1');
    expect(captured?.transcriptPath).toBe(store.transcriptPath('s-1', root));
    host.send('s-1', 'hello');
    await waitForTurnComplete(host, 1);
    await host.drain('s-1');
    await host.destroy('s-1');
    expect(failed).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(captured?.persisted()).toBe(false);
  });

  it('refuses native evidence if stream disposal rejects after successful appends', async () => {
    const store = new SessionStore(new NativeHome(root));
    vi.spyOn(store, 'dispose').mockRejectedValueOnce(new Error('dispose failed'));
    host = new NativeSessionHost(store, factory, NO_CONTEXT, async () => null, async () => null);
    await host.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const captured = host.captureHandoffWriter('s-1');
    await expect(host.destroy('s-1')).rejects.toThrow('dispose failed');
    expect(captured?.persisted()).toBe(false);
  });

  it.each(['live', 'completed'])('a %s child append failure rejects parent handoff without wedging parent appends', async (phase) => {
    const store = new SessionStore(new NativeHome(root));
    const append = store.append.bind(store);
    let parentAppended = false;
    vi.spyOn(store, 'append').mockImplementation(async (cwd, event) => {
      if (event.sessionId === 'child-1') throw new Error('child disk failure');
      if (event.sessionId === 'root-1') parentAppended = true;
      return append(cwd, event);
    });
    host = new NativeSessionHost(store, factory, NO_CONTEXT, async () => null, async () => null);
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const captured = host.captureHandoffWriter('root-1');
    const child = new EventEmitter() as any;
    child.binding = { modelId: 'm' }; child.interrupt = vi.fn(); child.destroy = () => child.removeAllListeners();
    (host as any).wireChildLive('root-1', 'child-1', root, child, { providerId: 'openrouter', modelId: 'm' }, 'tc-1');
    child.emit('transcript-event', { sessionId: 'child-1', type: 'user-message', uuid: 'child-u', timestamp: Date.now(), data: { text: 'child' } });
    await host.drain('child-1');
    if (phase === 'completed') {
      await host.destroy('child-1');
      expect((host as any).childrenOf.get('root-1')?.has('child-1')).toBeFalsy();
    }
    (host as any).live.get('root-1').session.emit('transcript-event',
      { sessionId: 'root-1', type: 'user-message', uuid: 'root-u', timestamp: Date.now(), data: { text: 'parent' } });
    await host.drain('root-1');
    expect(parentAppended).toBe(true);
    await host.destroy('root-1');
    expect(captured?.persisted()).toBe(false);
    // A different generation with the same id must not inherit this failure.
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const resumed = host.captureHandoffWriter('root-1');
    await host.destroy('root-1');
    expect(resumed?.persisted()).toBe(true);
  });

  it('waits for a deregistered child still draining appends before certifying its parent', async () => {
    const store = new SessionStore(new NativeHome(root));
    const append = store.append.bind(store);
    const dispose = store.dispose.bind(store);
    const order: string[] = [];
    vi.spyOn(store, 'dispose').mockImplementation(async (id) => {
      if (id === 'root-1') order.push('parent-dispose');
      return dispose(id);
    });
    let started!: () => void, reject!: (e: Error) => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((_resolve, fail) => { reject = fail; });
    vi.spyOn(store, 'append').mockImplementation(async (cwd, event) => {
      if (event.sessionId === 'child-1') {
        started();
        try { await blocked; } catch (error) { order.push('child-failed'); throw error; }
      }
      return append(cwd, event);
    });
    host = new NativeSessionHost(store, factory, NO_CONTEXT, async () => null, async () => null);
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const captured = host.captureHandoffWriter('root-1');
    const child = new EventEmitter() as any;
    child.binding = { modelId: 'm' }; child.interrupt = vi.fn(); child.destroy = () => child.removeAllListeners();
    (host as any).wireChildLive('root-1', 'child-1', root, child, { providerId: 'openrouter', modelId: 'm' }, 'tc-1');
    child.emit('transcript-event', { sessionId: 'child-1', type: 'user-message', uuid: 'child-u', timestamp: Date.now(), data: { text: 'child' } });
    await entered;
    const childStop = host.destroy('child-1');
    await vi.waitFor(() => expect((host as any).childrenOf.get('root-1')?.has('child-1')).toBeFalsy());
    let enteredCascade!: () => void, releaseCascade!: () => void;
    const cascadeEntered = new Promise<void>((resolve) => { enteredCascade = resolve; });
    const cascadeGate = new Promise<void>((resolve) => { releaseCascade = resolve; });
    const cascade = (host as any).destroyChildrenOf.bind(host);
    vi.spyOn(host as any, 'destroyChildrenOf').mockImplementation(async (...args: unknown[]) => {
      const id = args[0] as string; // WHY: spyOn on an `any` host types the stub's args as unknown[]
      await cascade(id);
      if (id === 'root-1') { enteredCascade(); await cascadeGate; }
    });
    const parentStop = host.destroy('root-1');
    await cascadeEntered;
    releaseCascade();
    // Let the cascade's microtasks run to the next event-loop phase. Without
    // the fence, dispose begins here; with it, the parent is still awaiting child.
    await new Promise<void>((resolve) => setImmediate(resolve));
    reject(new Error('child write failed'));
    await childStop;
    await parentStop;
    // Assert event ordering, not scheduler speed. A parent that didn't join the
    // deregistered child could dispose before the child's append catches.
    expect(order).toEqual(['child-failed', 'parent-dispose']);
    expect(captured?.persisted()).toBe(false);
  });

  it('retains a failed child disposal on the parent after the child is deregistered', async () => {
    const store = new SessionStore(new NativeHome(root));
    const dispose = store.dispose.bind(store);
    let failed = false;
    vi.spyOn(store, 'dispose').mockImplementation(async (id) => {
      if (id === 'child-1' && !failed) { failed = true; throw new Error('child disposal failed'); }
      return dispose(id);
    });
    host = new NativeSessionHost(store, factory, NO_CONTEXT, async () => null, async () => null);
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const captured = host.captureHandoffWriter('root-1');
    const child = new EventEmitter() as any;
    child.binding = { modelId: 'm' }; child.interrupt = vi.fn(); child.destroy = () => child.removeAllListeners();
    (host as any).wireChildLive('root-1', 'child-1', root, child, { providerId: 'openrouter', modelId: 'm' }, 'tc-1');
    await expect(host.destroy('child-1')).rejects.toThrow('child disposal failed');
    expect((host as any).childrenOf.get('root-1')?.has('child-1')).toBeFalsy();
    await host.destroy('root-1');
    expect(captured?.persisted()).toBe(false);
    await host.destroy('child-1'); // failed child's retained entry is still cleanable
  });

  it('coalesces concurrent native teardown and certifies only its captured generation', async () => {
    const store = new SessionStore(new NativeHome(root));
    const dispose = vi.spyOn(store, 'dispose');
    host = new NativeSessionHost(store, factory, NO_CONTEXT, async () => null, async () => null);
    await host.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const captured = host.captureHandoffWriter('s-1');
    expect(captured?.persisted()).toBe(false);
    await Promise.all([host.destroy('s-1'), host.destroy('s-1')]);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(captured?.persisted()).toBe(true);
  });

  it('pendingAskEventsFor delegates to the broker for one session', () => {
    // Task 0 (ROADMAP #permissions): TRANSCRIPT_REPLAY needs a host-level
    // method to re-send open asks after a reload — this just proves the host
    // forwards to the broker rather than re-implementing the lookup.
    const emitted: any[] = [];
    host.on('hook-event', (e) => emitted.push(e));
    // Seed at the broker: the public askPermission delegate was deleted, so this is the honest fixture for the forwarding.
    void (host as any).broker.ask({ sessionId: 's1', toolName: 'Bash', toolInput: { command: 'npm test' }, denyListed: false });
    void (host as any).broker.ask({ sessionId: 's2', toolName: 'Read', toolInput: {}, denyListed: false });
    const events = host.pendingAskEventsFor('s1');
    expect(events).toHaveLength(1);
    expect(events[0].sessionId).toBe('s1');
    expect(events[0].type).toBe('PermissionRequest');
    expect(events[0].payload._requestId).toBe(emitted[0].payload._requestId);
  });

  it('exposes only active root progress and forgets it when idle or destroyed', async () => {
    await host.create({ sessionId: 's-progress', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const entry = (host as any).live.get('s-progress');
    const progress = { type: 'assistant-thinking', sessionId: 's-progress', uuid: 'progress', timestamp: 100,
      data: { usageProgress: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 } } };
    entry.session._currentUsageProgress = progress;
    expect(host.currentUsageProgressFor('s-progress')).toBeNull();
    entry.inFlight = true;
    expect(host.currentUsageProgressFor('s-progress')).toBe(progress);
    entry.inFlight = false;
    expect(host.currentUsageProgressFor('s-progress')).toBeNull();
    await host.destroy('s-progress');
    expect(host.currentUsageProgressFor('s-progress')).toBeNull();
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
    expect(looseData(history![1]).text).toBe('Hi there');   // coalesced on disk
    // 2026-09-16 C2: the IPC handlers read through the async twins, which must
    // answer exactly what the sync forms do; isLive answers the tear-off's
    // boolean without reading anything.
    expect(await host.getHistoryAsync('s-1')).toEqual(history);
    expect(await host.getHistoryPageAsync('s-1', null)).toEqual(host.getHistoryPage('s-1', null));
    expect(await host.getHistoryPageAsync('s-1', 2)).toEqual(host.getHistoryPage('s-1', 2));
    expect(host.isLive('s-1')).toBe(true);
    expect(host.isLive('nope')).toBe(false);
    expect(await host.getHistoryAsync('nope')).toBeNull();
    expect(await host.getHistoryPageAsync('nope', null)).toBeNull();
  });

  it('fresh roots persist and use one exact step-guard snapshot', async () => {
    const readGuard = vi.fn(() => 12);
    const guarded = new NativeSessionHost(
      new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      new SpecialistCatalog({ claudeUserDir: null }), readGuard,
    );
    await guarded.create({ sessionId: 'guarded', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    expect(readGuard).toHaveBeenCalledTimes(1);
    expect(new SessionStore(new NativeHome(root)).readHeader('guarded', root)?.stepGuard).toBe(12);
    expect((guarded as any).live.get('guarded').session.opts.harness.limits.maxSteps).toBe(12);
    await guarded.destroyAll();
  });

  it('resume uses the stored snapshot despite preference changes, while old and malformed headers use no guard', async () => {
    const store = new SessionStore(new NativeHome(root));
    let preference = 14;
    const guarded = new NativeSessionHost(
      store, factory, NO_CONTEXT, async () => null, async () => null,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      new SpecialistCatalog({ claudeUserDir: null }), () => preference,
    );
    await guarded.create({ sessionId: 'stored', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    await guarded.destroyAll();
    preference = 99;
    await guarded.resume('stored', root);
    expect((guarded as any).live.get('stored').session.opts.harness.limits.maxSteps).toBe(14);
    await guarded.destroyAll();

    const headerBase = { v: 1 as const, harnessId: 'assistant', binding: { providerId: 'openrouter', modelId: 'm' }, cwd: root, createdAt: Date.now() };
    await store.create({ ...headerBase, sessionId: 'old' });
    await new NativeHome(root).appendSessionLine(nativeStoreSlug(root), 'bad', { ...headerBase, sessionId: 'bad', stepGuard: 'oops' });
    for (const id of ['old', 'bad']) {
      const resumed = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        new SpecialistCatalog({ claudeUserDir: null }), () => 77,
      );
      expect(await resumed.resume(id, root)).toBe(true);
      expect((resumed as any).live.get(id).session.opts.harness.limits.maxSteps).toBeUndefined();
      await resumed.destroyAll();
    }
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

  // 2026-09-27: a transcript that EXISTS but cannot be read (a Windows lock) used
  // to read as no events, so the session resumed with no model memory, silently,
  // and its next turn republished that as the checkpoint.
  it('resume refuses, with a plain retryable message, when it cannot read the history', async () => {
    await host.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    host.send('s-1', 'hello');
    await waitForTurnComplete(host, 1);
    await host.drain('s-1');
    await host.destroyAll();

    const store2 = new SessionStore(new NativeHome(root));
    vi.spyOn(store2, 'readEventsAsync').mockRejectedValue(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
    const host2 = new NativeSessionHost(store2, factory, NO_CONTEXT, async () => null, async () => null);
    await expect(host2.resume('s-1', root)).rejects.toThrow(TRANSCRIPT_UNREADABLE_MESSAGE);
    expect(host2.isNative('s-1')).toBe(false);   // nothing half-started
    await host2.destroyAll();
  });

  it('resume rides out a brief lock on the saved conversation instead of refusing', async () => {
    await host.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    host.send('s-1', 'hello');
    await waitForTurnComplete(host, 1);
    await host.drain('s-1');
    await host.destroyAll();

    // The FIRST read of the session file — sync or async, whichever resume makes
    // first — fails as a Windows sharing lock would. A sync read cannot retry, so
    // resume must reach the file through the retrying async read.
    const busy = () => Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    const realAsync = fs.promises.readFile;
    const realSync = fsModule.readFileSync;
    let locked = 1;
    const isSession = (file: any) => String(file).endsWith('s-1.jsonl');
    const asyncSpy = vi.spyOn(fs.promises, 'readFile').mockImplementation((async (file: any, ...rest: any[]) => {
      if (isSession(file) && locked-- > 0) throw busy();
      return (realAsync as any)(file, ...rest);
    }) as any);
    const syncSpy = vi.spyOn(fsModule, 'readFileSync').mockImplementation(((file: any, ...rest: any[]) => {
      if (isSession(file) && locked-- > 0) throw busy();
      return (realSync as any)(file, ...rest);
    }) as any);
    syncBuiltinESMExports();
    const host2 = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null);
    try {
      expect(await host2.resume('s-1', root)).toBe(true);
      expect(locked).toBeLessThan(0);                     // the lock really was hit
    } finally { asyncSpy.mockRestore(); syncSpy.mockRestore(); syncBuiltinESMExports(); }
    try { expect(host2.getHistory('s-1')!.length).toBe(3); }   // with its memory, not an empty one
    finally { await host2.destroyAll(); }
  });

  it('an unreadable history makes the page read throw (the caller answers unresolved), never an empty page', async () => {
    await host.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const spy = vi.spyOn((host as any).store, 'readEventsAsync').mockRejectedValue(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
    await expect(host.getHistoryPageAsync('s-1', null)).rejects.toThrow('EBUSY');
    spy.mockRestore();
    expect(await host.getHistoryPageAsync('s-1', null)).not.toBeNull();
  });

  // resume's bindingOverride must be applied INSIDE resume() (ipc-handlers reads modelForSession() the instant it returns), not via a later setBinding.
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

  it('continueTurn (Try again / Keep going) is refused for an unknown session and while a turn runs; idle, it runs a turn with no new message', async () => {
    expect(host.continueTurn('ghost')).toBe(false);
    await host.create({ sessionId: 's-ct', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const entry = (host as any).live.get('s-ct');
    entry.inFlight = true;
    expect(host.continueTurn('s-ct')).toBe(false);   // a press mid-turn never starts a second run
    entry.inFlight = false;
    // A real exchange first: Try again only follows a turn that ran.
    host.send('s-ct', 'hello');
    await waitForTurnComplete(host, 1);
    await entry.running;
    const users: string[] = []; const types: string[] = [];
    host.on('transcript-event', (e: any) => { types.push(e.type); if (e.type === 'user-message') users.push(e.data.text); });
    expect(host.continueTurn('s-ct')).toBe(true);
    await entry.running;
    expect(types).toContain('turn-complete');
    expect(users).toEqual([]);
    expect(host.isIdle('s-ct')).toBe(true);
  });

  it('getHistory returns null for unknown/non-native sessions (replay falls through to CC)', () => {
    expect(host.getHistory('nope')).toBeNull();
  });

  // M1: send() is now synchronous and returns a NativeSendResult (not a
  // Promise<boolean>) — 'not-live' replaces the old bare `false`.
  it('send to an unknown session returns failed/not-live, does not throw', () => {
    expect(host.send('ghost', 'x')).toEqual({ status: 'failed', reason: 'not-live' });
  });

  // A message typed while the session is STARTING is refused (draft stays on screen), not queued non-durably.

  it('refuses input during startup and only sends it after a fresh explicit submission', async () => {
    const creating = host.create({ sessionId: 's-warmup', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    expect(host.send('s-warmup', 'keep as a draft')).toEqual({ status: 'failed', reason: 'initializing' });
    await creating; await host.drain('s-warmup');
    expect(host.queuedMessagesFor('s-warmup')).toEqual([]);
    expect(host.getHistory('s-warmup')).toEqual([]);
    expect(host.send('s-warmup', 'keep as a draft')).toEqual({ status: 'sent' });
    await waitForTurnComplete(host, 1);
    await (host as any).live.get('s-warmup').running;
    await host.drain('s-warmup');
    const typed = host.getHistory('s-warmup')!.filter(e => e.type === 'user-message');
    expect(typed).toHaveLength(1);
    expect(typed[0].data.text).toBe('keep as a draft');
  });

  it('does not silently deliver any input refused before startup readiness', async () => {
    const creating = host.create({ sessionId: 's-warmup2', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    expect(host.send('s-warmup2', 'first').status).toBe('failed');
    expect(host.send('s-warmup2', 'second').status).toBe('failed');
    await creating; await host.drain('s-warmup2');
    expect(host.getHistory('s-warmup2')).toEqual([]);
    expect(host.queuedMessagesFor('s-warmup2')).toEqual([]);
  });

  it('a session that has ENDED still gets the ended message, not the starting one', async () => {
    // The whole point of the split: this must NOT become "starting".
    await host.create({ sessionId: 's-gone', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    await host.destroy('s-gone');
    expect(host.send('s-gone', 'x')).toEqual({ status: 'failed', reason: 'not-live' });
    // And an id nothing ever created is the same case.
    expect(host.send('never-existed', 'x')).toEqual({ status: 'failed', reason: 'not-live' });
  });

  it('uses the initializing reason without ever acknowledging an early holding queue', async () => {
    const creating = host.create({ sessionId: 's-warmup3', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    for (let i = 0; i < 11; i++) expect(host.send('s-warmup3', `m${i}`)).toEqual({ status: 'failed', reason: 'initializing' });
    expect(host.queuedMessageIds('s-warmup3')).toEqual([]);
    await creating;
    await host.destroy('s-warmup3');
  });

  it('does not invent a queued item for an unaccepted startup draft', async () => {
    const creating = host.create({ sessionId: 's-warmup4', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    expect(host.send('s-warmup4', 'still in the composer')).toEqual({ status: 'failed', reason: 'initializing' });
    expect(host.removeQueued('s-warmup4', 'unaccepted')).toBe(false);
    expect(host.sendQueuedNow('s-warmup4', 'unaccepted')).toBe(false);
    await creating; await host.drain('s-warmup4');
    expect(host.getHistory('s-warmup4')!.filter(e => e.type === 'user-message')).toHaveLength(0);
    await host.destroy('s-warmup4');
  });

  it('a failed startup leaves no accepted message or live generation behind', async () => {
    // Nothing was accepted: the failed create cannot later submit the caller's draft.
    const store = new SessionStore(new NativeHome(root));
    vi.spyOn(store, 'create').mockRejectedValue(new Error('disk is full'));
    const doomed = new NativeSessionHost(store, factory, NO_CONTEXT, async () => null, async () => null);
    const creating = doomed.create({ sessionId: 's-doomed', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    expect(doomed.send('s-doomed', 'unsent draft')).toEqual({ status: 'failed', reason: 'initializing' });
    await expect(creating).rejects.toThrow();
    // Back to the honest answer for a session that is not coming.
    expect(doomed.send('s-doomed', 'again')).toEqual({ status: 'failed', reason: 'not-live' });
    await doomed.destroyAll();
  });


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

  // Single-writer guard: resume() on a live id must destroy the orphan, or its listener keeps appending to the same JSONL.
  // Asserts on APPEND CALLS, not map state — a map assertion would pass on the broken code.
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

    // The aborted old stream must write nothing more; give its remaining 15ms chunk delays room to fire if abort did not take.
    const afterResume = appends.length;
    // settle (negative assertion): the aborted stream must write nothing more.
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

  // destroyAll() must also tear down pooled MCP connections, or an MCP subprocess outlives the app.
  describe('MCP teardown', () => {
    it('destroyAll() also tears down the pooled MCP connections', async () => {
      const mcpDestroyAll = vi.fn(async () => {});
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined,
        { destroyAll: mcpDestroyAll, acquire: vi.fn() }, // WHY acquire: required by the manager type; this test never opens a session
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
  describe('MCP session wiring', () => {
    const fakeServer = (id: string) => ({
      id, label: id, tools: [], call: async () => ({ text: 'ok', isError: false }),
    });

    // A lease whose release() is a spy — the manager's release is no longer a
    // method on the manager, so the host can only give a hold back through the
    // object acquire() returned. See McpLease in mcp-manager.ts.
    const fakeLease = (servers: any[], release = vi.fn(async () => {})) => ({ servers, release });

    it('opens history without waiting for tools and refuses unsent input instead of queueing it', async () => {
      let finish!: (value: ReturnType<typeof fakeLease>) => void;
      const acquire = vi.fn(() => new Promise<ReturnType<typeof fakeLease>>(resolve => { finish = resolve; }));
      const model = vi.fn(factory);
      const h = new NativeSessionHost(new SessionStore(new NativeHome(root)), model, NO_CONTEXT,
        async () => null, async () => null, undefined, undefined, undefined, undefined, undefined,
        { destroyAll: async () => {}, acquire });
      let opened = false;
      const opening = h.create({ sessionId: 'slow-tools', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } }).then(() => { opened = true; });
      try {
        await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
        expect(h.send('slow-tools', 'keep this draft', ['/tmp/fixture-image.png'])).toMatchObject({ status: 'failed', reason: 'initializing' });
        await vi.waitFor(() => expect(opened).toBe(true));
        expect(h.queuedMessagesFor('slow-tools')).toEqual([]);
        expect(model).not.toHaveBeenCalled();
      } finally {
        finish(fakeLease([])); await opening; await h.destroyAll();
      }
    });

    it('parks durable background reports before claiming them while tools are connecting', async () => {
      const home = new NativeHome(root), store = new SessionStore(home);
      await store.create({ v: 1, sessionId: 'pending-report', cwd: root, harnessId: 'coder', createdAt: Date.now(), binding: { providerId: 'openrouter', modelId: 'm' } });
      let finish!: (value: ReturnType<typeof fakeLease>) => void;
      const acquire = vi.fn(() => new Promise<ReturnType<typeof fakeLease>>(resolve => { finish = resolve; }));
      const model = vi.fn(factory);
      const h = new NativeSessionHost(store, model, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, { acquire, destroyAll: async () => {} }, home);
      const ledger = (h as any).ledger as DelegationLedger;
      await ledger.recordStart(root, 'pending-report', { childId: 'done-child', parentToolCallId: 'tc', agentType: 'explorer', title: 'Report',
        workDir: root, description: 'fixture', background: true, status: 'completed', startedAt: Date.now(), endedAt: Date.now(),
        delivered: false, rawReport: 'durable report', owner: OWNER, missedSteers: [] });
      const claim = vi.spyOn(ledger, 'claimUndelivered');
      const result = fakeLease([]);
      try {
        await h.resume('pending-report', root);
        expect(h.startupStateFor('pending-report')?.phase).toBe('connecting');
        expect((h as any).live.get('pending-report').inFlight).toBe(false);
        // Settle the host's startup reconciliation, not a guessed wall-clock delay.
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(claim).not.toHaveBeenCalled();
        expect(ledger.listFor(root, 'pending-report')[0].injectionAttempted).not.toBe(true);
        expect(model).not.toHaveBeenCalled();
        const completed = waitForTurnComplete(h, 1);
        finish(result); await completed;
        await vi.waitFor(() => expect(ledger.listFor(root, 'pending-report')[0].delivered).toBe(true));
        expect(model).toHaveBeenCalledOnce();
      } finally { finish(result); await h.destroyAll(); }
    });

    it('does not consume a background report when close wins after its durable injection marker', async () => {
      const home = new NativeHome(root), store = new SessionStore(home), model = vi.fn(factory);
      const h = new NativeSessionHost(store, model, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, home);
      await h.create({ sessionId: 'closing-report', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const ledger = (h as any).ledger as DelegationLedger;
      await ledger.recordStart(root, 'closing-report', { childId: 'done-child', parentToolCallId: 'tc', agentType: 'explorer', title: 'Report',
        workDir: root, description: 'fixture', background: true, status: 'completed', startedAt: Date.now(), endedAt: Date.now(),
        delivered: false, rawReport: 'durable report', owner: OWNER, missedSteers: [] });
      let finish!: () => void, entered!: () => void;
      const held = new Promise<void>(resolve => { finish = resolve; });
      const marked = new Promise<void>(resolve => { entered = resolve; });
      const realMark = ledger.markInjectionAttempted.bind(ledger);
      const mark = vi.spyOn(ledger, 'markInjectionAttempted').mockImplementation(async (...args) => { await realMark(...args); entered(); await held; });
      (h as any).queueDelivery('closing-report');
      await marked;
      const running = (h as any).live.get('closing-report').running;
      const closing = h.destroy('closing-report'); finish(); await Promise.all([closing, running]);
      expect(model).not.toHaveBeenCalled();
      expect(ledger.listFor(root, 'closing-report')[0].injectionAttempted).not.toBe(true);
      mark.mockRestore();
      const delivered = waitForTurnComplete(h, 1);
      await h.resume('closing-report', root); await delivered;
      await vi.waitFor(() => expect(ledger.listFor(root, 'closing-report')[0].delivered).toBe(true));
      expect(model).toHaveBeenCalledOnce();
      await h.destroyAll();
    });

    it('rearms a report when the replacement scanned before the old injection marker was cleared', async () => {
      const home = new NativeHome(root), store = new SessionStore(home), model = vi.fn(factory);
      const h = new NativeSessionHost(store, model, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, home);
      const id = 'replacement-report';
      await h.create({ sessionId: id, cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const ledger = (h as any).ledger as DelegationLedger;
      await ledger.recordStart(root, id, { childId: 'done-child', parentToolCallId: 'tc', agentType: 'explorer', title: 'Report',
        workDir: root, description: 'fixture', background: true, status: 'completed', startedAt: Date.now(), endedAt: Date.now(),
        delivered: false, rawReport: 'durable report', owner: OWNER, missedSteers: [] });
      let finish!: () => void, entered!: () => void, first = true;
      const held = new Promise<void>(resolve => { finish = resolve; });
      const marked = new Promise<void>(resolve => { entered = resolve; });
      const realMark = ledger.markInjectionAttempted.bind(ledger);
      const mark = vi.spyOn(ledger, 'markInjectionAttempted').mockImplementation(async (...args) => {
        await realMark(...args);
        if (first) { first = false; entered(); await held; }
      });
      let outgoing: Promise<void> | undefined;
      try {
        (h as any).queueDelivery(id); await marked;
        outgoing = (h as any).live.get(id).running;
        // Close must not await an optional/outgoing pass. Let the replacement scan
        // the still-stamped record before allowing that old pass to clean it up.
        await h.destroy(id);
        await h.resume(id, root);
        await (h as any).live.get(id).running;
        expect((h as any).pendingDeliveryParents.has(id)).toBe(false);
        expect(ledger.listFor(root, id)[0].injectionAttempted).toBe(true);
        expect(model).not.toHaveBeenCalled();
        finish(); await outgoing;
        await vi.waitFor(() => expect(ledger.listFor(root, id)[0].delivered).toBe(true));
        await h.drain(id);
        expect(model).toHaveBeenCalledOnce();
      } finally { finish(); await outgoing; mark.mockRestore(); await h.destroyAll(); }
    });

    it('an outgoing generation releases only its own delivery claim, not the replacement claim', async () => {
      const home = new NativeHome(root), store = new SessionStore(home), model = vi.fn(factory);
      const h = new NativeSessionHost(store, model, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, home);
      const id = 'claim-replacement-report';
      await h.create({ sessionId: id, cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const ledger = (h as any).ledger as DelegationLedger;
      await ledger.recordStart(root, id, { childId: 'done-child', parentToolCallId: 'tc', agentType: 'explorer', title: 'Report',
        workDir: root, description: 'fixture', background: true, status: 'completed', startedAt: Date.now(),
        delivered: false, rawReport: 'durable report', owner: OWNER, missedSteers: [] });
      let releaseOld!: () => void, releaseNew!: () => void, oldClaimed!: () => void, newClaimed!: () => void;
      const oldHeld = new Promise<void>(resolve => { releaseOld = resolve; });
      const newHeld = new Promise<void>(resolve => { releaseNew = resolve; });
      const oldReady = new Promise<void>(resolve => { oldClaimed = resolve; });
      const newReady = new Promise<void>(resolve => { newClaimed = resolve; });
      const realClaim = ledger.claimUndelivered.bind(ledger);
      let claims = 0;
      const claim = vi.spyOn(ledger, 'claimUndelivered').mockImplementation(async (...args) => {
        const record = await realClaim(...args);
        if (++claims === 1) { oldClaimed(); await oldHeld; }
        else if (claims === 2) { newClaimed(); await newHeld; }
        return record;
      });
      let outgoing: Promise<void> | undefined;
      try {
        (h as any).queueDelivery(id); await oldReady;
        outgoing = (h as any).live.get(id).running;
        const oldToken = ledger.listFor(root, id)[0].deliveryClaimId;
        await h.destroy(id); await h.resume(id, root); await newReady;
        const newToken = ledger.listFor(root, id)[0].deliveryClaimId;
        expect(newToken).toBeDefined(); expect(newToken).not.toBe(oldToken);
        releaseOld(); await outgoing;
        expect(ledger.listFor(root, id)[0].deliveryClaimId).toBe(newToken);
        expect(ledger.listFor(root, id)[0].claimedBy).toEqual(OWNER);
        releaseNew(); await (h as any).live.get(id).running;
        expect(ledger.listFor(root, id)[0].delivered).toBe(true);
        expect(model).toHaveBeenCalledOnce();
      } finally {
        releaseOld(); releaseNew(); await outgoing;
        await (h as any).live.get(id)?.running;
        claim.mockRestore(); await h.destroyAll();
      }
    });

    it('keeps an unstarted report pending when both rollback and its recovery claim fail', async () => {
      const home = new NativeHome(root), store = new SessionStore(home), model = vi.fn(factory);
      const h = new NativeSessionHost(store, model, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, home);
      const id = 'retry-claim-report';
      await h.create({ sessionId: id, cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const ledger = (h as any).ledger as DelegationLedger;
      await ledger.recordStart(root, id, { childId: 'done-child', parentToolCallId: 'tc', agentType: 'explorer', title: 'Report',
        workDir: root, description: 'fixture', background: true, status: 'completed', startedAt: Date.now(), endedAt: Date.now(),
        delivered: false, rawReport: 'durable report', owner: OWNER, missedSteers: [] });
      let finish!: () => void, entered!: () => void;
      const held = new Promise<void>(resolve => { finish = resolve; });
      const marked = new Promise<void>(resolve => { entered = resolve; });
      const realMark = ledger.markInjectionAttempted.bind(ledger);
      vi.spyOn(ledger, 'markInjectionAttempted').mockImplementation(async (...args) => { await realMark(...args); entered(); await held; });
      try {
        (h as any).queueDelivery(id); await marked;
        const outgoing = (h as any).live.get(id).running;
        await h.destroy(id); await h.resume(id, root);
        await (h as any).live.get(id).running;
        const failed = Object.assign(new Error('fixture storage unavailable'), { code: 'ENOSPC' });
        const writes = vi.spyOn(home, 'mutateJson').mockRejectedValueOnce(failed).mockRejectedValueOnce(failed);
        finish(); await outgoing; await (h as any).live.get(id).running;
        expect(writes).toHaveBeenCalledTimes(2); // cancellation + one recovery pass; no busy retry loop
        expect((h as any).pendingDeliveryParents.has(id)).toBe(true);
        expect(model).not.toHaveBeenCalled();
        writes.mockRestore();
        expect(h.send(id, 'storage recovered')).toMatchObject({ status: 'sent' });
        await vi.waitFor(() => expect(ledger.listFor(root, id)[0].delivered).toBe(true));
        await h.drain(id);
        expect(model).toHaveBeenCalledTimes(2); // one explicit user turn, one report
      } finally { finish(); vi.restoreAllMocks(); await h.destroyAll(); }
    });

    it.each(['before', 'after'] as const)('recovers an unstarted report after rollback fails %s committing', async failure => {
      const home = new NativeHome(root), store = new SessionStore(home), model = vi.fn(factory);
      const h = new NativeSessionHost(store, model, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, home);
      const id = 'rollback-report';
      await h.create({ sessionId: id, cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const ledger = (h as any).ledger as DelegationLedger;
      await ledger.recordStart(root, id, { childId: 'done-child', parentToolCallId: 'tc', agentType: 'explorer', title: 'Report',
        workDir: root, description: 'fixture', background: true, status: 'completed', startedAt: Date.now(), endedAt: Date.now(),
        delivered: false, rawReport: 'durable report', owner: OWNER, missedSteers: [] });
      let finish!: () => void, entered!: () => void;
      const held = new Promise<void>(resolve => { finish = resolve; });
      const marked = new Promise<void>(resolve => { entered = resolve; });
      const realMark = ledger.markInjectionAttempted.bind(ledger);
      vi.spyOn(ledger, 'markInjectionAttempted').mockImplementation(async (...args) => { await realMark(...args); entered(); await held; });
      const realMutate = home.mutateJson.bind(home);
      try {
        (h as any).queueDelivery(id); await marked;
        const outgoing = (h as any).live.get(id).running;
        await h.destroy(id);
        // Fail only the cancellation write, leaving subsequent recovery writes healthy.
        vi.spyOn(home, 'mutateJson').mockImplementationOnce(async (...args) => {
          if (failure === 'after') await realMutate(...args);
          throw Object.assign(new Error('fixture rollback write failure'), { code: 'ENOSPC' });
        });
        finish(); await outgoing;
        expect(model).not.toHaveBeenCalled();
        await h.resume(id, root);
        await vi.waitFor(() => expect(ledger.listFor(root, id)[0].delivered).toBe(true));
        await h.drain(id);
        expect(model).toHaveBeenCalledOnce();
      } finally { finish(); vi.restoreAllMocks(); await h.destroyAll(); }
    });

    it('does not wire a conversation closed while its startup header is being read', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(store, factory, NO_CONTEXT, async () => null, async () => null);
      await h.create({ sessionId: 'closed-start', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      await h.destroy('closed-start');
      const read = store.readHeaderAsync.bind(store);
      let finish!: () => void;
      const held = new Promise<void>(resolve => { finish = resolve; });
      const probe = vi.spyOn(store, 'readHeaderAsync').mockImplementation(async (...args) => { await held; return read(...args); });
      const reopening = h.resume('closed-start', root);
      // Observe rejection immediately so a failed fixture cannot leave an unhandled promise.
      const outcome = reopening.then(() => 'opened', () => 'cancelled');
      await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
      await h.destroy('closed-start'); finish();
      expect(await outcome).toBe('cancelled');
      expect(h.isNative('closed-start')).toBe(false);
      await h.destroyAll();
    });

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

    // Destroy -> resume -> destroy: each generation releases exactly its own lease once (a resume acquires a FRESH lease).
    // Generation discrimination itself is mutation-tested in mcp-manager.test.ts.
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

  // reserveSpecialist/releaseReservation driven directly (keyed by an arbitrary parent id); slot check AND writer-busy check are one synchronous call.
  describe('specialist slot + writer-lock bookkeeping', () => {
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
      // Releasing every reservation must not leave a 0 entry in the map.
      for (const t of tokens) host.releaseReservation(t);
      expect((host as any).specialistSlots.has('A')).toBe(false);
    });

    it('releasing a token for a parent with no live reservation is a harmless no-op', () => {
      expect(() => host.releaseReservation({ parentId: 'never-reserved', writer: false })).not.toThrow();
      expect((host as any).specialistSlots.has('never-reserved')).toBe(false);
    });

    it('writer lock: busy only for the parent that holds it, never an unrelated parent; clearing it frees the parent up', () => {
      // Read the Map directly: no public getter/setter exists, and a sibling Task call's in-flight writer lock is only observable there.
      expect((host as any).activeWriterChild.has('A')).toBe(false);
      (host as any).activeWriterChild.set('A', 'child-x');
      expect((host as any).activeWriterChild.has('A')).toBe(true);
      expect((host as any).activeWriterChild.has('B')).toBe(false);     // per-parent isolation
      (host as any).activeWriterChild.delete('A');
      expect((host as any).activeWriterChild.has('A')).toBe(false);
    });

    // Slot + writer checked and set in ONE synchronous call: two Task calls in the same parallel step must not both win the writer lock.
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

  // maxSpecialistsFor resolves the PARENT's live CapabilityProfile (a local ceiling can be below hosted's); no live parent -> the hosted constant.
  describe('the assumed window for an unknown custom endpoint', () => {
    const providerTypeFor = async () => 'openai-compatible';
    it('follows whether the context lookup says the address is on this computer', async () => {
      const ctx = async (b: any) => ({ contextLength: null, totalSlots: null, onThisComputer: b.modelId === 'here' });
      const h = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, ctx as any, providerTypeFor as any, async () => null);
      await h.create({ sessionId: 'here', cwd: root, binding: { providerId: 'c1', modelId: 'here' } });
      await h.create({ sessionId: 'away', cwd: root, binding: { providerId: 'c1', modelId: 'away' } });
      expect((h as any).live.get('here').session.profileSnapshot.assumedContextWindow).toBe(32_768);
      expect((h as any).live.get('away').session.profileSnapshot.assumedContextWindow).toBe(250_000);
      await h.destroyAll();
    });
  });

  describe('specialist concurrency cap follows the profile', () => {
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

    // A contextAndSlotsFor closure reporting 2 live slots for a KNOWN local model must make the host enforce 2 (not the floor of 1, not hosted 4).
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

    // Two overlapping create() calls for DIFFERENT local bindings with DIFFERENT slot counts: each session's cap is its own (the old shared-variable design crossed them).
    // Slots unknown at create (engine status never loads a model) -> floor of 1; the host re-reads once after the first turn.
    it('a local model whose slots were unknown at create re-reads them after its first turn and lifts the cap', async () => {
      let reads = 0;
      const lateSlots = async (b: any) => ({
        contextLength: b.providerId === 'local' ? 8192 : 200_000,
        // First read: not loaded yet → unknown. Every later read: 4 slots.
        totalSlots: b.providerId === 'local' ? (reads++ === 0 ? null : 4) : null,
      });
      const h = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, lateSlots as any, providerTypeFor as any, async () => null);
      await h.create({ sessionId: 'local-late', cwd: root, binding: { providerId: 'local', modelId: 'qwen3.6-35b-moe-q4' } });
      expect(h.reserveSpecialist('local-late', { writer: false }).ok).toBe(true);
      expect(h.reserveSpecialist('local-late', { writer: false })).toEqual({ ok: false, reason: 'at-capacity', max: 1 });
      expect((h as any).live.get('local-late').refreshSlotsAfterTurn).toBe(true);

      h.send('local-late', 'hi');
      await (h as any).live.get('local-late').running;
      await h.drain('local-late');

      expect(reads).toBe(2);
      expect((h as any).live.get('local-late').refreshSlotsAfterTurn).toBe(false);
      expect((h as any).live.get('local-late').session.profileSnapshot.maxConcurrentSpecialists).toBe(4);
      // One reservation is still held from above; three more fit under the real ceiling.
      for (let i = 0; i < 3; i++) expect(h.reserveSpecialist('local-late', { writer: false }).ok).toBe(true);
      expect(h.reserveSpecialist('local-late', { writer: false })).toEqual({ ok: false, reason: 'at-capacity', max: 4 });

      // A second turn does not ask again — the flag is one-shot once answered.
      h.send('local-late', 'again');
      await (h as any).live.get('local-late').running;
      await h.drain('local-late');
      expect(reads).toBe(2);
      await h.destroyAll();
    });

    // The post-turn re-read must also apply a corrected context window even when the helper cap already matches (else the gauge denominator stays optimistic).
    it('applies a corrected context window after the first turn even when the helper cap is unchanged', async () => {
      let reads = 0;
      const lateWindow = async (b: any) => {
        const first = reads++ === 0;
        return b.providerId === 'local'
          // Cap: unknown first (→ the one-helper floor), then 1 — the SAME cap,
          // which is what used to make the whole reading get dropped. Window:
          // the configured 32k guess first, then the engine's real 8k.
          ? { contextLength: first ? 32_768 : 8192, totalSlots: first ? null : 1 }
          : { contextLength: 200_000, totalSlots: null };
      };
      const h = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, lateWindow as any, providerTypeFor as any, async () => null);
      await h.create({ sessionId: 'local-window', cwd: root, binding: { providerId: 'local', modelId: 'qwen3.6-35b-moe-q4' } });
      const entry = (h as any).live.get('local-window');
      expect(entry.session.contextWindowTokens).toBe(32_768);
      const capBefore = entry.session.profileSnapshot.maxConcurrentSpecialists;

      h.send('local-window', 'hi');
      await entry.running;
      await h.drain('local-window');

      expect(reads).toBe(2);
      // The cap genuinely did not move — so this pins the WINDOW, not a cap
      // change smuggling the window along with it.
      expect(entry.session.profileSnapshot.maxConcurrentSpecialists).toBe(capBefore);
      expect(entry.session.contextWindowTokens).toBe(8192);
      await h.destroyAll();
    });

    // Review 2026-09-16: a picker swap that lands WHILE the post-turn re-read
    // is in the air must win — the stale reading is for the model the user
    // just left and must not put the session back on it.
    it('a model swap landing during the post-turn re-read is not reverted by it', async () => {
      let releaseRead: () => void = () => {};
      let reads = 0;
      const slowSlots = async (b: any) => {
        reads++;
        if (b.modelId === 'qwen3.6-35b-moe-q4' && reads === 2) await new Promise<void>((r) => { releaseRead = r; });
        // 2 slots, not 4: a stale local cap of 2 differs from the hosted ceiling,
        // so a wrongly applied reading would visibly revert the swap.
        return { contextLength: 8192, totalSlots: b.providerId === 'local' ? (reads === 1 ? null : 2) : null };
      };
      const h = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, slowSlots as any, providerTypeFor as any, async () => null);
      await h.create({ sessionId: 'local-race', cwd: root, binding: { providerId: 'local', modelId: 'qwen3.6-35b-moe-q4' } });
      h.send('local-race', 'hi');
      await vi.waitFor(() => expect(reads).toBe(2));            // the re-read is now in flight
      await h.setBinding('local-race', { providerId: 'openrouter', modelId: 'gpt-4o' });
      releaseRead();
      await (h as any).live.get('local-race').running;
      await h.drain('local-race');
      expect((h as any).live.get('local-race').session.binding).toEqual({ providerId: 'openrouter', modelId: 'gpt-4o' });
      expect((h as any).live.get('local-race').session.profileSnapshot.maxConcurrentSpecialists).toBe(HOSTED_MAX_CONCURRENT_SPECIALISTS);
      await h.destroyAll();
    });

    it('a hosted parent never re-reads — the flag is a local-engine concern', async () => {
      let reads = 0;
      const counting = async () => { reads++; return { contextLength: 200_000, totalSlots: null }; };
      const h = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, counting as any, providerTypeFor as any, async () => null);
      await h.create({ sessionId: 'cloud-late', cwd: root, binding: { providerId: 'openrouter', modelId: 'gpt-4o' } });
      expect((h as any).live.get('cloud-late').refreshSlotsAfterTurn).toBeUndefined();
      h.send('cloud-late', 'hi');
      await (h as any).live.get('cloud-late').running;
      await h.drain('cloud-late');
      expect(reads).toBe(1);
      await h.destroyAll();
    });

    it('two overlapping local-engine session starts each resolve their OWN slot count — no cross-talk', async () => {
      let releaseA: () => void;
      const stallA = new Promise<void>((res) => { releaseA = res; });
      // Both ids must match KNOWN_MODELS (an unknown local model floors to 1 regardless, masking the cross-talk). model-a's read stalls while model-b's lands.
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

    // visionSupportFor's discovered value must reach the profile; a cloud openrouter binding has no provider default, so `true` can only come from the closure.
    it('a discovered supportsVision:true from visionSupportFor reaches the resolved profile', async () => {
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, contextAndSlotsFor as any, providerTypeFor as any,
        async () => true,
      );
      await h.create({ sessionId: 'v', cwd: root, binding: { providerId: 'openrouter', modelId: 'vision-model' } });
      expect(profileOf(h, 'v').supportsVision).toBe(true);
      await h.destroyAll();
    });

    // Same wiring for a LOCAL-ENGINE binding ('mystery-3b' matches no KNOWN_MODELS, local-engine is not a vision provider): the closure's `true` is the only source.
    it('a discovered supportsVision:true reaches the profile of a LOCAL-ENGINE binding too', async () => {
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
    it('a discovered supportsVision:false keeps a LOCAL-ENGINE profile text-only', async () => {
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, contextAndSlotsFor as any, providerTypeFor as any,
        async () => false,
      );
      await h.create({ sessionId: 'lt', cwd: root, binding: { providerId: 'local', modelId: 'mystery-3b' } });
      expect(profileOf(h, 'lt').supportsVision).toBe(false);
      await h.destroyAll();
    });

    // A closure answering null leaves the profile as before (openrouter -> supportsVision false).
    it('visionSupportFor returning null leaves the profile exactly as it was before this task', async () => {
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, contextAndSlotsFor as any, providerTypeFor as any,
        async () => null,
      );
      await h.create({ sessionId: 'v2', cwd: root, binding: { providerId: 'openrouter', modelId: 'unknown-model' } });
      expect(profileOf(h, 'v2').supportsVision).toBe(false);
      await h.destroyAll();
    });

    // The registry context ceiling is LOCAL only: a hosted id matching a local family (qwen/qwen3.5-9b) must not be clamped; the same id on local-engine is.
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
      // Deny-listed Bash is the only ask full-auto still raises; mode is flipped AFTER create(), so this pins read-at-ask-time.
      const bashFactory = async () => scriptedModel([
        stream(toolCallChunk('c1', 'Bash', { command: 'git push origin master' }), finishChunk('tool-calls')),
        stream(...textChunks('t', 'done'), finishChunk('stop')),
      ]) as any;
      const p = new NativeSessionHost(
        // 3rd arg must be NO_CONTEXT (object-returning), not `async () => null`, or resolveContextAndProfile's destructure fails.
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
      rules = await pollFor(() => store.rulesFor(root), (rules) => rules.some((r) => r.tool === 'Write' && r.action === 'allow'));
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

  // Revocation must reach a LIVE session: buildDecide unions disk rules with per-session `rememberedFor`, so a disk delete alone still grants.
  // Drives real turns and asserts whether the session asks again.
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
      const hit = await pollFor(async () => (await store.rulesFor(cwd)).find((r) => r.tool === 'Write' && r.action === 'allow'), (r) => !!r);
      if (!hit) throw new Error('the remembered Write rule never reached disk');
      return hit;
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

      // Never grants, never persists: only a session's in-memory copy can grant, which a slug-keyed drop must clear in BOTH sessions.
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

    // Cross-project bucket: a grant on a user-folder specialist applies in every project (stored under CROSS_PROJECT_SLUG, unioned by every decide, revoked in every live session). Drives the real buildDecide.
    describe('saved admin approvals', () => {
      it('reads a Full Auto admin grant across projects and stops using it immediately on mode change or revocation', async () => {
        const store = new PermissionStore(new NativeHome(root));
        const p = revokeHost(store);
        const cwdA = path.join(root, 'alpha'); const cwdB = path.join(root, 'beta');
        fs.mkdirSync(cwdA); fs.mkdirSync(cwdB);
        await p.create({ sessionId: 'a', cwd: cwdA, binding });
        await p.create({ sessionId: 'b', cwd: cwdB, binding });
        const rule: PermissionRule = { tool: 'AdminFullAuto', action: 'allow', match: 'exact' };
        (p as any).rememberRule('a', cwdA, rule);
        await vi.waitFor(async () => expect((await store.rulesFor(cwdB)).some(r => r.tool === 'AdminFullAuto')).toBe(true));
        expect((await store.list()).find(project => project.rules.some(r => r.tool === 'AdminFullAuto'))?.slug).toBe(CROSS_PROJECT_SLUG);
        const decideA = (p as any).buildDecide('a', cwdA, []);
        const decideB = (p as any).buildDecide('b', cwdB, []);
        for (const mode of ['ask', 'auto-edit', 'full-auto'] as const) {
          p.setPermissionMode('b', mode);
          const decision = await decideB('Bash', 'sudo true');
          expect(decision.passwordlessAdminAllowed === true).toBe(mode === 'full-auto');
          expect(decision.passwordlessAdminExact).toBeUndefined();
        }
        p.setPermissionMode('a', 'full-auto');
        expect((await decideA('Bash', 'sudo true')).passwordlessAdminAllowed).toBe(true);
        await p.revokeRule(CROSS_PROJECT_SLUG, rule);
        expect((await decideA('Bash', 'sudo true')).passwordlessAdminAllowed).toBeUndefined();
        expect((await decideB('Bash', 'sudo true')).passwordlessAdminAllowed).toBeUndefined();
        await p.destroyAll();
      });

      it('keeps an exact admin grant literal and project-scoped, including after a fresh host is created', async () => {
        const store = new PermissionStore(new NativeHome(root));
        const p = revokeHost(store);
        const rule: PermissionRule = { tool: 'Bash', pattern: 'sudo rm *.tmp', action: 'allow', match: 'exact' };
        await store.remember(root, rule);
        const decide = (p as any).buildDecide('a', root, []);
        expect(await decide('Bash', 'sudo rm *.tmp')).toMatchObject({ passwordlessAdminAllowed: true, passwordlessAdminExact: true });
        expect((await decide('Bash', 'sudo rm other.tmp')).passwordlessAdminAllowed).toBeUndefined();
        expect((await (p as any).buildDecide('b', path.join(root, 'other'), [])('Bash', 'sudo rm *.tmp')).passwordlessAdminAllowed).toBeUndefined();
        await p.destroyAll();
      });
    });

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
        await vi.waitFor(async () => expect((await store.rulesFor(cwdB)).length).toBeGreaterThan(0));

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

    // The reported bug: "Ask first" on a Coder conversation silently came back
    // as Auto-edit after a resume or an app restart, while the chip still said
    // ASK FIRST. A fresh host stands in for the restart.
    const hostWithHome = () => new NativeSessionHost(
      new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null, undefined,
      undefined, undefined, undefined, undefined, undefined, new NativeHome(root),
    );

    it('a resume restores the mode the user chose, not the preset default', async () => {
      const h = hostWithHome();
      await h.create({ sessionId: 'kept', cwd: root, binding, presetId: 'coder' });
      h.setPermissionMode('kept', 'ask');
      const saved = new PermissionModeStore(new NativeHome(root));
      await vi.waitFor(() => expect(saved.get('kept')).toBe('ask'));
      await h.destroyAll();

      const restarted = hostWithHome();
      expect(await restarted.resume('kept', root)).toBe(true);
      expect(restarted.getPermissionMode('kept')).toBe('ask');
      await restarted.destroyAll();
    });

    // No saved-file store here (no NativeHome passed), so only the in-memory
    // copy can carry the choice across close → reopen in one app run.
    it('a close and reopen in the same app run keeps the chosen mode in memory', async () => {
      const h = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null);
      await h.create({ sessionId: 'mem', cwd: root, binding, presetId: 'coder' });
      h.setPermissionMode('mem', 'ask');
      await h.destroy('mem');
      expect(await h.resume('mem', root)).toBe(true);
      expect(h.getPermissionMode('mem')).toBe('ask');
      await h.destroyAll();
    });

    it('rapid changes save the latest mode, whatever order the saves finish in', async () => {
      const saved = new PermissionModeStore(new NativeHome(root));
      let current: 'ask' | 'full-auto' = 'full-auto';
      const first = saved.set('rapid', () => current);   // started while on full-auto
      current = 'ask';                                    // the user moved on
      await Promise.all([first, saved.set('rapid', () => current)]);
      expect(saved.get('rapid')).toBe('ask');
    });

    it('a resume with nothing saved starts from the preset default', async () => {
      const h = hostWithHome();
      await h.create({ sessionId: 'unsaved', cwd: root, binding, presetId: 'coder' });
      await h.destroyAll();
      const restarted = hostWithHome();
      expect(await restarted.resume('unsaved', root)).toBe(true);
      expect(restarted.getPermissionMode('unsaved')).toBe('auto-edit');
      await restarted.destroyAll();
    });

    // The chip used to read the mode before create() had set it and keep the
    // 'ask' fallback; the push is what corrects it, so it must carry the REAL
    // mode, and every change must be pushed too.
    it('pushes the real mode when a session starts, resumes, or changes', async () => {
      const h = hostWithHome();
      const pushed: Array<{ sessionId: string; mode: string }> = [];
      h.on('permission-mode', (e) => pushed.push(e));
      await h.create({ sessionId: 'p1', cwd: root, binding, presetId: 'coder' });
      expect(pushed).toEqual([{ sessionId: 'p1', mode: 'auto-edit' }]);
      h.setPermissionMode('p1', 'full-auto');
      expect(pushed.at(-1)).toEqual({ sessionId: 'p1', mode: 'full-auto' });
      await h.destroy('p1');
      pushed.length = 0;
      expect(await h.resume('p1', root)).toBe(true);
      expect(pushed).toEqual([{ sessionId: 'p1', mode: 'full-auto' }]);
      await h.destroyAll();
    });
  });

  // ---- M1: per-session FIFO send queue + honest sent/queued/failed result ----
  describe('send queue (M1)', () => {
    // Fresh host per test on delayedFactory so a turn stays in flight across several synchronous send() calls.
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

    // One-core R5-4a: the waiting messages are announced as the host's queue, so every screen (not only the one that sent them) draws and
    // can cancel the same strip. Each change is ONE announcement carrying the whole queue.
    it('announces the queue on every change: a message waits, is cancelled, is sent next', async () => {
      const seen: Array<Array<{ queueId: string; content: string }>> = [];
      host.on('queue-changed', (e: any) => { expect(e.sessionId).toBe(id); seen.push(e.queue.map((q: any) => ({ queueId: q.queueId, content: q.content }))); });
      expect(host.send(id, 'first').status).toBe('sent');
      expect(seen, 'a message that starts a turn is not "waiting"').toEqual([]);
      const a = host.send(id, 'second') as { queueId: string };
      const b = host.send(id, 'third') as { queueId: string };
      expect(seen).toEqual([
        [{ queueId: a.queueId, content: 'second' }],
        [{ queueId: a.queueId, content: 'second' }, { queueId: b.queueId, content: 'third' }],
      ]);
      expect(host.removeQueued(id, a.queueId)).toBe(true);
      expect(seen.at(-1)).toEqual([{ queueId: b.queueId, content: 'third' }]);
      expect(host.queuedMessagesFor(id).map((q) => q.content)).toEqual(['third']);
      await waitForTurnComplete(host, 1);
      await vi.waitFor(() => expect(host.queuedMessagesFor(id)).toEqual([]));
      expect(seen.at(-1), 'once it is sent the strip is empty').toEqual([]);
      expect(host.queuedMessagesFor(id)).toEqual([]);
    });

    it('a repeat with the same waiting messages is not announced again', () => {
      const seen: unknown[] = [];
      host.on('queue-changed', (e: any) => seen.push(e));
      host.send(id, 'first');
      host.send(id, 'second');
      const n = seen.length;
      (host as any).announceQueue(id);
      expect(seen.length).toBe(n);
    });

    it('refuses compaction during a reply without fabricating a lifecycle', async () => {
      const ev: any[] = [];
      host.on('compaction', (e: any) => ev.push(e));
      host.send(id, 'busy');
      const refused = await host.compact(id);                 // a turn is in flight: refused
      expect(refused).toEqual({ ok: false, reason: 'turn-in-flight' });
      expect(ev).toEqual([]); // The refusal belongs only to the requester, never to the running reply's lifecycle.
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
      await waitForTurnComplete(host, 1);
      expect(events).toEqual(['first', 'second']); // user-message for 'second' fires only when drained
    });

    it('an over-limit picture queued behind a running turn still arrives as its prepared derivative', async () => {
      // Same shape as the FIFO test above, but on a vision provider with the
      // OpenAI picture limits (chatgpt), and a model that records each request.
      const prompts: any[] = [];
      const capturing = async () => new MockLanguageModelV4({ doStream: async (o: any) => {
        prompts.push(o);
        return { stream: delayedStream(CHUNKS, 15) };
      } }) as any;
      const h = new NativeSessionHost(new SessionStore(new NativeHome(root)), capturing, NO_CONTEXT, async () => 'chatgpt', async () => null);
      const sid = 'q-picture';
      await h.create({ sessionId: sid, cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      try {
        const events: any[] = [];
        h.on('transcript-event', (e: any) => { if (e.type === 'user-message') events.push(e); });
        const huge = path.join(root, 'huge.png'); fs.writeFileSync(huge, pngHeader(2904, 17528));
        const small = path.join(root, 'small.png'); fs.writeFileSync(small, pngHeader(610, 3686));
        // One turn-complete, as in the FIFO test: the queued head is claimed into the running turn.
        const done = waitForTurnComplete(h, 1);
        // first send starts a turn and is held open; the second is queued with the derivative as its model-facing path
        expect(h.send(sid, 'first')).toEqual({ status: 'sent' });
        expect(h.send(sid, 'picture', [huge], [small]).status).toBe('queued');
        await done;
        const event = events.find((e) => e.type === 'user-message' && e.data.attachments?.[0] === huge)!;
        expect(event.data.modelAttachments).toEqual([small]);
        const prompt = prompts.at(-1);                                           // the queued turn's request
        const user = prompt.prompt.filter((m: any) => m.role === 'user').at(-1);
        expect(providerFileBytes(user.content.find((p: any) => p.type === 'file'))).toEqual(pngHeader(610, 3686));
      } finally { await h.destroyAll(); }
    });

    it('a picture queued during a notice pass is drained as its own turn with its prepared derivative', async () => {
      // The host's drain loop (not the in-turn claim above) sends this one: it
      // was queued while a notice — not a user turn — held the session.
      const prompts: any[] = [];
      const capturing = async () => new MockLanguageModelV4({ doStream: async (o: any) => {
        prompts.push(o);
        return { stream: simulateReadableStream({ chunks: CHUNKS }) };
      } }) as any;
      const h = new NativeSessionHost(new SessionStore(new NativeHome(root)), capturing, NO_CONTEXT, async () => 'chatgpt', async () => null);
      const sid = 'q-picture-notice';
      await h.create({ sessionId: sid, cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      try {
        const entry = (h as any).live.get(sid);
        let entered!: () => void;
        let release!: () => void;
        const started = new Promise<void>((r) => { entered = r; });
        const gate = new Promise<void>((r) => { release = r; });
        vi.spyOn(entry.session, 'runNotice').mockImplementation(async () => { entered(); await gate; });
        const events: any[] = [];
        h.on('transcript-event', (e: any) => { if (e.type === 'user-message') events.push(e); });
        const huge = path.join(root, 'huge.png'); fs.writeFileSync(huge, pngHeader(2904, 17528));
        const small = path.join(root, 'small.png'); fs.writeFileSync(small, pngHeader(610, 3686));
        (h as any).queueHostNotice(sid, 'notice', { kind: 'shell', runs: [] }, 'test');
        await started;
        expect(h.send(sid, 'picture', [huge], [small]).status).toBe('queued');
        release();
        await vi.waitFor(() => expect(events.some((e) => e.data.attachments?.[0] === huge)).toBe(true));
        await entry.running;
        const event = events.find((e) => e.data.attachments?.[0] === huge)!;
        expect(event.data.modelAttachments).toEqual([small]);
        const user = prompts.at(-1).prompt.filter((m: any) => m.role === 'user').at(-1);
        expect(providerFileBytes(user.content.find((p: any) => p.type === 'file'))).toEqual(pngHeader(610, 3686));
      } finally { await h.destroyAll(); }
    });

    it.each(['idle notice pass', 'user turn tail'])('delivers FIFO sends accepted during an %s before stable idle', async (start) => {
      const h = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null);
      const sid = `tail-${start}`;
      await h.create({ sessionId: sid, cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      try {
        const entry = (h as any).live.get(sid);
        let entered!: () => void;
        let release!: () => void;
        const started = new Promise<void>((r) => { entered = r; });
        const gate = new Promise<void>((r) => { release = r; });
        const notice = vi.spyOn(entry.session, 'runNotice').mockImplementation(async () => { entered(); await gate; });
        const seen: string[] = [];
        h.on('transcript-event', (e: any) => { if (e.type === 'user-message') seen.push(e.data.text); });
        if (start === 'user turn tail') h.send(sid, 'opening');
        (h as any).queueHostNotice(sid, 'notice', { kind: 'shell', runs: [] }, 'test');
        await started;
        const receipts = ['one', 'two', 'three'].map((text) => h.send(sid, text));
        expect(receipts.every((r) => r.status === 'queued')).toBe(true);
        expect(new Set(receipts.map((r: any) => r.queueId)).size).toBe(3);
        release();
        await vi.waitFor(() => expect(seen.slice(-3)).toEqual(['one', 'two', 'three']));
        await entry.running;
        expect(entry.queue).toHaveLength(0);
        expect(h.isIdle(sid)).toBe(true);
        expect(notice).toHaveBeenCalledTimes(1);
      } finally { await h.destroyAll(); }
    });

    it('delivers an acknowledged busy send inside the active turn without a second completion', async () => {
      const seen: string[] = [];
      let started!: () => void;
      const firstEvent = new Promise<void>(resolve => { started = resolve; });
      let completions = 0;
      host.on('transcript-event', (event: any) => {
        if (event.type === 'user-message') { seen.push(event.data.text); if (event.data.text === 'opening') started(); }
        if (event.type === 'turn-complete') completions++;
      });
      expect(host.send(id, 'opening').status).toBe('sent');
      await firstEvent;
      const receipt = host.send(id, 'correction') as { status: 'queued'; queueId: string };
      expect(receipt.status).toBe('queued');
      await vi.waitFor(() => expect(seen).toEqual(['opening', 'correction']));
      await (host as any).live.get(id).running;
      expect(completions).toBe(1);
      expect(host.removeQueued(id, receipt.queueId)).toBe(false);
    });

    it('consumes ready input at a second empty response without host-draining another turn', async () => {
      let requests = 0;
      const prompts: any[] = [];
      // WHY cast: same deliberately sparse finish part as CHUNKS.
      const empty = ([{ type: 'stream-start', warnings: [] },
        { type: 'finish', finishReason: { unified: 'stop' }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } }] as unknown) as LanguageModelV4StreamPart[];
      const modelFactory = async () => new MockLanguageModelV4({ doStream: async (req: any) => {
        const index = requests++;
        prompts.push(req.prompt);
        // WHY: the host's setImmediate readiness fence must open before the
        // second empty response settles; text alone never bypasses that fence.
        if (index === 1) await new Promise<void>(resolve => setImmediate(resolve));
        return { stream: simulateReadableStream({ chunks: index < 2 ? empty : CHUNKS }) };
      } }) as any;
      const h = new NativeSessionHost(new SessionStore(new NativeHome(root)), modelFactory, NO_CONTEXT, async () => null, async () => null);
      const sid = 'empty-ready';
      await h.create({ sessionId: sid, cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      try {
        const events: any[] = [];
        h.on('transcript-event', e => {
          events.push(e);
          if (e.type === 'user-message' && e.data.text === 'opening') {
            expect(h.send(sid, 'correction').status).toBe('queued');
          }
        });
        expect(h.send(sid, 'opening').status).toBe('sent');
        await (h as any).live.get(sid).running;
        expect(events.filter(e => e.type === 'user-message').map(e => e.data.text)).toEqual(['opening', 'correction']);
        expect(events.filter(e => e.type === 'turn-complete')).toHaveLength(1);
        expect(requests).toBe(3);
        expect(JSON.stringify(prompts[2])).toContain('correction');
        expect((h as any).live.get(sid).queue).toHaveLength(0);
      } finally { await h.destroyAll(); }
    });

    it('dispatches input arriving at final completion through the host without losing it', async () => {
      const seen: string[] = [];
      let receipt: ReturnType<typeof host.send> | undefined;
      let completions = 0;
      host.on('transcript-event', (e: any) => {
        if (e.type === 'user-message') seen.push(e.data.text);
        if (e.type === 'turn-complete' && ++completions === 1) receipt = host.send(id, 'late');
      });
      expect(host.send(id, 'first').status).toBe('sent');
      await vi.waitFor(() => expect(seen).toEqual(['first', 'late']));
      await vi.waitFor(() => expect(completions).toBe(2));
      expect(receipt?.status).toBe('queued');
    });

    it('claims only an acknowledged live FIFO head and preserves cancel IDs', async () => {
      const entry = (host as any).live.get(id);
      const first = host.send(id, 'opening');
      const canceled = host.send(id, 'cancel') as { queueId: string };
      const kept = host.send(id, 'kept') as { queueId: string };
      expect(first.status).toBe('sent');
      expect((host as any).takeReadyBusyMessage(id, entry.session)).toBeUndefined();
      expect(host.removeQueued(id, canceled.queueId)).toBe(true);
      await new Promise<void>(resolve => setImmediate(resolve));
      const claim = (host as any).takeReadyBusyMessage(id, entry.session);
      expect(claim?.id).toBe(kept.queueId);
      expect(host.removeQueued(id, kept.queueId)).toBe(false);
      claim.restore();
      expect(host.removeQueued(id, kept.queueId)).toBe(true);
      expect((host as any).takeReadyBusyMessage(id, {})).toBeUndefined();
    });

    it('Send now stops the running task and sends that waiting message ahead of the others', async () => {
      const order: string[] = [];
      let sendNow: boolean | undefined;
      let later!: { queueId: string };
      host.on('transcript-event', (e: any) => {
        if (e.type === 'user-message') order.push(e.data.text);
        if (e.type === 'user-interrupt') order.push('stopped');
        // Pressed while the first task is genuinely running.
        if (e.type === 'user-message' && e.data.text === 'first') sendNow = host.sendQueuedNow(id, later.queueId);
      });
      expect(host.send(id, 'first').status).toBe('sent');
      expect(host.send(id, 'waiting').status).toBe('queued');
      later = host.send(id, 'urgent') as { queueId: string };
      await vi.waitFor(() => expect(order.filter(t => t !== 'stopped')).toEqual(['first', 'urgent', 'waiting']));
      expect(sendNow).toBe(true);
      expect(order.indexOf('stopped')).toBeGreaterThan(order.indexOf('first'));
      expect(order.indexOf('stopped')).toBeLessThan(order.indexOf('urgent'));
      // Already on its way: the same honest false as Cancel.
      expect(host.sendQueuedNow(id, later.queueId)).toBe(false);
    });

    it('keeps the ack ahead of idle and busy user-message events, including queued edits', async () => {
      const order: string[] = [];
      host.on('transcript-event', (e: any) => { if (e.type === 'user-message') order.push(`event:${e.data.text}`); });
      order.push(`ack:${host.send(id, 'first').status}`);
      const canceled = host.send(id, 'cancel me') as { status: 'queued'; queueId: string };
      order.push(`ack:${canceled.status}`);
      expect(host.removeQueued(id, canceled.queueId)).toBe(true);
      const edited = host.send(id, 'edited') as { status: 'queued'; queueId: string };
      order.push(`ack:${edited.status}`);
      await waitForTurnComplete(host, 1);
      expect(order).toEqual(['ack:sent', 'ack:queued', 'ack:queued', 'event:first', 'event:edited']);
      expect(host.removeQueued(id, edited.queueId)).toBe(false);
    });

    it('does not skip an unready head and kicks it after a final idle check', async () => {
      const entry = (host as any).live.get(id);
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((r) => { entered = r; });
      const gate = new Promise<void>((r) => { release = r; });
      vi.spyOn(entry.session, 'runNotice').mockImplementation(async () => { entered(); await gate; });
      const seen: string[] = [];
      host.on('transcript-event', (e: any) => { if (e.type === 'user-message') seen.push(e.data.text); });
      (host as any).queueHostNotice(id, 'notice', { kind: 'shell', runs: [] }, 'test');
      await started;
      const head = host.send(id, 'head') as { status: 'queued'; queueId: string };
      const follower = host.send(id, 'follower') as { status: 'queued'; queueId: string };
      expect(entry.queue[0].ready).toBe(false);
      // The real readiness transition is setImmediate; the pass settles before
      // that callback, proving it cannot skip head OR require another send.
      release();
      await entry.running;
      expect(seen).toEqual([]);
      expect(entry.queue.map((q: any) => q.id)).toEqual([head.queueId, follower.queueId]);
      await vi.waitFor(() => expect(seen).toEqual(['head', 'follower']));
      expect(entry.queue).toHaveLength(0);
      expect(host.removeQueued(id, head.queueId)).toBe(false);
    });

    it('continues queued user dispatch when a host notice fails and leaves that notice for retry', async () => {
      const entry = (host as any).live.get(id);
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((r) => { entered = r; });
      const gate = new Promise<void>((r) => { release = r; });
      vi.spyOn(entry.session, 'runNotice').mockImplementation(async () => { entered(); await gate; throw new Error('notice failed'); });
      (host as any).queueHostNotice(id, 'notice', { kind: 'shell', runs: [] }, 'test');
      await started;
      const sent = host.send(id, 'survivor');
      release();
      expect(sent.status).toBe('queued');
      await waitForTurnComplete(host, 1);
      expect((host as any).pendingHostNotices.get(id)).toHaveLength(1);
      expect(host.removeQueued(id, (sent as { queueId: string }).queueId)).toBe(false);
    });

    it('cancels an unready head without letting its readiness callback revive it', async () => {
      host.send(id, 'first');
      const canceled = host.send(id, 'old') as { status: 'queued'; queueId: string };
      expect((host as any).live.get(id).queue[0].ready).toBe(false);
      expect(host.removeQueued(id, canceled.queueId)).toBe(true);
      const replacement = host.send(id, 'new') as { status: 'queued'; queueId: string };
      const seen: string[] = [];
      host.on('transcript-event', (e: any) => { if (e.type === 'user-message') seen.push(e.data.text); });
      await waitForTurnComplete(host, 1);
      expect(seen).toEqual(['first', 'new']);
      expect(replacement.queueId).not.toBe(canceled.queueId);
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
        await waitForTurnComplete(host, 1);                      // 'first' + 'b' — 'a' was cut
        expect(events).toEqual(['first', 'b']);
        expect(rB.queueId).not.toBe(rA.queueId);
      });

      it('returns false for an id that already drained (shift() beat the removal)', async () => {
        host.send(id, 'first');
        const rA = host.send(id, 'a') as { status: 'queued'; queueId: string };
        await waitForTurnComplete(host, 1); // both turns finish — 'a' has been shift()'d and sent
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
      // send() defers dispatch one macrotask; the abort controller does not exist until the turn starts, so wait one macrotask before interrupting.
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

    // Stop means quiet: a background report landing after Stop must not start a fresh model turn on its own.
    describe('Stop holds background deliveries until the next user message', () => {
      const shellNotice = (n: string) => ({
        text: `[Background command ${n} finished · exit 0 · 1s]\n$ echo ${n}\n${n}\nFull log: /tmp/${n}.txt`,
        meta: { kind: 'shell' as const, runs: [] },
      });
      const settle = () => new Promise((r) => setTimeout(r, 80));

      it('a notice that arrives AFTER Stop is not delivered as a turn — it is spliced in before the next user message', async () => {
        const events: any[] = [];
        host.on('transcript-event', (e) => events.push(e));
        host.send(id, 'long');
        await new Promise((r) => setImmediate(r));
        host.interrupt(id);
        await (host as any).live.get(id).running;
        expect(events.map((e) => e.type)).toContain('user-interrupt');
        // The helper finishes while the user is (deliberately) silent.
        const n = shellNotice('sh-after');
        (host as any).queueHostNotice(id, n.text, n.meta);
        await settle();
        expect(host.isIdle(id)).toBe(true);                                         // nothing woke the session
        expect(events.filter((e) => e.data?.injected)).toEqual([]);                  // nothing was delivered
        expect(events.filter((e) => e.type === 'turn-complete')).toEqual([]);       // and no turn ran

        host.send(id, 'next');
        await waitForTurnComplete(host, 1);
        const types = events.map((e) => e.type);
        const injectedIdx = events.findIndex((e) => e.data?.injected === 'shell-complete');
        const nextIdx = events.findIndex((e) => e.type === 'user-message' && e.data.text === 'next');
        expect(injectedIdx).toBeGreaterThan(types.indexOf('user-interrupt'));
        expect(injectedIdx).toBeLessThan(nextIdx);                                   // context for the message, not a turn of its own
        expect(events.filter((e) => e.type === 'turn-complete')).toHaveLength(1);   // exactly ONE model turn: the user's
        expect(events[injectedIdx].data.text).toContain('sh-after');
        // The model's own history has the report right before the user's words.
        const history = (host as any).live.get(id).session.history as Array<{ role: string; content: unknown }>;
        const hi = history.findIndex((m) => typeof m.content === 'string' && m.content.includes('sh-after'));
        const hn = history.findIndex((m) => m.content === 'next');
        expect(hi).toBeGreaterThanOrEqual(0);
        expect(hi).toBeLessThan(hn);
      });

      it('a notice queued DURING the turn that was stopped is held too — the interrupted turn\'s tail delivers nothing', async () => {
        const events: any[] = [];
        host.on('transcript-event', (e) => events.push(e));
        host.send(id, 'long');
        await new Promise((r) => setImmediate(r));
        const n = shellNotice('sh-during');
        (host as any).queueHostNotice(id, n.text, n.meta);   // parent busy: only parked
        host.interrupt(id);
        await (host as any).live.get(id).running;
        await settle();
        expect(events.filter((e) => e.data?.injected)).toEqual([]);
        expect(events.filter((e) => e.type === 'turn-complete')).toEqual([]);
        expect(host.isIdle(id)).toBe(true);
        host.send(id, 'next');
        await waitForTurnComplete(host, 1);
        const injectedIdx = events.findIndex((e) => e.data?.injected === 'shell-complete');
        const nextIdx = events.findIndex((e) => e.type === 'user-message' && e.data.text === 'next');
        expect(injectedIdx).toBeGreaterThanOrEqual(0);
        expect(injectedIdx).toBeLessThan(nextIdx);
        expect(events.filter((e) => e.type === 'turn-complete')).toHaveLength(1);
      });

      it('a message the user queued before pressing Stop still runs, with the held notice spliced in ahead of it', async () => {
        const events: any[] = [];
        host.on('transcript-event', (e) => events.push(e));
        host.send(id, 'long');
        host.send(id, 'queued-survivor');
        await new Promise((r) => setImmediate(r));
        const n = shellNotice('sh-queued');
        (host as any).queueHostNotice(id, n.text, n.meta);
        host.interrupt(id);
        await waitForTurnComplete(host, 1);     // the survivor's turn
        const types = events.map((e) => e.type);
        const injectedIdx = events.findIndex((e) => e.data?.injected === 'shell-complete');
        const survivorIdx = events.findIndex((e) => e.type === 'user-message' && e.data.text === 'queued-survivor');
        expect(injectedIdx).toBeGreaterThan(types.indexOf('user-interrupt'));
        expect(injectedIdx).toBeLessThan(survivorIdx);
        expect(events.filter((e) => e.type === 'turn-complete')).toHaveLength(1);
        // And the hold is spent: a later notice, with nothing stopped since, is a turn of its own again.
        // (Wait for the pass itself to settle first — a notice that lands in the sliver between the
        // tail's drain and inFlight clearing is parked until the next boundary, as it always was.)
        await (host as any).live.get(id).running;
        const later = shellNotice('sh-later');
        (host as any).queueHostNotice(id, later.text, later.meta);
        await waitForTurnComplete(host, 1);     // counts from here: the notice's own turn
        expect(events.filter((e) => e.type === 'turn-complete')).toHaveLength(2);
      });
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

    // destroy() in the same tick as send() (before the deferred dispatch) leaves a zombie turn with no listeners: must not throw or emit.
    it('destroy in the same tick as send() drops the turn without unhandled rejection', async () => {
      const events: any[] = [];
      host.on('transcript-event', (e) => events.push(e));
      host.send(id, 'same-tick');
      await expect(host.destroy(id)).resolves.toBeUndefined(); // no throw, no unhandled rejection
      // settle (negative assertion): the zombie turn's delayed stream must stay silent.
      await new Promise((r) => setTimeout(r, 150));
      expect(events.some((e) => e.type === 'user-message' && e.data.text === 'same-tick')).toBe(false);
    });
  });

  // quiesce is STRONGER than interrupt(): interrupt lets the FIFO queue keep draining, which would append past a takeover's flush. After quiesce, no appends until a new send.
  describe('quiesce (takeover/teardown)', () => {
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
      // settle (negative assertion): the queued survivor must never run.
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
      // send() + quiesce() in the same tick: quiesce awaits one macrotask first so it catches the just-dispatched turn.
      qHost.send('qz2', 'same-tick');
      await qHost.quiesce('qz2');

      const appendsAtQuiesce = appendSpy.mock.calls.length;
      // settle (negative assertion): no appends after quiesce.
      await new Promise((r) => setTimeout(r, 80));
      expect(appendSpy.mock.calls.length).toBe(appendsAtQuiesce); // no post-quiesce appends
      // Aborted mid-stream: the turn must NOT have reached turn-complete.
      const types = store.readEvents('qz2', root).map((e) => e.type);
      expect(types).not.toContain('turn-complete');
      await qHost.destroyAll();
    });

    // A send arriving WHILE quiesce is winding down (idle session, so it would
    // dispatch a fresh turn) used to run a whole turn on the old device before
    // the handoff. It is refused instead, and the renderer keeps the draft.
    it('a send that arrives while quiesce is in progress, or after it, is refused until the takeover ends', async () => {
      const store = new SessionStore(new NativeHome(root));
      const qHost = new NativeSessionHost(store, delayedFactory, NO_CONTEXT, async () => null, async () => null);
      await qHost.create({ sessionId: 'qz3', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const quiesced = qHost.quiesce('qz3');
      expect(qHost.send('qz3', 'mid-quiesce')).toEqual({ status: 'failed', reason: 'not-live' });
      await quiesced;
      // settle (negative assertion): the refused send must never be written.
      await new Promise((r) => setTimeout(r, 80));
      expect(store.readEvents('qz3', root).some((e) => e.type === 'user-message')).toBe(false);
      // Still refused after quiesce returns: the takeover's flush and lease
      // release come next, and only destroy ends the session.
      expect(qHost.send('qz3', 'after')).toEqual({ status: 'failed', reason: 'not-live' });
      // A takeover that did not go ahead lifts it.
      qHost.endQuiesce('qz3');
      expect(qHost.send('qz3', 'after')).toEqual({ status: 'sent' });
      await qHost.destroyAll();
    });

    // The same refusal guards every other way a quiesced session could start
    // work past the takeover's flush: /compact, /clear, a skill, and an idle
    // delivery pass (a finished specialist's report waking the model).
    it('while quiesced, compact / clear / invokeSkill refuse and an idle delivery pass does not start', async () => {
      const store = new SessionStore(new NativeHome(root));
      const appendSpy = vi.spyOn(store, 'append');
      const qHost = new NativeSessionHost(store, delayedFactory, NO_CONTEXT, async () => null, async () => null);
      await qHost.create({ sessionId: 'qz4', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      await qHost.quiesce('qz4');
      const appendsAtQuiesce = appendSpy.mock.calls.length;

      expect(await qHost.compact('qz4')).toEqual({ ok: false, reason: 'not-live' });
      expect(qHost.clear('qz4')).toEqual({ ok: false, reason: 'not-live' });
      expect(await qHost.invokeSkill('qz4', 'any-skill')).toEqual({ ok: false, reason: 'not-live' });
      (qHost as any).kickIdleDeliveryPass('qz4');
      expect((qHost as any).live.get('qz4').inFlight).toBeFalsy();

      // settle (negative assertion): no appends after quiesce.
      await new Promise((r) => setTimeout(r, 80));
      expect(appendSpy.mock.calls.length).toBe(appendsAtQuiesce);
      await qHost.destroyAll();
    });
  });

  // ---- Specialists (plan 1a, Task 5): createChild mints a CHILD session —
  // an ordinary HarnessSession marked by parentage, cold-started, with a
  // charter-capped tool + permission surface and no route to a user ask.
  describe('specialist children', () => {
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
      await h.destroyAll();
    });

    it('Bash-enabled Worker advertises and authorizes its own background companions without widening its definition', async () => {
      const { h } = await withParent();
      try {
        const worker = resolveSpecialist('worker')!;
        const original = [...worker.allowedTools];
        const { childId } = await h.createChild('root-1', {
          specialist: worker, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
        });
        const child = childSession(h, childId);
        const names = toolNames(h, childId);
        expect(names.sort()).toEqual([...worker.allowedTools, 'BashOutput', 'KillShell'].sort());
        for (const name of ['Bash', 'BashOutput', 'KillShell']) {
          expect((await child.opts.decide(name, undefined)).action).toBe('allow');
        }
        expect(worker.allowedTools).toEqual(original);
        expect(worker.allowedTools).not.toContain('BashOutput');
        expect(worker.allowedTools).not.toContain('KillShell');
        expect(child.opts.shells).not.toBe((childSession(h, 'root-1') as any).opts.shells);
        const { childId: otherId } = await h.createChild('root-1', {
          specialist: worker, prompt: 'p', workDir: root, parentToolCallId: 'tc-2',
        });
        expect(child.opts.shells).not.toBe(childSession(h, otherId).opts.shells);
        // Exercise the advertised real tool implementations against the session's
        // own registry, without starting an OS subprocess or signaling a process.
        const owned = child.opts.shells;
        const foreignId = 'sh-parent-only';
        const peerId = 'sh-other-child';
        const childShellId = 'sh-child-owned';
        const entry = (shellId: string) => ({ shellId, command: 'test', status: 'exited', startedAt: 1, endedAt: 2 });
        (childSession(h, 'root-1') as any).opts.shells.runs.set(foreignId, entry(foreignId));
        childSession(h, otherId).opts.shells.runs.set(peerId, entry(peerId));
        owned.runs.set(childShellId, entry(childShellId));
        const output = child.opts.tools.find((t: any) => t.name === 'BashOutput');
        const kill = child.opts.tools.find((t: any) => t.name === 'KillShell');
        const ctx = { sessionId: childId, cwd: root, signal: new AbortController().signal, shells: owned } as any;
        expect((await output.execute({}, ctx)).text).toContain(childShellId);
        expect((await output.execute({}, ctx)).text).not.toContain(foreignId);
        for (const id of [foreignId, peerId]) {
          expect((await output.execute({ shell_id: id }, ctx)).isError).toBe(true);
          expect((await kill.execute({ shell_id: id }, ctx)).isError).toBe(true);
        }
        expect((await kill.execute({ shell_id: childShellId }, ctx)).text).toContain('not running');
        for (const id of ['root-1', otherId]) {
          const foreign = childSession(h, id).opts;
          const foreignCtx = { ...ctx, sessionId: id, shells: foreign.shells };
          const foreignOutput = foreign.tools.find((t: any) => t.name === 'BashOutput');
          const foreignKill = foreign.tools.find((t: any) => t.name === 'KillShell');
          expect((await foreignOutput.execute({ shell_id: childShellId }, foreignCtx)).isError).toBe(true);
          expect((await foreignKill.execute({ shell_id: childShellId }, foreignCtx)).isError).toBe(true);
        }
      } finally { await h.destroyAll(); }
    });

    it('a read-write definition without Bash does not inherit Bash or background companions', async () => {
      const { h } = await withParent();
      try {
        const worker = resolveSpecialist('worker')!;
        const noBash = { ...worker, allowedTools: worker.allowedTools.filter(name => name !== 'Bash') };
        const { childId } = await h.createChild('root-1', {
          specialist: noBash, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
        });
        expect(toolNames(h, childId).sort()).toEqual([...noBash.allowedTools].sort());
        for (const name of ['Bash', 'BashOutput', 'KillShell']) {
          expect((await childSession(h, childId).opts.decide(name, undefined)).action).toBe('deny');
        }
        expect(worker.allowedTools).toContain('Bash');
      } finally { await h.destroyAll(); }
    });

    // opts.binding (a resolved override) is what the CHILD launches on: header, retainModel ref-count and HarnessSession must all agree.
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
      // Child was HANDED an empty catalog rather than falling back to createSkillCatalog() — only the injected value tells them apart.
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

    it("a child's events persist under its OWN id and never reach the host emitter", async () => {
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
      // Worker is read-write and lists Write; the parent is in 'ask'. The envelope turns that into an allow with no broker ask (a child has no user).
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

    it("the destructive deny-list cuts through the envelope, but now ROUTES to the parent instead of hard-denying", async () => {
      // The envelope is consent for the charter, not for `rm -rf`: no charter or envelope overrides the destructive deny-list.
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
      // A real user answers (deny) — real declines get the plain copy.
      expect(h.respondPermission(requestId, { behavior: 'deny' })).toBe(true);
      await sendPromise;
      const res = events.find((e) => e.type === 'tool-result')!;
      expect(res.data.isError).toBe(true);
      expect(res.data.toolResult).toMatch(/user declined/i);
      expect(fs.existsSync(path.join(root, 'marker.txt'))).toBe(true);     // never ran
      await h.destroyAll();
    });

    it('destroy(childId) cancels a routed ask registered under the parent id (raisedBy match)', async () => {
      const WORKER = resolveSpecialist('worker')!;
      const rmOnce = () => scriptedModel([
        stream(toolCallChunk('c1', 'Bash', { command: 'rm -rf marker.txt' }), finishChunk('tool-calls')),
        stream(...textChunks('t', 'done'), finishChunk('stop')),
      ]) as any;
      const { h } = await withParent(async () => rmOnce());
      const { childId } = await h.createChild('root-1', {
        specialist: WORKER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      const asks: any[] = [];
      h.on('hook-event', (e) => asks.push(e));
      const askArrived = firstAsk(h);
      const sendPromise = childSession(h, childId).send('go');
      await askArrived;
      await h.destroy(childId); // torn down WHILE the ask is still pending
      await sendPromise; // the child's own turn unwinds via the 'canceled' interrupt path
      expect(asks.some((e) => e.type === 'PermissionExpired')).toBe(true); // card cleared
      await h.destroyAll();
    });

    // A routed child ask's "Always allow" must persist (HarnessSession emits remember-rule on itself but a child is never wire()d), scoped to the specialist's agentType.
    describe('"Always allow" on a routed child ask is persisted, not dropped', () => {
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
        rules = await pollFor(() => store.rulesFor(root), (rules) => rules.some((r) => r.specialist === 'worker'));
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

        // Same command again must not re-ask: the in-memory rememberedFor bucket holds for this run, not just the disk write.
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
        await pollFor(() => store.rulesFor(root), (rules) => rules.some((r) => r.specialist === 'worker'));

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
        // Isolates the agentType scope filter buildDecide applies (only one read-write built-in exists for an end-to-end run).
        const store = {
          rulesFor: async () => [{ tool: 'Bash', pattern: 'rm -rf marker.txt', action: 'allow' as const, specialist: 'worker' }],
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
        // Hire Worker in F, Always allow, then a DIFFERENT read-write helper in F must be asked again — the whole lookup via the real rememberRule, PermissionStore and buildDecide (memory leg and, via a second host, disk leg).
        const F = path.join(root, 'project-f');
        fs.mkdirSync(F, { recursive: true });
        const store = new PermissionStore(new NativeHome(root));
        // Memory-leg store writes through to disk but is blind to it on read, so only the in-memory copy can answer.
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
        await vi.waitFor(async () => expect((await store.rulesFor(F)).some((r) => r.specialist === 'worker')).toBe(true));
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
      // Drives the external-directory forced ask (a WRITE: reads outside the workspace raise no ask) — the one call site that fails if `askUser: childAskRouter` is dropped.
      // Router wired: instant factual denial without reaching the broker; router missing: harness-session's own config-error copy. The two are exclusive, so asserting both discriminates them.
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
      // Explorer has no Write attached, so the driver's unknown-tool result answers first; the model gets a next step instead of retrying.
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
      // A definition listing Write under a read-only charter DOES get the tool, so only decide() (the second cap) stops it.
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
      // Grants follow the PROJECT: a child narrowed to `sub` must still look up rules by the parent's cwd.
      const rulesFor = vi.fn<(cwd: string) => Promise<PermissionRule[]>>(async () => []);
      const store = new SessionStore(new NativeHome(root));
      const globOnce = async () => scriptedModel([
        stream(toolCallChunk('c1', 'Glob', { pattern: '*.ts' }), finishChunk('tool-calls')),
        stream(...textChunks('t', 'done'), finishChunk('stop')),
      ]) as any;
      const h = new NativeSessionHost(store, globOnce, NO_CONTEXT, async () => null, async () => null, undefined,
        { rulesFor, remember: async () => { /* no-op */ }, remove: async () => false, removeProject: async () => false });
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

    // spawnSpecialist's finally once released only the writer lock, leaking the minted child (live entry, header, model ref, childrenOf) on every Task call. Failed-run half: specialist-run.test.ts.
    it('a completed spawnSpecialist run does not leak the minted child (leak guard)', async () => {
      const { store, h } = await withParent();
      const released: string[] = [];
      h.setModelReleasedHandler((id) => released.push(id));

      // The suite's default `factory` answers with one text step ("Hi there"),
      // which IS this child's report — a one-shot specialist that says its
      // piece and is torn down.
      const { childId, report } = await h.spawnSpecialist('root-1', {
        specialist: EXPLORER, prompt: 'find the config loader', description: 'find the config loader', workDir: root, parentToolCallId: 'tc-1',
        // spawnSpecialist binds a caller-supplied reservation; this drives the run loop directly with a plain reader token.
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

      // The leaked child's model ref would keep 'm' referenced forever (a local model could never unload).
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
      await waitForTurnInFlight(h, childId);
      h.interrupt('root-1');
      await turn;                                         // settles — no hang
      expect(events.some((e) => e.type === 'user-interrupt')).toBe(true);
      expect(events.some((e) => e.type === 'turn-complete')).toBe(false);
      await h.destroyAll();
    });

    // interrupt(parentId) (Stop) must NOT cascade to a BACKGROUND child; spawnSpecialist only records background:false, so stamp background:true on the private ledger.
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

    // quiesce (takeover path) must still cascade-destroy every live specialist child, foreground or background, leaving an 'interrupted' ledger row — never an orphan or a row claiming 'running'.
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
      rec = await pollFor(() => (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId), (rec) => rec?.status === 'interrupted');
      expect(rec?.status).toBe('interrupted');

      await h.destroyAll();
    });

    // A BACKGROUND child is removed from childrenOf a few microtasks AFTER its completion write; a quiesce/destroy racing that gap fired a fire-and-forget 'interrupted' that overwrote 'completed'.
    // Reproduced by setting the row 'completed' while the child is still in childrenOf; the report must survive as 'completed' and claimable.
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
      // Ledger already 'completed' while the child is still in childrenOf — the exact race window.
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

      // Spy on the guarded write and await it: polling the row proved nothing (recordStart already wrote it) and its late write raced afterEach into ENOTEMPTY (Linux CI).
      const guarded = vi.spyOn((h as any).ledger, 'updateUnlessCompleted');
      const settleWrites = () => Promise.allSettled(guarded.mock.results.map((r) => r.value));

      const result = h.interruptSpecialist('root-1', childId);
      expect(result.status).toBe('ok'); // the interrupt call itself still succeeds — only the ledger write is guarded
      expect(guarded).toHaveBeenCalledTimes(1);
      await settleWrites();

      const rec = (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId);
      expect(rec?.status).toBe('completed');
      const claimed = await (h as any).ledger.claimUndelivered(root, 'root-1');
      expect(claimed?.childId).toBe(childId);

      await h.destroyAll();
      await settleWrites();
    });
  });

  // Host-level invariants: a specialist header never re-enters through root resume(), and a steer that misses its window is never silently lost. Dispatch logic is covered via task-tool.test.ts.
  describe('task_id management', () => {
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

      // Live child, never sent a turn: postSteer's in-flight check is false, so this is the "between iterations" miss steerSpecialist records.
      const steerResult = h.steerSpecialist('root-1', childId, 'focus on auth.ts instead');
      expect(steerResult.status).toBe('ok');
      // The ledger write is fire-and-forget (steerSpecialist's own WHY —
      // never blocks the caller on disk I/O), so poll for it to land rather
      // than assuming it's synchronous.
      let recBefore: any;
      recBefore = await pollFor(() => (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId), (recBefore) => recBefore?.missedSteers?.length > 0);
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

    // steerSpecialist's miss-write once computed its patch from a snapshot read OUTSIDE the lock; a completion write landing after could erase the steer with `[]`.
    // Sequenced explicitly (steer landed FIRST, then completion) — ordering, not concurrency, causes the loss, and Promise.all would be flaky.
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

      // Miss the steer's window (child never took a turn) so it is recorded to the ledger; poll for the fire-and-forget write so the ordering is real.
      const steerResult = h.steerSpecialist('root-1', childId, 'focus on auth.ts instead');
      expect(steerResult.status).toBe('ok');
      let recBefore: any;
      recBefore = await pollFor(() => (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId), (recBefore) => recBefore?.missedSteers?.length > 0);
      expect(recBefore.missedSteers).toEqual(['focus on auth.ts instead']);

      // Now run the delegation to completion via runDelegation: its missedSteers comes from the child's untouched pendingSteers, i.e. an unrelated [] landing after a real steer.
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

    // The completion write was once two lock acquisitions (status, then appendMissedSteers): if the second threw the row was durably 'completed' with the drained steers lost.
    // Lets the first mutateJson for this record succeed and fails the second; a single atomic write has no second call, so it lands whole or not at all.
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

      // Stub drainUnappliedSteers (a steer queued in the child's live pendingSteers but never applied) — pushing early would let the turn loop apply it as a normal steer.
      const liveSession = (h as any).live.get(childId).session;
      vi.spyOn(liveSession, 'drainUnappliedSteers').mockReturnValue(['focus on auth.ts instead']);

      // Fail the SECOND NativeHome.mutateJson call touching THIS record (status patch, then steer append), scoped to its file so other ledger rows cannot consume the count.
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

      // Without call >= 1 the else branch passes identically whether the completion write rolled back or never ran at all.
      expect(call).toBeGreaterThanOrEqual(1);

      const recAfter = (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId);
      // Forbidden: status durably 'completed' while the drained steer is nowhere on the record (what a two-call write can produce).
      if (recAfter.status === 'completed') {
        expect(recAfter.missedSteers).toContain('focus on auth.ts instead');
      } else {
        expect(recAfter.status).toBe('running');
        expect(recAfter.missedSteers).toEqual([]);
      }

      await h.destroyAll();
    });

    // resumeSpecialist once read missedSteers from an early snapshot and later blind-cleared them; a steer landing in that gap was wiped, never delivered.
    // Deterministic: hooks the ONE ledger call that read-clears-and-flips to 'running' (takeMissedSteers) and injects a fully-landed append just before it proceeds.
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

    it.each(['before', 'after'] as const)('a rejected resume take %s committing retains its exact steers for one later turn', async (failure) => {
      const home = new NativeHome(root), store = new SessionStore(home);
      const h = new NativeSessionHost(store, factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, home);
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const { childId, title } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-take',
      });
      const ledger = (h as any).ledger as DelegationLedger;
      await ledger.recordStart(root, 'root-1', {
        childId, parentToolCallId: 'tc-take', agentType: EXPLORER.id, title, workDir: root,
        description: EXPLORER.description, background: false, status: 'completed', startedAt: Date.now(),
        delivered: true, owner: OWNER, missedSteers: ['SAVED STEER'],
      });
      await h.destroy(childId);
      const originalMutate = home.mutateJson.bind(home);
      let injected = false;
      const storage = vi.spyOn(home, 'mutateJson').mockImplementation(async (...args: any[]) => {
        if (!injected && String(args[0]).endsWith('.delegations.json')) {
          injected = true;
          if (failure === 'after') {
            await (originalMutate as any)(...args);
            // Another writer appends after the clear committed. Never restore a stale row.
            await ledger.appendMissedSteers(root, 'root-1', childId, ['CONCURRENT STEER']);
          }
          throw new Error('resume take acknowledgement failed');
        }
        return (originalMutate as any)(...args);
      });
      const reservation = h.reserveSpecialist('root-1', { writer: false });
      if (!reservation.ok) throw new Error('expected capacity');
      try {
        await expect(h.resumeSpecialist('root-1', {
          childId, prompt: 'retry later', background: false, parentToolCallId: 'tc-rejected', reservation: reservation.token,
        })).rejects.toThrow('resume take acknowledgement failed');
        expect(injected).toBe(true);
        expect((h as any).live.has(childId)).toBe(false);
        storage.mockRestore();
        // This ordinary write also gives a retained rollback intent a recovery boundary.
        await ledger.appendMissedSteers(root, 'root-1', childId, ['LATER STEER']);
        const pending = ledger.listFor(root, 'root-1').find(row => row.childId === childId)!;
        expect(pending.missedSteers).toEqual(failure === 'after'
          ? ['SAVED STEER', 'CONCURRENT STEER', 'LATER STEER'] : ['SAVED STEER', 'LATER STEER']);
        expect(await h.resumeSpecialist('root-1', {
          childId, prompt: 'now continue', background: false, parentToolCallId: 'tc-retry', reservation: reservation.token,
        })).toMatchObject({ status: 'ok' });
        const messages = store.readEvents(childId, root).filter(event => event.type === 'user-message');
        expect(messages).toHaveLength(1);
        const text = (messages[0] as any).data.text as string;
        expect(text.split('SAVED STEER')).toHaveLength(2);
        expect(text.split('LATER STEER')).toHaveLength(2);
        if (failure === 'after') expect(text.split('CONCURRENT STEER')).toHaveLength(2);
        expect(ledger.listFor(root, 'root-1').find(row => row.childId === childId)!.missedSteers).toEqual([]);
      } finally {
        storage.mockRestore(); await h.destroyAll();
      }
    });

    // Resume's take-then-flip was two lock acquisitions: if the take landed (steers cleared) and the flip threw, the resumed brief was never delivered and the steers were gone.
    // Hooks NativeHome.mutateJson (the primitive every ledger write bottoms out in) and fails the SECOND call for this record; mocking the methods would intercept before any disk I/O and prove nothing.
    // Today takeMissedSteers is one call, so call 2 is the foreground run's own completion write: its throw is swallowed (log-only), resume completes, and the record keeps takeMissedSteers' patch.
    // A re-split into two writes would shift the hook onto the second half and hit the forbidden partial-commit branch asserted below.
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

      // Real ledger path: the child has not taken a turn, so steerSpecialist's own write records the miss; poll for it to land so the ordering is real.
      const steerResult = h.steerSpecialist('root-1', childId, 'focus on auth.ts instead');
      expect(steerResult.status).toBe('ok');
      let recBefore: any;
      recBefore = await pollFor(() => (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId), (recBefore) => recBefore?.missedSteers?.length > 0);
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
      // Same dual-branch shape as above: today the atomic take succeeds and resume completes (steer folded in, cleared); a re-split leaves the steer wiped while the resume also failed — never delivered, never recoverable.
      if (resumeError) {
        expect(recAfter.missedSteers).toEqual(['focus on auth.ts instead']);
        expect(recAfter.status).toBe('running');
      } else {
        expect(recAfter.missedSteers).toEqual([]);
        expect(recAfter.status).toBe('running'); // takeMissedSteers' own patch restores 'running'
      }

      await h.destroyAll();
    });

    // resumeSpecialist's patch left run 1's injectionAttempted:true on the childId's single ledger row, so claimUndelivered's `!d.injectionAttempted` bar never passed again and run 2's report was claimed by nobody.
    // Drives both runs through the real background chain and asserts the OUTCOME: run 2's report reaches the parent as a second injected notice.
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
      // `delivered` flips on a later async disk write (confirmDelivered's file lock) the event is not gated on — poll, or this races under load.
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

      // Await the parent's delivery pass first: injecting run 2's report appends to the session file, and ending mid-pass raced afterEach's removal (ENOTEMPTY).
      await (h as any).live.get('root-1')?.running;
      await h.destroyAll();
    });

    it.each(['delivered', 'injectionAttempted'] as const)('discards a retained outcome behind the durable %s marker', async (marker) => {
      const home = new NativeHome(root);
      const h = new NativeSessionHost(
        new SessionStore(home), factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, home,
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const record: DelegationRecord = {
        childId: 'retained-child', parentToolCallId: 'tc-retained', agentType: 'explorer', title: 'Retained',
        workDir: root, description: 'd', background: true, status: 'completed',
        startedAt: Date.now(), delivered: false, owner: OWNER, missedSteers: [], rawReport: 'ALREADY ATTEMPTED',
      };
      const events: any[] = [];
      h.on('transcript-event', (event) => events.push(event));
      try {
        await (h as any).ledger.recordStart(root, 'root-1', { ...record, [marker]: true });
        (h as any).stashFallbackIfParentAlive('root-1', record.childId, record);
        (h as any).queueDelivery('root-1');
        await (h as any).live.get('root-1').running;
        expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(0);
        expect((h as any).inMemoryFallback.has(record.childId)).toBe(false);
      } finally { await h.destroyAll(); }
    });

    it.each([
      [false, false], [true, false], [false, true], [true, true],
    ])('retains an unknown background outcome until storage recovers (committed=%s, failed=%s)', async (committed, failed) => {
      const home = new NativeHome(root);
      let calls = 0;
      const h = new NativeSessionHost(
        new SessionStore(home), async () => {
          if (++calls === 1) {
            if (failed) throw new Error('ACTUAL CHILD FAILURE');
            return scriptedModel([stream(...textChunks('t', 'ACTUAL CHILD REPORT'), finishChunk('stop'))]) as any;
          }
          return factory();
        }, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, home,
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const ledger = (h as any).ledger as DelegationLedger;
      const originalUpdate = ledger.updateIfRunning.bind(ledger);
      const originalCompletion = ledger.update.bind(ledger);
      const originalList = ledger.listFor.bind(ledger);
      const originalClaim = ledger.claimUndelivered.bind(ledger);
      let unreadable = false;
      vi.spyOn(ledger, 'claimUndelivered').mockImplementation(async (...args) => {
        if (unreadable) throw new Error('storage unavailable for claim');
        return originalClaim(...args);
      });
      vi.spyOn(ledger, 'update').mockImplementation(async (...args) => {
        if (args[3].status === 'completed') {
          if (committed) await originalCompletion(...args);
          unreadable = true;
          throw new Error('outcome write acknowledgement failed');
        }
        return originalCompletion(...args);
      });
      vi.spyOn(ledger, 'updateIfRunning').mockImplementation(async (...args) => {
        if (args[3].status === (failed ? 'failed' : 'completed')) {
          if (committed) await originalUpdate(...args);
          unreadable = true;
          throw new Error('outcome write acknowledgement failed');
        }
        return originalUpdate(...args);
      });
      const read = vi.spyOn(ledger, 'listFor').mockImplementation((...args) => {
        if (unreadable) throw Object.assign(new Error('readback unavailable'), { code: 'EIO' });
        return originalList(...args);
      });
      // Hold the idle pass until the detached outcome handler has settled.
      const queued = vi.spyOn(h as any, 'queueDelivery').mockImplementation(() => {});
      const events: any[] = [];
      h.on('transcript-event', (event) => events.push(event));
      try {
        const reservation = h.reserveSpecialist('root-1', { writer: false });
        if (!reservation.ok) throw new Error('expected capacity');
        const { childId } = await h.spawnSpecialistBackground('root-1', {
          specialist: EXPLORER, prompt: 'inspect', workDir: root, parentToolCallId: 'tc-unknown',
          token: reservation.token, description: EXPLORER.description,
        });
        await vi.waitFor(() => expect(queued).toHaveBeenCalled());
        expect(unreadable).toBe(true);
        expect((h as any).inMemoryFallback.has(childId)).toBe(true);
        queued.mockRestore();
        (h as any).queueDelivery('root-1');
        await (h as any).live.get('root-1').running;
        expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(0);
        expect((h as any).inMemoryFallback.has(childId)).toBe(true);
        unreadable = false;
        (h as any).queueDelivery('root-1');
        await (h as any).live.get('root-1').running;
        const notices = events.filter((e) => e.data?.injected === 'specialist-report');
        expect(notices).toHaveLength(1);
        expect(notices[0].data.text).toContain(failed ? 'ACTUAL CHILD FAILURE' : 'ACTUAL CHILD REPORT');
        (h as any).queueDelivery('root-1');
        await (h as any).live.get('root-1').running; // settle a second idle pass: no duplicate
        expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(1);
        expect((h as any).inMemoryFallback.has(childId)).toBe(false);
      } finally {
        unreadable = false;
        queued.mockRestore();
        read.mockRestore();
        await h.destroyAll();
      }
    });

    // Drives the real chain: child factory throws -> runDelegation writes 'failed' -> queueDelivery -> claimUndelivered (also claims 'failed') -> formatDelivery -> a typed failure notice injected as a parent turn.
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

    // A resume rebuilds the child from the definition file AS IT IS NOW while consent was for the file at hire; a task_id call has no work_dir, so no consent card renders.
    // Only two fingerprints both present and DIFFERENT refuse (absent = no claim to check: built-ins, rows predating the field, else every old hire is unresumable). All four combinations are pinned.
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
          undefined, undefined, undefined, undefined, undefined, undefined, home, catalog,
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

      // The hire must record which version was consented to; without it every fingerprint is absent and the four cases pass vacuously.
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

  // The ledger's change listener turns every write into a 'specialists-event'; plus the user-facing note/stop surface and the spawn-time model on the record. steerSpecialist's dispatch logic is covered above.
  describe('user-facing steer/stop + specialists-event feed', () => {
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

      await destroyAllAndSettle(h, root);
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

      // Wait for the EVENT as well as the record: they reach us by different routes, so polling only the record could leave the "exactly one event" assertion reading []. (ubuntu CI lost this race.)
      let liveRec: any;
      liveRec = await pollFor(() => (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === liveChildId), (liveRec) => liveRec?.notes?.length > 0 && events.some((e) => e.run.childId === liveChildId));
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
      parkedRec = await pollFor(() => (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === parkedChildId), (parkedRec) => parkedRec?.missedSteers?.length > 0 && events.some((e) => e.run.childId === parkedChildId));
      expect(parkedRec.missedSteers).toEqual(['check config.ts instead']);
      expect(parkedRec.notes).toEqual([{ text: 'check config.ts instead', from: 'assistant', at: expect.any(Number) }]);
      // The parked steer and its note commit in the SAME mutateJson call
      // (appendMissedSteers' `note` param) — never two independent writes —
      // so this child gets exactly ONE event, carrying the note already.
      const parkedEvents = events.filter((e) => e.run.childId === parkedChildId);
      expect(parkedEvents).toHaveLength(1);
      expect(parkedEvents[0].run.notes).toEqual([{ text: 'check config.ts instead', from: 'assistant', at: expect.any(Number) }]);

      await destroyAllAndSettle(h, root);
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

      await destroyAllAndSettle(h, root);
    });

    // SPECIALIST_NOTE_MAX_CHARS lives INSIDE steerSpecialist so the model's own task_id steer is capped too; accepted steers are permanent ledger entries that grow the file.
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
      rec = await pollFor(() => (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId), (rec) => rec?.notes?.length > 0);
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
      await destroyAllAndSettle(h, root);
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
      await waitForTurnInFlight(h, childId);

      const shortText = 'focus on auth.ts instead';
      const result = h.steerSpecialist('root-1', childId, shortText, 'assistant');
      expect(result.status).toBe('ok');

      let rec: any;
      rec = await pollFor(() => (h as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId), (rec) => rec?.notes?.length > 0);
      expect(rec.notes).toEqual([{ text: shortText, from: 'assistant', at: expect.any(Number) }]);

      await turn;
      await destroyAllAndSettle(h, root);
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

      await destroyAllAndSettle(h, root);
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

      await destroyAllAndSettle(h, root);
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

      await destroyAllAndSettle(h, root);
    });
  });

  // internalReadRoots exempts only sessions/<slug>/specialist-reports/, not the whole sessions dir (other conversations' transcripts and ledger sidecars).
  // Asserts checkPathGuard's VERDICT: 'external' is free for Read/Grep/Glob but keeps a write-shaped tool fenced.
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
      // A home dir SEPARATE from the project cwd (as in production), so the sibling path proves the exemption rather than "under cwd anyway".
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-home-'));
      const home = new NativeHome(homeDir);
      const store = new SessionStore(home);
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, home,
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      const slug = nativeStoreSlug(root);
      // Another conversation's transcript in the same sessions/<slug>/ dir must still come back 'external'.
      const otherTranscript = path.join(home.root, 'sessions', slug, 'some-other-session-id.jsonl');
      const { checkPathGuard } = await import('../src/main/harness/tools/guards');
      const session = (h as any).live.get('root-1').session;
      const verdict = checkPathGuard(otherTranscript, root, session.opts.internalReadRoots);
      expect(verdict.kind).toBe('external');

      fs.rmSync(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });

      await h.destroyAll();
    });
  });

  // buildSpecialistStatus answers the Task tool's `list: true`; pinned by stamping the private ledger directly.
  describe('specialist status text (on demand)', () => {
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

      const status: string | null = (h as any).buildSpecialistStatus('root-1', root);

      expect(status).toBeTruthy();
      expect(status).toContain('Nadia');
      expect(status).toContain('running');
      expect(status).toContain('Otis');
      expect(status).toContain('report delivery pending');
      // Delivered specialist never appears.
      expect(status).not.toContain('Priya');

      await destroyAllAndSettle(h, root);
    });

    it('returns null (and wires nothing to inject) when the session has no delegations at all', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null, undefined,
        undefined, undefined, undefined, undefined, undefined, new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      expect((h as any).buildSpecialistStatus('root-1', root)).toBeNull();

      await destroyAllAndSettle(h, root);
    });

    // steps is only written at COMPLETION, so a running row's `steps ?? 0` rendered a permanently wrong "step 0"; the line must not claim a count it lacks.
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

      const status: string | null = (h as any).buildSpecialistStatus('root-1', root);

      expect(status).toBeTruthy();
      expect(status).not.toContain('step 0');
      expect(status).not.toMatch(/step \d/);

      await destroyAllAndSettle(h, root);
    });

    // `stale` only means "at least" the idle threshold elapsed; the line must state it as a floor, not an exact measurement.
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

      const status: string | null = (h as any).buildSpecialistStatus('root-1', root);

      expect(status).toContain('no activity for at least 2m');

      await destroyAllAndSettle(h, root);
    });

    // 'interrupted' is never delivered ("no report will arrive"); 'failed' IS claimed (claimUndelivered covers completed OR failed), so it gets the "delivery pending" framing with the real failureText inline.
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

      const status: string | null = (h as any).buildSpecialistStatus('root-1', root);
      const lines = (status ?? '').split('\n');

      const failedLine = lines.find((l) => l.startsWith('Fiona'));
      expect(failedLine).toBe('Fiona (debugger): failed — ENOENT: no such file or directory — report delivery pending');
      expect(failedLine).not.toContain('no report will arrive');

      const interruptedLine = lines.find((l) => l.startsWith('Greg'));
      expect(interruptedLine).toBe('Greg (writer): interrupted — no report will arrive');
      expect(interruptedLine).not.toContain('delivery pending');

      await destroyAllAndSettle(h, root);
    });
  });

  // toolWiring() once hardcoded `catalog: async () => null`; with a modelCatalog closure in toolServices, services.models.catalog() must return real rows and ModelSearch real matches.
  describe('a real catalog reaches services.models.catalog()', () => {
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

  // Settings' two model-tier rows via the same modelCatalog wiring: setDelegatedModel must refuse (and never write) a binding the live catalog does not recognize.
  describe('getDelegatedModels / setDelegatedModel', () => {
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

  describe('specialistRunsFor (run replay on attach)', () => {
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

    it('replays records beyond one process\'s spawn budget, newest included (the ledger outlives the per-process budget)', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null,
        undefined, undefined, undefined, undefined, undefined, undefined, new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      // The spawn budget (30) resets every app start while the ledger file keeps
      // growing, so a long-lived conversation holds more records than the budget.
      // The old test pinned a cap that kept the OLDEST 30 and hid the newest runs.
      const total = SPECIALIST_SPAWN_BUDGET_PER_SESSION + 5;
      for (let i = 0; i < total; i++) {
        await (h as any).ledger.recordStart(root, 'root-1', {
          childId: `child-${i}`, parentToolCallId: `tc-${i}`, agentType: 'explorer', title: `T${i}`,
          workDir: root, description: 'd', background: true,
          status: 'running', startedAt: Date.now(), delivered: false, owner: OWNER, missedSteers: [],
        });
      }

      const runs = h.specialistRunsFor('root-1');
      expect(runs).toHaveLength(total);
      expect(runs.some((r) => r.childId === `child-${total - 1}`)).toBe(true);

      await h.destroyAll();
    });
  });

  // Reconcile needs a REAL ledger (NativeHome on the tmp root); a fake would reimplement it.
  describe('restart recovery + subagent-card replay', () => {
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
        owner: { pid: deadPid(), instanceId: 'dead-instance' }, missedSteers: [],
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

    // reconcileDelegations once flagged "has undelivered" only for 'completed', so a parent whose only undelivered row was 'failed' never got its failure notice after a restart.
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

    // A FOREGROUND failure already reached the model as the Task tool's isError result but leaves a 'failed'/delivered:false row; without a `background` gate, reopening re-injected it, mislabeled "[Background specialist failed]".
    // Sibling test above pins that a genuine background failure is delivered once.
    it('a foreground specialist\'s failure is never re-delivered as a "[Background specialist failed]" notice after the conversation is reopened', async () => {
      const home = new NativeHome(root);
      const store = new SessionStore(home);
      const h = bootHost(home, store);
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      // What spawnSpecialist's throw path leaves: FOREGROUND, terminal 'failed', undelivered (confirmDelivered runs only on success).
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

      // settle (negative assertion): nothing fires, so wait past the delivery pass's async hops.
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
        missedSteers: [], claimedBy: { pid: deadPid(), instanceId: 'gone' }, claimedAt: Date.now() - 30_000,
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

      // `delivered` is set by a later async disk write — poll instead of racing it.
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

      // A real Task turn leaves a tool-use then a tool-result on the PARENT transcript; appended directly since task-tool.test.ts covers execute().
      await store.append(root, {
        type: 'tool-use', sessionId: 'root-1', uuid: 'u-tool-use', timestamp: Date.now(),
        data: { toolUseId: 'tc-1', toolName: 'Task', toolInput: { agent: 'explorer' } },
      });

      const { childId, report } = await h.spawnSpecialist('root-1', {
        specialist: EXPLORER, prompt: 'find the config loader', description: 'find the config loader', workDir: root, parentToolCallId: 'tc-1',
        token: { parentId: 'root-1', writer: false },
      });
      expect(report).toContain('Hi there'); // the suite's default `factory`'s one text step

      await store.append(root, {
        type: 'tool-result', sessionId: 'root-1', uuid: 'u-tool-result', timestamp: Date.now(),
        data: { toolUseId: 'tc-1', toolResult: report, isError: false },
      });

      await h.destroy('root-1');

      const h2 = bootHost(home, store);
      const resumed = await h2.resume('root-1', root);
      expect(resumed).toBe(true);

      const events = h2.getHistory('root-1')!;
      const taskIdx = events.findIndex((e) => e.type === 'tool-use' && e.data.toolName === 'Task');
      expect(taskIdx).toBeGreaterThanOrEqual(0);
      // Immediately after — not just "somewhere after".
      expect(looseData(events[taskIdx + 1]).agentId).toBe(childId);
      expect(looseData(events[taskIdx + 1]).parentAgentToolUseId).toBe(looseData(events[taskIdx]).toolUseId);
      // 'subagent-usage' is excluded: it is the PARENT's own bookkeeping event (spend), not a stamped child copy (see subagent-usage-event.test.ts).
      const stamped = events.filter((e) => looseData(e).agentId && e.type !== 'subagent-usage');
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
        specialist: EXPLORER, prompt: 'find the config loader', description: 'find the config loader', workDir: root, parentToolCallId: 'tc-1',
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
      expect(looseData(replayedText).partId).toBe(looseData(originalText).partId);

      await h2.destroyAll();
    });
  });

  // mergeChildEvents (Task 9, plan 1b) — the pure splice function, tested
  // directly per the brief rather than only through getHistory() above.
  describe('mergeChildEvents (pure function)', () => {
    const rec = (over: Partial<DelegationRecord> = {}): DelegationRecord => ({
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
      expect(looseData(merged[2]).agentId).toBe('child-1');
      expect(looseData(merged[2]).parentAgentToolUseId).toBe('tc-1');
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
      expect(merged.map((e) => `${e.type}:${looseData(e).agentId ?? looseData(e).toolUseId}`)).toEqual([
        'tool-use:tc-1', 'assistant-text:child-1', 'tool-use:tc-2', 'assistant-text:child-2',
      ]);
    });

    // Replay must match the live-copy guard: text-bearing thinking splices in stamped; heartbeat/stallWarning/toolPreparing never do. In-memory array, since the store already drops payload-less thinking and a disk round-trip would pass vacuously.
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
      expect(looseData(merged[1]).text).toBe('thinking it through');
      expect(merged[1].sessionId).toBe('root-1');
      expect(looseData(merged[1]).agentId).toBe('child-1');
      expect(looseData(merged[1]).parentAgentToolUseId).toBe('tc-1');
    });
  });

  // The catalog loads before the Task tool exists, is re-read at each root turn when a file changed, and the Task tool is rebuilt every turn.
  describe('specialist catalog wiring', () => {
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
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, catalog,
      );
    }
    // 'turn-complete' fires before runTurns clears inFlight, so a send() issued at once could be QUEUED and skip ensureFresh(); await entry.running.
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

    // task.ts resolves work_dir against the session folder only if harness-session hands createTaskTool the cwd; a dropped argument would name the Electron process's directory.
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

// The price a turn ran at is stamped in main, the only place that knows provider type ("free on your machine" vs "metered, no published rate").
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

  // `free` and `costUsd` come from independent sources and once produced {costUsd:7, free:true}; the invariant belongs where the number is stamped.
  it('never stamps a positive cost on a turn it also reports as free', async () => {
    const usage = await firstTurnUsage({
      providerType: 'local-engine', pricing: { in: 1_000_000, out: 2_000_000 },
    });
    expect(usage.free).toBe(true);
    expect(usage.costUsd).toBeNull();
  });

  // Prices attach per turn, never retroactively; two turns across a mid-session swap is the smallest shape that distinguishes that.
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
    // Turn 1 keeps its price (a regression floor; turn-complete builds usage fresh).
    // NOT pinned: a swap landing while a turn is still STREAMING stamps the in-flight turn with the new model/rate — a separate production defect, deliberately left unpinned.
    expect(turns[0].data.usage.costUsd).toBeCloseTo(7, 10);
    expect(turns[0].data.model).toBe('m-cheap');
    expect(turns[1].data.model).toBe('m-dear');
  });

  // Guards `if (free !== undefined) this.opts.free = free` in setBinding: deleting it left the rest of the suite green. A stale `free` suppresses the bill outright (swap local -> OpenRouter reports free forever).
  // Mutation-proved: with that line deleted turn 2 is {costUsd: null, free: true}.
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

  // 2026-09-09: the on-demand list (Task list: true) covers background
  // commands as well as specialists — one answer to "what am I waiting on?".
  it.skipIf(!posix)('listStatus names background commands alongside specialists, and is null when nothing is running', async () => {
    const listStatus = (host as any).live.get('p1').session.opts.toolServices.specialists.listStatus as (id: string) => string | null;
    expect(listStatus('p1')).toBeNull();
    const run = startIn('p1', 'sleep 5', 'tl');
    const text = listStatus('p1');
    expect(text).toContain('Background commands:');
    expect(text).toContain(`${run.shellId} · running`);
    expect(text).toContain('sleep 5');
    expect(text).not.toContain('Specialists:');   // none delegated in this conversation
    await reg('p1').kill(run.shellId, 'assistant');
    expect(listStatus('p1')).toContain('stopped');   // finished runs still list, with their state, as BashOutput does
    expect(listStatus('nope')).toBeNull();
  });

  it('every live session has a registry, reachable by the tool as ctx.shells', () => {
    expect(reg('p1')).toBeTruthy();
    expect((host as any).live.get('p1').session.opts.shells).toBe(reg('p1'));
  });

  // 2026-09-16: the still-running mark (LONG_RUN_NOTICE_MS) rides the same
  // idle-boundary lane as a finished notice, but as a PLAIN note — never a
  // completion, so the run stays unreported and its Bash card stays running.
  it.skipIf(!posix)('a still-running mark is injected as a shell-running note, not a completion', async () => {
    const run = startIn('p1', 'sleep 5', 'tu-long');
    const notice = waitForEvent(host, (e) => e.type === 'user-message' && e.data.injected === 'shell-running');
    // The registry's own timers are minutes long; fire the mark by hand.
    reg('p1').emit('long-running', run, 5 * 60_000);
    const e = await notice;
    expect(e.data.text).toBe(formatLongRunningNotice(run, 5 * 60_000));
    expect(e.data.injectedMeta).toEqual({ kind: 'shell-running', runs: [{ shellId: run.shellId, toolUseId: 'tu-long', elapsedMs: 5 * 60_000 }] });
    expect(run.reported).toBe(false);     // the finished notice is still owed
    expect(run.status).toBe('running');
    await reg('p1').kill(run.shellId, 'assistant');
  });

  // A mark queued while the parent was busy whose run finished before idle is DROPPED: "still running" above an exited card would be false.
  it.skipIf(!posix)('a mark whose run finished while it waited is dropped at delivery; the finished notice still goes out', async () => {
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
    await host.create({ sessionId: 'p3', cwd: root, binding });
    const injected: string[] = [];
    host.on('transcript-event', (e: any) => { if (e.type === 'user-message' && e.data.injected) injected.push(e.data.injected); });
    host.send('p3', 'busy');                                  // parent held mid-turn
    const run = startIn('p3', 'echo a', 'ta');
    reg('p3').emit('long-running', run, 5 * 60_000);          // mark queued behind the busy turn
    await run.exited;                                         // ...then the run finishes (completion queued after it)
    await vi.waitFor(() => expect(((host as any).pendingHostNotices.get('p3') ?? []).map((n: any) => n.meta?.kind)).toEqual(['shell-running', 'shell']));
    release();
    await waitForEvent(host, (e) => e.type === 'user-message' && e.data.injected === 'shell-complete');
    await host.drain('p3');
    expect(injected).toEqual(['shell-complete']);             // the stale mark never became a turn
  });

  it.skipIf(!posix)('two marks ready at the same idle boundary go out as ONE shell-running turn (D8)', async () => {
    const a = startIn('p1', 'sleep 5', 'ta');
    const b = startIn('p1', 'sleep 5', 'tb');
    const notice = waitForEvent(host, (e) => e.type === 'user-message' && e.data.injected === 'shell-running');
    // Queue both before any delivery pass can start (kick runs on setImmediate).
    reg('p1').emit('long-running', a, 5 * 60_000);
    reg('p1').emit('long-running', b, 15 * 60_000);
    const e = await notice;
    expect(e.data.injectedMeta.runs.map((r: any) => r.shellId)).toEqual([a.shellId, b.shellId]);
    expect(e.data.text).toContain(`${a.shellId} has been running for 5m`);
    expect(e.data.text).toContain(`${b.shellId} has been running for 15m`);
    await reg('p1').kill(a.shellId, 'assistant'); await reg('p1').kill(b.shellId, 'assistant');
  });

  it.skipIf(!posix)('a mark for a run that already ended queues nothing', async () => {
    const run = startIn('p1', 'echo x', 'tu-done');
    await run.exited;
    reg('p1').emit('long-running', run, 5 * 60_000);
    const pending = ((host as any).pendingHostNotices.get('p1') ?? []) as Array<{ meta?: { kind?: string } }>;
    expect(pending.filter((n) => n.meta?.kind === 'shell-running')).toEqual([]);
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
    // destroy() escalates SIGTERM->SIGKILL after 2s and drops the registry from the live map at once; without the draining set a SIGTERM-ignoring process was unreachable on quit. bash ignores the TERM here and loops.
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
    // settle (negative assertion): interrupt must not stop the background run.
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
    // WHY a signal, not a 50 ms sleep (final review F55): the note is written after the exit is
    // handled, a moment that stretches on a busy machine; wait for the line itself.
    const written = () => spy.mock.calls.map((c) => String(c[1]));
    await vi.waitFor(() => expect(written().some((l) => l.includes('a background command finished after its conversation was closed'))).toBe(true));
    expect(written().some((l) => l.includes('late permission answer'))).toBe(false);
    spy.mockRestore();
  });

  it.skipIf(!posix)('shell-event fires with the ShellRunView and shellRunsFor replays it', async () => {
    const views: any[] = [];
    host.on('shell-event', (e: any) => views.push(e));
    const a = startIn('p1', 'echo hi', 'ta');
    await a.exited;
    await vi.waitFor(() => expect(views[views.length - 1]).toEqual({ sessionId: 'p1', run: expect.objectContaining({ shellId: a.shellId, status: 'exited', exitCode: 0, tail: 'hi' }) }));
    expect(host.shellRunsFor('p1').map((v: any) => v.shellId)).toEqual([a.shellId]);
    expect(host.shellRunsFor('nope')).toEqual([]);
  });

  it.skipIf(!posix)('END TO END: the model starts a background command and gets its finished notice on the right card', async () => {
    // Lets the real Bash tool mint the run, covering ctx.toolCallId -> run.toolUseId -> the card's key -> ShellRunView; a break anywhere leaves the card silently never updating.
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

describe('background Bash records survive a restart (D2/D3/D4)', () => {
  const posix = process.platform !== 'win32';
  let root: string;
  let host: NativeSessionHost | undefined;
  const binding = { providerId: 'openrouter', modelId: 'm' };
  const chatty = async () => scriptedModel([stream(...textChunks('t', 'ok'), finishChunk('stop'))]) as any;
  const BASH = { shellCmd: '/bin/bash', shellArgs: ['-c'] };
  const boot = () => new NativeSessionHost(new SessionStore(new NativeHome(root)), chatty, NO_CONTEXT, async () => null, async () => null,
    undefined, undefined, undefined, undefined, undefined, undefined, new NativeHome(root));
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-shell-persist-')); });
  afterEach(async () => { await host?.destroyAll(); host = undefined; fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); });

  it.skipIf(!posix)('a command that finished before the app closed keeps its real exit code when the conversation is reopened', async () => {
    host = boot();
    await host.create({ sessionId: 's1', cwd: root, binding });
    const reg = (host as any).shellRegistries.get('s1');
    const started = reg.start({ toolUseId: 'tu-1', command: 'echo built; exit 4', description: 'build', cwd: root, ...BASH, env: { ...process.env } });
    await started.run.exited;
    await (host as any).shellSidecars.get('s1').flush();

    // "Restart": a brand-new host over the same home.
    await host.destroyAll();
    host = boot();
    await host.create({ sessionId: 's1', cwd: root, binding });
    const runs = await host.shellRunsForAsync('s1');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ toolUseId: 'tu-1', status: 'exited', exitCode: 4, command: 'echo built; exit 4', description: 'build', restored: true });
  });

  it.skipIf(!posix)('a conversation this host is not running still serves its saved commands (D4)', async () => {
    host = boot();
    await host.create({ sessionId: 's2', cwd: root, binding });
    const started = (host as any).shellRegistries.get('s2').start({ toolUseId: 'tu-2', command: 'exit 0', cwd: root, ...BASH, env: { ...process.env } });
    await started.run.exited;
    await (host as any).shellSidecars.get('s2').flush();
    await host.destroyAll();
    host = boot(); // s2 is NOT live here
    expect(host.shellRunsFor('s2')).toEqual([]); // the live-only view is still empty...
    const runs = await host.persistedShellRunsFor('s2', root); // ...but the saved record is served
    expect(runs[0]).toMatchObject({ toolUseId: 'tu-2', status: 'exited', exitCode: 0 });
  });

  it.skipIf(!posix || process.platform !== 'linux')('after a crash, a command whose process is still alive is reported running and Stop ends it (D3)', async () => {
    host = boot();
    await host.create({ sessionId: 's3', cwd: root, binding });
    const reg = (host as any).shellRegistries.get('s3');
    const started = reg.start({ toolUseId: 'tu-3', command: 'sleep 60', cwd: root, ...BASH, env: { ...process.env } });
    const pid = started.run.child.pid as number;
    await vi.waitFor(() => expect(started.run.procStart).toBeTruthy());
    await (host as any).shellSidecars.get('s3').flush();
    // Crash: the file claims "running" from an owner that no longer exists; the process lives on.
    const file = path.join(root, '.youcoded', 'sessions');
    const sidecar = fs.readdirSync(file, { recursive: true, encoding: 'utf8' }).map(String).find((f) => f.endsWith('s3.shells.json'))!;
    const full = path.join(file, sidecar);
    const doc = JSON.parse(fs.readFileSync(full, 'utf8'));
    doc.runs[0].ownerInstance = 'dead-instance';
    fs.writeFileSync(full, JSON.stringify(doc));
    (reg as any).runs.delete(started.run.shellId); // the old registry is gone without killing the process
    const oldHost = host; // the "crashed" app: abandoned, torn down at the end
    host = boot();
    await host.create({ sessionId: 's3', cwd: root, binding });
    const runs = await host.shellRunsForAsync('s3');
    expect(runs[0]).toMatchObject({ status: 'running', restored: true });
    expect(await host.killShell('s3', runs[0].shellId)).toEqual({ ok: true });
    expect(() => process.kill(pid, 0)).toThrow();
    await oldHost.destroyAll();
  });
});
