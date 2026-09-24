import type { TranscriptPageResult } from '../../shared/types';
import type { ChatAction } from './chat-types';
import { decideFirstPage, FIRST_PAGE_RETRY_MS } from './first-page-retry';

/**
 * Load a conversation's FIRST history page, then ask main to re-send the state
 * that lives only in its memory (App.loadFirstPage — every startup, resume and
 * window-handoff path goes through it).
 *
 * WHY the replay is chained here, after the page has been reduced, and on
 * EVERY path: the re-sent state lands on cards the page creates. Open asks,
 * specialist run records, background command records and — since specialists
 * plans (Task 5a) — the current plan card records (`plans:event`) are all
 * dropped by the reducer when their card is not there yet, and the
 * replay-complete marker that ends the re-send reaps cards the history left
 * 'running'. Until Task 5a only the window-handoff path did this; a restarted
 * app or a resumed conversation therefore never got its plan cards (or its
 * open asks) back. The replay runs even when the page failed: an open ask
 * still has to reach the user, and it can stand up its own card.
 *
 * Extracted from App.tsx so the order can be tested (App.tsx cannot be mounted
 * in a test — see tests/app-resume-session-listener.test.ts).
 */
export interface FirstPageLoadDeps {
  /** One request for the first page (App passes `detach.requestTranscriptPage`). */
  requestPage: () => Promise<TranscriptPageResult | null | undefined>;
  /** Must reduce synchronously (the chat store's dispatch does). */
  dispatch: (action: ChatAction) => void;
  /** `detach.replayLiveState` — absent on a bridge without it. */
  replayLiveState?: () => Promise<void> | void;
  sleep?: (ms: number) => Promise<void>;
}

export type FirstPageOutcome = 'loaded' | 'failed';

export async function loadFirstPageThenReplay(sessionId: string, deps: FirstPageLoadDeps): Promise<FirstPageOutcome> {
  const outcome = await loadFirstPage(sessionId, deps);
  try {
    await deps.replayLiveState?.();
  } catch {
    // The re-send is best-effort: a failed one leaves the page on screen, the
    // same as before this chain existed. Nothing to report to the user here —
    // the cards it would have updated keep what the page gave them.
  }
  return outcome;
}

async function loadFirstPage(sessionId: string, deps: FirstPageLoadDeps): Promise<FirstPageOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      const page = await deps.requestPage();
      if (!page) { deps.dispatch({ type: 'HISTORY_PAGE_FAILED', sessionId }); return 'failed'; }
      // An empty page used to be ambiguous: either the session genuinely has
      // no history, or main could not resolve its transcript YET (a
      // just-started session is not watched until Claude Code's hook reports
      // its path). Main now says which — `unresolved` — so the two get
      // different budgets, and an unresolved one is never RECORDED: writing
      // hasMore:false + a null cursor is what permanently removes the
      // scroll-up sentinel (Destin, 2026-09-07). See first-page-retry.ts.
      const decision = decideFirstPage(page, attempt);
      if (decision === 'accept') {
        deps.dispatch({
          type: 'HISTORY_PAGE_LOADED', sessionId, events: page.events, cursor: page.cursor, hasMore: page.hasMore,
          reconcileInterrupted: page.reconcileInterrupted === true, reconcileInterruptedToolIds: page.reconcileInterruptedToolIds,
        });
        return 'loaded';
      }
      if (decision === 'give-up') { deps.dispatch({ type: 'HISTORY_PAGE_FAILED', sessionId }); return 'failed'; }
    } catch {
      // The scroll sentinel can retry; a failed first page leaves an empty
      // view rather than a wrong one.
      deps.dispatch({ type: 'HISTORY_PAGE_FAILED', sessionId });
      return 'failed';
    }
    await sleep(FIRST_PAGE_RETRY_MS);
  }
}
