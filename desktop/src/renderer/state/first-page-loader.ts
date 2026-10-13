import type { ChatAction } from './chat-types';
import type { TranscriptPageRequest, TranscriptPageResult } from '../../shared/types';
import type { OpenReply, Push } from '../../shared/session-open-types';
import { decideFirstPage, FIRST_PAGE_RETRY_MS } from './first-page-retry';
import { applyOpenReply } from './session-fill';

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
 * And one way it "succeeded" with the wrong page: a renderer REBUILT while its
 * sessions kept running (reload, crash recovery, an error-boundary remount)
 * got a first page that stopped where the live tailer started, so every
 * message since vanished mid-conversation. Such a renderer passes `toEnd`.
 *
 * Fixes: a locator supplied later is picked up by the attempt already running;
 * a load that did not succeed is forgotten, and the first live transcript event
 * for that session asks again (proof main can now find the file). Re-asks are
 * bounded so a session that will never have a transcript stops asking.
 *
 * Extracted from App.tsx so it can be tested — App.tsx cannot be mounted in a
 * test (see first-page-retry.ts).
 *
 * ONE FILL (2026-10-01 one-core R5-2): the first request is now `session:open` — the computer's answer carries the newest page AND what
 * only memory holds (state/session-fill.ts applies it), so a window, a torn-off window and a phone all fill here, and a reconnecting
 * phone fills again through `refill`, which sends where it got to and gets back only the events it missed. The page retry below
 * (the transcript not found yet) asks `transcript:page` for the page alone: the open's other half has already been applied.
 */

interface PageLocator { claudeSessionId: string; projectSlug: string }
/** What a caller knows about where this session's first page comes from: the
 *  resume locator, and/or `toEnd` — this renderer was rebuilt while the session
 *  kept running, so the page must read to EOF (TranscriptPageRequest.toEnd). */
export type PageHint = Partial<PageLocator> & { toEnd?: boolean };

/** Whole load runs (each up to decideFirstPage's attempt budget) per session,
 *  counting the first. Bounded so a session that never gets a transcript (a
 *  plain shell) cannot keep asking on every event. */
export const FIRST_PAGE_MAX_RUNS = 4;

