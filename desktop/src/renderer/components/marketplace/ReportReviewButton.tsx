// ReportReviewButton.tsx
// Small flag-icon button on each review row. Clicking opens a confirmation dialog
// with an optional reason textarea, then submits to /reports via the marketplace API.
//
// Props:
//   ratingUserId   — the user_id of the review being reported
//   pluginId       — the plugin the review belongs to
//   reviewerLogin  — display name used in aria-label (falls back to "reviewer")
//
// Behavior:
//   - Signed out:   tooltip on click; no API call (same pattern as LikeButton)
//   - Signed in:    opens confirmation dialog (Scrim + OverlayPanel at layer 2)
//   - Submit flow:
//       ok:true     → "Report submitted" shown in-place ~2s, then dialog closes
//       ok:false 429 → inline rate-limit message, dialog stays open
//       other error → inline "Couldn't submit report", dialog stays open
//       exception   → same as other errors (non-blocking per plan)
//   - cancelledRef guards any setState after async awaits against unmount races

import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
} from 'react';
import { Scrim, OverlayPanel } from '../overlays/Overlay';
import { useMarketplaceAuth } from '../../state/marketplace-auth-context';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_REASON_CHARS = 300;

// ── Flag icon SVG ─────────────────────────────────────────────────────────────

function FlagIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
    >
      {/* Simple triangular flag path */}
      <path d="M3 2a.5.5 0 0 1 .5-.5h.5v12.5a.5.5 0 0 1-1 0V2zm1.5-.5a.5.5 0 0 1 .354.146L13 9l-8.146 7.354A.5.5 0 0 1 4 16V1.5a.5.5 0 0 1 .5-.5zm0 1.207V14.5L12 9 5 2.707z" />
    </svg>
  );
}

// ── Mini local toast (same pattern as LikeButton) ─────────────────────────────

function useLocalToast() {
  const [message, setMessage] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setMessage(msg);
    timerRef.current = setTimeout(() => setMessage(null), 3000);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { toastMessage: message, showToast };
}

// ── Confirmation dialog ───────────────────────────────────────────────────────

type DialogState =
  | { phase: 'idle' }
  | { phase: 'submitting' }
  | { phase: 'success' }
  | { phase: 'error'; message: string };

interface ReportDialogProps {
  reviewerLogin?: string;
  onClose(): void;
  onSubmit(reason: string): Promise<void>;
}

function ReportDialog({ reviewerLogin, onClose, onSubmit }: ReportDialogProps) {
  const [reason, setReason] = useState('');
  const [dialogState, setDialogState] = useState<DialogState>({ phase: 'idle' });

  // cancelledRef — guard setState after async awaits against unmount races
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => { cancelledRef.current = true; };
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleSubmit = useCallback(async () => {
    if (dialogState.phase === 'submitting') return;
    setDialogState({ phase: 'submitting' });

    try {
      await onSubmit(reason.trim());

      if (cancelledRef.current) return;

      // Success: show confirmation briefly, then close
      setDialogState({ phase: 'success' });
      setTimeout(() => {
        if (!cancelledRef.current) onClose();
      }, 2000);
    } catch (err: unknown) {
      if (cancelledRef.current) return;
      // onSubmit re-throws specific error messages for 429 vs generic
      const msg = err instanceof Error ? err.message : "Couldn't submit report";
      setDialogState({ phase: 'error', message: msg });
    }
  }, [dialogState.phase, reason, onSubmit, onClose]);

  const inFlight = dialogState.phase === 'submitting';
  const displayName = reviewerLogin ?? 'reviewer';

  return (
    <>
      {/* Scrim — clicking outside closes the dialog */}
      <Scrim layer={2} onClick={onClose} />

      {/* Dialog panel — centered */}
      <OverlayPanel
        layer={2}
        role="dialog"
        aria-modal
        aria-labelledby="report-dialog-title"
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-sm rounded-xl p-5"
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 id="report-dialog-title" className="text-sm font-semibold text-fg">
            Report this review?
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-fg-muted hover:text-fg transition-colors leading-none text-lg"
          >
            &times;
          </button>
        </div>

        {/* Success state */}
        {dialogState.phase === 'success' ? (
          <div className="py-4 flex flex-col items-center gap-2">
            <p role="status" aria-live="polite" className="text-sm text-fg-muted text-center">
              Report submitted. Thank you for helping keep the marketplace clean.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* Body copy */}
            <p className="text-xs text-fg-dim">
              Reports help keep the marketplace clean. Abusive reports may restrict your account.
            </p>

            {/* Optional reason textarea */}
            <div>
              <label
                htmlFor="report-reason"
                className="block text-xs font-medium text-fg-muted mb-1"
              >
                Reason <span className="text-fg-faint">(optional)</span>
              </label>
              <textarea
                id="report-reason"
                value={reason}
                onChange={e => setReason(e.target.value.slice(0, MAX_REASON_CHARS))}
                rows={3}
                maxLength={MAX_REASON_CHARS}
                placeholder={`Why are you reporting ${displayName}'s review?`}
                disabled={inFlight}
                className="w-full rounded-lg bg-inset border border-edge text-sm text-fg placeholder:text-fg-faint resize-none px-3 py-2 focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
              />
              {/* Character counter — shows remaining when text is present */}
              {reason.length > 0 && (
                <p className="text-right text-[10px] text-fg-faint mt-0.5">
                  {reason.length}/{MAX_REASON_CHARS}
                </p>
              )}
            </div>

            {/* Inline error message */}
            {dialogState.phase === 'error' && (
              <p role="alert" className="text-xs text-red-400 -mt-1">
                {dialogState.message}
              </p>
            )}

            {/* Action row */}
            <div className="flex justify-end gap-2">
              <button
                onClick={onClose}
                disabled={inFlight}
                className="px-3 py-1.5 text-sm text-fg-muted hover:text-fg transition-colors disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleSubmit()}
                disabled={inFlight}
                aria-disabled={inFlight}
                // Use --destructive token via Tailwind's text-[var(...)] pattern so the
                // submit button signals severity without hard-coding a hex color.
                className="px-4 py-1.5 text-sm font-medium rounded-lg border border-[color:var(--destructive,theme(colors.red.500))] text-[color:var(--destructive,theme(colors.red.500))] hover:bg-[color:var(--destructive,theme(colors.red.500))]/10 transition-colors disabled:opacity-50"
              >
                {inFlight ? 'Submitting…' : 'Report review'}
              </button>
            </div>
          </div>
        )}
      </OverlayPanel>
    </>
  );
}

