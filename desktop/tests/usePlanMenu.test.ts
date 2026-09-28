// nextTerminalUpdate is the plan driver's "wait for the screen to change".
// Regression pin: terminal-registry's onBufferReady fires a catch-up call for
// every registered terminal right after subscribing. If that counted as an
// update, every wait returned at once, the driver's poll loop spun on
// microtasks, and the terminal's own writes (which need the event loop) never
// landed — so "the menu left the screen" was never seen (found by
// PlanApprovalCard.test.tsx before this pin existed).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { nextTerminalUpdate } from '../src/renderer/hooks/usePlanMenu';
import { registerTerminal, unregisterTerminal } from '../src/renderer/hooks/terminal-registry';

afterEach(() => { vi.useRealTimers(); unregisterTerminal('t1'); });

describe('nextTerminalUpdate', () => {
  it('ignores the subscribe-time catch-up and waits for the timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    registerTerminal('t1', {} as never);
    let resolved = false;
    void nextTerminalUpdate('t1', 1000).then(() => { resolved = true; });
    for (let i = 0; i < 5; i++) await Promise.resolve(); // drain the catch-up microtasks
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolved).toBe(true);
  });
});
