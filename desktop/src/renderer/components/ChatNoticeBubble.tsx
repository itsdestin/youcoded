import React from 'react';
import { FoldRow } from './ui/FoldRow';

// The chat's notice card: a reply-shaped bubble with a status ring, one plain
// sentence, an optional Details fold, and its buttons at the right.
//
// WHY its own file (card #236): the red error card in AttentionBanner was the only
// user of this shape. The expired-sign-in and no-internet cards are the same job —
// "the reply could not happen, here is what to do" — so they render through this one
// shell instead of copying its classes (design guide "New UI reuses what exists").
// The markup is the SortedErrorCard's, moved here unchanged.

export type ChatNoticeTone = 'danger' | 'warning' | 'quiet';

// Status hues stay fixed across themes and live only in the ring (guide: "Status
// colours … only in a tint", never in the words). `quiet` is a resolved notice — a
// sign-in that has since been fixed — so it carries no status colour at all.
const RING: Record<ChatNoticeTone, string> = {
  danger: 'ring-1 ring-[var(--destructive)]',
  warning: 'ring-1 ring-amber-500',
  quiet: '',
};

export function ChatNoticeBubble({ tone, line, buttons, details, footer }: {
  tone: ChatNoticeTone;
  line: React.ReactNode;
  /** The card's buttons, outlined first and the one filled main action last. */
  buttons?: React.ReactNode;
  /** Machine words (a provider's raw message) — only ever under this fold. */
  details?: string | null;
  /** Small print under the card (a request id). */
  footer?: React.ReactNode;
}) {
  const row = buttons ? <div className="ml-auto flex items-center justify-end gap-2 shrink-0" data-parts-agree="chat-notice">{buttons}</div> : null;
  return (
    <div className="flex flex-col items-start gap-1 px-4 py-1.5 in-view">
      <div className={`flex flex-col gap-2 bg-inset rounded-2xl rounded-bl-sm px-4 py-2.5 max-w-full ${RING[tone]}`}>
        {/* Guide (Status and notices, gt-r1#E-2/#E-3): what happened, the machine's own
            words if you want them, then what you can do — so with a Details fold the
            buttons sit BELOW it, at the right; without one they sit beside the sentence. */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-fg-2 min-w-0">{line}</span>
          {!details && row}
        </div>
        {details && (
          <FoldRow title="Details" flush>
            <p className="text-2xs text-fg-2 font-mono break-all select-text">{details}</p>
          </FoldRow>
        )}
        {details && row}
      </div>
      {footer}
    </div>
  );
}
