// "Restart the app" (a setting that needs a restart to apply) and the one quit path.
//
// WHY (Task 6 fix round 6, I-B): the restart used to be `app.relaunch(); app.exit(0)`. exit()
// skips before-quit, so the Office quit gate never asked the windows to save, quit's final save
// never ran, and no page's unload guard was consulted — unsaved Office edits were dropped
// without a word. A restart is now an ordinary quit that remembers to start the app again:
// the gate runs, and if a document can't be saved the person gets the usual prompt. Review
// cancels the restart; Close anyway restarts.
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
// done, and the Office 'final' pass already saved what could be saved and released the documents.
// The one exception is a RESPONSIVE window with unsaved non-Office edits (a text file edited, or a
// draft parked, after the gate's check): it is never forced. Such a quit is refused on the spot —
// "Your chats have stopped. Save the file, then quit again." (plus "YouCoded will quit instead of
// restarting." when it was a restart, which it no longer is) — and every repeat without saving
// shows that again, never nothing. Once the file is saved (or discarded) the next quit finishes.
import { app, BrowserWindow } from 'electron';
import { log } from './logger';
import { refuseQuitForOtherUnsaved } from './office/office-flush';

let restartRequested = false;
let relaunchOnQuit = false;
let restartDropped = false; // a restart that became a quit after teardown (for the prompt's wording)
let watchdog: ReturnType<typeof setTimeout> | null = null;

/** How long after teardown a window may still hold the quit open. */
export const QUIT_WATCHDOG_MS = 10_000;

/** A restart was asked for: quit through the normal path (before-quit → the Office gate). */
export function requestRestart(quit: () => void): void {
  restartRequested = true;
  quit();
}

/** Electron's will-quit: the quit is happening — relaunch if it is a restart. */
export function onWillQuit(relaunch: () => void): void {
  if (!relaunchOnQuit) return;
  relaunchOnQuit = false;
  relaunch();
}

interface GatedQuitDeps {
  /** The Office quit gate (it also refuses while a text file is unsaved). `onProceed` is what
   *  its prompt's Close anyway runs. */
  gate(onProceed: () => void): Promise<boolean>;
  /** Tear everything down (shutdownApp). */
  shutdown(): Promise<void>;
  // Electron by default (main.ts passes only the two above); tests pass fakes.
  relaunch?(): void;
  quit?(): void;
  /** How many windows are still open. */
  openWindows?(): number;
  exit?(): void;
  /** Refuse for unsaved non-Office edits in a responsive window (it is shown the list); true if so. */
  refuseForUnsaved?(o: { afterTeardown: boolean; restartDropped: boolean }): boolean;
  setTimer?(fn: () => void, ms: number): ReturnType<typeof setTimeout> | null;
  clearTimer?(t: ReturnType<typeof setTimeout>): void;
}
type Deps = Required<Omit<GatedQuitDeps, 'gate' | 'shutdown'>>;

function electronDefaults(): Deps {
  return {
    relaunch: () => app.relaunch(),
    quit: () => app.quit(),
    openWindows: () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length,
    exit: () => app.exit(0),
    refuseForUnsaved: (o) => refuseQuitForOtherUnsaved(undefined, undefined, o),
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    clearTimer: (t) => clearTimeout(t),
  };
}

/**
 * before-quit's first pass: the Office gate decides; on go, mark a restart (if one was asked
 * for), tear down, and quit again (that quit comes back through quitAfterTeardown). A held quit
 * forgets the restart request here — only Close anyway (onProceed) marks it again.
 */
export async function gatedQuit(deps: GatedQuitDeps): Promise<void> {
  const d = { ...electronDefaults(), ...deps };
  const restart = restartRequested;
  restartRequested = false;
  const go = await d.gate(() => {
    if (restart) relaunchOnQuit = true;
    d.quit();
  });
  if (!go) return;
  if (restart) relaunchOnQuit = true;
  await d.shutdown().finally(() => d.quit());
}

/** A refusal after teardown: the restart (if any) becomes a quit, and the prompt says so. */
function refusedAfterTeardown(d: Deps): boolean {
  const refused = d.refuseForUnsaved({ afterTeardown: true, restartDropped: restartDropped || relaunchOnQuit });
  if (!refused) return false;
  if (relaunchOnQuit) { relaunchOnQuit = false; restartDropped = true; }
  return true;
}

/**
 * before-quit once teardown has run (main.ts's `shuttingDown` pass-through): false = refuse this
 * quit (a responsive window has unsaved non-Office edits and was just told so); true = let it go
 * on, with the watchdog (re-)armed.
 */
export function quitAfterTeardown(deps: Partial<Deps> = {}): boolean {
  const d = { ...electronDefaults(), ...deps };
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
    onWillQuit(d.relaunch); // exit() skips will-quit, so a restart relaunches here
    d.exit();
  }, QUIT_WATCHDOG_MS);
  return true;
}

/** Tests only. */
export function resetRestartForTests(): void {
  restartRequested = false;
  relaunchOnQuit = false;
  restartDropped = false;
  watchdog = null;
}
