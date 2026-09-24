// ReadingHighlights — Reading mode's entire comments surface (Destin, round
// 2): "the comment primarily be seen as highlighted text, with the comment
// displaying on hover… clicking a highlight pins the same card." No margin,
// no markers — the document stays full width (MarkdownView renders this
// INSTEAD of CommentsMargin when mode==='reading'). Owns:
//   - hover/pin/click on existing highlights → HighlightHoverCard
//   - select text, release it → the SAME right-click menu build-menu.ts
//     builds for this viewer (Add comment / Ask about this / Copy / Select
//     all), anchored at the selection's end → NewCommentPopover
// "Open in comments" and the header toggle (ActiveArtifactView) are the only
// way into the rich margin (Comments mode) — reply/resolve/edit/delete never
// happen here, on purpose (brief: "kinda be a distinct mode").
//
// Round 3 (polish pass): the old separate floating "Comment" button
// (SelectionCommentButton, now deleted) looked nothing like the right-click
// menu it duplicated — releasing a selection now opens buildContextMenu's
// OWN entries in the SAME <ContextMenu>, so the two paths can never drift
// apart again. This is scoped to the FILE VIEWER only — chat messages keep
// right-click only (auto-popping a menu while reading chat would be noisy).
import { useEffect, useMemo, useRef, useState } from 'react';
import { HighlightHoverCard } from './HighlightHoverCard';
import { NewCommentPopover } from './NewCommentPopover';
import { ContextMenu } from '../context-menu/ContextMenu';
import { buildContextMenu, type MenuEntry } from '../context-menu/build-menu';
import { useQuoteMarks, ACTIVE_CLASSES, segmentsRect } from './use-quote-marks';
import { useDocComments } from '../../state/doc-comments-store';

// Hover-card open delay + a short close delay: a highlight answering on the
// first pixel of hover would fire constantly while reading/scanning text;
// the close delay only bridges the gap between the segments of a highlight
// that wraps across lines, so the card doesn't blink moving along it.
const HOVER_OPEN_MS = 300;
const HOVER_CLOSE_MS = 120;
// A selection under this length isn't worth popping a menu over (item 1).
const MIN_SELECTION_CHARS = 2;

type SelectionMenu = { x: number; y: number; entries: MenuEntry[] };

/** The selection's END, for anchoring — the last of its (possibly
 *  multi-line) client rects, not the bounding box of the whole selection. */
function lastRectOf(range: Range): DOMRect {
  const rects = range.getClientRects();
  return rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
}

interface Props {
  containerRef: React.RefObject<HTMLElement | null>;
  path: string;
  onOpenComments: (commentId?: string) => void;
}

