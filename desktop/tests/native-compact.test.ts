// User-initiated /compact for a native session (M3 item 2).
//
// The point of this path is that it REPLACES a silent no-op: before it existed,
// choosing /compact in a native session went to guardedPtySend, returned false,
// and vanished. So the load-bearing assertions here are as much about honest
// refusals as about the happy path.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { dispatchSlashCommand } from '../src/renderer/state/slash-command-dispatcher';
import { runNativeSlashAction } from '../src/renderer/state/native-slash-actions';
import { NativeSessionHost } from '../src/main/harness/native-session-host';
import { HarnessSession } from '../src/main/harness/harness-session';
import { ASSISTANT_PRESET } from '../src/shared/harness-manifest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { TranscriptEvent } from '../src/shared/types';
import { EMPTY_SKILL_CATALOG } from './helpers/harness-fakes';

const OPTS = { skillCatalog: EMPTY_SKILL_CATALOG, sessionId: 's-1', cwd: '/tmp/x', harness: ASSISTANT_PRESET, binding: { providerId: 'openrouter', modelId: 'm' } };

function textModel(text: string) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'p1' },
          { type: 'text-delta', id: 'p1', delta: text },
          { type: 'text-end', id: 'p1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 5 }, outputTokens: { total: 3 } } },
        ],
      }),
    }),
  });
}

/** A session with `turns` user-delimited exchanges already in history. */
function seeded(turns: number, model: any) {
  const s = new HarnessSession(OPTS as any, async () => model);
  const history: any[] = [];
  for (let i = 0; i < turns; i++) {
    history.push({ role: 'user', content: `question ${i} ${'x'.repeat(400)}` });
    history.push({ role: 'assistant', content: `answer ${i} ${'y'.repeat(400)}` });
  }
  (s as any).history = history;
  return s;
}

function collect(session: HarnessSession): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
  return events;
}

