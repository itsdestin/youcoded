import React, { useEffect, useRef } from 'react';
import { OverlayPanel } from '../overlays/Overlay';
import { Button } from './Button';

/**
 * Transient feedback (change 44, §1.8).
 *
 * Replaces three uncoordinated systems: the App-global toast (hand-rolled
 * bg-panel/border-edge/shadow-lg with a manual setTimeout at EVERY call site),
 * LikeButton's local mini-toast (different size, radius, and z), and the
 * marketplace role="status" strips.
 *
 * The dismiss timer lives here on purpose — call sites kept re-implementing it,
 * and each one was a chance to leak a timer across unmount.
 *
 * Border/shadow/background all come from .layer-surface via OverlayPanel, which
 * also owns the z-index (design rule 11 — Overlay.tsx is the only z authority).
 */

export type ToastTone = 'default' | 'error';

/** A toast button. `primary` is the dark, leading one; the rest keep the
 *  toast action's original secondary style. Drawn left to right. */
export type ToastAction = { label: string; onClick: () => void; primary?: boolean };

export type ToastProps = {
  message: React.ReactNode;
  /** Optional single affordance (e.g. "Send anyway"). Rendered in a
   *  `pointer-events-auto` slot: the toast body stays click-through so it never
   *  swallows a click meant for the app underneath, but the one thing that IS
   *  meant to be clicked still is. Putting the action in `message` instead would
   *  inherit the body's pointer-events-none and render a dead button. */
  action?: React.ReactNode;
  /** Buttons drawn in the same click-through-safe slot (used when `action` is absent). */
  actions?: ToastAction[];
  onDismiss: () => void;
  tone?: ToastTone;
  /** global = centered above the input bar. anchored = pinned above its
   *  relatively-positioned parent (LikeButton). stacked = sits inside <FloatingNotices>' one column, which owns the
   *  fixed position, so two notices can never overlap. */
  variant?: 'global' | 'anchored' | 'stacked';
  /** Auto-dismiss delay. Pass null to require an explicit dismiss. */
  durationMs?: number | null;
  /** Adds an outlined Dismiss button, leftmost (Destin, waiting-notice deck K-7: "dismiss should be the leftmost
   *  button and not filled in. primary action should be filled rightmost button"). */
  dismissible?: boolean;
  /** Small muted words after the message ("1 more": others are waiting behind this one). */
  footnote?: string;
};

export function Toast({
  message,
  action,
  actions,
  onDismiss,
  tone = 'default',
  variant = 'global',
  durationMs = 3000,
  dismissible = false,
  footnote,
}: ToastProps) {
  // WHY a ref (the "waiting on something" notice that never went away, 2026-11-21): App passes a fresh
  // `() => setToast(null)` on every render, and with onDismiss in the timer's dependencies every App redraw
  // (many per second while a reply streams) restarted the countdown, so the notice could stay forever.
  // The timer now restarts only for a new message or duration; the ref still calls the latest onDismiss.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  useEffect(() => {
    if (durationMs == null) return;
    const id = setTimeout(() => onDismissRef.current(), durationMs);
    return () => clearTimeout(id);
    // Re-arm when the message changes so a second toast gets its own full
    // window rather than inheriting the first one's remaining time.
  }, [message, durationMs]);
  // Outlined buttons first, the filled main one last (Destin, K-7), whatever order the caller listed them in.
  const ordered = actions ? [...actions.filter((x) => !x.primary), ...actions.filter((x) => x.primary)] : [];

  return (
    <OverlayPanel
      layer={4}
      role="status"
      aria-live="polite"
      className={[
        'flex items-center gap-2 px-4 py-2 text-sm text-fg pointer-events-none',
        variant === 'stacked'
          // WHY (review 2, S2): the column around it is the fixed one; this just sizes to its words and wraps like the global one.
          ? 'relative flex-wrap gap-y-2 max-w-full'
          : variant === 'global'
          // WHY flex-wrap + the buttons' ml-auto (Destin, R3-6b: "with big notices like this, it would be a better use of space to
          // put the button under the text on the bottom right"): a short notice fits words + button on one line, button beside the
          // text as before. When the words alone fill the line (a long notice wraps), the buttons no longer fit beside them, so
          // they drop to their own row and ml-auto pushes them to the right. Pure layout, nothing is measured.
          ? 'fixed left-1/2 -translate-x-1/2 flex-wrap gap-y-2'
          : 'absolute bottom-full right-0 mb-1 whitespace-nowrap',
      ].join(' ')}
      // A toast is a control-sized surface, not a panel, so it wants radius-lg
      // rather than .layer-surface's radius-xl. Set inline, NOT via a rounded-lg
      // class: .layer-surface's border-radius is unlayered CSS and Tailwind emits
      // utilities inside @layer utilities, so the class would lose and the toast
      // would silently keep the panel radius.
      style={{
        borderRadius: 'var(--radius-lg)',
        // WHY (card #11 a): the global toast sits above the message area (hooks/useToastClearance publishes where it
        // starts); 4rem is the old fixed spot, kept where there is no message box.
        // width: max-content + a max of the window less a margin each side: with left:50% alone a toast could only grow to
        // half the window, so a long notice on a phone became a tall narrow column (seen on the settings-repaired picture).
        ...(variant === 'global' ? { bottom: 'var(--toast-clearance, 4rem)', width: 'max-content', maxWidth: 'calc(100vw - 2rem)' } : null),
      }}
    >
      {/* The dot stays with its words; min-w-0 lets the words wrap instead of forcing the row wider than the window. */}
      <span className="flex items-center gap-2 min-w-0">
        {tone === 'error' && (
          // The state family's failure mark (§1.6) — same dot ErrorState uses.
          <span className="w-1.5 h-1.5 rounded-full bg-destructive shrink-0" aria-hidden="true" />
        )}
        <span className="min-w-0">{message}{footnote && <span className="text-fg-muted shrink-0"> · {footnote}</span>}</span>
      </span>
      {action && <span className="pointer-events-auto shrink-0 ml-auto">{action}</span>}
      {!action && (ordered.length > 0 || dismissible) && (
        <span className="pointer-events-auto shrink-0 flex items-center gap-1.5 ml-auto">
          {dismissible && <Button variant="secondary" size="sm" onClick={() => onDismissRef.current()}>Dismiss</Button>}
          {ordered.map((x) => (
            <Button key={x.label} variant={x.primary ? 'primary' : 'secondary'} size="sm" onClick={x.onClick}>{x.label}</Button>
          ))}
        </span>
      )}
    </OverlayPanel>
  );
}
