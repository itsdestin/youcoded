// @vitest-environment jsdom
// T6 of the doc-comments build (docs/active/specs/2026-09-26-doc-comments-
// build-design.md §2.3): CommentCard's "Text no longer found" line — the one
// piece of new UI this task adds to the already-approved card. T14 computes
// `DocComment.status` ('anchored' | 'detached'); these pins are the render
// contract for what the card does with it, independent of how status gets
// set (use-quote-marks.test.tsx / use-code-comment-anchors.test.tsx already
// pin that part).
import '@testing-library/jest-dom/vitest';
import React, { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { CommentCard } from '../src/renderer/components/comments/CommentCard';
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
function renderCard(comment: DocComment) {
  return render(
    <CommentCard
      comment={comment}
      onTextChange={noop}
      onReply={noop}
      onResolve={noop}
      onReopen={noop}
      onDelete={noop}
    />,
  );
}

describe('CommentCard — a comment whose saved text/cell can no longer be found', () => {
  it('shows nothing extra when a comment is anchored', () => {
    renderCard(baseComment({ status: 'anchored' }));
    expect(screen.queryByText(/no longer found/i)).toBeNull();
    expect(screen.queryByText(/no longer exists/i)).toBeNull();
  });

  it('shows nothing extra when status is not yet known (undefined)', () => {
    renderCard(baseComment({ status: undefined }));
    expect(screen.queryByText(/no longer found/i)).toBeNull();
  });

  it('a detached text comment gets the plain, non-committal line, quoting the saved words', () => {
    renderCard(baseComment({ status: 'detached', quote: 'the quick brown fox' }));
    expect(screen.getByText(/text no longer found in this file\./i)).toBeTruthy();
    expect(screen.getByText(/the quick brown fox/)).toBeTruthy();
  });

  it('never invents a cause — the message names only what is actually known', () => {
    renderCard(baseComment({ status: 'detached' }));
    const note = screen.getByText(/text no longer found/i);
    // error-message-standards.md: general-and-non-committal, or specific-and-
    // true — never a guessed reason ("was deleted", "moved", "renamed", …).
    expect(note.textContent).not.toMatch(/delet|remov|rename|moved/i);
  });

  it('truncates a long saved quote rather than dumping the whole passage', () => {
    const long = 'word '.repeat(40).trim(); // well past the 60-char truncation point
    renderCard(baseComment({ status: 'detached', quote: long }));
    const note = screen.getByText(/text no longer found/i);
    expect(note.textContent!.length).toBeLessThan(long.length);
    expect(note.textContent).toContain('…');
  });

  it('a detached spreadsheet cell comment gets cell-specific wording, not text wording', () => {
    renderCard(baseComment({ status: 'detached', cell: 'Z99', sheet: 'Q3', quote: '42' }));
    expect(screen.getByText(/cell no longer exists in this file\./i)).toBeTruthy();
    expect(screen.queryByText(/text no longer found/i)).toBeNull();
    // The cell's old value isn't quoted the way text is — "Z99"/"Q3" are
    // already shown by the card's own cell-reference line.
    expect(screen.queryByText(/“42”/)).toBeNull();
  });

  it('a RESOLVED detached comment still shows the note, and stays repliable/resolvable (R6)', () => {
    renderCard(baseComment({
      status: 'detached', resolved: true, resolvedBy: 'user', resolvedAt: Date.now(),
    }));
    expect(screen.getByText(/text no longer found in this file\./i)).toBeTruthy();
    // Collapsed-resolved cards still render the reopen toggle (CompleteToggle) —
    // nothing about being detached removes the way back.
    expect(screen.getByTitle(/reopen/i)).toBeTruthy();
  });

  it('an open detached comment still offers a reply field (R6: nothing silently lost)', () => {
    renderCard(baseComment({ status: 'detached' }));
    expect(screen.getByPlaceholderText(/reply/i)).toBeTruthy();
  });

  it('a still-empty draft never shows the detached note, even if status were somehow set', () => {
    // Defensive: a draft's `status` is never actually set by the real
    // anchoring passes (it has no persisted selector yet), but the card
    // itself must not show "text no longer found" under a comment the user
    // hasn't finished writing.
    renderCard(baseComment({ status: 'detached', text: '', replies: [] }));
    expect(screen.queryByText(/no longer found/i)).toBeNull();
  });
});

// Bug fix (Destin, testing the dev instance): a resolved comment used to
// collapse to one truncated line and drop every reply, so a resolved
// thread's replies were unreachable in "show resolved" view. Docs-style:
// full text + every reply stay visible (muted), and there's no reply box.
describe('CommentCard — a resolved comment with replies (Docs-style resolved thread)', () => {
  it('shows the full comment text and every reply, still reads "Resolved by …", and offers no reply box', () => {
    renderCard(baseComment({
      text: 'This whole paragraph needs a rewrite for clarity and tone.',
      resolved: true,
      resolvedBy: 'user',
      resolvedAt: Date.now(),
      replies: [
        { id: 'r-1', author: 'assistant', createdAt: Date.now(), text: 'Agreed — I tightened the second sentence.' },
        { id: 'r-2', author: 'user', createdAt: Date.now(), text: 'Looks good, thanks.' },
      ],
    }));
    expect(screen.getByText(/this whole paragraph needs a rewrite for clarity and tone\./i)).toBeTruthy();
    expect(screen.getByText(/agreed — i tightened the second sentence\./i)).toBeTruthy();
    expect(screen.getByText(/looks good, thanks\./i)).toBeTruthy();
    expect(screen.getByText(/resolved by/i)).toBeTruthy();
    expect(screen.getByTitle(/reopen/i)).toBeTruthy();
    expect(screen.queryByPlaceholderText(/reply/i)).toBeNull();
  });
});

// F3 (T14 review, performance.md rule 4): a comment in a file too large for
// use-quote-marks.ts/use-code-comment-anchors.ts to check gets its OWN
// status — 'unchecked' — rather than reusing 'detached', which would falsely
// claim the text is specifically gone.
describe('CommentCard — a comment in a file too large to check (status "unchecked")', () => {
  it('shows the honest "too large to check" line, never the "no longer found" one', () => {
    renderCard(baseComment({ status: 'unchecked' }));
    expect(screen.getByText(/too large to show where this comment points/i)).toBeTruthy();
    expect(screen.queryByText(/no longer found/i)).toBeNull();
    expect(screen.queryByText(/no longer exists/i)).toBeNull();
  });

  it('never invents a cause for why the file is too large', () => {
    renderCard(baseComment({ status: 'unchecked' }));
    const note = screen.getByText(/too large/i);
    expect(note.textContent).not.toMatch(/delet|remov|rename|moved/i);
  });

  it('a RESOLVED unchecked comment still shows the note and stays reopenable (R6)', () => {
    renderCard(baseComment({ status: 'unchecked', resolved: true, resolvedBy: 'user', resolvedAt: Date.now() }));
    expect(screen.getByText(/too large to show where this comment points/i)).toBeTruthy();
    expect(screen.getByTitle(/reopen/i)).toBeTruthy();
  });

  it('a still-empty draft never shows the unchecked note either', () => {
    renderCard(baseComment({ status: 'unchecked', text: '', replies: [] }));
    expect(screen.queryByText(/too large/i)).toBeNull();
  });
});

// Bug fix (Destin, testing the dev instance: "the chat input sometimes
// steals focus in the middle of me typing a comment"). Root cause: `isDraft`
// used to be recomputed from the LIVE `comment.text` on every render, so the
// first keystroke (making `comment.text` non-empty) flipped the JSX from
// <Textarea> to a plain <p>, unmounting the focused box mid-sentence — see
// CommentCard.tsx's own WHY on `editingDraft`. Both harnesses below wire
// `onTextChange` exactly the way CommentsMargin/CodeCommentsRail do (a
// parent that re-renders CommentCard with a freshly updated `comment`
// object on every keystroke), so a regression here reproduces the same way
// it did in the real store.
describe('CommentCard — typing into a fresh draft never loses the box (focus-steal regression)', () => {
  // A stand-in for CommentsMargin/CodeCommentsRail: owns `comment` in state
  // and republishes a NEW object on every keystroke, the same shape
  // doc-comments-store.ts's `updateComment` produces.
  type Push = (updater: (c: DocComment) => DocComment) => void;
  function DraftHarness({ onExternalPush }: { onExternalPush?: (push: Push) => void }) {
    const [comment, setComment] = useState<DocComment>(baseComment({ id: 'c-draft', text: '', replies: [] }));
    onExternalPush?.((updater) => setComment((c) => updater(c)));
    return (
      <CommentCard
        comment={comment}
        autoFocus
        onTextChange={(t) => setComment((c) => ({ ...c, text: t }))}
        onReply={noop}
        onResolve={noop}
        onReopen={noop}
        onDelete={noop}
      />
    );
  }

  it('typing several characters keeps the SAME textarea mounted and focused, with every character kept', () => {
    render(<DraftHarness />);
    const box = screen.getByPlaceholderText(/add a comment…/i) as HTMLTextAreaElement;
    box.focus();
    expect(document.activeElement).toBe(box);

    // Type one character at a time — a naive re-render that swaps element
    // types on the first non-empty value would unmount `box` right here.
    for (const ch of 'hello') {
      fireEvent.change(box, { target: { value: box.value + ch } });
    }

    // Still the exact same box, in the document, still focused, with the
    // full word intact — none of that survives the old unmount-on-first-char
    // bug (queryByPlaceholderText would return null after the first change).
    expect(screen.getByPlaceholderText(/add a comment…/i)).toBe(box);
    expect(document.body.contains(box)).toBe(true);
    expect(document.activeElement).toBe(box);
    expect(box.value).toBe('hello');
  });

  it('a store push mid-typing (same id, fresh object reference — a docComments:changed echo or re-anchor pass) does not steal focus either', () => {
    let push!: Push;
    render(<DraftHarness onExternalPush={(p) => { push = p; }} />);
    const box = screen.getByPlaceholderText(/add a comment…/i) as HTMLTextAreaElement;
    box.focus();

    fireEvent.change(box, { target: { value: 'wo' } });
    // Simulate mergeServerComments()'s fromPersisted(): a BRAND NEW DocComment
    // object, same id and content, as a `docComments:changed` refresh or an
    // anchoring pass would hand this card.
    push((c) => ({ ...c, text: c.text }));

    expect(screen.getByPlaceholderText(/add a comment…/i)).toBe(box);
    expect(document.activeElement).toBe(box);

    fireEvent.change(box, { target: { value: 'world' } });
    expect(box.value).toBe('world');
    expect(document.activeElement).toBe(box);
  });

  it('blurring with real text hands off to the normal display + reply layout', () => {
    render(<DraftHarness />);
    const box = screen.getByPlaceholderText(/add a comment…/i) as HTMLTextAreaElement;
    box.focus();
    fireEvent.change(box, { target: { value: 'done' } });
    fireEvent.blur(box);
    expect(screen.queryByPlaceholderText(/add a comment…/i)).toBeNull();
    expect(screen.getByText('done')).toBeTruthy();
    expect(screen.getByPlaceholderText(/reply/i)).toBeTruthy();
  });

  it('blurring while still empty stays a draft (nothing to post yet)', () => {
    render(<DraftHarness />);
    const box = screen.getByPlaceholderText(/add a comment…/i) as HTMLTextAreaElement;
    box.focus();
    fireEvent.blur(box);
    expect(screen.getByPlaceholderText(/add a comment…/i)).toBe(box);
  });
});

// Draft's send control (Destin, 2026-09-28): same round-arrow send button
// ReplyField uses inside the field, instead of a Cancel/Delete row below the
// box — so Escape and a blur-while-empty are now the ONLY ways to drop a
// never-posted draft (the bottom "Delete" button this replaces is gone).
describe("CommentCard — a draft's send control (no bottom Delete button)", () => {
  // `editingDraft` only INITIALIZES true for a comment that starts empty
  // (CommentCard.tsx's own WHY) — a real draft always starts that way, so
  // this harness starts empty too and types via `onTextChange`, the same
  // shape CommentsMargin/CodeCommentsRail hand it in production (and the
  // same pattern the focus-steal regression harness above uses).
  function DraftBox({ onDelete, onCommit }: { onDelete: () => void; onCommit: () => void }) {
    const [comment, setComment] = useState<DocComment>(baseComment({ id: 'c-draft-2', text: '', replies: [] }));
    return (
      <CommentCard
        comment={comment}
        onTextChange={(t) => setComment((c) => ({ ...c, text: t }))}
        onReply={noop}
        onResolve={noop}
        onReopen={noop}
        onDelete={onDelete}
        onCommit={onCommit}
      />
    );
  }

  function renderDraft() {
    const onDelete = vi.fn();
    const onCommit = vi.fn();
    const utils = render(<DraftBox onDelete={onDelete} onCommit={onCommit} />);
    return { ...utils, onDelete, onCommit };
  }

  it('renders no bottom "Delete" button for a draft', () => {
    renderDraft();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('renders a "Post comment" arrow button instead, disabled while the draft is empty', () => {
    renderDraft();
    expect(screen.getByRole('button', { name: /post comment/i })).toBeDisabled();
  });

  it('typing enables the arrow; clicking it posts, same as a blur commit', () => {
    const { onCommit } = renderDraft();
    fireEvent.change(screen.getByPlaceholderText(/add a comment…/i), { target: { value: 'a real note' } });
    const post = screen.getByRole('button', { name: /post comment/i });
    expect(post).not.toBeDisabled();
    fireEvent.click(post);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(screen.getByText('a real note')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /post comment/i })).toBeNull();
  });

  it('Enter posts a non-empty draft, matching ReplyField', () => {
    const { onCommit } = renderDraft();
    const box = screen.getByPlaceholderText(/add a comment…/i);
    fireEvent.change(box, { target: { value: 'typed before Enter' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('Escape discards an empty draft (calls onDelete) — the replacement for the removed Delete button', () => {
    const { onDelete } = renderDraft();
    fireEvent.keyDown(screen.getByPlaceholderText(/add a comment…/i), { key: 'Escape' });
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('Escape on a non-empty draft does NOT discard it — only an empty draft is droppable this way', () => {
    const { onDelete } = renderDraft();
    const box = screen.getByPlaceholderText(/add a comment…/i);
    fireEvent.change(box, { target: { value: 'do not lose this' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/add a comment…/i)).toBeTruthy();
  });

  it('blurring an empty draft discards it — click-away can no longer leave a stuck empty card', () => {
    const { onDelete } = renderDraft();
    fireEvent.blur(screen.getByPlaceholderText(/add a comment…/i));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
