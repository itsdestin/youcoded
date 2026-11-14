// @vitest-environment jsdom
// The phone's connection band above the message box (components/ConnectionStrip.tsx): what each state says, Refresh, and the
// short "Up to date." after catching up.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('../src/renderer/state/chat-context', () => ({ useSessionIsEmpty: () => false }));
import { ConnectionStrip } from '../src/renderer/components/ConnectionStrip';

describe('the phone\'s connection band', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('says nothing for a conversation that is up to date, as on the computer', () => {
    const { container } = render(<ConnectionStrip sessionId="s1" />);
    expect(container.textContent).toBe('');
    render(<ConnectionStrip sessionId="s1" conversationStatus="complete" />);
    expect(container.textContent).toBe('');
  });

  it('says what is happening in each state, and Refresh asks for a fresh copy', () => {
    const onRefresh = vi.fn();
    const { rerender } = render(<ConnectionStrip sessionId="s1" conversationStatus="reconnecting" onRefresh={onRefresh} />);
    expect(screen.getByText('Reconnecting to your computer…')).toBeTruthy();
    rerender(<ConnectionStrip sessionId="s1" conversationStatus="restoring" onRefresh={onRefresh} />);
    expect(screen.getByText('Catching up with your computer…')).toBeTruthy();
    rerender(<ConnectionStrip sessionId="s1" conversationStatus="incomplete" onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    rerender(<ConnectionStrip sessionId="s1" conversationStatus="complete" waitingForComputer onRefresh={onRefresh} />);
    expect(screen.getByText('Up to date.')).toBeTruthy();
  });

  it('shows "Up to date." for a moment after catching up, then the slow-computer line if that still applies, else nothing', () => {
    vi.useFakeTimers();
    const { rerender, container } = render(<ConnectionStrip sessionId="s1" conversationStatus="restoring" />);
    rerender(<ConnectionStrip sessionId="s1" conversationStatus="complete" waitingForComputer />);
    expect(screen.getByText('Up to date.')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(2600); });
    expect(screen.getByText('Waiting for your computer…')).toBeTruthy();
    rerender(<ConnectionStrip sessionId="s1" conversationStatus="complete" />);
    expect(container.textContent).toBe('');
  });

  // Card #182 (deck C-6): the person's own words, after about 20 s of silence.
  it('after about 20 s of no answer says the computer may be asleep or off, and a computer that answers clears it', () => {
    vi.useFakeTimers();
    const { rerender, container } = render(<ConnectionStrip sessionId="s1" conversationStatus="complete" waitingForComputer />);
    act(() => { vi.advanceTimersByTime(14_000); });
    expect(screen.getByText('Waiting for your computer…')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1_500); });
    expect(container.textContent).toBe("Can't reach your computer. It may be asleep or off. YouCoded will keep trying.");
    rerender(<ConnectionStrip sessionId="s1" conversationStatus="complete" />);
    expect(container.textContent).toBe('');
  });

  it('a dropped connection waits the full 20 s before guessing', () => {
    vi.useFakeTimers();
    const { container } = render(<ConnectionStrip sessionId="s1" conversationStatus="reconnecting" />);
    act(() => { vi.advanceTimersByTime(19_000); });
    expect(screen.getByText('Reconnecting to your computer…')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1_500); });
    expect(container.textContent).toContain("Can't reach your computer.");
  });
});
