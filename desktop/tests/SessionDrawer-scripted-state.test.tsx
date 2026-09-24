// @vitest-environment jsdom
// SessionDrawer driven by a scripted ArtifactContext — cases that need to set the
// artifact state directly, or count the drawer's own renders.
// WHY a separate file from SessionDrawer.test.tsx: the vi.mock below replaces
// ArtifactContext for the whole file, and those cases need the real one.
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { NARROW_VIEWPORT_QUERY } from '../src/renderer/hooks/use-narrow-viewport';

const mocks = vi.hoisted(() => ({ state: {} as any, dispatch: vi.fn(), listeners: new Set<() => void>(), bodyRuns: 0, rowRenders: 0 }));

// WHY a subscribing fake and not a plain `() => state`: SessionDrawer is
// React.memo'd, so re-rendering it with the same props is skipped — a changed
// fake state would never reach it, while in the app a store change always
// does. This fake redraws its consumers when a test changes the state, the way
// the real artifact store does.
//
// WHY it also counts calls: useArtifactDispatch is called exactly once in the
// drawer's own body, so counting the calls counts the renders — if memo bails
// out, the body never runs and the count stays put. A React Profiler is NOT
// usable for that: it reports a commit for its own re-render as the parent
// updates, even when the child below it bailed out. (useArtifactSelector is
// called several times per render, so it is not the counter.)
vi.mock('../src/renderer/state/ArtifactContext', async () => {
  const { useReducer, useEffect } = await import('react');
  return {
    useArtifactDispatch: () => {
      mocks.bodyRuns++;
      const [, redraw] = useReducer((n: number) => n + 1, 0);
      useEffect(() => {
        const listener = () => redraw();
        mocks.listeners.add(listener);
        return () => { mocks.listeners.delete(listener); };
      }, []);
      return mocks.dispatch;
    },
    useArtifactSelector: (select: (s: any) => unknown) => select(mocks.state),
  };
});

