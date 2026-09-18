// @vitest-environment jsdom
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
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup, waitFor, fireEvent, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ state: {} as any, dispatch: vi.fn(), bodyRuns: 0, rowRenders: 0 }));

// useArtifact is called in the drawer's own body (and its children's). Counting
// the calls counts the renders — if memo bails out, the body never runs, so this
// stays put. A React Profiler is NOT usable here: it reports a commit for its own
// re-render as the parent updates, even when the child below it bailed out.
vi.mock('../src/renderer/state/ArtifactContext', () => ({
  useArtifact: () => { mocks.bodyRuns++; return { state: mocks.state, dispatch: mocks.dispatch }; },
}));

// Task 12: ArtifactListItem (the row) calls formatRelativeTime once in its own
// body on every render (and nowhere else while the list is the only thing on
// screen — the active-file footer that also calls it only mounts once a file
// is open). Counting calls to it counts ROW renders the same way `bodyRuns`
// above counts the drawer's own — a memo bail-out never reaches this call.
vi.mock('../src/renderer/utils/format-time', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/renderer/utils/format-time')>();
  return { ...real, formatRelativeTime: (w: number | string) => { mocks.rowRenders++; return real.formatRelativeTime(w); } };
});

import { SessionDrawer } from '../src/renderer/components/SessionDrawer';

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

describe('the file pane and a streaming reply', () => {
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

// Task 12: the file ROWS (ArtifactListItem) — half 1 above pins the whole
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

describe('row memoisation (Task 12)', () => {
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
    // Every row is handed the SAME onSelectId/onRemoveId (Task 12) for the
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
});
