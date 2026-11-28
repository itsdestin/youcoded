// handler-utils.ts
// Shared helpers for token-bound IPC handler modules (marketplace-api-handlers.ts
// and social-handlers.ts). Extracted so the two modules can't drift on the error
// contract the renderer relies on. The ApiResult type itself stays in
// marketplace-api-handlers.ts (its historical home — preload.ts imports it from
// there); this module holds only behavior.

import type { MarketplaceAuthStore } from "./marketplace-auth-store";
import { MarketplaceApiError } from "../renderer/state/marketplace-api-client";
import type { ApiResult } from "./marketplace-api-handlers";
import { log } from "./logger";

// WHY: Custom Error fields (MarketplaceApiError.status) are dropped by
// structuredClone across the contextBridge. Returning a plain object preserves
// the status code so the renderer can distinguish install-gate (403) / not-found
// (404) / caps (429) from generic errors.
export async function wrap<T>(run: () => Promise<T>): Promise<ApiResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    if (e instanceof MarketplaceApiError) return { ok: false, status: e.status, message: e.message };
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, message }; // status:0 = non-API error (network, parse, etc.)
  }
}

// Fix: a 401 from an auth'd endpoint means the server no longer recognizes this
// session (identity-migration row drop, 90-day idle expiry, revocation). Keeping
// the local token would strand the user "signed in" with every call failing
// (the exact bug: post-migration users saw the handle prompt, typed a handle,
// got "invalid token" and no way out). Clear the local session so the UI flips
// to signed-out and offers a fresh sign-in. This only REACTS to a 401 that
// already happened — it never proactively validates. Returned as a closure so
// each handler module binds it to its own auth store once at registration.
//
// IT MUST NOT BE SILENT. Until now it was: no toast, no renderer event beyond
// the sign-in state flipping, and no log line. The user is unhooked from their
// account with zero feedback, presence drops with it, friends see them offline
// forever, and they only find out by opening the friends panel — a symptom
// indistinguishable from the separate presence-latch wedge. With nothing
// written down, neither the user nor a later session could tell the two apart
// after the fact.
//
// `surface` is bound once per handler module (social / marketplace / arcade)
// rather than per call, because there are 3 registration sites and 19 call
// sites, and the subsystem plus the server's own message is enough to tell
// which one 401'd. The message is the SERVER'S, never a guess of ours
// (docs/error-message-standards.md).
//
// Only logged when a session actually existed: several calls can 401 in one
// burst, and signOut() is idempotent, so this would otherwise write one line
// per in-flight request for a single sign-out event.
//
// The user-facing notice (card #216) is raised by clearSessionAfter401 below.
const MAX_LOGGED_SERVER_MESSAGE = 200;

// WHY (card #216): the log line used to be the only trace of the sign-out. Now the same moment also tells the
// screen (social-handlers registers the listener and relays it as a presence event), so the person sees a notice.
type SessionLostListener = (info: { surface: string }) => void;
let sessionLostListener: SessionLostListener | null = null;
/** One listener; a later registration replaces the earlier one (hot reload). Pass null to clear. */
export function setSessionLostListener(fn: SessionLostListener | null): void { sessionLostListener = fn; }

/**
 * The ONE place the app signs the account out because the SERVER rejected the session (a 401). Shared by the
 * 401 decorator below and the three account handlers that used to call store.signOut() silently.
 * WHY only when a session existed: several calls can 401 in one burst, but only the first finds a token, so the
 * log line and the on-screen notice both happen once per sign-out event. A sign-out the person chose never comes
 * through here (account:sign-out / sign-out-all / delete call store.signOut() themselves), so it gets no notice.
 */
export function clearSessionAfter401(store: MarketplaceAuthStore, surface: string, serverMessage: string): void {
  const hadSession = store.getToken() !== null;
  store.signOut();
  if (!hadSession) return;
  log('WARN', 'Auth', 'account session cleared — a call came back 401', {
    surface,
    // CAPPED because this is the 401 RESPONSE BODY, verbatim and
    // server-controlled: marketplace-api-client falls back to the raw
    // text when the body is not JSON, so a proxy or captive portal
    // answering with an HTML page would write that whole page here. The
    // log keeps only its last 500 lines, so one such entry can evict
    // every useful line around it. 200 characters is more than any real
    // server message and cannot cost more than one line.
    serverMessage: serverMessage.slice(0, MAX_LOGGED_SERVER_MESSAGE),
  });
  try { sessionLostListener?.({ surface }); } catch { /* a notice that fails to send must never undo the sign-out */ }
}

export function makeClearSessionOn401(store: MarketplaceAuthStore, surface: string) {
  return <T>(result: ApiResult<T>): ApiResult<T> => {
    if (!result.ok && result.status === 401) clearSessionAfter401(store, surface, result.message);
    return result;
  };
}