// WHY: ArtifactListItem (a file row) calls formatRelativeTime once in its own
// body on every render (and nowhere else while the list is the only thing on
// screen — the active-file footer that also calls it only mounts once a file is
// open). Counting calls to it counts ROW renders the same way `bodyRuns` above
// counts the drawer's own — a memo bail-out never reaches this call. The real
// function still runs, so every other case here sees unchanged output.
vi.mock('../src/renderer/utils/format-time', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/renderer/utils/format-time')>();
  return { ...real, formatRelativeTime: (w: number | string) => { mocks.rowRenders++; return real.formatRelativeTime(w); } };
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
//   2. App hands the artifact provider a STORE created once, and the drawer reads
//      only its own session's slice through selectors — a changing context value
//      redraws every consumer regardless of what memo does about props
// This file pins half 1. Half 2 is pinned by tests/artifact-store-selectors.test.tsx
// and, at App's one call site, by the ast-grep rule artifact-provider-stable-store
// in the workspace's scripts/ast-grep/rules/.
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

  // WHY: the file ROWS (ArtifactListItem) — half 1 above pins the whole
  // drawer skipping a PARENT re-render; this pins each row skipping the
  // DRAWER'S OWN re-renders (typing in its search box, toggling a filter…),
  // which is a different failure mode: `listedArtifacts.map()` used to hand
  // every row a freshly-built `onSelect`/`onRemove` closure on every one of
  // those renders, so a keystroke redrew every row in the list whether or not
  // that row's own file had changed.
  function mkArtifact(id: string, name: string, minutesAgo: number): any {
    const ts = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    return {
      id, path: `${ROOT}/${name}`, kind: 'internal', absolutePath: null,
      lastModified: ts, status: 'active',
      versions: [{ id: `v-${id}`, ts, sessionId: SESSION, type: 'create', author: 'agent' }],
      comments: [], tags: [],
    };
  }

  async function renderSettledDrawer() {
    const utils = render(
      <SessionDrawer sessionId={SESSION} cwd={ROOT} projectRoot={ROOT} projectId="p1" projectName="alpha" />
    );
    await waitFor(() => expect((window as any).claude.artifacts.checkExistence).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    return utils;
  }

  describe('file rows skip the drawer\'s own re-renders', () => {
    beforeEach(() => {
      mocks.state.sessionArtifacts[SESSION] = [
        mkArtifact('a1', 'perf-small.ts', 5),
        mkArtifact('a2', 'perf-big.ts', 10),
      ];
      (window as any).claude.artifacts.removeRecord = vi.fn().mockResolvedValue({ ok: true });
    });

    it('typing in the drawer search re-renders only rows whose visibility changed', async () => {
      await renderSettledDrawer();
      // Sanity: the probe is actually wired up (both rows painted once at mount)
      // — an assertion that stayed green with a broken counter would prove nothing.
      expect(mocks.rowRenders).toBeGreaterThan(0);
      mocks.rowRenders = 0;

      // Both fixtures survive every query used below ("perf" matches both file
      // names), so their VISIBILITY never changes — the nearest testable form
      // of the title's claim is therefore the zero-changed-rows case: neither
      // row should redraw at all.
      const search = screen.getByLabelText('Search files');
      fireEvent.change(search, { target: { value: 'perf' } });
      await act(async () => {});

      expect(mocks.rowRenders).toBe(0);
    });

    it('a shared row handler still uses the CURRENT sessionId, not one frozen at the first render', async () => {
      // Every row is handed the SAME onSelectId/onRemoveId for the
      // drawer's whole lifetime — unlike SkillCard's per-render-swapped
      // handler, staleness here would come from the STABLE callback closing
      // over a render-scoped value directly instead of reading it through
      // `rowActions.current`. sessionId is the cleanest value to prove this
      // with: it is a genuine SessionDrawer PROP, so re-rendering with a
      // DIFFERENT one is guaranteed to run the component body fresh (its own
      // React.memo cannot bail when a prop differs), while the component
      // instance — and so onSelectId's identity — stays the SAME across that
      // prop change, exactly the shape a "skipped render, stale value" bug
      // would hide in.
      const SESSION2 = 's2';
      mocks.state.drawerOpenBySession[SESSION2] = true;
      mocks.state.sessionArtifacts[SESSION2] = [mkArtifact('b1', 'other.ts', 1)];

      const { rerender } = await renderSettledDrawer();
      fireEvent.click(screen.getByText('perf-small.ts').closest('button')!);
      expect(mocks.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ACTIVE_ARTIFACT_SET', sessionId: SESSION, artifactId: 'a1' })
      );
      mocks.dispatch.mockClear();

      rerender(
        <SessionDrawer sessionId={SESSION2} cwd={ROOT} projectRoot={ROOT} projectId="p1" projectName="alpha" />
      );
      await waitFor(() => expect(screen.getByText('other.ts')).toBeTruthy());

      fireEvent.click(screen.getByText('other.ts').closest('button')!);
      // A stale callback (closed over SESSION='s1' from the very first render)
      // would dispatch with sessionId 's1' here. The fresh one reads the
      // CURRENT sessionId through rowActions.current.
      expect(mocks.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ACTIVE_ARTIFACT_SET', sessionId: SESSION2, artifactId: 'b1' })
      );
    });

    // Mirrors the select-freshness test above, but for onRemoveId /
    // handleRemoveRecord: the exact same "stable callback must read through
    // rowActions.current, not close over a render-scoped value" risk applies
    // here — and handleRemoveRecord ALSO depends on activeArtifactId (not just
    // sessionId), so this additionally proves "removing the currently active
    // artifact clears it" reads the CURRENT activeArtifactId, not one frozen
    // at handleRemoveRecord's very first identity.
    it('a shared row handler still removes using the CURRENT sessionId and active-artifact state, not values frozen at the first render', async () => {
      const SESSION2 = 's2';
      mocks.state.drawerOpenBySession[SESSION2] = true;
      mocks.state.sessionArtifacts[SESSION2] = [mkArtifact('b1', 'other.ts', 1)];
      // Selecting b1 mounts the content pane, which reads the file through
      // this handler — unrelated to what this test pins, so it just needs an
      // answer.
      (window as any).claude.artifacts.get = vi.fn().mockResolvedValue({ ok: true, content: '' });

      const { rerender } = await renderSettledDrawer();

      // Same trick as the select test: rerendering the SAME <SessionDrawer>
      // instance with a different sessionId PROP guarantees the component body
      // reruns fresh (React.memo only wraps the ROW, not the drawer), while
      // onSelectId/onRemoveId's identities — both useCallback(fn, []) — stay
      // the SAME functions across that change.
      rerender(
        <SessionDrawer sessionId={SESSION2} cwd={ROOT} projectRoot={ROOT} projectId="p1" projectName="alpha" />
      );
      await waitFor(() => expect(screen.getByText('other.ts')).toBeTruthy());

      // Select b1 so it becomes s2's active artifact — a non-narrow select
      // keeps the list open (keepListOpen = !narrowViewport), so the row stays
      // reachable for the remove click below.
      fireEvent.click(screen.getByText('other.ts').closest('button')!);
      expect(mocks.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ACTIVE_ARTIFACT_SET', sessionId: SESSION2, artifactId: 'b1' })
      );
      mocks.dispatch.mockClear();

      // Apply what the real reducer would do with that action. SessionDrawer
      // itself is ALSO React.memo'd (half 1 above), so a rerender with the SAME
      // sessionId prop would bail out without picking this up — a keystroke in
      // the (already-open) search box is a genuine internal state change that
      // forces a fresh render instead, the same way it would in the real app
      // once the reducer's state updates flowed back down as a new snapshot.
      mocks.state.activeArtifactBySession[SESSION2] = 'b1';
      fireEvent.change(screen.getByLabelText('Search files'), { target: { value: 'other' } });
      await act(async () => {});

      fireEvent.click(screen.getByRole('button', { name: /^Remove other\.ts from this list/ }));

      // A stale onRemoveId would still call removeRecord — its projectRoot
      // never changes in this fixture — but the ACTIVE_ARTIFACT_CLEARED
      // dispatch is where the freeze shows: it would either never fire (frozen
      // activeArtifactId=null != 'b1') or fire with sessionId 's1'. The fresh
      // handler reads both current values through rowActions.current.
      await waitFor(() =>
        expect(mocks.dispatch).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'ACTIVE_ARTIFACT_CLEARED', sessionId: SESSION2 })
        )
      );
      expect((window as any).claude.artifacts.removeRecord).toHaveBeenCalledWith(ROOT, 'b1');
    });
  });
});
