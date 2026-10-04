// A restart goes through the ordinary quit: the quit gate asks first about unsaved files, and the
// app starts again only once the quit is really happening — a held quit cancels the restart, and a
// cancelled quit never relaunches later. Every quit after teardown is refused
// on the spot if a responsive window has unsaved text edits (and says so each time); otherwise
// it arms a 10 s watchdog that lets a still-open (hung) window go.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QUIT_WATCHDOG_MS, gatedQuit, onWillQuit, quitAfterTeardown, requestRestart, resetRestartForTests } from '../src/main/app-restart';

function deps(go: boolean, open = 0) {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const d = {
    gate: vi.fn(() => go),
    relaunch: vi.fn(),
    shutdown: vi.fn(async () => {}),
    quit: vi.fn(),
    openWindows: vi.fn(() => open),
    exit: vi.fn(),
    refuseForUnsaved: vi.fn((_o: { afterTeardown: boolean; restartDropped: boolean }) => false),
    setTimer: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return null; },
    clearTimer: vi.fn(),
  };
  return { d, fire: () => timers.splice(0).forEach((t) => t.fn()), timers };
}

beforeEach(() => resetRestartForTests());

describe('restart and quit', () => {
  it('a restart quits through the gate, tears down, quits again, and relaunches when the quit happens', async () => {
    const quit = vi.fn();
    requestRestart(quit);
    expect(quit).toHaveBeenCalledTimes(1); // app.quit(), never app.exit()
    const { d } = deps(true);
    await gatedQuit(d);
    expect(d.shutdown).toHaveBeenCalled();
    expect(d.quit).toHaveBeenCalled();
    expect(d.relaunch).not.toHaveBeenCalled(); // not yet: only on will-quit
    const relaunch = vi.fn();
    onWillQuit(relaunch);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it('a restart held for unsaved files tears nothing down and never relaunches', async () => {
    requestRestart(() => {});
    const held = deps(false);
    await gatedQuit(held.d);
    expect(held.d.shutdown).not.toHaveBeenCalled();
    const early = vi.fn();
    onWillQuit(early);
    expect(early).not.toHaveBeenCalled();
  });

  it('after a held restart, a later ordinary quit does not restart the app', async () => {
    requestRestart(() => {});
    await gatedQuit(deps(false).d);
    await gatedQuit(deps(true).d);
    const relaunch = vi.fn();
    onWillQuit(relaunch);
    expect(relaunch).not.toHaveBeenCalled();
  });
});

describe('a quit after teardown', () => {
  it('goes on and arms a 10 s watchdog that exits if a window is still open', () => {
    const t = deps(true, 2);
    expect(quitAfterTeardown(t.d)).toBe(true);
    expect(t.timers.map((x) => x.ms)).toEqual([QUIT_WATCHDOG_MS]);
    t.fire();
    expect(t.d.exit).toHaveBeenCalledTimes(1);
  });

  it('relaunches first for a restart (exit skips will-quit)', async () => {
    requestRestart(() => {});
    const t = deps(true, 1);
    await gatedQuit(t.d);
    quitAfterTeardown(t.d);
    t.fire();
    expect(t.d.relaunch).toHaveBeenCalledTimes(1);
    expect(t.d.exit).toHaveBeenCalledTimes(1);
  });

  it('is refused while a responsive window has unsaved text edits — every time, saying a restart became a quit', async () => {
    requestRestart(() => {});
    const t = deps(true, 1);
    await gatedQuit(t.d);
    t.d.refuseForUnsaved.mockReturnValue(true);
    expect(quitAfterTeardown(t.d)).toBe(false);
    expect(t.d.refuseForUnsaved).toHaveBeenLastCalledWith({ afterTeardown: true, restartDropped: true });
    expect(t.timers).toEqual([]);
    expect(quitAfterTeardown(t.d)).toBe(false); // the person quits again without saving: told again
    expect(t.d.refuseForUnsaved).toHaveBeenCalledTimes(2);
    expect(t.d.refuseForUnsaved).toHaveBeenLastCalledWith({ afterTeardown: true, restartDropped: true });
    const relaunch = vi.fn();
    onWillQuit(relaunch);
    expect(relaunch).not.toHaveBeenCalled(); // it quits instead of restarting
    t.d.refuseForUnsaved.mockReturnValue(false); // saved: the next quit goes on, watchdog armed
    expect(quitAfterTeardown(t.d)).toBe(true);
    expect(t.timers).toHaveLength(1);
  });

  it('a file edited while the quit was finishing holds it at the watchdog: told, not exited', () => {
    const t = deps(true, 1);
    quitAfterTeardown(t.d);
    t.d.refuseForUnsaved.mockReturnValue(true);
    t.fire();
    expect(t.d.exit).not.toHaveBeenCalled();
  });

  it('does nothing when every window already closed', () => {
    const t = deps(true, 0);
    quitAfterTeardown(t.d);
    t.fire();
    expect(t.d.exit).not.toHaveBeenCalled();
  });
});
