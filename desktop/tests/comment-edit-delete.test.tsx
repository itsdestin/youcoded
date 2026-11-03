// @vitest-environment jsdom
// The UI for editing/deleting comments: CommentCard's and HighlightHoverCard's Edit/Delete icons, inline editor and
// inline delete-confirm (components/comments/CommentActions.tsx, shared by both). The store-level edit/delete
// actions are pinned in use-doc-comments.test.tsx.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { CommentCard } from '../src/renderer/components/comments/CommentCard';
import { HighlightHoverCard } from '../src/renderer/components/comments/HighlightHoverCard';
import type { DocComment } from '../src/renderer/state/doc-comments-store';

afterEach(cleanup);

const noop = () => {};
const reply = (id: string, text: string, author: 'user' | 'assistant' = 'user') => ({ id, author, createdAt: Date.now(), text });

function baseComment(overrides: Partial<DocComment> = {}): DocComment {
  return {
    id: 'c-1', path: 'notes.md', quote: 'the quick brown fox', sourceLabel: 'notes.md',
    text: 'A note about this passage.', author: 'user', createdAt: Date.now(), replies: [],
    resolved: false, resolvedBy: null, resolvedAt: null, ...overrides,
  };
}

type CardProps = React.ComponentProps<typeof CommentCard>;
const WIRED = { onEditText: noop, onDeleteComment: noop };
/** CommentCard with every required handler stubbed; `extra` wires (or spies on) the edit/delete ones. */
const card = (comment: DocComment, extra: Partial<CardProps> = {}) => render(
  <CommentCard comment={comment} onTextChange={noop} onReply={noop} onResolve={noop} onReopen={noop} onDelete={noop} {...extra} />,
);
// A real element, not null: anchor-position's boundsFor calls .closest() on it.
const bounds = document.createElement('div');
const hoverCard = (comment: DocComment, extra: Partial<React.ComponentProps<typeof HighlightHoverCard>> = {}) => render(
  <HighlightHoverCard comment={comment} anchorRect={new DOMRect(0, 0, 10, 10)} boundsEl={bounds}
    onPointerEnter={noop} onPointerLeave={noop} onEngagedChange={noop} onReply={noop} onResolve={noop} onReopen={noop} {...extra} />,
);

const editIcon = () => screen.getByLabelText(/edit comment/i);
const deleteIcon = () => screen.getByLabelText(/delete comment/i);
const resolveToggle = () => screen.getByTitle(/resolve this comment/i);
const editBox = () => screen.getByPlaceholderText(/edit…/i) as HTMLTextAreaElement;
const button = (name: string) => screen.getByRole('button', { name });
const twoReplies = () => baseComment({ replies: [reply('r-1', 'first reply'), reply('r-2', 'second reply', 'assistant')] });

