// ReplyField — the reply box with its send arrow inside it. Shared by
// CommentCard (Comments mode) and HighlightHoverCard (Reading mode) so the two
// places you can reply look and behave identically (Destin, 2026-09-24:
// "pull your mouse down over the actual comment and then add a reply right
// there without entering the full comment view").
import { useState } from 'react';
import { Button } from '../ui/Button';
import { InputGroup } from '../ui/InputGroup';

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
  return (
    // Round 10 (Destin: "the send button for replies should be within the
    // right side of the reply box"): InputGroup — the primitive for a field
    // with its submit inside it (TagPicker's Create is the same shape).
    // Enter sends.
    <InputGroup size="sm" className={`${className} w-full pr-1.5`}>
      <InputGroup.Field
        aria-label="Reply"
        value={text}
        onChange={(e) => { setText(e.target.value); onDraftChange?.(!!e.target.value.trim()); }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } }}
        onFocus={() => onFocusChange?.(true)}
        onBlur={() => onFocusChange?.(false)}
        placeholder="Reply…"
      />
      {/* Round 12/14 (Destin: "send button looks too big… too close to
          edges"): icon-xs (16px) with the group's right inset raised to 6px,
          so ~6px of air on every side; the glyph is the composer's send
          arrow, so it reads as "send" at a glance. */}
      <Button size="icon-xs" aria-label="Send reply" disabled={!text.trim()} onClick={send}>
        <svg className="w-2.5 h-2.5 text-on-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" />
        </svg>
      </Button>
    </InputGroup>
  );
}
