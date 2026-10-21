// WHY separate from index-service's IO-core tests: these replace the live
// services and worker constructor, exercising production scheduling without
// touching any user index. Worker output is checked by chatsearch-index-worker.test.ts.
import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import os from 'node:os';

// vi.hoisted: index-service.ts's static import of conversations/service is
// itself hoisted above this file's top-level code, so the mock factory below
// would otherwise run before a plain `const` had initialized — vi.hoisted
// forces this state to exist first.
const state = vi.hoisted(() => ({
  list: vi.fn(() => { throw new Error('record enumeration must run in the worker'); }),
  core: vi.fn(() => { throw new Error('IO core must run in the worker'); }),
  jobs: [] as { workerData: unknown }[],
  workers: [] as { emit: (event: string, value?: unknown) => void; terminate: ReturnType<typeof vi.fn> }[],
  spawnFails: false,
  tagList: vi.fn(async () => []),
  tagsAvailable: true,
}));

vi.mock('../src/main/chatsearch-index/refresh-core', () => ({
  refreshChatsearchIndex: state.core,
  resolveTranscriptPathTwoStep: state.core,
}));

vi.mock('node:worker_threads', () => ({
  Worker: class {
    handlers = new Map<string, ((value?: unknown) => void)[]>();
    terminate = vi.fn(() => new Promise<number>(() => {}));
    unref = vi.fn();
    constructor(_file: string, options: { workerData: unknown }) {
      if (state.spawnFails) throw new Error('spawn failed');
      state.jobs.push(options);
      state.workers.push(this);
    }
    on(event: string, fn: (value?: unknown) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
      return this;
    }
    emit(event: string, value?: unknown) { for (const fn of this.handlers.get(event) ?? []) fn(value); }
  },
}));

vi.mock('../src/main/conversations/service', () => ({
  getConversationStore: () => ({
    // Only the root is safe on main; list throws if production calls it.
    root: () => os.homedir(),
    list: state.list,
  }),
  onConversationMetaChanged: () => () => {},
}));
vi.mock('../src/main/conversations/tag-registry-service', () => ({
  getTagRegistry: () => state.tagsAvailable ? { root: () => os.homedir(), list: state.tagList } : null,
}));

import {
  requestChatsearchRefresh, startChatsearchIndex, stopChatsearchIndex,
} from '../src/main/chatsearch-index/index-service';
import { createIndexWorkerRunner } from '../src/main/chatsearch-index/index-worker-runner';

const workerCalls = () => state.jobs.length;

// Drains whatever microtasks the currently-suspended async chain needs without
// advancing real wall-clock time — `advanceTimersByTimeAsync(0)` still pumps
// the microtask queue between checks, which is all that's needed to let
// `refreshFromLiveState` walk forward to its next await point.
const settle = async () => { await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(0); };

