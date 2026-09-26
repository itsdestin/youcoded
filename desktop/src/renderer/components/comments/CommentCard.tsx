// CommentCard — one comment thread: author + timestamp,
// the note, replies (including an assistant reply), and resolve/reopen.
// Used both in the margin (desktop) and inside a popover (narrow viewport).
import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Textarea } from '../ui/Textarea';
import { CompleteToggle } from '../SessionCardDetails';
import { formatRelativeTime } from '../../utils/format-time';
import type { DocComment } from '../../state/doc-comments-store';
import { Avatar, authorName, authorNameInline } from './Avatar';
import { ReplyField } from './ReplyField';

interface Props {
  comment: DocComment;
  autoFocus?: boolean;
  onTextChange: (text: string) => void;
  onReply: (text: string) => void;
  onResolve: () => void;
  onReopen: () => void;
  onDelete: () => void;
}

export function CommentCard({ comment, autoFocus, onTextChange, onReply, onResolve, onReopen, onDelete }: Props) {
  const textRef = useRef<HTMLTextAreaElement>(null);

  // A freshly added comment (from "Add comment" on a selection) opens with
  // its note box already focused — Docs-style, so typing starts immediately
  // with no extra click.
  useEffect(() => {
    if (autoFocus) textRef.current?.focus();
  }, [autoFocus]);

  const isDraft = comment.text.trim() === '' && comment.replies.length === 0 && !comment.resolved;

  // Round 10 (Destin: "the 'resolved' button should be an icon, like the
  // complete button for resume browser, at the top right of each comment
  // area"): the SAME CompleteToggle the Resume card uses — hollow circle-check
  // to resolve, filled to show it's resolved (click again to reopen). A draft
  // has nothing to resolve yet, so it gets no toggle.
  const resolveToggle = !isDraft && (
    <CompleteToggle
      done={comment.resolved}
      name="this comment"
      onToggle={(next) => (next ? onResolve() : onReopen())}
      titles={{ set: 'Resolved. Click to reopen.', unset: 'Resolve this comment?' }}
      className="shrink-0"
    />
  );
  // Round 11 (Destin: "remove the quote section at the top of each
  // comment"): in Comments mode each card already sits beside its highlight
  // and lights it up on hover, so repeating the quoted words was noise. The
  // resolve toggle moves onto the author row, top right.
  // `cell`: a spreadsheet comment names its cell ("B4") after the time, muted
  // — the pane lists cells in sheet order, and with no quoted text on the
  // card the reference is the only way to tell which cell a card is about
  // without clicking it. Only the thread's own header gets it, not replies.
  // A multi-sheet workbook's comment names its tab too ("By rep · B4").
  const cellRef = comment.cell ? (comment.sheet ? `${comment.sheet} · ${comment.cell}` : comment.cell) : undefined;
  // The reference sits on its own muted line under name · time: beside them,
  // "By rep · B4" squeezed the author's name down to "Pr…" (polish pass).
  const header = (c: { author: DocComment['author']; createdAt: number }, cell?: string) => (
    <>
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="font-medium text-fg truncate">{authorName(c.author)}</span>
        <span className="text-2xs text-fg-muted shrink-0">{formatRelativeTime(c.createdAt)}</span>
      </div>
      {cell && <div className="text-2xs text-fg-muted truncate">{cell}</div>}
    </>
  );

  if (comment.resolved) {
    // Collapsed (Docs-style): who wrote it, a one-line note, who resolved
    // it; the filled toggle top-right is the way back.
    return (
      // Design-guide review (round 7): a card inside a side pane is `inset`
      // with an `edge-dim` border and no shadow (§2.1/§2.4 — the tool-card
      // recipe); muted text says "done" without fading the whole card below
      // the contrast floor.
      <div className="rounded-lg border border-edge-dim bg-inset p-3 text-xs">
        <div className="flex items-start gap-2">
          <Avatar author={comment.author} />
          <div className="flex-1 min-w-0">
            {header(comment, cellRef)}
            <p className="mt-0.5 text-fg-muted truncate">{comment.text}</p>
          </div>
          {resolveToggle}
        </div>
        <p className="mt-1.5 text-fg-muted">Resolved by {authorNameInline(comment.resolvedBy ?? 'user')}</p>
      </div>
    );
  }



  return (
    <div className="rounded-lg border border-edge-dim bg-inset p-3 text-xs w-full">
      <div className="flex items-start gap-2">
        <Avatar author={comment.author} />
        <div className="flex-1 min-w-0">
          {header(comment, cellRef)}
          {isDraft ? (
            <Textarea
              ref={textRef}
              size="sm"
              rows={2}
              value={comment.text}
              onChange={(e) => onTextChange(e.target.value)}
              placeholder="Add a comment…"
              // data-edit-menu (was the artifact-edit-textarea class, which design lint rejects on <Textarea>): reuses the artifact editor's right-click
              // routing (build-menu.ts) — Electron ships no default context menu,
              // so without this marker cut/copy/paste here would do nothing.
              className="mt-1 w-full"
              data-edit-menu
            />
          ) : (
            <p className="mt-0.5 text-fg-2 whitespace-pre-wrap">{comment.text}</p>
          )}
        </div>
        {resolveToggle}
      </div>

      {comment.replies.map((r) => (
        <div key={r.id} className="flex items-start gap-2 mt-2 pl-1">
          <Avatar author={r.author} />
          <div className="flex-1 min-w-0">
            {header(r)}
            <p className="mt-0.5 text-fg-2 whitespace-pre-wrap">{r.text}</p>
          </div>
        </div>
      ))}

      {/* The reply box is shared with the Reading-mode hover card (ReplyField.tsx). */}
      {!isDraft && <ReplyField onSend={onReply} />}
      {isDraft && (
        <div className="mt-2 flex items-center justify-end gap-1.5">
          <Button variant="ghost" size="sm" onClick={onDelete}>Delete</Button>
        </div>
      )}
    </div>
  );
}
