// session-fill.ts — applies a `session:open` answer to a screen (one-core R5-2). The host half is main/session-open.ts.
//
// WHY ONE FUNCTION (2026-10-01 one-core R5-2): a phone, a torn-off window and a reconnecting phone each used to apply a different thing —
// a whole copy of another window's chat state, a page plus a live-state replay, an event-by-event hook replay — with different rules for
// each. Now the computer answers one question ("what do I need to draw this session?") and every screen applies the answer the same way:
//
//   1. start the session over (only when the answer is a fresh page: the screen's copy was never this record's, or is too far behind);
//   2. play `before`: the record's recent past, as live events (a streaming answer's deltas arrive merged), through the SAME handlers a
//      live event reaches;
//   3. apply the page: older history, prepended below what is already there, skipping what the screen already holds (the reducer's
//      uuid and tool-id checks — which is why `before` may overlap the page);
//   4. play `after`: what only memory holds (asks still waiting, a helper's run, the turn's progress, the idle marker) or, for a
//      screen that only missed events, exactly those events.
//
// The caller (first-page-loader.ts) decides whether the page is good enough to apply; this file never retries anything.
import type { ChatAction } from './chat-types';
import type { OpenReply, Push } from '../../shared/session-open-types';

export interface FillDeps {
  dispatch: (action: ChatAction) => void;
  /** Apply the transcript events already handed to the frame batcher: `before` must land before the page does. */
  flush: () => void;
  /** Hand pushes to the listeners a live push reaches (`window.claude.session.play`). */
  play: (pushes: Push[]) => void;
}

export type OpenOk = Extract<OpenReply, { ok: true }>;

export function applyOpenReply(deps: FillDeps, sessionId: string, reply: OpenOk, opts: { acceptPage: boolean }): void {
  if (reply.resume === 'page') {
    deps.dispatch({ type: 'SESSION_FILL_RESET', sessionId });
    deps.play(reply.before);
    deps.flush();
    const page = reply.page;
    if (opts.acceptPage && page) {
      deps.dispatch({
        type: 'HISTORY_PAGE_LOADED', sessionId, events: page.events, cursor: page.cursor, hasMore: page.hasMore,
        reconcileInterrupted: page.reconcileInterrupted === true, reconcileInterruptedToolIds: page.reconcileInterruptedToolIds,
      });
    } else {
      // The page is not ready (the transcript is not found yet): the loader asks again, and `loading` keeps the scroll-up sentinel idle.
      deps.dispatch({ type: 'HISTORY_PAGE_REQUESTED', sessionId });
    }
  }
  // A page read from disk cannot say a turn is in flight; the record can.
  deps.dispatch({ type: 'SESSION_WORKING_SYNCED', sessionId, working: reply.facts.working });
  deps.play(reply.after);
}
