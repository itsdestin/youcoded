// @vitest-environment jsdom
// WHY (card #134 round 4, Q-1): the chips' saved values must only count once really read.
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { useModelModes } from '../src/renderer/hooks/useModelModes';

afterEach(() => { cleanup(); delete (window as any).claude; });

describe('useModelModes', () => {
  it('is unread, then read with the real values', async () => {
    (window as any).claude = { modes: { get: async () => ({ fast: true, effort: 'high' }) } };
    const { result } = renderHook(() => useModelModes(0));
    expect(result.current.read).toBe(false);
    await waitFor(() => expect(result.current.read).toBe(true));
    expect(result.current).toMatchObject({ fast: true, effort: 'high' });
  });
  it('stays unread when the read fails (including a not-available-here answer)', async () => {
    let calls = 0;
    (window as any).claude = { modes: { get: () => { calls++; return Promise.reject(Object.assign(new Error('remote-unsupported: modes:get'), { code: 'REMOTE_UNSUPPORTED' })); } } };
    const { result } = renderHook(() => useModelModes(0));
    await waitFor(() => expect(calls).toBe(1));
    await Promise.resolve(); await Promise.resolve();
    expect(result.current.read).toBe(false);
  });
  it('stays unread when there is no modes api or a non-object answer', async () => {
    (window as any).claude = {};
    expect(renderHook(() => useModelModes(0)).result.current.read).toBe(false);
    let called = false;
    (window as any).claude = { modes: { get: async () => { called = true; return null; } } };
    const { result } = renderHook(() => useModelModes(0));
    await waitFor(() => expect(called).toBe(true));
    expect(result.current.read).toBe(false);
  });
  it('keeps its last real values if a later re-read fails', async () => {
    let fail = false;
    (window as any).claude = { modes: { get: async () => { if (fail) throw new Error('x'); return { fast: true, effort: 'low' }; } } };
    const { result, rerender } = renderHook(({ k }) => useModelModes(k), { initialProps: { k: 0 } });
    await waitFor(() => expect(result.current.read).toBe(true));
    fail = true; rerender({ k: 1 });
    await Promise.resolve(); await Promise.resolve();
    expect(result.current).toMatchObject({ read: true, fast: true, effort: 'low' });
  });
});