describe('CommentCard Edit/Delete icons next to the Resolve toggle', () => {
  it('renders neither icon when the edit/delete handlers are not wired, and the resolve toggle is unaffected', () => {
    card(baseComment());
    expect(screen.queryByLabelText(/edit comment/i)).toBeNull();
    expect(screen.queryByLabelText(/delete comment/i)).toBeNull();
    expect(resolveToggle()).toBeTruthy();
  });

  it('renders both icons, alongside the resolve toggle, when wired', () => {
    card(baseComment(), WIRED);
    expect(editIcon()).toBeTruthy();
    expect(deleteIcon()).toBeTruthy();
    expect(resolveToggle()).toBeTruthy();
  });

  it('a DRAFT (nothing persisted yet) gets neither icon, even when the handlers are wired', () => {
    card(baseComment({ text: '', replies: [] }), WIRED);
    expect(screen.queryByLabelText(/edit comment/i)).toBeNull();
    expect(screen.queryByLabelText(/delete comment/i)).toBeNull();
  });

  it('Edit opens an inline textarea seeded with the current text; Enter saves the trimmed text and closes it', () => {
    const onEditText = vi.fn();
    card(baseComment({ text: 'Original note.' }), { ...WIRED, onEditText });
    fireEvent.click(editIcon());
    expect(editBox().value).toBe('Original note.');
    fireEvent.change(editBox(), { target: { value: '  A better note.  ' } });
    fireEvent.keyDown(editBox(), { key: 'Enter' });
    expect(onEditText).toHaveBeenCalledWith('A better note.');
    expect(screen.queryByPlaceholderText(/edit…/i)).toBeNull();
  });

  it.each(['Escape key', 'Cancel button'])('the %s discards the edit without saving, restoring the original text', (how) => {
    const onEditText = vi.fn();
    card(baseComment({ text: 'Original note.' }), { ...WIRED, onEditText });
    fireEvent.click(editIcon());
    fireEvent.change(editBox(), { target: { value: 'a change nobody asked to save' } });
    if (how === 'Escape key') fireEvent.keyDown(editBox(), { key: 'Escape' });
    else fireEvent.click(button('Cancel'));
    expect(onEditText).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText(/edit…/i)).toBeNull();
    expect(screen.getByText('Original note.')).toBeTruthy();
  });

  // WHY: typing must never itself flip isEditingComment and unmount the box (same class as the editingDraft fix).
  it('typing into the edit textarea never unmounts it, whatever is typed (focus-safety)', () => {
    card(baseComment({ text: 'Original note.' }), WIRED);
    fireEvent.click(editIcon());
    const box = editBox();
    box.focus();
    for (const ch of 'hello') fireEvent.change(box, { target: { value: box.value + ch } });
    expect(editBox()).toBe(box);
    expect(document.activeElement).toBe(box);
  });

  it('Cancel and Save sit INSIDE the same bordered box as the edit textarea, not below it', () => {
    card(baseComment({ text: 'Original note.' }), WIRED);
    fireEvent.click(editIcon());
    const wrapper = editBox().parentElement;
    expect(wrapper?.contains(button('Cancel'))).toBe(true);
    expect(wrapper?.contains(button('Save'))).toBe(true);
    expect(wrapper?.className).toContain('border');
  });

  // Deleting a thread's first comment deletes the whole thread, so the confirm must say so.
  it.each([[0, 'Delete this comment?'], [2, /\b2 replies\b/]] as const)('Delete shows an inline confirm (%i replies)', (n, expected) => {
    card(baseComment({ replies: [reply('r-1', 'a reply'), reply('r-2', 'another', 'assistant')].slice(0, n) }), WIRED);
    fireEvent.click(deleteIcon());
    expect(screen.getByText(expected)).toBeTruthy();
  });

  it('Cancel on the delete confirm dismisses it without calling onDeleteComment', () => {
    const onDeleteComment = vi.fn();
    card(baseComment(), { ...WIRED, onDeleteComment });
    fireEvent.click(deleteIcon());
    fireEvent.click(button('Cancel'));
    expect(onDeleteComment).not.toHaveBeenCalled();
    expect(screen.queryByText(/delete this comment/i)).toBeNull();
  });

  it('confirming Delete calls onDeleteComment, also on a resolved comment', () => {
    const onDeleteComment = vi.fn();
    card(baseComment({ resolved: true, resolvedBy: 'user', resolvedAt: Date.now(), text: 'Resolved note.' }), { ...WIRED, onDeleteComment });
    expect(editIcon()).toBeTruthy();
    fireEvent.click(deleteIcon());
    fireEvent.click(button('Delete'));
    expect(onDeleteComment).toHaveBeenCalledTimes(1);
  });
});

