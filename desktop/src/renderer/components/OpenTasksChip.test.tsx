// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import OpenTasksChip from './OpenTasksChip';

describe('OpenTasksChip', () => {
  beforeEach(() => {
    cleanup();
  });

  it('renders nothing when running=0 and pending=0', () => {
    const { container } = render(
      <OpenTasksChip running={0} pending={0} onOpen={() => {}} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders both counts when both are nonzero', () => {
    render(<OpenTasksChip running={1} pending={2} onOpen={() => {}} />);
    const btn = screen.getByRole('button');
    expect(btn.textContent).toContain('1');
    expect(btn.textContent).toContain('2');
    expect(btn.textContent?.toUpperCase()).toContain('TASKS');
  });

  it('omits zero counts from the label', () => {
    render(<OpenTasksChip running={0} pending={3} onOpen={() => {}} />);
    const btn = screen.getByRole('button');
    expect(btn.textContent).toContain('3');
    expect(btn.textContent).not.toMatch(/\b0\b/);
  });

  it('fires onOpen when clicked', () => {
    const onOpen = vi.fn();
    render(<OpenTasksChip running={1} pending={0} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('aria-label omits zero count', () => {
    render(<OpenTasksChip running={0} pending={3} onOpen={() => {}} />);
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-label')).not.toContain('0 in progress');
    expect(btn.getAttribute('aria-label')).toContain('3 pending');
  });
});

// WHY (Open tasks rework, 2026-10-13; small-fixes-3#SF3-10): status hues stay out of the words —
// the counts were hand-typed blue and amber. The running count's state is the green dot.
describe('OpenTasksChip colours', () => {
  it('draws no coloured text, and marks the running count with the green status dot', () => {
    cleanup();
    render(<OpenTasksChip running={1} pending={2} onOpen={() => {}} />);
    const btn = screen.getByRole('button');
    for (const el of [btn, ...btn.querySelectorAll('*')]) expect((el as HTMLElement).style.color).not.toMatch(/#|rgb\((96|251)/);
    expect(btn.querySelectorAll('.bg-green-400')).toHaveLength(1);
  });
});
