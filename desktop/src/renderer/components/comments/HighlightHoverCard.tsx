// HighlightHoverCard — Reading mode's read-only preview of a highlighted
// comment: author, time, the note itself, a reply count or "Resolved by…",
// and "Open in comments" (switches ActiveArtifactView into Comments mode,
// focused on this thread). Destin, round 2: "the comment primarily be seen
// as highlighted text, with the comment displaying on hover… clicking a
// highlight pins the same card." Comments mode (CommentCard) is where you
// actually reply/resolve/edit — this card never mutates anything.
import { CheckIcon } from '../Icons';
import { formatRelativeTime } from '../../utils/format-time';
import { POPOVER_Z } from '../overlays/Overlay';
import type { CommentAuthor, DocComment } from '../../state/doc-comments-store';

function authorName(author: CommentAuthor): string {
  return author === 'assistant' ? 'Claude' : 'You';
}

function Avatar({ author }: { author: CommentAuthor }) {
  return (
    <span
      aria-hidden
      className="inline-flex items-center justify-center shrink-0 w-5 h-5 rounded-full border border-edge-dim bg-inset text-3xs font-medium text-fg-2"
    >
      {author === 'assistant' ? '✳' : 'D'}
    </span>
  );
}

interface Props {
  comment: DocComment;
  /** Viewport position (fixed) — computed by the caller from the mark's own
   *  rect, clamped so the card never runs off-screen. */
  style: React.CSSProperties;
  onOpenComments: () => void;
}

export function HighlightHoverCard({ comment, style, onOpenComments }: Props) {
  return (
    <div
      role="dialog"
      className="fixed w-64 rounded-lg border border-edge bg-panel shadow-lg p-2.5 text-xs"
      style={{ zIndex: POPOVER_Z, ...style }}
      // Keep the card open while the pointer is over IT too — a hover card
      // that vanishes the instant the mouse leaves the highlight to reach
      // "Open in comments" would make that link unreachable by mouse.
      onMouseDown={(e) => e.stopPropagation()}
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
        <button type="button" onClick={onOpenComments} className="text-link hover:text-link-hover underline shrink-0">
          Open in comments
        </button>
      </div>
    </div>
  );
}