describe('CommentCard a reply\'s own Edit/Delete icons', () => {
  it('no reply icons when the reply handlers are not wired', () => {
    card(twoReplies());
    expect(screen.queryByLabelText(/edit reply/i)).toBeNull();
    expect(screen.queryByLabelText(/delete reply/i)).toBeNull();
  });

  it('editing one reply only affects that reply — the other reply and the comment\'s own text stay put', () => {
    const onEditReply = vi.fn();
    card(twoReplies(), { onEditReply, onDeleteReply: noop });
    const editButtons = screen.getAllByLabelText(/edit reply/i);
    expect(editButtons).toHaveLength(2);
    fireEvent.click(editButtons[0]);
    expect(editBox().value).toBe('first reply');
    fireEvent.change(editBox(), { target: { value: 'edited first reply' } });
    fireEvent.keyDown(editBox(), { key: 'Enter' });
    expect(onEditReply).toHaveBeenCalledWith('r-1', 'edited first reply');
    expect(screen.getByText('second reply')).toBeTruthy();
    expect(screen.getByText('A note about this passage.')).toBeTruthy();
  });

  it('Delete on a reply shows its own confirm and calls onDeleteReply with that reply\'s id', () => {
    const onDeleteReply = vi.fn();
    card(twoReplies(), { onEditReply: noop, onDeleteReply });
    fireEvent.click(screen.getAllByLabelText(/delete reply/i)[1]);
    expect(screen.getByText('Delete this reply?')).toBeTruthy();
    fireEvent.click(button('Delete'));
    expect(onDeleteReply).toHaveBeenCalledWith('r-2');
  });
});

describe('HighlightHoverCard Edit/Delete icons (code/xlsx surfaces reuse the same card)', () => {
  it('renders no Edit/Delete icons when the handlers are not wired', () => {
    hoverCard(baseComment());
    expect(screen.queryByLabelText(/edit comment/i)).toBeNull();
    expect(screen.queryByLabelText(/delete comment/i)).toBeNull();
  });

  it('Edit opens the inline editor and Save calls onEditText with the new text', () => {
    const onEditText = vi.fn();
    hoverCard(baseComment({ text: 'Original.' }), { onEditText, onDeleteComment: noop });
    fireEvent.click(editIcon());
    expect(editBox().value).toBe('Original.');
    fireEvent.change(editBox(), { target: { value: 'Updated.' } });
    fireEvent.click(button('Save'));
    expect(onEditText).toHaveBeenCalledWith('Updated.');
  });

  it('Delete asks first, and confirming calls onDeleteComment', () => {
    const onDeleteComment = vi.fn();
    hoverCard(baseComment(), { onEditText: noop, onDeleteComment });
    fireEvent.click(deleteIcon());
    expect(screen.getByText('Delete this comment?')).toBeTruthy();
    fireEvent.click(button('Delete'));
    expect(onDeleteComment).toHaveBeenCalledTimes(1);
  });

  it('a reply gets its own Edit/Delete icons too, scoped to that reply', () => {
    const onDeleteReply = vi.fn();
    hoverCard(baseComment({ replies: [reply('r-1', 'a reply')] }), { onEditReply: noop, onDeleteReply });
    fireEvent.click(screen.getByLabelText(/delete reply/i));
    fireEvent.click(button('Delete'));
    expect(onDeleteReply).toHaveBeenCalledWith('r-1');
  });
});

// WHY: a bare <button>'s UA stylesheet sets cursor:default, which breaks inheritance, so the gap slivers between the
// tightly-packed icons kept the inherited pointer and the OS cursor flickered. jsdom applies neither stylesheet, so this
// pins the class-name half of the fix: every button and gap-only <div> in the row carries an explicit cursor-pointer.
describe('Resolve/Edit/Delete row: one cursor, no dead gaps', () => {
  const pointer = (el: Element | null | undefined) => expect(el?.className).toContain('cursor-pointer');

  it("CommentCard's top-right row: Edit, Delete, Resolve and both wrapping gaps are all cursor-pointer", () => {
    card(baseComment(), WIRED);
    pointer(editIcon());
    pointer(deleteIcon());
    pointer(resolveToggle());
    pointer(editIcon().parentElement);                 // Edit+Delete gap
    pointer(editIcon().parentElement?.parentElement);  // gap between that pair and the resolve toggle
  });

  it("a reply row's Edit/Delete icons and their gap are cursor-pointer too", () => {
    card(baseComment({ replies: [reply('r-1', 'a reply')] }), { onEditReply: noop, onDeleteReply: noop });
    pointer(screen.getByLabelText(/edit reply/i));
    pointer(screen.getByLabelText(/delete reply/i));
    pointer(screen.getByLabelText(/edit reply/i).parentElement);
  });

  it("HighlightHoverCard's trailing row (the code/xlsx hover preview) is the same fix", () => {
    hoverCard(baseComment(), WIRED);
    pointer(editIcon());
    pointer(resolveToggle());
    pointer(editIcon().parentElement);
    pointer(editIcon().parentElement?.parentElement);
  });

  // A docComments:changed push mid-hover (same id, fresh object) must not recreate the buttons, or the opacity-reveal re-triggers.
  it('a same-id comment refresh mid-hover keeps the same Edit/Delete/Resolve DOM nodes', () => {
    const c1 = baseComment();
    const props = { onTextChange: noop, onReply: noop, onResolve: noop, onReopen: noop, onDelete: noop, ...WIRED };
    const { rerender } = render(<CommentCard comment={c1} {...props} />);
    const editBefore = editIcon();
    const resolveBefore = resolveToggle();
    rerender(<CommentCard comment={{ ...c1 }} {...props} />);
    expect(editIcon()).toBe(editBefore);
    expect(resolveToggle()).toBe(resolveBefore);
  });
});

