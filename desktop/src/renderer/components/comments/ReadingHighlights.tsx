// ReadingHighlights — Reading mode's entire comments surface (Destin, round
// 2): "the comment primarily be seen as highlighted text, with the comment
// displaying on hover… clicking a highlight pins the same card." No margin,
// no markers — the document stays full width (MarkdownView renders this
// INSTEAD of CommentsMargin when mode==='reading'). Owns:
//   - hover/pin/click on existing highlights → HighlightHoverCard
//   - select text, release it → the SAME right-click menu build-menu.ts
//     builds for this viewer (Add comment / Ask about this / Copy / Select
//     all), anchored at the selection's end → NewCommentPopover
// Clicking a highlight or the floating Comments button opens the rich pane
// (Comments mode). Replying is the one action also offered here, inside the
// hover card (Destin, 2026-09-24); resolve/edit/delete stay in Comments mode
// (brief: "kinda be a distinct mode").
//
// Round 3 (polish pass): the old separate floating "Comment" button
// (SelectionCommentButton, now deleted) looked nothing like the right-click
// menu it duplicated — releasing a selection now opens buildContextMenu's
// OWN entries in the SAME <ContextMenu>, so the two paths can never drift
// apart again. This is scoped to the FILE VIEWER only — chat messages keep
// right-click only (auto-popping a menu while reading chat would be noisy).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
// 250ms (was 120): the card is now something you move ONTO to reply
// (Destin, 2026-09-24), so the close delay must also cover the trip across
// the 8px gap between the highlight and the card.
const HOVER_CLOSE_MS = 250;
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
  /** Pop the right-click menu when a text selection is released. Off for
   *  spreadsheets, whose cells are commented by right-clicking the cell. */
  selectionMenu?: boolean;
}

// Touch (Destin, questions deck Q-3: phone support now, "tap opens the
// list"): a phone has no hover, so the hover card never opens from a touch —
// a tap goes straight to the comment, like a click. Tracked per pointerdown
// because one device can have both (a touchscreen laptop).
let lastPointerWasTouch = false;
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => { lastPointerWasTouch = e.pointerType === 'touch'; }, true);
}
// After a long-press selection settles on a touchscreen there is no mouseup
// to act on — the menu opens once the selection has stopped changing.
const TOUCH_SELECTION_SETTLE_MS = 500;