describe('chatsearch metadata-change reschedule', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.jobs.length = 0;
    state.workers.length = 0;
    state.spawnFails = false;
    state.list.mockClear();
    state.core.mockClear();
    state.tagList.mockClear();
    state.tagsAvailable = true;
  });

  afterEach(() => {
    stopChatsearchIndex();
    for (const worker of state.workers) worker.emit('exit', 1);
    vi.useRealTimers();
    expect(state.list).not.toHaveBeenCalled();
    expect(state.core).not.toHaveBeenCalled();
    expect(state.tagList).not.toHaveBeenCalled();
  });

  it('forwards the tag root without enumerating or folding tags on main', async () => {
    startChatsearchIndex();
    await settle();
    expect(state.tagList).not.toHaveBeenCalled();
    expect(state.jobs[0].workerData).toEqual({ homeRoot: os.homedir(), storeRoot: os.homedir(), tagsRoot: os.homedir() });
  });

  it('forwards a missing tag registry as null without skipping the refresh', async () => {
    state.tagsAvailable = false;
    startChatsearchIndex();
    await settle();
    expect(state.jobs[0].workerData).toEqual({ homeRoot: os.homedir(), storeRoot: os.homedir(), tagsRoot: null });
  });

  it('runs one more cycle after a trigger arrives mid-cycle, instead of dropping it', async () => {
    startChatsearchIndex(); // Startup creates exactly one worker, held until exit.
    await settle();
    expect(workerCalls()).toBe(1);
    expect(state.list).not.toHaveBeenCalled();
    expect(state.jobs[0].workerData).toEqual({ homeRoot: os.homedir(), storeRoot: os.homedir(), tagsRoot: os.homedir() });

    // A tag/note change arrives while cycle 1 is still in flight.
    requestChatsearchRefresh();
    await vi.advanceTimersByTimeAsync(3_000); // debounce timer fires here
    await settle();

    // The fired trigger must be REMEMBERED, not started as a concurrent second
    // cycle (that would race the same build lock) and not silently dropped.
    expect(workerCalls()).toBe(1);

    // Let cycle 1 finish.
    state.workers[0].emit('message', { ok: true, value: true });
    state.workers[0].emit('exit', 0);
    await settle();
    await settle();

    // The remembered trigger ran as a second cycle once the first finished.
    expect(workerCalls()).toBe(2);
    expect(state.list).not.toHaveBeenCalled();
  });

  it('does not queue a rerun when no trigger arrives during the cycle', async () => {
    startChatsearchIndex();
    await settle();
    expect(workerCalls()).toBe(1);

    state.workers[0].emit('message', { ok: true, value: true });
    state.workers[0].emit('exit', 0);
    await settle();
    await settle();

    // Nothing requested a refresh mid-cycle, so there is nothing to catch up on.
    expect(workerCalls()).toBe(1);
  });

  it('coalesces bursts and waits for actual exit after a success reply', async () => {
    startChatsearchIndex();
    await settle();
    state.workers[0].emit('message', { ok: true, value: true });
    requestChatsearchRefresh();
    requestChatsearchRefresh();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(workerCalls()).toBe(1);
    state.workers[0].emit('exit', 0);
    await settle();
    expect(workerCalls()).toBe(2);
  });

  it('stops queued reruns and ignores late replies, including across restart', async () => {
    startChatsearchIndex();
    await settle();
    requestChatsearchRefresh();
    await vi.advanceTimersByTimeAsync(3_000);
    stopChatsearchIndex();
    expect(state.workers[0].terminate).toHaveBeenCalledOnce();
    state.workers[0].emit('message', { ok: true, value: true });
    await settle();
    expect(workerCalls()).toBe(1);
    startChatsearchIndex();
    await settle();
    expect(workerCalls()).toBe(1);
    state.workers[0].emit('exit', 1);
    await settle();
    expect(workerCalls()).toBe(2);
    // A stale success must not release or finish the replacement worker.
    state.workers[0].emit('message', { ok: true, value: true });
    requestChatsearchRefresh();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(workerCalls()).toBe(2);
  });

  it('discards a pending rerun when stopped and the old worker later exits', async () => {
    startChatsearchIndex();
    await settle();
    requestChatsearchRefresh();
    await vi.advanceTimersByTimeAsync(3_000);
    stopChatsearchIndex();
    state.workers[0].emit('message', { ok: true, value: true });
    state.workers[0].emit('exit', 0);
    await settle();
    await vi.advanceTimersByTimeAsync(120_000); // settle: no queued trigger survives stop
    expect(workerCalls()).toBe(1);
  });

  it('times out without launching a replacement before the old thread exits', async () => {
    startChatsearchIndex();
    await settle();
    // Even a resolved terminate promise is not the worker exit signal.
    state.workers[0].terminate.mockResolvedValueOnce(1);
    requestChatsearchRefresh();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(state.workers[0].terminate).toHaveBeenCalledOnce();
    expect(workerCalls()).toBe(1);
    state.workers[0].emit('message', { ok: true, value: true });
    await settle();
    expect(workerCalls()).toBe(1);
    state.workers[0].emit('exit', 1);
    await settle();
    expect(workerCalls()).toBe(2);
  });

  it.each(['error', 'exit', 'reply'] as const)('retries after worker %s failure without running the IO core on main', async (kind) => {
    startChatsearchIndex();
    await settle();
    if (kind === 'error') state.workers[0].emit('error', new Error('disk error'));
    if (kind === 'reply') state.workers[0].emit('message', { ok: false, error: 'failed build' });
    state.workers[0].emit('exit', kind === 'reply' ? 0 : 1);
    await settle();
    requestChatsearchRefresh();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(workerCalls()).toBe(2);
    expect(state.list).not.toHaveBeenCalled();
  });

  it.each(['stop', 'timeout'] as const)('bounds the caller wait on %s even if termination never resolves', async (kind) => {
    const runner = createIndexWorkerRunner({ timeoutMs: 100 });
    const job = { homeRoot: os.homedir(), storeRoot: os.homedir(), tagsRoot: os.homedir() };
    const result = runner.run(job).catch((error: Error) => error.message);
    if (kind === 'stop') runner.stop();
    else await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatch(kind === 'stop' ? /stopped/ : /timed out/);
    expect(runner.busy()).toBe(true);
    await expect(runner.run(job)).rejects.toThrow('still running or stopping');
    state.workers[0].emit('exit', 1);
    expect(runner.busy()).toBe(false);
  });

  it('retries construction failure on the next trigger with no blocking fallback', async () => {
    state.spawnFails = true;
    startChatsearchIndex();
    await settle();
    expect(workerCalls()).toBe(0);
    expect(state.list).not.toHaveBeenCalled();
    state.spawnFails = false;
    requestChatsearchRefresh();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(workerCalls()).toBe(1);
  });
});
