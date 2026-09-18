// @vitest-environment jsdom
// SessionDrawer driven by a scripted ArtifactContext — cases that need to set the
// artifact state directly, or count the drawer's own renders.
// WHY a separate file from SessionDrawer.test.tsx: the vi.mock below replaces
// ArtifactContext for the whole file, and those cases need the real one.
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, act } from '@testing-library/react';
import { NARROW_VIEWPORT_QUERY } from '../src/renderer/hooks/use-narrow-viewport';

const mocks = vi.hoisted(() => ({ state: {} as any, dispatch: vi.fn(), listeners: new Set<() => void>(), bodyRuns: 0 }));

// WHY a subscribing fake and not a plain `() => ({ state })`: SessionDrawer is
// React.memo'd, so re-rendering it with the same props is skipped — a changed
// fake state would never reach it, while in the app a context change always
// does. This fake redraws its consumers when a test changes the state, the way
// the real ArtifactContext does.
//
// WHY it also counts calls: useArtifact is called in the drawer's own body (and its
// children's), so counting the calls counts the renders — if memo bails out, the
// body never runs and the count stays put. A React Profiler is NOT usable for
// that: it reports a commit for its own re-render as the parent updates, even
// when the child below it bailed out.
vi.mock('../src/renderer/state/ArtifactContext', async () => {
  const { useReducer, useEffect } = await import('react');
  return {
    useArtifact: () => {
      mocks.bodyRuns++;
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

// Perf cycle 2 regression guard.
//
// The session drawer's file list used to be loaded once by ChatView at session
// mount and then refreshed as a SIDE EFFECT of transcript replay: the artifact
// tool-use tracker listens to transcript events, so re-streaming a whole
// conversation's history happened to re-list its files. Paged history stopped
// streaming history through that channel and the drawer went empty — caught by
// the perf rig, whose files-drawer scenario failed twice in a row.
//
// The drawer must list its own session when it opens, against the RESOLVED
// project root.
describe('SessionDrawer lists its session when it opens', () => {
  const SESSION = 's1';
  const ROOT = '/projects/alpha';

  function baseState(drawerOpen: boolean) {
    return {
      sessionArtifacts: { [SESSION]: [] },
      drawerOpenBySession: { [SESSION]: drawerOpen },
      activeArtifactBySession: {},
      gitReviewBySession: {},
      pillError: {},
      drawerExpanded: false,
      // Added by the artifact-zoom / session-preview work merged from master.
      activeSessionPreviewBySession: {},
      referencedSessionsBySession: {},
    };
  }

  let listSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mocks.dispatch = vi.fn();
    listSession = vi.fn().mockResolvedValue({ ok: true, artifacts: [{ id: 'a1', path: `${ROOT}/perf-small.ts` }] });
    (window as any).claude = {
      artifacts: {
        listSession,
        checkExistence: vi.fn().mockResolvedValue({ ok: true, missingIds: [] }),
      },
    };
  });
  afterEach(() => cleanup());

  it('calls listSession with the RESOLVED project root and loads the rows', async () => {
    mocks.state = baseState(true);
    render(<SessionDrawer cwd="" sessionId={SESSION} projectRoot={ROOT} projectId="p" projectName="alpha" />);
    await waitFor(() => expect(listSession).toHaveBeenCalledWith(SESSION, ROOT));
    await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SESSION_ARTIFACTS_LOADED', sessionId: SESSION }),
    ));
  });

  it('does not list while the drawer is closed', () => {
    mocks.state = baseState(false);
    render(<SessionDrawer cwd="" sessionId={SESSION} projectRoot={ROOT} projectId="p" projectName="alpha" />);
    expect(listSession).not.toHaveBeenCalled();
  });

  it('does not list before the project root has resolved', () => {
    mocks.state = baseState(true);
    render(<SessionDrawer cwd="" sessionId={SESSION} projectRoot="" projectId="p" projectName="alpha" />);
    expect(listSession).not.toHaveBeenCalled();
  });
});

