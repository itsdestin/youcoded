import React from 'react';
import type { AttentionState } from '../state/chat-types';

// Banner shown in place of ThinkingIndicator when the classifier (or a
// process-exit event) concludes chat view is out of sync with what the user
// would see in Terminal view. Copy is keyed off AttentionState — keep it
// short and point the user at Terminal view when the state is ambiguous.

interface Props {
  state: Exclude<AttentionState, 'ok'>;
}

const COPY: Record<Props['state'], string> = {
  'awaiting-input': 'Response needed in Terminal view.',
  'shell-idle': 'Session is idle — open Terminal view.',
  'error': 'Error in Terminal view — check it.',
  'stuck': 'Still waiting on Claude — check Terminal view if this persists.',
  'session-died': 'Session ended unexpectedly.',
};

// Destructive states pick up the L3 destructive ring tokens so they read as
// "something went wrong" rather than just a nudge. Other states reuse the
// neutral bubble styling to stay consistent with ThinkingIndicator.
const DESTRUCTIVE: Props['state'][] = ['error', 'session-died'];

export default function AttentionBanner({ state }: Props) {
  const destructive = DESTRUCTIVE.includes(state);
  const bubbleClasses = destructive
    ? 'bg-inset rounded-2xl rounded-bl-sm px-4 py-2.5 ring-1 ring-[var(--destructive)]'
    : 'bg-inset rounded-2xl rounded-bl-sm px-4 py-2.5';
  const textClasses = destructive
    ? 'text-sm text-fg-2'
    : 'text-sm text-fg-muted italic';

  return (
    <div className="flex items-center gap-2 px-4 py-1.5">
      <div className={bubbleClasses}>
        <span className={textClasses}>{COPY[state]}</span>
      </div>
    </div>
  );
}
