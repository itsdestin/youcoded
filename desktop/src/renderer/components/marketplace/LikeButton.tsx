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
//   - Signed out:   shows tooltip on hover; click shows inline toast, skips API call
//   - Signed in:    flips state immediately (optimistic), calls window.claude.marketplaceApi.likeTheme()
//       ok + liked:true   → reconcile, increment count
//       ok + liked:false  → reconcile, decrement count (backend toggled back)
//       err 401           → revert, show "Sign in to like themes"
//       err other         → revert, show "Couldn't like theme — try again"
//   - Disables button during in-flight request to prevent double-clicks

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useMarketplaceAuth } from '../../state/marketplace-auth-context';

// ── Mini local toast (no global toast context available inside the modal) ──────

function useLocalToast() {
  const [message, setMessage] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setMessage(msg);
    timerRef.current = setTimeout(() => setMessage(null), 3000);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { toastMessage: message, showToast };
}

// ── Heart SVG icons ───────────────────────────────────────────────────────────

function HeartFilled({ size = 14 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
    >
      <path d="M8 14.25l-.345-.666C3.5 9.402 1 7.16 1 4.5a3.5 3.5 0 0 1 5.5-2.878A3.5 3.5 0 0 1 15 4.5c0 2.66-2.5 4.902-6.655 9.084L8 14.25z" />
    </svg>
  );
}

function HeartOutline({ size = 14 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
    >
      <path d="M8 14.25l-.345-.666C3.5 9.402 1 7.16 1 4.5a3.5 3.5 0 0 1 5.5-2.878A3.5 3.5 0 0 1 15 4.5c0 2.66-2.5 4.902-6.655 9.084L8 14.25z" />
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
  const { signedIn } = useMarketplaceAuth();

  const [liked, setLiked] = useState(initialLiked);
  const [count, setCount] = useState(initialCount);
  const [inFlight, setInFlight] = useState(false);

  const { toastMessage, showToast } = useLocalToast();

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

    // Signed-out guard: show feedback but don't call the API
    if (!signedIn) {
      showToast('Sign in to like themes');
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
          showToast('Sign in to like themes');
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
      <button
        onClick={handleClick}
        disabled={inFlight}
        title={title}
        aria-label={liked ? `Unlike (${count})` : `Like (${count})`}
        aria-pressed={liked}
        className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium transition-colors disabled:opacity-50 ${
          liked
            ? 'text-red-400 hover:text-red-300'
            : 'text-fg-muted hover:text-red-400'
        }`}
      >
        {liked ? <HeartFilled size={12} /> : <HeartOutline size={12} />}
        <span>{count > 0 ? count : ''}</span>
      </button>

      {/* Inline toast — shown briefly on error or signed-out click */}
      {toastMessage && (
        <div
          role="status"
          aria-live="polite"
          className="absolute bottom-full right-0 mb-1 whitespace-nowrap px-2 py-1 rounded-md bg-panel border border-edge text-[10px] text-fg shadow-md"
          // zIndex 62 = one above CONTENT_Z[2] (61, L2 content). The toast anchors inline
          // beside the button inside an OverlayPanel, so it needs to clear the panel's
          // own surface. Not L3 (70) — destructive confirmations only. Not using the
          // layer primitives because this is an ephemeral position:absolute sibling,
          // not a full overlay surface.
          style={{ zIndex: 62 }}
        >
          {toastMessage}
        </div>
      )}
    </div>
  );
}
