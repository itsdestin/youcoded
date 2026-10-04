// @vitest-environment jsdom
// The app-wide pinch handler is capture-phase on window and preventDefaults
// EVERY ctrlKey wheel event, but does not stopPropagation. Without a guard, a
// pinch over a picture zooms the whole app AND the picture at once, with two
// different percentages showing in two corners. That double-zoom is what this
// pins against.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useZoomControls } from '../src/renderer/hooks/useZoomControls';

const zoomIn = vi.fn(async () => 110);

beforeEach(() => {
  vi.useFakeTimers();
  zoomIn.mockClear();
  (window as any).claude = {
    zoom: { zoomIn, zoomOut: vi.fn(async () => 90), reset: vi.fn(async () => 100), get: vi.fn(async () => 100) },
  };
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

function Host() {
  useZoomControls();
  return (
    <div>
      <div data-zoomable><span data-testid="picture" /></div>
      <span data-testid="outside" />
    </div>
  );
}

function pinchOn(el: Element) {
  act(() => {
    el.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -120, bubbles: true }));
    vi.advanceTimersByTime(100);
  });
}

describe('useZoomControls pinch guard', () => {
  it('ignores a ctrl+wheel that starts inside a zoomable viewer', () => {
    const { getByTestId } = render(<Host />);
    pinchOn(getByTestId('picture'));
    expect(zoomIn).not.toHaveBeenCalled();
  });

  it('still zooms the app for a ctrl+wheel anywhere else', () => {
    const { getByTestId } = render(<Host />);
    pinchOn(getByTestId('outside'));
    expect(zoomIn).toHaveBeenCalled();
  });
});

// Fix 3 (2026-10-04): a NON-passive window wheel listener makes the browser ask the page's main thread before it
// scrolls anything, so every scroll waits whenever the page is busy. The desktop app registers it passive; the
// other surfaces keep the cancelable one because there the browser's own page zoom is what preventDefault stops.
describe('useZoomControls scroll never waits (desktop) / stays cancelable (elsewhere)', () => {
  const wheelRegistrations = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.filter((c: any[]) => c[0] === 'wheel').map((c: any[]) => c[2] as AddEventListenerOptions);
  afterEach(() => { delete (window as any).__PLATFORM__; vi.restoreAllMocks(); });

  it('desktop: the wheel listener is passive, still zooms, and never tries to cancel', () => {
    const spy = vi.spyOn(window, 'addEventListener');
    const { getByTestId } = render(<Host />);
    const opts = wheelRegistrations(spy);
    expect(opts).toHaveLength(1);
    expect(opts[0].passive).toBe(true);
    const ev = new WheelEvent('wheel', { ctrlKey: true, deltaY: -120, bubbles: true, cancelable: true });
    act(() => { getByTestId('outside').dispatchEvent(ev); vi.advanceTimersByTime(100); });
    expect(zoomIn).toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it('remote browser / Android: the listener stays cancelable and cancels the browser zoom', () => {
    (window as any).__PLATFORM__ = 'browser';
    const spy = vi.spyOn(window, 'addEventListener');
    const { getByTestId } = render(<Host />);
    const opts = wheelRegistrations(spy);
    expect(opts).toHaveLength(1);
    expect(opts[0].passive).toBe(false);
    const ev = new WheelEvent('wheel', { ctrlKey: true, deltaY: -120, bubbles: true, cancelable: true });
    act(() => { getByTestId('outside').dispatchEvent(ev); vi.advanceTimersByTime(100); });
    expect(zoomIn).toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
  });
});
