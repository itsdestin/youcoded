import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createWatchSet } from '../state/watch-set';
import type { FirstPageLoader } from '../state/first-page-loader';

type Outcome = 'ok' | 'failed';

/**
 * Which conversations a PHONE watches, and what that means for filling them (one-core R5-3). On the computer's own windows (`enabled`
 * false) this does nothing: they own their sessions and already receive exactly the ones they own.
 *
 * The rule: the conversation on screen is watched; the last few before it stay watched (state/watch-set.ts says how many and why);
 * everything else is not sent to this phone at all, and its dot comes from the computer's summary instead. Watching is `session:open`
 * (it fills AND subscribes); a conversation that falls out of the set is told to the computer with `session:unwatch`, and keeps what
 * this page already drew, so tapping back shows it at once while a catch-up of only what was missed runs.
 */
export function useRemoteWatch(opts: {
  enabled: boolean;
  activeId: string | null;
  /** Every conversation the computer lists (an ended one is forgotten). */
  sessionIds: readonly string[];
  loader: FirstPageLoader;
}) {
  const { enabled, activeId, sessionIds, loader } = opts;
  const setRef = useRef(createWatchSet());
  /** Conversations whose fill is running now: their screen shows the loading state, not an empty conversation. */
  const [filling, setFilling] = useState<ReadonlySet<string>>(new Set());

  const watch = useCallback((sid: string): Promise<Outcome> => {
    if (!enabled || !sid || sid.startsWith('pending-handoff:')) return Promise.resolve('ok');
    const { added, evicted } = setRef.current.touch(sid);
    for (const old of evicted) {
      // An open for it may still be running: its answer is for a watch that is ending, so the next watch must start a new one.
      loader.abandon(old);
      // Fire and forget: if the message is lost the computer just keeps sending one more conversation until the next reconnect.
      try { Promise.resolve((window.claude.session as { unwatch?: (id: string) => Promise<unknown> }).unwatch?.(old)).catch(() => {}); } catch { /* bridge without it */ }
    }
    if (!added) return Promise.resolve('ok');
    setFilling((prev) => new Set(prev).add(sid));
    return loader.watch(sid).then((outcome) => outcome, () => 'failed' as const).then((outcome) => {
      setFilling((prev) => { if (!prev.has(sid)) return prev; const n = new Set(prev); n.delete(sid); return n; });
      return outcome;
    });
  }, [enabled, loader]);

  // The conversation on screen is always watched. (A tap calls `watch` itself first, so its loading state is up before the switch is drawn.)
  useEffect(() => { if (activeId) void watch(activeId); }, [activeId, watch]);

  // An ended conversation: forget it (the computer already did).
  useEffect(() => {
    const live = new Set(sessionIds);
    for (const id of setRef.current.ids()) if (!live.has(id)) setRef.current.forget(id);
  }, [sessionIds]);

  return useMemo(() => ({
    watch,
    /** What to fill again after a reconnect or Refresh: only what is watched (the rest is not sent). */
    watchedIds: () => (enabled ? setRef.current.ids() : null),
    /**
     * Is this conversation's screen still waiting for its first content? True while its fill runs, and for the ONE frame between
     * switching to a conversation and the fill being started (it is the active one and not watched yet), so an empty conversation
     * is never drawn for it. A conversation that already has content (a stale copy it is being brought up to date from) is not
     * "filling" for the screen's purposes: the caller only uses this while the timeline is empty.
     */
    isFilling: (sid: string) => enabled && (filling.has(sid) || (sid === activeId && !setRef.current.has(sid))),
  }), [watch, enabled, filling, activeId]);
}
