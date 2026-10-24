// A restart goes through the ordinary quit: the quit gate asks first about unsaved files, and the
// app starts again only once the quit is really happening — a held quit cancels the restart, and a
// cancelled quit never relaunches later. Every quit after teardown is refused
// on the spot if a responsive window has unsaved text edits (and says so each time); otherwise
// it arms a 10 s watchdog that lets a still-open (hung) window go.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QUIT_WATCHDOG_MS, currentExitAction, gatedQuit, onWillQuit, quitAfterTeardown, registerInstallExit, requestInstallRestart, requestRestart, resetRestartForTests, shutdownStep, takeUntrackForTeardown } from '../src/main/app-restart';
import { internalAppQuit } from '../src/main/internal-quit';
import fs from 'fs';
import path from 'path';

it('repeated quit stays blocked until teardown is complete', () => {
  const t = deps(true);
  let complete = false;
  expect(quitAfterTeardown({ ...t.d, teardownComplete: () => complete })).toBe(false);
  expect(t.timers).toHaveLength(0);
  complete = true;
  expect(quitAfterTeardown({ ...t.d, teardownComplete: () => complete })).toBe(true);
});

it('cleanup failures do not skip waiting for other cleanup steps', async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  let done = false;
  const stopped = Promise.all([
    shutdownStep('broken', () => { throw new Error('test cleanup'); }),
    shutdownStep('pending', () => pending),
  ]).then(() => { done = true; });
  await Promise.resolve();
  expect(done).toBe(false);
  finish();
  await stopped;
  expect(done).toBe(true);
});

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

// #183 T3: a quit can also install a downloaded update — but only a person's own quit, and only at exit.
describe('quit install and Restart to update', () => {
  const personQuit = (t: ReturnType<typeof deps>, allowed = true) => gatedQuit({ ...t.d, quitInstallAllowed: () => allowed });

  it('a person\'s plain quit installs the update at exit, without reopening', async () => {
    const install = vi.fn(); registerInstallExit(install);
    await personQuit(deps(true));
    expect(currentExitAction()).toBe('install');
    onWillQuit(vi.fn());
    expect(install).toHaveBeenCalledWith(false, expect.any(Function));
  });

  it('does not install when the service says no (switch off, password needed, not the latest, 2 failures …)', async () => {
    const install = vi.fn(); registerInstallExit(install);
    await personQuit(deps(true), false);
    onWillQuit(vi.fn());
    expect(install).not.toHaveBeenCalled();
  });

  it('a quit raised by our own code never installs (internal quit)', async () => {
    const install = vi.fn(); registerInstallExit(install);
    internalAppQuit(() => {});
    await personQuit(deps(true));
    onWillQuit(vi.fn());
    expect(install).not.toHaveBeenCalled();
    // ...and the mark is spent: the next plain quit may install again.
    await personQuit(deps(true));
    expect(currentExitAction()).toBe('install');
  });

  it('a settings restart relaunches and does not install', async () => {
    const install = vi.fn(); registerInstallExit(install);
    requestRestart(() => {});
    await personQuit(deps(true));
    const relaunch = vi.fn();
    onWillQuit(relaunch);
    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(install).not.toHaveBeenCalled();
  });

  it('SIGTERM never installs: it does not pass the quit gate, so there is no exit action', () => {
    const install = vi.fn(); registerInstallExit(install);
    onWillQuit(vi.fn());
    expect(currentExitAction()).toBe('none');
    expect(install).not.toHaveBeenCalled();
  });

  it('main.ts decides quit-install with the system-shutdown flag (Windows session-end, powerMonitor shutdown)', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.ts'), 'utf8');
    expect(main).toMatch(/quitInstallAllowed: \(\) => !systemShutdown && /);
    expect(main).toMatch(/powerMonitor\.on\('shutdown', \(\) => \{ systemShutdown = true; \}\)/);
    expect(main).toMatch(/'session-end', \(\) => \{ systemShutdown = true; \}/);
  });

  it('a quit held for unsaved files spawns nothing', async () => {
    const install = vi.fn(); registerInstallExit(install);
    await personQuit(deps(false));
    expect(currentExitAction()).toBe('none');
    onWillQuit(vi.fn());
    expect(install).not.toHaveBeenCalled();
  });

  it('runs from the watchdog exit too (exit skips will-quit), and only once', async () => {
    const install = vi.fn(); registerInstallExit(install);
    const t = deps(true, 1);
    await personQuit(t);
    quitAfterTeardown(t.d);
    t.fire();
    expect(install).toHaveBeenCalledTimes(1);
    expect(t.d.exit).toHaveBeenCalledTimes(1);
    onWillQuit(vi.fn()); // a late will-quit finds nothing left to do
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('Restart to update installs and reopens, and untracks only after the gate passed', async () => {
    const install = vi.fn(); registerInstallExit(install);
    requestInstallRestart(() => {}, ['s1', 's2']);
    const t = deps(true);
    await gatedQuit(t.d);
    expect(takeUntrackForTeardown()).toEqual(['s1', 's2']);
    onWillQuit(vi.fn());
    expect(install).toHaveBeenCalledWith(true, expect.any(Function));
  });

  it('a held Restart keeps its sessions tracked and forgets the install', async () => {
    const install = vi.fn(); registerInstallExit(install);
    requestInstallRestart(() => {}, ['s1']);
    await gatedQuit(deps(false).d);
    expect(takeUntrackForTeardown()).toEqual([]);
    await gatedQuit(deps(true).d); // the next plain quit untracks nothing either
    expect(takeUntrackForTeardown()).toEqual([]);
    onWillQuit(vi.fn());
    expect(install).not.toHaveBeenCalled();
  });

  it('a restart dropped after teardown (unsaved edits) still installs, but does not reopen', async () => {
    const install = vi.fn(); registerInstallExit(install);
    requestInstallRestart(() => {}, []);
    const t = deps(true, 1);
    await gatedQuit(t.d);
    t.d.refuseForUnsaved.mockReturnValue(true);
    expect(quitAfterTeardown(t.d)).toBe(false); // told to save first
    expect(currentExitAction()).toBe('install');
    t.d.refuseForUnsaved.mockReturnValue(false);
    onWillQuit(vi.fn());
    expect(install).toHaveBeenCalledWith(false, expect.any(Function));
  });

  it('a Restart whose installer already ran (Linux package) quits with no install step', async () => {
    const install = vi.fn(); registerInstallExit(install);
    requestInstallRestart(() => {}, ['s1'], false);
    await gatedQuit(deps(true).d);
    expect(takeUntrackForTeardown()).toEqual(['s1']);
    onWillQuit(vi.fn());
    expect(install).not.toHaveBeenCalled();
  });

  it('a second quit while a restart is already under way does not downgrade it to a plain install', async () => {
    const install = vi.fn(); registerInstallExit(install);
    requestInstallRestart(() => {}, []);
    await gatedQuit(deps(true).d);                 // Restart passed the gate: install-relaunch
    await personQuit(deps(true));                   // the person quits again during teardown
    expect(currentExitAction()).toBe('install-relaunch');
    onWillQuit(vi.fn());
    expect(install).toHaveBeenCalledWith(true, expect.any(Function));
  });
});
