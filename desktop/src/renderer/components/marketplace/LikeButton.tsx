// LikeButton.tsx
// Heart icon toggle for themes. Optimistic update with server reconciliation.
//
// Props:
//   themeId       — slug/id passed to the API
//   initialLiked  — local starting state (default false; backend doesn't currently
//                   expose per-user liked state so this is best-effort)
//   initialCount  — like count from useMarketplaceStats().themes[themeId]?.likes ?? 0
//
// Behavior:
//   - Signed out:   click opens SignInPromptModal with "Sign in to YouCoded" CTA.
//                   Used to be a silent inline toast that was easy to miss and had
//                   no way to actually start the sign-in flow.
//   - Signed in:    flips state immediately (optimistic), calls window.claude.marketplaceApi.likeTheme()
//       ok + liked:true   → reconcile, increment count
//       ok + liked:false  → reconcile, decrement count (backend toggled back)
//       err 401           → revert, open SignInPromptModal (token was rejected)
//       err other         → revert, show "Couldn't like theme — try again" toast
//   - Disables button during in-flight request to prevent double-clicks

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useAccount } from '../../state/account-context';
import SignInPromptModal from './SignInPromptModal';
import { Button, Toast } from '../ui';

// ── Local toast state (no global toast context available inside the modal) ────
//
// Change 44: this used to be a whole hand-rolled toast — its own setTimeout, its
// own unmount cleanup, its own bg-panel/border/shadow at text-3xs, and its own
// z-index. The <Toast> primitive owns all of that now, so what is left here is
// just "which message, if any". The `nonce` exists because the primitive re-arms
// its timer when the MESSAGE changes: both call sites below show the same string,
// so without it a second failure inside the 3s window would inherit whatever was
// left of the first one's timer instead of getting a fresh read.

