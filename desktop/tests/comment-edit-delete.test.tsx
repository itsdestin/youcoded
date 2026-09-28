// @vitest-environment jsdom
// Edit/delete build (E-1..E-6, docs/active/design/2026-09-24-doc-comments/
// doc-comments.edit-delete.questions.answers.json): CommentCard's and
// HighlightHoverCard's own Edit/Delete icons, inline editor and inline
// delete-confirm (components/comments/CommentActions.tsx, shared by both).
// Store-level editComment/editReply/deleteComment/deleteReply are pinned
// separately in use-doc-comments.test.tsx; these pin the UI that drives them.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { CommentCard } from '../src/renderer/components/comments/CommentCard';
import { HighlightHoverCard } from '../src/renderer/components/comments/HighlightHoverCard';
import type { DocComment } from '../src/renderer/state/doc-comments-store';

afterEach(cleanup);

function baseComment(overrides: Partial<DocComment> = {}): DocComment {
  return {
    id: 'c-1',
    path: 'notes.md',
    quote: 'the quick brown fox',
    sourceLabel: 'notes.md',
    text: 'A note about this passage.',
    author: 'user',
    createdAt: Date.now(),
    replies: [],
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
    ...overrides,
  };
}

const noop = () => {};

describe('CommentCard — Edit/Delete icons next to the Resolve toggle (E-1)', () => {
  it('renders neither icon when the edit/delete handlers are not wired (existing callers keep working)', () => {
    render(<CommentCard comment={baseComment()} onTextChange={noop} onReply={noop} onResolve={noop} onReopen={noop} onDelete={noop} />);
    expect(screen.queryByLabelText(/edit comment/i)).toBeNull();
    expect(screen.queryByLabelText(/delete comment/i)).toBeNull();
    // The resolve toggle itself is unaffected.
    expect(screen.getByTitle(/resolve this comment/i)).toBeTruthy();
  });

  it('renders both icons, alongside the resolve toggle, when wired', () => {
    render(
      <CommentCard
        comment={baseComment()}
        onTextChange={noop} onReply={noop} onResolve={noop} onReopen={noop} onDelete={noop}
        onEditText={noop} onDeleteComment={noop}
      />,
    );
    expect(screen.getByLabelText(/edit comment/i)).toBeTruthy();
    expect(screen.getByLabelText(/delete comment/i)).toBeTruthy();
    expect(screen.getByTitle(/resolve this comment/i)).toBeTruthy();
  });

  it('a DRAFT (nothing persisted yet) gets neither icon, even when the handlers are wired', () => {
    render(
      <CommentCard
        comment={baseComment({ text: '', replies: [] })}
        onTextChange={noop} onReply={noop} onResolve={noop} onReopen={noop} onDelete={noop}
        onEditText={noop} onDeleteComment={noop}
      />,
    );
    expect(screen.queryByLabelText(/edit comment/i)).toBeNull();
    expect(screen.queryByLabelText(/delete comment/i)).toBeNull();
  });

  it('Edit opens an inline textarea seeded with the current text; Enter saves the trimmed text and closes it', () => {
    const onEditText = vi.fn();
    render(
      <CommentCard
        comment={baseComment({ text: 'Original note.' })}
        onTextChange={noop} onReply={noop} onResolve={noop} onReopen={noop} onDelete={noop}
        onEditText={onEditText} onDeleteComment={noop}
      />,
    );
    fireEvent.click(screen.getByLabelText(/edit comment/i));
    const box = screen.getByPlaceholderText(/edit…/i) as HTMLTextAreaElement;
    expect(box.value).toBe('Original note.');
    fireEvent.change(box, { target: { value: '  A better note.  ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onEditText).toHaveBeenCalledWith('A better note.');
    // Back to plain display — the textarea is gone.
    expect(screen.queryByPlaceholderText(/edit…/i)).toBeNull();
  });

  it('Escape cancels the edit without saving, restoring the original text', () => {
    const onEditText = vi.fn();
    render(
      <CommentCard
        comment={baseComment({ text: 'Original note.' })}
        onTextChange={noop} onReply={noop} onResolve={noop} onReopen={noop} onDelete={noop}
        onEditText={onEditText} onDeleteComment={noop}
      />,
    );
    fireEvent.click(screen.getByLabelText(/edit comment/i));
    const box = screen.getByPlaceholderText(/edit…/i) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'a change nobody asked to save' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onEditText).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText(/edit…/i)).toBeNull();
    expect(screen.getByText('Original note.')).toBeTruthy();
  });

  it('the Cancel button also discards the edit without saving', () => {
    const onEditText = vi.fn();
    render(
      <CommentCard
        comment={baseComment({ text: 'Original note.' })}
        onTextChange={noop} onReply={noop} onResolve={noop} onReopen={noop} onDelete={noop}
        onEditText={onEditText} onDeleteComment={noop}
      />,
    );
    fireEvent.click(screen.getByLabelText(/edit comment/i));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onEditText).not.toHaveBeenCalled();
    expect(screen.getByText('Original note.')).toBeTruthy();
  });

  // Same class of bug this file's `editingDraft` fix closed (CommentCard.tsx's
  // own WHY) — but this time proving the NEW state stays purely explicit:
  // typing must never itself flip `isEditingComment` and unmount the box.
  it('typing into the edit textarea never unmounts it, whatever is typed (focus-safety)', () => {
    render(
      <CommentCard
        comment={baseComment({ text: 'Original note.' })}
        onTextChange={noop} onReply={noop} onResolve={noop} onReopen={noop} onDelete={noop}
        onEditText={noop} onDeleteComment={noop}
      />,
    );
    fireEvent.click(screen.getByLabelText(/edit comment/i));
    const box = screen.getByPlaceholderText(/edit…/i) as HTMLTextAreaElement;
    box.focus();
    for (const ch of 'hello') fireEvent.change(box, { target: { value: box.value + ch } });
    expect(screen.getByPlaceholderText(/edit…/i)).toBe(box);
    expect(document.activeElement).toBe(box);
  });

  it('Delete shows an inline confirm naming the comment alone when it has no replies', () => {
    render(
      <CommentCard
        comment={baseComment({ replies: [] })}
        onTextChange={noop} onReply={noop} onResolve={noop} onReopen={noop} onDelete={noop}
        onEditText={noop} onDeleteComment={noop}
      />,
    );
    fireEvent.click(screen.getByLabelText(/delete comment/i));
    expect(screen.getByText('Delete this comment?')).toBeTruthy();
  });

  // E-3: deleting a thread's first comment deletes the whole thread — the
  // confirm copy says so, so nobody is surprised the replies went too.
  it('Delete names the reply count when the thread has replies (E-3)', () => {
    render(
      <CommentCard
        comment={baseComment({
          replies: [
            { id: 'r-1', author: 'assistant', createdAt: Date.now(), text: 'a reply' },
            { id: 'r-2', author: 'user', createdAt: Date.now(), text: 'another' },
          ],
        })}
        onTextChange={noop} onReply={noop} onResolve={noop} onReopen={noop} onDelete={noop}
        onEditText={noop} onDeleteComment={noop}
      />,
    );
    fireEvent.click(screen.getByLabelText(/delete comment/i));
    expect(screen.getByText('Delete this comment and its 2 replies?')).toBeTruthy();
  });

  it('Cancel on the delete confirm dismisses it without calling onDeleteComment', () => {
    const onDeleteComment = vi.fn();
    render(
      <CommentCard
        comment={baseComment()}
        onTextChange={noop} onReply={noop} onResolve={noop} onReopen={noop} onDelete={noop}
        onEditText={noop} onDeleteComment={onDeleteComment}
      />,
    );
    fireEvent.click(screen.getByLabelText(/delete comment/i));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDeleteComment).not.toHaveBeenCalled();
    expect(screen.queryByText(/delete this comment/i)).toBeNull();
  });

  it('confirming Delete calls onDeleteComment (E-4)', () => {
    const onDeleteComment = vi.fn();
    render(
      <CommentCard
        comment={baseComment()}
        onTextChange={noop} onReply={noop} onResolve={noop} onReopen={noop} onDelete={noop}
        onEditText={noop} onDeleteComment={onDeleteComment}
      />,
    );
    fireEvent.click(screen.getByLabelText(/delete comment/i));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDeleteComment).toHaveBeenCalledTimes(1);
  });

  it('a resolved comment also gets working Edit/Delete icons (Destin: fine on resolved threads too)', () => {
    const onEditText = vi.fn();
    const onDeleteComment = vi.fn();
    render(
      <CommentCard
        comment={baseComment({ resolved: true, resolvedBy: 'user', resolvedAt: Date.now(), text: 'Resolved note.' })}
        onTextChange={noop} onReply={noop} onResolve={noop} onReopen={noop} onDelete={noop}
        onEditText={onEditText} onDeleteComment={onDeleteComment}
      />,
    );
    expect(screen.getByLabelText(/edit comment/i)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/delete comment/i));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDeleteComment).toHaveBeenCalledTimes(1);
  });
});

