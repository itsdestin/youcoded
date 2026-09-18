// @vitest-environment jsdom
// terminal-right-slot-session-key.test.tsx
//
// Pins the fix for the terminal-view cross-session drawer bleed (filed from
// the PR #304 review). Chat view mounts one SessionDrawer PER SESSION
// (App.tsx keys each ChatView with key={s.id} and passes a fixed sessionId),
// so per-session drawer state — open file, scroll, review state, a late git
// discard failure banner — is isolated by construction. TerminalRightSlot is
// a single overlay bound to the ACTIVE session: without a key, switching
// sessions reuses the same SessionDrawer instance, so state accumulated under
// session A (e.g. a discard-failed banner that landed after the switch) was
// painted into session B's drawer. PR #304's discardRunRef token guard covers
// close/reopen of one instance, not the cross-session reuse.
//
// The invariant: TerminalRightSlot must key the drawer by session id so a
// session switch REMOUNTS it with fresh state, matching chat view's
// per-session isolation.

import React, { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

afterEach(cleanup);

// Stub the drawer with a component holding local state, exactly the shape of
// the bug: state set while session A was active must not survive into session
// B. If TerminalRightSlot drops the key={sessionId}, React reuses this
// instance across the prop change and the assertion below fails.
vi.mock('../src/renderer/components/SessionDrawer', () => ({
  SessionDrawer: ({ sessionId }: { sessionId: string }) => {
    const [banner, setBanner] = useState<string | null>(null);
    return (
      <div data-testid="drawer-stub" data-session={sessionId}>
        {banner && <div data-testid="banner">{banner}</div>}
        <button onClick={() => setBanner(`discard failed in ${sessionId}`)}>
          trigger banner
        </button>
      </div>
    );
  },
}));

// useActiveProject hits window.claude.artifacts over IPC — irrelevant here.
vi.mock('../src/renderer/hooks/useActiveProject', () => ({
  useActiveProject: () => null,
}));

import TerminalRightSlot from '../src/renderer/components/TerminalRightSlot';

function renderSlot(sessionId: string) {
  return render(
    <TerminalRightSlot
      sessionId={sessionId}
      cwd="/home/u/proj"
      gamePane={null}
      drawerOpen={true}
      expanded={false}
    />,
  );
}

describe('TerminalRightSlot session keying', () => {
  it('remounts the drawer on session switch so per-session state cannot cross-paint', () => {
    const { rerender } = renderSlot('session-a');

    // Accumulate per-session drawer state under session A (stands in for the
    // late discard-failure banner, open tabs, scroll, review state...).
    fireEvent.click(screen.getByText('trigger banner'));
    expect(screen.getByTestId('banner').textContent).toBe('discard failed in session-a');

    // Switch the active session — same single overlay, new sessionId prop.
    rerender(
      <TerminalRightSlot
        sessionId="session-b"
        cwd="/home/u/proj"
        gamePane={null}
        drawerOpen={true}
        expanded={false}
      />,
    );

    // Fresh mount: session A's banner must NOT be visible in session B's drawer.
    expect(screen.getByTestId('drawer-stub').dataset.session).toBe('session-b');
    expect(screen.queryByTestId('banner')).toBeNull();
  });

  it('keeps the drawer mounted (state intact) when the session does NOT change', () => {
    const { rerender } = renderSlot('session-a');
    fireEvent.click(screen.getByText('trigger banner'));

    // Re-render the SLOT ITSELF with an identical sessionId — this is what a
    // parent state change does in production. The key is the SESSION id, not
    // something that churns every render (a key={Math.random()} would fail
    // here): the drawer instance must survive, state intact.
    rerender(
      <TerminalRightSlot
        sessionId="session-a"
        cwd="/home/u/proj"
        gamePane={null}
        drawerOpen={true}
        expanded={false}
      />,
    );
    expect(screen.getByTestId('banner').textContent).toBe('discard failed in session-a');
  });
});
