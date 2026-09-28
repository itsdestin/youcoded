// A window's X: Office saves first, then the sessions prompt, then the window goes. The sessions
// answer is carried out only on the close that goes through; a close the page vetoed asks again;
// a hung window can be closed anyway.
import { describe, expect, it, vi } from 'vitest';
import { HUNG_CLOSE_WINDOW_MS, createCloseGate } from '../src/main/window-close-gate';

type Office = 'none' | 'hold' | 'hold-fail';

function gate(over: { sessions?: number; answer?: boolean } = {}) {
  const state = { sessions: over.sessions ?? 1, destroyed: false, office: 'none' as Office, hung: false, t: 0, closeAnyway: true };
  const deps = {
    buddy: false,
    shuttingDown: () => false,
    holdForOffice: vi.fn((ev: { preventDefault(): void }, onFailed: () => void) => {
      if (state.office === 'none') return false;
      ev.preventDefault();
      if (state.office === 'hold-fail') onFailed();
      return true;
    }),
    sessionCount: () => state.sessions,
    ask: vi.fn(async () => over.answer ?? true),
    apply: vi.fn((a: boolean) => a),
    closes: (a: boolean) => a,
    isDestroyed: () => state.destroyed,
    close: vi.fn(),
    unresponsive: () => state.hung,
    confirmCloseHung: vi.fn(async () => state.closeAnyway),
    destroy: vi.fn(),
    now: () => state.t,
  };
  const ev = () => ({ preventDefault: vi.fn() });
  return { g: createCloseGate<boolean>(deps), deps, state, ev };
}

describe('the window close gate', () => {
  it('asks about sessions, and carries the answer out only on the close that goes through', async () => {
    const { g, deps, ev } = gate();
    const first = ev();
    await g.onClose(first);
    expect(first.preventDefault).toHaveBeenCalled();
    expect(deps.ask).toHaveBeenCalledWith(1);
    expect(deps.apply).not.toHaveBeenCalled(); // not yet: the final Office pass comes first
    expect(deps.close).toHaveBeenCalledTimes(1);
    const again = ev();
    await g.onClose(again); // the re-issued close
    expect(again.preventDefault).not.toHaveBeenCalled();
    expect(deps.apply).toHaveBeenCalledTimes(1);
    expect(deps.ask).toHaveBeenCalledTimes(1);
  });

  it('leaves the sessions alone when the final Office save fails and the person chooses Review', async () => {
    const { g, deps, state, ev } = gate();
    await g.onClose(ev()); // sessions prompt: confirmed
    state.office = 'hold-fail';
    await g.onClose(ev()); // the re-issued close: Office saves, fails, asks (Review / Close anyway)
    expect(deps.apply).not.toHaveBeenCalled();
    // Review… then later a fresh X: Office saves again (and succeeds this time)…
    state.office = 'hold';
    await g.onClose(ev());
    state.office = 'none';
    const reissued = ev();
    await g.onClose(reissued); // …and the sessions prompt comes back, once — nothing was ended
    expect(deps.apply).not.toHaveBeenCalled();
    expect(deps.ask).toHaveBeenCalledTimes(2);
    expect(reissued.preventDefault).toHaveBeenCalled();
  });

  it('carries the sessions answer out after Close anyway on a failed Office save', async () => {
    const { g, deps, state, ev } = gate();
    await g.onClose(ev());
    state.office = 'hold-fail';
    await g.onClose(ev());
    state.office = 'none'; // Close anyway: main re-issues the close past the Office hold
    const e = ev();
    await g.onClose(e);
    expect(deps.apply).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(deps.ask).toHaveBeenCalledTimes(1);
  });

  it('asks again (Office and sessions) after the page vetoed the confirmed close', async () => {
    const { g, deps, state, ev } = gate();
    await g.onClose(ev());
    await g.onClose(ev()); // goes through (apply)…
    g.onUnloadPrevented(); // …but the unload guard kept the window
    state.office = 'hold';
    await g.onClose(ev());
    expect(deps.holdForOffice).toHaveBeenCalledTimes(3);
    state.office = 'none';
    const e = ev();
    await g.onClose(e);
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

describe('a window that stopped responding', () => {
  // The hung path: X → Office hold → no answer in 5 s → main re-issues the close → the page
  // cannot run its unload, so the window stays. A second X then asks natively.
  async function stuck() {
    const t = gate({ sessions: 0 });
    t.state.office = 'hold';
    await t.g.onClose(t.ev()); // Office asks the (hung) page
    t.state.office = 'none';
    t.state.t = 5_000;
    await t.g.onClose(t.ev()); // main re-issued the close after its cap
    t.state.hung = true;
    return t;
  }

  it('asks "close it anyway?" on a second X within 10 s, and destroys the window on yes', async () => {
    const { g, deps, state, ev } = await stuck();
    state.t = 5_000 + HUNG_CLOSE_WINDOW_MS - 1;
    const e = ev();
    await g.onClose(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(deps.confirmCloseHung).toHaveBeenCalledTimes(1);
    expect(deps.destroy).toHaveBeenCalledTimes(1);
  });

  it('waits when the person chooses Wait', async () => {
    const { g, deps, state, ev } = await stuck();
    state.closeAnyway = false;
    state.t = 6_000;
    await g.onClose(ev());
    expect(deps.destroy).not.toHaveBeenCalled();
  });

  it('does not ask when the window is responsive, or after 10 s', async () => {
    const late = await stuck();
    late.state.t = 5_000 + HUNG_CLOSE_WINDOW_MS + 1;
    await late.g.onClose(late.ev());
    expect(late.deps.confirmCloseHung).not.toHaveBeenCalled();
    const fine = await stuck();
    fine.state.hung = false;
    fine.state.t = 6_000;
    await fine.g.onClose(fine.ev());
    expect(fine.deps.confirmCloseHung).not.toHaveBeenCalled();
  });
});
