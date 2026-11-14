// @vitest-environment jsdom
// Round 4 review: BrailleBurst's 500 ms particle clean-up timer is cleared when the button goes away.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import BrailleBurst from '../src/renderer/components/BrailleBurst';

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('BrailleBurst timer', () => {
  it('unmounting inside the 500 ms leaves no pending timer', () => {
    vi.useFakeTimers();
    const { getByRole, unmount } = render(<BrailleBurst onTrigger={() => {}}>go</BrailleBurst>);
    fireEvent.click(getByRole('button'));
    expect(vi.getTimerCount()).toBeGreaterThan(0);   // the clean-up is scheduled
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('still clears the particles after 500 ms when it stays mounted', () => {
    vi.useFakeTimers();
    const { getByRole } = render(<BrailleBurst onTrigger={() => {}}>go</BrailleBurst>);
    fireEvent.click(getByRole('button'));
    expect(getByRole('button').querySelectorAll('span').length).toBe(5);
    act(() => { vi.advanceTimersByTime(500); });
    expect(getByRole('button').querySelectorAll('span').length).toBe(0);
  });
});
