// ReplyField — the reply box with its send arrow inside it. Shared by
// CommentCard (Comments mode) and HighlightHoverCard (Reading mode) so the two
// places you can reply look and behave identically (Destin, 2026-09-24:
// "pull your mouse down over the actual comment and then add a reply right
// there without entering the full comment view").
import { useState } from 'react';
import { CommentComposer } from './CommentComposer';

interface Props {
  onSend: (text: string) => void;
  /** Lets the hover card stay open while a reply is being typed. */
  onDraftChange?: (hasText: boolean) => void;
  onFocusChange?: (focused: boolean) => void;
  className?: string;
}

export function ReplyField({ onSend, onDraftChange, onFocusChange, className = 'mt-2' }: Props) {
  const [text, setText] = useState('');
  const send = () => {
    if (!text.trim()) return;
    onSend(text);
    setText('');
    onDraftChange?.(false);
  };
  // 2026-09-28: the same box as a new comment (CommentComposer.tsx's WHY) —
  // the reply box used to be a single-line input, the new-comment boxes a
  // textarea, and their text and arrows never lined up. Enter sends;
  // Shift+Enter now starts a new line in a reply too.
  return (
    <CommentComposer
      className={className}
      value={text}
      onChange={(t) => { setText(t); onDraftChange?.(!!t.trim()); }}
      onSubmit={send}
      onFocus={() => onFocusChange?.(true)}
      onBlur={() => onFocusChange?.(false)}
      placeholder="Reply…"
      ariaLabel="Reply"
      sendLabel="Send reply"
    />
  );
}
