// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAnyAttentionNeeded } from '../src/renderer/hooks/useAnyAttentionNeeded';
import type { AttentionSummary } from '../src/shared/types';

describe('useAnyAttentionNeeded', () => {
  beforeEach(() => {
    // Set up a mock for window.claude.buddy.onAttentionSummary
    (global as any).window = (global as any).window ?? {};
  });

  afterEach(() => {
    delete (global as any).window.claude;
  });

  it('returns false initially', () => {
    mockClaudeBuddy([]);
    const { result } = renderHook(() => useAnyAttentionNeeded());
    expect(result.current).toBe(false);
  });

  it('returns true when summary says anyNeedsAttention', () => {
    const emit = mockClaudeBuddy([]);
    const { result } = renderHook(() => useAnyAttentionNeeded());
    act(() => {
      emit({
        anyNeedsAttention: true,
        perSession: { 's1': { attentionState: 'awaiting-input', awaitingApproval: false } },
      } satisfies AttentionSummary);
    });
    expect(result.current).toBe(true);
  });

  it('returns false after clearing', () => {
    const emit = mockClaudeBuddy([]);
    const { result } = renderHook(() => useAnyAttentionNeeded());
    act(() => {
      emit({ anyNeedsAttention: true, perSession: {} });
      emit({ anyNeedsAttention: false, perSession: {} });
    });
    expect(result.current).toBe(false);
  });
});

// Helper: mount a stub for window.claude.buddy.onAttentionSummary that
// returns an emit function the test uses to push summaries.
function mockClaudeBuddy(
  initial: AttentionSummary[]
): (s: AttentionSummary) => void {
  let cb: ((s: AttentionSummary) => void) | null = null;
  (global as any).window = (global as any).window ?? {};
  (global as any).window.claude = {
    buddy: {
      onAttentionSummary: (c: (s: AttentionSummary) => void) => {
        cb = c;
        return () => {
          cb = null;
        };
      },
    },
  };
  for (const s of initial) cb?.(s);
  return (s) => cb?.(s);
}
