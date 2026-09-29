// A restart goes through the ordinary quit: the Office gate saves (or asks) first, and the app
// starts again only once the quit is really happening — Review cancels it, Close anyway
// restarts, and a cancelled quit never relaunches later. After teardown, a window that holds
// the quit open (hung, or vetoing) is let go of after 10 s.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QUIT_WATCHDOG_MS, gatedQuit, onWillQuit, requestRestart, resetRestartForTests } from '../src/main/app-restart';

function deps(go: boolean, open: boolean[] = []) {
  let proceed!: () => void;
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const d = {
    gate: vi.fn(async (onProceed: () => void) => { proceed = onProceed; return go; }),
    relaunch: vi.fn(),
    shutdown: vi.fn(async () => {}),
    quit: vi.fn(),
    openWindows: vi.fn(() => open),
    exit: vi.fn(),
    cannotQuit: vi.fn(),
    setTimer: (fn: () => void, ms: number) => { timers.push({ fn, ms }); },
  };
  return { d, proceed: () => proceed(), fire: () => timers.forEach((t) => t.fn()), timers };
}

beforeEach(() => resetRestartForTests());

describe('restart and quit', () => {
  it('a restart quits through the gate, tears down, and relaunches when the quit really happens', async () => {
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

  it('a restart held by an unsaved document restarts only on Close anyway', async () => {
    requestRestart(() => {});
    const held = deps(false);
    await gatedQuit(held.d);
    expect(held.d.shutdown).not.toHaveBeenCalled();
    const early = vi.fn();
    onWillQuit(early);
    expect(early).not.toHaveBeenCalled();
    held.proceed(); // Close anyway
    expect(held.d.quit).toHaveBeenCalledTimes(1);
    const relaunch = vi.fn();
    onWillQuit(relaunch);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it('after Review cancelled a restart, a later ordinary quit does not restart the app', async () => {
    requestRestart(() => {});
    await gatedQuit(deps(false).d); // Review: nothing else happens
    await gatedQuit(deps(true).d);
    const relaunch = vi.fn();
    onWillQuit(relaunch);
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('an ordinary quit never relaunches', async () => {
    const { d } = deps(true);
    await gatedQuit(d);
    const relaunch = vi.fn();
    onWillQuit(relaunch);
    expect(relaunch).not.toHaveBeenCalled();
  });
});

describe('the quit watchdog', () => {
  it('exits 10 s after teardown when every window still open is hung', async () => {
    const t = deps(true, [true, true]);
    await gatedQuit(t.d);
    expect(t.timers.map((x) => x.ms)).toEqual([QUIT_WATCHDOG_MS]);
    expect(t.d.exit).not.toHaveBeenCalled();
    t.fire();
    expect(t.d.exit).toHaveBeenCalledTimes(1);
    expect(t.d.relaunch).not.toHaveBeenCalled();
  });

  it('relaunches first for a restart (exit skips will-quit)', async () => {
    requestRestart(() => {});
    const t = deps(true, [true]);
    await gatedQuit(t.d);
    t.fire();
    expect(t.d.relaunch).toHaveBeenCalledTimes(1);
    expect(t.d.exit).toHaveBeenCalledTimes(1);
  });

  it('never forces a responsive window that vetoed the quit: says why, drops the restart, stays open', async () => {
    requestRestart(() => {});
    const t = deps(true, [true, false]); // one hung, one with an unsaved text file
    await gatedQuit(t.d);
    t.fire();
    expect(t.d.exit).not.toHaveBeenCalled();
    expect(t.d.cannotQuit).toHaveBeenCalledTimes(1);
    const relaunch = vi.fn();
    onWillQuit(relaunch); // a later, unrelated quit
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('does nothing when every window already closed', async () => {
    const t = deps(true, []);
    await gatedQuit(t.d);
    t.fire();
    expect(t.d.exit).not.toHaveBeenCalled();
  });

  it('is never armed for a quit the gate held', async () => {
    const t = deps(false, [true]);
    await gatedQuit(t.d);
    expect(t.timers).toEqual([]);
  });
});
