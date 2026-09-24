import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createArtifactToolUseTracker } from '../../src/renderer/state/artifact-tool-use-tracker';

/**
 * Pins the renderer half of the 2026-08-15 "YouCoded dies 16–21 s after
 * opening one big conversation" fix. Opening a conversation replays its whole
 * transcript through this handler — the events are byte-identical to live ones
 * — so a long session hands it ~1,000 Write/Edit/Read tool calls at once.
 * Before: one appendVersion AND one listSession per event. After: appends still
 * go out per event (main coalesces them; each carries the toolUseId main dedupes
 * on) and the drawer refresh runs ONCE per session after the burst settles.
 */

const ROOT = '/home/u/proj';

function toolUse(i: number, opts: { tool?: string; path?: string; sessionId?: string; toolUseId?: string } = {}) {
  return {
    type: 'tool-use',
    sessionId: opts.sessionId ?? 'sess-1',
    uuid: `u${i}`,
    timestamp: Date.now(),
    data: {
      toolName: opts.tool ?? 'Edit',
      toolUseId: opts.toolUseId ?? `toolu_${i}`,
      toolInput: { file_path: opts.path ?? `${ROOT}/src/file${i % 20}.ts` },
    },
  };
}

function sendUse(toolUseId: string, files: string[], sessionId = 'sess-1') {
  return { type: 'tool-use', sessionId, uuid: `u-${toolUseId}`, timestamp: Date.now(),
    data: { toolName: 'SendUserFile', toolUseId, toolInput: { files, status: 'normal' } } };
}
function toolResult(toolUseId: string, opts: { isError?: boolean; sessionId?: string } = {}) {
  return { type: 'tool-result', sessionId: opts.sessionId ?? 'sess-1', uuid: `r-${toolUseId}`, timestamp: Date.now(),
    data: { toolUseId, toolResult: 'x', isError: opts.isError ?? false } };
}

