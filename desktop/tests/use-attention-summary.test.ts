// @vitest-environment jsdom
//
// ---------------------------------------------------------------------------
// INVARIANT: the switcher's cross-window colour feed PULLS a snapshot on mount
// (the push fires on change only, so a window opened mid-turn would otherwise
// show a working peer session as idle), and it re-renders its host ONLY when a
// colour actually changed — main pushes on every reported change anywhere in
// the app, so an idle window would otherwise re-render several times a second
// while another window works.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAttentionSummary } from '../src/renderer/hooks/useAttentionSummary';
import type { AttentionSummary } from '../src/shared/types';

afterEach(() => { delete (global as any).window.claude; });

const summary = (perSession: AttentionSummary['perSession']): AttentionSummary =>
  ({ anyNeedsAttention: false, perSession });

const working = (id: string) => summary({
  [id]: { attentionState: 'ok', awaitingApproval: false, status: 'green' },
});

/** Stub the two halves of the feed; returns the push emitter. */
function mockFeed(pulled?: unknown) {
  let cb: ((s: AttentionSummary) => void) | null = null;
  (global as any).window.claude = {
    attention: { getSummary: vi.fn(async () => pulled) },
    buddy: {
      onAttentionSummary: (c: (s: AttentionSummary) => void) => { cb = c; return () => { cb = null; }; },
    },
  };
  return (s: AttentionSummary) => act(() => { cb?.(s); });
}

describe('useAttentionSummary', () => {
  it('pulls a snapshot on mount, so a window opened mid-turn is not blind', async () => {
    mockFeed(working('peer'));
    const { result } = renderHook(() => useAttentionSummary());
    await waitFor(() => expect(result.current.perSession.peer?.status).toBe('green'));
  });

  it('takes pushed updates after the pull', async () => {
    const emit = mockFeed(summary({}));
    const { result } = renderHook(() => useAttentionSummary());
    await waitFor(() => expect(result.current.perSession).toEqual({}));
    emit(working('peer'));
    expect(result.current.perSession.peer?.status).toBe('green');
  });

  it('does not re-render when a push carries the same colours', async () => {
    const emit = mockFeed(summary({}));
    let renders = 0;
    const { result } = renderHook(() => { renders += 1; return useAttentionSummary(); });
    await waitFor(() => expect(result.current.perSession).toEqual({}));
    emit(working('peer'));
    const after = renders;
    emit(working('peer'));
    emit(working('peer'));
    expect(renders).toBe(after);
  });

  it('survives a bridge that answers with something else entirely', async () => {
    // The workbench mock-shim answers every channel it does not implement by
    // hand with `[]` — truthy, and with no perSession to read through.
    const emit = mockFeed([]);
    const { result } = renderHook(() => useAttentionSummary());
    await waitFor(() => expect(result.current.perSession).toEqual({}));
    emit(null as any);
    emit(undefined as any);
    emit([] as any);
    emit({ perSession: 'not-a-map' } as any);
    expect(result.current.perSession).toEqual({});
  });

  it('still takes pushes when the pull is missing altogether', async () => {
    // Remote browsers and Android reach this through remote-shim; an older
    // shim, or a buddy window mid-boot, may not expose getSummary at all.
    let cb: ((s: AttentionSummary) => void) | null = null;
    (global as any).window.claude = {
      buddy: { onAttentionSummary: (c: any) => { cb = c; return () => {}; } },
    };
    const { result } = renderHook(() => useAttentionSummary());
    act(() => { cb?.(working('peer')); });
    expect(result.current.perSession.peer?.status).toBe('green');
  });
});
