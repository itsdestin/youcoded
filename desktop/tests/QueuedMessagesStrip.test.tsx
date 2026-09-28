// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import QueuedMessagesStrip from '../src/renderer/components/QueuedMessagesStrip';

describe('QueuedMessagesStrip', () => {
  it('Send now sends the message it sits on, and is last in the row after the trash button', () => {
    const onSendNow = vi.fn();
    render(<QueuedMessagesStrip
      queuedMessages={[{ queueId: 'a', content: 'first', timestamp: 0 }, { queueId: 'b', content: 'second', timestamp: 0 }]}
      onSendNow={onSendNow} onCancel={() => {}} onEdit={() => {}} />);
    const buttons = screen.getAllByRole('button', { name: 'Interrupt and send now' });
    expect(buttons).toHaveLength(2);
    // Its hover words say what it does, including that it interrupts.
    expect(buttons[1].textContent).toBe('Interrupt and Send Now');
    // Rightmost: the trash (Cancel) sits immediately to its left.
    expect(buttons[1].previousElementSibling?.getAttribute('aria-label')).toBe('Cancel queued message');
    expect(buttons[1].nextElementSibling).toBeNull();
    fireEvent.click(buttons[1]);
    expect(onSendNow).toHaveBeenCalledWith('b');
  });

  it('shows no Send now button where the host cannot offer one', () => {
    render(<QueuedMessagesStrip queuedMessages={[{ queueId: 'a', content: 'first', timestamp: 0 }]} onCancel={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Interrupt and send now' })).toBeNull();
  });
});
