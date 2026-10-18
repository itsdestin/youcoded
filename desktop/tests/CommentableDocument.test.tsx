// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CommentableDocument } from '../src/renderer/components/comments/CommentableDocument';
import { addComment, useDocComments, __resetDocCommentsStoreForTest } from '../src/renderer/state/doc-comments-store';
import { renderHook } from '@testing-library/react';

const pane = vi.hoisted(() => ({ narrow: true }));
vi.mock('../src/renderer/hooks/use-container-narrow', () => ({
  useContainerNarrow: () => [React.useRef(null), pane.narrow],
}));

afterEach(() => {
  document.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true }), { pointerType: 'mouse' }));
  __resetDocCommentsStoreForTest(); vi.useRealTimers();
});

function seed() {
  const id = addComment('hover.md', 'selected words', 'hover.md');
  const { result } = renderHook(() => useDocComments('hover.md'));
  act(() => { result.current.setCommentText(id, 'A note to hover.'); result.current.clearFocus(); });
  return id;
}

function view() {
  return <CommentableDocument path="hover.md" source="rendered" commentsMode="comments"><p>Some selected words to discuss.</p></CommentableDocument>;
}

describe('CommentableDocument comment views', () => {
  it('keeps hoverable highlights and no marker rail in a narrow pane', () => {
    pane.narrow = true;
    const id = seed();
    const { container } = render(view());
    expect(container.querySelector('[data-marker-id]')).toBeNull();
    expect(container.querySelector('[data-comments-pane]')).toBeNull();
    const highlight = container.querySelector<HTMLElement>(`[data-comment-id="${id}"]`)!;
    expect(highlight).toBeTruthy();
    vi.useFakeTimers();
    fireEvent.mouseEnter(highlight);
    act(() => { vi.runOnlyPendingTimers(); });
    const note = screen.getByText('A note to hover.');
    expect(note).toBeVisible();
    expect(note.closest('[data-hover-card]')?.parentElement).toBe(document.body);
  });

  it('opens the comment popup on touch so removing the rail does not hide comments on phones', () => {
    pane.narrow = true;
    const id = seed();
    const { container } = render(view());
    const highlight = container.querySelector<HTMLElement>(`[data-comment-id="${id}"]`)!;
    document.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true }), { pointerType: 'touch' }));
    fireEvent.click(highlight);
    expect(screen.getByText('A note to hover.')).toBeVisible();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('A note to hover.')).toBeNull();
  });

  it('shows the full comments panel when there is room', () => {
    pane.narrow = false;
    seed();
    const { container } = render(view());
    expect(container.querySelector('[data-comments-pane]')).toBeTruthy();
    expect(screen.getByText('A note to hover.')).toBeVisible();
  });
});
