// What happens when a window's X is pressed (its `close` event), in order: the last window's
// unsaved files are listed instead of closing (unsaved-quit.ts), then a window that still owns chat
// sessions asks the person (the in-app "close these sessions?" prompt), then the window goes.
//
// WHY its own module (Task 6 fix round 6, I-A): the handler lived inline in main.ts, which no
// test can import. A vetoed unload (Electron's `will-prevent-unload`, observed without
// preventDefault — an unsaved text file's guard) clears a remembered sessions answer, so the next
// X asks again instead of skipping the prompt.
//
// WHY the sessions answer waits (fix rounds 7–8): it is only remembered — with the sessions owned
// at that moment, so one started later is never ended — and carried out on the close that actually
// goes through (the one this gate re-issues). Any refusal in between drops it.
//
// WHY no Office step (finish plan Task 8): Office documents used to be saved here first, holding
// the close for up to 5 s and asking again when a save failed. Their edits now reach a recovery
// journal as they are made (office/office-recovery.ts), so a window can close at once.
//
// WHY a hung-window question (fix round 7): a renderer that stopped responding never runs its
// unload, so the window cannot close and every X only starts another wait. A second X within
// 10 s of the previous one, while the window is unresponsive, asks natively (the page cannot draw
// anything): close it anyway, or wait. Closing anyway destroys the window without its unload — the
// only way out of a hang. Accepted: that window's chat sessions keep running (nothing ends them),
// exactly as after a renderer crash; they stay reachable from another window or on the next launch.
// (Task 8: "the previous X" replaces "a close main re-issued" — the Office save's re-issued close
// was what armed the question for most windows, and it is gone.)

export interface CloseEvent { preventDefault(): void }

/** How long after an X a second X counts as "still waiting on it". */
export const HUNG_CLOSE_WINDOW_MS = 10_000;

export interface CloseGateDeps<Answer> {
  /** Buddy windows never own sessions: they close freely. */
  buddy: boolean;
  /** Whole-app quit already saved and settled everything; the window just goes. */
  shuttingDown(): boolean;
  /** The LAST window has unsaved edits (a text editor, a parked draft, an Office document): it was
   *  just shown their list instead of closing (fix round 11). */
  refuseForUnsaved?(): boolean;
  /** Office (Task 8 fix round 1): this window's editors send their newest edits to the recovery
   *  journal before it closes. null when it has no Office documents; capped by the caller. */
  syncJournals?(): Promise<void> | null;
  /** The chat sessions this window owns right now. */
  sessionIds(): string[];
  /** Ask the person (resolves with their answer; concurrent asks share one prompt). */
  ask(count: number): Promise<Answer>;
  /** Carry out the answer for these sessions; true when the window should close. */
  apply(answer: Answer, sessionIds: string[]): boolean;
  /** Whether the answer lets the window close (Cancel does not). Default: `answer.close`. */
  closes?(answer: Answer): boolean;
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

type Remembered<Answer> = { answer: Answer; sessionIds: string[] };

export function createCloseGate<Answer>(d: CloseGateDeps<Answer>) {
  const now = d.now ?? Date.now;
  const closes = d.closes ?? ((a: Answer) => (a as { close?: boolean }).close === true);
  let confirmed: Remembered<Answer> | null = null; // answered, waiting for the close that goes through
  let lastCloseAt: number | null = null;
  let askingHung = false;
  let asking = false; // the sessions prompt is up: a second press waits on it, never asks again
  let journalsSynced = false; // the close this gate re-issued after its editors journaled
  return {
    async onClose(ev: CloseEvent): Promise<void> {
      if (d.buddy) return;
      if (d.shuttingDown()) return;
      // A hung window: the previous X is stuck behind a page that cannot answer.
      const t = now();
      if (lastCloseAt !== null && t - lastCloseAt <= HUNG_CLOSE_WINDOW_MS && d.unresponsive()) {
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
      lastCloseAt = t;
      // Unsaved edits in the last window: say so before anything else (fix round 11).
      // WHY only the last window: closing it ends the app, and a parked draft (no editor on
      // screen, so no unload veto) would go with it unasked. Another window's text editor still
      // vetoes that window's unload; its Office documents are in their recovery journals.
      if (d.refuseForUnsaved?.()) {
        ev.preventDefault();
        // Even on the close re-issued after the sessions prompt: that answer must not be carried
        // out later by some other close (fix round 12).
        confirmed = null;
        return;
      }
      // Office editors journal their last second of edits before the window goes (fix round 1).
      // WHY on every close that would go through, not once: a cancelled close lets typing go on.
      if (!journalsSynced) {
        const sync = d.syncJournals?.();
        if (sync) {
          ev.preventDefault();
          await sync;
          journalsSynced = true;
          if (!d.isDestroyed()) d.close();
          return;
        }
      }
      journalsSynced = false;
      const r = confirmed;
      confirmed = null;
      if (r) {
        // Sessions owned at confirm time AND still here (one dragged away meanwhile is not ended).
        const owned = d.sessionIds();
        if (!d.apply(r.answer, r.sessionIds.filter((id) => owned.includes(id)))) ev.preventDefault();
        return;
      }
      const ids = d.sessionIds();
      if (ids.length === 0) return; // no sessions — close freely
      ev.preventDefault();
      // WHY a flag (fix round 9): a second press while the prompt is up must neither ask again
      // nor re-issue a second close; the first press carries the answer out.
      if (asking) return;
      asking = true;
      let answer: Answer;
      try { answer = await d.ask(ids.length); } finally { asking = false; }
      if (!closes(answer)) return; // Cancel — the window stays, and the next press asks again
      confirmed = { answer, sessionIds: d.sessionIds() };
      if (!d.isDestroyed()) d.close();
    },
    /** The page vetoed its unload (Electron `will-prevent-unload`): the close did not happen. */
    onUnloadPrevented(): void {
      confirmed = null;
    },
  };
}
