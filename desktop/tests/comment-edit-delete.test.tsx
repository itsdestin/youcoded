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

  // Destin, 2026-09-28: Cancel/Save move inside the field's own border,
  // bottom-right — one bordered box, not a border on the textarea plus a
  // separate row below it.
  it('Cancel and Save sit INSIDE the same bordered box as the edit textarea, not below it', () => {
    render(
      <CommentCard
        comment={baseComment({ text: 'Original note.' })}
        onTextChange={noop} onReply={noop} onResolve={noop} onReopen={noop} onDelete={noop}
        onEditText={noop} onDeleteComment={noop}
      />,
    );
    fireEvent.click(screen.getByLabelText(/edit comment/i));
    const box = screen.getByPlaceholderText(/edit…/i);
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const save = screen.getByRole('button', { name: 'Save' });
    const wrapper = box.parentElement;
    expect(wrapper?.contains(cancel)).toBe(true);
    expect(wrapper?.contains(save)).toBe(true);
    expect(wrapper?.className).toContain('border');
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

// Restyle round (Destin, 2026-09-28, reviewing the dev instance screenshot):
// edit mode now matches CommentComposer's styling (Save filled like the send
// arrow), hides the row's other controls behind a single "Editing" pill, and
// swaps Save for Delete once the box is emptied. CommentCard and
// HighlightHoverCard share every bit of this through CommentActions.tsx's
// InlineEditField + CommentRowActions/EditingPill, so both are pinned here.
describe('CommentCard — while editing: hide reply box + delete/resolve, show the "Editing" pill (asks 2-3)', () => {
  it('editing a comment hides its own Delete AND Resolve, replacing both (and Edit) with the "Editing" pill', () => {
    render(
      <CommentCard
        comment={baseComment({ text: 'Original note.' })}
        onTextChange={noop} onReply={noop} onResolve={noop} onReopen={noop} onDelete={noop}
        onEditText={noop} onDeleteComment={noop}
      />,
    );
    fireEvent.click(screen.getByLabelText(/edit comment/i));
    expect(screen.queryByLabelText(/^edit comment$/i)).toBeNull();
    expect(screen.queryByLabelText(/delete comment/i)).toBeNull();
    expect(screen.queryByTitle(/resolve this comment/i)).toBeNull();
    expect(screen.getByLabelText(/cancel editing/i)).toBeTruthy();
    expect(screen.getByText('Editing')).toBeTruthy();
  });

  it('editing a comment also hides the reply box', () => {
    render(
      <CommentCard
        comment={baseComment()}
        onTextChange={noop} onReply={noop} onResolve={noop} onReopen={noop} onDelete={noop}
        onEditText={noop} onDeleteComment={noop}
      />,
    );
    expect(screen.getByPlaceholderText(/reply/i)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/edit comment/i));
    expect(screen.queryByPlaceholderText(/reply/i)).toBeNull();
  });

  it('clicking the "Editing" pill cancels the edit (its aria-label/tooltip say so) and restores Edit/Delete/Resolve', () => {
    const onEditText = vi.fn();
    render(
      <CommentCard
        comment={baseComment({ text: 'Original note.' })}
        onTextChange={noop} onReply={noop} onResolve={noop} onReopen={noop} onDelete={noop}
        onEditText={onEditText} onDeleteComment={noop}
      />,
    );
    fireEvent.click(screen.getByLabelText(/edit comment/i));
    const pill = screen.getByLabelText(/cancel editing/i);
    expect(pill.getAttribute('title')).toMatch(/cancel editing/i);
    fireEvent.click(pill);
    expect(onEditText).not.toHaveBeenCalled();
    expect(screen.getByText('Original note.')).toBeTruthy();
    expect(screen.getByLabelText(/edit comment/i)).toBeTruthy();
    expect(screen.getByLabelText(/delete comment/i)).toBeTruthy();
    expect(screen.getByTitle(/resolve this comment/i)).toBeTruthy();
  });

  it("editing a reply hides only THAT reply's own Delete and the thread's reply box — the comment's own actions and the other reply stay put", () => {
    render(
      <CommentCard
        comment={baseComment({
          replies: [
            { id: 'r-1', author: 'user', createdAt: Date.now(), text: 'first reply' },
            { id: 'r-2', author: 'assistant', createdAt: Date.now(), text: 'second reply' },
          ],
        })}
        onTextChange={noop} onReply={noop} onResolve={noop} onReopen={noop} onDelete={noop}
        onEditText={noop} onDeleteComment={noop} onEditReply={noop} onDeleteReply={noop}
      />,
    );
    fireEvent.click(screen.getAllByLabelText(/edit reply/i)[0]);
    // Only the OTHER reply still has its own Edit/Delete icons.
    expect(screen.getAllByLabelText(/edit reply/i)).toHaveLength(1);
    expect(screen.getAllByLabelText(/delete reply/i)).toHaveLength(1);
    expect(screen.getByLabelText(/cancel editing/i)).toBeTruthy();
    // The thread's reply box is gone.
    expect(screen.queryByPlaceholderText(/^reply…$/i)).toBeNull();
    // The comment's own Edit/Delete/Resolve are untouched.
    expect(screen.getByLabelText(/edit comment/i)).toBeTruthy();
    expect(screen.getByLabelText(/delete comment/i)).toBeTruthy();
    expect(screen.getByTitle(/resolve this comment/i)).toBeTruthy();
  });
});

describe('InlineEditField (CommentCard) — Save becomes Delete when the box is emptied, and back (ask 4)', () => {
  it('clearing all text swaps Save for a danger Delete button; typing text back swaps it back to Save', () => {
    render(
      <CommentCard
        comment={baseComment({ text: 'Original note.' })}
        onTextChange={noop} onReply={noop} onResolve={noop} onReopen={noop} onDelete={noop}
        onEditText={noop} onDeleteComment={noop}
      />,
    );
    fireEvent.click(screen.getByLabelText(/edit comment/i));
    const box = screen.getByPlaceholderText(/edit…/i);
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();

    fireEvent.change(box, { target: { value: '   ' } }); // whitespace-only counts as empty
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();

    fireEvent.change(box, { target: { value: 'back again' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('clicking Delete while the box is empty opens the SAME delete confirm the standalone Delete icon opens (E-4, no second path)', () => {
    const onDeleteComment = vi.fn();
    render(
      <CommentCard
        comment={baseComment({
          text: 'Original note.',
          replies: [{ id: 'r-1', author: 'user', createdAt: Date.now(), text: 'a reply' }],
        })}
        onTextChange={noop} onReply={noop} onResolve={noop} onReopen={noop} onDelete={noop}
        onEditText={noop} onDeleteComment={onDeleteComment}
      />,
    );
    fireEvent.click(screen.getByLabelText(/edit comment/i));
    fireEvent.change(screen.getByPlaceholderText(/edit…/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.queryByPlaceholderText(/edit…/i)).toBeNull();
    expect(screen.getByText('Delete this comment and its 1 reply?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDeleteComment).toHaveBeenCalledTimes(1);
  });

  it('Enter while the box is empty opens the delete confirm too, instead of a no-op save', () => {
    const onEditText = vi.fn();
    render(
      <CommentCard
        comment={baseComment({ text: 'Original note.' })}
        onTextChange={noop} onReply={noop} onResolve={noop} onReopen={noop} onDelete={noop}
        onEditText={onEditText} onDeleteComment={noop}
      />,
    );
    fireEvent.click(screen.getByLabelText(/edit comment/i));
    const box = screen.getByPlaceholderText(/edit…/i);
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onEditText).not.toHaveBeenCalled();
    expect(screen.getByText('Delete this comment?')).toBeTruthy();
  });

  it('a reply\'s own edit field gets the same Save<->Delete swap and Enter-while-empty behavior', () => {
    const onDeleteReply = vi.fn();
    render(
      <CommentCard
        comment={baseComment({ replies: [{ id: 'r-1', author: 'user', createdAt: Date.now(), text: 'first reply' }] })}
        onTextChange={noop} onReply={noop} onResolve={noop} onReopen={noop} onDelete={noop}
        onEditReply={noop} onDeleteReply={onDeleteReply}
      />,
    );
    fireEvent.click(screen.getByLabelText(/edit reply/i));
    const box = screen.getByPlaceholderText(/edit…/i);
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByText('Delete this reply?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDeleteReply).toHaveBeenCalledWith('r-1');
  });
});

describe('HighlightHoverCard — while editing: hide reply box + delete/resolve, the "Editing" pill, Save<->Delete (asks 2-4)', () => {
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

  it('editing the comment hides Delete, Resolve and the reply box, showing the "Editing" pill instead', () => {
    renderCard(baseComment({ text: 'Original.' }), { onEditText: noop, onDeleteComment: noop });
    expect(screen.getByPlaceholderText(/reply/i)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/edit comment/i));
    expect(screen.queryByLabelText(/^delete comment$/i)).toBeNull();
    expect(screen.queryByTitle(/resolve this comment/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/reply/i)).toBeNull();
    expect(screen.getByLabelText(/cancel editing/i)).toBeTruthy();
  });

  it('clicking the "Editing" pill cancels without saving', () => {
    const onEditText = vi.fn();
    renderCard(baseComment({ text: 'Original.' }), { onEditText, onDeleteComment: noop });
    fireEvent.click(screen.getByLabelText(/edit comment/i));
    fireEvent.click(screen.getByLabelText(/cancel editing/i));
    expect(onEditText).not.toHaveBeenCalled();
    expect(screen.getByText('Original.')).toBeTruthy();
    expect(screen.getByTitle(/resolve this comment/i)).toBeTruthy();
  });

  it('clearing the text swaps Save for Delete, and Enter-while-empty opens the confirm', () => {
    renderCard(baseComment({ text: 'Original.' }), { onEditText: noop, onDeleteComment: noop });
    fireEvent.click(screen.getByLabelText(/edit comment/i));
    const box = screen.getByPlaceholderText(/edit…/i);
    fireEvent.change(box, { target: { value: '' } });
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(screen.getByText('Delete this comment?')).toBeTruthy();
  });

  it("editing a reply hides its own Delete and the thread's reply box, leaving the comment's own row untouched", () => {
    const comment = baseComment({
      replies: [{ id: 'r-1', author: 'user', createdAt: Date.now(), text: 'a reply' }],
    });
    renderCard(comment, { onEditText: noop, onDeleteComment: noop, onEditReply: noop, onDeleteReply: noop });
    fireEvent.click(screen.getByLabelText(/edit reply/i));
    expect(screen.queryByLabelText(/delete reply/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/^reply…$/i)).toBeNull();
    expect(screen.getByLabelText(/edit comment/i)).toBeTruthy();
    expect(screen.getByLabelText(/delete comment/i)).toBeTruthy();
    expect(screen.getByTitle(/resolve this comment/i)).toBeTruthy();
  });
});
