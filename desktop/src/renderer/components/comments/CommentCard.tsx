// CommentCard — one comment thread: author + timestamp, the anchored quote,
// the note, replies (including an assistant reply), and resolve/reopen.
// Used both in the margin (desktop) and inside a popover (narrow viewport).
import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Textarea } from '../ui/Textarea';
import { TextInput } from '../ui/TextInput';
import { CheckIcon } from '../Icons';
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

  if (comment.resolved) {
    // Fade/collapse (Docs-style): a one-line sliver naming who resolved it,
    // with the only action being to bring it back.
    return (
      <div className="rounded-lg border border-edge-dim bg-panel/70 opacity-70 px-2.5 py-2 text-xs">
        <button type="button" onClick={onJump} className="block w-full text-left mb-1 min-w-0">
          <p className="text-fg-muted italic truncate">&ldquo;{comment.quote}&rdquo;</p>
        </button>
        <div className="flex items-center gap-1.5 text-fg-muted">
          <CheckIcon className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">Resolved by {comment.resolvedBy === 'assistant' ? 'Claude' : 'you'}</span>
          <Button variant="ghost" size="sm" onClick={onReopen} className="ml-auto shrink-0">Reopen</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-edge bg-panel shadow-sm p-2.5 text-xs w-full">
      <button type="button" onClick={onJump} className="block w-full text-left mb-2 min-w-0">
        <p className="text-fg-muted italic line-clamp-2 border-l-2 border-edge-dim pl-2">&ldquo;{comment.quote}&rdquo;</p>
      </button>

      <div className="flex items-start gap-2">
        <Avatar author={comment.author} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="font-medium text-fg">{authorName(comment.author)}</span>
            <span className="text-3xs text-fg-muted">{formatRelativeTime(comment.createdAt)}</span>
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
              <span className="text-3xs text-fg-muted">{formatRelativeTime(r.createdAt)}</span>
            </div>
            <p className="mt-0.5 text-fg-2 whitespace-pre-wrap">{r.text}</p>
          </div>
        </div>
      ))}

      {/* Round 3: Reply + Resolve moved OFF a single row with the reply field
          (guide §4.6 card anatomy) after the coordinator's review caught
          Resolve — and sometimes Reply — clipped off the margin's 256px
          card even with min-w-0 on the input: three controls sharing one
          row simply don't fit that width. The input now takes its own
          full-width row; the two buttons sit right-aligned below it, which
          fits at any card width the margin ever renders. A draft has
          nothing to resolve yet, so it only offers Delete. */}
      {!isDraft && (
        <div className="mt-2 flex flex-col gap-1.5">
          <TextInput
            size="sm"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && replyText.trim()) { onReply(replyText); setReplyText(''); }
            }}
            placeholder="Reply…"
            className="w-full"
          />
          <div className="flex items-center justify-end gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              disabled={!replyText.trim()}
              onClick={() => { onReply(replyText); setReplyText(''); }}
            >
              Reply
            </Button>
            <Button variant="secondary" size="sm" onClick={onResolve}>Resolve</Button>
          </div>
        </div>
      )}
      {isDraft && (
        <div className="mt-2 flex items-center justify-end gap-1.5">
          <Button variant="ghost" size="sm" onClick={onDelete}>Delete</Button>
        </div>
      )}
    </div>
  );
}
