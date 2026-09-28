// HighlightHoverCard — Reading mode's read-only preview of a highlighted
// comment: author, time and the note itself, shown only while the pointer
// is on the highlight. Round 9 (Destin): "drop the 'no replies yet' text and
// the 'open in comments' button… hovering should just display that comment"
// — clicking the highlight itself now opens Comments mode (ReadingHighlights). Destin, round 2: "the comment primarily be seen
// as highlighted text, with the comment displaying on hover… clicking a
// highlight pins the same card." Comments mode (CommentCard) is where you
// resolve/edit; since 2026-09-24 this card also takes a reply (see render).
//
// Round 3 (polish pass): positioning moved onto the SAME anchor-position.ts
// arithmetic AnchorTip/Tooltip use (below the highlight, flipped above when
// there's no room, clamped to the viewer's own content area — never the
// header row or the window) instead of a hand-rolled clamp; ReadingHighlights
// now also gives it an open delay + a close grace period, and its own
// onMouseEnter/onMouseLeave keep it open while the pointer travels onto it.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CompleteToggle } from '../SessionCardDetails';
import { formatRelativeTime } from '../../utils/format-time';
import { OverlayPanel, POPOVER_Z } from '../overlays/Overlay';
import { ErrorState } from '../ui/states';
import { placeBubble } from '../ui/anchor-position';
import { Avatar, authorName } from './Avatar';
import { ReplyField } from './ReplyField';
import { EditDeleteButtons, InlineEditField, DeleteConfirmRow, deleteCommentLabel } from './CommentActions';
import type { DocComment } from '../../state/doc-comments-store';

const GAP = 8;

interface Props {
  comment: DocComment;
  /** Viewport rect of the highlight this card answers for. */
  anchorRect: DOMRect;
  /** The viewer's own content area — the card must stay inside it, never
   *  over the header/toolbar rows above. */
  boundsEl: HTMLElement | null;
  /** Pointer arrived on the card — the host cancels its close timer. */
  onPointerEnter: () => void;
  /** Pointer left the card — the host schedules the close. */
  onPointerLeave: () => void;
  /** True while a reply is being typed (focused or non-empty), so the host
   *  keeps the card open even if the pointer drifts away. */
  onEngagedChange: (engaged: boolean) => void;
  onReply: (text: string) => void;
  onResolve: () => void;
  onReopen: () => void;
  // Edit/delete build (E-1..E-6, docs/active/design/2026-09-24-doc-comments/
  // doc-comments.edit-delete.questions.answers.json): "code/xlsx surfaces
  // reuse the same card" — this preview gets the identical icons Comments
  // mode's CommentCard does, not just resolve. Optional so a caller that
  // hasn't wired the concurrent backend yet still renders (same convention
  // as CommentCard's own onEditText/onDeleteComment/onEditReply/onDeleteReply).
  onEditText?: (text: string) => void;
  onDeleteComment?: () => void;
  onEditReply?: (replyId: string, text: string) => void;
  onDeleteReply?: (replyId: string) => void;
}

