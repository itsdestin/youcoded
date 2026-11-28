// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { MarkdownView } from './MarkdownView';

afterEach(cleanup);

const base = { path: 'plants.md', absolutePath: '/x/plants.md', isEditable: true, contentInfo: null } as const;

describe('ticking a task list in the file viewer', () => {
  it('turns the checkboxes on and reports the file text with just that item ticked', () => {
    const onToggleTask = vi.fn();
    const { container } = render(<MarkdownView {...base} content={'- [ ] water\n- [x] prune\n'} onToggleTask={onToggleTask} />);
    const boxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(boxes.length).toBe(2);
    expect(boxes[0].disabled).toBe(false);
    fireEvent.click(boxes[0]);
    expect(onToggleTask).toHaveBeenCalledWith('- [x] water\n- [x] prune\n');
  });

  it('leaves the boxes alone when the file cannot be saved', () => {
    const { container } = render(<MarkdownView {...base} content={'- [ ] water\n'} />);
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true);
  });
});
