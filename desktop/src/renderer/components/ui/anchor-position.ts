/**
 * Where an anchored bubble goes.
 *
 * WHY this is its own module rather than a method on AnchorTip: `Tooltip` needs
 * exactly the same arithmetic — same dialog-aware bounds, same flip, same clamp —
 * and this repo has shipped the same component twice under two names before
 * (SkillCard's dead `marketplace` variant, FirstRunView's shadow `ProgressBar`,
 * spec §20). A second hand-tuned copy of the clamp would drift silently, and the
 * failure mode is a bubble hanging outside the panel it belongs to, which nobody
 * notices until it is in front of Destin.
 */

/** Breathing room the bubble keeps from the edge of the panel it lives in. */
export const EDGE = 8;

export type BubblePlacement = 'top' | 'bottom';
export type BubbleAlign = 'center' | 'start';

/**
 * The box the bubble is not allowed to leave.
 *
 * WHY it is not simply the window (AnchorTip contract R21, 2026-09-06): these
 * bubbles are opened from rows inside a settings dialog, and the window is much
 * taller than the dialog. A size number near the bottom of the Model Providers
 * panel therefore opened a bubble that hung 51 px BELOW the panel, floating over
 * the page behind it — measured in the real app. The bubble belongs to the
 * panel, so the panel is the boundary; anywhere there is no dialog around the
 * trigger, the window is. Whichever it is, it is also intersected with the
 * window, because a dialog can itself be taller than a short window.
 */
export function boundsFor(el: HTMLElement) {
  const host = el.closest('[role="dialog"]');
  const h = host ? host.getBoundingClientRect() : null;
  return {
    left: Math.max(EDGE, h ? h.left + EDGE : EDGE),
    right: Math.min(window.innerWidth - EDGE, h ? h.right - EDGE : window.innerWidth - EDGE),
    top: Math.max(EDGE, h ? h.top + EDGE : EDGE),
    bottom: Math.min(window.innerHeight - EDGE, h ? h.bottom - EDGE : window.innerHeight - EDGE),
  };
}

/**
 * Position is returned as plain left/top rather than a CSS transform so that
 * clamping is possible: a `translateX(-50%)` bubble cannot be nudged back inside
 * its panel without fighting the transform.
 *
 * `panel` is null on the first render after opening — the bubble is in the DOM
 * at 0,0 but has not been measured yet — so width and height fall back to 0 and
 * the caller re-runs this as a LAYOUT effect once the real size is readable.
 */
export function placeBubble(
  trigger: HTMLElement,
  panel: HTMLElement | null,
  opts: {
    placement: BubblePlacement;
    align: BubbleAlign;
    gapBelow: number;
    gapAbove: number;
  },
): { left: number; top: number } {
  const rect = trigger.getBoundingClientRect();
  const box = panel?.getBoundingClientRect();
  const w = box?.width ?? 0;
  const h = box?.height ?? 0;
  const b = boundsFor(trigger);

  // Preferred side, then flip if the preferred side does not fit and the other
  // one does. Flipping only happens when staying put would push the bubble out
  // of the bounds — a hint asked for below the control stays below it in every
  // case where below is actually available.
  const belowTop = rect.bottom + opts.gapBelow;
  const aboveTop = rect.top - opts.gapAbove - h;
  let side = opts.placement;
  if (h > 0) {
    if (side === 'bottom' && belowTop + h > b.bottom && aboveTop >= b.top) side = 'top';
    else if (side === 'top' && aboveTop < b.top && belowTop + h <= b.bottom) side = 'bottom';
  }

  const wantLeft = opts.align === 'start' ? rect.left : rect.left + rect.width / 2 - w / 2;
  const left = w > 0 ? Math.min(Math.max(wantLeft, b.left), Math.max(b.left, b.right - w)) : wantLeft;
  const wantTop = side === 'bottom' ? belowTop : aboveTop;
  // The final clamp is the backstop for a bubble taller than its bounds: it is
  // pinned to the top and allowed to overflow downwards rather than being pushed
  // off the top, because the first line is the part you need to see.
  const top = h > 0 ? Math.min(Math.max(wantTop, b.top), Math.max(b.top, b.bottom - h)) : wantTop;
  return { left, top };
}
