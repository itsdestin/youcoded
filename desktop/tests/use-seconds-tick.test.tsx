// @vitest-environment jsdom
//
// The shared seconds clock (simplification audit W19): one interval for every
// mounted seconds counter, none while nothing is counting, paused while the
// window is hidden and caught up the moment it is visible again.
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useSecondsTick } from '../src/renderer/hooks/useSecondsTick';

function Counter({ startedAt, active = true }: { startedAt: number; active?: boolean }) {
  const now = useSecondsTick(active);
  return <span data-testid="elapsed">{Math.floor((now - startedAt) / 1000)}</span>;
}

let hidden = false;
function setHidden(value: boolean) {
  hidden = value;
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(1_000_000);
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  hidden = false;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const read = (el: HTMLElement) => Array.from(el.querySelectorAll('[data-testid="elapsed"]')).map((n) => Number(n.textContent));

describe('useSecondsTick', () => {
  it('drives any number of counters from ONE interval, and stops it when the last one unmounts', () => {
    const t0 = Date.now();
    const r = render(<><Counter startedAt={t0} /><Counter startedAt={t0} /><Counter startedAt={t0} /></>);
    expect(vi.getTimerCount()).toBe(1);
    act(() => { vi.advanceTimersByTime(3000); });
    expect(read(r.container)).toEqual([3, 3, 3]);
    r.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an inactive counter subscribes to nothing', () => {
    render(<Counter startedAt={Date.now()} active={false} />);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pauses while the document is hidden and catches up with an immediate tick on return', () => {
    const t0 = Date.now();
    const r = render(<Counter startedAt={t0} />);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(read(r.container)).toEqual([2]);

    setHidden(true);
    expect(vi.getTimerCount()).toBe(0); // no interval at all while hidden
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(read(r.container)).toEqual([2]); // nothing rendered in the dark

    setHidden(false);
    // Visible again: the counter is right at once — derived from the start
    // timestamp, not from ticks it missed — and the interval is back.
    expect(read(r.container)).toEqual([32]);
    expect(vi.getTimerCount()).toBe(1);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(read(r.container)).toEqual([33]);
  });

  it('a counter mounted after an idle spell reads a fresh clock, not the last tick', () => {
    const first = render(<Counter startedAt={Date.now()} />);
    act(() => { vi.advanceTimersByTime(1000); });
    first.unmount();
    act(() => { vi.advanceTimersByTime(60_000); }); // a minute with nothing mounted
    const t0 = Date.now();
    const r = render(<Counter startedAt={t0} />);
    expect(read(r.container)).toEqual([0]);
  });
});
