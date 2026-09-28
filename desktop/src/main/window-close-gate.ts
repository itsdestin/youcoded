// What happens when a window's X is pressed (its `close` event), in order: Office documents
// save first (office-flush.ts), then a window that still owns chat sessions asks the person
// (the in-app "close these sessions?" prompt), then the window goes.
//
// WHY its own module (Task 6 fix round 6, I-A): the handler lived inline in main.ts, which no
// test can import, and it had a latent trap. `confirmedClose` (the person already answered the
// sessions prompt) was checked BEFORE the Office hold and never reset. When the close was then
// vetoed after all — the Office unload guard keeps the window open because a document changed
// while the prompt was up — every later X skipped the Office save and its prompt, and with a
// failed save the X became a silent no-op for good. Now the Office hold always runs first, and
// a vetoed unload (Electron's `will-prevent-unload`, observed without preventDefault) clears
// the confirmation so the next X asks again.

export interface CloseEvent { preventDefault(): void }

export interface CloseGateDeps<Answer> {
  /** Buddy windows never own sessions: they close freely. */
  buddy: boolean;
  /** Whole-app quit already saved and settled everything; the window just goes. */
  shuttingDown(): boolean;
  /** Office: holds the close (preventDefault) to save first; false when nothing to save or on
   *  the close it re-issued itself (holdCloseForOfficeSave). */
  holdForOffice(ev: CloseEvent): boolean;
  /** How many chat sessions this window owns right now. */
  sessionCount(): number;
  /** Ask the person (resolves with their answer; concurrent asks share one prompt). */
  ask(count: number): Promise<Answer>;
  /** Carry out the answer; true when the window should close. */
  apply(answer: Answer): boolean;
  isDestroyed(): boolean;
  close(): void;
}

export function createCloseGate<Answer>(d: CloseGateDeps<Answer>) {
  let confirmed = false;
  return {
    async onClose(ev: CloseEvent): Promise<void> {
      if (d.buddy) return;
      // Office first, every time — even after the sessions prompt was answered (see above).
      if (d.shuttingDown() || d.holdForOffice(ev)) return;
      if (confirmed) return;
      const count = d.sessionCount();
      if (count === 0) return; // no sessions — close freely
      ev.preventDefault();
      const answer = await d.ask(count);
      // A second press while this was pending resolved the SAME prompt; the first one through
      // already closed the window.
      if (confirmed) return;
      if (!d.apply(answer)) return; // Cancel — the window stays, and the next press asks again
      confirmed = true;
      if (!d.isDestroyed()) d.close();
    },
    /** The page vetoed its unload (Electron `will-prevent-unload`): the close did not happen. */
    onUnloadPrevented(): void {
      confirmed = false;
    },
  };
}
