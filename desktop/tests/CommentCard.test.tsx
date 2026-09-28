// @vitest-environment jsdom
// T6 of the doc-comments build (docs/active/specs/2026-09-26-doc-comments-
// build-design.md §2.3): CommentCard's "Text no longer found" line — the one
// piece of new UI this task adds to the already-approved card. T14 computes
// `DocComment.status` ('anchored' | 'detached'); these pins are the render
// contract for what the card does with it, independent of how status gets
// set (use-quote-marks.test.tsx / use-code-comment-anchors.test.tsx already
// pin that part).
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
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
