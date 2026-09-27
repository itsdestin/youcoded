import type { ChatAction } from './chat-types';
import type { TranscriptPageRequest, TranscriptPageResult } from '../../shared/types';
import { decideFirstPage, FIRST_PAGE_RETRY_MS } from './first-page-retry';

/**
 * Loads each session's FIRST page of history (the newest one) exactly once —
 * and, unlike the App.tsx closure it replaces, never leaves a live conversation
 * permanently blank because that one load failed.
 *
 * WHY this exists (2026-09-27, "my messages disappeared, but Claude still
 * remembers them"): the old guard recorded a session as "asked" on the FIRST
 * request and never forgot it while the session stayed open. Two ways that
 * request could fail for good, each leaving "Start a conversation" over a
 * conversation that was fine:
 *
 *  1. Resume race. session:created reaches the renderer before the resume's
 *     own reply, so the sessions effect asked WITHOUT the transcript locator;
 *     main answered `unresolved` until Claude Code's SessionStart hook landed,
 *     the retries ran out (~3 s), and the resume's locator-carrying request
 *     then hit the guard and did nothing. A slow Claude Code start (MCP
 *     servers, the trust prompt) was enough.
 *  2. A transient read failure (a Windows file lock) answered as a failure.
 *
 * Fixes: a locator supplied later is picked up by the attempt already running;
 * a load that did not succeed is forgotten, and the first live transcript event
 * for that session asks again (proof main can now find the file). Re-asks are
 * bounded so a session that will never have a transcript stops asking.
 *
 * Extracted from App.tsx so it can be tested — App.tsx cannot be mounted in a
 * test (see first-page-retry.ts).
 */

export interface PageLocator { claudeSessionId: string; projectSlug: string }

/** Whole load runs (each up to decideFirstPage's attempt budget) per session,
 *  counting the first. Bounded so a session that never gets a transcript (a
 *  plain shell) cannot keep asking on every event. */
export const FIRST_PAGE_MAX_RUNS = 4;

export interface FirstPageLoaderDeps {
  request: (req: TranscriptPageRequest) => Promise<TranscriptPageResult | null | undefined>;
  dispatch: (action: ChatAction) => void;
  /** false = not now (a remote client waiting for its hydrate). NOT recorded,
   *  so a later call can still load. */
  mayLoad: (sessionId: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

export interface FirstPageLoader {
  /** Load `sessionId`'s newest page unless it is loading or loaded already. A
   *  `locator` reaches an attempt already in flight. */
  load: (sessionId: string, locator?: PageLocator) => Promise<void>;
  /** A live transcript event arrived: re-ask if this session's load failed. */
  noteLiveActivity: (sessionId: string) => void;
  /** Forget every session not in `liveIds` (closed sessions; a native id can
   *  legitimately come back and must get its history again). */
  retainOnly: (liveIds: ReadonlySet<string>) => void;
}

export function createFirstPageLoader(deps: FirstPageLoaderDeps): FirstPageLoader {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  /** Loading now, or loaded — the value is the run's token, so a run whose
   *  session was closed (and maybe reopened under the same id) mid-await can
   *  tell it is no longer current and records nothing. */
  const busyOrDone = new Map<string, object>();
  /** Loads that did not succeed, awaiting a live event to try again. */
  const failed = new Set<string>();
  const runs = new Map<string, number>();
  const locators = new Map<string, PageLocator>();

  const fail = (sid: string) => {
    deps.dispatch({ type: 'HISTORY_PAGE_FAILED', sessionId: sid });
    busyOrDone.delete(sid);
    failed.add(sid);
  };

  const load = async (sid: string, locator?: PageLocator) => {
    // Recorded BEFORE the guard: the attempt loop reads it each time round.
    if (locator) locators.set(sid, locator);
    if (busyOrDone.has(sid)) return;
    if ((runs.get(sid) ?? 0) >= FIRST_PAGE_MAX_RUNS) return;
    if (!deps.mayLoad(sid)) return;
    const token = {};
    busyOrDone.set(sid, token);
    failed.delete(sid);
    runs.set(sid, (runs.get(sid) ?? 0) + 1);
    deps.dispatch({ type: 'HISTORY_PAGE_REQUESTED', sessionId: sid });
    for (let attempt = 0; ; attempt++) {
      let page: TranscriptPageResult | null | undefined;
      try {
        const loc = locators.get(sid);
        page = await deps.request({ sessionId: sid, beforeCursor: null,
          claudeSessionId: loc?.claudeSessionId, projectSlug: loc?.projectSlug });
      } catch {
        if (busyOrDone.get(sid) === token) fail(sid);
        return;
      }
      // Closed while we waited (retainOnly dropped it): record nothing.
      if (busyOrDone.get(sid) !== token) return;
      if (!page) { fail(sid); return; }
      const decision = decideFirstPage(page, attempt);
      if (decision === 'accept') {
        locators.delete(sid);
        try {
          deps.dispatch({ type: 'HISTORY_PAGE_LOADED', sessionId: sid, events: page.events, cursor: page.cursor,
            hasMore: page.hasMore, reconcileInterrupted: page.reconcileInterrupted === true,
            reconcileInterruptedToolIds: page.reconcileInterruptedToolIds });
        } catch (err) {
          // The page replay threw. Same outcome the App closure had (it sat in
          // its try), but now re-askable, and bounded by FIRST_PAGE_MAX_RUNS.
          console.error('[first-page] applying the first page failed', err);
          fail(sid);
        }
        return;
      }
      if (decision === 'give-up') { fail(sid); return; }
      await sleep(FIRST_PAGE_RETRY_MS);
    }
  };

  return {
    load,
    // One Set lookup per live event — the hot path pays nothing else.
    noteLiveActivity: (sid) => { if (failed.has(sid)) void load(sid); },
    retainOnly: (liveIds) => {
      for (const id of failed) if (!liveIds.has(id)) failed.delete(id);
      for (const map of [busyOrDone, runs, locators]) for (const id of map.keys()) if (!liveIds.has(id)) map.delete(id);
    },
  };
}
