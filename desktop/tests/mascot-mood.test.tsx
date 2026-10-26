// @vitest-environment jsdom
// The buddy's mood follows the status dots' colours: alert on red/amber, a focused look while working, a wave when a
// reply is ready, quiet idle moments, sleep after a quiet while, and waking when anything changes.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { AttentionSummary } from '../src/shared/types';
import {
  useMascotMood, strongestStatus, DONE_MS, SLEEP_AFTER_MS, MOMENT_MIN_MS, MOMENT_SPREAD_MS, GLANCE_MS,
} from '../src/renderer/components/buddy/mascot-mood';

const summary = (...statuses: string[]): AttentionSummary =>
  ({ anyNeedsAttention: false, perSession: Object.fromEntries(statuses.map((s, i) => [`s${i}`, { status: s }])) }) as unknown as AttentionSummary;

afterEach(() => { vi.useRealTimers(); });

describe('strongestStatus', () => {
  it('takes the most urgent colour across sessions, in the dots\' order', () => {
    expect(strongestStatus(summary('gray', 'blue', 'green'))).toBe('green');
    expect(strongestStatus(summary('green', 'amber'))).toBe('amber');
    expect(strongestStatus(summary('amber', 'red', 'blue'))).toBe('red');
    expect(strongestStatus(null)).toBe('gray');
  });
});

describe('useMascotMood', () => {
  it('is alert on red or amber and working on green', () => {
    const { result, rerender } = renderHook(({ s }) => useMascotMood(s, false), { initialProps: { s: summary('red') } });
    expect(result.current).toBe('alert');
    rerender({ s: summary('amber') });
    expect(result.current).toBe('alert');
    rerender({ s: summary('green') });
    expect(result.current).toBe('working');
  });

  it('waves once when a reply becomes ready, then rests', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ s }) => useMascotMood(s, false), { initialProps: { s: summary('green') } });
    rerender({ s: summary('blue') });
    expect(result.current).toBe('done');
    act(() => { vi.advanceTimersByTime(DONE_MS); });
    expect(result.current).toBe('idle');
  });

  it('has an idle moment while quiet, then falls asleep, and wakes when anything changes', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { result, rerender } = renderHook(({ s }) => useMascotMood(s, false), { initialProps: { s: summary('gray') } });
    expect(result.current).toBe('idle');
    act(() => { vi.advanceTimersByTime(MOMENT_MIN_MS); });
    expect(result.current).toBe('glance');
    act(() => { vi.advanceTimersByTime(GLANCE_MS); });
    expect(result.current).toBe('idle');
    act(() => { vi.advanceTimersByTime(SLEEP_AFTER_MS); });
    expect(result.current).toBe('sleep');
    rerender({ s: summary('green') });
    expect(result.current).toBe('working');
    rerender({ s: summary('gray') });
    expect(result.current).toBe('idle');
  });

  it('never has idle moments or sleeps while a session is red, amber or green', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useMascotMood(summary('green'), false));
    act(() => { vi.advanceTimersByTime(SLEEP_AFTER_MS + MOMENT_MIN_MS + MOMENT_SPREAD_MS); });
    expect(result.current).toBe('working');
  });

  it('with reduced effects there is no wave, no idle moment and no sleep', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ s }) => useMascotMood(s, true), { initialProps: { s: summary('green') } });
    rerender({ s: summary('blue') });
    expect(result.current).toBe('idle');
    act(() => { vi.advanceTimersByTime(SLEEP_AFTER_MS + MOMENT_MIN_MS + MOMENT_SPREAD_MS); });
    expect(result.current).toBe('idle');
  });
});
