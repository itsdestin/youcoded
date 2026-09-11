import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { OverlayPanel } from '../overlays/Overlay';
import { useEscClose } from '../../hooks/use-esc-close';
import { placeBubble } from './anchor-position';

/**
 * Anchored info bubble (change 28, §1.7).
 *
 * Replaces the two hand-rolled `fixed z-[9999]` / `bg-panel border rounded-lg
 * shadow-lg` boxes — InfoPopover and SkipPermissionsInfoTooltip — with one
 * .layer-surface at L4, so Overlay.tsx stays the only z-index authority
 * (design rule 11).
 *
 * L4 on purpose: these explain L2 popups, so they must float above z-61 or the
 * bubble gets trapped behind the panel it's describing.
 *
 * NOTE — the spec described SkipPermissionsInfoTooltip as "a copy of"
 * InfoPopover. It isn't. They share the (i) glyph and the panel styling, but
 * their interaction models differ: InfoPopover is click-toggled and dismissible,
 * SkipPermissionsInfoTooltip is hover/focus-shown and pointer-events-none. Both
 * modes are supported here rather than forcing one call site to change behavior.
 *
 * Native `title=` hover hints are NOT this component — they stay as-is
 * (~231 across 63 files). AnchorTip is for rich/click-open info; `title` is for
 * plain hover hints. Two tools, one documented policy.
 */

/** The gaps the bubble has always sat at, kept exactly: 6 px under the trigger,
 *  10 px above it. */
const GAP_BELOW = 6;
const GAP_ABOVE = 10;

export type AnchorTipTrigger = 'click' | 'hover';
export type AnchorTipPlacement = 'top' | 'bottom';

export type AnchorTipProps = {
  /** Accessible name for the trigger, e.g. "About OpenRouter". */
  label: string;
  /** Optional bold heading inside the bubble. */
  title?: string;
  children: React.ReactNode;
  /** click (default) = toggled + dismissible. hover = transient, non-interactive. */
  trigger?: AnchorTipTrigger;
  placement?: AnchorTipPlacement;
  /** Tailwind width class for the bubble. */
  widthClass?: string;
  className?: string;
  /**
   * Render THIS as the trigger instead of the (i) glyph — a dotted-underlined
   * number that breaks down on hover, an eye icon that says "Sees images".
   * Same bubble, same layer, and the same touch behaviour — a finger tap opens
   * it (see the hover handlers below). Added 2026-09-05 for the Local Models
   * screen (design deck P-5 / P-6).
   */
  anchor?: React.ReactNode;
  /**
   * `start` lines the bubble's left edge up with the trigger's left edge instead of
   * centring on it — for triggers at the left of a row, where a centred bubble hangs
   * out of the panel it belongs to (round-2 P-12). Default `center`.
   */
  align?: 'center' | 'start';
};

