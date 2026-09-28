// "Restart the app" (a setting that needs a restart to apply) and the one quit path.
//
// WHY (Task 6 fix round 6, I-B): the restart used to be `app.relaunch(); app.exit(0)`. exit()
// skips before-quit, so the Office quit gate never asked the windows to save, quit's final save
// never ran, and no page's unload guard was consulted — unsaved Office edits were dropped
// without a word. A restart is now an ordinary quit that remembers to start the app again:
// the gate runs, and if a document can't be saved the person gets the usual prompt. Review
// cancels the restart; Close anyway restarts. Electron's relaunch() only schedules a start for
// when this instance exits, so it is called only once the quit is certain — never while the
// prompt is up, or a later unrelated quit would restart the app out of nowhere.

let restartRequested = false;

/** A restart was asked for: quit through the normal path (before-quit → the Office gate). */
export function requestRestart(quit: () => void): void {
  restartRequested = true;
  quit();
}

interface GatedQuitDeps {
  /** The Office quit gate. `onProceed` is what its prompt's Close anyway runs. */
  gate(onProceed: () => void): Promise<boolean>;
  relaunch(): void;
  /** Tear everything down (shutdownApp). */
  shutdown(): Promise<void>;
  quit(): void;
}

/**
 * before-quit's first pass: the Office gate decides; on go, relaunch (if a restart was asked
 * for) and tear down. A held quit forgets the restart request here — only Close anyway
 * (onProceed) brings it back, by relaunching itself.
 */
export async function gatedQuit(d: GatedQuitDeps): Promise<void> {
  const restart = restartRequested;
  restartRequested = false;
  const go = await d.gate(() => {
    if (restart) d.relaunch();
    d.quit();
  });
  if (!go) return;
  if (restart) d.relaunch();
  await d.shutdown().finally(() => d.quit());
}
