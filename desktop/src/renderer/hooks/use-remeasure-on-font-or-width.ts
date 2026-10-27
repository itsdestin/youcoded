// use-remeasure-on-font-or-width.ts — measure an auto-sizing box again when a font finishes loading or its width changes.
//
// WHY (Destin, 2026-10-22 review deck: "the 'message your assistant' text in the box has a weird extra space below it
// instead of being centered"): the message box sizes itself to its placeholder as laid out when it was last measured. The
// first measurement came before the theme's font had loaded, in a wider stand-in font that wrapped the placeholder onto
// two lines, and nothing measured again until the text changed — so the box stayed two lines tall with one line of
// placeholder at its top. A phone turned sideways changes the width the same way. Height alone never triggers it (the
// measure sets the height), so it cannot loop. A placeholder that truly needs two lines (a wide theme font on a phone)
// still gets them.
import { useEffect, type RefObject } from 'react';

export function useRemeasureOnFontOrWidth(ref: RefObject<HTMLElement | null>, measure: () => void): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    fonts?.addEventListener?.('loadingdone', measure);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      let width = el.clientWidth;
      observer = new ResizeObserver(() => {
        if (el.clientWidth === width) return;
        width = el.clientWidth;
        measure();
      });
      observer.observe(el);
    }
    return () => { fonts?.removeEventListener?.('loadingdone', measure); if (observer) observer.disconnect(); };
  }, [ref, measure]);
}
