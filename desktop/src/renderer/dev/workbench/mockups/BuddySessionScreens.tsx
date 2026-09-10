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
  // ?bare=1 drops the explainer and lets the panel BE the viewport.
  //
  // WHY IT MATTERS, and it is not cosmetic: the framed version below is a 320px
  // BOX inside a browser window several hundred pixels wide, so `innerWidth` is
  // that wider number. Anything that clamps to the VIEWPORT — the model
  // picker's panel does — therefore behaves as it does in the main window, and
  // the framed page silently fails to reproduce the one condition the buddy
  // actually imposes. Screenshot this route at a 320x480 viewport with ?bare=1
  // to see what the floater really shows.
  const bare = new URLSearchParams(window.location.search).get('bare') === '1';

  const panel = (
    <div
      className="buddy-chat-panel"
      style={{
        width: bare ? '100vw' : CHAT_SIZE.width,
        height: bare ? '100vh' : CHAT_SIZE.height,
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
  );

  if (bare) return panel;

  return (
    <div className="min-h-screen bg-canvas text-fg p-8">
      <h1 className="text-sm font-semibold mb-1">Buddy floater — session screens</h1>
      <p className="text-2xs text-fg-dim mb-6 max-w-xl leading-relaxed">
        The floater&rsquo;s chat window at its real {CHAT_SIZE.width}&times;{CHAT_SIZE.height}.
        Both buttons open a pane: New Session is the form, Resume Session is the recent
        list. Everything below is live against the fake backend — pick a model, expand a
        conversation, press Create or Resume.
      </p>

      {panel}

      <p className="text-2xs text-fg-dim mt-4 max-w-xl leading-relaxed">
        Add <code className="text-fg">&amp;bare=1</code> and size the window to
        320&times;480 to reproduce the floater&rsquo;s real viewport — the only way to see
        how a popover that clamps to the viewport actually lands there.
      </p>

      {created && (
        <p className="text-2xs text-fg-dim mt-4">
          Started session <code className="text-fg">{created}</code>. In the real floater the
          screen would now be the conversation.
        </p>
      )}
    </div>
  );
}