export function ReadingHighlights({ containerRef, path, onOpenComments }: Props) {
  // WHY no `addComment` here: a new comment now always comes from
  // buildContextMenu's "Add comment" entry (selection-release menu OR the
  // real right-click menu), which writes straight to the store itself — see
  // build-menu.ts's own WHY. This component only reads/positions the result.
  const { comments, focusId, showResolved, setCommentText, removeComment, clearFocus } = useDocComments(path);
  const visible = useMemo(() => comments.filter((c) => showResolved || !c.resolved), [comments, showResolved]);
  const marks = useQuoteMarks(containerRef, visible);

  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [cardRect, setCardRect] = useState<DOMRect | null>(null);
  const draftComment = visible.find((c) => c.id === focusId) ?? null;
  // The draft being composed always wins the "active" (marked) look while
  // its popup is open (item 2: "keep the selected span visibly marked").
  const activeId = draftComment?.id ?? hoveredId;
  const activeComment = !draftComment ? (visible.find((c) => c.id === activeId) ?? null) : null;

  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const clearOpenTimer = () => { if (openTimerRef.current) { window.clearTimeout(openTimerRef.current); openTimerRef.current = null; } };
  const clearCloseTimer = () => { if (closeTimerRef.current) { window.clearTimeout(closeTimerRef.current); closeTimerRef.current = null; } };
  const scheduleClose = () => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => setHoveredId(null), HOVER_CLOSE_MS);
  };

  // Hover/click wiring on marks — mirrors CommentsMargin's own linking so
  // the SAME highlight behaves identically regardless of which mode last
  // touched it (a resolved-state class comes from use-quote-marks either way).
  useEffect(() => {
    const offs: Array<() => void> = [];
    // A quote spanning several text nodes has several <mark> segments —
    // every one of them must open the same card (see use-quote-marks.ts).
    for (const [id, segs] of marks) for (const mark of segs) {
      const enter = () => {
        clearCloseTimer();
        clearOpenTimer();
        openTimerRef.current = window.setTimeout(() => {
          setHoveredId(id);
          setCardRect(segmentsRect(segs));
        }, HOVER_OPEN_MS);
      };
      const leave = () => {
        clearOpenTimer();
        scheduleClose();
      };
      // Round 9 (Destin: "clicking the highlighted area should default to
      // opening the comments pane"): a click goes straight to Comments mode,
      // focused on this thread; the hover card is dismissed on the way.
      const click = () => {
        clearOpenTimer();
        clearCloseTimer();
        setHoveredId(null);
        onOpenComments(id);
      };
      mark.addEventListener('mouseenter', enter);
      mark.addEventListener('mouseleave', leave);
      mark.addEventListener('click', click);
      offs.push(() => {
        mark.removeEventListener('mouseenter', enter);
        mark.removeEventListener('mouseleave', leave);
        mark.removeEventListener('click', click);
      });
    }
    return () => {
      offs.forEach((off) => off());
      clearOpenTimer();
      clearCloseTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onOpenComments is the host's stable callback; marks is the real trigger
  }, [marks]);

  useEffect(() => {
    for (const [id, segs] of marks) for (const mark of segs) {
      ACTIVE_CLASSES.forEach((cls) => mark.classList.toggle(cls, id === activeId));
    }
  }, [marks, activeId]);

  // A sent pill's click ("Ask about this" / a batched comment) jumps back to
  // its thread — the same as clicking the highlight: Comments mode, focused
  // on it. A no-op unless this exact file is open (compose-ref.ts's
  // dispatchJumpToRef: there is no cross-file navigation here).
  useEffect(() => {
    const listener = (e: Event) => {
      const commentId = (e as CustomEvent<{ commentId?: string }>).detail?.commentId;
      if (!commentId) return;
      if (!marks.has(commentId)) return;
      onOpenComments(commentId);
    };
    window.addEventListener('youcoded:jump-to-ref', listener);
    return () => window.removeEventListener('youcoded:jump-to-ref', listener);
  }, [marks, onOpenComments]);

  // ── Selection → the SAME right-click menu (item 1) ──────────────────────
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenu | null>(null);
  // The anchor for a fresh draft's popover — captured once, from the
  // selection that made it (either this menu's own "Add comment", or the
  // real right-click menu elsewhere on the same selection).
  const [draftAnchor, setDraftAnchor] = useState<DOMRect | null>(null);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    // Only act on a mouseup that STARTED inside this viewer — never open
    // over a drag that began elsewhere and happened to end here.
    let downInside = false;
    const onMouseDown = (e: MouseEvent) => { downInside = root.contains(e.target as Node); };
    const onMouseUp = (e: MouseEvent) => {
      if (!downInside) return;
      downInside = false;
      // A microtask, not a synchronous read: mouseup does not guarantee the
      // engine has finished collapsing/extending the selection yet (a
      // double-click's word-select in particular) — reading one tick later
      // is what every native selection UI does before acting on it.
      queueMicrotask(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !root.contains(sel.anchorNode)) return;
        if (sel.toString().trim().length < MIN_SELECTION_CHARS) return; // trivially small
        const entries = buildContextMenu(root);
        if (!entries) return;
        const rect = lastRectOf(sel.getRangeAt(0));
        setSelectionMenu({ x: rect.right, y: rect.bottom + 4, entries });
      });
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [containerRef]);

  // Extending/collapsing the selection (shift+arrow, or a plain click that
  // clears it) answers a selection that no longer exists — close it, same
  // as ContextMenu's own Esc/click-away/scroll dismissal.
  useEffect(() => {
    if (!selectionMenu) return;
    const onSelChange = () => setSelectionMenu(null);
    document.addEventListener('selectionchange', onSelChange);
    return () => document.removeEventListener('selectionchange', onSelChange);
  }, [selectionMenu]);

  // The new-comment popover anchors to the selection's END — captured once
  // when a fresh draft (focusId) appears, whichever menu made it.
  useEffect(() => {
    if (!focusId) return;
    const sel = window.getSelection();
    const rect = sel && sel.rangeCount > 0 && !sel.isCollapsed
      ? lastRectOf(sel.getRangeAt(0))
      : containerRef.current?.getBoundingClientRect() ?? null;
    setDraftAnchor(rect);
  }, [focusId, containerRef]);

  return (
    <>
      {selectionMenu && (
        <ContextMenu
          x={selectionMenu.x}
          y={selectionMenu.y}
          entries={selectionMenu.entries}
          onClose={() => setSelectionMenu(null)}
        />
      )}
      {activeComment && cardRect && (
        <HighlightHoverCard
          comment={activeComment}
          anchorRect={cardRect}
          boundsEl={containerRef.current}
        />
      )}
      {draftComment && draftAnchor && (
        <NewCommentPopover
          comment={draftComment}
          anchorRect={draftAnchor}
          boundsEl={containerRef.current}
          onTextChange={(t) => setCommentText(draftComment.id, t)}
          onDone={clearFocus}
          onCancel={() => removeComment(draftComment.id)}
        />
      )}
    </>
  );
}
