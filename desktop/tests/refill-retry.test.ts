// A phone's conversations that could not be refilled are tried again on their own, and the strip
// says "Up to date" once they are — instead of "may be out of date" until the person presses Refresh.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRefillRetry, REFILL_RETRY_MS } from '../src/renderer/state/refill-retry';

function harness(results: Record<string, string[]>) {
  let hidden = false;
  let shown: (() => void) | null = null;
  const calls: string[] = [];
  const healed = vi.fn();
  const retry = createRefillRetry({
    refill: async (id) => { calls.push(id); return results[id]?.shift() ?? 'ok'; },
    healed,
    hidden: () => hidden,
    whenVisible: (cb) => { shown = cb; return () => { shown = null; }; },
  });
  return { retry, calls, healed, hide: (h: boolean) => { hidden = h; }, show: () => { hidden = false; shown?.(); } };
}

describe('refill retry', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('tries only the conversations that failed, and reports healed once all are filled', async () => {
    const h = harness({ b: ['failed', 'ok'] });
    h.retry.start(['a', 'b'], ['ok', 'failed']);
    await vi.advanceTimersByTimeAsync(REFILL_RETRY_MS[0]);
    expect(h.calls).toEqual(['b']);
    expect(h.healed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(REFILL_RETRY_MS[1]);
    expect(h.calls).toEqual(['b', 'b']);
    expect(h.healed).toHaveBeenCalledTimes(1);
  });

  it('stops after its last try, leaving Refresh to the person', async () => {
    const h = harness({ a: Array(20).fill('failed') });
    h.retry.start(['a'], ['failed']);
    await vi.advanceTimersByTimeAsync(REFILL_RETRY_MS.reduce((x, y) => x + y, 0) + 600_000);
    expect(h.calls).toHaveLength(REFILL_RETRY_MS.length);
    expect(h.healed).not.toHaveBeenCalled();
  });

  it('waits while the page is hidden, then tries when it is shown', async () => {
    const h = harness({});
    h.hide(true);
    h.retry.start(['a'], ['failed']);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.calls).toEqual([]);
    h.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toEqual(['a']);
    expect(h.healed).toHaveBeenCalledTimes(1);
  });

  it('a new round cancels the old one', async () => {
    const h = harness({});
    h.retry.start(['a'], ['failed']);
    h.retry.cancel();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.calls).toEqual([]);
  });

  it('does nothing when every fill succeeded', async () => {
    const h = harness({});
    h.retry.start(['a', 'b'], ['ok', 'ok']);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.calls).toEqual([]);
    expect(h.healed).not.toHaveBeenCalled();
  });
});