// Edit mode hides the row's other controls behind a single "Editing" pill and swaps Save for Delete once the box is
// emptied. Both cards share this through CommentActions.tsx, so both are pinned.
describe('CommentCard while editing: reply box and Delete/Resolve hidden, "Editing" pill shown', () => {
  it('editing a comment hides its own Delete AND Resolve and the reply box, replacing them (and Edit) with the "Editing" pill', () => {
    card(baseComment({ text: 'Original note.' }), WIRED);
    expect(screen.getByPlaceholderText(/reply/i)).toBeTruthy();
    fireEvent.click(editIcon());
    expect(screen.queryByLabelText(/^edit comment$/i)).toBeNull();
    expect(screen.queryByLabelText(/delete comment/i)).toBeNull();
    expect(screen.queryByTitle(/resolve this comment/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/reply/i)).toBeNull();
    expect(screen.getByLabelText(/cancel editing/i)).toBeTruthy();
    expect(screen.getByText('Editing')).toBeTruthy();
  });

  it('clicking the "Editing" pill cancels the edit and restores Edit/Delete/Resolve', () => {
    const onEditText = vi.fn();
    card(baseComment({ text: 'Original note.' }), { ...WIRED, onEditText });
    fireEvent.click(editIcon());
    const pill = screen.getByLabelText(/cancel editing/i);
    expect(pill.getAttribute('title')).toMatch(/cancel editing/i);
    fireEvent.click(pill);
    expect(onEditText).not.toHaveBeenCalled();
    expect(screen.getByText('Original note.')).toBeTruthy();
    expect(editIcon()).toBeTruthy();
    expect(deleteIcon()).toBeTruthy();
    expect(resolveToggle()).toBeTruthy();
  });

  it("editing a reply hides only THAT reply's own Delete and the thread's reply box — the comment's own actions and the other reply stay put", () => {
    card(twoReplies(), { ...WIRED, onEditReply: noop, onDeleteReply: noop });
    fireEvent.click(screen.getAllByLabelText(/edit reply/i)[0]);
    expect(screen.getAllByLabelText(/edit reply/i)).toHaveLength(1);
    expect(screen.getAllByLabelText(/delete reply/i)).toHaveLength(1);
    expect(screen.getByLabelText(/cancel editing/i)).toBeTruthy();
    expect(screen.queryByPlaceholderText(/^reply…$/i)).toBeNull();
    expect(editIcon()).toBeTruthy();
    expect(deleteIcon()).toBeTruthy();
    expect(resolveToggle()).toBeTruthy();
  });
});

