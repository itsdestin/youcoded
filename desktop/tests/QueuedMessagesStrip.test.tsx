// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import QueuedMessagesStrip from '../src/renderer/components/QueuedMessagesStrip';

const preview = vi.hoisted(() => ({ mode: null as string | null }));
vi.mock('../src/renderer/workbench-mode', () => ({ workbenchQueuePreview: () => preview.mode }));

describe('QueuedMessagesStrip', () => {
  beforeEach(() => { preview.mode = null; });

  it('dismisses an unconfirmed row directly without a confirmation or resend', () => {
    const onCancel = vi.fn(); const onSendNow = vi.fn();
    render(<QueuedMessagesStrip queuedMessages={[{ queueId: 'a', content: 'unknown delivery', timestamp: 0, status: 'uncertain' }]} onCancel={onCancel} onSendNow={onSendNow} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss without resending' }));
    expect(onCancel).toHaveBeenCalledWith('a'); expect(onSendNow).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('previews direct dismissal without a blocked-state replacement', () => {
    preview.mode = 'uncertain-after';
    const onSendNow = vi.fn();
    const onCancel = vi.fn();
    render(<QueuedMessagesStrip queuedMessages={[]} onSendNow={onSendNow} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss without resending' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('Unconfirmed')).toBeNull();
    expect(screen.queryByText(/Sending is still blocked/)).toBeNull();
    expect(onSendNow).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('previews immediate delivery quietly but leaves genuinely waiting rows visible', () => {
    preview.mode = 'idle-after';
    const view = render(<QueuedMessagesStrip queuedMessages={[]} />);
    expect(screen.queryByLabelText('Queued messages')).toBeNull();
    preview.mode = 'waiting-after';
    view.rerender(<QueuedMessagesStrip queuedMessages={[]} />);
    expect(screen.getByText('Queued')).toBeTruthy();
  });
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