function makeTracker(overrides: Partial<Parameters<typeof createArtifactToolUseTracker>[0]> = {}) {
  const appendVersion = vi.fn().mockResolvedValue({ ok: true });
  const listSession = vi.fn().mockResolvedValue({ ok: true, artifacts: [{ id: 'a1' }] });
  const onSessionArtifacts = vi.fn();
  const tracker = createArtifactToolUseTracker({
    getSessions: () => [{ id: 'sess-1', cwd: ROOT }, { id: 'sess-2', cwd: ROOT }],
    getSessionArtifacts: () => [],
    appendVersion,
    listSession,
    onSessionArtifacts,
    refreshDelayMs: 250,
    log: () => {},
    ...overrides,
  });
  return { tracker, appendVersion, listSession, onSessionArtifacts };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('artifact tool-use tracker', () => {
  it('a 1,000-event replay burst refreshes the session drawer ONCE, not 1,000 times', async () => {
    const { tracker, appendVersion, listSession, onSessionArtifacts } = makeTracker();
    for (let i = 0; i < 1000; i++) tracker.handle(toolUse(i));
    // Every event still records its version (main coalesces those)...
    expect(appendVersion).toHaveBeenCalledTimes(1000);
    // ...but the drawer refresh waits for the burst to settle.
    await vi.advanceTimersByTimeAsync(0);
    expect(listSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(listSession).toHaveBeenCalledTimes(1);
    expect(listSession).toHaveBeenCalledWith('sess-1', ROOT);
    expect(onSessionArtifacts).toHaveBeenCalledWith('sess-1', [{ id: 'a1' }]);
  });

  it('every append carries the transcript toolUseId — the replay-dedupe key main uses', () => {
    const { tracker, appendVersion } = makeTracker();
    tracker.handle(toolUse(1, { tool: 'Write', toolUseId: 'toolu_abc' }));
    expect(appendVersion).toHaveBeenCalledWith(ROOT, 'sess-1', expect.objectContaining({
      type: 'create',
      toolUseId: 'toolu_abc',
      author: 'agent',
    }));
  });

  it('refreshes each session separately when a burst spans two sessions', async () => {
    const { tracker, listSession } = makeTracker();
    for (let i = 0; i < 20; i++) tracker.handle(toolUse(i, { sessionId: i % 2 ? 'sess-1' : 'sess-2' }));
    await vi.advanceTimersByTimeAsync(300);
    expect(listSession).toHaveBeenCalledTimes(2);
    expect(listSession.mock.calls.map((c) => c[0]).sort()).toEqual(['sess-1', 'sess-2']);
  });

  it('a steady trickle refreshes again after each quiet period (debounce, not throttle-once)', async () => {
    const { tracker, listSession } = makeTracker();
    tracker.handle(toolUse(1));
    await vi.advanceTimersByTimeAsync(300);
    expect(listSession).toHaveBeenCalledTimes(1);
    tracker.handle(toolUse(2));
    await vi.advanceTimersByTimeAsync(300);
    expect(listSession).toHaveBeenCalledTimes(2);
  });

  it('a failed append still schedules the refresh (the drawer must not go stale on one error)', async () => {
    const { tracker, listSession } = makeTracker({ appendVersion: vi.fn().mockRejectedValue(new Error('nope')) });
    tracker.handle(toolUse(1));
    await vi.advanceTimersByTimeAsync(300);
    expect(listSession).toHaveBeenCalledTimes(1);
  });

  it('dispose() cancels a pending refresh and ignores later events', async () => {
    const { tracker, appendVersion, listSession } = makeTracker();
    tracker.handle(toolUse(1));
    tracker.dispose();
    tracker.handle(toolUse(2));
    await vi.advanceTimersByTimeAsync(300);
    expect(appendVersion).toHaveBeenCalledTimes(1);
    expect(listSession).not.toHaveBeenCalled();
  });

  // App frees a closed tab's file list (SESSION_REMOVED). A refresh already in
  // flight when the tab closed must not load it back for a tab that is gone —
  // but a conversation resumed under the SAME id (native resume) is back in
  // the session list, and its refresh is real and must load.
  it('a refresh that lands after its tab closed is dropped; a resumed tab with the same id still loads', async () => {
    let sessions = [{ id: 'sess-1', cwd: ROOT }];
    const { tracker, listSession, onSessionArtifacts } = makeTracker({ getSessions: () => sessions });
    tracker.handle(toolUse(1));
    sessions = []; // the tab closes before the debounced refresh runs
    await vi.advanceTimersByTimeAsync(300);
    expect(listSession).toHaveBeenCalledTimes(1);
    expect(onSessionArtifacts).not.toHaveBeenCalled();

    sessions = [{ id: 'sess-1', cwd: ROOT }]; // resumed, same id
    tracker.handle(toolUse(2));
    await vi.advanceTimersByTimeAsync(300);
    expect(onSessionArtifacts).toHaveBeenCalledWith('sess-1', [{ id: 'a1' }]);
  });

  describe('what is tracked (unchanged behaviour, now pinned)', () => {
    it('ignores non-tool events, untracked tools, and events for unknown sessions', () => {
      const { tracker, appendVersion } = makeTracker();
      tracker.handle({ type: 'assistant-text', sessionId: 'sess-1', data: {} });
      tracker.handle(toolUse(1, { tool: 'Bash' }));
      tracker.handle(toolUse(2, { sessionId: 'nope' }));
      expect(appendVersion).not.toHaveBeenCalled();
    });

    it('tracks Read only for documents, and only the first read of a doc per session', () => {
      const { tracker, appendVersion } = makeTracker({
        getSessionArtifacts: () => [{ kind: 'internal', path: 'docs/known.md' }],
      });
      tracker.handle(toolUse(1, { tool: 'Read', path: `${ROOT}/src/code.ts` }));      // code read: not tracked
      tracker.handle(toolUse(2, { tool: 'Read', path: `${ROOT}/docs/known.md` }));    // already known: skipped
      tracker.handle(toolUse(3, { tool: 'Read', path: `${ROOT}/docs/new.md` }));      // first read of a doc
      expect(appendVersion).toHaveBeenCalledTimes(1);
      expect(appendVersion).toHaveBeenCalledWith(ROOT, 'sess-1', expect.objectContaining({ type: 'read', path: 'docs/new.md' }));
    });

    it('maps Write → create and Edit/MultiEdit → edit', () => {
      const { tracker, appendVersion } = makeTracker();
      tracker.handle(toolUse(1, { tool: 'Write' }));
      tracker.handle(toolUse(2, { tool: 'Edit' }));
      tracker.handle(toolUse(3, { tool: 'MultiEdit' }));
      expect(appendVersion.mock.calls.map((c) => c[2].type)).toEqual(['create', 'edit', 'edit']);
    });
  });

  describe('SendUserFile → delivered versions', () => {
    it('records nothing on the call and one delivered version per file on the successful result', () => {
      const { tracker, appendVersion } = makeTracker();
      tracker.handle(sendUse('toolu_s', [`${ROOT}/docs/report.md`, '/tmp/chart.png']));
      expect(appendVersion).not.toHaveBeenCalled();           // the file is not confirmed yet
      tracker.handle(toolResult('toolu_s'));
      expect(appendVersion).toHaveBeenCalledTimes(2);
      expect(appendVersion).toHaveBeenCalledWith(ROOT, 'sess-1', expect.objectContaining({
        type: 'delivered', author: 'agent', toolUseId: 'toolu_s', kind: 'internal', path: 'docs/report.md',
      }));
      expect(appendVersion).toHaveBeenCalledWith(ROOT, 'sess-1', expect.objectContaining({
        type: 'delivered', author: 'agent', toolUseId: 'toolu_s', kind: 'external', absolutePath: '/tmp/chart.png',
      }));
    });

    it('an error result drops the pending call — no ghost record for a typo’d path', () => {
      const { tracker, appendVersion } = makeTracker();
      tracker.handle(sendUse('toolu_bad', [`${ROOT}/docs/missing.md`]));
      tracker.handle(toolResult('toolu_bad', { isError: true }));
      tracker.handle(toolResult('toolu_bad'));                 // a late duplicate must not revive it
      expect(appendVersion).not.toHaveBeenCalled();
    });

    it('a result with no pending SendUserFile call is ignored', () => {
      const { tracker, appendVersion } = makeTracker();
      tracker.handle(toolResult('toolu_unknown'));
      expect(appendVersion).not.toHaveBeenCalled();
    });

    it('refreshes the drawer ONCE after a multi-file delivery', async () => {
      // A naive implementation that schedules the refresh inside the
      // per-file .map() (one scheduleRefresh call per file) still collapses
      // to a single listSession call here, because the mocked appendVersion
      // resolves instantly — all three per-file "schedule" calls land in the
      // same microtask and re-arm/cancel the same debounce timer before it
      // ever fires. That made the old version of this test unable to fail
      // for the bug it's named for.
      //
      // To actually discriminate "schedule once, after every file settles"
      // from "schedule once per file", give each file's appendVersion call
      // its own controllable promise and resolve them one at a time with a
      // gap LARGER than the debounce window. The correct implementation
      // (Promise.all(...).finally(() => scheduleRefresh(...))) does not
      // schedule anything until every append has resolved, so listSession
      // still fires exactly once regardless of how spread out those
      // resolutions are. A per-file implementation would instead re-arm (and
      // let fire) the debounce timer on each resolution, producing multiple
      // listSession calls when the gaps exceed the debounce window.
      // LOAD-BEARING INVARIANT: GAP_MS must stay > REFRESH_DELAY_MS. The gap is what
      // lets each file's refresh timer FIRE and clear before the next file resolves,
      // so a once-per-FILE implementation books three separate listSession calls.
      // Flip the inequality and each call merely cancel-and-rearms the same pending
      // timer, both implementations collapse to one call, and this test silently
      // reverts to the blind spot it was written to close (review 2026-08-25).
      const REFRESH_DELAY_MS = 50;
      const GAP_MS = 100;
      const resolvers: Array<() => void> = [];
      const appendVersion = vi.fn(() => new Promise((resolve) => {
        resolvers.push(() => resolve({ ok: true }));
      }));
      const { tracker, listSession } = makeTracker({ appendVersion, refreshDelayMs: REFRESH_DELAY_MS });

      tracker.handle(sendUse('toolu_s', [`${ROOT}/a.md`, `${ROOT}/b.md`, `${ROOT}/c.md`]));
      tracker.handle(toolResult('toolu_s'));
      expect(resolvers).toHaveLength(3); // one appendVersion call queued per file

      resolvers[0]();
      await vi.advanceTimersByTimeAsync(GAP_MS);
      resolvers[1]();
      await vi.advanceTimersByTimeAsync(GAP_MS);
      resolvers[2]();
      await vi.advanceTimersByTimeAsync(GAP_MS);

      expect(listSession).toHaveBeenCalledTimes(1);
    });
  });
});
