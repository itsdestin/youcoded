import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { OverlayPanel } from '../overlays/Overlay';
import { useEscClose } from '../../hooks/use-esc-close';
import { placeBubble } from './anchor-position';

/**
 * The app's own hover hint — the replacement for the browser's `title=` bubble.
 *
 * `title=` is drawn by the operating system, so no theme can reach it: it is the
 * same grey box on Midnight and on Light, and on a touchscreen it never appears
 * at all. Destin asked for every hint to look like the app (questions deck
 * `app-themed-tooltips-questions`, answered 2026-09-10).
 *
 * WHY this CLONES its child instead of wrapping it. The 2026-09-01 investigation
 * assumed each swap would turn an attribute into a wrapper element, and priced
 * the work on perturbing flex/grid in dense rows — the status bar especially.
 * A clone injects the handlers and a ref straight onto the control that is
 * already there, so the DOM is byte-identical to before and nothing can shift —
 * with no exceptions, including disabled controls.
 *
 * A disabled control looked like it would need a wrapper, because Chromium
 * suppresses `click` on one. MEASURED instead of assumed (2026-09-10, real CDP
 * mouse input over a disabled <button>, not a synthetic dispatch — which proves
 * nothing, since it skips hit-testing): a real mouse produces `pointerover`,
 * `pointerenter` and `pointermove` there. So the clone works, and the wrapper
 * this file used to add was not merely unnecessary — it was a latent layout bug.
 * An `inline-flex` span around StatusBar's `w-full` theme-cycle row would have
 * collapsed that row to its content width on the one theme where the hint
 * appears at all.
 *
 * NOT this component: rich or click-open explanations, which are `AnchorTip`.
 * Paragraph-length copy belongs there rather than here — a sentence hidden
 * behind a hover cannot be read without holding the pointer still, and never
 * appears on Android at all (deck Q-5).
 */

/**
 * How long the pointer rests before a hint appears.
 *
 * The questions deck (Q-4) chose to keep the OS's full second over the under-
 * half-second I recommended. Destin then tried it on the live deck and asked for
 * "just a smidge faster" (L-3, 2026-09-10) — so this is 800 ms: his own
 * correction to his own answer, NOT a quiet slide back toward the 400 ms he
 * turned down. Do not shorten it further without asking.
 */
const HOVER_DELAY = 800;

/**
 * Once one hint has been shown, its neighbours open on a much shorter wait for
 * this long — the behaviour the OS bubble has, and the reason a longer first
 * wait is livable: sweeping along the status bar answers quickly after the first
 * one. Module-level on purpose, because the warmth belongs to the app, not to
 * one tooltip.
 */
const WARM_MS = 400;
let warmUntil = 0;

/**
 * The wait for a neighbour while the row is warm.
 *
 * WHY it is not zero: it WAS zero, and Destin's verdict on the live deck was
 * that crossing adjacent buttons wanted "slightly more of a delay/fade in"
 * (L-3, 2026-09-10). At zero the bubble teleports along the row, one hard cut
 * per chip. This plus the 110 ms `.tooltip-in` fade in globals.css is that
 * correction; they are two halves of one answer, so do not drop one of them.
 */
const WARM_DELAY = 130;

/** Press-and-hold on a touchscreen, which is the only way to reach a hint with
 *  no pointer (deck Q-3, `long-press`). */
const LONG_PRESS = 450;

/** Finger travel that means the press was the start of a scroll, not a hold. */
const MOVE_CANCEL = 10;

const GAP = 6;

export type TooltipProps = {
  /** The hint itself. Keep it to a few words; a sentence belongs in `AnchorTip`. */
  text: string;
  /** Preferred side. Flips automatically when that side does not fit. */
  placement?: 'top' | 'bottom';
  /** The single control the hint describes. */
  children: React.ReactElement<Record<string, unknown>>;
};

/** True when anything inside the element is real text the user can already read. */
function hasTextContent(node: React.ReactNode): boolean {
  if (typeof node === 'string') return node.trim().length > 0;
  if (typeof node === 'number') return true;
  if (Array.isArray(node)) return node.some(hasTextContent);
  if (React.isValidElement(node)) {
    return hasTextContent((node.props as { children?: React.ReactNode }).children);
  }
  return false;
}

