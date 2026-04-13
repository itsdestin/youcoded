// marketplace-auth-context.tsx
// Global "am I signed in to the marketplace?" React context.
//
// Uses window.claude.marketplaceAuth (exposed via preload + remote-shim) for all
// communication with the main process. The main process owns the token — it never
// crosses the IPC boundary into the renderer.
//
// Polling contract (device-code OAuth flow):
//   1. startSignIn() calls marketplaceAuth.start() → receives device_code + auth_url
//   2. A poll loop calls marketplaceAuth.poll(device_code) every pollIntervalMs ms
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

// ── Context shape ─────────────────────────────────────────────────────────────

interface MarketplaceAuthCtx {
  /** Whether the user is currently signed in to the marketplace. */
  signedIn: boolean;
  /** The signed-in user's profile, or null if not signed in. */
  user: MarketplaceUser | null;
  /** True while the device-code sign-in flow is in progress. */
  signInPending: boolean;
  /** Kick off the device-code OAuth flow. Resolves when sign-in completes or rejects on timeout/error. */
  startSignIn(): Promise<void>;
  /** Sign out and clear local state. */
  signOut(): Promise<void>;
}

const MarketplaceAuthContext = createContext<MarketplaceAuthCtx | null>(null);

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_POLL_INTERVAL_MS = 2000;
// 15 minutes — matches the typical GitHub device-code expiry window
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

// ── Provider ──────────────────────────────────────────────────────────────────

export function MarketplaceAuthProvider({
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

  // Refresh auth state from the main process (token + user profile).
  // Called on mount and after sign-in completes.
  const refresh = useCallback(async () => {
    // Note: signedIn() and user() return plain values (NOT ApiResult-wrapped).
    // The main process reads from its in-memory store so these are cheap/fast.
    const isIn = await window.claude.marketplaceAuth.signedIn();
    if (cancelledRef.current) return; // unmounted — skip setState
    const profile = await window.claude.marketplaceAuth.user();
    if (cancelledRef.current) return; // unmounted — skip setState
    setSignedIn(isIn);
    setUser(profile);
  }, []);

  // Load initial auth state on mount
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Start the device-code OAuth flow.
  // Prevents concurrent flows with signInPending guard.
  const startSignIn = useCallback(async () => {
    if (signInPending) return;
    setSignInPending(true);
    try {
      // Fix: start() returns ApiResult<AuthStartResponse> — must check .ok and
      // read .value; the main process may return an error if the auth server is down.
      const startRes = await window.claude.marketplaceAuth.start();
      if (cancelledRef.current) return; // unmounted mid-await — abort before setState
      if (!startRes.ok) {
        throw new Error(`sign-in start failed: ${startRes.message ?? "unknown error"}`);
      }
      const { device_code } = startRes.value;

      const deadline = Date.now() + POLL_TIMEOUT_MS;

      // Poll loop — runs until "complete" or timeout.
      // Fix: each await point checks cancelledRef so an unmount during the 15-minute
      // window stops the loop immediately instead of continuing to burn IPC calls.
      while (true) {
        if (cancelledRef.current) return; // unmounted — stop loop
        if (Date.now() > deadline) {
          throw new Error("sign-in timed out — please try again");
        }

        const pollRes = await window.claude.marketplaceAuth.poll(device_code);
        if (cancelledRef.current) return; // unmounted mid-await — stop loop

        if (!pollRes.ok) {
          throw new Error(`sign-in poll failed: ${pollRes.message ?? "unknown error"}`);
        }
        const pollData = pollRes.value;

        if (pollData.status === "complete") {
          // Main process has stored the token — refresh our renderer-side state
          await refresh();
          return;
        }

        // Status is "pending" — wait before polling again
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        if (cancelledRef.current) return; // unmounted during sleep — stop loop
      }
    } finally {
      // Always clear pending flag, even on error or timeout.
      // Guard against setState on unmounted: if cancelled the component is gone
      // but setSignInPending is a no-op at that point (React silently ignores it).
      setSignInPending(false);
    }
  }, [signInPending, pollIntervalMs, refresh]);

  // Sign out — clear token on main process side, then clear local React state.
  // Fix: optimistic sign-out — local state is cleared unconditionally even if
  // the IPC call rejects. This is intentional: a failed signOut() on the main
  // process side is rare and the UX cost of leaving the user "stuck signed in"
  // is worse than the edge-case inconsistency. Do NOT add error propagation here
  // unless the design explicitly requires rollback on failure.
  const signOut = useCallback(async () => {
    await window.claude.marketplaceAuth.signOut();
    setSignedIn(false);
    setUser(null);
  }, []);

  // Fix: memoize context value so consumers only re-render when signedIn / user /
  // signInPending actually change. Action fns (startSignIn, signOut) are stable
  // useCallback references, so they don't break the memo comparison.
  // Matches the pattern used in ThemeProvider (theme-context.tsx).
  const value = useMemo<MarketplaceAuthCtx>(
    () => ({ signedIn, user, signInPending, startSignIn, signOut }),
    [signedIn, user, signInPending, startSignIn, signOut],
  );

  return (
    <MarketplaceAuthContext.Provider value={value}>
      {children}
    </MarketplaceAuthContext.Provider>
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/** Access marketplace auth state and actions from any component inside MarketplaceAuthProvider. */
export function useMarketplaceAuth(): MarketplaceAuthCtx {
  const ctx = useContext(MarketplaceAuthContext);
  if (!ctx) {
    throw new Error(
      "useMarketplaceAuth must be used inside <MarketplaceAuthProvider>"
    );
  }
  return ctx;
}
