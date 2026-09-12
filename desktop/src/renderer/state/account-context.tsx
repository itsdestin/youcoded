// account-context.tsx
// Global "am I signed in to my YouCoded account?" React context.
//
// WHY the "account" naming: this is the Phase 2 rename. Phase 1 renamed only the
// underlying window.claude surface (marketplaceAuth → account) and deliberately
// left the React-side provider/hook identifiers on their old marketplace names to
// keep that diff small. Phase 2's friends UI builds on the account identity, so
// the React-side rename to AccountProvider / useAccount lands here as a pure
// mechanical change with zero behavior difference.
//
// Uses window.claude.account (exposed via preload + remote-shim) for all
// communication with the main process. The main process owns the token — it never
// crosses the IPC boundary into the renderer.
//
// Polling contract (device-code OAuth flow):
//   1. startSignIn() calls account.start() → receives device_code + auth_url
//   2. A poll loop calls account.poll(device_code) every pollIntervalMs ms
//   3. When poll returns status "complete", refresh() is called to update state
//   4. The loop times out after 15 minutes (POLL_TIMEOUT_MS)

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MarketplaceUser } from "../../main/marketplace-auth-store";
import { useOnRemoteReconnect } from "../hooks/useOnRemoteReconnect";

// ── Context shape ─────────────────────────────────────────────────────────────

interface AccountCtx {
  /** Whether the user is currently signed in to their YouCoded account. */
  signedIn: boolean;
  /** The signed-in user's profile, or null if not signed in. */
  user: MarketplaceUser | null;
  /** True while the device-code sign-in flow is in progress. */
  signInPending: boolean;
  /**
   * Human-readable message when the last sign-in attempt failed, else null.
   * (knowledge-debt #6: startSignIn failures were void-swallowed at every
   * sign-in button — this one context field surfaces them everywhere.)
   * Cleared when a new sign-in attempt starts.
   */
  signInError: string | null;
  /** Kick off the device-code OAuth flow. On failure sets `signInError` (never rejects). */
  startSignIn(): Promise<void>;
  /**
   * Force a /auth/me round-trip and apply the fresh profile to state. A null
   * result (session 401-cleared server-side) flips the UI to signed-out.
   * (knowledge-debt #8: profile changes on another device now propagate here.)
   */
  refresh(): Promise<void>;
  /** Sign out and clear local state. */
  signOut(): Promise<void>;
  /** Update display name; refreshes user state on success. Throws on failure. */
  updateProfile(displayName: string): Promise<void>;
  /** Set/change handle; refreshes user state. Throws with the server's message on 400/409. */
  setHandle(handle: string): Promise<void>;
  /** Delete the account server-side and clear local state. */
  deleteAccount(): Promise<void>;
}

const AccountContext = createContext<AccountCtx | null>(null);

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_POLL_INTERVAL_MS = 2000;
// 15 minutes — matches the typical GitHub device-code expiry window
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

// ── Provider ──────────────────────────────────────────────────────────────────

