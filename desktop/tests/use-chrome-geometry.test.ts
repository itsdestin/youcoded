// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChromeGeometry } from '../src/renderer/hooks/useChromeGeometry';

// Minimal ResizeObserver stub — captures observed elements and exposes a
// `trigger()` so tests can simulate a resize event on demand.
class StubResizeObserver {
  static instances: StubResizeObserver[] = [];
  cb: ResizeObserverCallback;
  observed = new Set<Element>();
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    StubResizeObserver.instances.push(this);
  }
  observe(el: Element) { this.observed.add(el); }
  unobserve(el: Element) { this.observed.delete(el); }
  disconnect() { this.observed.clear(); }
  trigger() { this.cb([], this); }
}

describe('useChromeGeometry', () => {
  let originalRO: typeof ResizeObserver;

  beforeEach(() => {
    originalRO = (globalThis as any).ResizeObserver;
    (globalThis as any).ResizeObserver = StubResizeObserver;
    StubResizeObserver.instances = [];
    document.body.innerHTML = '';
  });

  afterEach(() => {
    (globalThis as any).ResizeObserver = originalRO;
  });

  function makeChrome(className: string, rect: { left: number; top: number; width: number; height: number }) {
    const el = document.createElement('div');
    el.className = className;
    el.getBoundingClientRect = () =>
      ({
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
        x: rect.left,
        y: rect.top,
        toJSON: () => ({}),
      }) as DOMRect;
    document.body.appendChild(el);
    return el;
  }

  it('returns [] when no chrome elements exist', () => {
    const { result } = renderHook(() => useChromeGeometry());
    expect(result.current).toEqual([]);
  });

  it('returns rects for matched chrome elements on first render', () => {
    makeChrome('header-bar', { left: 0, top: 0, width: 1280, height: 40 });
    makeChrome('status-bar', { left: 0, top: 680, width: 1280, height: 40 });
    const { result } = renderHook(() => useChromeGeometry());
    expect(result.current).toEqual([
      { left: 0, top: 0, width: 1280, height: 40 },
      { left: 0, top: 680, width: 1280, height: 40 },
    ]);
  });

  it('updates rects when ResizeObserver fires', () => {
    const header = makeChrome('header-bar', { left: 0, top: 0, width: 1280, height: 40 });
    const { result } = renderHook(() => useChromeGeometry());
    expect(result.current[0].height).toBe(40);

    // Simulate the input bar growing — change the rect, then trigger the observer.
    header.getBoundingClientRect = () =>
      ({
        left: 0, top: 0, width: 1280, height: 60,
        right: 1280, bottom: 60, x: 0, y: 0, toJSON: () => ({}),
      }) as DOMRect;
    act(() => {
      StubResizeObserver.instances[0].trigger();
    });

    expect(result.current[0].height).toBe(60);
  });

  it('disconnects the observer on unmount', () => {
    makeChrome('header-bar', { left: 0, top: 0, width: 1280, height: 40 });
    const { unmount } = renderHook(() => useChromeGeometry());
    const obs = StubResizeObserver.instances[0];
    expect(obs.observed.size).toBe(1);
    unmount();
    expect(obs.observed.size).toBe(0);
  });

  // A fresh array per observer tick re-rendered ThemeEffects and repainted the full-window particle canvas while
  // typing, even when nothing moved. An unchanged measurement must keep the same array, so the clip-path built from
  // it is unchanged and the canvas is not repainted. (React may still run the component once before bailing out —
  // that render produces the identical clip-path string, so the DOM is untouched.)
  it('keeps the same array when an observer tick finds nothing moved', () => {
    makeChrome('header-bar', { left: 0, top: 0, width: 1280, height: 40 });
    const { result } = renderHook(() => useChromeGeometry());
    const before = result.current;
    act(() => { StubResizeObserver.instances[0].trigger(); });
    act(() => { StubResizeObserver.instances[0].trigger(); });
    expect(result.current).toBe(before);
  });
});

