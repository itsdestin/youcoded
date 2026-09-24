// Design: docs/active/specs/2026-09-24-welcome-back-design.md §4, §6.
// A fake timer + a deterministic id generator (same DI shape as
// welcome-back-store.test.ts's fake fs) let these assert on exact ordering —
// including that a reused request never sends a second push.
import { describe, it, expect, beforeEach } from 'vitest';
import { createCloseRequestManager, type CloseRequestManager, type CloseRequestPush } from '../src/main/close-request-manager';

/** A manual, single-shot fake timer: schedules are recorded but never fire
 *  until the test calls `fireDue()` (or `cancel(handle)` removes them first),
 *  so a test controls the exact moment a timeout resolves — no real 5s wait,
 *  and no vi.useFakeTimers side effects on the rest of the file. */
function createFakeTimers() {
  let nextHandle = 1;
  const scheduled = new Map<number, () => void>();
  return {
    setTimer: (fn: () => void, _ms: number) => {
      const handle = nextHandle++;
      scheduled.set(handle, fn);
      return handle;
    },
    clearTimer: (handle: unknown) => { scheduled.delete(handle as number); },
    /** Fires every timer still scheduled, in the order they were set. */
    fireDue(): void {
      const due = [...scheduled.entries()];
      scheduled.clear();
      for (const [, fn] of due) fn();
    },
    pendingCount: () => scheduled.size,
  };
}

function createIdSequence() {
  let n = 0;
  return () => `req-${++n}`;
}

describe('createCloseRequestManager', () => {
  let timers: ReturnType<typeof createFakeTimers>;
  let genId: () => string;
  let manager: CloseRequestManager;

  beforeEach(() => {
    timers = createFakeTimers();
    genId = createIdSequence();
    manager = createCloseRequestManager({ setTimer: timers.setTimer, clearTimer: timers.clearTimer, genId });
  });

  it('sends one push and resolves {close:false} on Cancel', async () => {
    const pushes: CloseRequestPush[] = [];
    const promise = manager.request(1, 2, (p) => pushes.push(p));
    expect(pushes).toEqual([{ requestId: 'req-1', sessions: 2 }]);
    manager.answer('req-1', { close: false });
    await expect(promise).resolves.toEqual({ close: false });
  });

  it('resolves {close:true, reopen:false} when the switch was left off', async () => {
    const promise = manager.request(1, 1, () => {});
    manager.answer('req-1', { close: true, reopen: false });
    await expect(promise).resolves.toEqual({ close: true, reopen: false });
  });

  it('resolves {close:true, reopen:true} when "Resume on Next Launch?" was on', async () => {
    const promise = manager.request(1, 1, () => {});
    manager.answer('req-1', { close: true, reopen: true });
    await expect(promise).resolves.toEqual({ close: true, reopen: true });
  });

  it('a timeout resolves {close:true, reopen:true} — destroy and close, but keep tracked', async () => {
    const promise = manager.request(1, 3, () => {});
    expect(timers.pendingCount()).toBe(1);
    timers.fireDue();
    await expect(promise).resolves.toEqual({ close: true, reopen: true });
  });

  it('a late answer after a timeout has already settled the request is ignored', async () => {
    const promise = manager.request(1, 1, () => {});
    timers.fireDue(); // settles as {close:true, reopen:true}
    await expect(promise).resolves.toEqual({ close: true, reopen: true });
    // The renderer's answer arrives anyway (a slow round trip) — must not throw
    // and must not resolve anything a second time (there is nothing left to
    // resolve; the promise already settled above).
    expect(() => manager.answer('req-1', { close: false })).not.toThrow();
  });

  it('a second close press for the same window reuses the pending request — no second push', async () => {
    const pushes: CloseRequestPush[] = [];
    const first = manager.request(1, 2, (p) => pushes.push(p));
    const second = manager.request(1, 2, (p) => pushes.push(p));
    expect(pushes).toHaveLength(1); // the second call sent nothing
    manager.answer('req-1', { close: true, reopen: false });
    await expect(first).resolves.toEqual({ close: true, reopen: false });
    await expect(second).resolves.toEqual({ close: true, reopen: false });
  });

  it('settleAll resolves every pending request as keep-tracked and reports each for the cancelled push', async () => {
    const w1 = manager.request(1, 2, () => {});
    const w2 = manager.request(2, 1, () => {});
    const cancelled: Array<[number, string]> = [];
    manager.settleAll((windowId, requestId) => cancelled.push([windowId, requestId]));
    await expect(w1).resolves.toEqual({ close: true, reopen: true });
    await expect(w2).resolves.toEqual({ close: true, reopen: true });
    expect(cancelled.sort()).toEqual([[1, 'req-1'], [2, 'req-2']].sort());
    // The pending timers must not still be armed — nothing left to leak.
    expect(timers.pendingCount()).toBe(0);
  });

  it('a late answer after settleAll (SIGTERM/before-quit route) is ignored', async () => {
    const promise = manager.request(1, 1, () => {});
    manager.settleAll(() => {});
    await expect(promise).resolves.toEqual({ close: true, reopen: true });
    expect(() => manager.answer('req-1', { close: false })).not.toThrow();
  });

  it('a fresh request for a window whose previous one already settled gets a NEW requestId', async () => {
    const pushes: CloseRequestPush[] = [];
    const first = manager.request(1, 1, (p) => pushes.push(p));
    manager.answer('req-1', { close: false });
    await first;
    manager.request(1, 1, (p) => pushes.push(p));
    expect(pushes.map((p) => p.requestId)).toEqual(['req-1', 'req-2']);
  });
});
