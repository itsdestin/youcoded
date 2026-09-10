// src/renderer/dev/workbench/mockups/BuddySessionScreens.tsx
//
// The buddy floater's empty screen — "No Active Session" plus its New Session
// and Resume Session panes — at the floater's REAL size, against the mock
// backend, so all three panes can be clicked through and judged in every theme
// without launching a dev Electron instance and waiting for a buddy window.
//
// The frame is 320x480 because that is CHAT_SIZE (shared/buddy-geometry.ts).
// Getting that width wrong is the whole point of this page: the model picker's
// panel has a 320px minimum, so anything WIDER than the real window here would
// hide the exact clipping this surface was rebuilt to fix.
//
// Renders the SHIPPING <BuddyWelcome/>, so this page cannot drift from the
// floater. Reached at ?mode=workbench&child=1&view=buddy-session (routing in
// index.tsx). Dev-only, like the rest of dev/.

import React from 'react';
import { BuddyWelcome } from '../../../components/buddy/BuddyWelcome';
import { CHAT_SIZE } from '../../../../shared/buddy-geometry';

export function BuddySessionScreensMockup() {
  const [created, setCreated] = React.useState<string | null>(null);
  return (
    <div className="min-h-screen bg-canvas text-fg p-8">
      <h1 className="text-sm font-semibold mb-1">Buddy floater — session screens</h1>
      <p className="text-2xs text-fg-dim mb-6 max-w-xl leading-relaxed">
        The floater&rsquo;s chat window at its real {CHAT_SIZE.width}&times;{CHAT_SIZE.height}.
        Both buttons open a pane: New Session is the form, Resume Session is the recent
        list. Everything below is live against the fake backend — pick a model, expand a
        conversation, press Create or Resume.
      </p>

      <div
        className="buddy-chat-panel"
        style={{
          width: CHAT_SIZE.width,
          height: CHAT_SIZE.height,
          // Matches BuddyChat's own shell padding so the panes sit where they
          // really sit — a mock-up with different padding measures nothing.
          padding: '12px 10px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <BuddyWelcome onSessionCreated={setCreated} />
        </div>
      </div>

      {created && (
        <p className="text-2xs text-fg-dim mt-4">
          Started session <code className="text-fg">{created}</code>. In the real floater the
          screen would now be the conversation.
        </p>
      )}
    </div>
  );
}
