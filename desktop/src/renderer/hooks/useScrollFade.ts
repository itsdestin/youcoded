import { useEffect, useRef, type RefObject } from 'react';

// Attach to any scrollable element to hide the scrollbar and fade the
// content at whichever edge has hidden scroll room. The hook sets two
// data attributes — `data-fade-top` and `data-fade-bottom` — which the
// `.scroll-fade` CSS class reads to drive the fade pseudo-element opacity.
//
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
    if (!el) return;

    const update = () => {
      // 1px tolerance avoids flicker at exact scroll boundaries
      const top = el.scrollTop > 1;
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      if (el.dataset.fadeTop !== String(top)) el.dataset.fadeTop = String(top);
      if (el.dataset.fadeBottom !== String(bottom)) el.dataset.fadeBottom = String(bottom);
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
