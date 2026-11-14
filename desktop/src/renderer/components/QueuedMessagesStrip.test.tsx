// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import QueuedMessagesStrip from './QueuedMessagesStrip';

// Task 12: docked strip for queued messages. Mocking approach mirrors the
// deleted UserMessage affordance test (Task 11) — QueuedMessagesStrip does no
// IPC/dispatch itself (pure callback-prop component), so these tests cover
// render-gating (nothing queued → nothing rendered) and that clicks call
// through with the right args, mirroring how ChatView actually wires
// sessionId + queueId + text through to App's handlers.

afterEach(() => {
  cleanup();
});

describe('QueuedMessagesStrip (Task 12)', () => {
  it('renders nothing when queuedMessages is empty', () => {
    const { container } = render(
      <QueuedMessagesStrip queuedMessages={[]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders one row per queued message with its content and a Queued label', () => {
    render(
      <QueuedMessagesStrip
        queuedMessages={[
          { queueId: 'q-1', content: 'first queued message', timestamp: 1 },
          { queueId: 'q-2', content: 'second queued message', timestamp: 2 },
        ]}
      />,
    );
    expect(screen.getByText('first queued message')).toBeInTheDocument();
    expect(screen.getByText('second queued message')).toBeInTheDocument();
    expect(screen.getAllByText('Queued')).toHaveLength(2);
  });

  it('renders neither affordance when no handlers are wired', () => {
    render(
      <QueuedMessagesStrip
        queuedMessages={[{ queueId: 'q-1', content: 'hello', timestamp: 1 }]}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Cancel queued message' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit queued message' })).not.toBeInTheDocument();
  });

  it('renders only Cancel when onEdit is not provided', () => {
    render(
      <QueuedMessagesStrip
        queuedMessages={[{ queueId: 'q-1', content: 'hello', timestamp: 1 }]}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Cancel queued message' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit queued message' })).not.toBeInTheDocument();
  });

  it('renders both affordances and wires clicks with (queueId[, content])', () => {
    const onCancel = vi.fn();
    const onEdit = vi.fn();
    render(
      <QueuedMessagesStrip
        queuedMessages={[{ queueId: 'q-42', content: 'edit me please', timestamp: 1 }]}
        onCancel={onCancel}
        onEdit={onEdit}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }));
    expect(onCancel).toHaveBeenCalledWith('q-42');

    fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }));
    expect(onEdit).toHaveBeenCalledWith('q-42', 'edit me please');
  });

  it('each row targets its OWN queueId when multiple are queued', () => {
    const onCancel = vi.fn();
    render(
      <QueuedMessagesStrip
        queuedMessages={[
          { queueId: 'q-1', content: 'first', timestamp: 1 },
          { queueId: 'q-2', content: 'second', timestamp: 2 },
        ]}
        onCancel={onCancel}
      />,
    );
    const cancelButtons = screen.getAllByRole('button', { name: 'Cancel queued message' });
    expect(cancelButtons).toHaveLength(2);
    fireEvent.click(cancelButtons[1]);
    expect(onCancel).toHaveBeenCalledWith('q-2');
  });

  // Card #62: a waiting message with files shows names (never full paths); extras fold into "+N more".
  it('shows file-name chips for attachments, not full paths, and folds extras', () => {
    render(
      <QueuedMessagesStrip
        queuedMessages={[{ queueId: 'q-f', content: 'see these', timestamp: 1, status: 'waiting',
          attachments: ['/home/me/a.pdf', 'C:\\Users\\me\\b.png', '/x/c.txt', '/x/d.txt', '/x/e.txt'] }]}
      />,
    );
    expect(screen.getByText('a.pdf')).toBeInTheDocument();
    expect(screen.getByText('b.png')).toBeInTheDocument();
    expect(screen.queryByText(/home\/me/)).toBeNull();
    expect(screen.getByText('+2 more')).toBeInTheDocument();
  });

  it('draws no chip row when nothing is attached', () => {
    render(<QueuedMessagesStrip queuedMessages={[{ queueId: 'q-n', content: 'plain', timestamp: 1 }]} />);
    expect(screen.queryByTestId('queued-file-chips')).toBeNull();
  });

  // Card #62 (Destin 2026-11-12): chips sit in the same row as the words, after them, and a long message does not hide them.
  it('puts the file chips in the same row as the message words, after them', () => {
    render(<QueuedMessagesStrip queuedMessages={[{ queueId: 'q-i', content: 'a very long message '.repeat(20), timestamp: 1, status: 'waiting', attachments: ['/x/a.pdf'] }]} />);
    const row = screen.getByTestId('queued-row-text');
    const chips = screen.getByTestId('queued-file-chips');
    expect(chips.parentElement).toBe(row);
    expect(row.firstElementChild).not.toBe(chips);          // words first, chips after
    expect(row.firstElementChild).toHaveClass('truncate');  // the words give way, the chips stay
    expect(chips).toHaveClass('shrink-0');
  });
});
