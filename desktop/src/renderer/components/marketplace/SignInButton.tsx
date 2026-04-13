// SignInButton.tsx
// Marketplace header component that renders one of three states:
//   1. Signed out   → "Sign in with GitHub" button
//   2. Pending      → disabled button with "Check your browser…" message
//   3. Signed in    → avatar + username chip with a dropdown to sign out
//
// Uses useMarketplaceAuth() exclusively for all state + actions.
// Uses OverlayPanel from the shared overlay system for the sign-out popover.

import React, { useRef, useState, useEffect, useCallback } from 'react';
import { useMarketplaceAuth } from '../../state/marketplace-auth-context';
import { Scrim, OverlayPanel } from '../overlays/Overlay';

// Inline GitHub mark SVG — avoids adding a file dependency
function GitHubMark({ size = 16 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      className="shrink-0"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export default function SignInButton() {
  const { signedIn, user, signInPending, startSignIn, signOut } = useMarketplaceAuth();

  // Controls the signed-in user dropdown popover
  const [popoverOpen, setPopoverOpen] = useState(false);

  // Close popover on Escape
  useEffect(() => {
    if (!popoverOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPopoverOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [popoverOpen]);

  const handleSignOut = useCallback(async () => {
    setPopoverOpen(false);
    await signOut();
  }, [signOut]);

  // ── Signed out ──────────────────────────────────────────────────────────────
  if (!signedIn && !signInPending) {
    return (
      <button
        onClick={() => void startSignIn()}
        className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-full border border-edge text-fg-muted hover:text-fg hover:border-edge transition-colors"
      >
        <GitHubMark size={13} />
        Sign in
      </button>
    );
  }

  // ── Pending (device-code flow in progress) ──────────────────────────────────
  // Future enhancement: surface user_code here if the auth context exposes it.
  // Currently MarketplaceAuthProvider holds device_code internally (poll loop)
  // but does not surface user_code to consumers. Once it does, render:
  //   {userCode && <span className="font-mono tracking-widest">{userCode}</span>}
  if (signInPending) {
    return (
      <button
        disabled
        className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-full border border-edge text-fg-faint opacity-70 cursor-not-allowed"
      >
        <GitHubMark size={13} />
        Check your browser…
      </button>
    );
  }

  // ── Signed in — user chip + dropdown ───────────────────────────────────────
  return (
    <div className="relative">
      <button
        onClick={() => setPopoverOpen(prev => !prev)}
        className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium rounded-full border border-edge hover:border-accent text-fg transition-colors"
        aria-haspopup="true"
        aria-expanded={popoverOpen}
      >
        {/* Avatar */}
        {user?.avatar_url ? (
          <img
            src={user.avatar_url}
            alt={user.login}
            className="w-4 h-4 rounded-full shrink-0 object-cover"
          />
        ) : (
          <span className="w-4 h-4 rounded-full bg-accent/30 shrink-0 flex items-center justify-center text-[8px] text-accent font-bold">
            {user?.login?.charAt(0)?.toUpperCase() ?? '?'}
          </span>
        )}
        <span className="max-w-[80px] truncate">{user?.login ?? 'Signed in'}</span>
        {/* Caret */}
        <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" aria-hidden="true" className="text-fg-muted shrink-0">
          <path d="M1 2.5L4 5.5L7 2.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {/* Sign-out popover */}
      {popoverOpen && (
        <>
          {/* Transparent scrim to close on outside click */}
          <Scrim layer={2} onClick={() => setPopoverOpen(false)} style={{ background: 'transparent' }} />
          <OverlayPanel
            layer={2}
            className="absolute right-0 top-full mt-1 min-w-[140px] rounded-lg p-1"
          >
            {/* User info row */}
            {user && (
              <div className="px-2 py-1.5 text-[10px] text-fg-muted border-b border-edge-dim mb-1">
                Signed in as <span className="font-semibold text-fg">{user.login}</span>
              </div>
            )}
            <button
              onClick={() => void handleSignOut()}
              className="w-full text-left px-2 py-1.5 text-[11px] text-fg-muted hover:text-fg hover:bg-inset rounded-md transition-colors"
            >
              Sign out
            </button>
          </OverlayPanel>
        </>
      )}
    </div>
  );
}
