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
//
// WHY the sessions answer waits (fix round 7): it used to be carried out (sessions ended) the
// moment the person confirmed, before the last Office save. If that save then failed and the
// person chose Review, the window stayed with its sessions already gone. Now the answer is only
// remembered; it is carried out on the close that actually goes through — after the final Office
// pass succeeded, or after Close anyway. An Office pass that fails, followed by a fresh X (the
// person chose Review and came back), forgets the answer: the sessions are untouched and are
// asked about again after the next successful save — once, never in a loop.
//
// WHY a hung-window question (fix round 7): a renderer that stopped responding never answers the
// Office save (main closes after 5 s) nor its own beforeunload, so the window cannot close and
// every X only starts another wait. A second X within 10 s of a close main re-issued, while the
// window is unresponsive, asks natively (the page cannot draw anything): close it anyway, or
// wait. Closing it anyway destroys the window without its unload — the only way out of a hang.

export interface CloseEvent { preventDefault(): void }

/** How long after a re-issued close a second X counts as "still waiting on it". */
export const HUNG_CLOSE_WINDOW_MS = 10_000;

export interface CloseGateDeps<Answer> {
  /** Buddy windows never own sessions: they close freely. */
  buddy: boolean;
  /** Whole-app quit already saved and settled everything; the window just goes. */
  shuttingDown(): boolean;
  /** Office: holds the close (preventDefault) to save first; false when nothing to save or on
   *  the close it re-issued itself (holdCloseForOfficeSave). `onFailed` runs when that save
   *  failed and the person is being asked (Review / Close anyway). */
  holdForOffice(ev: CloseEvent, onFailed: () => void): boolean;
  /** How many chat sessions this window owns right now. */
  sessionCount(): number;
  /** Ask the person (resolves with their answer; concurrent asks share one prompt). */
  ask(count: number): Promise<Answer>;
  /** Carry out the answer; true when the window should close. */
  apply(answer: Answer): boolean;
  /** Whether the answer lets the window close (Cancel does not). Nothing is carried out yet. */
  closes(answer: Answer): boolean;
  isDestroyed(): boolean;
  close(): void;
  /** The window stopped responding (Electron 'unresponsive', not yet 'responsive'). */
  unresponsive(): boolean;
  /** The native "not responding — close anyway?" question; true = Close anyway. */
  confirmCloseHung(): Promise<boolean>;
  /** Close without the page's unload (win.destroy()). */
  destroy(): void;
  now?(): number;
}

export function createCloseGate<Answer>(d: CloseGateDeps<Answer>) {
  const now = d.now ?? Date.now;
  let confirmed = false;
  let pending: { answer: Answer } | null = null;
  let officeFailed = false;
  let lastHeld = false;
  let reissuedAt: number | null = null;
  let askingHung = false;
  const forget = () => { confirmed = false; pending = null; officeFailed = false; };
  return {
    async onClose(ev: CloseEvent): Promise<void> {
      if (d.buddy) return;
      if (d.shuttingDown()) return;
      // A hung window: the close main re-issued is stuck behind a page that cannot answer.
      if (reissuedAt !== null && now() - reissuedAt <= HUNG_CLOSE_WINDOW_MS && d.unresponsive()) {
        ev.preventDefault();
        if (askingHung) return;
        askingHung = true;
        try {
          if (await d.confirmCloseHung()) { if (!d.isDestroyed()) d.destroy(); }
        } finally {
          askingHung = false;
        }
        return;
      }
      // Office first, every time — even after the sessions prompt was answered (see above).
      // Read before this pass starts: its own failure is reported later (onFailed).
      const afterFailure = officeFailed;
      officeFailed = false;
      const held = d.holdForOffice(ev, () => { officeFailed = true; });
      if (held) {
        // A fresh X after an Office pass that failed (Review): the remembered answer is stale.
        if (afterFailure) { confirmed = false; pending = null; }
        lastHeld = true;
        return;
      }
      // Not held right after a failure: this is Close anyway's re-issued close — go ahead.
      // A close right after a hold is the one Office re-issued (saved, or Close anyway).
      if (lastHeld) { reissuedAt = now(); lastHeld = false; }
      if (confirmed) {
        // The final Office pass is done: now the sessions answer is carried out.
        const p = pending;
        forget();
        if (p && !d.apply(p.answer)) ev.preventDefault();
        return;
      }
      const count = d.sessionCount();
      if (count === 0) return; // no sessions — close freely
      ev.preventDefault();
      const answer = await d.ask(count);
      // A second press while this was pending resolved the SAME prompt; the first one through
      // already re-issued the close.
      if (confirmed) return;
      if (!d.closes(answer)) return; // Cancel — the window stays, and the next press asks again
      confirmed = true;
      pending = { answer };
      reissuedAt = now();
      if (!d.isDestroyed()) d.close();
    },
    /** The page vetoed its unload (Electron `will-prevent-unload`): the close did not happen. */
    onUnloadPrevented(): void {
      forget();
    },
  };
}
