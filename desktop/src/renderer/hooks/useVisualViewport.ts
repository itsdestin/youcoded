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

/** The Android keyboard's slide: ~340 ms measured on a Galaxy Z Flip7; Android's keyboard curve (fast start, gentle stop). */
const IME_GLIDE_MS = 300;
/** cubic-bezier(0.2, 0, 0, 1) at progress t (0-1): x(u) is solved for u by bisection, then y(u). */
function imeEase(t: number): number {
  const bez = (a: number, b: number, u: number) => 3 * a * u * (1 - u) ** 2 + 3 * b * u * u * (1 - u) + u ** 3;
  let lo = 0, hi = 1, u = t;
  for (let i = 0; i < 20; i++) { u = (lo + hi) / 2; if (bez(0.2, 0, u) < t) lo = u; else hi = u; }
  return bez(0, 1, u);
}

export function useVisualViewport() {
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;

    let frame: number | null = null;
    // The Android app's keyboard (MainActivity → window.__ycImeOffset), in CSS px. The app does not resize the page for
    // the keyboard (that redrew everything every frame), and a WebView whose size does not change reports no keyboard
    // through visualViewport, so the app sends the keyboard's FINAL height once, as it starts to slide. A phone browser
    // over remote access never calls this and keeps following visualViewport.
    //
    // WHY the page animates the value itself (Destin, 2026-11-02): when the app sent the height every frame it arrived
    // unevenly ("stuttery/flickery"); when the message box glided on its own transition while everything else jumped,
    // "the bottom edge of the frame jumps up, then the chips/input bar … slide up after" ("detached and janky"). Here
    // --vvp-offset itself moves from where it is to the target on the page's own frame clock, with the keyboard's
    // timing, so the frame's edge, the message box, the messages and the empty-chat hint move in the same frame.
    let nativeFrom = 0;
    let nativeTo = 0;
    let nativeStart = 0;
    let nativeOffset = 0;
    let last = -1;
    const w = window as unknown as { __ycImeOffset?: (px: number) => void };
    const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    w.__ycImeOffset = (px: number) => {
      const target = Number.isFinite(px) ? Math.max(0, px) : 0;
      if (target === nativeTo) return;
      nativeFrom = nativeOffset;
      nativeTo = target;
      nativeStart = performance.now();
      document.documentElement.dataset.ime = 'native';
      schedule();
    };

    const apply = () => {
      frame = null;
      let gliding = false;
      if (nativeOffset !== nativeTo) {
        const t = reduced() ? 1 : Math.min(1, (performance.now() - nativeStart) / IME_GLIDE_MS);
        nativeOffset = t >= 1 ? nativeTo : nativeFrom + (nativeTo - nativeFrom) * imeEase(t);
        gliding = t < 1;
      }
      // innerHeight is the layout viewport; vv.height is the visible viewport.
      // Their difference equals keyboard + any other overlay chrome the UA is
      // reporting (on Android WebView: essentially just the IME).
      // Math.max guards against negative values during orientation changes.
      const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop, nativeOffset);
      // Clamp sub-pixel jitter — some devices fire values like 398.6 vs 399.0
      // back-to-back mid-animation.
      const rounded = Math.round(offset);
      if (gliding) schedule();
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
