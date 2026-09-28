// A window's X: Office saves first, then the sessions prompt, then the window goes — and a
// close the page vetoed after the prompt was answered asks again next time, never a silent X.
import { describe, expect, it, vi } from 'vitest';
import { createCloseGate } from '../src/main/window-close-gate';

function gate(over: { sessions?: number; officeHolds?: () => boolean; answer?: boolean } = {}) {
  const state = { sessions: over.sessions ?? 1, destroyed: false };
  const deps = {
    buddy: false,
    shuttingDown: () => false,
    holdForOffice: vi.fn(over.officeHolds ?? (() => false)),
    sessionCount: () => state.sessions,
    ask: vi.fn(async () => over.answer ?? true),
    apply: vi.fn((a: boolean) => a),
    isDestroyed: () => state.destroyed,
    close: vi.fn(),
  };
  const ev = () => ({ preventDefault: vi.fn() });
  return { g: createCloseGate<boolean>(deps), deps, state, ev };
}

describe('the window close gate', () => {
  it('asks about sessions, then closes once the person confirms', async () => {
    const { g, deps, ev } = gate();
    const e = ev();
    await g.onClose(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(deps.ask).toHaveBeenCalledWith(1);
    expect(deps.close).toHaveBeenCalledTimes(1);
    // The close it re-issued goes through without asking again.
    const again = ev();
    await g.onClose(again);
    expect(again.preventDefault).not.toHaveBeenCalled();
    expect(deps.ask).toHaveBeenCalledTimes(1);
  });

  it('lets Office hold the close first, even after the sessions prompt was answered', async () => {
    let holds = false;
    const { g, deps, ev } = gate({ officeHolds: () => holds });
    await g.onClose(ev());
    holds = true;
    await g.onClose(ev()); // the re-issued close: Office saves once more before the window goes
    expect(deps.holdForOffice).toHaveBeenCalledTimes(2);
  });

  it('asks again (Office and sessions) after the page vetoed the confirmed close', async () => {
    let holds = false;
    const { g, deps, ev } = gate({ officeHolds: () => holds });
    await g.onClose(ev()); // prompt answered, close re-issued…
    g.onUnloadPrevented(); // …but the unload guard kept the window (a change during the prompt)
    holds = true;
    await g.onClose(ev()); // the next X: Office saves (and prompts if that fails)
    expect(deps.holdForOffice).toHaveBeenCalledTimes(2);
    holds = false;
    const e = ev();
    await g.onClose(e); // and the sessions prompt comes back rather than a silent pass
    expect(e.preventDefault).toHaveBeenCalled();
    expect(deps.ask).toHaveBeenCalledTimes(2);
  });

  it('closes freely with no sessions, and never for a Cancel', async () => {
    const free = gate({ sessions: 0 });
    const e = free.ev();
    await free.g.onClose(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    const cancel = gate({ answer: false });
    await cancel.g.onClose(cancel.ev());
    expect(cancel.deps.close).not.toHaveBeenCalled();
  });
});
