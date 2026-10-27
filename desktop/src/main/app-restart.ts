// "Restart the app" (a setting that needs a restart to apply) and the one quit path.
//
// WHY (Task 6 fix round 6, I-B): the restart used to be `app.relaunch(); app.exit(0)`. exit()
// skips before-quit, so the quit gate never ran and no page's unload guard was consulted —
// unsaved edits were dropped without a word. A restart is now an ordinary quit that remembers to
// start the app again: the gate runs, and with unsaved files the person gets the usual list
// (unsaved-quit.ts) — a restart it holds is forgotten (Discard and quit then quits).
//
// WHY the relaunch waits for will-quit (fix round 7): Electron's relaunch() schedules a start
// for whenever this instance exits — even much later. Called any earlier, a quit that was then
// cancelled (a window vetoed it) left a restart armed for the next, unrelated quit. So a go
// only marks the restart; `onWillQuit` (Electron's will-quit, which fires only when the quit is
// really happening) relaunches.
//
// WHY a watchdog (fix rounds 7–11): once teardown has run, a window whose renderer hangs would
// keep the app alive forever, with every session already stopped: a quit (or restart) that never
// finishes. So every quit that goes on after teardown — the one gatedQuit itself re-issues, and
// any the person repeats — arms a 10 s watchdog: if a window is still open then, the app exits
// (relaunching first for a restart, since exit skips will-quit). That is safe then: teardown is
// done, and an Office document's edits are in its recovery journal (Task 8).
// The one exception is a RESPONSIVE window with unsaved edits (a file edited, or a draft parked,
// after the gate's check): it is never forced. Such a quit is refused on the spot —
// "Your chats have stopped. Save the file, then quit again." (plus "YouCoded will quit instead of
// restarting." when it was a restart, which it no longer is) — and every repeat without saving
// shows that again, never nothing. Once the file is saved (or discarded) the next quit finishes.
import { app, BrowserWindow } from 'electron';
import { log } from './logger';
import { internalAppQuit, takeInternalQuit } from './internal-quit';
import { refuseQuitForUnsaved } from './unsaved-quit';

// #183 T3: what the process does as it really exits. 'relaunch' is today's restart; 'install' is a
// person's quit that also installs a downloaded update; 'install-relaunch' is Restart to update.
export type ExitAction = 'none' | 'relaunch' | 'install' | 'install-relaunch';
let restartRequested = false;
let exitAction: ExitAction = 'none';
// Restart to update asked (consumed by the next gatedQuit), with the sessions to untrack once the
// unsaved-files gate has passed (review F6: a held restart must leave them tracked).
let installRestartRequested = false;
let installRestartInstalls = true; // false = the update was already installed (Linux package, interactive installer)
let untrackAfterGate: string[] | null = null;
let untrackForTeardown: string[] = [];
let restartDropped = false; // a restart that became a quit after teardown (for the prompt's wording)
let watchdog: ReturnType<typeof setTimeout> | null = null;

/** How long after teardown a window may still hold the quit open. */
export const QUIT_WATCHDOG_MS = 10_000;

/** A restart was asked for: quit through the normal path (before-quit → the quit gate). */
export function requestRestart(quit: () => void): void {
  restartRequested = true;
  internalAppQuit(quit);
}

/** Restart to update: quit through the normal path and install + reopen at exit (#183 T3). `untrack` is
 *  applied only when the unsaved-files gate lets the quit go on, so a held quit keeps sessions tracked. */
export function requestInstallRestart(quit: () => void, untrack: string[], installsAtExit = true): void {
  installRestartRequested = true;
  installRestartInstalls = installsAtExit;
  untrackAfterGate = untrack;
  internalAppQuit(quit);
}

/** Sessions to untrack at the start of teardown (set only after the gate passed); read once. */
export function takeUntrackForTeardown(): string[] {
  const ids = untrackForTeardown;
  untrackForTeardown = [];
  return ids;
}

/** What this quit will do on exit; the prepare step reads it. */
export function currentExitAction(): ExitAction { return exitAction; }

// The install step itself lives in update-service.ts; main.ts registers it here so the two exit
// routes (will-quit and the watchdog) share one hook without this file importing the service.
type InstallExit = (relaunch: boolean, appRelaunch: () => void) => void;
let installExit: InstallExit | null = null;
export function registerInstallExit(fn: InstallExit | null): void { installExit = fn; }

/**
 * Electron's will-quit — and the watchdog's exit, which skips will-quit: the quit is happening. Runs the
 * exit action: relaunch, or the instant install step (update-exit.ts), optionally with a relaunch.
 */
export function onWillQuit(relaunch: () => void): void {
  const action = exitAction;
  exitAction = 'none';
  if (action === 'relaunch') { relaunch(); return; }
  if (action === 'install' || action === 'install-relaunch') {
    try { installExit?.(action === 'install-relaunch', relaunch); } catch (e) { log('WARN', 'quit', 'update install step failed', { error: String(e) }); }
  }
}

