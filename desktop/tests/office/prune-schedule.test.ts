import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelAllPruning, createPruneScheduler } from '../../src/main/office/prune-schedule';

// The 1 GB tidy-up of kept versions: run a while after a new version, never on the save itself,
// requests while one waits join it, and runs are at least 5 minutes apart.
describe('the kept-versions tidy-up schedule', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('runs 30 s after a request, not at once', async () => {
    const run = vi.fn(async () => {});
    createPruneScheduler(run, { delayMs: 30_000, minGapMs: 300_000 }).request();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('joins requests made while one is waiting into a single run', async () => {
    const run = vi.fn(async () => {});
    const s = createPruneScheduler(run, { delayMs: 30_000, minGapMs: 300_000 });
    s.request(); s.request();
    await vi.advanceTimersByTimeAsync(10_000);
    s.request();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs at most once every 5 minutes', async () => {
    const run = vi.fn(async () => {});
    const s = createPruneScheduler(run, { delayMs: 30_000, minGapMs: 300_000 });
    s.request();
    await vi.advanceTimersByTimeAsync(30_000); // first run at 30 s
    s.request();
    await vi.advanceTimersByTimeAsync(299_999); // 5 min after the first run (30 s) is 330 s
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('keeps scheduling after a run that failed', async () => {
    const run = vi.fn(async () => { throw new Error('disk gone'); });
    const s = createPruneScheduler(run, { delayMs: 30_000, minGapMs: 300_000 });
    s.request();
    await vi.advanceTimersByTimeAsync(30_000);
    s.request();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('runs nothing once cancelled, and ignores later requests', async () => {
    const run = vi.fn(async () => {});
    const s = createPruneScheduler(run, { delayMs: 30_000, minGapMs: 300_000 });
    s.request();
    s.cancel();
    s.request();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(run).not.toHaveBeenCalled();
  });

  it('stops every waiting tidy-up at quit', async () => {
    const run = vi.fn(async () => {});
    createPruneScheduler(run, { delayMs: 30_000, minGapMs: 300_000 }).request();
    cancelAllPruning();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).not.toHaveBeenCalled();
  });
});