export function AnchorTip({
  label,
  title,
  children,
  trigger = 'click',
  placement = 'bottom',
  widthClass = 'w-72',
  className = '',
  anchor,
  align = 'center',
}: AnchorTipProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /**
   * Where the bubble actually goes. Two passes by construction: the first render
   * after `open` commits the panel to the DOM at 0,0, this runs as a LAYOUT
   * effect (so it is measured and moved before the browser paints — no flash),
   * and it can read the panel's real width and height, which is what makes
   * "does it fit below?" answerable at all.
   *
   * The arithmetic — dialog-aware bounds, flip, clamp — is shared with `Tooltip`
   * in `anchor-position.ts`; see the WHY there.
   */
  const measure = () => {
    const el = triggerRef.current;
    if (!el) return;
    const { left, top } = placeBubble(el, panelRef.current, {
      placement,
      align,
      gapBelow: GAP_BELOW,
      gapAbove: GAP_ABOVE,
    });
    setPos((prev) => (prev.left === left && prev.top === top ? prev : { left, top }));
  };

  useLayoutEffect(() => {
    if (open) measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, placement, align]);

  /**
   * Esc goes through the shared dismissal stack rather than a hand-rolled
   * capture-phase listener.
   *
   * The spec said to keep the capture-phase Esc "because it must beat the parent
   * popup's Esc". It doesn't need to: useEscClose is a LIFO stack, and the tip
   * pushes AFTER the popup that hosts it, so Esc pops the tip first by
   * construction — which is the exact behavior the capture-phase hack was
   * hand-rolling. Going through the stack also means the tip responds to
   * Android's hardware-back button, which the raw listener never did.
   */
  useEscClose(open && trigger === 'click', () => setOpen(false));

  // Outside-press dismissal. This used to be click-mode only, on the reasoning
  // that a hover tip closes itself when the mouse moves away. A finger has no
  // "moves away": once a tap can open a hover tip (see below), a tap somewhere
  // else has to be what closes it, so hover mode is in here too now. Both
  // `pointerdown` and `mousedown` are listened for because they are not
  // redundant — jsdom-based tests fire mousedown, and a stylus/finger fires
  // pointerdown; closing twice is harmless.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [open, trigger]);

  // These live inside scrollable settings panels, so a bubble measured once on
  // open detaches from its trigger the moment the panel scrolls. Capture-phase
  // catches scrolls on ANY ancestor, not just window.
  useEffect(() => {
    if (!open) return;
    const reposition = () => measure();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, placement, align]);

  /**
   * Hover-mode triggers, and why they listen to POINTER events instead of mouse
   * events (contract R20, fixed 2026-09-06).
   *
   * Tapping one of these with a finger used to do nothing at all. The reason is
   * that after a touch, the browser REPLAYS the whole mouse sequence for
   * compatibility — mouseover, mouseenter, focus, click, mouseout, mouseleave —
   * so `onMouseEnter` opened the bubble and the trailing `mouseleave` closed it
   * again in the same frame. Polled every 60 ms for 1.5 s after a real tap, the
   * bubble was never once on screen. Destin drives this machine by touchscreen
   * and has no mouse, so on his hardware the size breakdown was unreachable.
   *
   * Pointer events carry `pointerType`, so hovering can be restricted to an
   * actual mouse and the replayed mouse events are ignored. A tap is then
   * handled on its own terms:
   *
   *   · `onPointerDown` for a finger/stylus FLIPS the bubble, so a second tap on
   *     the same number closes it.
   *   · `onFocus` still opens it, which is both the keyboard path (Tab to the
   *     number) and the reason the flip is correct in every case: the browser
   *     focuses the button on the first tap, and focus and the flip agree (both
   *     open). On a later tap the button is already focused, so no focus event
   *     follows and the flip is the only thing that acts.
   *   · `onBlur` closes it, which is what "tap somewhere else" does.
   */
  const hoverProps =
    trigger === 'hover'
      ? {
          onPointerEnter: (e: React.PointerEvent) => { if (e.pointerType === 'mouse') setOpen(true); },
          onPointerLeave: (e: React.PointerEvent) => { if (e.pointerType === 'mouse') setOpen(false); },
          onPointerDown: (e: React.PointerEvent) => { if (e.pointerType !== 'mouse') setOpen((v) => !v); },
          onFocus: () => setOpen(true),
          onBlur: () => setOpen(false),
        }
      : {};

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-expanded={trigger === 'click' ? open : undefined}
        onClick={(e) => {
          e.stopPropagation();
          if (trigger === 'click') setOpen((v) => !v);
        }}
        {...hoverProps}
        className={`inline-flex items-center justify-center shrink-0 ${anchor ? '' : 'text-fg-muted hover:text-fg'} transition-colors ${className}`.trim()}
      >
        {anchor ?? (
          <svg
            className="w-3.5 h-3.5 opacity-60 hover:opacity-100 transition-opacity"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 11v5" />
            <circle cx="12" cy="8" r="0.5" fill="currentColor" />
          </svg>
        )}
      </button>

      {open &&
        createPortal(
          <OverlayPanel
            ref={panelRef}
            layer={4}
            role={trigger === 'hover' ? 'tooltip' : 'dialog'}
            className={`fixed p-3 text-left max-w-[calc(100vw-1.5rem)] ${widthClass} ${
              trigger === 'hover' ? 'pointer-events-none' : ''
            }`}
            // Plain left/top, no transform: `measure()` above has already done
            // the centring arithmetic, because a bubble positioned by transform
            // cannot also be clamped back inside its panel.
            style={{ left: pos.left, top: pos.top }}
            onClick={(e) => e.stopPropagation()}
          >
            {title && <p className="text-xs font-semibold text-fg mb-1.5">{title}</p>}
            <div className="text-2xs text-fg-2 leading-snug space-y-2">{children}</div>
          </OverlayPanel>,
          document.body,
        )}
    </>
  );
}
