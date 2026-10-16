// @vitest-environment jsdom
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

  it('lists the running task first, then the waiting ones, under "To do"; finished ones fold below', () => {
    render(
      <OpenTasksPopup
        open={true}
        tasks={[
          task({ id: '1', subject: 'Done thing', status: 'completed', orderIndex: 0 }),
          task({ id: '3', subject: 'Queued thing', status: 'pending', orderIndex: 1 }),
          task({ id: '2', subject: 'Running thing', status: 'in_progress', activeForm: 'Running', orderIndex: 2 }),
        ]}
        onClose={noop}
        onMarkInactive={noop}
        onUnhide={noop}
      />
    );
    const body = screen.getByRole('dialog').textContent!;
    const order = ['To do', 'Running', 'Queued thing', 'Other tasks', 'Completed', 'Done thing'].map((w) => body.indexOf(w));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
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

  it('fires onMarkInactive when the Mark inactive button is clicked', () => {
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
    const btn = screen.getByRole('button', { name: 'Mark "Thing" inactive' });
    fireEvent.click(btn);
    expect(onMarkInactive).toHaveBeenCalledWith('5');
  });

  it('shows a "Marked inactive" section at the bottom with an Unhide button per row', () => {
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
    render(
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
    // Queried off `document`, not `container`: this popup used to render inline,
    // and <Dialog> portals to document.body like every other dialog does.
    const scrim = document.querySelector('.layer-scrim');
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

describe('OpenTasksPopup folded sections', () => {
  it('folds Completed and Marked inactive in the shared fold, with no full-width line', () => {
    // Destin, submit-ticket-5#ST5-Q2: the sweep's hard line above "Marked inactive".
    render(
      <OpenTasksPopup open onClose={noop} onMarkInactive={noop} onUnhide={noop} tasks={[
        task({ id: '1', subject: 'Done thing', status: 'completed' }),
        task({ id: '2', subject: 'Hidden thing', status: 'pending', markedInactive: true, orderIndex: 1 }),
      ]} />,
    );
    for (const name of [/^Completed/, /^Marked inactive/]) {
      const row = screen.getByRole('button', { name });
      // The shared fold: a box holding its own header row (FoldRow), never a bare toggle.
      expect(row.parentElement!.className).toContain('has-[>button:hover]:bg-inset');
    }
    expect(document.querySelector('.border-t')).toBeNull();
  });
});

// WHY (Open tasks rework, 2026-10-13; Destin small-fixes-1#SF-8 "align with the new ui guide",
// built without review rounds): the popup is built only from the guide's existing pieces, and
// these pin the ones a later edit could quietly undo.
describe('OpenTasksPopup follows the guide', () => {
  const tasks = [
    task({ id: '7', subject: 'Fix it', activeForm: 'Fixing it', status: 'in_progress', orderIndex: 0, description: 'The longer note' }),
    task({ id: '8', subject: 'Test it', status: 'pending', orderIndex: 1 }),
    task({ id: '9', subject: 'Old idea', status: 'pending', orderIndex: 2, markedInactive: true }),
  ];

  it('puts every group in a labelled first-level card, so nothing sits bare on the popup', () => {
    render(<OpenTasksPopup open tasks={tasks} onClose={noop} onMarkInactive={noop} onUnhide={noop} />);
    for (const label of ['To do', 'Other tasks']) {
      const section = screen.getByText(label).closest('section')!;
      expect(section.querySelector(':scope > .surface-1')).toBeTruthy();
    }
  });

  it('keeps the running task\'s green Working pill (small-fixes-1#SF-8), on that row only', () => {
    render(<OpenTasksPopup open tasks={tasks} onClose={noop} onMarkInactive={noop} onUnhide={noop} />);
    const pills = screen.getAllByText('Working');
    expect(pills).toHaveLength(1);
    expect(pills[0].closest('li')!.textContent).toContain('Fixing it');
  });

  it('shows no task numbers, dots or crossed-out words, and says each task in the normal text colour', () => {
    render(<OpenTasksPopup open tasks={[...tasks, task({ id: '10', subject: 'Done', status: 'completed', orderIndex: 3 })]}
      onClose={noop} onMarkInactive={noop} onUnhide={noop} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).not.toMatch(/#\d/);
    expect(dialog.querySelector('.line-through, .font-mono, .rounded-full.w-2')).toBeNull();
  });

  it('makes Mark inactive and Unhide outlined buttons, never faded or bare text', () => {
    render(<OpenTasksPopup open tasks={tasks} onClose={noop} onMarkInactive={noop} onUnhide={noop} />);
    const outlined = screen.getByRole('button', { name: 'Mark "Fixing it" inactive' }).className;
    for (const name of ['Mark "Test it" inactive', 'Unhide "Old idea"']) {
      const cls = screen.getByRole('button', { name }).className;
      expect(cls).toBe(outlined);
      expect(cls).not.toContain('opacity-40');
    }
    expect(outlined).toContain('border');
  });

  it('says "No open tasks" inside the To do card when nothing is left', () => {
    render(<OpenTasksPopup open tasks={[]} onClose={noop} onMarkInactive={noop} onUnhide={noop} />);
    const line = screen.getByText('No open tasks.');
    expect(line.closest('.surface-1')).toBeTruthy();
    expect(screen.queryByText('Other tasks')).toBeNull();
  });
});
