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
import React, { useState } from 'react';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ state: {} as any, dispatch: vi.fn(), bodyRuns: 0 }));

// useArtifact is called in the drawer's own body (and its children's). Counting
// the calls counts the renders — if memo bails out, the body never runs, so this
// stays put. A React Profiler is NOT usable here: it reports a commit for its own
// re-render as the parent updates, even when the child below it bailed out.
vi.mock('../src/renderer/state/ArtifactContext', () => ({
  useArtifact: () => { mocks.bodyRuns++; return { state: mocks.state, dispatch: mocks.dispatch }; },
}));

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

  it('App gives ArtifactContext a memoized value, not a fresh object per render', () => {
    // A rendering test for App would need the entire shell stood up; the
    // invariant is one prop at one call site, so read it. Without this, memo
    // above still passes while every context consumer redraws per token.
    const src = fs.readFileSync(path.join(__dirname, '../src/renderer/App.tsx'), 'utf8');
    const call = src.match(/<ArtifactProvider[^>]*>/);
    expect(call, '<ArtifactProvider> not found in App.tsx').toBeTruthy();
    expect(call![0]).not.toMatch(/value=\{\{/);          // the inline-literal form
    expect(call![0]).toContain('value={artifactContextValue}');
    expect(src).toMatch(/const artifactContextValue = useMemo\(/);
  });
});
