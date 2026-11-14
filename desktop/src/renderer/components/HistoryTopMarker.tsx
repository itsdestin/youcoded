import React, { useLayoutEffect, useRef } from 'react';
import { ErrorState } from './ui';

/**
 * The top of the chat list while older messages exist: the invisible marker whose appearance loads the previous page, or — after a
 * page really failed to load — the thin notice with Try again (card #134). The marker is removed while the notice shows so a
 * still-visible marker cannot re-fire the failing read in a loop. Lives here to keep ChatView inside its line budget.
 */
export function HistoryTopMarker({ failed, sentinelRef, onRetry }: {
  failed: boolean; sentinelRef: React.Ref<HTMLDivElement>; onRetry: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  // The box appears above the messages. A reader who has scrolled down must not see the page jump by the box's height, so the
  // scroll position moves with it (and moves back when the box goes). A reader parked at the very top simply sees the notice.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!failed || !box) return;
    let parent: HTMLElement | null = box.parentElement;
    while (parent && getComputedStyle(parent).overflowY !== 'auto' && getComputedStyle(parent).overflowY !== 'scroll') parent = parent.parentElement;
    if (!parent || parent.scrollTop <= 0) return;
    const h = box.offsetHeight;
    parent.scrollTop += h;
    return () => { parent!.scrollTop = Math.max(0, parent!.scrollTop - h); };
  }, [failed]);
  if (!failed) return <div ref={sentinelRef} data-history-sentinel className="h-px" aria-hidden="true" />;
  return (
    <div ref={boxRef} className="px-4 pt-2">
      <ErrorState variant="inline" message="Couldn't load earlier messages." onRetry={onRetry} />
    </div>
  );
}
