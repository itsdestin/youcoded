// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import {
  useOneShotWindow, defaultMotionWindowMs, resetDefaultMotionWindowForTests, MOTION_WINDOW_FALLBACK_MS,
} from '../src/renderer/hooks/use-one-shot-window';

describe('useOneShotWindow', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('does NOT open on first mount', () => {
    // At app start the active session's pill and pane render immediately.
    // Firing there would make every cold launch look like a switch that
    // never happened.
    const { result } = renderHook(() => useOneShotWindow('session-a'));
    expect(result.current).toBe(false);
  });

  it('opens when the key changes', () => {
    const { result, rerender } = renderHook(({ k }) => useOneShotWindow(k), {
      initialProps: { k: 'session-a' },
    });
    rerender({ k: 'session-b' });
    expect(result.current).toBe(true);
  });

  it('is open in the FIRST COMMITTED render after the change — no flash frame', () => {
    // The first version set `open` from useEffect, which runs after the browser
    // has painted the new state once: one frame of the incoming conversation
    // fully visible, THEN a fade-in from invisible. A layout effect sees only
    // committed renders, so this is the sequence the browser can paint.
    const committed: boolean[] = [];
    const { rerender } = renderHook(({ k }) => {
      const open = useOneShotWindow(k);
      useLayoutEffect(() => { committed.push(open); });
      return open;
    }, { initialProps: { k: 'a' } });
    rerender({ k: 'b' });
    expect(committed).toEqual([false, true]);
  });

  it('closes itself after the window', () => {
    const { result, rerender } = renderHook(({ k }) => useOneShotWindow(k, 240), {
      initialProps: { k: 'session-a' },
    });
    rerender({ k: 'session-b' });
    act(() => { vi.advanceTimersByTime(300); });
    expect(result.current).toBe(false);
  });

  it('re-opens on a second change, restarting the clock', () => {
    const { result, rerender } = renderHook(({ k }) => useOneShotWindow(k, 240), {
      initialProps: { k: 'a' },
    });
    rerender({ k: 'b' });
    act(() => { vi.advanceTimersByTime(200); });
    rerender({ k: 'c' });
    act(() => { vi.advanceTimersByTime(200); });
    expect(result.current).toBe(true);   // the first timer was cleared, not left to fire
  });

  it('the default window outlasts the stylesheet\'s --dur-switch, whatever it is', () => {
    // THE 63% BUG (2026-09-18): the default was a literal 240 written for a 240ms
    // switch; the switch became 380ms and ChatView, the one caller of the
    // default, pulled `.switch-arrival` off mid-air. The default now follows the
    // token, so a future vocabulary change cannot reopen the gap.
    resetDefaultMotionWindowForTests();
    document.documentElement.style.setProperty('--dur-switch', '700ms');
    try {
      expect(defaultMotionWindowMs()).toBeGreaterThan(700);
      const { result, rerender } = renderHook(({ k }) => useOneShotWindow(k), { initialProps: { k: 'a' } });
      rerender({ k: 'b' });
      act(() => { vi.advanceTimersByTime(700); });
      expect(result.current).toBe(true);    // still open for the whole animation
      act(() => { vi.advanceTimersByTime(400); });
      expect(result.current).toBe(false);   // and it does close
    } finally {
      document.documentElement.style.removeProperty('--dur-switch');
      resetDefaultMotionWindowForTests();
    }
  });

  it('falls back to a window longer than today\'s switch when the token cannot be read', () => {
    resetDefaultMotionWindowForTests();
    expect(defaultMotionWindowMs()).toBe(MOTION_WINDOW_FALLBACK_MS);
    expect(MOTION_WINDOW_FALLBACK_MS).toBeGreaterThan(380);
    resetDefaultMotionWindowForTests();
  });

  it('opens in BOTH directions — one-way callers AND the result', () => {
    // ChatView must animate a pane arriving and NOT one leaving. The hook does
    // not know about directions; the call site says which one it wants by
    // ANDing in the state it cares about. This test pins that pattern, because
    // it is the whole reason one hook can serve both call sites.
    const { result, rerender } = renderHook(
      ({ a }) => useOneShotWindow(a) && a,
      { initialProps: { a: true } },
    );
    rerender({ a: false });
    expect(result.current).toBe(false);   // window opened, guard says no
  });
});
