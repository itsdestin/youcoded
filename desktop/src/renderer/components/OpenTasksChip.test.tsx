// @vitest-environment jsdom
import React from 'react';
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
