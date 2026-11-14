// @vitest-environment jsdom
import React, { useRef } from 'react';
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
    Element.prototype.getBoundingClientRect = () => ({ top: 700, bottom: 760, left: 0, right: 0, width: 0, height: 60, x: 0, y: 700, toJSON() {} }) as DOMRect;
    const { unmount } = render(<Bar />);
    expect(document.documentElement.style.getPropertyValue(TOAST_CLEARANCE_VAR)).toBe('208px'); // 900 - 700 + 8
    unmount();
    expect(document.documentElement.style.getPropertyValue(TOAST_CLEARANCE_VAR)).toBe('');
    Element.prototype.getBoundingClientRect = orig;
  });
  it('the global Toast sits at that distance, falling back to 4rem', () => {
    const { container } = render(<Toast message="hi" onDismiss={() => {}} durationMs={null} />);
    expect((container.querySelector('[role="status"]') as HTMLElement).style.bottom).toBe('var(--toast-clearance, 4rem)');
    cleanup();
  });
});