export function ReadingHighlights({ containerRef, path, onOpenComments, selectionMenu: selectionMenuOn = true }: Props) {
  // WHY no `addComment` here: a new comment now always comes from
  // buildContextMenu's "Add comment" entry (selection-release menu OR the
  // real right-click menu), which writes straight to the store itself — see
  // build-menu.ts's own WHY. This component only reads/positions the result.
  const { comments, focusId, showResolved, setCommentText, addReply, resolveComment, reopenComment, removeComment, clearFocus } = useDocComments(path);
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
  // While a reply is being typed in the hover card, drifting the pointer
  // away must not throw the half-written reply away — the card then closes
  // only on Esc or a click outside it (effect below).
  const engagedRef = useRef(false);
  const [engaged, setEngaged] = useState(false);
  const onEngagedChange = useCallback((v: boolean) => { engagedRef.current = v; setEngaged(v); }, []);
  const scheduleClose = () => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      if (!engagedRef.current) setHoveredId(null);
    }, HOVER_CLOSE_MS);
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
        if (lastPointerWasTouch) return; // no hover card on touch (see above)
        // Mid-reply, hovering another highlight must not swap the card out
        // from under the half-written text.
        if (engagedRef.current) return;
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

  // An engaged card (reply being typed) closes on Esc or a click outside it,
  // like every other popover — never on pointer drift.
  useEffect(() => {
    if (!engaged) return;
    const close = () => { onEngagedChange(false); setHoveredId(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.('[data-hover-card]')) close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [engaged, onEngagedChange]);

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
    if (!root || !selectionMenuOn) return;
    const openForSelection = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !root.contains(sel.anchorNode)) return;
      if (sel.toString().trim().length < MIN_SELECTION_CHARS) return; // trivially small
      const entries = buildContextMenu(root);
      if (!entries) return;
      const rect = lastRectOf(sel.getRangeAt(0));
      setSelectionMenu({ x: rect.right, y: rect.bottom + 4, entries });
    };
    // Touch: wait for the long-press selection (and any handle drags) to
    // settle, then open the same menu.
    let settleTimer: number | null = null;
    const onSelectionChange = () => {
      if (!lastPointerWasTouch) return;
      if (settleTimer) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        // A long-press can ALSO fire `contextmenu`, which ContextMenuHost
        // answers with this same menu — never stack a second copy on it.
        if (document.querySelector('[role="menu"]')) return;
        openForSelection();
      }, TOUCH_SELECTION_SETTLE_MS);
    };
    document.addEventListener('selectionchange', onSelectionChange);
    // Only act on a mouseup that STARTED inside this viewer — never open
    // over a drag that began elsewhere and happened to end here.
    let downInside = false;
    // Left button only: a right-click's mouseup would otherwise pop this
    // menu AND the real right-click menu at once (Destin, 2026-09-24:
    // "we should not allow the right click menu to open a second version of
    // the same menu").
    const onMouseDown = (e: MouseEvent) => { downInside = e.button === 0 && root.contains(e.target as Node); };
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 0 || !downInside) return;
      downInside = false;
      // A microtask, not a synchronous read: mouseup does not guarantee the
      // engine has finished collapsing/extending the selection yet (a
      // double-click's word-select in particular) — reading one tick later
      // is what every native selection UI does before acting on it.
      queueMicrotask(openForSelection);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      if (settleTimer) window.clearTimeout(settleTimer);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [containerRef, selectionMenuOn]);

  // Extending/collapsing the selection (shift+arrow, or a plain click that
  // clears it) answers a selection that no longer exists — close it, same
  // as ContextMenu's own Esc/click-away/scroll dismissal.
  // A right-click while the auto menu is up REPLACES it: the right-click
  // menu (ContextMenuHost) opens at the pointer with the same entries, so the
  // auto copy closes — only one menu is ever on screen.
  useEffect(() => {
    if (!selectionMenu) return;
    const onContextMenu = () => setSelectionMenu(null);
    document.addEventListener('contextmenu', onContextMenu, true);
    return () => document.removeEventListener('contextmenu', onContextMenu, true);
  }, [selectionMenu]);

  useEffect(() => {
    if (!selectionMenu) return;
    // On touch the selection keeps changing while handles are dragged; the
    // settle timer above reopens the menu for the final selection.
    const onSelChange = () => setSelectionMenu(null);
    document.addEventListener('selectionchange', onSelChange);
    return () => document.removeEventListener('selectionchange', onSelChange);
  }, [selectionMenu]);

  // The new-comment popover anchors to the selection's END — captured once
  // when a fresh draft (focusId) appears, whichever menu made it.
  useEffect(() => {
    if (!focusId) return;
    // A cell comment (spreadsheets) anchors to its cell — there is no text
    // selection behind it, the cell was right-clicked.
    const cell = comments.find((c) => c.id === focusId)?.cell;
    const cellEl = cell ? containerRef.current?.querySelector(`[data-cell="${cell}"]`) : null;
    if (cellEl) { setDraftAnchor(cellEl.getBoundingClientRect()); return; }
    const sel = window.getSelection();
    const rect = sel && sel.rangeCount > 0 && !sel.isCollapsed
      ? lastRectOf(sel.getRangeAt(0))
      : containerRef.current?.getBoundingClientRect() ?? null;
    setDraftAnchor(rect);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per new draft (focusId); comments is looked up, not a trigger
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
          onPointerEnter={clearCloseTimer}
          onPointerLeave={scheduleClose}
          onEngagedChange={onEngagedChange}
          onReply={(t) => addReply(activeComment.id, 'user', t)}
          // Resolving hides the comment (unless Show Resolved is on), which
          // unmounts the card without a blur — so release the "typing a
          // reply" hold here, or later hovers would stay blocked.
          onResolve={() => { resolveComment(activeComment.id, 'user'); onEngagedChange(false); setHoveredId(null); }}
          onReopen={() => reopenComment(activeComment.id)}
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
