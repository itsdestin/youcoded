import React from 'react';
import { Button } from './ui';
import BrailleSpinner from './BrailleSpinner';

export type HandoffFreshnessPhase = 'waiting' | 'incomplete' | 'confirmed';

/** WHY float in the chat pane, not the input chrome: saved history is already
 * open; the composer stays editable but cannot submit until the choice resolves. */
export const HandoffFreshnessInline = React.forwardRef<HTMLDivElement, {
  phase: HandoffFreshnessPhase;
  onRetry: () => void;
  onContinue: () => void;
}>(function HandoffFreshnessInline({ phase, onRetry, onContinue }, ref) {
  if (phase === 'confirmed') return null;
  return (
    // WHY use pane-local insets: full chat-column width, not viewport/drawer.
    <div ref={ref} className="handoff-freshness-toast absolute inset-x-3">
      <div className="layer-surface px-4 py-3 text-sm text-fg-2">
        {phase === 'waiting' ? (
          <div role="status" className="flex items-center gap-2">
            <BrailleSpinner size="sm" />
            <span>Still syncing recent messages, this may take a moment.</span>
          </div>
        ) : (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0">This conversation may have newer messages on your other computer.</span>
            {/* Keep both choices together when they move below the copy on a phone. */}
            <div className="flex flex-nowrap items-center gap-2 ml-auto max-w-full">
              <Button variant="secondary" size="sm" onClick={onContinue}>Continue with these messages</Button>
              <Button variant="primary" size="sm" onClick={onRetry}>Try again</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
