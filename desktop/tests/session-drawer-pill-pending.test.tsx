// @vitest-environment jsdom
// The loading state for a tapped file path (2026-09-11, found on the owner's
// phone). While the lookup ran, the drawer opened onto "Nothing here yet" —
// flatly contradicting the file just tapped — and stayed there for as long as
// the lookup took. While a tap is pending the drawer now says what it is doing,
// in the same place and box as the "couldn't open" note, and neither the empty
// state nor the list's load-error state is shown underneath it.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, act } from '@testing-library/react';
import { NARROW_VIEWPORT_QUERY } from '../src/renderer/hooks/use-narrow-viewport';

const mocks = vi.hoisted(() => ({ state: {} as any, dispatch: vi.fn(), listeners: new Set<() => void>() }));

// WHY a subscribing fake and not a plain `() => ({ state })`: SessionDrawer is
// React.memo'd, so re-rendering it with the same props is skipped — a changed
// fake state would never reach it, while in the app a context change always
// does. This fake redraws its consumers when a test changes the state, the way
// the real ArtifactContext does.
vi.mock('../src/renderer/state/ArtifactContext', async () => {
  const { useReducer, useEffect } = await import('react');
  return {
    useArtifact: () => {
      const [, redraw] = useReducer((n: number) => n + 1, 0);
      useEffect(() => {
        const listener = () => redraw();
        mocks.listeners.add(listener);
        return () => { mocks.listeners.delete(listener); };
      }, []);
      return { state: mocks.state, dispatch: mocks.dispatch };
    },
  };
});

import { SessionDrawer } from '../src/renderer/components/SessionDrawer';

const SESSION = 's1';
const ROOT = '/projects/alpha';

function baseState(pending: string | null) {
  return {
    sessionArtifacts: { [SESSION]: [] },
    drawerOpenBySession: { [SESSION]: true },
    activeArtifactBySession: {},
    gitReviewBySession: {},
    pillError: {},
    pillPending: { [SESSION]: pending },
    drawerExpanded: false,
    activeSessionPreviewBySession: {},
    referencedSessionsBySession: {},
  };
}

/** Change the fake artifact state the way a context update would. */
function setArtifactState(next: ReturnType<typeof baseState>) {
  act(() => {
    mocks.state = next;
    for (const listener of mocks.listeners) listener();
  });
}

/** Declare the viewport (jsdom has no matchMedia; its absence reads as wide). */
function setViewport(narrow: boolean) {
  (window as any).matchMedia = (query: string) => ({
    matches: narrow && query === NARROW_VIEWPORT_QUERY,
    media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  });
}

let listSession: ReturnType<typeof vi.fn>;
const originalMatchMedia = (window as any).matchMedia;

beforeEach(() => {
  mocks.dispatch = vi.fn();
  listSession = vi.fn().mockResolvedValue({ ok: true, artifacts: [] });
  (window as any).claude = {
    artifacts: {
      listSession,
      checkExistence: vi.fn().mockResolvedValue({ ok: true, missingIds: [] }),
    },
  };
});
afterEach(() => {
  cleanup();
  mocks.listeners.clear();
  (window as any).matchMedia = originalMatchMedia;
});

function renderDrawer() {
  return render(<SessionDrawer sessionId={SESSION} cwd={ROOT} projectRoot={ROOT} projectId="p" projectName="alpha" />);
}

describe('SessionDrawer while a tapped file is being looked up', () => {
  it('says "Opening <name>…", politely announced, and not "Nothing here yet"', async () => {
    setViewport(false);
    mocks.state = baseState('CLAUDE.md');
    renderDrawer();
    await waitFor(() => expect(listSession).toHaveBeenCalled());
    const note = screen.getByText('Opening CLAUDE.md…');
    expect(note.getAttribute('aria-live')).toBe('polite');
    expect(screen.queryByText(/Nothing here yet/)).toBeNull();
  });

  it('control: with nothing pending the empty state is shown (so the check above is not vacuous)', async () => {
    setViewport(false);
    mocks.state = baseState(null);
    renderDrawer();
    await waitFor(() => expect(screen.getByText(/Nothing here yet/)).toBeTruthy());
    expect(screen.queryByText(/^Opening /)).toBeNull();
  });

  it("hides the list's load-error state too while pending — and shows it again once nothing is", async () => {
    setViewport(false);
    listSession.mockRejectedValue(new Error('socket closed'));
    // Signal first: with nothing pending, wait until the load error is really on
    // screen. Checking "absent while pending" before that point would pass
    // whether or not the drawer hides it.
    mocks.state = baseState(null);
    renderDrawer();
    await screen.findByText(/Couldn’t load this chat’s files/);

    setArtifactState(baseState('CLAUDE.md'));
    expect(screen.queryByText(/Couldn’t load this chat’s files/)).toBeNull();
    expect(screen.getByText('Opening CLAUDE.md…')).toBeTruthy();

    setArtifactState(baseState(null));
    expect(screen.getByText(/Couldn’t load this chat’s files/)).toBeTruthy();
    expect(screen.queryByText(/^Opening /)).toBeNull();
  });

  it('shows the note on a phone-width screen as well', async () => {
    setViewport(true);
    mocks.state = baseState('report.xlsx');
    renderDrawer();
    await waitFor(() => expect(listSession).toHaveBeenCalled());
    expect(screen.getByText('Opening report.xlsx…')).toBeTruthy();
    expect(screen.queryByText(/Nothing here yet/)).toBeNull();
  });
});
