// The version of how a screen is filled, said in the page's `client:ready` (one-core R5-2 review fix).
// Version 2 = filled by `session:open`. A page from before that sent `client:ready` with a `seq` and no version and waited for a
// `chat:hydrate` snapshot this computer no longer sends, so the host recognises it and refuses it plainly instead of leaving it blank.
export const FILL_PROTOCOL_VERSION = 2;
/** The words a screen that is too old is given (the close reason). */
export const OLD_APP_REASON = "This app is older than your computer's YouCoded. Update the app to keep using remote access.";
/** The WebSocket close code for it (the shipped shim already treats 4005 as final: no endless retry). */
export const CLOSE_OLD_CLIENT = 4005;
/** The one line an already-open OLD phone page is shown in every conversation (it cannot be told anything else; see remote-server). */
export const REFRESH_NOTICE = 'Refresh this page to finish updating';
/** Is this `client:ready` payload from a page that expects the old snapshot? */
export function isOldFillClient(payload: unknown): boolean {
  const p = (payload ?? {}) as { seq?: unknown; protocolVersion?: unknown };
  if (typeof p.protocolVersion === 'number') return p.protocolVersion < FILL_PROTOCOL_VERSION;
  return p.seq !== undefined;
}