describe('HarnessSession.compactNow — user-initiated /compact', () => {
  it('summarizes, emits compact-summary, and replaces history with summary + recent turns', async () => {
    const session = seeded(4, textModel('Earlier: user asked about X; we did Y.'));
    const events = collect(session);

    const result = await session.compactNow();

    expect(result).toEqual({ ok: true });
    const marker = events.find((e) => e.type === 'compact-summary');
    expect(marker).toBeTruthy();
    expect((marker as any).data.summary).toContain('Earlier: user asked about X');

    const history = (session as any).history as any[];
    // First message is the summary; the last 2 user-delimited turns survive verbatim.
    expect(history[0].role).toBe('user');
    expect(history[0].content).toContain('[Earlier conversation summary]');
    expect(history.length).toBeLessThan(8);
  });

  it('keeps accepted history and marker unchanged until a durable compaction commit resolves', async () => {
    let complete!: (event: TranscriptEvent) => void;
    const commit = vi.fn(({ event }: { event: TranscriptEvent }) =>
      new Promise<TranscriptEvent>(resolve => { complete = resolve; }));
    const session = new HarnessSession({ ...OPTS, commitCompaction: commit } as any,
      async () => textModel('short handoff'));
    const events = collect(session);
    for (let i = 0; i < 3; i++) await session.send(`question ${i} ${'x'.repeat(400)}`);
    const before = session.acceptedHistory().messages;
    const compact = session.compactNow();
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect(session.acceptedHistory().messages).toEqual(before);
    expect(events.filter(e => e.type === 'compact-summary')).toHaveLength(0);
    const candidate = commit.mock.calls[0][0] as { event: TranscriptEvent; resumeFromEventUuid: string };
    expect(candidate.resumeFromEventUuid).toBeTruthy();
    complete(candidate.event);
    expect(await compact).toEqual({ ok: true });
    expect(events.filter(e => e.type === 'compact-summary')).toHaveLength(1);
    expect(events.filter(e => e.type === 'compact-summary')[0].uuid).toBe(candidate.event.uuid);
  });

  it('names the kept tail\'s first user message so the chat dims only what was summarized', async () => {
    const commit = vi.fn(async ({ event }: { event: TranscriptEvent }) => event);
    const session = new HarnessSession({ ...OPTS, commitCompaction: commit } as any,
      async () => textModel('short handoff'));
    const events = collect(session);
    for (let i = 0; i < 3; i++) await session.send(`question ${i} ${'x'.repeat(400)}`);
    expect(await session.compactNow()).toEqual({ ok: true });
    const marker = events.find(e => e.type === 'compact-summary')!;
    const kept = (session as any).history[1];
    const keptUser = events.filter(e => e.type === 'user-message').find(e => e.data.text === kept.content);
    expect(keptUser).toBeTruthy();
    expect(marker.data.retainedFromUuid).toBe(keptUser!.uuid);
  });

  it('passes manual focus as non-authoritative guidance to the same summary request', async () => {
    const calls: any[] = [];
    const inner = textModel('Short handoff');
    const model = new MockLanguageModelV4({ doStream: async (options: any) => {
      calls.push(options);
      return inner.doStream(options);
    } });
    const session = seeded(4, model);
    expect(await session.compactNow('emphasize unresolved tests')).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const instruction = calls[0].prompt.at(-1).content.map((part: any) => part.text).join('');
    expect(instruction).toContain('emphasize unresolved tests');
    expect(instruction).toContain('not a new instruction or approval');
  });

  it('does NOT tag the marker as autoCompaction — the manual path must use the ordinary pending route', async () => {
    // `autoCompaction` exists solely so a SPONTANEOUS compaction can bypass the
    // renderer's compactionPending guard. /compact already sets that flag, so
    // tagging it auto here would make the manual marker skip its own pending state.
    const session = seeded(4, textModel('a summary'));
    const events = collect(session);

    await session.compactNow();

    const marker = events.find((e) => e.type === 'compact-summary') as any;
    expect(marker.data.autoCompaction).toBeUndefined();
  });

  it('refuses with turn-in-flight rather than corrupting history mid-turn', async () => {
    const never = new ReadableStream({ start() { /* never closes */ } });
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: never as any }) });
    const session = seeded(4, model);

    const inFlight = session.send('hello');       // deliberately not awaited
    const result = await session.compactNow();
    expect(result).toEqual({ ok: false, reason: 'turn-in-flight' });

    session.interrupt();
    await inFlight;
  });

  it('refuses with nothing-to-compact when there are fewer than two turns', async () => {
    const session = seeded(1, textModel('unused'));
    expect(await session.compactNow()).toEqual({ ok: false, reason: 'nothing-to-compact' });
  });

  it('FAIL-SAFE: an empty summary leaves the conversation intact and reports summary-failed', async () => {
    // A small local model returning nothing must never cost the user their history.
    const session = seeded(4, textModel(''));
    const before = [...((session as any).history as any[])];
    const events = collect(session);

    const result = await session.compactNow();

    expect(result).toEqual({ ok: false, reason: 'summary-failed' });
    expect(events.find((e) => e.type === 'compact-summary')).toBeUndefined();
    const after = (session as any).history as any[];
    expect(after.length).toBe(before.length);     // no messages dropped
  });

  it('FAIL-SAFE: a throwing model reports summary-failed instead of propagating', async () => {
    const throwing = new MockLanguageModelV4({ doStream: async () => { throw new Error('model exploded'); } });
    const session = seeded(4, throwing);
    await expect(session.compactNow()).resolves.toEqual({ ok: false, reason: 'summary-failed' });
  });

  it('releases the abort controller so the session still works after a compaction', async () => {
    // compactNow takes this.abort for the duration; a leaked controller would
    // brick every later send() via the re-entrancy guard.
    const session = seeded(4, textModel('a summary'));
    await session.compactNow();
    expect((session as any).abort).toBeNull();
    await expect(session.send('still working?')).resolves.toBeUndefined();
  });

  it('releases the abort controller even when the summary fails', async () => {
    const throwing = new MockLanguageModelV4({ doStream: async () => { throw new Error('boom'); } });
    const session = seeded(4, throwing);
    await session.compactNow();
    expect((session as any).abort).toBeNull();
  });

  it('allows a slow first text chunk and finishes after the old absolute 30-second cutoff', async () => {
    vi.useFakeTimers();
    try {
      let controller!: ReadableStreamDefaultController<any>;
      const model = new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream<any>({
        start(c) { controller = c; c.enqueue({ type: 'stream-start', warnings: [] }); },
      }) }) });
      const session = seeded(4, model);
      const compact = session.compactNow();
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect((session as any).abort?.signal.aborted).toBe(false);
      controller.enqueue({ type: 'text-start', id: 'p' });
      controller.enqueue({ type: 'text-delta', id: 'p', delta: 'a complete handoff' });
      await vi.advanceTimersByTimeAsync(59_000);
      expect((session as any).abort?.signal.aborted).toBe(false);
      controller.enqueue({ type: 'text-end', id: 'p' });
      controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 5 }, outputTokens: { total: 3 } } });
      controller.close();
      await expect(compact).resolves.toEqual({ ok: true });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('times out before first activity at five minutes without committing partial output', async () => {
    vi.useFakeTimers();
    try {
      const stream = new ReadableStream({ start(c) {
        c.enqueue({ type: 'stream-start', warnings: [] });
        // No text or reasoning: the provider stays silent past the first-activity deadline.
      } });
      const model = new MockLanguageModelV4({ doStream: async () => ({ stream: stream as any }) });
      const session = seeded(4, model);
      const events = collect(session);
      const compact = session.compactNow();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await expect(compact).resolves.toEqual({ ok: false, reason: 'summary-failed' });
      expect(events.find((e) => e.type === 'compact-summary')).toBeUndefined();
      expect((session as any).abort).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each([
    ['text', { type: 'text-delta', id: 'p', delta: 'partial' }],
    ['reasoning', { type: 'reasoning-delta', id: 'r', delta: 'thinking' }],
  ])('refreshes the silence timeout on %s activity, then aborts without committing partial text', async (_name, activity) => {
    vi.useFakeTimers();
    try {
      const stream = new ReadableStream({ start(c) {
        c.enqueue({ type: 'stream-start', warnings: [] });
        c.enqueue(activity);
      } });
      const model = new MockLanguageModelV4({ doStream: async () => ({ stream: stream as any }) });
      const session = seeded(4, model);
      const events = collect(session);
      const compact = session.compactNow();
      await vi.advanceTimersByTimeAsync(59_999);
      expect((session as any).abort?.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(compact).resolves.toEqual({ ok: false, reason: 'summary-failed' });
      expect(events.find((e) => e.type === 'compact-summary')).toBeUndefined();
      expect((session as any).abort).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each([
    ['length', 'length'],
    ['tool-call', 'tool-calls'],
  ])('does not commit a summary when stream finishes with %s', async (_name, finishReason) => {
    const stream = simulateReadableStream({ chunks: [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'p' },
      { type: 'text-delta', id: 'p', delta: 'not complete' },
      { type: 'text-end', id: 'p' },
      { type: 'finish', finishReason: { unified: finishReason, raw: finishReason }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
    ] });
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream }) });
    const session = seeded(4, model);
    const events = collect(session);
    await expect(session.compactNow()).resolves.toEqual({ ok: false, reason: 'summary-failed' });
    expect(events.find((e) => e.type === 'compact-summary')).toBeUndefined();
    expect((session as any).history).toHaveLength(8);
  });

  it('does not commit partial text when the summary stream errors', async () => {
    const stream = simulateReadableStream({ chunks: [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'p' },
      { type: 'text-delta', id: 'p', delta: 'partial' },
      { type: 'error', error: new Error('summary provider failed') },
    ] });
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream }) });
    const session = seeded(4, model);
    const events = collect(session);
    await expect(session.compactNow()).resolves.toEqual({ ok: false, reason: 'summary-failed' });
    expect(events.find((e) => e.type === 'compact-summary')).toBeUndefined();
    expect((session as any).history).toHaveLength(8);
  });

  it('cleans up the summary watchdog after a stream error', async () => {
    vi.useFakeTimers();
    try {
      const model = new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream<any>({ start(c) {
        c.enqueue({ type: 'stream-start', warnings: [] });
        c.enqueue({ type: 'error', error: new Error('provider failed') });
        c.close();
      } }) }) });
      const session = seeded(4, model);
      const before = (session as any).history.slice();
      expect(await session.compactNow()).toEqual({ ok: false, reason: 'summary-failed' });
      expect((session as any).history).toEqual(before);
      expect((session as any).rearmSummaryWatchdog).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('Stop aborts a stalled summary and never commits its partial text', async () => {
    const stream = new ReadableStream({ start(c) {
      c.enqueue({ type: 'stream-start', warnings: [] });
      c.enqueue({ type: 'text-start', id: 'p' });
      c.enqueue({ type: 'text-delta', id: 'p', delta: 'partial' });
    } });
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: stream as any }) });
    const session = seeded(4, model);
    const events = collect(session);
    const compact = session.compactNow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    session.interrupt();
    // Stop is reported as a stop, not as a model failure.
    await expect(compact).resolves.toEqual({ ok: false, reason: 'interrupted' });
    expect(events.find((e) => e.type === 'compact-summary')).toBeUndefined();
    expect((session as any).abort).toBeNull();
  });
});

