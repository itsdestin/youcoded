// @vitest-environment jsdom
import React, { useRef } from 'react';
import { act } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useToastClearance, TOAST_CLEARANCE_VAR } from './useToastClearance';
import { Toast } from '../components/ui/Toast';

// Card #11 a: notices must sit above the message area, which the message area reports as a CSS variable.
function Bar() {
  const ref = useRef<HTMLDivElement>(null);
  useToastClearance(ref, true);
  return <div ref={ref} />;
}
describe('toast clearance', () => {
  it('publishes the distance from the window bottom to the message area, and removes it on unmount', () => {
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
    const orig = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = () => ({ top: 700, bottom: 760, left: 0, right: 100, width: 100, height: 60, x: 0, y: 700, toJSON() {} }) as DOMRect;
    const { unmount } = render(<Bar />);
    expect(document.documentElement.style.getPropertyValue(TOAST_CLEARANCE_VAR)).toBe('208px'); // 900 - 700 + 8
    unmount();
    expect(document.documentElement.style.getPropertyValue(TOAST_CLEARANCE_VAR)).toBe('');
    Element.prototype.getBoundingClientRect = orig;
  });
  // Review 2026-11-13: a hidden or zero-size bar must never push the notice off the screen.
  const withBar = (rect: Partial<DOMRect>, attrs: Record<string, string> = {}, style = '') => {
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
    const orig = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = () => ({ top: 700, bottom: 760, left: 0, right: 100, width: 100, height: 60, x: 0, y: 700, toJSON() {}, ...rect }) as DOMRect;
    function B() { const r = useRef<HTMLDivElement>(null); useToastClearance(r, true); return <div ref={r} style={style ? Object.fromEntries(style.split(';').filter(Boolean).map((x) => x.split(':'))) : undefined} />; }
    const out = render(<B />);
    // React 19 reads inert="" as off, so the attribute is set the way the app's own code does it.
    if ('inert' in attrs) { out.container.firstElementChild!.setAttribute('inert', ''); act(() => { window.dispatchEvent(new Event('resize')); }); }
    return { ...out, restore: () => { Element.prototype.getBoundingClientRect = orig; } };
  };
  it.each([
    ['zero size', { width: 0, height: 0 }, {}, ''],
    ['inert (the terminal view\'s chrome)', {}, { inert: '' }, ''],
    ['display none', {}, {}, 'display:none'],
    ['top below the window', { top: 950 }, {}, ''],
  ] as const)('falls back to the default for a bar that is %s', (_n, rect, attrs, style) => {
    const { unmount, restore } = withBar(rect as any, attrs as any, style);
    expect(document.documentElement.style.getPropertyValue(TOAST_CLEARANCE_VAR)).toBe('');
    unmount(); restore();
  });
  it('re-measures when the bar becomes inert (a switch to the terminal view) and when the keyboard moves it', () => {
    const { container, unmount, restore } = withBar({});
    expect(document.documentElement.style.getPropertyValue(TOAST_CLEARANCE_VAR)).toBe('208px');
    // The keyboard lifts the bar 300px; the chat announces it.
    Element.prototype.getBoundingClientRect = () => ({ top: 400, bottom: 460, left: 0, right: 100, width: 100, height: 60 }) as DOMRect;
    act(() => { window.dispatchEvent(new Event('youcoded:keyboard-offset')); });
    expect(document.documentElement.style.getPropertyValue(TOAST_CLEARANCE_VAR)).toBe('508px');
    return Promise.resolve().then(async () => {
      container.firstElementChild!.setAttribute('inert', '');
      await new Promise((r) => setTimeout(r, 0));
      expect(document.documentElement.style.getPropertyValue(TOAST_CLEARANCE_VAR)).toBe('');
      unmount(); restore();
    });
  });
  it('the global Toast sits at that distance, falling back to 4rem', () => {
    const { container } = render(<Toast message="hi" onDismiss={() => {}} durationMs={null} />);
    expect((container.querySelector('[role="status"]') as HTMLElement).style.bottom).toBe('var(--toast-clearance, 4rem)');
    cleanup();
  });
});
