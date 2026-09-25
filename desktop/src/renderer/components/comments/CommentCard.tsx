// CommentCard — one comment thread: author + timestamp,
// the note, replies (including an assistant reply), and resolve/reopen.
// Used both in the margin (desktop) and inside a popover (narrow viewport).
import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Textarea } from '../ui/Textarea';
import { InputGroup } from '../ui/InputGroup';
import { CompleteToggle } from '../SessionCardDetails';
import { formatRelativeTime } from '../../utils/format-time';
import type { DocComment } from '../../state/doc-comments-store';
import { Avatar, authorName, authorNameInline } from './Avatar';

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
  const [replyText, setReplyText] = useState('');
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
  const header = (c: { author: DocComment['author']; createdAt: number }, cell?: string) => (
    <div className="flex items-baseline gap-1.5 min-w-0">
      <span className="font-medium text-fg truncate">{authorName(c.author)}</span>
      <span className="text-2xs text-fg-muted shrink-0">{formatRelativeTime(c.createdAt)}</span>
      {cell && <span className="text-2xs text-fg-muted shrink-0">· {cell}</span>}
    </div>
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
            {header(comment, comment.cell)}
            <p className="mt-0.5 text-fg-muted truncate">{comment.text}</p>
          </div>
          {resolveToggle}
        </div>
        <p className="mt-1.5 text-fg-muted">Resolved by {authorNameInline(comment.resolvedBy ?? 'user')}</p>
      </div>
    );
  }

  const sendReply = () => {
    if (!replyText.trim()) return;
    onReply(replyText);
    setReplyText('');
  };

  return (
    <div className="rounded-lg border border-edge-dim bg-inset p-3 text-xs w-full">
      <div className="flex items-start gap-2">
        <Avatar author={comment.author} />
        <div className="flex-1 min-w-0">
          {header(comment, comment.cell)}
          {isDraft ? (
            <Textarea
              ref={textRef}
              size="sm"
              rows={2}
              value={comment.text}
              onChange={(e) => onTextChange(e.target.value)}
              placeholder="Add a comment…"
              // artifact-edit-textarea: reuses the artifact editor's right-click
              // routing (build-menu.ts) — Electron ships no default context menu,
              // so without this marker cut/copy/paste here would do nothing.
              className="artifact-edit-textarea mt-1 w-full"
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

      {/* Round 10 (Destin: "the send button for replies should be within the
          right side of the reply box"): InputGroup — the primitive for a field
          with its submit inside it (TagPicker's Create is the same shape).
          Enter still sends. */}
      {!isDraft && (
        <InputGroup size="sm" className="mt-2 w-full pr-1.5">
          <InputGroup.Field
            aria-label="Reply"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); sendReply(); } }}
            placeholder="Reply…"
          />
          {/* Round 12 (Destin: "send button looks too big for the container.
              doesnt look nested correctly"): the sm field is 28px tall and a
              text sm button 22px, leaving ~3px above and below — it read as
              filling the field, not sitting in it. icon-sm (20px) leaves an
              even 4px on every side, matching InputGroup's own 4px right
              inset; the glyph is the composer send button's arrow, so it
              reads as "send" at a glance. Round 14 ("gets too close to edges
              of the outer container"): icon-xs (16px) with the group's right
              inset raised to 6px, so ~6px of air on every side. */}
          <Button size="icon-xs" aria-label="Send reply" disabled={!replyText.trim()} onClick={sendReply}>
            <svg className="w-2.5 h-2.5 text-on-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </Button>
        </InputGroup>
      )}
      {isDraft && (
        <div className="mt-2 flex items-center justify-end gap-1.5">
          <Button variant="ghost" size="sm" onClick={onDelete}>Delete</Button>
        </div>
      )}
    </div>
  );
}
