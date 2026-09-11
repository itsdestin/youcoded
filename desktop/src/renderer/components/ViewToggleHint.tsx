import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { OverlayPanel, CONTENT_Z } from './overlays/Overlay';
import { CloseButton } from './ui';

/**
 * Coach mark that points at the chat/terminal toggle.
 *
 * WHY: the "Initializing session…" overlay's slow warning now sends the user to
 * terminal view with one button. That is a one-way door unless they already know
 * where the toggle is — the overlay was the only thing naming it, and it is gone
 * the moment the view switches. This is the way back, pointed straight at the
 * control.
 *
 * It anchors to whatever carries `data-view-toggle` (the wide segmented pill and
 * the narrow single-icon button both do), so it follows the toggle across the
 * narrow breakpoint and across platforms — on macOS the toggle sits in a
 * different header cluster than it does on Windows/Linux, and neither position
 * is hardcoded here.
 *
 * Shape chosen by Destin on 2026-09-04 from three candidates
 * (docs/active/design/2026-09-04-back-to-chat-hint/): the filled bubble, plus an
 * outline, with fill AND outline both derived from the theme's accent. The two
 * candidates it beat were a plain popup-surface bubble (invisible on Light — a
 * near-white box on a near-white terminal) and an arrowless shelf hung off the
 * toolbar (nothing pointed at the button).
 */

/** Marks the element this hint points at. Both toggle variants carry it. */
export const VIEW_TOGGLE_ANCHOR_ATTR = 'data-view-toggle';

const GAP_PX = 8;      // vertical distance from the toggle to the bubble
const MARGIN_PX = 8;   // minimum distance from the window edges
const ARROW_PX = 12;   // side of the rotated square; its visible tip is ~8px tall

// Fill and edge are the SAME theme colour at two strengths — no neutral border,
// which is what made the outline read as a foreign part in review. Nudging the
// edge toward the label colour is the app's own trick for deriving a rim from a
// fill (globals.css does it for the accent gradients), so a theme pack that
// changes --accent gets a matching outline for free.
// Exported: the first-run guide's bubble (components/guide/GuideBubble.tsx) is
// this same shape speaking for the buddy, and must never drift a shade from it.
export const HINT_FILL = 'var(--accent)';
export const HINT_EDGE = 'color-mix(in srgb, var(--on-accent) 55%, var(--accent))';

interface Props {
  /** The ✕. Auto-dismissal on switching back to chat is the caller's job. */
  onDismiss: () => void;
}

type Geometry = { top: number; left: number; arrowLeft: number };

export default function ViewToggleHint({ onDismiss }: Props) {
  const [geo, setGeo] = useState<Geometry | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const measure = useCallback(() => {
    const anchor = document.querySelector(`[${VIEW_TOGGLE_ANCHOR_ATTR}]`);
    const panel = panelRef.current;
    if (!anchor || !panel) { setGeo(null); return; }
    const a = anchor.getBoundingClientRect();
    // A detached or zero-sized toggle (mid-remount across the narrow
    // breakpoint) would pin the bubble to the top-left corner. Skip the frame.
    if (a.width <= 0 || a.height <= 0) return;
    const width = panel.offsetWidth;

    // Aim at the button the user has to press, not at the middle of the pill —
    // centred on the pill, the arrow landed on the seam between its two halves.
    // Wide renders Chat first, then Terminal; narrow renders the single button
    // for the view you'd switch TO, which in terminal view is chat. Either way
    // the first button is the target.
    const target = (anchor.querySelector('button') ?? anchor).getBoundingClientRect();
    const aim = target.left + target.width / 2;

    // Left-aligned to the toggle, then clamped: the toggle sits close to the
    // window edge on Windows/Linux and the bubble is wider than that offset, so
    // an unclamped box would hang off-screen. The arrow moves within the box to
    // keep pointing at the real target.
    const maxLeft = Math.max(MARGIN_PX, window.innerWidth - width - MARGIN_PX);
    const left = Math.min(Math.max(a.left, MARGIN_PX), maxLeft);
    setGeo({ top: a.bottom + GAP_PX, left, arrowLeft: aim - left });
  }, []);

  useLayoutEffect(() => {
    measure();
    // The wide toggle animates its active label's width for 300ms on every
    // switch, and this mounts mid-animation — re-measure once it has settled.
    const settle = setTimeout(measure, 350);
    window.addEventListener('resize', measure);
    return () => { clearTimeout(settle); window.removeEventListener('resize', measure); };
  }, [measure]);

  // The header re-lays-out when session pills come and go, which moves the
  // toggle without a window resize.
  useEffect(() => {
    const anchor = document.querySelector(`[${VIEW_TOGGLE_ANCHOR_ATTR}]`);
    if (!anchor || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(anchor);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, [measure]);

  return createPortal(
    // The wrapper carries the layer, so the arrow — which has to live OUTSIDE
    // the bubble, because .layer-surface clips its own children — can't fall
    // behind the header.
    <div
      className="fixed"
      style={{
        top: geo?.top ?? 0,
        left: geo?.left ?? 0,
        zIndex: CONTENT_Z[4],
        // First paint happens before the bubble can be measured; showing it then
        // would flash it in the corner.
        visibility: geo ? 'visible' : 'hidden',
      }}
    >
      <OverlayPanel
        ref={panelRef}
        layer={4}
        role="status"
        className="relative flex items-center gap-1 pl-3 pr-1 py-1 text-on-accent max-w-[calc(100vw-1rem)]"
        // Inline, not utility classes: .layer-surface sets background, border and
        // radius in UNLAYERED css, and unlayered always beats a Tailwind utility
        // (see the cascade note in globals.css). Inline is the only thing that
        // wins, and it wins over the wallpaper opacity rule too — which is what
        // we want, since this has to stay readable over terminal text.
        style={{
          // zIndex auto, overriding the layer's own 100: the WRAPPER already
          // carries L4, so inside it the only thing that should decide paint
          // order is document order — and the arrow must come out on top. With
          // the panel at 100 it won, and its top border drew a line straight
          // across the arrow's base (measured: a solid row of edge colour under
          // the tip), which is the seam this shape exists to avoid.
          zIndex: 'auto',
          background: HINT_FILL,
          borderColor: HINT_EDGE,
          // The popup radius (16px) reads as a full lozenge on a 30px-tall bar;
          // still a theme token, so big-radius packs scale with it.
          borderRadius: 'var(--radius-lg)',
        }}
      >
        <span className="text-2xs font-medium leading-snug whitespace-nowrap">
          Click here to switch back to chat view
        </span>
        <CloseButton
          label="Dismiss hint"
          size="icon-sm"
          variant="on-accent"
          onClick={onDismiss}
          className="shrink-0"
        />
      </OverlayPanel>
      {/* AFTER the bubble on purpose: a rotated square painted BELOW it left the
          bubble's own top border running straight across the arrow's base, so the
          tip read as a separate triangle stuck to a box. Painted above, the
          arrow's fill hides that segment and its two borders continue the
          bubble's outline as one shape. Centred on the bubble's top edge, so
          half of it is inside and half is the visible tip. */}
      <div
        aria-hidden="true"
        className="absolute rotate-45"
        style={{
          width: ARROW_PX,
          height: ARROW_PX,
          left: (geo?.arrowLeft ?? 0) - ARROW_PX / 2,
          top: -ARROW_PX / 2,
          background: HINT_FILL,
          borderTop: `1px solid ${HINT_EDGE}`,
          borderLeft: `1px solid ${HINT_EDGE}`,
        }}
      />
    </div>,
    document.body,
  );
}
