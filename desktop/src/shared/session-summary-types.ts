// session-summary-types.ts — the per-session summary the computer pushes about EVERY session (`session:summary`), shared by the computer
// (main/session-record.ts builds it) and a phone's page (renderer/hooks/useSessionSummaries.ts draws dots and plays the attention sound
// from it). Types only: nothing here runs.
//
// WHY here and not in main/ (one-core R5-3): the renderer reads it, and renderer code does not import from main/.

/** What a session strip's dot needs, small enough to push to everyone.
 *
 *  Deliberately NOT here (R5-3 decision, with the reason each is left out):
 *   - the session's name: the strip already receives every rename through `session:renamed` / `session:list`, to every phone, and a
 *     second copy would be a second thing to keep equal;
 *   - the last-activity time: it changes with every event, so carrying it would make every summary push differ and send one per event
 *     for a value no screen draws;
 *   - "unseen" (the blue dot): it depends on what THIS screen has looked at, so each screen works it out for itself. */
export interface SessionSummary {
  /** A turn is in flight (what the chat calls "thinking"). Green. */
  working: boolean;
  /** Questions waiting for an answer, helpers' included. Any means red. */
  awaitingCount: number;
  /** Relayed attention when it says something is wrong, else what the events say: ok, stuck, stalled, error, awaiting-input, shell-idle, session-died. */
  attention: string;
  /** The conversation has at least one message (the blue "unseen" dot needs something to have been unseen). */
  hasHistory: boolean;
  queuedCount: number;
  /** Claude Code has run its first hook, so its startup dialogs are over (record `started`). WHY here (one-core sync-fix2): a phone that missed the moment it
   *  started (it was away, or not watching that conversation) used to read "initializing" forever, with a "check terminal view" button, for a session that is
   *  fine on the computer. The summary reaches every phone for every session, on connect and on every change. */
  started: boolean;
  // WHY no permissionMode / model here (sync-fix3): they were sent and read by no screen. A late-joining screen gets the mode and the model chip from the fill
  // (`session:open`: liveFill / the native host's facts), which is where the chips are drawn from. Carrying them also made every mode or model change push a summary nobody uses.
}

/** The push: every session the computer has a record of. */
export interface SessionSummaryPayload { summaries: Record<string, SessionSummary> }