export function Tooltip({ text, placement = 'top', children }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [byTouch, setByTouch] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const triggerRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const id = useId();

  const child = React.Children.only(children) as React.ReactElement<Record<string, unknown>>;
  const childProps = child.props as Record<string, unknown> & { children?: React.ReactNode };
  // Empty text is a real state, not a mistake: several hints exist only in one
  // branch ("at least one theme must stay in the cycle" appears only on the last
  // remaining theme). An empty string must render nothing rather than an empty
  // bubble, and it cannot be an early return, because hooks run unconditionally.
  const armed = text.trim().length > 0;

  const cancelTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const close = useCallback(() => {
    cancelTimer();
    setOpen((was) => {
      // Only start the warm window if something was actually on screen, so a
      // pointer that passed over a control without ever opening one does not
      // make the NEXT control open instantly.
      if (was) warmUntil = Date.now() + WARM_MS;
      return false;
    });
    setByTouch(false);
  }, []);

  const measure = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const { left, top } = placeBubble(el, panelRef.current, {
      placement,
      align: 'center',
      gapBelow: GAP,
      gapAbove: GAP,
    });
    setPos((prev) => (prev.left === left && prev.top === top ? prev : { left, top }));
  }, [placement]);

  // Measured as a layout effect so the bubble is moved off 0,0 before the browser
  // paints it — the same two-pass shape AnchorTip uses.
  useLayoutEffect(() => {
    if (open) measure();
  }, [open, measure]);

  // Esc (and Android's hardware back) closes a hint that a finger opened. A
  // hovered one needs no key: moving the pointer away is the dismissal.
  useEscClose(open && byTouch, close);

  useEffect(() => {
    if (!open) return;
    const reposition = () => measure();
    // Capture-phase: these sit inside scrollable strips and drawers, so a hint
    // measured once detaches from its control the moment any ancestor scrolls.
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    // A hint the app drew lives inside the app window, so it must go when the
    // window does — the trade-off Destin accepted on the deck (S-1).
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('blur', close);
    };
  }, [open, measure, close]);

  // A finger has no "moves away", so a tap anywhere else is what dismisses a
  // long-pressed hint.
  useEffect(() => {
    if (!open || !byTouch) return;
    const onDown = (e: Event) => {
      if (triggerRef.current?.contains(e.target as Node)) return;
      close();
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open, byTouch, close]);

  useEffect(() => cancelTimer, []);

  // The caller's own ref is kept in a ref of its own so that `setRef` below can
  // stay referentially stable. A ref callback that changes identity every render
  // is detached and reattached every render, which React does by calling it with
  // null first — enough to lose the node mid-hover.
  const childRef = useRef<React.Ref<HTMLElement> | undefined>(undefined);
  childRef.current = (childProps as { ref?: React.Ref<HTMLElement> }).ref;

  const setRef = useCallback((node: HTMLElement | null) => {
    triggerRef.current = node;
    // Hand the node on to whatever ref the caller already had, so cloning a
    // control never steals its ref.
    const ref = childRef.current;
    if (typeof ref === 'function') ref(node);
    else if (ref && typeof ref === 'object') (ref as React.MutableRefObject<HTMLElement | null>).current = node;
  }, []);

  /**
   * WHY pointer events and not mouse events (the same trap AnchorTip hit on
   * 2026-09-06): after a touch the browser REPLAYS the whole mouse sequence for
   * compatibility, so `onMouseEnter` would open a hint and the trailing
   * `mouseleave` would close it in the same frame. `pointerType` is what lets
   * hovering mean a real pointer and a press mean a press.
   */
  const handlers = {
    onPointerEnter: (e: React.PointerEvent) => {
      if (!armed || e.pointerType !== 'mouse') return;
      cancelTimer();
      const wait = Date.now() < warmUntil ? WARM_DELAY : HOVER_DELAY;
      timer.current = setTimeout(() => setOpen(true), wait);
    },
    onPointerLeave: (e: React.PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      close();
    },
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse') {
        // Clicking the thing is an answer in itself; the hint gets out of the way.
        close();
        return;
      }
      if (!armed) return;
      pressStart.current = { x: e.clientX, y: e.clientY };
      cancelTimer();
      timer.current = setTimeout(() => {
        setByTouch(true);
        setOpen(true);
      }, LONG_PRESS);
    },
    onPointerMove: (e: React.PointerEvent) => {
      // A press that travels is a scroll or a drag starting, not a hold — let it go.
      const from = pressStart.current;
      if (!from || !timer.current) return;
      if (Math.abs(e.clientX - from.x) > MOVE_CANCEL || Math.abs(e.clientY - from.y) > MOVE_CANCEL) {
        cancelTimer();
      }
    },
    onPointerUp: (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      pressStart.current = null;
      // Cancel a hold that has not fired yet; one already on screen stays until
      // the next tap somewhere else.
      cancelTimer();
    },
    onPointerCancel: () => {
      pressStart.current = null;
      cancelTimer();
    },
    // Keyboard reaches the hint the same way it reaches everything else.
    onFocus: () => { if (armed) setOpen(true); },
    onBlur: close,
  };

  /**
   * The hint's text has to reach a screen reader too — `title=` gave that for
   * free and losing it silently would be a real regression on the icon-only
   * controls where the hint is the ONLY name. A control that already reads as
   * something (its own `aria-label`, or visible words inside it) gets the hint
   * as a DESCRIPTION; one that reads as nothing gets it as its NAME.
   */
  const named = childProps['aria-label'] != null || childProps['aria-labelledby'] != null;
  const describes = named || hasTextContent(childProps.children);

  /**
   * The hint's words, left on the control itself.
   *
   * WHY an attribute at all, when the point of this component is that the hint
   * lives in a portal: with `title` gone the copy is in the DOM only while the
   * bubble is open, so nothing can read it without first simulating a hover —
   * and the app has ~15 tests that assert hint COPY ("Input tokens: 12,345.
   * Counts this session so far, including specialists."), which is copy worth
   * guarding. `data-hint` keeps those assertions about the words rather than
   * about the mechanism, and makes the hint readable in DevTools. It is an
   * attribute, not an element, so it cannot move anything.
   */
  const aria: Record<string, unknown> = {
    'data-hint': armed ? text : undefined,
    'aria-describedby': describes && open ? id : (childProps['aria-describedby'] as string | undefined),
  };
  if (!describes && armed) aria['aria-label'] = text;

  return (
    <>
      {React.cloneElement(child, { ...aria, ...handlers, ref: setRef })}

      {open && armed &&
        createPortal(
          <OverlayPanel
            ref={panelRef}
            layer={4}
            role="tooltip"
            id={id}
            // pointer-events-none so a hint can never swallow a click meant for
            // what is underneath it.
            className="tooltip-in fixed pointer-events-none px-2 py-1 max-w-[min(20rem,calc(100vw-1.5rem))] text-2xs text-fg-2 leading-snug"
            style={{ left: pos.left, top: pos.top }}
          >
            {text}
          </OverlayPanel>,
          document.body,
        )}
    </>
  );
}
