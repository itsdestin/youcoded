// @vitest-environment jsdom
// A phone that reconnects to a computer with several conversations already waiting sounds ONCE, not once per conversation;
// a conversation that newly needs the person afterwards still sounds (one-core sync-fix5). Fake timers drive the quiet window.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../src/renderer/utils/sounds', () => ({ playSound: vi.fn() }));
import { playSound } from '../src/renderer/utils/sounds';
import { useAttentionSound } from '../src/renderer/hooks/useAttentionSound';
import { useSessionSummaries } from '../src/renderer/hooks/useSessionSummaries';
import { SOUND_BURST_WINDOW_MS } from '../src/renderer/utils/sound-burst';

const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}` }));
const colours = (entries: Record<string, string>) => new Map(Object.entries(entries));
const asks = () => (playSound as any).mock.calls.filter((c: any[]) => c[0] === 'attention').length;

describe('the phone attention sound', () => {
  beforeEach(() => { vi.useFakeTimers(); (playSound as any).mockClear(); });
  afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); });

  function mount() {
    const sessions = ids(6);
    const view = renderHook(({ statuses }) => useAttentionSound(sessions, statuses, true), { initialProps: { statuses: colours({}) } });
    return { set: (e: Record<string, string>) => view.rerender({ statuses: colours(e) }) };
  }

  it('reconnecting with 5 conversations already waiting sounds exactly once', () => {
    const { set } = mount();
    set({ s0: 'red', s1: 'red', s2: 'red', s3: 'red', s4: 'red', s5: 'green' });
    expect(asks()).toBe(1);
  });

  it('a conversation that newly starts waiting after that settles sounds once', () => {
    const { set } = mount();
    set({ s0: 'red', s1: 'red', s2: 'red', s3: 'red', s4: 'red', s5: 'green' });
    act(() => { vi.advanceTimersByTime(SOUND_BURST_WINDOW_MS + 1); });
    set({ s0: 'red', s1: 'red', s2: 'red', s3: 'red', s4: 'red', s5: 'red' });
    expect(asks()).toBe(2);
  });

  it('3 conversations asking inside the window sound once', () => {
    const { set } = mount();
    set({ s0: 'green', s1: 'green', s2: 'green' });
    set({ s0: 'red', s1: 'green', s2: 'green' });
    act(() => { vi.advanceTimersByTime(300); });
    set({ s0: 'red', s1: 'red', s2: 'green' });
    act(() => { vi.advanceTimersByTime(300); });
    set({ s0: 'red', s1: 'red', s2: 'red' });
    expect(asks()).toBe(1);
  });

  it('2 asks far apart sound twice', () => {
    const { set } = mount();
    set({ s0: 'green', s1: 'green' });
    set({ s0: 'red', s1: 'green' });
    act(() => { vi.advanceTimersByTime(10_000); });
    set({ s0: 'red', s1: 'red' });
    expect(asks()).toBe(2);
  });

  it('the computer still sounds once per newly waiting conversation', () => {
    const sessions = ids(3);
    const view = renderHook(({ statuses }) => useAttentionSound(sessions, statuses, false), { initialProps: { statuses: colours({}) } });
    view.rerender({ statuses: colours({ s0: 'red', s1: 'red', s2: 'red' }) });
    expect(asks()).toBe(3);
  });
});

describe('the phone finished chime', () => {
  const base = { awaitingCount: 0, attention: 'ok', hasHistory: true, queuedCount: 0, permissionMode: null, model: null };
  let push: (p: unknown) => void = () => {};
  beforeEach(() => {
    vi.useFakeTimers(); (playSound as any).mockClear();
    (window as any).claude = { on: { sessionSummary: (cb: (p: unknown) => void) => { push = cb; return () => {}; } } };
  });
  afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); delete (window as any).claude; });

  it('several conversations finishing in one push chime once; a later finish chimes again', () => {
    renderHook(() => useSessionSummaries(true));
    const working = (w: boolean) => Object.fromEntries(['a', 'b', 'c'].map((k) => [k, { ...base, working: w }]));
    act(() => push({ summaries: working(true) }));
    act(() => push({ summaries: working(false) }));
    expect(playSound).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(SOUND_BURST_WINDOW_MS + 1); });
    act(() => push({ summaries: working(true) }));
    act(() => push({ summaries: working(false) }));
    expect(playSound).toHaveBeenCalledTimes(2);
  });
});
