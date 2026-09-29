// @vitest-environment jsdom
// useChromeMeasurements publishes the header/bottom-bar sizes as CSS vars on <html>.
// Every write there restyles the whole page, so a resize that rounds to the same
// pixel height must not write again.
import React, { useRef } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { useChromeMeasurements } from '../src/renderer/hooks/useChromeMeasurements';

let observers: StubResizeObserver[] = [];
class StubResizeObserver {
  cb: () => void;
  connected = true;
  target: Element | null = null;
  constructor(cb: () => void) { this.cb = cb; observers.push(this); }
  observe(target: Element) { this.target = target; } unobserve() {} disconnect() { this.connected = false; }
  fire() { this.cb(); }
}

let bottomHeight = 80;
let headerHeight = 48;
let headerBottom = 48;
function Harness({ sessionId = 's1', view = 'chat', replace = false }: { sessionId?: string; view?: string; replace?: boolean }) {
  const headerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  useChromeMeasurements(headerRef, bottomRef, sessionId, view);
  return (
    <>
      <div ref={headerRef}><div key={replace ? 'new' : 'old'} className="header-bar" /></div>
      <div key={replace ? 'new' : 'old'} ref={bottomRef} data-testid="bottom" />
    </>
  );
}

describe('useChromeMeasurements', () => {
  let original: typeof ResizeObserver;
  beforeEach(() => {
    original = (globalThis as any).ResizeObserver;
    (globalThis as any).ResizeObserver = StubResizeObserver;
    observers = [];
    headerHeight = 48;
    headerBottom = 48;
    document.documentElement.removeAttribute('style');
    document.body.removeAttribute('data-chrome-style');
    document.body.removeAttribute('data-header-style');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const h = this.dataset.testid === 'bottom' ? bottomHeight : headerHeight;
      const bottom = this.dataset.testid === 'bottom' ? h : headerBottom;
      return { height: h, bottom, top: bottom - h, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
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
    act(() => { for (const observer of observers.filter(o => o.connected)) observer.fire(); });
    expect(spy).not.toHaveBeenCalled();

    bottomHeight = 96;
    act(() => { for (const observer of observers.filter(o => o.connected)) observer.fire(); });
    expect(spy.mock.calls).toEqual([['--bottom-chrome-height', '96px']]);
    expect(style.getPropertyValue('--bottom-chrome-height')).toBe('96px');

    unmount();
    expect(style.getPropertyValue('--bottom-chrome-height')).toBe('');
  });

  it('tracks position-only chrome theme changes without rewriting an ordinary session switch', async () => {
    bottomHeight = 80;
    const { rerender, unmount } = render(<Harness />);
    const style = document.documentElement.style;
    const writes = vi.spyOn(style, 'setProperty');
    const removals = vi.spyOn(style, 'removeProperty');
    const header = document.querySelector('.header-bar')!;
    rerender(<Harness sessionId="s2" />);
    expect(document.querySelector('.header-bar')).toBe(header);
    expect(writes).not.toHaveBeenCalled();
    expect(removals).not.toHaveBeenCalled();
    headerBottom = 54; // float adds 6px top margin, height still 48px
    act(() => { document.body.setAttribute('data-chrome-style', 'float'); });
    await waitFor(() => expect(style.getPropertyValue('--top-chrome-bottom')).toBe('54px'));
    expect(style.getPropertyValue('--top-chrome-height')).toBe('48px');
    expect(writes.mock.calls).toEqual([['--top-chrome-bottom', '54px']]);
    headerBottom = 48;
    act(() => { document.body.setAttribute('data-header-style', 'framed'); });
    await waitFor(() => expect(style.getPropertyValue('--top-chrome-bottom')).toBe('48px'));
    expect(removals).not.toHaveBeenCalled();
    unmount();
    expect(style.getPropertyValue('--top-chrome-bottom')).toBe('');
    const count = writes.mock.calls.length;
    headerBottom = 54;
    act(() => { document.body.setAttribute('data-chrome-style', 'float-again'); });
    await Promise.resolve();
    expect(writes).toHaveBeenCalledTimes(count);
  });

  it('keeps inherited chrome vars and observers across session changes, but updates changed geometry and releases on unmount', () => {
    bottomHeight = 80;
    const { rerender, unmount } = render(<Harness />);
    const style = document.documentElement.style;
    const remove = vi.spyOn(style, 'removeProperty');
    const set = vi.spyOn(style, 'setProperty');
    rerender(<Harness sessionId="s2" />);
    expect(remove).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(observers).toHaveLength(2);
    bottomHeight = 104;
    act(() => { for (const o of observers.filter(x => x.connected)) o.fire(); });
    expect(style.getPropertyValue('--bottom-chrome-height')).toBe('104px');
    rerender(<Harness sessionId="s2" view="terminal" replace />);
    expect(observers).toHaveLength(4);
    expect(observers.slice(0, 2).every(x => !x.connected)).toBe(true);
    bottomHeight = 105;
    headerHeight = 53;
    headerBottom = 65; // floating chrome includes its top margin in bottom offset
    act(() => { observers[0].fire(); observers[1].fire(); });
    expect(style.getPropertyValue('--bottom-chrome-height')).toBe('104px');
    act(() => { for (const o of observers.filter(x => x.connected)) o.fire(); });
    expect(style.getPropertyValue('--bottom-chrome-height')).toBe('105px');
    expect(style.getPropertyValue('--top-chrome-height')).toBe('53px');
    expect(style.getPropertyValue('--top-chrome-bottom')).toBe('65px');
    unmount();
    expect(style.getPropertyValue('--bottom-chrome-height')).toBe('');
    expect(style.getPropertyValue('--top-chrome-height')).toBe('');
    expect(style.getPropertyValue('--top-chrome-bottom')).toBe('');
    expect(observers.every(o => !o.connected)).toBe(true);
  });
});
