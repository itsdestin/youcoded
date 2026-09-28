import React from 'react';
import { Button } from './ui';

// Task 12: renders messages the native host FIFO'd behind an in-flight turn
// (SessionChatState.queuedMessages) docked at the bottom of the chat area —
// NOT as timeline entries. This replaces Task 3/11's queued `USER_PROMPT`
// timeline bubble + UserMessage's Cancel/Edit affordances: that design
// appended the bubble to the timeline at ENQUEUE time, but the streaming
// assistant turn's timeline entry is created lazily on its FIRST delta — so
// content arriving after the enqueue rendered BELOW the queued bubble and
// stayed there once the in-place confirm froze that position ("assistant
// responding to itself"). A queued message now joins the timeline for the
// first time when the host actually drains it (TRANSCRIPT_USER_MESSAGE's
// no-pending-match fallback in chat-reducer.ts), which always appends at the
// true, current end of the timeline.
//
// Known accepted limit: this list is renderer-local state. A reload loses the
// strip's visual rows while the host queue keeps draining underneath it —
// confirms still land correctly in the timeline; the rows just don't come
// back until a fresh QUEUED_MESSAGE_ADDED (there isn't one, since the reload
// didn't send anything). Rehydrating from the host's live queue on connect is
// a possible later nicety, not required here. Remote clients that didn't
// enqueue the message also never see it in their own strip — same
// renderer-local scope.

/** Same trash glyph as the doc-comments delete action (comments/CommentActions
 *  .tsx on its branch, Destin 2026-09-28: "matching ... delete a comment") —
 *  24×24 viewBox, stroke currentColor, the app's inline-icon convention. */
function TrashGlyph() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}

/** "Send now" (Destin, 2026-09-28 review decks): rightmost in the row, styled
 *  like the message box's own send button — the same primary <Button> (theme
 *  accent fill, the same arrow glyph) rather than a hand-styled look, so it
 *  reads as "send" wherever the theme puts its accent. On hover or keyboard
 *  focus the words "Interrupt and Send Now" roll out to the left of the
 *  arrow inside the button; the trash beside it is the next item in the row,
 *  so it slides left with a fixed gap.
 *  WHY the reveal is on an inner span: the primitive owns the button's own
 *  colours, size and effects (design lint `no-restyle`); only the label's
 *  max-width animates, with the session pills' sanctioned motion tokens
 *  (pill-label-style.ts, ast-grep `pill-label-reveals-with-motion-tokens`).
 *  WHY one inner wrapper: the Button's own gap would otherwise leave a space
 *  beside the arrow while the label is hidden.
 *  Touch has no hover, so on a phone it stays the arrow alone; its meaning is
 *  in the accessible name for screen readers. */
function SendNowButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="primary" size="sm" aria-label="Interrupt and send now" onClick={onClick} className="group">
      <span className="flex items-center">
        <span
          aria-hidden
          className="max-w-0 overflow-hidden whitespace-nowrap opacity-0 group-hover:max-w-48 group-hover:opacity-100 group-hover:pr-1.5 group-focus-visible:max-w-48 group-focus-visible:opacity-100 group-focus-visible:pr-1.5"
          style={{ transition: 'max-width var(--dur-reveal) var(--ease-reveal), opacity var(--dur-reveal) var(--ease-reveal), padding var(--dur-reveal) var(--ease-reveal)' }}
        >
          Interrupt and Send Now
        </span>
        {/* The message box's send arrow (InputBar.tsx "Send message"), same path. */}
        <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" />
        </svg>
      </span>
    </Button>
  );
}

interface QueuedMessage {
  queueId: string;
  content: string;
  timestamp: number;
}

interface Props {
  queuedMessages: QueuedMessage[];
  // Cancel/Edit — App owns the native:queue-remove invoke, the
  // QUEUED_MESSAGE_REMOVED dispatch (on BOTH outcomes — see App.tsx
  // handleCancelQueued/handleEditQueued), and the too-late toast. This
  // component is a pure callback-prop presentational piece, mirroring how
  // UserMessage's Task 11 affordances were wired (ChatView threads
  // sessionId + queueId through, no IPC/dispatch happens here).
  onCancel?: (queueId: string) => void;
  onEdit?: (queueId: string, text: string) => void;
  // "Send now" — App stops the current task and sends this message next.
  onSendNow?: (queueId: string) => void;
}

// forwardRef (review fix, post-approval): ChatView needs the strip's OWN
// rendered height to publish `--queued-strip-height` (see ChatView.tsx's
// measurement effect) so the two floating elements that share its bottom
// offset band (.model-status-strip / .jump-to-bottom) can lift above it
// instead of overlapping it. The ref targets this component's root div
// directly (not a wrapping element in ChatView) because that root is
// `position: absolute` — a plain static wrapper around it would NOT size
// itself to the absolutely-positioned child's content, so measuring a
// wrapper instead of this element would always read 0.
const QueuedMessagesStrip = React.forwardRef<HTMLDivElement, Props>(function QueuedMessagesStrip(
  { queuedMessages, onCancel, onEdit, onSendNow },
  ref,
) {
  if (queuedMessages.length === 0) return null;

  return (
    <div
      ref={ref}
      className="queued-messages-strip absolute left-3 right-3 z-10 flex flex-col gap-1.5"
      aria-label="Queued messages"
    >
      {queuedMessages.map((q) => (
        <div
          key={q.queueId}
          className="layer-surface flex items-center gap-2 rounded-xl px-3 py-2 shadow-lg"
        >
          <div className="text-4xs text-fg-muted tracking-wider uppercase select-none shrink-0">
            Queued
          </div>
          <div className="flex-1 min-w-0 truncate text-sm text-fg-2">{q.content}</div>
          {(onEdit || onCancel || onSendNow) && (
            <div className="flex items-center gap-0.5 shrink-0">
              {onEdit && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Edit queued message"
                  onClick={() => onEdit(q.queueId, q.content)}
                  className="w-6 h-6 rounded-full text-fg-dim hover:text-fg text-xs leading-none"
                >
                  ✎
                </Button>
              )}
              {onCancel && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Cancel queued message"
                  onClick={() => onCancel(q.queueId)}
                  className="w-6 h-6 rounded-full text-fg-dim hover:text-fg text-xs leading-none"
                >
                  <TrashGlyph />
                </Button>
              )}
              {onSendNow && <SendNowButton onClick={() => onSendNow(q.queueId)} />}
            </div>
          )}
        </div>
      ))}
    </div>
  );
});

export default QueuedMessagesStrip;
