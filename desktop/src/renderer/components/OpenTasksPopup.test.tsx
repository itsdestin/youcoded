// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import OpenTasksPopup from './OpenTasksPopup';
import type { TaskState } from '../state/task-state';

// WHY: testing-library does not auto-cleanup in vitest; without this each test
// accumulates DOM from previous renders, causing getByRole/getByText to find
// multiple matches or wrong elements.
afterEach(cleanup);

const noop = () => {};

function task(overrides: Partial<TaskState> & { id: string }): TaskState {
  return { events: [], orderIndex: 0, ...overrides } as TaskState;
}

describe('OpenTasksPopup', () => {
  it('returns null when open=false', () => {
    const { container } = render(
      <OpenTasksPopup
        open={false}
        tasks={[task({ id: '1', subject: 'X', status: 'in_progress' })]}
        onClose={noop}
        onMarkInactive={noop}
        onUnhide={noop}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('groups tasks by status with "In Progress", "Pending", "Completed" sections', () => {
    render(
      <OpenTasksPopup
        open={true}
        tasks={[
          task({ id: '1', subject: 'Done thing', status: 'completed', orderIndex: 0 }),
          task({ id: '2', subject: 'Running thing', status: 'in_progress', activeForm: 'Running', orderIndex: 1 }),
          task({ id: '3', subject: 'Queued thing', status: 'pending', orderIndex: 2 }),
        ]}
        onClose={noop}
        onMarkInactive={noop}
        onUnhide={noop}
      />
    );
    const body = screen.getByRole('dialog').textContent!;
    const inProgressIdx = body.toLowerCase().indexOf('in progress');
    const pendingIdx = body.toLowerCase().indexOf('pending');
    const completedIdx = body.toLowerCase().indexOf('completed');
    expect(inProgressIdx).toBeGreaterThanOrEqual(0);
    expect(pendingIdx).toBeGreaterThan(inProgressIdx);
    expect(completedIdx).toBeGreaterThan(pendingIdx);
  });

  it('uses activeForm as the row title when task is in_progress', () => {
    render(
      <OpenTasksPopup
        open={true}
        tasks={[task({ id: '2', subject: 'Default', activeForm: 'Running things…', status: 'in_progress' })]}
        onClose={noop}
        onMarkInactive={noop}
        onUnhide={noop}
      />
    );
    expect(screen.getByText(/Running things…/)).toBeTruthy();
  });

  it('fires onMarkInactive when the Mark Inactive button is clicked', () => {
    const onMarkInactive = vi.fn();
    render(
      <OpenTasksPopup
        open={true}
        tasks={[task({ id: '5', subject: 'Thing', status: 'pending' })]}
        onClose={noop}
        onMarkInactive={onMarkInactive}
        onUnhide={noop}
      />
    );
    const btn = screen.getByRole('button', { name: /mark task #5 inactive/i });
    fireEvent.click(btn);
    expect(onMarkInactive).toHaveBeenCalledWith('5');
  });

  it('shows a "Marked Inactive" section at the bottom with an Unhide button per row', () => {
    const onUnhide = vi.fn();
    render(
      <OpenTasksPopup
        open={true}
        tasks={[task({ id: '9', subject: 'Stale', status: 'pending', markedInactive: true })]}
        onClose={noop}
        onMarkInactive={noop}
        onUnhide={onUnhide}
      />
    );
    expect(screen.getByText(/marked inactive/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /unhide/i }));
    expect(onUnhide).toHaveBeenCalledWith('9');
  });

  it('renders "No open tasks" when every task is completed', () => {
    render(
      <OpenTasksPopup
        open={true}
        tasks={[task({ id: '1', subject: 'Done', status: 'completed' })]}
        onClose={noop}
        onMarkInactive={noop}
        onUnhide={noop}
      />
    );
    expect(screen.getByText(/no open tasks/i)).toBeTruthy();
  });

  it('fires onClose when scrim is clicked', () => {
    const onClose = vi.fn();
    const { container } = render(
      <OpenTasksPopup
        open={true}
        tasks={[task({ id: '1', subject: 'X', status: 'pending' })]}
        onClose={onClose}
        onMarkInactive={noop}
        onUnhide={noop}
      />
    );
    // Scrim primitive does not forward arbitrary props, so find it by its
    // theme-driven class name rather than a test id.
    const scrim = container.querySelector('.layer-scrim');
    expect(scrim).toBeTruthy();
    fireEvent.click(scrim!);
    expect(onClose).toHaveBeenCalled();
  });

  it('completed section stays collapsed when >5 entries', () => {
    const many = Array.from({ length: 6 }, (_, i) => task({
      id: String(i + 1),
      subject: `Done ${i + 1}`,
      status: 'completed',
      orderIndex: i,
    }));
    render(
      <OpenTasksPopup
        open={true}
        tasks={many}
        onClose={noop}
        onMarkInactive={noop}
        onUnhide={noop}
      />
    );
    // With 6 completed entries, the section header should say "6" but the rows
    // should not be rendered until the toggle is clicked.
    const toggle = screen.getByRole('button', { name: /completed/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Done 1')).toBeNull();
    expect(screen.queryByText('Done 6')).toBeNull();
  });
});
