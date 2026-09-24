// HighlightHoverCard — Reading mode's read-only preview of a highlighted
// comment: author, time and the note itself, shown only while the pointer
// is on the highlight. Round 9 (Destin): "drop the 'no replies yet' text and
// the 'open in comments' button… hovering should just display that comment"
// — clicking the highlight itself now opens Comments mode (ReadingHighlights). Destin, round 2: "the comment primarily be seen
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
import { formatRelativeTime } from '../../utils/format-time';
import { OverlayPanel, POPOVER_Z } from '../overlays/Overlay';
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
}

export function HighlightHoverCard({ comment, anchorRect, boundsEl }: Props) {
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
    // Round 7: the app's shared popup surface (OverlayPanel/.layer-surface —
    // what the right-click menu uses) instead of a hand-rolled bg-panel +
    // shadow, so glass themes render it like every other popover.
    // The outer div carries position; the panel inside is the surface.
    // pointer-events-none: nothing on the card is clickable any more, so it
    // must never catch the pointer and cut the hover short.
    <div
      ref={panelRef}
      role="tooltip"
      className="fixed w-64 pointer-events-none"
      style={{ zIndex: POPOVER_Z, left: pos.left, top: pos.top }}
    >
    <OverlayPanel layer={4} className="p-3 text-xs" style={{ zIndex: 'auto', borderRadius: 'var(--radius-lg)' }}>
      <div className="flex items-start gap-2">
        <Avatar author={comment.author} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="font-medium text-fg">{authorName(comment.author)}</span>
            <span className="text-2xs text-fg-muted">{formatRelativeTime(comment.createdAt)}</span>
          </div>
          <p className="mt-0.5 text-fg-2 whitespace-pre-wrap line-clamp-4">{comment.text}</p>
        </div>
      </div>
    </OverlayPanel>
    </div>
  );
}
