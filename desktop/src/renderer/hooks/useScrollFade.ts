import { useEffect, useRef, type RefObject } from 'react';

// The FALLBACK half of the app's one scroll fade (`.scroll-mask`, styles/scroll-mask.css).
// The fade itself is CSS-only: the browser follows each box's own scroll position, no script.
// This hook only matters in a browser WITHOUT scroll-driven animations (Firefox in a remote
// browser, an old Android WebView): there it sets data-fade-top/-bottom/-left/-right and the
// stylesheet's fallback block reads them. Everywhere else it attaches NOTHING — no scroll
// listener, ResizeObserver or MutationObserver (performance.md rules 2, 3, 6).
// WHY keep it at all: the popups, Settings and the big lists already call it, and on those
// browsers it is the difference between a fade and none. A new scroll area needs only the
// class; calling this is optional.
// WHY asked per element, not once per page: it runs only when the hook meets a new element
// (once per mount — the fast path below skips every other render), so it costs nothing, and a
// test can stand in for a browser without the feature by stubbing CSS.supports (jsdom's says
// yes to everything).
function cssDrivesFade(): boolean {
  return typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
    && CSS.supports('animation-timeline: scroll()');
}

// Why useEffect-without-deps instead of [] deps: some callers (e.g.
// ResumeBrowser) conditionally render with `if (!open) return null`, so the
// target element only mounts AFTER the enclosing component mounts. With
// useEffect([]) the effect would run once at component mount — when the
// conditional block has returned null and the target div doesn't exist yet —
// capture a null ref, early-return, and never run again. Refs don't trigger
// re-renders, so we can't depend on `ref.current`. Running on every render
// (no deps) is cheap: the fast-path check `el !== attachedEl.current` makes
// it a no-op after attachment.
export function useScrollFade<T extends HTMLElement>(externalRef?: RefObject<T | null>) {
  const internalRef = useRef<T>(null);
  const ref = externalRef ?? internalRef;
  const attachedEl = useRef<T | null>(null);
  const cleanupRef = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    const el = ref.current;
    // Fast path: already attached to this element.
    if (el === attachedEl.current) return;

    // Element changed (mount, unmount, or swap) — detach from the old.
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = undefined;
    }
    attachedEl.current = el;
    if (!el || cssDrivesFade()) return;

    const update = () => {
      // 1px tolerance avoids flicker at exact scroll boundaries
      const top = el.scrollTop > 1;
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      if (el.dataset.fadeTop !== String(top)) el.dataset.fadeTop = String(top);
      if (el.dataset.fadeBottom !== String(bottom)) el.dataset.fadeBottom = String(bottom);
      // Sideways too, for a row of chips (2026-09-10). A
      // vertical caller reads neither attribute, so this costs it nothing.
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      if (el.dataset.fadeLeft !== String(left)) el.dataset.fadeLeft = String(left);
      if (el.dataset.fadeRight !== String(right)) el.dataset.fadeRight = String(right);
    };

    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    // Content size can change without the container resizing (e.g. async list
    // load, expand/collapse). Observe subtree mutations too so the fade tracks.
    const mo = new MutationObserver(update);
    mo.observe(el, { childList: true, subtree: true, characterData: true });

    cleanupRef.current = () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
      mo.disconnect();
    };
  }); // intentionally no deps — see comment above

  // Component-unmount cleanup (run once, on unmount).
  useEffect(() => () => {
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = undefined;
    }
  }, []);

  return ref;
}
