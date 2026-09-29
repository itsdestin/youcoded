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
// WHY the sessions answer waits (fix rounds 7–8): it used to be carried out (sessions ended) the
// moment the person confirmed, before the last Office save. If that save then failed and the
// person chose Review, the window stayed with its sessions already gone. Now the answer is only
// remembered — with the sessions owned at that moment, so one started later is never ended — and
// carried out on the close that actually goes through: after the final Office pass succeeded, or
// on Close anyway, which says so explicitly (onProceed). An Office failure clears the remembered
// answer at once (keeping it only for that Close anyway); any other close that goes through
// without a proceed asks about the sessions again — once, never in a loop.
//
// WHY a hung-window question (fix round 7): a renderer that stopped responding never answers the
// Office save (main closes after 5 s) nor its own beforeunload, so the window cannot close and
// every X only starts another wait. A close within 10 s of one main re-issued, while the window
// is unresponsive, asks natively (the page cannot draw anything): close it anyway, or wait. That
// close can be the person's second X or main's own next re-issue (after the Office hold that X
// started) — either way the hang has outlasted a close. Closing anyway destroys the window
// without its unload — the only way out of a hang. Accepted: that window's chat sessions keep
// running (nothing ends them), exactly as after a renderer crash; they stay reachable from
// another window or on the next launch.

export interface CloseEvent { preventDefault(): void }

/** How long after a re-issued close a second X counts as "still waiting on it". */
export const HUNG_CLOSE_WINDOW_MS = 10_000;

interface OfficeHoldCallbacks {
  /** The Office save failed and the person is being asked (Review / Close anyway). */
  onFailed(): void;
  /** They chose Close anyway: the close main re-issues next goes ahead. */
  onProceed(): void;
}

export interface CloseGateDeps<Answer> {
  /** Buddy windows never own sessions: they close freely. */
  buddy: boolean;
  /** Whole-app quit already saved and settled everything; the window just goes. */
  shuttingDown(): boolean;
  /** The LAST window has unsaved non-Office edits (a text editor, a parked draft): it was just
   *  shown their list instead of closing (fix round 11). */
  refuseForUnsaved?(): boolean;
  /** Office: holds the close (preventDefault) to save first; false when nothing to save or on
   *  the close it re-issued itself (holdCloseForOfficeSave). */
  holdForOffice(ev: CloseEvent, cb: OfficeHoldCallbacks): boolean;
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
  let confirmed: Remembered<Answer> | null = null; // answered, waiting for the final Office pass
  let forProceed: Remembered<Answer> | null = null; // the Office pass failed: only Close anyway uses it
  let proceeding = false;
  let lastHeld = false;
  let reissuedAt: number | null = null;
  let askingHung = false;
  let asking = false; // the sessions prompt is up: a second press waits on it, never asks again
  const carryOut = (ev: CloseEvent, r: Remembered<Answer>) => {
    // Sessions owned at confirm time AND still here (one dragged away meanwhile is not ended).
    const owned = d.sessionIds();
    if (!d.apply(r.answer, r.sessionIds.filter((id) => owned.includes(id)))) ev.preventDefault();
  };
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
      // Unsaved text edits in the last window: say so before anything else (fix round 11).
      // WHY only the last window: closing it ends the app, and a parked draft (no editor on
      // screen, so no unload veto) would go with it unasked. Another window's close keeps its
      // behaviour for now: an open editor still vetoes that window's unload; a draft parked in it
      // is lost with it — accepted by the controller for this round, not solved.
      if (d.refuseForUnsaved?.()) {
        ev.preventDefault();
        // Even on the close re-issued after the sessions prompt: that answer must not be carried
        // out later by some other close (fix round 12).
        confirmed = null;
        forProceed = null;
        return;
      }
      // Office first, every time — even after the sessions prompt was answered (see above).
      const held = d.holdForOffice(ev, {
        onFailed: () => { forProceed = confirmed; confirmed = null; },
        onProceed: () => { proceeding = true; },
      });
      if (held) { lastHeld = true; return; }
      // A close right after a hold is the one Office re-issued (saved, or Close anyway).
      if (lastHeld) { reissuedAt = now(); lastHeld = false; }
      const proceed = proceeding;
      proceeding = false;
      const failedAnswer = forProceed;
      forProceed = null; // only Close anyway may use it; any other close asks again
      const r = proceed ? failedAnswer : confirmed;
      confirmed = null;
      if (r) { carryOut(ev, r); return; }
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
      reissuedAt = now();
      if (!d.isDestroyed()) d.close();
    },
    /** The page vetoed its unload (Electron `will-prevent-unload`): the close did not happen. */
    onUnloadPrevented(): void {
      confirmed = null;
      forProceed = null;
      proceeding = false;
    },
  };
}