function useLocalToast() {
  const [toast, setToast] = useState<{ message: string; nonce: number } | null>(null);
  const showToast = useCallback((message: string) => {
    setToast((prev) => ({ message, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  return { toast, showToast, clearToast: useCallback(() => setToast(null), []) };
}

// ── Heart icon ────────────────────────────────────────────────────────────────
// WHY redrawn (marketplace-detail-1#MD-7, Destin: "the heart svg just isn't really a
// heart"): the old 16-unit path's second arc ended at (15, 4.5) instead of mirroring the
// first lobe, so the right half was flattened and the point sat off-centre — at 12px it
// read as a lopsided blob. This is the standard symmetric 24-unit heart (the same drawing
// as the Feather/Lucide sets), on the same 24 grid and stroke weight as the star and share
// icons it sits beside. Filled = liked.
function HeartIcon({ filled, size = 16 }: { filled: boolean; size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}

// ── LikeButton ────────────────────────────────────────────────────────────────

interface LikeButtonProps {
  themeId: string;
  initialLiked?: boolean;
  initialCount: number;
}

export default function LikeButton({ themeId, initialLiked = false, initialCount }: LikeButtonProps) {
  const { signedIn } = useAccount();

  const [liked, setLiked] = useState(initialLiked);
  const [count, setCount] = useState(initialCount);
  const [inFlight, setInFlight] = useState(false);
  // Signed-out users get a real modal CTA instead of a fly-by toast — the toast
  // had no actual sign-in button and was widely missed.
  const [signInPromptOpen, setSignInPromptOpen] = useState(false);

  const { toast, showToast, clearToast } = useLocalToast();

  // cancelledRef — prevents setState after unmount if a slow API call returns late
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => { cancelledRef.current = true; };
  }, []);

  // Sync external count updates (stats-context loading late) into local state.
  // Skip while a like is in flight so we don't clobber the optimistic +/-1 delta.
  useEffect(() => {
    if (!inFlight) setCount(initialCount);
  }, [initialCount, inFlight]);

  // Note: initialLiked is NOT synced here intentionally. The backend doesn't expose
  // per-user liked state today, so initialLiked is always undefined → false. Adding
  // a sync effect for it would cause a re-render storm on every stats reload with no
  // benefit. Revisit when the backend exposes per-user liked state.

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    // Stop click from bubbling up to MarketplaceCard's onClick (which opens detail)
    e.stopPropagation();

    // Signed-out guard: open the sign-in prompt modal instead of the API call.
    // The prompt has an actual "Sign in to YouCoded" button that kicks off the
    // device-code OAuth flow.
    if (!signedIn) {
      setSignInPromptOpen(true);
      return;
    }

    if (inFlight) return;

    // ── Optimistic update ─────────────────────────────────────────────────────
    const prevLiked = liked;
    const prevCount = count;
    const nextLiked = !liked;
    const nextCount = nextLiked ? count + 1 : count - 1;

    setLiked(nextLiked);
    setCount(Math.max(0, nextCount));
    setInFlight(true);

    try {
      const res = await window.claude.marketplaceApi.likeTheme(themeId);

      if (cancelledRef.current) return;

      if (res.ok) {
        // Reconcile with server: server is authoritative on the final liked state
        const serverLiked = res.value.liked;
        setLiked(serverLiked);
        // Adjust count based on reconciliation vs. our optimistic prediction
        if (serverLiked !== nextLiked) {
          // Server toggled differently than we predicted (unusual but possible)
          setCount(serverLiked ? prevCount + 1 : Math.max(0, prevCount - 1));
        }
        // If server matches our prediction, count is already correct — no update needed
      } else {
        // API error — revert optimistic update
        setLiked(prevLiked);
        setCount(prevCount);

        if (res.status === 401) {
          // Server rejected our token (expired/revoked) — surface the prompt
          // modal so the user can re-auth without hunting for the chip.
          setSignInPromptOpen(true);
        } else {
          showToast("Couldn't like theme — try again");
        }
      }
    } catch {
      // Network or unexpected error — revert
      if (cancelledRef.current) return;
      setLiked(prevLiked);
      setCount(prevCount);
      showToast("Couldn't like theme — try again");
    } finally {
      if (!cancelledRef.current) setInFlight(false);
    }
  }, [signedIn, inFlight, liked, count, themeId, showToast]);

  // ── Tooltip for signed-out state (shown on hover via title attribute) ────────
  const title = !signedIn ? 'Sign in to like themes' : liked ? 'Unlike' : 'Like';

  return (
    <div className="relative">
      {/* WHY the shared ghost button (guide "Control primitives"): it sits beside the star
          and share icon buttons, so it is their height and hover; the count is the word-
          then-number style. Liked is the accent fill like the favourite star — not red
          text (status hues never colour words; guide principle 2). */}
      <Button
        variant="ghost"
        size="sm"
        onClick={handleClick}
        disabled={inFlight}
        title={title}
        aria-label={liked ? `Unlike (${count})` : `Like (${count})`}
        aria-pressed={liked}
        className={`h-7 px-1.5 text-xs ${liked ? 'text-accent' : ''}`}
      >
        <HeartIcon filled={liked} />
        {count > 0 && <span>{count}</span>}
      </Button>

      {/* Inline toast — shown briefly on non-auth errors only. Auth errors now
          open the SignInPromptModal below instead of using this toast.

          Change 44: the `anchored` variant IS this site — the primitive was built
          with it in mind. The hand-rolled `zIndex: 62` is gone with it: that
          number was reverse-engineered from CONTENT_Z[2] + 1 to clear the parent
          OverlayPanel, which is exactly the kind of magic z-index design rule 11
          exists to stop. It also grows text-3xs -> text-sm, matching every other
          toast in the app instead of being a third size. */}
      {toast && (
        <Toast
          key={toast.nonce}
          variant="anchored"
          tone="error"
          message={toast.message}
          onDismiss={clearToast}
        />
      )}

      <SignInPromptModal
        open={signInPromptOpen}
        onClose={() => setSignInPromptOpen(false)}
        title="Sign in to like themes"
        message="Liking themes lets the community see what's popular. Sign in with your GitHub account to like this and other themes."
      />
    </div>
  );
}
