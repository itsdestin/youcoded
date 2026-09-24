// A container-width breakpoint, not a viewport one. useNarrowViewport()
// answers "is the whole app window phone-width" — but the doc-comments
// margin lives inside the file viewer PANE, which is a fixed ~480px
// (--right-pane-width) regardless of how wide the app window is (SessionDrawer
// stays 480px on a 2000px-wide desktop monitor just as much as on a 700px
// one). Measuring the window here would never collapse the margin in the one
// place it actually runs out of room. ResizeObserver on the pane itself is
// the correct source of truth — ProjectView's file tab (full-width) never
// collapses; SessionDrawer's fixed-width pane always does.
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Own-ref form: creates and returns the ref to attach. */
export function useContainerNarrow<T extends HTMLElement>(thresholdPx: number): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const narrow = useNarrowByRef(ref, thresholdPx);
  return [ref, narrow];
}

/** Existing-ref form: a host that already has its own root ref (e.g.
 *  ActiveArtifactView's rootRef) observes it directly instead of attaching a
 *  second ref to the same node. */
export function useNarrowByRef<T extends HTMLElement>(ref: RefObject<T | null>, thresholdPx: number): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) setNarrow(width < thresholdPx);
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ref identity is stable
  }, [thresholdPx]);
  return narrow;
}
