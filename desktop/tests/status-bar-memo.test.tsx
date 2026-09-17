// @vitest-environment jsdom
// The status bar and the header do not redraw when something unrelated in
// the shell changes (2026-09-16 audit W21).
//
// App used to build the bar's statusData object and every handler inline in
// JSX, so any of the shell's ~60 state changes — a toast, a popup — re-rendered
// both bars whether or not anything they show had changed. The projection is
// now memoised (hooks/useStatusBarProps.ts), the handlers are callbacks, and
// both components are React.memo. Renders are counted from INSIDE each bar —
// a hook it calls on every render is wrapped to count — because a Profiler
// around a memo'd child fires whenever the parent re-creates the element,
// bail-out or not. Driven through the parent's REAL state changes, as
// root-selectors-skip-token-rerenders does: an unrelated tick → 0 renders; a
// status push that changes the session's context → the status bar renders,
// the header does not.
import React, { useCallback, useState } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';

const renders = vi.hoisted(() => ({ status: 0, header: 0 }));
vi.mock('../src/renderer/state/theme-context', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/renderer/state/theme-context')>();
  return { ...real, useTheme: () => { renders.status++; return real.useTheme(); } };
});
vi.mock('../src/renderer/hooks/use-narrow-viewport', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/renderer/hooks/use-narrow-viewport')>();
  return { ...real, useNarrowViewport: () => { renders.header++; return real.useNarrowViewport(); } };
});

import { makeStoreWrapper } from './helpers/chat-store-harness';
import StatusBar from '../src/renderer/components/StatusBar';
import HeaderBar from '../src/renderer/components/HeaderBar';
import { ArtifactContext } from '../src/renderer/state/ArtifactContext';
import { useStatusBarData } from '../src/renderer/hooks/useStatusBarProps';

const feed0 = {
  usage: null, chatgptUsage: null, updateStatus: null, announcement: null,
  contextMap: { s1: 80 } as Record<string, number>,
  gitBranchMap: {} as Record<string, string>,
  sessionStatsMap: {} as Record<string, any>,
  syncWarnings: null,
};
type Feed = typeof feed0;

let api: { setTick: (n: number) => void; setFeed: (f: Feed) => void } | null = null;

function Parent() {
  const [feed, setFeed] = useState<Feed>(feed0);
  const [tick, setTick] = useState(0);
  api = { setTick, setFeed };
  const statusData = useStatusBarData(feed, 's1', false);
  const onOpenSync = useCallback(() => {}, []);
  const noop = useCallback(() => {}, []);
  const sessions = React.useMemo(() => [{ id: 's1', name: 'One', provider: 'claude', cwd: '/x', status: 'active' }], []);
  return (
    <>
      <span data-testid="tick">{tick}</span>
      <HeaderBar
        sessions={sessions as any} activeSessionId="s1"
        onSelectSession={noop} onCreateSession={noop as any} onCloseSession={noop}
        viewMode="chat" onToggleView={noop}
        gamePanelOpen={false} onToggleGamePanel={noop} gameConnected={false} challengePending={false}
        settingsOpen={false} onToggleSettings={noop} onOpenResumeBrowser={noop}
      />
      <StatusBar statusData={statusData} provider="claude" sessionId="s1" onOpenSync={onOpenSync} />
    </>
  );
}

beforeEach(() => {
  (window as any).localStorage = {
    _s: {} as Record<string, string>,
    getItem(k: string) { return this._s[k] ?? null; },
    setItem(k: string, v: string) { this._s[k] = v; },
    removeItem(k: string) { delete this._s[k]; },
  };
  (window as any).matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
  (window as any).claude = {
    tags: { list: async () => [] },
    session: { getMeta: async () => ({}) },
    on: { tagsChanged: () => () => {}, sessionMetaChanged: () => () => {} },
  };
});
afterEach(() => { cleanup(); api = null; delete (window as any).claude; });

function mount() {
  const { wrapper: Store } = makeStoreWrapper(['s1']);
  const artifact = { state: { sessionArtifacts: {}, drawerOpenBySession: {} } as any, dispatch: vi.fn() };
  render(
    <Store>
      <ArtifactContext.Provider value={artifact as any}>
        <Parent />
      </ArtifactContext.Provider>
    </Store>,
  );
  // Both bars rendered at least once on mount — the counters can see them.
  expect(renders.status).toBeGreaterThan(0);
  expect(renders.header).toBeGreaterThan(0);
  renders.status = 0;
  renders.header = 0;
}

describe('the two bars and an unrelated shell state change', () => {
  it('a state change the bars do not read re-renders neither of them', () => {
    mount();
    act(() => { api!.setTick(1); });
    act(() => { api!.setTick(2); });
    expect(renders).toEqual({ status: 0, header: 0 });
  });

  it('a status push with the same values (a fresh feed object) re-renders neither', () => {
    mount();
    act(() => { api!.setFeed({ ...feed0, contextMap: { s1: 80 } }); });
    expect(renders).toEqual({ status: 0, header: 0 });
  });

  it('a status push that changes this session\'s context re-renders the status bar, not the header', () => {
    mount();
    act(() => { api!.setFeed({ ...feed0, contextMap: { s1: 40 } }); });
    expect(renders.status).toBeGreaterThan(0);
    expect(renders.header).toBe(0);
  });
});