export function AccountProvider({
  children,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: {
  children: React.ReactNode;
  /** Override poll interval — used by tests to speed up the poll loop. */
  pollIntervalMs?: number;
}) {
  const [signedIn, setSignedIn] = useState(false);
  const [user, setUser] = useState<MarketplaceUser | null>(null);
  const [signInPending, setSignInPending] = useState(false);
  // knowledge-debt #6: one context-level error string surfaces sign-in failures
  // at every sign-in button (they were void-swallowed at 4 separate callsites).
  const [signInError, setSignInError] = useState<string | null>(null);

  // Fix: cancelledRef prevents setState calls and poll-loop IPC calls after unmount.
  // Without this, an in-progress sign-in flow (which can run up to 15 minutes)
  // keeps firing poll() IPC calls and calling setState long after the component is gone.
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  // knowledge-debt #5: an in-flight sign-in poll loop could complete AFTER a
  // signOut()/deleteAccount() and flip state back to signed-in. Each signOut /
  // deleteAccount bumps this epoch; the poll loop captures it at start and
  // discards its result if the epoch changed underneath it.
  const signInEpoch = useRef(0);

  // Re-read auth state from the main process's LOCAL store (token + cached
  // profile). Cheap, no network — used on mount, after sign-in completes, and
  // after profile mutations (the main process has already mirrored those into
  // its store). For a forced /auth/me round-trip, use refresh() below instead.
  const reloadFromStore = useCallback(async () => {
    // Note: signedIn() and user() return plain values (NOT ApiResult-wrapped).
    // The main process reads from its in-memory store so these are cheap/fast.
    const isIn = await window.claude.account.signedIn();
    if (cancelledRef.current) return; // unmounted — skip setState
    const profile = await window.claude.account.user();
    if (cancelledRef.current) return; // unmounted — skip setState
    setSignedIn(isIn);
    setUser(profile);
  }, []);

  // knowledge-debt #8: force a /auth/me round-trip via the main process, then
  // apply the fresh profile to state. A null result means the token was cleared
  // server-side (401 auto-sign-out) — propagate that to the UI so it flips to
  // signed-out. A transient offline failure returns the cached profile (main
  // swallows non-401 errors), so a network blip can't blank a signed-in UI.
  const refresh = useCallback(async () => {
    // Fix: capture the epoch so a refresh resolving AFTER a signOut/deleteAccount
    // can't resurrect the signed-in UI. refresh() runs on every focus/15-min tick,
    // so a signOut landing while the main process's /auth/me is in flight would
    // otherwise flip the UI back to signed-in when it resolves OK. (The store-side
    // re-persist self-heals — the revoked token 401s on the next refresh — but the
    // visible flip-back would not.)
    const epoch = signInEpoch.current;
    const profile = await window.claude.account.refresh();
    if (cancelledRef.current || signInEpoch.current !== epoch) return; // unmounted / signed-out mid-flight — skip setState
    setSignedIn(!!profile);
    setUser(profile);
  }, []);

  // Load initial auth state on mount
  useEffect(() => {
    void reloadFromStore();
  }, [reloadFromStore]);
  // And after a remote reconnect: a read lost while the phone was away left "Sign in" on screen
  // for a signed-in user until the page reloaded (2026-09-11 phone pass sweep).
  useOnRemoteReconnect(() => { reloadFromStore().catch(() => { /* next reconnect retries */ }); });

  // Start the device-code OAuth flow.
  // Prevents concurrent flows with signInPending guard.
  const startSignIn = useCallback(async () => {
    if (signInPending) return;
    setSignInPending(true);
    setSignInError(null); // clear any prior error on a fresh attempt
    // knowledge-debt #5: capture the epoch so a signOut/deleteAccount that lands
    // mid-flight makes the loop discard its result instead of resurrecting the session.
    const epoch = signInEpoch.current;
    try {
      // Fix: start() returns ApiResult<AuthStartResponse> — must check .ok and
      // read .value; the main process may return an error if the auth server is down.
      const startRes = await window.claude.account.start();
      if (cancelledRef.current || signInEpoch.current !== epoch) return; // unmounted / cancelled mid-await
      if (!startRes.ok) {
        throw new Error(`sign-in start failed: ${startRes.message ?? "unknown error"}`);
      }
      const { device_code } = startRes.value;

      const deadline = Date.now() + POLL_TIMEOUT_MS;

      // Poll loop — runs until "complete" or timeout.
      // Fix: each await point checks cancelledRef so an unmount during the 15-minute
      // window stops the loop immediately instead of continuing to burn IPC calls.
      while (true) {
        if (cancelledRef.current || signInEpoch.current !== epoch) return; // unmounted / cancelled — stop loop
        if (Date.now() > deadline) {
          throw new Error("sign-in timed out — please try again");
        }

        const pollRes = await window.claude.account.poll(device_code);
        if (cancelledRef.current || signInEpoch.current !== epoch) return; // unmounted / cancelled mid-await — stop loop

        if (!pollRes.ok) {
          throw new Error(`sign-in poll failed: ${pollRes.message ?? "unknown error"}`);
        }
        const pollData = pollRes.value;

        if (pollData.status === "complete") {
          // Main process has stored the token — reload our renderer-side state.
          await reloadFromStore();
          return;
        }

        // Status is "pending" — wait before polling again
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        if (cancelledRef.current || signInEpoch.current !== epoch) return; // unmounted / cancelled during sleep — stop loop
      }
    } catch (err) {
      // knowledge-debt #6: surface the failure via context instead of leaving it
      // as an unhandled rejection (every sign-in button calls `void startSignIn()`).
      // The four sign-in surfaces render `signInError` below their button.
      if (!cancelledRef.current && signInEpoch.current === epoch) {
        setSignInError(err instanceof Error ? err.message : "sign-in failed");
      }
    } finally {
      // Always clear pending flag, even on error or timeout.
      // Guard against setState on unmounted: if cancelled the component is gone
      // but setSignInPending is a no-op at that point (React silently ignores it).
      setSignInPending(false);
    }
  }, [signInPending, pollIntervalMs, reloadFromStore]);

  // Sign out — clear token on main process side, then clear local React state.
  // Fix: optimistic sign-out — local state is cleared unconditionally even if
  // the IPC call rejects. This is intentional: a failed signOut() on the main
  // process side is rare and the UX cost of leaving the user "stuck signed in"
  // is worse than the edge-case inconsistency. Do NOT add error propagation here
  // unless the design explicitly requires rollback on failure.
  const signOut = useCallback(async () => {
    // knowledge-debt #5: bump the epoch FIRST so any in-flight sign-in poll loop
    // discards its result instead of flipping us back to signed-in after this.
    signInEpoch.current += 1;
    // Fix: try/CATCH (not try/finally) so the IPC rejection is SWALLOWED, not
    // re-thrown. void-callers (the "Sign out" button) would otherwise get an
    // unhandled promise rejection — contradicting the "do NOT propagate" contract
    // above. Local state is cleared after the try either way, so a failed
    // main-process signOut still leaves the UI signed out (optimistic).
    try {
      await window.claude.account.signOut();
    } catch (err) {
      console.warn("account.signOut() failed; clearing local state anyway", err);
    }
    setSignedIn(false);
    setUser(null);
  }, []);

  // Update the display name. Unlike signOut, this propagates failure to the caller
  // (the Settings UI shows the error inline) and refreshes user state on success so
  // the new name renders without a manual reload.
  const updateProfile = useCallback(async (displayName: string) => {
    const res = await window.claude.account.updateProfile(displayName);
    if (!res.ok) {
      // Fix: on failure ALSO refresh before re-throwing. A 401 makes the main
      // process clear the local session (dead/expired token); refresh() re-reads
      // signedIn()/user() so the UI flips to signed-out promptly instead of
      // staying stranded "signed in" while every call fails. Non-401 failures
      // (e.g. validation) leave the session intact, so this is a cheap no-op.
      await reloadFromStore();
      throw new Error(res.message ?? "couldn't update name");
    }
    await reloadFromStore();
  }, [reloadFromStore]);

  // Claim/change the @handle. Throws with the server's message (e.g. "that handle is
  // taken" on 409) so the Settings UI can surface it verbatim; refreshes on success.
  const setHandle = useCallback(async (handle: string) => {
    const res = await window.claude.account.setHandle(handle);
    if (!res.ok) {
      // Fix: on failure ALSO refresh before re-throwing — a 401 cleared the local
      // session in the main process, so refresh() flips the UI to signed-out
      // instead of leaving the post-sign-in handle prompt stuck showing "invalid
      // token" with no way out (the exact migration bug). Non-401 failures (e.g.
      // "handle taken") keep the session, so this is a cheap no-op there.
      await reloadFromStore();
      throw new Error(res.message ?? "couldn't set handle");
    }
    await reloadFromStore();
  }, [reloadFromStore]);

  // Permanent hard-delete. Main clears the local session too, but we also clear
  // renderer state immediately so the UI reflects the signed-out state at once.
  const deleteAccount = useCallback(async () => {
    // knowledge-debt #5: bump the epoch FIRST (same as signOut) so an in-flight
    // sign-in poll can't resurrect the account we're about to delete.
    signInEpoch.current += 1;
    const res = await window.claude.account.deleteAccount();
    if (!res.ok) {
      // Same 401 escape hatch as updateProfile/setHandle: a dead token makes
      // main clear the local session, so reloadFromStore() flips the UI to
      // signed-out instead of stranding the user retrying delete against
      // "invalid token".
      await reloadFromStore();
      throw new Error(res.message ?? "couldn't delete account");
    }
    setSignedIn(false);
    setUser(null);
  }, [reloadFromStore]);

  // knowledge-debt #8: re-fetch the profile when the window regains focus (min
  // 60s between refreshes) and every 15 minutes, so a rename / new @handle made
  // on another device reaches this client without a sign-out/in cycle. Only runs
  // while signed in. Offline failures are fine — the next focus/tick retries.
  useEffect(() => {
    if (!signedIn) return;
    let last = 0;
    const doRefresh = async () => {
      if (Date.now() - last < 60_000) return;
      last = Date.now();
      try { await refresh(); } catch { /* offline is fine; next focus retries */ }
    };
    const onFocus = () => { void doRefresh(); };
    window.addEventListener("focus", onFocus);
    const timer = setInterval(() => { void doRefresh(); }, 15 * 60_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(timer);
    };
  }, [signedIn, refresh]);

  // Fix: memoize context value so consumers only re-render when signedIn / user /
  // signInPending / signInError actually change. Action fns (startSignIn, refresh,
  // signOut, updateProfile, setHandle, deleteAccount) are stable useCallback
  // references, so they don't break the memo comparison. Matches the pattern used
  // in ThemeProvider (theme-context.tsx).
  const value = useMemo<AccountCtx>(
    () => ({ signedIn, user, signInPending, signInError, startSignIn, refresh, signOut, updateProfile, setHandle, deleteAccount }),
    [signedIn, user, signInPending, signInError, startSignIn, refresh, signOut, updateProfile, setHandle, deleteAccount],
  );

  return (
    <AccountContext.Provider value={value}>
      {children}
    </AccountContext.Provider>
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/** Access account auth state and actions from any component inside AccountProvider. */
export function useAccount(): AccountCtx {
  const ctx = useContext(AccountContext);
  if (!ctx) {
    throw new Error(
      "useAccount must be used inside <AccountProvider>"
    );
  }
  return ctx;
}
