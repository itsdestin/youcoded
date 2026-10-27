// internal-quit.ts — "this app.quit() was raised by our own code" (#183 T3, design rev 4 F3).
//
// WHY its own tiny module: update-service.ts must mark its quits, and app-restart.ts (which reads the
// mark) drags in the whole unsaved-files / Office stack; the service and its tests must not.
//
// Quit-install is opt-in: a quit installs a downloaded update only when it reaches the quit gate with this
// flag still false, i.e. nobody in our code asked for it (menu Quit, Cmd+Q, the last window closing).
// Every internal caller marks itself: launch()'s scheduled quit, requestRestart (settings restart),
// Restart to update. The window-all-closed handler and unsaved-quit's "Discard and quit" stay UNmarked on
// purpose: both are a person's own quit continuing.
let internalQuit = false;

export function markInternalQuit(): void { internalQuit = true; }

/** An app.quit() raised by our own code: mark first, then quit. */
export function internalAppQuit(quit: () => void): void {
  internalQuit = true;
  quit();
}

/** Read and clear. The quit gate calls this once per quit. */
export function takeInternalQuit(): boolean {
  const v = internalQuit;
  internalQuit = false;
  return v;
}