interface GatedQuitDeps {
  /** The quit gate: false while a window has unsaved files (it is shown their list). */
  gate(): boolean | Promise<boolean>;
  /** Tear everything down (shutdownApp). */
  shutdown(): Promise<void>;
  // Electron by default (main.ts passes only the two above); tests pass fakes.
  relaunch?(): void;
  quit?(): void;
  /** How many windows are still open. */
  openWindows?(): number;
  exit?(): void;
  /** Refuse for unsaved edits in a responsive window (it is shown the list); true if so. */
  refuseForUnsaved?(o: { afterTeardown: boolean; restartDropped: boolean }): boolean;
  setTimer?(fn: () => void, ms: number): ReturnType<typeof setTimeout> | null;
  clearTimer?(t: ReturnType<typeof setTimeout>): void;
  /** A second quit must not mistake an in-progress teardown for a completed one. */
  teardownComplete?(): boolean;
  /** True when a person's plain quit may also install a downloaded update (switch on, ready, no system shutdown …). */
  quitInstallAllowed?(): boolean;
}
type Deps = Required<Omit<GatedQuitDeps, 'gate' | 'shutdown'>>;

function electronDefaults(): Deps {
  return {
    relaunch: () => app.relaunch(),
    quit: () => app.quit(),
    openWindows: () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length,
    exit: () => app.exit(0),
    refuseForUnsaved: (o) => refuseQuitForUnsaved(undefined, undefined, o),
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    clearTimer: (t) => clearTimeout(t),
    teardownComplete: () => true,
    quitInstallAllowed: () => false,
  };
}

/**
 * before-quit's first pass: the quit gate decides; on go, mark a restart (if one was asked for),
 * tear down, and quit again (that quit comes back through quitAfterTeardown). A held quit
 * forgets the restart request.
 */
export async function gatedQuit(deps: GatedQuitDeps): Promise<void> {
  const d = { ...electronDefaults(), ...deps };
  const restart = restartRequested;
  const installRestart = installRestartRequested;
  const untrack = untrackAfterGate;
  const installsAtExit = installRestartInstalls;
  const internal = takeInternalQuit();
  restartRequested = false; installRestartRequested = false; untrackAfterGate = null;
  if (!(await d.gate())) return; // held: every request above is forgotten, sessions stay tracked
  if (installRestart) { exitAction = installsAtExit ? 'install-relaunch' : 'none'; untrackForTeardown = untrack ?? []; }
  else if (restart) exitAction = 'relaunch';
  // Decided AFTER the gate: the person may have spent a while on the unsaved list. SIGTERM/SIGINT never
  // come through here at all, so they can never install.
  // WHY only from 'none' (review): a second quit while an earlier one already set 'relaunch' or
  // 'install-relaunch' must not downgrade it into a plain install.
  else if (!internal && exitAction === 'none' && d.quitInstallAllowed()) exitAction = 'install';
  await d.shutdown().finally(() => d.quit());
}

/** A refusal after teardown: the restart (if any) becomes a quit, and the prompt says so. */
function refusedAfterTeardown(d: Deps): boolean {
  const relaunching = exitAction === 'relaunch' || exitAction === 'install-relaunch';
  const refused = d.refuseForUnsaved({ afterTeardown: true, restartDropped: restartDropped || relaunching });
  if (!refused) return false;
  // WHY (review F7): the update still installs, the app just does not reopen.
  if (exitAction === 'relaunch') { exitAction = 'none'; restartDropped = true; }
  else if (exitAction === 'install-relaunch') { exitAction = 'install'; restartDropped = true; }
  return true;
}

/**
 * before-quit once teardown has run (main.ts's `shuttingDown` pass-through): false = refuse this
 * quit (a responsive window has unsaved edits and was just told so); true = let it go
 * on, with the watchdog (re-)armed.
 */
export function quitAfterTeardown(deps: Partial<Deps> = {}): boolean {
  const d = { ...electronDefaults(), ...deps };
  if (!d.teardownComplete()) return false;
  if (refusedAfterTeardown(d)) return false;
  if (watchdog) d.clearTimer(watchdog);
  watchdog = d.setTimer(() => {
    watchdog = null;
    const open = d.openWindows();
    if (open === 0) return;
    // Edited after this quit began (typing during teardown): never forced — told, not exited.
    if (refusedAfterTeardown(d)) {
      log('WARN', 'quit', 'quit held after teardown by a window with unsaved edits', { windows: open });
      return;
    }
    log('WARN', 'quit', 'windows still open 10 s after teardown; exiting', { windows: open });
    onWillQuit(d.relaunch); // exit() skips will-quit, so a restart relaunches (and an install runs) here
    d.exit();
  }, QUIT_WATCHDOG_MS);
  return true;
}

/** WHY: one failing cleanup must not skip the other services or their pending saves. */
export async function shutdownStep(name: string, stop: () => unknown): Promise<void> {
  try { await stop(); }
  catch (error) { log('WARN', 'quit', 'cleanup failed', { step: name, error: String(error) }); }
}

/** Tests only. */
export function resetRestartForTests(): void {
  restartRequested = false;
  exitAction = 'none';
  installRestartRequested = false;
  installRestartInstalls = true;
  untrackAfterGate = null;
  untrackForTeardown = [];
  takeInternalQuit();
  installExit = null;
  restartDropped = false;
  watchdog = null;
}
