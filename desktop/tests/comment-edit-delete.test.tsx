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

// Cursor flicker fix (Destin, dev instance: "cursor seems to flicker/stutter
// when hovering between/across the different buttons" — Resolve/Edit/Delete).
// Root cause: a bare <button>'s UA stylesheet sets `cursor: default`, which
// BREAKS inheritance rather than falling back to it — so it never picked up
// the card background's `cursor-pointer`. The tiny gap-0.5 slivers between
// the tightly-packed icons stayed on the inherited pointer, and every button/
// gap crossing flipped the OS cursor glyph. jsdom applies neither Tailwind's
// stylesheet nor the browser's UA defaults (see unselectable-chrome.test.ts's
// own WHY), so this pins the CLASS NAME half of the fix — every button and
// every gap-only <div> in the row carries an explicit `cursor-pointer`, which
// cannot disagree with anything else regardless of what an ancestor does.
describe('Resolve/Edit/Delete row — one cursor, no dead gaps (hover flicker fix)', () => {
  it("CommentCard's top-right row: Edit, Delete, Resolve and both wrapping gaps are all cursor-pointer", () => {
    render(
      <CommentCard
        comment={baseComment()}
        onTextChange={noop} onReply={noop} onResolve={noop} onReopen={noop} onDelete={noop}
        onEditText={noop} onDeleteComment={noop}
      />,
    );
    const editBtn = screen.getByLabelText(/edit comment/i);
    const deleteBtn = screen.getByLabelText(/delete comment/i);
    const resolveBtn = screen.getByTitle(/resolve this comment/i);
    expect(editBtn.className).toContain('cursor-pointer');
    expect(deleteBtn.className).toContain('cursor-pointer');
    expect(resolveBtn.className).toContain('cursor-pointer');
    // The <div> wrapping Edit+Delete (their own gap-0.5), and the <div>
    // wrapping that pair with the resolve toggle (the gap between the two
    // groups) — both are gap-only pixels no button's own class reaches.
    expect(editBtn.parentElement?.className).toContain('cursor-pointer');
    expect(editBtn.parentElement?.parentElement?.className).toContain('cursor-pointer');
  });

  it("a reply row's Edit/Delete icons and their gap are cursor-pointer too", () => {
    render(
      <CommentCard
        comment={baseComment({ replies: [{ id: 'r-1', author: 'user', createdAt: Date.now(), text: 'a reply' }] })}
        onTextChange={noop} onReply={noop} onResolve={noop} onReopen={noop} onDelete={noop}
        onEditReply={noop} onDeleteReply={noop}
      />,
    );
    const editBtn = screen.getByLabelText(/edit reply/i);
    const deleteBtn = screen.getByLabelText(/delete reply/i);
    expect(editBtn.className).toContain('cursor-pointer');
    expect(deleteBtn.className).toContain('cursor-pointer');
    expect(editBtn.parentElement?.className).toContain('cursor-pointer');
  });

  it("HighlightHoverCard's trailing row (the code/xlsx hover preview) is the same fix", () => {
    const bounds = document.createElement('div');
    render(
      <HighlightHoverCard
        comment={baseComment()}
        anchorRect={new DOMRect(0, 0, 10, 10)}
        boundsEl={bounds}
        onPointerEnter={noop}
        onPointerLeave={noop}
        onEngagedChange={noop}
        onReply={noop}
        onResolve={noop}
        onReopen={noop}
        onEditText={noop}
        onDeleteComment={noop}
      />,
    );
    const editBtn = screen.getByLabelText(/edit comment/i);
    const resolveBtn = screen.getByTitle(/resolve this comment/i);
    expect(editBtn.className).toContain('cursor-pointer');
    expect(resolveBtn.className).toContain('cursor-pointer');
    expect(editBtn.parentElement?.className).toContain('cursor-pointer');
    expect(editBtn.parentElement?.parentElement?.className).toContain('cursor-pointer');
  });

  // Companion check, not the cursor fix itself: a docComments:changed push
  // landing mid-hover (same id, fresh object — CommentCard.tsx's own
  // `editingDraft` WHY describes exactly this shape) must not tear down and
  // recreate the row's buttons, or a hover mid-sweep would re-trigger the
  // opacity-reveal transition and read as another stutter.
  it('a same-id comment refresh mid-hover keeps the same Edit/Delete/Resolve DOM nodes', () => {
    const c1 = baseComment();
    const { rerender } = render(
      <CommentCard
        comment={c1}
        onTextChange={noop} onReply={noop} onResolve={noop} onReopen={noop} onDelete={noop}
        onEditText={noop} onDeleteComment={noop}
      />,
    );
    const editBefore = screen.getByLabelText(/edit comment/i);
    const resolveBefore = screen.getByTitle(/resolve this comment/i);
    rerender(
      <CommentCard
        comment={{ ...c1 }}
        onTextChange={noop} onReply={noop} onResolve={noop} onReopen={noop} onDelete={noop}
        onEditText={noop} onDeleteComment={noop}
      />,
    );
    expect(screen.getByLabelText(/edit comment/i)).toBe(editBefore);
    expect(screen.getByTitle(/resolve this comment/i)).toBe(resolveBefore);
  });
});
