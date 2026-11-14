import { useEffect, type RefObject } from 'react';

// WHY (card #11 a, 2026-11-13): the app's one Toast sat a fixed 4rem above the bottom edge, which is INSIDE the
// message box and the quick-chip row above it (the damaged-settings notice covered the last chip and the top of the
// box in its picture; any two-line notice does). The message area publishes how far its top edge is from the bottom
// of the window, and the Toast sits just above that. The box grows with the person's typing and the chip row can be
// hidden, so this is measured, not guessed. Without a message box on screen the Toast keeps its old 4rem.
export const TOAST_CLEARANCE_VAR = '--toast-clearance';

export function useToastClearance(ref: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled || typeof window === 'undefined') return undefined;
    const root = document.documentElement;
    const publish = () => {
      const top = el.getBoundingClientRect().top;
      // 0.5rem gap so the notice does not touch the chips.
      root.style.setProperty(TOAST_CLEARANCE_VAR, `${Math.max(0, Math.round(window.innerHeight - top + 8))}px`);
    };
    publish();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(publish) : null;
    ro?.observe(el);
    // The window and the content above also move the box's top without resizing it.
    ro?.observe(document.body);
    window.addEventListener('resize', publish);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', publish);
      root.style.removeProperty(TOAST_CLEARANCE_VAR);
    };
  }, [ref, enabled]);
}
