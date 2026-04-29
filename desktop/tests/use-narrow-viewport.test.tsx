// @vitest-environment jsdom
// Unit test for useNarrowViewport — matchMedia-based hook returning true when
// viewport is below the marketplace mobile breakpoint (640px).

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useNarrowViewport } from '../src/renderer/hooks/use-narrow-viewport';

// Build a fake MediaQueryList we can mutate to simulate viewport changes.
function installMatchMediaMock(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    get matches() { return matches; },
    media: '(max-width: 639.98px)',
    onchange: null,
    addEventListener: (_t: string, cb: any) => { listeners.add(cb); },
    removeEventListener: (_t: string, cb: any) => { listeners.delete(cb); },
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: () => true,
  };
  (window as any).matchMedia = (q: string) => {
    mql.media = q;
    return mql;
  };
  return {
    setMatches(next: boolean) {
      matches = next;
      listeners.forEach((cb) => cb({ matches: next } as MediaQueryListEvent));
    },
  };
}

function HookProbe({ onValue }: { onValue: (v: boolean) => void }) {
  const v = useNarrowViewport();
  onValue(v);
  return null;
}

describe('useNarrowViewport', () => {
  beforeEach(() => {
    (globalThis as any).window = (globalThis as any).window ?? {};
  });
  afterEach(() => {
    cleanup();
    delete (window as any).matchMedia;
  });

  it('returns false initially when viewport is wide', () => {
    installMatchMediaMock(false);
    const observed: boolean[] = [];
    render(<HookProbe onValue={(v) => observed.push(v)} />);
    // Last observed value (post-effect) should be false.
    expect(observed[observed.length - 1]).toBe(false);
  });

  it('returns true initially when viewport is narrow', () => {
    installMatchMediaMock(true);
    const observed: boolean[] = [];
    render(<HookProbe onValue={(v) => observed.push(v)} />);
    expect(observed[observed.length - 1]).toBe(true);
  });

  it('updates when the viewport crosses the breakpoint', () => {
    const ctl = installMatchMediaMock(false);
    const observed: boolean[] = [];
    render(<HookProbe onValue={(v) => observed.push(v)} />);
    expect(observed[observed.length - 1]).toBe(false);

    act(() => { ctl.setMatches(true); });
    expect(observed[observed.length - 1]).toBe(true);

    act(() => { ctl.setMatches(false); });
    expect(observed[observed.length - 1]).toBe(false);
  });
});
