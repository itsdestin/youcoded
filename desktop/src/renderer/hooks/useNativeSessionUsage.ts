import { useCallback, useRef, useSyncExternalStore } from 'react';
import { useChatStore } from '../state/chat-context';
import type { TurnUsage } from '../state/chat-types';
import { selectNativeUsage } from '../state/usage-snapshot';

// Cached selector: transient measured progress, or the latest completed turn
// in the ACTIVE session (or null — no measured usage). Feeds the StatusBar
// context / tokens / tokens-per-sec chips (Plan C Task 12).
//
// Why a hook and not a useMemo (merge reconciliation, Plan C × AppInner tranche 1):
// this started life as `useMemo(..., [isNativeSession, sessionId, chatStateMap])`
// inside AppInner. Tranche 1 then deleted the reactive `chatStateMap` value —
// AppInner now holds `chatStateMapRef`, a ref fed by a store subscription,
// precisely so a dispatch no longer re-renders the whole component. A ref can't
// drive a memo (no re-render, so the chips would freeze at their first value), so
// the walk moves here, behind useSyncExternalStore: the host re-renders only when
// THIS session's selected usage object actually changes identity.
//
// Snapshot stability: getSnapshot must return a referentially stable value or
// React loops. Both `inProgressUsage` and `turn.usage` are OWNED by the chat
// store, so repeated calls return the same reference until the reducer changes
// the selected usage. (Contrast useSessionAttention, which builds a Map and
// therefore needs its own manual cache.)
export function useNativeSessionUsage(sessionId: string | null): TurnUsage | null {
  const store = useChatStore();
  // Render-phase mirror so getSnapshot sees the current sessionId on the very
  // render that switches sessions (R8 pattern — same as useActiveSessionModel).
  const sidRef = useRef(sessionId);
  sidRef.current = sessionId;

  const getSnapshot = useCallback((): TurnUsage | null => {
    const sid = sidRef.current;
    if (!sid) return null;
    const session = store.getState().get(sid);
    if (!session) return null;

    return selectNativeUsage(session);
  }, [store]);

  const subscribe = useCallback((cb: () => void) => store.subscribeAll(cb), [store]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Occupancy the harness re-based after a /compact or /clear, or null.
 *
 *  Why a separate hook rather than a field on the usage object above: that
 *  object is OWNED by the chat store (it is the turn's own `usage`), and the
 *  snapshot must stay referentially stable — synthesising a merged object here
 *  would allocate on every store change and loop React. A primitive is stable by
 *  construction, so this needs no cache, exactly like useTurnsWithUsage below.
 *
 *  The two values are combined in `selectNativeStatusChips`, which both the
 *  status bar and the /usage card call — see its parameter docs. */
export function useNativeContextOverride(sessionId: string | null): number | null {
  const store = useChatStore();
  const sidRef = useRef(sessionId);
  sidRef.current = sessionId;

  const getSnapshot = useCallback((): number | null => {
    const sid = sidRef.current;
    if (!sid) return null;
    return store.getState().get(sid)?.contextUsedOverride ?? null;
  }, [store]);

  const subscribe = useCallback((cb: () => void) => store.subscribeAll(cb), [store]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** How many completed turns in this session carry usage, saturating at 2.
 *
 *  Why it exists: the cache-reuse chip needs to tell "nothing to reuse YET"
 *  (the session's first turn — expected, and not worth alarming anyone about)
 *  from "nothing was reused" later on (the cache stopped being hit, which IS
 *  worth surfacing). Both look identical from a single turn's usage numbers.
 *
 *  Why it saturates at 2: the chip only ever asks "is this the first one?", so
 *  counting further would walk the whole timeline on every store change for an
 *  answer nothing reads. Two is "two or more".
 *
 *  Why a number and not an object: useSyncExternalStore requires a referentially
 *  stable snapshot, and a primitive is stable by construction — no cache needed
 *  (contrast the sibling hook above, which returns a store-OWNED object). */
export function useTurnsWithUsage(sessionId: string | null): 0 | 1 | 2 {
  const store = useChatStore();
  const sidRef = useRef(sessionId);
  sidRef.current = sessionId;

  const getSnapshot = useCallback((): 0 | 1 | 2 => {
    const sid = sidRef.current;
    if (!sid) return 0;
    const session = store.getState().get(sid);
    if (!session) return 0;

    let seen = 0;
    // Backward, like the sibling hook: the turns we care about are the most
    // recent ones, so the loop normally exits after a couple of entries.
    for (let i = session.timeline.length - 1; i >= 0; i--) {
      const entry = session.timeline[i];
      if (entry.kind !== 'assistant-turn') continue;
      if (!session.assistantTurns.get(entry.turnId)?.usage) continue;
      seen++;
      if (seen === 2) return 2;
    }
    return seen as 0 | 1;
  }, [store]);

  const subscribe = useCallback((cb: () => void) => store.subscribeAll(cb), [store]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