describe('InlineEditField: Save becomes Delete when the box is emptied, and back', () => {
  it('clearing all text swaps Save for a danger Delete button; typing text back swaps it back to Save', () => {
    card(baseComment({ text: 'Original note.' }), WIRED);
    fireEvent.click(editIcon());
    expect(button('Save')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();

    fireEvent.change(editBox(), { target: { value: '   ' } }); // whitespace-only counts as empty
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(button('Delete')).toBeTruthy();

    fireEvent.change(editBox(), { target: { value: 'back again' } });
    expect(button('Save')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('clicking Delete while the box is empty opens the SAME delete confirm the standalone Delete icon opens', () => {
    const onDeleteComment = vi.fn();
    card(baseComment({ text: 'Original note.', replies: [reply('r-1', 'a reply')] }), { ...WIRED, onDeleteComment });
    fireEvent.click(editIcon());
    fireEvent.change(editBox(), { target: { value: '' } });
    fireEvent.click(button('Delete'));
    expect(screen.queryByPlaceholderText(/edit…/i)).toBeNull();
    expect(screen.getByText(/\b1 reply\b/)).toBeTruthy();
    fireEvent.click(button('Delete'));
    expect(onDeleteComment).toHaveBeenCalledTimes(1);
  });

  it('Enter while the box is empty opens the delete confirm too, instead of a no-op save', () => {
    const onEditText = vi.fn();
    card(baseComment({ text: 'Original note.' }), { ...WIRED, onEditText });
    fireEvent.click(editIcon());
    fireEvent.change(editBox(), { target: { value: '' } });
    fireEvent.keyDown(editBox(), { key: 'Enter' });
    expect(onEditText).not.toHaveBeenCalled();
    expect(screen.getByText('Delete this comment?')).toBeTruthy();
  });

  it('a reply\'s own edit field gets the same Save<->Delete swap', () => {
    const onDeleteReply = vi.fn();
    card(baseComment({ replies: [reply('r-1', 'first reply')] }), { onEditReply: noop, onDeleteReply });
    fireEvent.click(screen.getByLabelText(/edit reply/i));
    fireEvent.change(editBox(), { target: { value: '' } });
    fireEvent.click(button('Delete'));
    expect(screen.getByText('Delete this reply?')).toBeTruthy();
    fireEvent.click(button('Delete'));
    expect(onDeleteReply).toHaveBeenCalledWith('r-1');
  });
});

describe('HighlightHoverCard while editing', () => {
  it('editing the comment hides Delete, Resolve and the reply box, showing the "Editing" pill instead', () => {
    hoverCard(baseComment({ text: 'Original.' }), WIRED);
    expect(screen.getByPlaceholderText(/reply/i)).toBeTruthy();
    fireEvent.click(editIcon());
    expect(screen.queryByLabelText(/^delete comment$/i)).toBeNull();
    expect(screen.queryByTitle(/resolve this comment/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/reply/i)).toBeNull();
    expect(screen.getByLabelText(/cancel editing/i)).toBeTruthy();
  });

  it('clicking the "Editing" pill cancels without saving', () => {
    const onEditText = vi.fn();
    hoverCard(baseComment({ text: 'Original.' }), { onEditText, onDeleteComment: noop });
    fireEvent.click(editIcon());
    fireEvent.click(screen.getByLabelText(/cancel editing/i));
    expect(onEditText).not.toHaveBeenCalled();
    expect(screen.getByText('Original.')).toBeTruthy();
    expect(resolveToggle()).toBeTruthy();
  });

  it('clearing the text swaps Save for Delete, and Enter-while-empty opens the confirm', () => {
    hoverCard(baseComment({ text: 'Original.' }), WIRED);
    fireEvent.click(editIcon());
    fireEvent.change(editBox(), { target: { value: '' } });
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(button('Delete')).toBeTruthy();
    fireEvent.keyDown(editBox(), { key: 'Enter' });
    expect(screen.getByText('Delete this comment?')).toBeTruthy();
  });

  it("editing a reply hides its own Delete and the thread's reply box, leaving the comment's own row untouched", () => {
    hoverCard(baseComment({ replies: [reply('r-1', 'a reply')] }), { ...WIRED, onEditReply: noop, onDeleteReply: noop });
    fireEvent.click(screen.getByLabelText(/edit reply/i));
    expect(screen.queryByLabelText(/delete reply/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/^reply…$/i)).toBeNull();
    expect(editIcon()).toBeTruthy();
    expect(deleteIcon()).toBeTruthy();
    expect(resolveToggle()).toBeTruthy();
  });
});
