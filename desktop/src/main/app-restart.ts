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
// WHY a watchdog (fix round 7): once teardown has run, a window whose renderer hangs — or one
// that vetoes its unload — would keep the app alive forever, with every session already
// stopped: a quit (or restart) that never finishes. So 10 s after teardown, any window still
// open is let go of: app.exit (relaunching first for a restart, since exit skips will-quit).
// That is safe at that point: teardown is done, and the Office 'final' pass already saved what
// could be saved and released the documents; waiting longer could only hang.

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
  /** The Office quit gate. `onProceed` is what its prompt's Close anyway runs. */
  gate(onProceed: () => void): Promise<boolean>;
  relaunch(): void;
  /** Tear everything down (shutdownApp). */
  shutdown(): Promise<void>;
  quit(): void;
  /** Whether any window is still open (the watchdog's question). */
  windowsLeft(): boolean;
  exit(): void;
  setTimer?(fn: () => void, ms: number): void;
}

/**
 * before-quit's first pass: the Office gate decides; on go, mark a restart (if one was asked
 * for), tear down, quit, and arm the watchdog. A held quit forgets the restart request here —
 * only Close anyway (onProceed) marks it again.
 */
export async function gatedQuit(d: GatedQuitDeps): Promise<void> {
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
    (d.setTimer ?? ((fn, ms) => { setTimeout(fn, ms).unref?.(); }))(() => {
      if (!d.windowsLeft()) return;
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
