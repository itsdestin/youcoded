// CommentCard — one comment thread: author + timestamp, the anchored quote,
// the note, replies (including an assistant reply), and resolve/reopen.
// Used both in the margin (desktop) and inside a popover (narrow viewport).
import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Textarea } from '../ui/Textarea';
import { InputGroup } from '../ui/InputGroup';
import { CompleteToggle } from '../SessionCardDetails';
import { formatRelativeTime } from '../../utils/format-time';
import type { DocComment } from '../../state/doc-comments-store';
import { Avatar, authorName } from './Avatar';

interface Props {
  comment: DocComment;
  autoFocus?: boolean;
  onTextChange: (text: string) => void;
  onReply: (text: string) => void;
  onResolve: () => void;
  onReopen: () => void;
  onDelete: () => void;
  onJump?: () => void;
}

export function CommentCard({ comment, autoFocus, onTextChange, onReply, onResolve, onReopen, onDelete, onJump }: Props) {
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
  // The quoted text doubles as "jump to it in the document".
  const quote = (clamp: 'truncate' | 'line-clamp-2') => (
    <button type="button" onClick={onJump} className="flex-1 min-w-0 text-left">
      <p className={`text-fg-muted italic ${clamp} border-l-2 border-edge-dim pl-2`}>&ldquo;{comment.quote}&rdquo;</p>
    </button>
  );

  if (comment.resolved) {
    // Collapsed (Docs-style): the quote and who resolved it; the filled
    // toggle top-right is the way back.
    return (
      // Design-guide review (round 7): a card inside a side pane is `inset`
      // with an `edge-dim` border and no shadow (§2.1/§2.4 — the tool-card
      // recipe); muted text says "done" without fading the whole card below
      // the contrast floor.
      <div className="rounded-lg border border-edge-dim bg-inset p-3 text-xs">
        <div className="flex items-start gap-2">
          {quote('truncate')}
          {resolveToggle}
        </div>
        <p className="mt-1.5 text-fg-muted">Resolved by {comment.resolvedBy === 'assistant' ? 'Claude' : 'you'}</p>
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
      <div className="flex items-start gap-2 mb-2">
        {quote('line-clamp-2')}
        {resolveToggle}
      </div>

      <div className="flex items-start gap-2">
        <Avatar author={comment.author} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="font-medium text-fg">{authorName(comment.author)}</span>
            <span className="text-2xs text-fg-muted">{formatRelativeTime(comment.createdAt)}</span>
          </div>
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
      </div>

      {comment.replies.map((r) => (
        <div key={r.id} className="flex items-start gap-2 mt-2 pl-1">
          <Avatar author={r.author} />
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-1.5">
              <span className="font-medium text-fg">{authorName(r.author)}</span>
              <span className="text-2xs text-fg-muted">{formatRelativeTime(r.createdAt)}</span>
            </div>
            <p className="mt-0.5 text-fg-2 whitespace-pre-wrap">{r.text}</p>
          </div>
        </div>
      ))}

      {/* Round 10 (Destin: "the send button for replies should be within the
          right side of the reply box"): InputGroup — the primitive for a field
          with its submit inside it (TagPicker's Create is the same shape).
          Enter still sends. */}
      {!isDraft && (
        <InputGroup size="sm" className="mt-2 w-full">
          <InputGroup.Field
            aria-label="Reply"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); sendReply(); } }}
            placeholder="Reply…"
          />
          <Button size="sm" disabled={!replyText.trim()} onClick={sendReply}>Send</Button>
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
