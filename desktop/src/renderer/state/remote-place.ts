// Where a phone opens, and when it may load history of its own
// (remote access batch 2, design §3 and §4; contract R2, R5).
//
// WHY a module of pure functions: App decides these at five places that cannot be
// exercised in a unit test (App does not mount outside the real bridge), and the rules
// are exactly the part that is easy to get subtly wrong — a phone that jumps away from
// what you were reading, or loads a page of history on top of the computer's copy and
// shows every message twice. The rules are tested here (tests/remote-place.test.ts);
// App's use of them is pinned in tests/remote-place-app-wiring.test.ts.

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
export interface PlaceStorages { session: StorageLike; local: StorageLike }

const PLACE_KEY_PREFIX = 'youcoded-remote-place:';

/**
 * The host a stored place belongs to: the paired target's host:port when the Android
 * app stored one (`youcoded-remote-target`, set by connectToHost), else the page's own
 * host — a phone browser has no stored target.
 */
export function remotePlaceHostId(target: string | null, locationHost: string): string {
  if (target) {
    try { return new URL(target).host || locationHost; } catch { /* fall through */ }
  }
  return locationHost;
}

/** The place is per TAB (sessionStorage), mirrored per host into localStorage as the
 *  fallback for a fresh tab or a reload that lost the tab's storage. Storage that
 *  throws (a private window) reads as no place. */
export function readRemotePlace(storages: PlaceStorages, hostId: string): string | null {
  const key = PLACE_KEY_PREFIX + hostId;
  for (const store of [storages.session, storages.local]) {
    try {
      const v = store.getItem(key);
      if (v) return v;
    } catch { /* try the next one */ }
  }
  return null;
}

export function writeRemotePlace(storages: PlaceStorages, hostId: string, sessionId: string): void {
  const key = PLACE_KEY_PREFIX + hostId;
  for (const store of [storages.session, storages.local]) {
    try { store.setItem(key, sessionId); } catch { /* nothing to remember it in */ }
  }
}

/** The browser's storages; kept out of the pure functions above so they stay testable. */
export function remotePlaceStorages(): PlaceStorages {
  return { session: window.sessionStorage, local: window.localStorage };
}

export function remotePlaceHost(): string {
  let target: string | null = null;
  try { target = window.localStorage.getItem('youcoded-remote-target'); } catch { /* none */ }
  return remotePlaceHostId(target, window.location.host);
}

/**
 * Where the phone opens when the computer's copy has been applied: its stored place if
 * that conversation still exists, else the one the desktop is showing, else the first.
 *
 * Decision (T4): "still exists" means after the apply — including a conversation an
 * incomplete copy KEPT — not only one the snapshot carried. Otherwise an incomplete
 * Refresh would jump the phone away from what it was reading (contract R3).
 */
export function choosePlaceOnHydrate(input: {
  stored: string | null;
  existingSessionIds: string[];
  focusSessionId: string | null | undefined;
}): string | null {
  const { stored, existingSessionIds, focusSessionId } = input;
  if (stored && existingSessionIds.includes(stored)) return stored;
  if (focusSessionId && existingSessionIds.includes(focusSessionId)) return focusSessionId;
  return existingSessionIds[0] ?? null;
}

/** After a conversation goes away: unchanged unless it was the one on screen; then the
 *  desktop's focus, unless the focus IS the destroyed one (session-exit fires before
 *  any desktop window moves), then the first remaining. */
export function chooseAfterDestroyed(input: {
  destroyedId: string;
  currentId: string | null;
  remainingIds: string[];
  focusSessionId: string | null | undefined;
}): string | null {
  const { destroyedId, currentId, remainingIds, focusSessionId } = input;
  if (currentId !== destroyedId) return currentId;
  if (focusSessionId && focusSessionId !== destroyedId && remainingIds.includes(focusSessionId)) return focusSessionId;
  return remainingIds[0] ?? null;
}

/**
 * Whether this window may ask for a session's first page of history.
 *
 * A remote client waits for the computer's copy first — a page requested before it
 * arrives lands on top of it — and never loads one for a session the copy delivered:
 * the replayed page's turn and tool-group ids are this client's, so entries the uuid
 * dedup does not cover appeared twice (design §4). A session created after the copy,
 * or one an incomplete first copy omitted, still loads its own.
 */
export function shouldLoadFirstPage(input: { remote: boolean; placeDecided: boolean; hydrated: boolean }): boolean {
  if (!input.remote) return true;
  if (!input.placeDecided) return false;
  return !input.hydrated;
}
