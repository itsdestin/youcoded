import { useEffect, useRef, type RefObject } from 'react';

// Attach to any scrollable element to hide the scrollbar and fade the
// content at whichever edge has hidden scroll room. The hook sets two
// data attributes — `data-fade-top` and `data-fade-bottom` — which the
// `.scroll-fade` CSS class reads to drive a mask-image gradient.
//
// Why data attrs instead of inline style or class toggles: attribute
// writes are cheap, don't cause React re-renders, and the CSS rule
// stays the single source of truth for the fade size.
export function useScrollFade<T extends HTMLElement>(externalRef?: RefObject<T | null>) {
  const internalRef = useRef<T>(null);
  const ref = externalRef ?? internalRef;

  useEffect(() => {
    const el = ref.current;
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

    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  return ref;
}
