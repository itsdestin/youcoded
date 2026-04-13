import React from 'react';
import type { AttentionState } from '../state/chat-types';
import BrailleSpinner from './BrailleSpinner';

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
  const bubbleBase = 'flex items-center gap-2 bg-inset rounded-2xl rounded-bl-sm px-4 py-2.5';
  const bubbleClasses = destructive
    ? `${bubbleBase} ring-1 ring-[var(--destructive)]`
    : bubbleBase;
  const textClasses = destructive
    ? 'text-sm text-fg-2'
    : 'text-sm text-fg-muted italic';
  // Show the spinner for every state except session-died — that one signals
  // the process is gone, so a spinning indicator would be misleading.
  const showSpinner = state !== 'session-died';

  return (
    // in-view: opts the bubble into wallpaper-driven bubble glassmorphism
    // (theme-engine targets `.in-view .bg-inset`), matching ThinkingIndicator.
    <div className="flex items-center gap-2 px-4 py-1.5 in-view">
      <div className={bubbleClasses}>
        {showSpinner && <BrailleSpinner size="base" />}
        <span className={textClasses}>{COPY[state]}</span>
      </div>
    </div>
  );
}
