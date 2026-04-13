// RatingSubmitModal.tsx
// Modal for submitting a star rating + optional review text for a marketplace plugin.
//
// Props:
//   pluginId   — the plugin to rate
//   open       — whether the modal is visible
//   onClose()  — called when the modal is dismissed (cancel, Escape, or after success)
//   onSubmitted?() — fired after a successful submission so the parent can refresh ReviewList
//
// Flow:
//   1. If not signed in: shows a "sign in to rate" message with a sign-in button (no form)
//   2. Signed in: interactive 5-star picker + optional textarea (500-char limit) + Submit
//   3. 403 install-gate → show "Install and rate" button (calls install, then retries rate)
//   4. 429 rate-limit → inline message
//   5. Other error → inline message
//   6. Success → refresh stats, close modal, fire onSubmitted
//
// Errors surface inline — no global toast needed.

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
} from 'react';
import { Scrim, OverlayPanel } from '../overlays/Overlay';
import { useMarketplaceAuth } from '../../state/marketplace-auth-context';
import { useMarketplaceStats } from '../../state/marketplace-stats-context';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_REVIEW_CHARS = 500;

// ── Interactive star picker ───────────────────────────────────────────────────
// Distinct from the read-only StarRating component — these stars are clickable buttons.

interface StarPickerProps {
  value: number | null;
  onChange(stars: number): void;
}