export interface FirstPageLoaderDeps {
  /** `session:open`. Rejects, or answers undefined, on a bridge with no host record to fill from (the Android app's own runtime). */
  open: (req: { sessionId: string; claudeSessionId?: string; projectSlug?: string; fresh?: boolean }) => Promise<OpenReply | undefined>;
  /** `transcript:page`, for the retry while the transcript is not found yet. */
  requestPage: (req: TranscriptPageRequest) => Promise<TranscriptPageResult | null | undefined>;
  dispatch: (action: ChatAction) => void;
  /** Apply the transcript events handed to the frame batcher (see session-fill.ts). */
  flush: () => void;
  /** Hand pushes to the listeners a live push reaches (`window.claude.session.play`). */
  play: (pushes: Push[]) => void;
  /** The computer says this conversation has ended (it ended while this screen was away): show it as ended and stop asking. */
  gone?: (sessionId: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

type FillOutcome = 'ok' | 'failed';

export interface FirstPageLoader {
  /** Fill `sessionId` from a fresh page unless it is loading or loaded already. A `hint` reaches an attempt already in flight. */
  load: (sessionId: string, hint?: PageHint) => Promise<FillOutcome>;
  /** Fill it AGAIN: a reconnect sends where this screen got to and gets back only what it missed (or a fresh page when it cannot
   *  be continued); `fresh` (Refresh) always takes a fresh page. Waits for a load already running instead of starting a second. */
  refill: (sessionId: string, opts: { fresh: boolean }) => Promise<FillOutcome>;
  /**
   * Start watching `sessionId` on a phone (one-core R5-3). A conversation this page has never filled takes a first fill (and shows its
   * loading state); one it filled before and then stopped watching is filled AGAIN from where it got to, which sends only what it missed
   * (or a fresh page when it was away too long). Either way `session:open` is what makes the computer start sending it.
   */
  watch: (sessionId: string, hint?: PageHint) => Promise<FillOutcome>;
  /**
   * Stop treating a fill in flight as this conversation's fill (one-core R5-3 review): the phone told the computer to stop sending it
   * (`session:unwatch`) while its `session:open` was still running, so that open's answer is for a watch that no longer exists and is
   * applied to nothing. The next `watch` then starts a NEW open (a first fill, a fresh page); without this it would join the stale one and
   * the conversation would look filled while the computer sends it nothing.
   */
  abandon: (sessionId: string) => void;
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
  const hints = new Map<string, PageHint>();
  /** The run in flight per session. WHY: a caller that ORDERS work after the
   *  page (applyAcquired chains replayLiveState, which reaps tool cards the page
   *  left 'running') must wait for the run already going, not get an instant
   *  resolve because someone else started it (2026-09-27 review). */
  const inflight = new Map<string, Promise<FillOutcome>>();

  const fail = (sid: string): FillOutcome => {
    deps.dispatch({ type: 'HISTORY_PAGE_FAILED', sessionId: sid });
    busyOrDone.delete(sid);
    failed.add(sid);
    return 'failed';
  };

  const start = (sid: string, opts: { fresh: boolean; refill: boolean }): Promise<FillOutcome> => {
    const token = {};
    busyOrDone.set(sid, token);
    failed.delete(sid);
    const running = run(sid, token, opts).finally(() => { if (inflight.get(sid) === running) inflight.delete(sid); });
    inflight.set(sid, running);
    return running;
  };

  const load = (sid: string, hint?: PageHint): Promise<FillOutcome> => {
    // Recorded BEFORE the guard: the attempt loop reads it each time round.
    if (hint) hints.set(sid, { ...hints.get(sid), ...hint });
    if (busyOrDone.has(sid)) return inflight.get(sid) ?? Promise.resolve('ok');
    if ((runs.get(sid) ?? 0) >= FIRST_PAGE_MAX_RUNS) return Promise.resolve('ok');
    runs.set(sid, (runs.get(sid) ?? 0) + 1);
    deps.dispatch({ type: 'HISTORY_PAGE_REQUESTED', sessionId: sid });
    // A first load never resumes: whatever this screen holds for the id (nothing, or a copy from a session that had this id before)
    // is not something to continue from.
    return start(sid, { fresh: true, refill: false });
  };

  const refill = (sid: string, opts: { fresh: boolean }): Promise<FillOutcome> => {
    // A load already running IS a fill; asking again would apply the answer twice.
    const running = inflight.get(sid);
    if (running) return running;
    return start(sid, { fresh: opts.fresh, refill: true });
  };

  const run = async (sid: string, token: object, opts: { fresh: boolean; refill: boolean }): Promise<FillOutcome> => {
    const h = hints.get(sid);
    // A failed REFILL leaves the screen as it was (it still shows what it had, which the strip says may be behind); only a first load
    // that failed is forgotten and re-asked by the next live event.
    const bad = (): FillOutcome => (opts.refill ? 'failed' : fail(sid));
    // ATTEMPT 0 is the fill: one `session:open`, whose answer carries the page and everything else a screen needs.
    let reply: OpenReply | undefined;
    try {
      reply = await deps.open({
        sessionId: sid, claudeSessionId: h?.claudeSessionId, projectSlug: h?.projectSlug,
        ...(opts.fresh ? { fresh: true } : {}),
      });
    } catch {
      // The computer could not be asked (the connection dropped, a bridge with no host record).
      return busyOrDone.get(sid) === token ? bad() : 'failed';
    }
    // Closed while we waited (retainOnly dropped it): record nothing.
    if (busyOrDone.get(sid) !== token) return 'failed';
    if (reply && !reply.ok && reply.gone) {
      // An ended conversation is an ANSWER, not a failure: nothing to retry, and the strip must not say "may be behind" for it.
      deps.gone?.(sid);
      inflight.delete(sid); busyOrDone.delete(sid); failed.delete(sid); runs.delete(sid);
      return 'ok';
    }
    if (!reply || !reply.ok) return bad();

    const filler = { dispatch: deps.dispatch, flush: deps.flush, play: deps.play };
    if (reply.resume === 'events') {
      applyOpenReply(filler, sid, reply, { acceptPage: false });
      return 'ok';
    }
    const first = reply.page ?? { events: [], cursor: null, hasMore: false, unresolved: true };
    let decision = decideFirstPage(first, 0);
    // The page is applied now only when it is good; otherwise the rest of the answer is applied and the page is asked for again below.
    try { applyOpenReply(filler, sid, reply, { acceptPage: decision === 'accept' }); }
    catch (err) { console.error('[first-page] applying the fill failed', err); return bad(); }
    if (decision === 'accept') { hints.delete(sid); return 'ok'; }
    if (decision === 'give-up') return bad();

    for (let attempt = 1; ; attempt++) {
      await sleep(FIRST_PAGE_RETRY_MS);
      let page: TranscriptPageResult | null | undefined;
      try {
        const hh = hints.get(sid);
        page = await deps.requestPage({ sessionId: sid, beforeCursor: null, toEnd: true,
          claudeSessionId: hh?.claudeSessionId, projectSlug: hh?.projectSlug });
      } catch {
        return busyOrDone.get(sid) === token ? bad() : 'failed';
      }
      if (busyOrDone.get(sid) !== token) return 'failed';
      if (!page) return bad();
      decision = decideFirstPage(page, attempt);
      if (decision === 'accept') {
        hints.delete(sid);
        try {
          deps.dispatch({ type: 'HISTORY_PAGE_LOADED', sessionId: sid, events: page.events, cursor: page.cursor,
            hasMore: page.hasMore, reconcileInterrupted: page.reconcileInterrupted === true,
            reconcileInterruptedToolIds: page.reconcileInterruptedToolIds });
        } catch (err) {
          // The page replay threw. Same outcome the App closure had (it sat in
          // its try), but now re-askable, and bounded by FIRST_PAGE_MAX_RUNS.
          console.error('[first-page] applying the first page failed', err);
          return bad();
        }
        return 'ok';
      }
      if (decision === 'give-up') return bad();
    }
  };

  const watch = (sid: string, hint?: PageHint): Promise<FillOutcome> => {
    // Never filled here (or its first fill failed and was forgotten): a first fill. Otherwise it is a conversation this page already holds.
    if (!busyOrDone.has(sid) && !inflight.has(sid)) return load(sid, hint);
    return refill(sid, { fresh: false });
  };

  const abandon = (sid: string): void => {
    // Only a fill still running is abandoned; a finished one is a conversation this page holds and resumes from its cursor.
    if (!inflight.has(sid)) return;
    inflight.delete(sid); busyOrDone.delete(sid); failed.delete(sid); runs.delete(sid);
  };

  return {
    load,
    refill,
    watch,
    abandon,
    // One Set lookup per live event — the hot path pays nothing else.
    noteLiveActivity: (sid) => { if (failed.has(sid)) void load(sid); },
    retainOnly: (liveIds) => {
      for (const id of failed) if (!liveIds.has(id)) failed.delete(id);
      for (const map of [busyOrDone, runs, hints, inflight]) for (const id of map.keys()) if (!liveIds.has(id)) map.delete(id);
    },
  };
}
