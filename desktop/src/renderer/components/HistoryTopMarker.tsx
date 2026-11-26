import React, { useCallback, useRef, useState } from 'react';
import { ErrorState } from './ui';

/**
 * The top of the chat list while older messages exist: the invisible marker whose appearance loads the previous page, or — after a
 * page really failed to load — the thin notice with Try again (card #134). The marker is removed while the notice shows so a
 * still-visible marker cannot re-fire the failing read in a loop. Lives here to keep ChatView inside its line budget.
 */
export function HistoryTopMarker({ failed, sentinelRef, onRetry }: {
  failed: boolean; sentinelRef: React.Ref<HTMLDivElement>; onRetry: () => void;
}) {
  // WHY no scroll code here any more (round 4 review): the box used to nudge scrollTop by its own height, which jumped a short
  // conversation up a box when the browser had already clamped scrollTop on removal, and walked up the parent chain with
  // getComputedStyle on each toggle. ChatView now holds the reader's place with its element anchor (captureScrollAnchor), the same
  // mechanism a prepended page uses.
  if (!failed) return <div ref={sentinelRef} data-history-sentinel className="h-px" aria-hidden="true" />;
  return (
    <div className="px-4 pt-2" data-history-failed-box>
      <ErrorState variant="inline" message="Couldn't load earlier messages." onRetry={onRetry} />
    </div>
  );
}

/**
 * The "couldn't load earlier messages" flag, whose box appears/disappears ABOVE the messages. WHY here (round 4 review): the box used
 * to nudge scrollTop by its own height, which double-corrected when the browser had already clamped scrollTop on removal. Now a real
 * change of the flag captures ChatView's element anchor (captureScrollAnchor, the same one a prepended page uses) and ChatView's
 * layout effect puts the topmost visible entry back where it was in the document, so the result is exact whatever the browser
 * clamped. A reader at the very top (scrollTop 0) is left alone so the notice is seen.
 */
export function useHeldFlag<A>(
  scrollerRef: React.RefObject<HTMLElement | null>, anchorRef: React.MutableRefObject<A | null>, capture: () => A | null,
): [boolean, (next: boolean) => void] {
  const [value, setRaw] = useState(false);
  const live = useRef(false);
  const set = useCallback((next: boolean) => {
    if (live.current === next) return;
    live.current = next;
    if ((scrollerRef.current?.scrollTop ?? 0) > 0) anchorRef.current = capture();
    setRaw(next);
  }, [scrollerRef, anchorRef, capture]);
  return [value, set];
}
