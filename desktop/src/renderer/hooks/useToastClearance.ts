import { useEffect, type RefObject } from 'react';
import { KEYBOARD_OFFSET_EVENT } from './keyboard-live-lift';

// WHY (card #11 a, 2026-11-13): the app's one Toast sat a fixed 4rem above the bottom edge, which is INSIDE the message box and the
// quick-chip row above it (the damaged-settings notice covered the last chip and the top of the box in its picture; any two-line notice
// does). The message area publishes how far its top edge is from the bottom of the window, and the Toast sits just above that. The box
// grows with the person's typing and the chip row can be hidden, so this is measured, not guessed. Without a usable message box on
// screen the Toast keeps its old 4rem.
export const TOAST_CLEARANCE_VAR = '--toast-clearance';

/** Whether the bar is really on screen: laid out (not display:none, not zero size), not inert chrome (the terminal view keeps the bar
 *  mounted but inert and zero-size so a draft survives the switch), and its top inside the window. Anything else must fall back to the
 *  default, because a clearance measured from a hidden bar would push the notice off the screen. */
export function barIsUsable(el: HTMLElement, windowHeight: number): boolean {
  if (!el.isConnected || el.closest('[inert]')) return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  return r.top > 0 && r.top < windowHeight;
}

export function useToastClearance(ref: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled || typeof window === 'undefined') return undefined;
    const root = document.documentElement;
    const publish = () => {
      if (!barIsUsable(el, window.innerHeight)) { root.style.removeProperty(TOAST_CLEARANCE_VAR); return; }
      const top = el.getBoundingClientRect().top;
      // 0.5rem gap so the notice does not touch the chips.
      root.style.setProperty(TOAST_CLEARANCE_VAR, `${Math.max(0, Math.round(window.innerHeight - top + 8))}px`);
    };
    publish();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(publish) : null;
    ro?.observe(el);
    // The window and the content above also move the box's top without resizing it. A view switch (chat <-> terminal) changes the
    // bar's size or inertness, which both observers and the attribute watch below catch.
    ro?.observe(document.body);
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(publish) : null;
    mo?.observe(el, { attributes: true, attributeFilter: ['inert', 'class', 'style', 'hidden'] });
    window.addEventListener('resize', publish);
    // The phone's software keyboard lifts the bar (hooks/keyboard-live-lift.ts) without resizing the page: re-measure when the
    // visible area changes and when the chat reports a new keyboard offset, so the notice rides above the keyboard.
    const vv = window.visualViewport;
    vv?.addEventListener('resize', publish);
    vv?.addEventListener('scroll', publish);
    window.addEventListener(KEYBOARD_OFFSET_EVENT, publish);
    return () => {
      ro?.disconnect();
      mo?.disconnect();
      window.removeEventListener('resize', publish);
      vv?.removeEventListener('resize', publish);
      vv?.removeEventListener('scroll', publish);
      window.removeEventListener(KEYBOARD_OFFSET_EVENT, publish);
      root.style.removeProperty(TOAST_CLEARANCE_VAR);
    };
  }, [ref, enabled]);
}