// The loading state for a tapped file path (2026-09-11, found on the owner's
// phone). While the lookup ran, the drawer opened onto "Nothing here yet" —
// flatly contradicting the file just tapped — and stayed there for as long as
// the lookup took. While a tap is pending the drawer now says what it is doing,
// in the same place and box as the "couldn't open" note, and neither the empty
// state nor the list's load-error state is shown underneath it.
describe('SessionDrawer while a tapped file is being looked up', () => {
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

  it('a file already open stays open with no note over it while the next tap is looked up', async () => {
    setViewport(false);
    const tracked = {
      id: 'a1', path: 'notes.md', kind: 'internal', absolutePath: null, lastModified: '', status: 'active',
      versions: [{ id: 'v1', kind: 'create', at: '', sessionId: SESSION }], comments: [], tags: [],
    };
    Object.assign((window as any).claude.artifacts, {
      get: vi.fn().mockResolvedValue({ ok: true, content: '# notes', orphan: false, binary: false, truncated: false, sizeBytes: 7, mtimeMs: 1 }),
      onChanged: () => () => {},
    });
    listSession.mockResolvedValue({ ok: true, artifacts: [tracked] });
    mocks.state = { ...baseState('CLAUDE.md'), sessionArtifacts: { [SESSION]: [tracked] }, activeArtifactBySession: { [SESSION]: 'a1' } };
    renderDrawer();
    await waitFor(() => expect(listSession).toHaveBeenCalled());
    expect(screen.queryByText('Opening CLAUDE.md…')).toBeNull();
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

// The file pane must not redraw on every streamed token.
//
// The drawer lives inside ChatView, which re-renders on every transcript event —
// so once per token of a reply. Nothing about the drawer changes during that: its
// five props are plain strings that only move when you switch conversation or
// project. Before this guard it re-rendered anyway, the whole subtree: the file
// list, the open file's viewer, the git footer.
//
// Two halves, because either alone leaves the redraw in place:
//   1. the drawer itself skips a parent re-render that changes none of its props
//   2. App hands ArtifactContext a MEMOIZED value — an inline object literal is a
//      new identity every render, which redraws every consumer of that context
//      regardless of what memo does about props
// This file pins half 1. WHY half 2 is not here (Plan B, 2026-09-16): it is one
// prop at one call site in App.tsx, pinned by the ast-grep rule
// artifact-provider-value-memoized in the workspace's scripts/ast-grep/rules/.
describe('the file pane and a streaming reply', () => {
  const SESSION = 's1';
  const ROOT = '/projects/alpha';

  beforeEach(() => {
    mocks.dispatch = vi.fn();
    mocks.state = {
      sessionArtifacts: { [SESSION]: [] },
      drawerOpenBySession: { [SESSION]: true },
      activeArtifactBySession: {},
      gitReviewBySession: {},
      pillError: {},
      drawerExpanded: false,
      activeSessionPreviewBySession: {},
      referencedSessionsBySession: {},
    };
    (window as any).claude = {
      artifacts: {
        listSession: vi.fn().mockResolvedValue({ ok: true, artifacts: [{ id: 'a1', path: `${ROOT}/perf-small.ts` }] }),
        checkExistence: vi.fn().mockResolvedValue({ ok: true, missingIds: [] }),
        onChanged: () => () => {},
      },
    };
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it('does not re-render when its parent does and its props have not changed', async () => {
    let bump: () => void = () => {};

    function Streamer() {
      // Stands in for ChatView: re-renders on every token, passing the drawer
      // the same five strings each time.
      const [tokens, setTokens] = useState(0);
      bump = () => setTokens((t) => t + 1);
      return (
        <div data-tokens={tokens}>
          <SessionDrawer sessionId={SESSION} cwd={ROOT} projectRoot={ROOT} projectId="p1" projectName="alpha" />
        </div>
      );
    }

    render(<Streamer />);
    // Let the drawer's own async work settle first, so the count below is only
    // about parent re-renders.
    await waitFor(() => expect((window as any).claude.artifacts.listSession).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });

    mocks.bodyRuns = 0;
    for (let i = 0; i < 40; i++) await act(async () => { bump(); });

    expect(mocks.bodyRuns).toBe(0);
  });
});
