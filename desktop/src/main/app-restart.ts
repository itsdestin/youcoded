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
// WHY a watchdog (fix rounds 7–9): once teardown has run, a window whose renderer hangs would
// keep the app alive forever, with every session already stopped: a quit (or restart) that never
// finishes. So 10 s after teardown, any window still open is let go of: app.exit (relaunching
// first for a restart, since exit skips will-quit). That is safe then: teardown is done, the
// Office 'final' pass already saved what could be saved and released the documents, and a page
// with a legitimate reason to veto — a text file with unsaved edits — was already asked about
// BEFORE teardown (the quit gate refuses while any window reports one, fix round 9). So a window
// still open here is hung, or vetoed for a reason nothing could act on any more; it is logged.
import { app, BrowserWindow } from 'electron';
import { log } from './logger';

let restartRequested = false;
let relaunchOnQuit = false;

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
  setTimer?(fn: () => void, ms: number): void;
}

function electronDefaults() {
  return {
    relaunch: () => app.relaunch(),
    quit: () => app.quit(),
    openWindows: () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length,
    exit: () => app.exit(0),
    setTimer: (fn: () => void, ms: number) => { setTimeout(fn, ms).unref?.(); },
  };
}

/**
 * before-quit's first pass: the Office gate decides; on go, mark a restart (if one was asked
 * for), tear down, quit, and arm the watchdog. A held quit forgets the restart request here —
 * only Close anyway (onProceed) marks it again.
 */
export async function gatedQuit(deps: GatedQuitDeps): Promise<void> {
  const d = { ...electronDefaults(), ...deps } as Required<GatedQuitDeps>;
  const restart = restartRequested;
  restartRequested = false;
  const go = await d.gate(() => {
    if (restart) relaunchOnQuit = true;
    d.quit();
  });
  if (!go) return;
  if (restart) relaunchOnQuit = true;
  await d.shutdown().finally(() => {
    d.quit();
    d.setTimer(() => {
      const open = d.openWindows();
      if (open === 0) return;
      log('WARN', 'quit', 'windows still open 10 s after teardown; exiting', { windows: open });
      onWillQuit(d.relaunch); // exit() skips will-quit, so a restart relaunches here
      d.exit();
    }, QUIT_WATCHDOG_MS);
  });
}

/** Tests only. */
export function resetRestartForTests(): void {
  restartRequested = false;
  relaunchOnQuit = false;
}
