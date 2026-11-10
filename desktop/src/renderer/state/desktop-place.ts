// Which chat a desktop window reopens on after a reload (card #146).
//
// WHY this exists: after a reload the window used to open the OLDEST open chat, so the next
// message typed could go to the wrong conversation. Phones already remember their place
// (remote-place.ts); this is the desktop's equivalent, kept deliberately small.
//
// WHY sessionStorage and nothing else: it belongs to ONE window, it survives that window's
// reload (Ctrl+R / webContents.reload), and a second window gets its own empty copy — so two
// windows can never overwrite each other's memory. It is wiped when the window closes, so a
// fresh app launch starts with no saved place and falls back to the first chat; a stale id
// from an earlier run can never match. localStorage is NOT used (it is shared by all windows).
// Tested in tests/desktop-place.test.ts.

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const KEY = 'youcoded-desktop-place';

/** The chat this window last showed, or null. Storage that throws reads as no place. */
export function readDesktopPlace(store: StorageLike): string | null {
  try { return store.getItem(KEY) || null; } catch { return null; }
}

/** Remember the chat on screen; null (no chat on screen) forgets it so no stale id lingers. */
export function writeDesktopPlace(store: StorageLike, sessionId: string | null): void {
  try {
    if (sessionId) store.setItem(KEY, sessionId); else store.removeItem(KEY);
  } catch { /* nothing to remember it in */ }
}

/**
 * Where a desktop window opens once its chat list has arrived. `ownedSessionIds` is the list
 * main returned for THIS window, so a saved chat that was closed or now belongs to another
 * window is simply not in it. Falls back to exactly the old behaviour: first chat, if
 * auto-selecting is allowed, else none.
 */
export function chooseDesktopPlace(input: {
  stored: string | null;
  ownedSessionIds: string[];
  mayAutoSelect: boolean;
}): string | null {
  const { stored, ownedSessionIds, mayAutoSelect } = input;
  if (!mayAutoSelect) return null;
  if (stored && ownedSessionIds.includes(stored)) return stored;
  return ownedSessionIds[0] ?? null;
}
