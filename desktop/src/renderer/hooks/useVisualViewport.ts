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
export function useVisualViewport() {
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;

    let frame: number | null = null;

    const apply = () => {
      frame = null;
      // innerHeight is the layout viewport; vv.height is the visible viewport.
      // Their difference equals keyboard + any other overlay chrome the UA is
      // reporting (on Android WebView: essentially just the IME).
      // Math.max guards against negative values during orientation changes.
      const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      // Clamp sub-pixel jitter — some devices fire values like 398.6 vs 399.0
      // back-to-back mid-animation.
      const rounded = Math.round(offset);
      document.documentElement.style.setProperty('--vvp-offset', `${rounded}px`);
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
      document.documentElement.style.removeProperty('--vvp-offset');
    };
  }, []);
}
