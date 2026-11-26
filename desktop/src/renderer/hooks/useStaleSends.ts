// useStaleSends — the clock for stale-sends.ts: every few seconds, look at the end of each conversation for a sent bubble that has waited too long
// for its echo, and hand it to the reducer (SENDS_STALE). One timer per chat store (main window, buddy window), never per bubble or per tab.
// WHY a poll and not a timer per send: a bubble can also come back from a reload or a reconnect fill, long after its send; the poll sees those too.
// Cost: a backward look over at most the last 60 rows per conversation, every 5 s, dispatching only when something is due (performance.md rule 4).
import { useEffect } from 'react';
import { useChatDispatch, useChatStore } from '../state/chat-context';
import { dueStaleSends } from '../state/stale-sends';

const CHECK_EVERY_MS = 5_000;
/** After the window is shown again, how long its own catch-up gets before anything is judged stale. WHY (code review, 2026-11-18): a phone
 *  back from the background fills in what it missed over a few seconds; judging at once flashed a doubt note on a message whose echo was
 *  still on its way. */
const SHOWN_GRACE_MS = 15_000;

export function useStaleSends(): void {
  const dispatch = useChatDispatch();
  const store = useChatStore();
  useEffect(() => {
    let shownAt = 0;
    const onVisibility = () => { if (!document.hidden) shownAt = Date.now(); };
    const tick = () => {
      // Hidden means idle (performance.md rule 2): nobody can see a pinned bubble in a hidden window.
      if (document.hidden) return;
      const now = Date.now();
      if (now - shownAt < SHOWN_GRACE_MS) return;
      for (const [sessionId, session] of store.getState()) {
        const messageIds = dueStaleSends(session.timeline, now);
        if (messageIds.length) dispatch({ type: 'SENDS_STALE', sessionId, messageIds, now });
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    const timer = setInterval(tick, CHECK_EVERY_MS);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [dispatch, store]);
}
