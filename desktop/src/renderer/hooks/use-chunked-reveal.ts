// The ONE way a long list of cards/rows is drawn: a window of CHUNK items that
// grows as the user scrolls toward its end. Extracted from ResumeBrowser.tsx
// (f8ca631b, 2026-07-31) where it took opening 1,642 conversations from 804 ms
// to 96 ms and DOM from 37,920 to 1,585 nodes, flat at 4,000 rows.
//
// Deliberately NOT virtualization: rows here are variable-height, grow when
// opened, and sit in containers whose scroll-fade reads real content height
// (docs/archive/handoffs/2026-07-31-resume-browser-load-time-handoff.md).
// Timelines use hooks/use-entry-folding.ts instead; collapsed previews slice.
import { useCallback, useEffect, useRef, useState } from 'react';

export const REVEAL_CHUNK = 50;

export interface ChunkedReveal<T> {
  visible: readonly T[];
  hasMore: boolean;
  sentinelRef: (el: HTMLElement | null) => void;
}

export function useChunkedReveal<T>(
  items: readonly T[],
  { resetKey, rootRef, active = true, resetScrollOnActivate = true, chunk = REVEAL_CHUNK }: {
    resetKey: string;
    rootRef: React.RefObject<HTMLElement | null>;
    active?: boolean;
    resetScrollOnActivate?: boolean;
    chunk?: number;
  },
): ChunkedReveal<T> {
  const [count, setCount] = useState(chunk);

  // Reset keyed on the query VALUES, deliberately not on `items`' identity:
  // items also change when a row mutates (tag, complete, rename), and resetting
  // then would collapse the list under a user who scrolled down to organise it.
  // Adjusted DURING render (React's documented pattern), not in an effect — an
  // effect would commit one render at the OLD, large count first.
  const [lastKey, setLastKey] = useState(resetKey);
  if (resetKey !== lastKey) {
    setLastKey(resetKey);
    setCount(chunk);
  }

  // A new query starts at the top. Load-bearing: resetting the count while the
  // container stays scrolled deep leaves the sentinel in view, and the observer
  // cascades straight back (measured: 250 rows re-revealed instead of 50).
  //
  // Two triggers, kept apart: a NEW QUERY always scrolls to the top; becoming
  // ACTIVE again does so only when the host wants it (the Resume browser reopens
  // at the top; the Files tab, hidden and shown with the same search, must not
  // jump). A query that changed while inactive is caught on activation because
  // scrolledKey is only advanced while active.
  const wasActive = useRef(false);
  const scrolledKey = useRef<string | null>(null);
  useEffect(() => {
    if (!active) { wasActive.current = false; return; }
    const activated = !wasActive.current;
    wasActive.current = true;
    const keyChanged = scrolledKey.current !== resetKey;
    scrolledKey.current = resetKey;
    if (!keyChanged && !(activated && resetScrollOnActivate)) return;
    const el = rootRef.current;
    if (el) el.scrollTop = 0;
  }, [resetKey, active, rootRef, resetScrollOnActivate]);

  const hasMore = items.length > count;
  const visible = hasMore ? items.slice(0, count) : items;

  // The sentinel is held in STATE through a callback ref, not a ref object, on
  // purpose: a host that swaps the sentinel element without changing the count
  // (FilesTab grid ↔ list view) would leave a ref-object version observing the
  // detached element forever — no dep changes, so the effect never re-arms. The
  // cost is one extra host render when the sentinel mounts; rows are memoised.
  const [sentinel, setSentinel] = useState<HTMLElement | null>(null);
  const sentinelRef = useCallback((el: HTMLElement | null) => setSentinel(el), []);

  // Re-arming on every count change is what makes it cascade until the
  // sentinel is past the margin (short rows, tall window).
  useEffect(() => {
    if (!active || !hasMore) return;
    // No observer (jsdom, exotic WebView): draw everything rather than strand
    // the list at one chunk with no way to grow.
    if (typeof IntersectionObserver === 'undefined') { setCount(items.length); return; }
    if (!sentinel) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) setCount((n) => n + chunk); },
      { root: rootRef.current, rootMargin: '400px 0px' },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [active, hasMore, count, items.length, sentinel, rootRef, chunk]);

  return { visible, hasMore, sentinelRef };
}
