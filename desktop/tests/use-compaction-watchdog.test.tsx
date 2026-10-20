// @vitest-environment jsdom
// The screen's own compaction watchdog (one-core R5-4a review): a spinner THIS screen raised (picking "Resume from summary") must still end
// after 180 s on a host with a record; one the computer raised (hostOwned) or a native call's own answer ends must not be guessed at here.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { createSessionChatState } from '../src/renderer/state/chat-types';
import { useCompactionWatchdog, COMPACTION_WATCHDOG_MS } from '../src/renderer/hooks/useCompactionWatchdog';
import { routeSessionLive } from '../src/renderer/state/transcript-batch';

const S = 's1';
function store() {
  let state = new Map([[S, createSessionChatState()]]);
  const subs = new Set<() => void>();
  const dispatch = (a: any) => { state = chatReducer(state, a); subs.forEach((f) => f()); };
  return { dispatch, getState: () => state, subscribeAll: (f: () => void) => { subs.add(f); return () => subs.delete(f); } };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useCompactionWatchdog', () => {
  it('does not reset a pending session timer when another session changes', () => {
    const st = store();
    const actions: any[] = [];
    renderHook(() => useCompactionWatchdog(st as any, a => { actions.push(a); st.dispatch(a); }));
    act(() => st.dispatch({ type: 'COMPACTION_PENDING', sessionId: S, cardId: 'mine', beforeContextTokens: null }));
    act(() => { vi.advanceTimersByTime(100_000); st.dispatch({ type: 'SESSION_INIT', sessionId: 'other' }); });
    act(() => { vi.advanceTimersByTime(80_001); });
    expect(actions).toContainEqual(expect.objectContaining({ type: 'COMPACTION_COMPLETE', operationId: 'mine' }));
  });
  it('ignores an old callback already queued before a newer operation started', () => {
    const st = store();
    const dispatch = vi.fn();
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    try {
      renderHook(() => useCompactionWatchdog(st as any, dispatch));
      act(() => st.dispatch({ type: 'COMPACTION_PENDING', sessionId: S, cardId: 'old', beforeContextTokens: null }));
      const oldCallback = timeout.mock.calls.at(-1)![0] as () => void;
      act(() => st.dispatch({ type: 'COMPACTION_PENDING', sessionId: S, cardId: 'new', beforeContextTokens: null }));
      act(() => oldCallback());
      expect(dispatch).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(COMPACTION_WATCHDOG_MS); });
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'new' }));
    } finally { timeout.mockRestore(); }
  });
  it('cleans all outstanding timers when unmounted', () => {
    const st = store();
    const dispatch = vi.fn();
    const hook = renderHook(() => useCompactionWatchdog(st as any, dispatch));
    act(() => st.dispatch({ type: 'COMPACTION_PENDING', sessionId: S, cardId: 'mine', beforeContextTokens: null }));
    hook.unmount();
    act(() => { vi.advanceTimersByTime(COMPACTION_WATCHDOG_MS * 2); });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('ends a spinner the screen raised itself (Resume from summary) after 180 s, with the "may have failed" note', () => {
    const st = store();
    renderHook(() => useCompactionWatchdog(st as any, st.dispatch as any));
    act(() => st.dispatch({ type: 'COMPACTION_PENDING', sessionId: S, cardId: 'c', beforeContextTokens: null }));
    act(() => { vi.advanceTimersByTime(COMPACTION_WATCHDOG_MS - 1000); });
    expect(st.getState().get(S)!.compactionPending).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1500); });
    const s = st.getState().get(S)!;
    expect(s.compactionPending).toBeNull();
    expect(s.timeline.some((e: any) => e.kind === 'system-marker' && e.marker.label === 'Compaction may have failed')).toBe(true);
  });
  it('is bumped by activity: events keep a long compaction alive', () => {
    const st = store();
    renderHook(() => useCompactionWatchdog(st as any, st.dispatch as any));
    act(() => st.dispatch({ type: 'COMPACTION_PENDING', sessionId: S, cardId: 'c', beforeContextTokens: null }));
    for (let i = 0; i < 3; i++) { act(() => { vi.advanceTimersByTime(100_000); }); act(() => st.dispatch({ type: 'ATTENTION_STATE_CHANGED', sessionId: S, state: i % 2 === 0 ? 'stuck' : 'ok' })); }
    expect(st.getState().get(S)!.compactionPending).not.toBeNull();
  });
  it('leaves a spinner the computer raised (hostOwned) and a native call\'s own (awaitsResult) alone', () => {
    const st = store();
    renderHook(() => useCompactionWatchdog(st as any, st.dispatch as any));
    act(() => routeSessionLive({ sessionId: S, kind: 'compact-start', id: 'h' }, { batcher: { push: st.dispatch }, contextTokens: () => null }));
    expect(st.getState().get(S)!.compactionPending?.hostOwned).toBe(true);
    act(() => { vi.advanceTimersByTime(COMPACTION_WATCHDOG_MS * 2); });
    expect(st.getState().get(S)!.compactionPending).not.toBeNull();
    act(() => st.dispatch({ type: 'COMPACTION_CANCELLED', sessionId: S }));
    act(() => st.dispatch({ type: 'COMPACTION_PENDING', sessionId: S, cardId: 'n', beforeContextTokens: null, awaitsResult: true }));
    act(() => { vi.advanceTimersByTime(COMPACTION_WATCHDOG_MS * 2); });
    expect(st.getState().get(S)!.compactionPending).not.toBeNull();
  });
});
