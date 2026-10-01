// A window's X: the last window's unsaved files first, then the sessions prompt, then the window
// goes. The sessions answer is carried out only on the close that goes through; a close the page
// vetoed asks again; a hung window can be closed anyway. (Task 8 removed the Office save step.)
import { describe, expect, it, vi } from 'vitest';
import { HUNG_CLOSE_WINDOW_MS, createCloseGate } from '../src/main/window-close-gate';

function gate(over: { sessions?: number; answer?: boolean } = {}) {
  const state = { sessions: over.sessions ?? 1, destroyed: false, hung: false, t: 0, closeAnyway: true, refuse: false };
  const deps = {
    buddy: false,
    shuttingDown: () => false,
    refuseForUnsaved: vi.fn(() => state.refuse),
    sessionIds: () => Array.from({ length: state.sessions }, (_, i) => `s${i + 1}`),
    ask: vi.fn(async () => over.answer ?? true),
    apply: vi.fn((a: boolean, _ids: string[]) => a),
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
    expect(deps.apply).not.toHaveBeenCalled();
    expect(deps.close).toHaveBeenCalledTimes(1);
    const again = ev();
    await g.onClose(again); // the re-issued close
    expect(again.preventDefault).not.toHaveBeenCalled();
    expect(deps.apply).toHaveBeenCalledTimes(1);
    expect(deps.ask).toHaveBeenCalledTimes(1);
  });

  it('asks again after the page vetoed the confirmed close', async () => {
    const { g, deps, ev } = gate();
    await g.onClose(ev());
    await g.onClose(ev()); // goes through (apply)…
    g.onUnloadPrevented(); // …but an unsaved text file's guard kept the window
    const e = ev();
    await g.onClose(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(deps.ask).toHaveBeenCalledTimes(2);
  });

  it('a veto between the answer and its close drops the answer', async () => {
    const { g, deps, ev } = gate();
    let answer!: (a: boolean) => void;
    deps.ask.mockImplementationOnce(() => new Promise<boolean>((r) => (answer = r)));
    const first = g.onClose(ev());
    answer(true);
    await first; // confirmed, close re-issued — and the page vetoes it before it arrives
    g.onUnloadPrevented();
    await g.onClose(ev()); // a fresh X
    expect(deps.apply).not.toHaveBeenCalled();
    expect(deps.ask).toHaveBeenCalledTimes(2);
  });

  it('two presses during one sessions prompt: one prompt, one re-issued close', async () => {
    const { g, deps, ev } = gate();
    let answer!: (a: boolean) => void;
    deps.ask.mockImplementation(() => new Promise<boolean>((r) => (answer = r)));
    const first = g.onClose(ev());
    const secondEv = ev();
    const second = g.onClose(secondEv);
    expect(secondEv.preventDefault).toHaveBeenCalled(); // the second press does not close the window
    answer(true);
    await Promise.all([first, second]);
    expect(deps.ask).toHaveBeenCalledTimes(1);
    expect(deps.close).toHaveBeenCalledTimes(1);
  });

  it("the last window's unsaved files are asked about before anything else", async () => {
    const { g, deps, state, ev } = gate();
    state.refuse = true;
    const e = ev();
    await g.onClose(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(deps.ask).not.toHaveBeenCalled();
    state.refuse = false; // saved or discarded: the close goes on to the sessions prompt
    await g.onClose(ev());
    expect(deps.ask).toHaveBeenCalledTimes(1);
  });

  it('a refusal on the close re-issued after the sessions prompt drops that answer', async () => {
    const { g, deps, state, ev } = gate();
    await g.onClose(ev()); // sessions prompt: confirmed, close re-issued…
    state.refuse = true;
    await g.onClose(ev()); // …which the unsaved files refuse
    state.refuse = false; // later (saved) a fresh X
    const e = ev();
    await g.onClose(e);
    expect(deps.apply).not.toHaveBeenCalled(); // the old answer is not carried out
    expect(deps.ask).toHaveBeenCalledTimes(2); // asked again
    expect(e.preventDefault).toHaveBeenCalled();
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

  it('ends only the sessions owned when the person confirmed', async () => {
    const { g, deps, state, ev } = gate({ sessions: 2 });
    await g.onClose(ev()); // confirmed with s1, s2
    state.sessions = 3; // a session started before the close goes through
    await g.onClose(ev());
    expect(deps.apply).toHaveBeenCalledWith(true, ['s1', 's2']);
  });
});

describe('Office documents in a closing window', () => {
  it("its editors journal their last edits first; then the close goes on", async () => {
    const { deps, ev } = gate({ sessions: 0 });
    let finish!: () => void;
    const syncJournals = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const g = createCloseGate<boolean>({ ...deps, syncJournals });
    const first = ev();
    const pending = g.onClose(first);
    expect(first.preventDefault).toHaveBeenCalled();
    expect(deps.close).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(deps.close).toHaveBeenCalledTimes(1);
    const reissued = ev();
    await g.onClose(reissued); // the re-issued close passes straight through
    expect(reissued.preventDefault).not.toHaveBeenCalled();
    expect(syncJournals).toHaveBeenCalledTimes(1);
  });

  it('a window without Office documents closes without waiting', async () => {
    const { deps, ev } = gate({ sessions: 0 });
    const g = createCloseGate<boolean>({ ...deps, syncJournals: () => null });
    const e = ev();
    await g.onClose(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});

describe('a window that stopped responding', () => {
  // The hung path: X → the page cannot run its unload, so the window stays. A second X then asks natively.
  async function stuck(sessions = 0) {
    const t = gate({ sessions });
    if (sessions > 0) t.deps.ask.mockImplementation(() => new Promise<boolean>(() => {})); // the hung page never answers
    void t.g.onClose(t.ev()); // the first X
    t.state.hung = true;
    return t;
  }

  it('asks "close it anyway?" on a second X within 10 s, and destroys the window on yes', async () => {
    const { g, deps, state, ev } = await stuck();
    state.t = HUNG_CLOSE_WINDOW_MS - 1;
    const e = ev();
    await g.onClose(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(deps.confirmCloseHung).toHaveBeenCalledTimes(1);
    expect(deps.destroy).toHaveBeenCalledTimes(1);
  });

  it('also when the first X is waiting on a sessions prompt the hung page cannot show', async () => {
    const { g, deps, state, ev } = await stuck(1);
    state.t = 2_000;
    await g.onClose(ev());
    expect(deps.confirmCloseHung).toHaveBeenCalledTimes(1);
    expect(deps.destroy).toHaveBeenCalledTimes(1);
  });

  it('waits when the person chooses Wait', async () => {
    const { g, deps, state, ev } = await stuck();
    state.closeAnyway = false;
    state.t = 1_000;
    await g.onClose(ev());
    expect(deps.destroy).not.toHaveBeenCalled();
  });

  it('does not ask when the window is responsive, or after 10 s', async () => {
    const late = await stuck();
    late.state.t = HUNG_CLOSE_WINDOW_MS + 1;
    await late.g.onClose(late.ev());
    expect(late.deps.confirmCloseHung).not.toHaveBeenCalled();
    const fine = await stuck();
    fine.state.hung = false;
    fine.state.t = 1_000;
    await fine.g.onClose(fine.ev());
    expect(fine.deps.confirmCloseHung).not.toHaveBeenCalled();
  });
});
