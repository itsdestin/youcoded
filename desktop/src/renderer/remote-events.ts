// Window events the remote shim raises for the page. Deliberately its own
// module with NO imports, like remote-unsupported.ts: remote-shim.ts is loaded
// only via a dynamic import() on the remote/browser path (index.tsx), and a
// renderer hook importing a constant straight from it would drag the whole shim
// into the main bundle and evaluate it on the desktop, where it is never used.

/**
 * Fired once per RECONNECT (never on the first connect), after auth completes
 * and the shim has re-issued its own reads. A screen holding a per-socket
 * subscription on the host — the project watcher — listens for this and
 * subscribes again: the host keys those by socket, and a reconnect is a new
 * socket (remote access batch 3, design §8 "Live refresh").
 */
export const REMOTE_RECONNECTED_EVENT = 'youcoded:remote-reconnected';

/**
 * Fired when the person presses Refresh on the "may be behind" strip. App listens and fills every conversation again from a
 * fresh page (the computer's record, one-core R5-2), then reports how it went (`remote.reportFill`). The shim cannot do it
 * itself: it does not own the chat state.
 */
export const REMOTE_REFRESH_EVENT = 'youcoded:remote-refresh';

/**
 * Ids whose fate the host could not tell us after a reconnect, as `{id, type, outcome, sendId?}` (the shim raises it; see remote-shim.ts). A request that
 * was a chat message names it by `sendId`, and hooks/useSendReconcile.ts asks the computer's record what became of it.
 */
export const OUTCOME_UNKNOWN_EVENT = 'youcoded:outcome-unknown';
