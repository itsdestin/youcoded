// @vitest-environment jsdom
// Switching to a conversation a phone is not watching: its content arrives through a fill, and no frame in between draws it as an empty
// conversation (one-core R5-3). Component level: the real ChatView and the real useRemoteWatch, with a stand-in for the computer.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, act, cleanup } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  state: {
    timeline: [] as any[], queuedMessages: [] as any[], toolCalls: new Map(), toolGroups: new Map(), assistantTurns: new Map(),
    activeTurnToolIds: new Set(), isThinking: false, promptProcessing: null, attentionState: 'ok', errorMessage: null, stallWarning: null,
    lastActivityAt: 0, lastOutputAt: 0, modelState: 'idle', modelInfo: null, modelLoadedBytes: 0, modelEverResident: false,
    history: { cursor: null, hasMore: false, loading: false },
  } as any,
  artifact: { drawerOpenBySession: {} as Record<string, boolean>, drawerExpanded: false },
}));
vi.mock('../src/renderer/state/chat-context', () => ({ useChatState: () => mocks.state, useChatDispatch: () => vi.fn() }));
vi.mock('../src/renderer/components/SessionDrawer', () => ({ SessionDrawer: () => <div>Files</div> }));
vi.mock('../src/renderer/state/ArtifactContext', () => ({
  useArtifactSelector: (select: (s: any) => unknown) => select(mocks.artifact),
  useArtifactDispatch: () => vi.fn(),
  useArtifactStoreOptional: () => null,
}));
if (typeof (globalThis as any).IntersectionObserver === 'undefined') {
  (globalThis as any).IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
}

vi.mock('../src/renderer/utils/sounds', () => ({ playSound: vi.fn() }));
import { playSound } from '../src/renderer/utils/sounds';
import { useSessionSummaries } from '../src/renderer/hooks/useSessionSummaries';
import ChatView from '../src/renderer/components/ChatView';
import { useRemoteWatch } from '../src/renderer/hooks/useRemoteWatch';
import type { FirstPageLoader } from '../src/renderer/state/first-page-loader';

const HINT = 'Start a conversation';
const CATCHING_UP = 'Catching up with your computer';

describe('a conversation the phone is not watching yet', () => {
  beforeEach(() => { cleanup(); mocks.state.timeline = []; });
  afterEach(() => cleanup());

  it('shows "catching up" from the very first frame, never an empty conversation, and then its content', () => {
    const frames: string[] = [];
    const draw = (container: HTMLElement) => frames.push(container.textContent ?? '');
    // The frame the switch is drawn in: the conversation is chosen, nothing has arrived.
    const { container, rerender } = render(<ChatView sessionId="far" visible sessionActive provider="claude" filling />);
    draw(container);
    // The fill lands: the conversation has its messages.
    mocks.state.timeline = [{ kind: 'user', message: { id: 'u1', role: 'user', content: 'hello from the other session', timestamp: 1 } }];
    rerender(<ChatView sessionId="far" visible sessionActive provider="claude" filling={false} />);
    draw(container);
    expect(frames[0]).toContain(CATCHING_UP);
    expect(frames[0]).not.toContain(HINT);
    for (const f of frames) expect(f, 'a frame drew an empty conversation').not.toContain(HINT);
    expect(frames[1]).not.toContain(CATCHING_UP);
  });

  it('a conversation the phone already holds is shown at once while it catches up, with no strip over it', () => {
    mocks.state.timeline = [{ kind: 'user', message: { id: 'u1', role: 'user', content: 'what the page drew before it stopped watching', timestamp: 1 } }];
    const { container } = render(<ChatView sessionId="recent" visible sessionActive provider="claude" filling />);
    expect(container.textContent).not.toContain(CATCHING_UP);
    expect(container.textContent).not.toContain(HINT);
  });

  it('a genuinely empty conversation still says so once the fill has finished', () => {
    const { container } = render(<ChatView sessionId="new" visible sessionActive provider="claude" filling={false} />);
    expect(container.textContent).toContain(HINT);
  });

  it('the computer never passes `filling`, so its empty conversation reads exactly as before', () => {
    const { container } = render(<ChatView sessionId="s1" visible sessionActive provider="claude" />);
    expect(container.textContent).toContain(HINT);
    expect(container.textContent).not.toContain(CATCHING_UP);
  });
});