// The /compact transport and host access fence belong with the user-initiated
// compaction behavior, not in a separate task-numbered test suite.
describe('native /compact focus propagation', () => {
  const source = (p: string) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

  it('retains optional args in native action, with bare /compact unchanged and CC PTY unchanged', () => {
    const input = (raw: string) => dispatchSlashCommand({ raw, sessionId: 's', view: 'chat', files: [],
      dispatch: vi.fn(), timeline: [], callbacks: {} } as any);
    expect(input('/compact').nativeAction).toEqual({ kind: 'compact' });
    expect(input('/compact emphasize OpenAPI types').nativeAction).toEqual({ kind: 'compact', focus: 'emphasize OpenAPI types' });
    expect(input('/compact emphasize OpenAPI types')).toMatchObject({ alsoSendToPty: '/compact emphasize OpenAPI types\r' });
  });

  it('forwards focus through renderer action and host without changing bare calls', async () => {
    const compact = vi.fn(async () => ({ ok: true }));
    const previous = (globalThis as any).window;
    (globalThis as any).window = { claude: { native: { compact } } };
    try {
      const deps = { sessionId: 's', dispatch: vi.fn() };
      expect(await runNativeSlashAction({ kind: 'compact', focus: 'remember tests' }, deps)).toBe(true);
      expect(await runNativeSlashAction({ kind: 'compact' }, deps)).toBe(true);
      expect(compact.mock.calls).toEqual([['s', 'remember tests'], ['s', undefined]]);
    } finally { (globalThis as any).window = previous; }
    const compactNow = vi.fn(async () => ({ ok: true }));
    const fake = { live: new Map([['s', { inFlight: false, queue: [], session: { compactNow } }]]), publishAcceptedHistory: vi.fn(), pendingDeliveryParents: new Set(), pendingHostNotices: new Map() };
    await NativeSessionHost.prototype.compact.call(fake as any, 's', 'remember tests');
    await NativeSessionHost.prototype.compact.call(fake as any, 's');
    expect(compactNow.mock.calls).toEqual([['remember tests', undefined], [undefined, undefined]]);
  });

  it('explains a failed summary without claiming any history was trimmed', async () => {
    const previous = (globalThis as any).window;
    (globalThis as any).window = { claude: { native: { compact: vi.fn(async () => ({ ok: false, reason: 'summary-failed' })) } } };
    try {
      const onToast = vi.fn();
      expect(await runNativeSlashAction({ kind: 'compact' }, { sessionId: 's', dispatch: vi.fn(), onToast })).toBe(false);
      expect(onToast).toHaveBeenCalledWith(expect.stringContaining('left intact'));
      expect(onToast.mock.calls[0][0]).not.toMatch(/trimmed|freed space/i);
    } finally { (globalThis as any).window = previous; }
  });

  it('refuses a send while a manual summary is running instead of acknowledging and losing it', async () => {
    let finish!: (result: { ok: true }) => void;
    const compactNow = vi.fn(() => new Promise<{ ok: true }>(resolve => { finish = resolve; }));
    const entry = { inFlight: false, queue: [], session: { compactNow } };
    // send() is now a thin wrapper around the private sendTurn() (plans Task 4:
    // it carries an optional historyNote/toolsDisabled through the queue) — the
    // fake needs that method too, or `this.sendTurn` inside send() resolves
    // against Object.prototype instead of the real implementation.
    const fake = {
      live: new Map([['s', entry]]), publishAcceptedHistory: vi.fn(), startingSends: new Map(), runTurns: vi.fn(async () => {}),
      pendingDeliveryParents: new Set(), pendingHostNotices: new Map(), sendTurn: (NativeSessionHost.prototype as any).sendTurn,
    };
    const pending = NativeSessionHost.prototype.compact.call(fake as any, 's');
    expect(NativeSessionHost.prototype.send.call(fake as any, 's', 'a new message')).toEqual({ status: 'failed', reason: 'compacting' });
    expect(await NativeSessionHost.prototype.compact.call(fake as any, 's')).toEqual({ ok: false, reason: 'turn-in-flight' });
    finish({ ok: true });
    expect(await pending).toEqual({ ok: true });
    expect(NativeSessionHost.prototype.send.call(fake as any, 's', 'a new message')).toEqual({ status: 'sent' });
  });

  it('does not let clear, a skill or idle delivery enter a manual summary', async () => {
    let finish!: (result: { ok: true }) => void;
    const entry = { inFlight: false, queue: [], session: { compactNow: vi.fn(() => new Promise<{ ok: true }>(resolve => { finish = resolve; })), clearHistory: vi.fn() } };
    const fake = { live: new Map([['s', entry]]), publishAcceptedHistory: vi.fn(), pendingDeliveryParents: new Set(['s']), pendingHostNotices: new Map(), kickIdleDeliveryPass: vi.fn() };
    const pending = NativeSessionHost.prototype.compact.call(fake as any, 's');
    expect(NativeSessionHost.prototype.clear.call(fake as any, 's')).toEqual({ ok: false, reason: 'turn-in-flight' });
    expect(entry.session.clearHistory).not.toHaveBeenCalled();
    expect(fake.publishAcceptedHistory).not.toHaveBeenCalled();
    expect(await NativeSessionHost.prototype.invokeSkill.call(fake as any, 's', 'some-skill')).toEqual({ ok: false, reason: 'turn-in-flight' });
    expect(NativeSessionHost.prototype.isIdle.call(fake as any, 's')).toBe(false);
    finish({ ok: true });
    await pending;
    expect(fake.kickIdleDeliveryPass).toHaveBeenCalledWith('s');
  });

  it('does not publish accepted history when manual compaction refuses without a rewrite', async () => {
    const compactNow = vi.fn(async () => ({ ok: false, reason: 'summary-failed' }));
    const fake = { live: new Map([['s', { inFlight: false, queue: [], session: { compactNow } }]]), publishAcceptedHistory: vi.fn(), pendingDeliveryParents: new Set(), pendingHostNotices: new Map() };
    expect(await NativeSessionHost.prototype.compact.call(fake as any, 's')).toEqual({ ok: false, reason: 'summary-failed' });
    expect(fake.publishAcceptedHistory).not.toHaveBeenCalled();
  });

  it('keeps optional focus on desktop and remote bridges through the same IPC payload; Android explicitly refuses the channel', () => {
    const preload = source('main/preload.ts');
    const remote = source('renderer/remote-shim.ts');
    const handler = source('main/ipc-handlers.ts');
    const android = fs.readFileSync(path.join(__dirname, '..', '..', 'app/src/main/kotlin/com/youcoded/app/runtime/SessionService.kt'), 'utf8');
    expect(preload).toMatch(/compact: \(sessionId: string, focus\?: string\) => ipcRenderer\.invoke\(IPC\.NATIVE_COMPACT, \{ sessionId, focus \}\)/);
    expect(remote).toMatch(/compact: \(sessionId: string, focus\?: string\) => invoke\('native:compact', \{ sessionId, focus \}\)/);
    expect(handler).toMatch(/ipcMain\.handle\(IPC\.NATIVE_COMPACT, async \(_e, \{ sessionId, focus \}/);
    expect(android).toContain('"native:compact",');
  });
});
