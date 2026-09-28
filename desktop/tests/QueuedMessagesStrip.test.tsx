// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import QueuedMessagesStrip from '../src/renderer/components/QueuedMessagesStrip';

describe('QueuedMessagesStrip', () => {
  it('Send now names the waiting message it sends, and says in words that it stops the task', () => {
    const onSendNow = vi.fn();
    render(<QueuedMessagesStrip
      queuedMessages={[{ queueId: 'a', content: 'first', timestamp: 0 }, { queueId: 'b', content: 'second', timestamp: 0 }]}
      onSendNow={onSendNow} onCancel={() => {}} onEdit={() => {}} />);
    const buttons = screen.getAllByRole('button', { name: 'Stop the current task and send this message now' });
    expect(buttons).toHaveLength(2);
    expect(buttons[1].textContent).toBe('Send now');
    fireEvent.click(buttons[1]);
    expect(onSendNow).toHaveBeenCalledWith('b');
  });

  it('shows no Send now button where the host cannot offer one', () => {
    render(<QueuedMessagesStrip queuedMessages={[{ queueId: 'a', content: 'first', timestamp: 0 }]} onCancel={() => {}} />);
    expect(screen.queryByText('Send now')).toBeNull();
  });
});