describe('useRemoteWatch on a phone', () => {
  const unwatch = vi.fn(() => Promise.resolve({ ok: true }));
  beforeEach(() => { unwatch.mockClear(); (window as any).claude = { session: { unwatch } }; });
  afterEach(() => { delete (window as any).claude; });

  function fakeLoader() {
    const filled: string[] = [];
    let release: Array<() => void> = [];
    const loader = {
      watch: vi.fn((sid: string) => { filled.push(sid); return new Promise<'ok'>((r) => { release.push(() => r('ok')); }); }),
      abandon: vi.fn(),
    } as unknown as FirstPageLoader;
    return { loader, filled, finish: () => { release.forEach((r) => r()); release = []; } };
  }

  it('fills and watches the conversation on screen, and says it is filling from the frame the switch is drawn in', async () => {
    const { loader, filled, finish } = fakeLoader();
    const seen: boolean[] = [];
    const { rerender } = renderHook((p: { activeId: string }) => {
      const w = useRemoteWatch({ enabled: true, activeId: p.activeId, sessionIds: ['a', 'b'], loader });
      seen.push(w.isFilling(p.activeId));
      return w;
    }, { initialProps: { activeId: 'a' } });
    expect(seen[0]).toBe(true);                  // the very first frame already says filling
    expect(filled).toEqual(['a']);
    await act(async () => { finish(); });
    rerender({ activeId: 'b' });
    // The first render for "b" (before any effect has run) already says filling: no blank frame between the switch and the fill.
    expect(seen.at(seen.length - 2)).toBe(true);
    expect(filled).toEqual(['a', 'b']);
    await act(async () => { finish(); });
  });

  it('keeps three, and tells the computer to stop sending the one it let go of', async () => {
    const { loader, finish } = fakeLoader();
    const { rerender } = renderHook((p: { activeId: string }) => useRemoteWatch({ enabled: true, activeId: p.activeId, sessionIds: ['a', 'b', 'c', 'd'], loader }), { initialProps: { activeId: 'a' } });
    for (const id of ['b', 'c']) { rerender({ activeId: id }); await act(async () => { finish(); }); }
    expect(unwatch).not.toHaveBeenCalled();
    rerender({ activeId: 'd' });
    await act(async () => { finish(); });
    expect(unwatch).toHaveBeenCalledTimes(1);
    expect(unwatch).toHaveBeenCalledWith('a');
    expect((loader.abandon as any)).toHaveBeenCalledWith('a');   // an open still running for it must not be joined by the next tap
    // going back to one that is still watched costs nothing
    const callsBefore = (loader.watch as any).mock.calls.length;
    rerender({ activeId: 'c' });
    expect((loader.watch as any).mock.calls.length).toBe(callsBefore);
  });

  it('a reconnect refills only what is watched', async () => {
    const { loader, finish } = fakeLoader();
    const { result, rerender } = renderHook((p: { activeId: string }) => useRemoteWatch({ enabled: true, activeId: p.activeId, sessionIds: ['a', 'b', 'c'], loader }), { initialProps: { activeId: 'a' } });
    rerender({ activeId: 'b' });
    await act(async () => { finish(); });
    expect(result.current.watchedIds()).toEqual(['b', 'a']);
  });

  it('does nothing on the computer\'s own windows', async () => {
    const { loader } = fakeLoader();
    const { result } = renderHook(() => useRemoteWatch({ enabled: false, activeId: 'a', sessionIds: ['a'], loader }));
    expect((loader.watch as any).mock.calls.length).toBe(0);
    expect(result.current.isFilling('a')).toBe(false);
    expect(result.current.watchedIds()).toBeNull();
    expect(unwatch).not.toHaveBeenCalled();
  });

  it('forgets an ended conversation, so it can be watched again if its id comes back', async () => {
    const { loader, finish } = fakeLoader();
    const { rerender } = renderHook((p: { ids: string[]; activeId: string }) => useRemoteWatch({ enabled: true, activeId: p.activeId, sessionIds: p.ids, loader }), { initialProps: { ids: ['a', 'b'], activeId: 'a' } });
    await act(async () => { finish(); });
    rerender({ ids: ['b'], activeId: 'b' });          // a ended
    await act(async () => { finish(); });
    rerender({ ids: ['a', 'b'], activeId: 'a' });     // the id comes back
    await act(async () => { finish(); });
    expect((loader.watch as any).mock.calls.map((c: any[]) => c[0])).toEqual(['a', 'b', 'a']);
  });
});

describe('useSessionSummaries on a phone: the finished chime and the viewed reset', () => {
  const base = { awaitingCount: 0, attention: 'ok', hasHistory: true, queuedCount: 0, permissionMode: null, model: null };
  let push: (p: unknown) => void = () => {};
  beforeEach(() => {
    (playSound as any).mockClear();
    (window as any).claude = { on: { sessionSummary: (cb: (p: unknown) => void) => { push = cb; return () => {}; } } };
  });
  afterEach(() => { delete (window as any).claude; });

  it('chimes once when a conversation stops working, not when it appears idle or starts', () => {
    renderHook(() => useSessionSummaries(true));
    act(() => push({ summaries: { a: { ...base, working: false } } }));
    act(() => push({ summaries: { a: { ...base, working: true } } }));
    expect(playSound).not.toHaveBeenCalled();
    act(() => push({ summaries: { a: { ...base, working: false } } }));
    expect(playSound).toHaveBeenCalledTimes(1);
    expect(playSound).toHaveBeenCalledWith('ready');
  });

  it('a conversation that starts working is dropped from the viewed set', () => {
    let viewed = new Set(['a', 'b']);
    const setViewed = (u: (p: Set<string>) => Set<string>) => { viewed = u(viewed); };
    renderHook(() => useSessionSummaries(true, setViewed));
    act(() => push({ summaries: { a: { ...base, working: true }, b: { ...base, working: false } } }));
    expect([...viewed]).toEqual(['b']);
  });

  it('does nothing on the computer', () => {
    renderHook(() => useSessionSummaries(false));
    act(() => push({ summaries: { a: { ...base, working: true } } }));
    act(() => push({ summaries: { a: { ...base, working: false } } }));
    expect(playSound).not.toHaveBeenCalled();
  });
});