function StarPicker({ value, onChange }: StarPickerProps) {
  const [hovered, setHovered] = useState<number | null>(null);

  return (
    <div
      className="flex gap-1"
      role="radiogroup"
      aria-label="Star rating"
    >
      {[1, 2, 3, 4, 5].map((n) => {
        const active = hovered !== null ? n <= hovered : value !== null ? n <= value : false;
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n} star${n > 1 ? 's' : ''}`}
            onClick={() => onChange(n)}
            onMouseEnter={() => setHovered(n)}
            onMouseLeave={() => setHovered(null)}
            // Star colors: filled = amber, empty = faint — theme-driven via text-* tokens
            className={`text-2xl leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm ${
              active ? 'text-[#f0ad4e]' : 'text-fg-faint'
            }`}
          >
            {active ? '\u2605' : '\u2606'}
          </button>
        );
      })}
    </div>
  );
}

// ── Modal ─────────────────────────────────────────────────────────────────────

interface RatingSubmitModalProps {
  pluginId: string;
  open: boolean;
  onClose(): void;
  onSubmitted?(): void;
}

export default function RatingSubmitModal({
  pluginId,
  open,
  onClose,
  onSubmitted,
}: RatingSubmitModalProps) {
  const { signedIn, startSignIn } = useMarketplaceAuth();
  const { refresh: refreshStats } = useMarketplaceStats();

  const [stars, setStars] = useState<number | null>(null);
  const [reviewText, setReviewText] = useState('');
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 'install-gate' triggers the one-click install-then-rate affordance
  const [installGate, setInstallGate] = useState(false);
  const [installing, setInstalling] = useState(false);
  // isOfflineError — true when the last submit failed due to network unavailability
  const [isOfflineError, setIsOfflineError] = useState(false);

  // cancelledRef — prevent setState after unmount for any async chain
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => { cancelledRef.current = true; };
  }, []);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // Reset form state whenever the modal opens for a new session.
  // inFlight and installing are also reset here so that a close+reopen while a
  // previous submit was mid-flight doesn't leave the button permanently disabled.
  useEffect(() => {
    if (open) {
      setStars(null);
      setReviewText('');
      setError(null);
      setInstallGate(false);
      setInFlight(false);
      setInstalling(false);
      setIsOfflineError(false);
    }
  }, [open]);

  // ── Submission ──────────────────────────────────────────────────────────────

  const doRate = useCallback(async (selectedStars: number) => {
    const res = await window.claude.marketplaceApi.rate({
      plugin_id: pluginId,
      // stars is guaranteed 1-5 by the picker; cast to satisfy the union type
      stars: selectedStars as 1 | 2 | 3 | 4 | 5,
      review_text: reviewText.trim() || undefined,
    });
    return res;
  }, [pluginId, reviewText]);

  const handleSubmit = useCallback(async () => {
    if (!stars || inFlight) return;
    setInFlight(true);
    setError(null);
    setInstallGate(false);
    setIsOfflineError(false);

    try {
      const res = await doRate(stars);

      if (cancelledRef.current) return;

      if (res.ok) {
        // Refresh the stats context so cards + detail update live
        void refreshStats();
        onClose();
        onSubmitted?.();
      } else if (res.status === 403) {
        // Install-gate: must install the plugin first before rating
        setInstallGate(true);
      } else if (res.status === 429) {
        setError("You've rated too many plugins in the last hour. Try again shortly.");
      } else {
        console.error('[RatingSubmitModal] rate error:', res);
        setError(`Couldn't submit rating: ${res.message ?? 'Unknown error'}`);
      }
    } catch (err) {
      if (cancelledRef.current) return;
      console.error('[RatingSubmitModal] network error:', err);
      // Detect offline / network errors — TypeError covers fetch failures
      // (e.g. "Failed to fetch", "NetworkError", "Load failed")
      const isOffline = err instanceof TypeError;
      if (isOffline) {
        setIsOfflineError(true);
        setError("Offline — your rating wasn't submitted. Try again when you're back online.");
      } else {
        setError('Network error — try again.');
      }
    } finally {
      if (!cancelledRef.current) setInFlight(false);
    }
  }, [stars, inFlight, doRate, refreshStats, onClose, onSubmitted]);

  // Install-gate one-click flow: install the plugin then retry the rating.
  // The user sees a clear "Install and rate" button — no silent installs.
  const handleInstallAndRate = useCallback(async () => {
    if (!stars || installing) return;
    setInstalling(true);
    setError(null);

    try {
      const installRes = await window.claude.marketplaceApi.install(pluginId);

      if (cancelledRef.current) return;

      if (!installRes.ok) {
        // Install failed — don't auto-retry rating; show a clear message
        setInstallGate(false);
        setError('Install this plugin first to rate it.');
        return;
      }

      // Install succeeded — retry the rating
      const rateRes = await doRate(stars);

      if (cancelledRef.current) return;

      if (rateRes.ok) {
        void refreshStats();
        onClose();
        onSubmitted?.();
      } else {
        setInstallGate(false);
        setError(`Couldn't submit rating after install: ${rateRes.message ?? 'Unknown error'}`);
      }
    } catch (err) {
      if (cancelledRef.current) return;
      setInstallGate(false);
      setError('Network error — try again.');
    } finally {
      if (!cancelledRef.current) setInstalling(false);
    }
  }, [stars, installing, pluginId, doRate, refreshStats, onClose, onSubmitted]);

  if (!open) return null;

  const submitDisabled = !signedIn || !stars || inFlight;

  return (
    <>
      {/* Scrim — clicking outside closes the modal */}
      <Scrim layer={2} onClick={onClose} />

      {/* Modal panel — centered */}
      <OverlayPanel
        layer={2}
        role="dialog"
        aria-modal
        aria-labelledby="rate-modal-title"
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-sm rounded-xl p-5"
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 id="rate-modal-title" className="text-sm font-semibold text-fg">
            Rate this plugin
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-fg-muted hover:text-fg transition-colors leading-none text-lg"
          >
            &times;
          </button>
        </div>

        {/* Body */}
        {!signedIn ? (
          // ── Signed-out state ────────────────────────────────────────────────
          <div className="flex flex-col items-center gap-3 py-2">
            <p className="text-sm text-fg-muted text-center">
              Sign in with GitHub to rate this plugin.
            </p>
            <button
              onClick={() => void startSignIn()}
              className="px-4 py-1.5 text-sm font-medium rounded-lg bg-accent text-on-accent hover:brightness-110 transition-colors"
            >
              Sign in with GitHub
            </button>
          </div>
        ) : (
          // ── Signed-in form ──────────────────────────────────────────────────
          <div className="flex flex-col gap-4">
            {/* Star picker */}
            <div>
              <label className="block text-xs font-medium text-fg-muted mb-2">
                Your rating
              </label>
              <StarPicker value={stars} onChange={setStars} />
            </div>

            {/* Optional review textarea */}
            <div>
              <label
                htmlFor="review-text"
                className="block text-xs font-medium text-fg-muted mb-1"
              >
                Review <span className="text-fg-faint">(optional)</span>
              </label>
              <textarea
                id="review-text"
                value={reviewText}
                onChange={e => setReviewText(e.target.value.slice(0, MAX_REVIEW_CHARS))}
                rows={3}
                maxLength={MAX_REVIEW_CHARS}
                placeholder="Share your experience with this plugin…"
                className="w-full rounded-lg bg-inset border border-edge text-sm text-fg placeholder:text-fg-faint resize-none px-3 py-2 focus:outline-none focus:ring-1 focus:ring-accent"
              />
              {/* Character counter — shows remaining only when text is present */}
              {reviewText.length > 0 && (
                <p className="text-right text-[10px] text-fg-faint mt-0.5">
                  {reviewText.length}/{MAX_REVIEW_CHARS}
                </p>
              )}
            </div>

            {/* Inline error message — offline errors get a Retry button */}
            {error && (
              <div className="-mt-1">
                <p role="alert" className="text-xs text-red-400">
                  {error}
                </p>
                {/* Retry button — only shown for offline errors; replays the last submit */}
                {isOfflineError && (
                  <button
                    onClick={() => void handleSubmit()}
                    disabled={inFlight}
                    className="mt-1.5 text-xs font-medium text-accent hover:underline disabled:opacity-50"
                  >
                    Retry
                  </button>
                )}
              </div>
            )}

            {/* Install-gate affordance — clear labeling, not a surprise install */}
            {installGate && !error && (
              <div className="rounded-lg bg-inset border border-edge/60 p-3 flex flex-col gap-2">
                <p className="text-xs text-fg-muted">
                  You need to install this plugin before you can rate it.
                </p>
                <button
                  onClick={() => void handleInstallAndRate()}
                  disabled={installing}
                  className="self-start px-3 py-1.5 text-xs font-medium rounded-lg bg-accent text-on-accent hover:brightness-110 transition-colors disabled:opacity-50"
                >
                  {installing ? 'Installing…' : 'Install and rate'}
                </button>
              </div>
            )}

            {/* Submit row */}
            {!installGate && (
              <div className="flex justify-end gap-2">
                <button
                  onClick={onClose}
                  className="px-3 py-1.5 text-sm text-fg-muted hover:text-fg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void handleSubmit()}
                  disabled={submitDisabled}
                  aria-disabled={submitDisabled}
                  className="px-4 py-1.5 text-sm font-medium rounded-lg bg-accent text-on-accent hover:brightness-110 transition-colors disabled:opacity-50"
                >
                  {inFlight ? 'Submitting…' : 'Submit rating'}
                </button>
              </div>
            )}
          </div>
        )}
      </OverlayPanel>
    </>
  );
}
