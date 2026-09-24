// HighlightHoverCard — Reading mode's read-only preview of a highlighted
// comment: author, time, the note itself, a reply count or "Resolved by…",
// and "Open in comments" (switches ActiveArtifactView into Comments mode,
// focused on this thread). Destin, round 2: "the comment primarily be seen
// as highlighted text, with the comment displaying on hover… clicking a
// highlight pins the same card." Comments mode (CommentCard) is where you
// actually reply/resolve/edit — this card never mutates anything.
//
// Round 3 (polish pass): positioning moved onto the SAME anchor-position.ts
// arithmetic AnchorTip/Tooltip use (below the highlight, flipped above when
// there's no room, clamped to the viewer's own content area — never the
// header row or the window) instead of a hand-rolled clamp; ReadingHighlights
// now also gives it an open delay + a close grace period, and its own
// onMouseEnter/onMouseLeave keep it open while the pointer travels onto it.
import { useLayoutEffect, useRef, useState } from 'react';
import { CheckIcon } from '../Icons';
import { formatRelativeTime } from '../../utils/format-time';
import { POPOVER_Z } from '../overlays/Overlay';
import { placeBubble } from '../ui/anchor-position';
import { Avatar, authorName } from './Avatar';
import type { DocComment } from '../../state/doc-comments-store';

const GAP = 8;

interface Props {
  comment: DocComment;
  /** Viewport rect of the highlight this card answers for. */
  anchorRect: DOMRect;
  /** The viewer's own content area — the card must stay inside it, never
   *  over the header/toolbar rows above. */
  boundsEl: HTMLElement | null;
  onOpenComments: () => void;
  /** Keeps the card open while the pointer is over IT too (grace period). */
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

export function HighlightHoverCard({ comment, anchorRect, boundsEl, onOpenComments, onMouseEnter, onMouseLeave }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchorRect.left, top: anchorRect.bottom + GAP });

  // Two-pass placement (anchor-position.ts's own WHY): the panel is 0-sized
  // on its first render, so this reruns as a layout effect once it can
  // actually be measured.
  useLayoutEffect(() => {
    const trigger = { getBoundingClientRect: () => anchorRect } as unknown as HTMLElement;
    const { left, top } = placeBubble(
      trigger,
      panelRef.current,
      { placement: 'bottom', align: 'start', gapBelow: GAP, gapAbove: GAP },
      boundsEl,
    );
    setPos({ left, top });
  }, [comment.id, anchorRect, boundsEl]);

  return (
    <div
      ref={panelRef}
      role="dialog"
      className="fixed w-64 rounded-lg border border-edge bg-panel shadow-lg p-2.5 text-xs"
      style={{ zIndex: POPOVER_Z, left: pos.left, top: pos.top }}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="flex items-start gap-2">
        <Avatar author={comment.author} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="font-medium text-fg">{authorName(comment.author)}</span>
            <span className="text-3xs text-fg-muted">{formatRelativeTime(comment.createdAt)}</span>
          </div>
          <p className="mt-0.5 text-fg-2 whitespace-pre-wrap line-clamp-4">{comment.text}</p>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-fg-muted">
        {comment.resolved ? (
          <span className="inline-flex items-center gap-1">
            <CheckIcon className="w-3.5 h-3.5" />
            Resolved by {comment.resolvedBy === 'assistant' ? 'Claude' : 'you'}
          </span>
        ) : (
          <span>{comment.replies.length > 0 ? `${comment.replies.length} ${comment.replies.length === 1 ? 'reply' : 'replies'}` : 'No replies yet'}</span>
        )}
        {/* text-accent + link-control: the house text-link pattern
            (SyncSetupWizard, MarketplaceDetailOverlay) — not the raw
            `text-link` token, which reads as a plain browser-blue underline
            here (round 3 finding). */}
        <button type="button" onClick={onOpenComments} className="text-accent underline link-control shrink-0">
          Open in comments
        </button>
      </div>
    </div>
  );
}
