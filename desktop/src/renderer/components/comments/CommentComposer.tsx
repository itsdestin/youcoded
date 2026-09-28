// CommentComposer — the ONE text box with a round send arrow inside it, used
// for a reply (ReplyField), a new comment in the panel (CommentCard's draft)
// and a new comment in the floating box (NewCommentPopover).
//
// WHY one component (Destin, 2026-09-28: "the cursor/text/box/send button
// alignment is all very off in the comment box"): the three boxes were built
// separately — the reply box through InputGroup.Field (padded), the two
// new-comment boxes as bare textareas with NO left padding, so the caret and
// text sat against the border and the arrow landed at a different height in
// each. Sharing one box makes them identical by construction.
import React from 'react';
import { Button } from '../ui/Button';
import { InputGroup } from '../ui/InputGroup';
import { FIELD_SIZE, FIELD_TEXT } from '../ui/field';

// Starts one line tall like the reply box always was, grows with what's typed
// up to a cap, then scrolls. CSS `field-sizing: content` does the growing
// with no script measuring the box per keystroke (performance.md rule 6).
const GROW_STYLE = { fieldSizing: 'content', maxHeight: '14em', overflowY: 'auto' } as React.CSSProperties;

interface Props {
  value: string;
  onChange: (text: string) => void;
  /** Enter (without Shift) and the arrow. */
  onSubmit: () => void;
  onEscape?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  placeholder: string;
  ariaLabel: string;
  sendLabel: string;
  textRef?: React.Ref<HTMLTextAreaElement>;
  /** Floating box only: stops the arrow's mousedown from blurring the field,
   *  so its click-away listener never races the arrow's own click. */
  keepFocusOnSend?: boolean;
  className?: string;
}

export function CommentComposer({
  value, onChange, onSubmit, onEscape, onFocus, onBlur, placeholder, ariaLabel, sendLabel, textRef, keepFocusOnSend, className = '',
}: Props) {
  return (
    // The caller's spacing goes on a plain wrapper: design lint can't check a
    // className built at runtime on a primitive, so InputGroup's stays static.
    <div className={className}>
    <InputGroup size="sm" className="w-full">
      <textarea
        ref={textRef}
        rows={1}
        style={GROW_STYLE}
        aria-label={ariaLabel}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(); }
          else if (e.key === 'Escape' && onEscape) { e.preventDefault(); onEscape(); }
        }}
        onFocus={onFocus}
        onBlur={onBlur}
        // Bare like InputGroup.Field (the wrapper carries the border), with
        // the SAME text and padding tokens, so the caret lines up with the
        // reply box's. data-edit-menu: real cut/copy/paste on right-click
        // (build-menu.ts) — Electron ships no default context menu.
        className={`flex-1 min-w-0 bg-transparent border-0 outline-none resize-none leading-snug ${FIELD_TEXT} ${FIELD_SIZE.sm}`}
        data-edit-menu
      />
      {/* self-end + mb-1: on one line the arrow sits centred beside the text
          (the same place it always sat in the reply box); as the text grows
          it stays pinned beside the LAST line instead of floating mid-box. */}
      <Button
        size="icon-xs"
        aria-label={sendLabel}
        disabled={!value.trim()}
        onMouseDown={keepFocusOnSend ? (e) => e.preventDefault() : undefined}
        onClick={onSubmit}
        className="mr-0.5 self-end mb-1"
      >
        <svg className="w-2.5 h-2.5 text-on-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" />
        </svg>
      </Button>
    </InputGroup>
    </div>
  );
}
