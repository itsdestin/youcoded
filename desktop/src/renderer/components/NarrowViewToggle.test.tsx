// @vitest-environment jsdom
//
// Pins the direction of the narrow toggle. It shows the view you'd switch TO,
// not the one you're in — the kind of thing that reads as correct either way
// when you're editing the file and is only obviously wrong in the running app.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import NarrowViewToggle from './NarrowViewToggle';

beforeEach(() => cleanup());

describe('NarrowViewToggle', () => {
  it('offers the terminal while you are in chat', () => {
    render(<NarrowViewToggle viewMode="chat" onToggleView={vi.fn()} />);
    expect(screen.getByLabelText('Switch to terminal')).toBeTruthy();
    expect(screen.queryByLabelText('Switch to chat')).toBeNull();
  });

  it('offers chat while you are in the terminal', () => {
    render(<NarrowViewToggle viewMode="terminal" onToggleView={vi.fn()} />);
    expect(screen.getByLabelText('Switch to chat')).toBeTruthy();
    expect(screen.queryByLabelText('Switch to terminal')).toBeNull();
  });

  it('switches to the view it advertises', () => {
    const onToggleView = vi.fn();
    render(<NarrowViewToggle viewMode="chat" onToggleView={onToggleView} />);
    fireEvent.click(screen.getByLabelText('Switch to terminal'));
    expect(onToggleView).toHaveBeenCalledWith('terminal');
  });

  it('switches back the other way', () => {
    const onToggleView = vi.fn();
    render(<NarrowViewToggle viewMode="terminal" onToggleView={onToggleView} />);
    fireEvent.click(screen.getByLabelText('Switch to chat'));
    expect(onToggleView).toHaveBeenCalledWith('chat');
  });

  // ViewToggleHint anchors to this attribute. Drop it and the coach mark that
  // sends a stuck user back to chat silently never renders — nothing else fails.
  it('carries the coach-mark anchor', () => {
    const { container } = render(<NarrowViewToggle viewMode="terminal" onToggleView={vi.fn()} />);
    expect(container.querySelector('[data-view-toggle]')).toBeTruthy();
  });
});
