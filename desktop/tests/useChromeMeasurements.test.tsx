// @vitest-environment jsdom
// useChromeMeasurements publishes the header/bottom-bar sizes as CSS vars on <html>.
// Every write there restyles the whole page, so a resize that rounds to the same
// pixel height must not write again.
import React, { useRef } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { useChromeMeasurements } from '../src/renderer/hooks/useChromeMeasurements';

let observers: Array<() => void> = [];
class StubResizeObserver {
  cb: () => void;
  constructor(cb: () => void) { this.cb = cb; observers.push(cb); }
  observe() {} unobserve() {} disconnect() {}
}

let bottomHeight = 80;
function Harness() {
  const headerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  useChromeMeasurements(headerRef, bottomRef, 's1', 'chat');
  return (
    <>
      <div ref={headerRef}><div className="header-bar" /></div>
      <div ref={bottomRef} data-testid="bottom" />
    </>
  );
}

describe('useChromeMeasurements', () => {
  let original: typeof ResizeObserver;
  beforeEach(() => {
    original = (globalThis as any).ResizeObserver;
    (globalThis as any).ResizeObserver = StubResizeObserver;
    observers = [];
    document.documentElement.removeAttribute('style');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const h = this.dataset.testid === 'bottom' ? bottomHeight : 48;
      return { height: h, bottom: h, top: 0, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
    });
  });
  afterEach(() => {
    (globalThis as any).ResizeObserver = original;
    vi.restoreAllMocks();
  });

  it('writes a chrome var only when its rounded pixel value changes', () => {
    bottomHeight = 80;
    const { unmount } = render(<Harness />);
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--bottom-chrome-height')).toBe('80px');
    expect(style.getPropertyValue('--top-chrome-height')).toBe('48px');

    const spy = vi.spyOn(style, 'setProperty');
    bottomHeight = 79.4; // rounds up to the same 80px
    act(() => { for (const fire of observers) fire(); });
    expect(spy).not.toHaveBeenCalled();

    bottomHeight = 96;
    act(() => { for (const fire of observers) fire(); });
    expect(spy.mock.calls).toEqual([['--bottom-chrome-height', '96px']]);
    expect(style.getPropertyValue('--bottom-chrome-height')).toBe('96px');

    unmount();
    expect(style.getPropertyValue('--bottom-chrome-height')).toBe('');
  });
});
