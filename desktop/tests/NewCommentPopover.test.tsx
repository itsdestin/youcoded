// @vitest-environment jsdom
// NewCommentPopover — Reading mode's / a code file's "add a comment" popup.
// Destin, 2026-09-28: the Cancel/Comment buttons below the textarea are
// replaced with the same in-field round-arrow send control ReplyField and
// CommentCard's draft box use. Enter-sends, Escape-cancels and the
// click-away-commits behaviour are unchanged — see the file's own WHY.
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { NewCommentPopover } from '../src/renderer/components/comments/NewCommentPopover';
import type { DocComment } from '../src/renderer/state/doc-comments-store';

afterEach(cleanup);

function baseComment(overrides: Partial<DocComment> = {}): DocComment {
  return {
    id: 'c-draft',
    path: 'notes.md',
    quote: 'the quick brown fox',
    sourceLabel: 'notes.md',
    text: '',
    author: 'user',
    createdAt: Date.now(),
    replies: [],
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
    ...overrides,
  };
}

// A real element: anchor-position.ts's `boundsFor` calls `.closest()` on it.
const bounds = document.createElement('div');

function renderPopover(text: string) {
  const onTextChange = vi.fn();
  const onDone = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <NewCommentPopover
      comment={baseComment({ text })}
      anchorRect={new DOMRect(0, 0, 10, 10)}
      boundsEl={bounds}
      onTextChange={onTextChange}
      onDone={onDone}
      onCancel={onCancel}
    />,
  );
  return { ...utils, onTextChange, onDone, onCancel };
}

describe('NewCommentPopover — same send control as ReplyField (no Cancel/Comment buttons)', () => {
  it('renders no "Cancel" or "Comment" buttons', () => {
    renderPopover('');
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Comment' })).toBeNull();
  });

  it('renders a "Post comment" arrow button, disabled while the draft is empty', () => {
    renderPopover('');
    expect(screen.getByRole('button', { name: /post comment/i })).toBeDisabled();
  });

  it('a non-empty draft enables the arrow; clicking it calls onDone', () => {
    const { onDone } = renderPopover('a real note');
    const post = screen.getByRole('button', { name: /post comment/i });
    expect(post).not.toBeDisabled();
    fireEvent.click(post);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('Enter still calls onDone (send), Escape still calls onCancel', () => {
    const { onDone } = renderPopover('typed before Enter');
    const box = screen.getByPlaceholderText(/add a comment…/i);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('Escape calls onCancel', () => {
    const { onCancel } = renderPopover('');
    const box = screen.getByPlaceholderText(/add a comment…/i);
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('typing calls onTextChange with the new value', () => {
    const { onTextChange } = renderPopover('');
    const box = screen.getByPlaceholderText(/add a comment…/i);
    fireEvent.change(box, { target: { value: 'hello' } });
    expect(onTextChange).toHaveBeenCalledWith('hello');
  });
});
