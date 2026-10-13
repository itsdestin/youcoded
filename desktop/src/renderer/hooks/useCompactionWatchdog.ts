import { useEffect, useRef } from 'react';
import type { ChatAction, SessionChatState } from '../state/chat-types';

export const COMPACTION_WATCHDOG_MS = 180_000;

/** The slice of the chat store the watchdog reads. */
interface WatchedStore {
  getState(): ReadonlyMap<string, SessionChatState>;
  subscribeAll(cb: () => void): () => void;
}

/** A spinner THIS screen raised and nothing else will end: not one the computer raised (it owns that watchdog, main/session-live.ts) and not
 *  one a native call's own answer ends (`awaitsResult`). */
const watchedHere = (s: SessionChatState): boolean => !!s.compactionPending && !s.compactionPending.awaitsResult && !s.compactionPending.hostOwned;

/**
 * Compaction watchdog: activity-aware — resets on any reducer update for a session with a pending compaction. Any transcript event bumps the
 * timer forward, so long compactions (large sessions) don't trigger a false "may have failed" message as long as events keep flowing. Only
 * fires if nothing happens for 180s straight, which genuinely means something's stuck.
 *
 * Prior bug: fixed 60s timer. Big sessions took longer than 60s legitimately, hit the watchdog, dispatched aborted=true, cleared the pending
 * flag — then the real shrink event arrived but had no pending flag to key off of, so the user saw "may have failed" even though compaction
 * succeeded.
 *
 * WHY it stays on a host with a record (one-core R5-4a review): the computer ends the spinners IT raised (a typed /compact, a native
 * compaction), but a screen still raises one of its own when you pick "Resume from summary" on the Resume Session card (ChatView). With this
 * watchdog switched off for the whole screen that spinner could spin forever when the summary step failed.
 * Store subscription instead of a [chatStateMap] effect (tranche 1): the host does not re-render per dispatch.
 */
export function useCompactionWatchdog(store: WatchedStore, dispatch: (a: ChatAction) => void, limitMs: number = COMPACTION_WATCHDOG_MS): void {
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const check = () => {
      const map = store.getState();
      // Perf: this runs on every reducer dispatch. Steady state (nothing watched, no live timers) short-circuits without walking the map.
      if (timers.current.size === 0) {
        let any = false;
        for (const s of map.values()) if (watchedHere(s)) { any = true; break; }
        if (!any) return;
      }
      for (const [sid, session] of map) {
        const existing = timers.current.get(sid);
        if (watchedHere(session)) {
          // Reset on every reducer tick while pending — if events are flowing for this session, the timer keeps bumping and never fires.
          if (existing) clearTimeout(existing);
          timers.current.set(sid, setTimeout(() => {
            if (store.getState().get(sid)?.compactionPending) {
              dispatch({ type: 'COMPACTION_COMPLETE', sessionId: sid, markerId: `compact-timeout-${Date.now()}`, afterContextTokens: null, aborted: true });
            }
            timers.current.delete(sid);
          }, limitMs));
        } else if (existing) {
          clearTimeout(existing);
          timers.current.delete(sid);
        }
      }
    };
    check();
    return store.subscribeAll(check);
  }, [store, dispatch, limitMs]);
}
