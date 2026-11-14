import React from 'react';
import { ErrorState } from './ui';

/**
 * The top of the chat list while older messages exist: the invisible marker whose appearance loads the previous page, or — after a
 * page really failed to load — the thin notice with Try again (card #134). The marker is removed while the notice shows so a
 * still-visible marker cannot re-fire the failing read in a loop. Lives here to keep ChatView inside its line budget.
 */
export function HistoryTopMarker({ failed, sentinelRef, onRetry }: {
  failed: boolean; sentinelRef: React.Ref<HTMLDivElement>; onRetry: () => void;
}) {
  if (!failed) return <div ref={sentinelRef} data-history-sentinel className="h-px" aria-hidden="true" />;
  return (
    <div className="px-4 pt-2">
      <ErrorState variant="inline" message="Couldn't load earlier messages." onRetry={onRetry} />
    </div>
  );
}
