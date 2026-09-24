// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNativeSessionTotals } from '../src/renderer/hooks/useNativeSessionTotals';
import { useNativeSessionUsage } from '../src/renderer/hooks/useNativeSessionUsage';

// Mirrors the harness the sibling useNativeSessionUsage test uses — see that
// file for the store/provider wrapper if this one drifts.
import { makeStoreWrapper, dispatchTo } from './helpers/chat-store-harness';

describe('useNativeSessionUsage', () => {
  it('selects session-owned progress before completed usage and restores completed usage on terminal clear', () => {
    const { wrapper, store } = makeStoreWrapper(['s1', 's2']);
    const { result, rerender } = renderHook(({ id }) => useNativeSessionUsage(id), { wrapper, initialProps: { id: 's1' as string | null } });
    expect(result.current).toBeNull();
    const completed = { inputTokens: 20, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, contextUsedTokens: 200 };
    act(() => {
      dispatchTo(store, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: 's1', uuid: 'text', timestamp: 5, text: 'done' });
      dispatchTo(store, { type: 'TRANSCRIPT_TURN_COMPLETE', sessionId: 's1', uuid: 'end', timestamp: 10,
        stopReason: null, model: null, anthropicRequestId: null, usage: completed });
      dispatchTo(store, { type: 'TRANSCRIPT_USER_MESSAGE', sessionId: 's1', uuid: 'next', timestamp: 11, text: 'next' });
    });
    const saved = result.current;
    expect(saved).toBe(completed);
    const progress = { ...completed, inputTokens: 50, contextUsedTokens: 500 };
    act(() => { dispatchTo(store, { type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: 's1', timestamp: 20, uuid: 'p', usageProgress: progress }); });
    expect(result.current).toBe(progress);
    act(() => { dispatchTo(store, { type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: 's2', timestamp: 21, uuid: 'p2', usageProgress: { ...progress, inputTokens: 90 } }); });
    expect(result.current).toBe(progress);
    act(() => { dispatchTo(store, { type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: 's1' }); });
    expect(result.current).toBe(progress); // stable useSyncExternalStore snapshot on unrelated updates
    rerender({ id: 's2' });
    expect(result.current?.inputTokens).toBe(90);
    rerender({ id: 's1' });
    act(() => { dispatchTo(store, { type: 'TRANSCRIPT_INTERRUPT', sessionId: 's1', uuid: 'interrupt', timestamp: 30, kind: 'plain' }); });
    expect(result.current).toBe(saved);
    rerender({ id: null });
    expect(result.current).toBeNull();
  });
});

describe('useNativeSessionTotals', () => {
  it('returns null for a session that does not exist', () => {
    const { wrapper } = makeStoreWrapper();
    const { result } = renderHook(() => useNativeSessionTotals('nope'), { wrapper });
    expect(result.current).toBeNull();
  });

  it('returns the same object reference until a total actually changes', () => {
    const { wrapper, store } = makeStoreWrapper(['s1']);
    const { result } = renderHook(() => useNativeSessionTotals('s1'), { wrapper });
    const first = result.current;
    act(() => { dispatchTo(store, { type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: 's1' } as any); });
    expect(result.current).toBe(first);   // stable snapshot — React loops otherwise
  });

  it('updates when a turn completes', () => {
    const { wrapper, store } = makeStoreWrapper(['s1']);
    const { result } = renderHook(() => useNativeSessionTotals('s1'), { wrapper });
    act(() => {
      dispatchTo(store, {
        type: 'TRANSCRIPT_TURN_COMPLETE', sessionId: 's1', uuid: 'u1', timestamp: 1,
        stopReason: 'end_turn', model: 'm', anthropicRequestId: null,
        usage: { inputTokens: 42, outputTokens: 7, cacheReadTokens: 0, cacheCreationTokens: 0 },
      } as any);
    });
    expect(result.current?.inputTokens).toBe(42);
  });
});