// ── ReportReviewButton ────────────────────────────────────────────────────────

interface ReportReviewButtonProps {
  ratingUserId: string;
  pluginId: string;
  reviewerLogin?: string;
}

export default function ReportReviewButton({
  ratingUserId,
  pluginId,
  reviewerLogin,
}: ReportReviewButtonProps) {
  const { signedIn } = useMarketplaceAuth();
  const [dialogOpen, setDialogOpen] = useState(false);
  const { toastMessage, showToast } = useLocalToast();

  const handleButtonClick = useCallback((e: React.MouseEvent) => {
    // Prevent the click from bubbling up to any parent card click handlers
    e.stopPropagation();

    if (!signedIn) {
      showToast('Sign in to report reviews');
      return;
    }

    setDialogOpen(true);
  }, [signedIn, showToast]);

  // onSubmit is called by ReportDialog — throws specific error messages for dialog to display
  const handleSubmit = useCallback(async (reason: string) => {
    let res: Awaited<ReturnType<typeof window.claude.marketplaceApi.report>>;
    try {
      res = await window.claude.marketplaceApi.report({
        rating_user_id: ratingUserId,
        rating_plugin_id: pluginId,
        reason: reason || undefined,
      });
    } catch (err) {
      // Network/unexpected error — non-blocking per plan; surface as generic message
      console.error('[ReportReviewButton] network error:', err);
      throw new Error("Couldn't submit report");
    }

    if (res.ok) {
      // Success — let ReportDialog handle the confirmation display
      return;
    }

    if (res.status === 429) {
      throw new Error("You've reported too many reviews — try again later");
    } else if (res.status === 401) {
      // Signed-out edge case — shouldn't reach here since we gate on signedIn
      throw new Error("Couldn't submit report");
    } else {
      // Other error — non-blocking, log it
      console.error('[ReportReviewButton] report error:', res);
      throw new Error("Couldn't submit report");
    }
  }, [ratingUserId, pluginId]);

  const ariaLabel = `Report review by ${reviewerLogin ?? 'reviewer'}`;

  return (
    <div className="relative">
      <button
        onClick={handleButtonClick}
        title={signedIn ? 'Report review' : 'Sign in to report reviews'}
        aria-label={ariaLabel}
        // Subtle flag icon: normally dim, shifts toward destructive color on hover
        // Uses --destructive token so theme drives the warning hue, not a hardcoded hex
        className="p-1 rounded text-fg-faint hover:text-[color:var(--destructive,theme(colors.red.400))] transition-colors"
      >
        <FlagIcon size={12} />
      </button>

      {/* Inline toast — shown briefly when clicking while signed out */}
      {toastMessage && (
        <div
          role="status"
          aria-live="polite"
          className="absolute bottom-full right-0 mb-1 whitespace-nowrap px-2 py-1 rounded-md bg-panel border border-edge text-[10px] text-fg shadow-md"
          // zIndex 62 = one above CONTENT_Z[2] (61, L2 content). Ephemeral
          // position:absolute sibling anchored beside the button — not a full
          // overlay surface so we don't use the layer primitives here.
          style={{ zIndex: 62 }}
        >
          {toastMessage}
        </div>
      )}

      {/* Confirmation dialog — rendered via portal-like pattern using fixed positioning */}
      {dialogOpen && (
        <ReportDialog
          reviewerLogin={reviewerLogin}
          onClose={() => setDialogOpen(false)}
          onSubmit={handleSubmit}
        />
      )}
    </div>
  );
}
