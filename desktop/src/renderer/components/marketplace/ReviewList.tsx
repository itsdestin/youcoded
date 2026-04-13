// ReviewList.tsx
// Fetches and renders the list of user reviews for a marketplace plugin.
//
// Props:
//   pluginId    — plugin to fetch reviews for
//   refreshKey  — bump this number to re-fetch (e.g. after a new rating is submitted)
//
// Behavior:
//   - Fetches via apiClient.listRatings() on mount and whenever refreshKey changes
//   - Loading state while fetching
//   - Empty state: "No reviews yet — be the first"
//   - Error state: "Couldn't load reviews" (no auto-retry)
//   - Populated: avatar (24px circular), login, stars (hideCount), optional review text, date
//   - React auto-escapes text content so review_text is XSS-safe as written
//   - AbortController cancels the in-flight fetch on unmount or refreshKey change

import React, { useEffect, useRef, useState } from 'react';
import {
  createMarketplaceApiClient,
  MARKETPLACE_API_HOST,
  type RatingEntry,
} from '../../state/marketplace-api-client';
import StarRating from './StarRating';

// Unauthenticated client — listRatings is a public endpoint
const apiClient = createMarketplaceApiClient({
  host: MARKETPLACE_API_HOST,
  getToken: () => null,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Format a Unix-seconds timestamp as a locale date string (e.g. "April 12, 2026"). */
function formatDate(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

// ── Single review row ─────────────────────────────────────────────────────────

function ReviewRow({ r }: { r: RatingEntry }) {
  return (
    <div className="flex flex-col gap-1 py-3 border-b border-edge-dim last:border-0">
      {/* Author row: avatar + login + stars + date */}
      <div className="flex items-center gap-2">
        {/* Avatar — 24px circular */}
        {r.user_avatar_url ? (
          <img
            src={r.user_avatar_url}
            alt={r.user_login}
            className="w-6 h-6 rounded-full shrink-0 object-cover"
          />
        ) : (
          // Fallback initials circle when avatar URL is absent
          <span className="w-6 h-6 rounded-full bg-accent/20 shrink-0 flex items-center justify-center text-[9px] font-bold text-accent">
            {r.user_login.charAt(0).toUpperCase()}
          </span>
        )}
        <span className="text-xs font-medium text-fg">{r.user_login}</span>
        {/* StarRating with hideCount=true — individual review rows don't need "(1)" */}
        {/* count=1: each row represents one review; hideCount suppresses the "(1)" suffix */}
        <StarRating value={r.stars} count={1} size="sm" hideCount />
        <span className="ml-auto text-[10px] text-fg-faint shrink-0">{formatDate(r.created_at)}</span>
      </div>

      {/* Review text — React auto-escapes this, so XSS-safe */}
      {r.review_text && (
        <p className="text-xs text-fg-dim leading-relaxed whitespace-pre-wrap pl-8">
          {r.review_text}
        </p>
      )}
    </div>
  );
}

// ── ReviewList ────────────────────────────────────────────────────────────────

interface ReviewListProps {
  pluginId: string;
  /**
   * Bump to re-fetch (e.g. after the user submits a new rating).
   * The initial value (undefined or 0) triggers the first fetch on mount.
   */
  refreshKey?: number;
}

type FetchState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'loaded'; ratings: RatingEntry[] }
  | { status: 'error' };

export default function ReviewList({ pluginId, refreshKey = 0 }: ReviewListProps) {
  const [state, setState] = useState<FetchState>({ status: 'loading' });

  useEffect(() => {
    setState({ status: 'loading' });

    // AbortController to cancel on unmount or refreshKey/pluginId change
    const controller = new AbortController();
    let cancelled = false;

    // Pass the signal so fetch is actually cancelled on unmount/refreshKey change —
    // the `cancelled` boolean alone guards setState but leaves the network request running.
    apiClient.listRatings(pluginId, controller.signal)
      .then(({ ratings }) => {
        if (cancelled) return;
        setState(
          ratings.length === 0
            ? { status: 'empty' }
            : { status: 'loaded', ratings }
        );
      })
      .catch((err: unknown) => {
        // AbortError is intentional (unmount or refreshKey change) — don't surface as an error.
        if (cancelled || (err instanceof Error && err.name === 'AbortError')) return;
        setState({ status: 'error' });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [pluginId, refreshKey]);

  return (
    <div>
      <h4 className="text-xs font-semibold text-fg-muted uppercase tracking-wide mb-2">
        Reviews
      </h4>

      {state.status === 'loading' && (
        <p className="text-xs text-fg-faint">Loading reviews…</p>
      )}

      {state.status === 'empty' && (
        <p className="text-xs text-fg-muted">No reviews yet — be the first.</p>
      )}

      {state.status === 'error' && (
        <p className="text-xs text-red-400">Couldn't load reviews.</p>
      )}

      {state.status === 'loaded' && (
        <div>
          {state.ratings.map(r => (
            <ReviewRow key={r.id} r={r} />
          ))}
        </div>
      )}
    </div>
  );
}
