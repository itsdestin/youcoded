import { useEffect } from 'react';

// Populates --vvp-offset on <html> with the current soft-keyboard (IME) height
// in pixels, driven by window.visualViewport. globals.css uses it in
// `height: calc(100dvh - var(--vvp-offset, 0px))` on html/body/#root so the
// bottom input bar stays glued to the top of the keyboard as it animates up.
//
// WHY this matters on Android: AndroidManifest sets
// windowSoftInputMode="adjustNothing" and index.html declares
// interactive-widget=overlays-content in the viewport meta. Together that tells
// the OS + browser to let the keyboard overlay the page without resizing it,
// and to report keyboard geometry through visualViewport. This hook is the one
// place we consume that geometry — updates happen in a single rAF per
// visualViewport event, in lockstep with the OS animation, eliminating the
// prior jitter caused by ResizeObserver races mid-animation.
//
// Desktop is unaffected: visualViewport.height === innerHeight when no
// keyboard is open, so --vvp-offset stays 0.
/** Fired on window each time --vvp-offset changes (the keyboard opened, closed or resized). */
export const KEYBOARD_OFFSET_EVENT = 'youcoded:keyboard-offset';

export function useVisualViewport() {
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;

    let frame: number | null = null;
    // The Android app's own keyboard height, in CSS px (MainActivity → window.__ycImeOffset). WHY: the app no longer
    // resizes the page for the keyboard (that redrew everything every frame), and an Android WebView whose size does
    // not change reports no keyboard through visualViewport — so the app tells the page directly, once per frame of
    // the keyboard's slide. A phone browser over remote access never calls it and keeps using visualViewport.
    let nativeOffset = 0;
    let last = -1;
    const w = window as unknown as { __ycImeOffset?: (px: number) => void };
    // The app sends the keyboard's FINAL height once, when it starts to slide (not every frame: that kept the page
    // restyling every frame and still trailed the keyboard). `data-ime="native"` turns on keyboard.css's glide, so the
    // message box and the messages move up together in one smooth animation timed like the keyboard's.
    w.__ycImeOffset = (px: number) => {
      nativeOffset = Number.isFinite(px) ? Math.max(0, px) : 0;
      document.documentElement.dataset.ime = 'native';
      schedule();
    };

    const apply = () => {
      frame = null;
      // innerHeight is the layout viewport; vv.height is the visible viewport.
      // Their difference equals keyboard + any other overlay chrome the UA is
      // reporting (on Android WebView: essentially just the IME).
      // Math.max guards against negative values during orientation changes.
      const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop, nativeOffset);
      // Clamp sub-pixel jitter — some devices fire values like 398.6 vs 399.0
      // back-to-back mid-animation.
      const rounded = Math.round(offset);
      // Skip an unchanged value (performance.md rule 6): a root variable write restyles the whole page.
      if (rounded === last) return;
      last = rounded;
      document.documentElement.style.setProperty('--vvp-offset', `${rounded}px`);
      // ChatView keeps the newest message in view above the keyboard (it no longer gets a smaller window to notice).
      window.dispatchEvent(new CustomEvent(KEYBOARD_OFFSET_EVENT));
    };

    const schedule = () => {
      if (frame != null) return;
      frame = requestAnimationFrame(apply);
    };

    apply();
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    return () => {
      if (frame != null) cancelAnimationFrame(frame);
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
      delete w.__ycImeOffset;
      delete document.documentElement.dataset.ime;
      document.documentElement.style.removeProperty('--vvp-offset');
    };
  }, []);
}
