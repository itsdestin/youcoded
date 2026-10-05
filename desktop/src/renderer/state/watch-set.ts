// watch-set.ts — which conversations a phone is receiving live (one-core R5-3). Pure: no timers, no bridge, no React.
//
// WHY (2026-10-01 one-core R5-3): the computer used to send a phone EVERY conversation's events and terminal output, so ten busy
// conversations meant ten streams over a mobile link for one screen. Now a phone watches the conversation on its screen plus the few it
// looked at last, and learns about all the others from the small per-session summary alone (renderer/hooks/useSessionSummaries.ts).
//
// WHY 3 (current + the two before it): the realistic back-and-forth is "this one and the one I just came from"; a third covers a
// helper conversation checked in passing. Each watched conversation costs a live stream (its chat events and its terminal bytes) and
// a copy of its chat in the page's memory, so the number is a small constant rather than "all of them"; with ten busy conversations a
// phone that watches three receives about three tenths of what it used to, and the two it dropped by looking elsewhere cost one
// incremental catch-up (only what it missed, see session:open's `have`), not a reload. A conversation dropped from the set keeps what
// the page already drew, so switching back shows it at once while the catch-up runs.
export const WATCH_LIMIT = 3;

interface WatchChange {
  /** This call started watching `id` (it was not in the set): the caller must fill it (`session:open`). */
  added: boolean;
  /** Dropped to make room, least recently used first: the caller must tell the computer (`session:unwatch`). */
  evicted: string[];
}

export interface WatchSet {
  /** `id` is on screen (or was just chosen): watch it, most recent first, and drop the oldest beyond the limit. */
  touch(id: string): WatchChange;
  /** The conversation ended: nothing to unwatch (the computer forgot it), just stop remembering it. */
  forget(id: string): void;
  has(id: string): boolean;
  /** Most recently used first. */
  ids(): string[];
  /** The connection was lost or replaced: the computer has forgotten every watch, and the caller fills what it wants again. */
  clear(): void;
}

export function createWatchSet(limit: number = WATCH_LIMIT): WatchSet {
  // Most recent LAST: delete + set keeps a Map in recency order.
  const order = new Set<string>();
  return {
    touch(id) {
      const had = order.has(id);
      order.delete(id);
      order.add(id);
      const evicted: string[] = [];
      while (order.size > limit) {
        const oldest = order.values().next().value as string;
        order.delete(oldest);
        evicted.push(oldest);
      }
      return { added: !had, evicted };
    },
    forget(id) { order.delete(id); },
    has: (id) => order.has(id),
    ids: () => [...order].reverse(),
    clear() { order.clear(); },
  };
}
