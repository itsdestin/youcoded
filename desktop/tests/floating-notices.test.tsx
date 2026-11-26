// @vitest-environment jsdom
// The app's two floating slots (waiting-notice T3): quick notices never push out a notice that needs you,
// nothing that needs you is ever dropped, Dismiss closes only the top one, and the same sentence twice restarts the timer.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';
import FloatingNotices from '../src/renderer/components/FloatingNotices';
import { announce } from '../src/renderer/utils/announce';
import { resetFloatingNotices, showRoutineToast } from '../src/renderer/state/floating-notices';

beforeEach(() => { vi.useFakeTimers(); resetFloatingNotices(); });
afterEach(() => { cleanup(); vi.useRealTimers(); resetFloatingNotices(); });

const needs = (m: string, label?: string, onClick = () => {}) => act(() => announce(m, undefined, label ? { label, onClick } : undefined, { untilClosed: true }));

describe('floating notices', () => {
  it('a quick toast during an open needs-you notice shows beside it and does not remove it', () => {
    render(<FloatingNotices />);
    needs('We turned off a plugin.');
    act(() => announce('Copied'));
    expect(screen.getByText('Copied')).toBeTruthy();
    expect(screen.getByText('We turned off a plugin.')).toBeTruthy();
    // Even after the quick one runs out, and after someone clears "the toast", the needs-you notice is still there.
    act(() => { vi.advanceTimersByTime(4000); });
    expect(screen.queryByText('Copied')).toBeNull();
    act(() => showRoutineToast(null));
    expect(screen.getByText('We turned off a plugin.')).toBeTruthy();
  });

  it('the quick toast stacks above the needs-you one, never overlapping (they share one column)', () => {
    const { container } = render(<FloatingNotices />);
    needs('Needs you');
    act(() => announce('Quick'));
    const col = container.firstElementChild as HTMLElement;
    const texts = Array.from(col.querySelectorAll('[role="status"]')).map((e) => e.textContent ?? '');
    expect(texts[0]).toContain('Quick');
    expect(texts[1]).toContain('Needs you');
    expect(col.className).toContain('flex-col');
  });

  it('none is dropped with four waiting: they show one at a time, in order, with "N more"', () => {
    render(<FloatingNotices />);
    ['one', 'two', 'three', 'four'].forEach((m) => needs(`notice ${m}`));
    expect(screen.getByText(/notice one/)).toBeTruthy();
    expect(screen.getByText(/3 more/)).toBeTruthy();
    for (const [i, m] of ['two', 'three', 'four'].entries()) {
      fireEvent.click(screen.getByText('Dismiss'));
      expect(screen.getByText(new RegExp(`notice ${m}`))).toBeTruthy();
      if (i < 2) expect(screen.getByText(new RegExp(`${2 - i} more`))).toBeTruthy();
    }
    fireEvent.click(screen.getByText('Dismiss'));
    expect(screen.queryByText(/notice/)).toBeNull();
  });

  it('Dismiss closes only the top notice, and its own button closes only that one too', () => {
    const act1 = vi.fn();
    render(<FloatingNotices />);
    needs('first', 'Show', act1);
    needs('second');
    fireEvent.click(screen.getByText('Dismiss'));
    expect(screen.queryByText(/first/)).toBeNull();
    expect(screen.getByText(/second/)).toBeTruthy();
    needs('third', 'Open', act1);
    needs('fourth');
    // second is on top; close it, third has a button: pressing it runs the action and closes only third.
    fireEvent.click(screen.getByText('Dismiss'));
    fireEvent.click(screen.getByText('Open'));
    expect(act1).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/third/)).toBeNull();
    expect(screen.getByText(/fourth/)).toBeTruthy();
  });

  it('a notice that needs you has no timer: it is still there a minute later', () => {
    render(<FloatingNotices />);
    needs('still here');
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText('still here')).toBeTruthy();
  });

  it('the same sentence shown twice restarts its timer instead of running out on the first countdown', () => {
    render(<FloatingNotices />);
    act(() => announce('Copied'));
    act(() => { vi.advanceTimersByTime(2000); });
    act(() => announce('Copied'));
    act(() => { vi.advanceTimersByTime(2000); }); // 4 s after the first, 2 s after the second: old timer would have closed it
    expect(screen.getByText('Copied')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1100); });
    expect(screen.queryByText('Copied')).toBeNull();
  });

  it('the same needs-you sentence arriving twice is listed once (it would only repeat itself)', () => {
    render(<FloatingNotices />);
    needs('same thing', 'Show'); needs('same thing', 'Show');
    expect(screen.queryByText(/more/)).toBeNull();
  });
});