export function HighlightHoverCard({
  comment, anchorRect, boundsEl, onPointerEnter, onPointerLeave, onEngagedChange, onReply, onResolve, onReopen,
  onEditText, onDeleteComment, onEditReply, onDeleteReply,
}: Props) {
  // Same explicitly-triggered-only local state CommentCard.tsx uses (see its
  // own WHY) — never derived from `comment.text`/`replies`, so a
  // `docComments:changed` refresh mid-edit can't unmount this card's textarea.
  const [isEditingComment, setIsEditingComment] = useState(false);
  const [confirmingDeleteComment, setConfirmingDeleteComment] = useState(false);
  const [editingReplyId, setEditingReplyId] = useState<string | null>(null);
  const [confirmingDeleteReplyId, setConfirmingDeleteReplyId] = useState<string | null>(null);
  // Engaged = the reply box is focused OR has text. Either one alone must
  // keep the card open: focus covers "clicked in, not typed yet", text covers
  // "typed, then clicked elsewhere on the card".
  const [focused, setFocused] = useState(false);
  const [hasText, setHasText] = useState(false);
  useEffect(() => { onEngagedChange(focused || hasText); }, [focused, hasText, onEngagedChange]);
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
    // Destin, 2026-09-24: "you can kind of pull your mouse down over the
    // actual comment and then add a reply right there without entering the
    // full comment view". So the card now takes the pointer: moving onto it
    // keeps it open (onPointerEnter/Leave feed ReadingHighlights' timers),
    // and it shows the thread's replies plus the same reply box Comments mode
    // uses. Edit/delete build (2026-09-28): resolving, editing and deleting
    // now all work from this preview too, not just Comments mode.
    <div
      ref={panelRef}
      role="dialog"
      data-hover-card
      aria-label={`Comment from ${authorName(comment.author)}`}
      className="fixed w-64"
      style={{ zIndex: POPOVER_Z, left: pos.left, top: pos.top }}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
    <OverlayPanel layer={4} className="p-3 text-xs" style={{ zIndex: 'auto', borderRadius: 'var(--radius-lg)' }}>
      {/* Destin, 2026-09-24: resolve from the preview too — the same
          circle-check, in the same top-right spot, as a Comments-mode card.
          Edit/delete build: Edit/Delete icons join it (E-1) — "code/xlsx
          surfaces reuse the same card". */}
      <Entry
        author={comment.author}
        createdAt={comment.createdAt}
        text={comment.text}
        clamp={!isEditingComment}
        editing={isEditingComment}
        onSaveEdit={(text) => { onEditText?.(text); setIsEditingComment(false); }}
        onCancelEdit={() => setIsEditingComment(false)}
        below={confirmingDeleteComment && (
          <DeleteConfirmRow
            label={deleteCommentLabel(comment.replies.length)}
            onConfirm={() => { onDeleteComment?.(); setConfirmingDeleteComment(false); }}
            onCancel={() => setConfirmingDeleteComment(false)}
          />
        )}
        trailing={
          <div className="flex items-center gap-0.5 shrink-0">
            {onEditText && onDeleteComment && (
              <EditDeleteButtons
                onEdit={() => { setIsEditingComment(true); setConfirmingDeleteComment(false); }}
                onDelete={() => { setConfirmingDeleteComment(true); setIsEditingComment(false); }}
                editLabel="Edit comment"
                deleteLabel="Delete comment"
              />
            )}
            <CompleteToggle
              done={comment.resolved}
              name="this comment"
              onToggle={(next) => (next ? onResolve() : onReopen())}
              titles={{ set: 'Resolved. Click to reopen.', unset: 'Resolve this comment?' }}
              className="shrink-0"
            />
          </div>
        }
      />
      {/* Replies scroll inside the card past a few, so a long thread never
          pushes the reply box off screen. */}
      {comment.replies.length > 0 && (
        <div className="max-h-40 overflow-y-auto">
          {comment.replies.map((r) => (
            <div key={r.id} className="mt-2 pl-1">
              <Entry
                author={r.author}
                createdAt={r.createdAt}
                text={r.text}
                editing={editingReplyId === r.id}
                onSaveEdit={(text) => { onEditReply?.(r.id, text); setEditingReplyId(null); }}
                onCancelEdit={() => setEditingReplyId(null)}
                below={confirmingDeleteReplyId === r.id && (
                  <DeleteConfirmRow
                    label="Delete this reply?"
                    onConfirm={() => { onDeleteReply?.(r.id); setConfirmingDeleteReplyId(null); }}
                    onCancel={() => setConfirmingDeleteReplyId(null)}
                  />
                )}
                trailing={onEditReply && onDeleteReply && editingReplyId !== r.id && confirmingDeleteReplyId !== r.id && (
                  <EditDeleteButtons
                    onEdit={() => { setEditingReplyId(r.id); setConfirmingDeleteReplyId(null); }}
                    onDelete={() => { setConfirmingDeleteReplyId(r.id); setEditingReplyId(null); }}
                    editLabel="Edit reply"
                    deleteLabel="Delete reply"
                  />
                )}
              />
            </div>
          ))}
        </div>
      )}
      {/* F7 fix (T5 review): a failed reply/resolve/reopen from THIS hover
          preview shows here — the card actually on screen — instead of a
          global toast the preview has already closed by the time it appears. */}
      {comment.error && (
        <ErrorState className="mt-2" message={comment.error.message} onRetry={comment.error.onRetry} />
      )}
      {!confirmingDeleteComment && <ReplyField onSend={onReply} onFocusChange={setFocused} onDraftChange={setHasText} />}
    </OverlayPanel>
    </div>
  );
}

/** One author · time · text row — the same header shape CommentCard uses.
 *  Edit/delete build: `editing` swaps the text paragraph for the shared
 *  `InlineEditField`, and `below` renders CommentCard's own delete confirm
 *  underneath — kept as props on the ALREADY-shared row rather than a second
 *  near-duplicate component (Avatar.tsx's own "two copies drifted" WHY). */
function Entry({ author, createdAt, text, clamp, trailing, editing, onSaveEdit, onCancelEdit, below }: {
  author: DocComment['author']; createdAt: number; text: string; clamp?: boolean; trailing?: ReactNode;
  editing?: boolean; onSaveEdit?: (text: string) => void; onCancelEdit?: () => void; below?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2 group">
      <Avatar author={author} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className="font-medium text-fg">{authorName(author)}</span>
          <span className="text-2xs text-fg-muted">{formatRelativeTime(createdAt)}</span>
        </div>
        {editing && onSaveEdit && onCancelEdit ? (
          <InlineEditField text={text} onSave={onSaveEdit} onCancel={onCancelEdit} />
        ) : (
          <p className={`mt-0.5 text-fg-2 whitespace-pre-wrap${clamp ? ' line-clamp-4' : ''}`}>{text}</p>
        )}
        {below}
      </div>
      {trailing}
    </div>
  );
}