describe('CommentCard — a reply\'s own Edit/Delete icons (E-1)', () => {
  function commentWithReplies() {
    return baseComment({
      replies: [
        { id: 'r-1', author: 'user', createdAt: Date.now(), text: 'first reply' },
        { id: 'r-2', author: 'assistant', createdAt: Date.now(), text: 'second reply' },
      ],
    });
  }

  it('no reply icons when the reply handlers are not wired', () => {
    render(<CommentCard comment={commentWithReplies()} onTextChange={noop} onReply={noop} onResolve={noop} onReopen={noop} onDelete={noop} />);
    expect(screen.queryByLabelText(/edit reply/i)).toBeNull();
    expect(screen.queryByLabelText(/delete reply/i)).toBeNull();
  });

  it('editing one reply only affects that reply — the other reply and the comment\'s own text stay put', () => {
    const onEditReply = vi.fn();
    render(
      <CommentCard
        comment={commentWithReplies()}
        onTextChange={noop} onReply={noop} onResolve={noop} onReopen={noop} onDelete={noop}
        onEditReply={onEditReply} onDeleteReply={noop}
      />,
    );
    const editButtons = screen.getAllByLabelText(/edit reply/i);
    expect(editButtons).toHaveLength(2);
    fireEvent.click(editButtons[0]); // "first reply"
    const box = screen.getByPlaceholderText(/edit…/i) as HTMLTextAreaElement;
    expect(box.value).toBe('first reply');
    fireEvent.change(box, { target: { value: 'edited first reply' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onEditReply).toHaveBeenCalledWith('r-1', 'edited first reply');
    expect(screen.getByText('second reply')).toBeTruthy();
    expect(screen.getByText('A note about this passage.')).toBeTruthy();
  });

  it('Delete on a reply shows its own confirm ("Delete this reply?") and calls onDeleteReply with that reply\'s id', () => {
    const onDeleteReply = vi.fn();
    render(
      <CommentCard
        comment={commentWithReplies()}
        onTextChange={noop} onReply={noop} onResolve={noop} onReopen={noop} onDelete={noop}
        onEditReply={noop} onDeleteReply={onDeleteReply}
      />,
    );
    const deleteButtons = screen.getAllByLabelText(/delete reply/i);
    fireEvent.click(deleteButtons[1]); // "second reply"
    expect(screen.getByText('Delete this reply?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDeleteReply).toHaveBeenCalledWith('r-2');
  });
});

describe('HighlightHoverCard — Edit/Delete icons (E-1, "code/xlsx surfaces reuse the same card")', () => {
  // A real element, not null: `anchor-position.ts`'s `boundsFor` calls
  // `.closest()` on it when no bounds host is given, which a bare `null`
  // (or a fake `getBoundingClientRect`-only stand-in) doesn't have.
  const bounds = document.createElement('div');
  function renderCard(comment: DocComment, extra: Partial<React.ComponentProps<typeof HighlightHoverCard>> = {}) {
    return render(
      <HighlightHoverCard
        comment={comment}
        anchorRect={new DOMRect(0, 0, 10, 10)}
        boundsEl={bounds}
        onPointerEnter={noop}
        onPointerLeave={noop}
        onEngagedChange={noop}
        onReply={noop}
        onResolve={noop}
        onReopen={noop}
        {...extra}
      />,
    );
  }

  it('renders no Edit/Delete icons when the handlers are not wired', () => {
    renderCard(baseComment());
    expect(screen.queryByLabelText(/edit comment/i)).toBeNull();
    expect(screen.queryByLabelText(/delete comment/i)).toBeNull();
  });

  it('Edit opens the inline editor and Save calls onEditText with the new text', () => {
    const onEditText = vi.fn();
    renderCard(baseComment({ text: 'Original.' }), { onEditText, onDeleteComment: noop });
    fireEvent.click(screen.getByLabelText(/edit comment/i));
    const box = screen.getByPlaceholderText(/edit…/i) as HTMLTextAreaElement;
    expect(box.value).toBe('Original.');
    fireEvent.change(box, { target: { value: 'Updated.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onEditText).toHaveBeenCalledWith('Updated.');
  });

  it('Delete asks first, and confirming calls onDeleteComment', () => {
    const onDeleteComment = vi.fn();
    renderCard(baseComment(), { onEditText: noop, onDeleteComment });
    fireEvent.click(screen.getByLabelText(/delete comment/i));
    expect(screen.getByText('Delete this comment?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDeleteComment).toHaveBeenCalledTimes(1);
  });

  it('a reply gets its own Edit/Delete icons too, scoped to that reply', () => {
    const onDeleteReply = vi.fn();
    const comment = baseComment({
      replies: [{ id: 'r-1', author: 'user', createdAt: Date.now(), text: 'a reply' }],
    });
    renderCard(comment, { onEditReply: noop, onDeleteReply });
    fireEvent.click(screen.getByLabelText(/delete reply/i));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDeleteReply).toHaveBeenCalledWith('r-1');
  });
});
