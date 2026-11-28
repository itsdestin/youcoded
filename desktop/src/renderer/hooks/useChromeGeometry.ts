import { useEffect, useState } from 'react';
import type { ChromeRect } from '../components/theme-effects-mask';

// CSS classes of the always-on glassmorphism chrome panels. These are the
// elements whose backdrop-filter cost we want to make static. Dynamic
// overlays (.settings-drawer, .layer-surface popups) are intentionally
// excluded — masking them would require tracking show/hide/animate state
// and is not worth the complexity. Cost while a popup is open is a
// known, accepted trade-off documented in the plan.
const CHROME_SELECTORS = ['.header-bar', '.status-bar', '.input-bar-container'];

function sameRects(a: ChromeRect[], b: ChromeRect[]): boolean {
  return a.length === b.length && a.every((r, i) =>
    r.left === b[i].left && r.top === b[i].top && r.width === b[i].width && r.height === b[i].height);
}

export function useChromeGeometry(): ChromeRect[] {
  const [rects, setRects] = useState<ChromeRect[]>([]);

  useEffect(() => {
    const elements = CHROME_SELECTORS
      .map((sel) => document.querySelector(sel))
      .filter((el): el is Element => el !== null);

    if (elements.length === 0) {
      setRects([]);
      return;
    }

    const measure = () => {
      const next = elements.map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      });
      // WHY keep the old array when nothing moved (hitch audit 2026-11-27): a fresh array re-rendered ThemeEffects and
      // rebuilt its clip-path string, which repaints the full-window particle canvas — on every ResizeObserver tick of
      // the input bar while typing, even when no rectangle changed. Same rects → same state → no render.
      setRects((prev) => (sameRects(prev, next) ? prev : next));
    };

    // Synchronous initial measurement avoids a frame where the canvas is
    // unmasked while React is still scheduling the first observer callback.
    measure();

    // Perf: `window.resize` is NOT frame-batched. On Wayland the compositor
    // emits a configure per frame during a drag-resize, and each one ran a full
    // getBoundingClientRect sweep + setState — forcing layout and a React render
    // in the exact window where the compositor is waiting for our new-size
    // frame, which shows up as content lagging behind the window edge.
    // Coalesce to one measure per frame.
    let rafId: number | null = null;
    const measureOnFrame = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        measure();
      });
    };

    // ResizeObserver stays direct — the browser already delivers its callbacks
    // at most once per frame, so throttling it would only add a frame of lag.
    const observer = new ResizeObserver(measure);
    elements.forEach((el) => observer.observe(el));
    window.addEventListener('resize', measureOnFrame);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      observer.disconnect();
      window.removeEventListener('resize', measureOnFrame);
    };
  }, []);

  return rects;
}
