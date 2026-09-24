// ReadingHighlights — Reading mode's entire comments surface (Destin, round
// 2): "the comment primarily be seen as highlighted text, with the comment
// displaying on hover… clicking a highlight pins the same card." No margin,
// no markers — the document stays full width (MarkdownView renders this
// INSTEAD of CommentsMargin when mode==='reading'). Owns:
//   - hover/pin/click on existing highlights → HighlightHoverCard
//   - select text → SelectionCommentButton → NewCommentPopover
// "Open in comments" and the header toggle (ActiveArtifactView) are the only
// way into the rich margin (Comments mode) — reply/resolve/edit/delete never
// happen here, on purpose (brief: "kinda be a distinct mode").
import { useEffect, useMemo, useRef, useState } from 'react';
import { HighlightHoverCard } from './HighlightHoverCard';
import { SelectionCommentButton } from './SelectionCommentButton';
import { NewCommentPopover } from './NewCommentPopover';
import { useQuoteMarks, ACTIVE_CLASSES } from './use-quote-marks';
import { useDocComments, basenameOf } from '../../state/doc-comments-store';

const CARD_W = 256; // HighlightHoverCard / NewCommentPopover width (w-64)
const CARD_MAX_H = 220; // generous estimate for clamping — both cards cap their own text

/** Keeps a fixed-position card on screen — same idea as the composer's
 *  popovers, just working from a raw viewport rect instead of an anchor
 *  element. */
function clampedStyle(rect: DOMRect): React.CSSProperties {
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - CARD_W - 8);
  const top = rect.bottom + 8 + CARD_MAX_H > window.innerHeight
    ? Math.max(8, rect.top - CARD_MAX_H - 8)
    : rect.bottom + 8;
  return { left, top };
}

interface Props {
  containerRef: React.RefObject<HTMLElement | null>;
  path: string;
  onOpenComments: (commentId?: string) => void;
}

export function ReadingHighlights({ containerRef, path, onOpenComments }: Props) {
  const { comments, focusId, showResolved, setCommentText, addComment, removeComment, clearFocus } = useDocComments(path);
  const visible = useMemo(() => comments.filter((c) => showResolved || !c.resolved), [comments, showResolved]);
  const marks = useQuoteMarks(containerRef, visible);

  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [cardRect, setCardRect] = useState<DOMRect | null>(null);
  const activeId = pinnedId ?? hoveredId;
  const activeComment = visible.find((c) => c.id === activeId) ?? null;

  // Hover/click wiring on marks — mirrors CommentsMargin's own linking so
  // the SAME highlight behaves identically regardless of which mode last
  // touched it (a resolved-state class comes from use-quote-marks either way).
  useEffect(() => {
    const offs: Array<() => void> = [];
    for (const [id, mark] of marks) {
      const enter = () => { setHoveredId(id); setCardRect(mark.getBoundingClientRect()); };
      const leave = () => setHoveredId((cur) => (cur === id ? null : cur));
      const click = () => {
        setCardRect(mark.getBoundingClientRect());
        setPinnedId((cur) => (cur === id ? null : id));
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
    return () => offs.forEach((off) => off());
  }, [marks]);

  useEffect(() => {
    for (const [id, mark] of marks) {
      ACTIVE_CLASSES.forEach((cls) => mark.classList.toggle(cls, id === activeId));
    }
  }, [marks, activeId]);

  // A sent pill's click ("Ask about this" / a batched comment) jumps back to
  // its highlight and pins the hover card — a no-op unless this exact file
  // happens to be open (compose-ref.ts's dispatchJumpToRef: "there is no
  // cross-file navigation here, only a scroll+flash of an already-open match").
  useEffect(() => {
    const listener = (e: Event) => {
      const commentId = (e as CustomEvent<{ commentId?: string }>).detail?.commentId;
      if (!commentId) return;
      const mark = marks.get(commentId);
      if (!mark) return;
      mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setCardRect(mark.getBoundingClientRect());
      setPinnedId(commentId);
    };
    window.addEventListener('youcoded:jump-to-ref', listener);
    return () => window.removeEventListener('youcoded:jump-to-ref', listener);
  }, [marks]);

  // Esc unpins a clicked (not just hovered) card.
  useEffect(() => {
    if (!pinnedId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPinnedId(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinnedId]);

  // Selection tracking for the floating "Comment" button — only within THIS
  // file's own content column, so a selection in the chat or another pane
  // never spawns a button here.
  const [selection, setSelection] = useState<{ text: string; rect: DOMRect } | null>(null);
  useEffect(() => {
    const onSelectionChange = () => {
      const root = containerRef.current;
      const sel = window.getSelection();
      if (!root || !sel || sel.isCollapsed || sel.rangeCount === 0 || !root.contains(sel.anchorNode)) {
        setSelection(null);
        return;
      }
      const text = sel.toString().trim();
      if (!text) { setSelection(null); return; }
      setSelection({ text, rect: sel.getRangeAt(0).getBoundingClientRect() });
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [containerRef]);

  // The new-comment popover anchors to the selection that made it, captured
  // once when a fresh draft (focusId) appears — a right-click "Add comment"
  // reaches the SAME store call as the floating button, so this covers both
  // entry points without the button needing to know about the menu.
  const draftAnchorRef = useRef<DOMRect | null>(null);
  const [draftAnchor, setDraftAnchor] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!focusId) return;
    const sel = window.getSelection();
    const rect = sel && sel.rangeCount > 0 && !sel.isCollapsed
      ? sel.getRangeAt(0).getBoundingClientRect()
      : containerRef.current?.getBoundingClientRect() ?? null;
    draftAnchorRef.current = rect;
    setDraftAnchor(rect);
  }, [focusId, containerRef]);

  const draftComment = visible.find((c) => c.id === focusId) ?? null;

  const startComment = () => {
    if (!selection) return;
    addComment(selection.text, basenameOf(path));
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  };

  return (
    <>
      {selection && !draftComment && (
        <SelectionCommentButton rect={selection.rect} onClick={startComment} />
      )}
      {activeComment && cardRect && !draftComment && (
        <HighlightHoverCard
          comment={activeComment}
          style={clampedStyle(cardRect)}
          onOpenComments={() => { setPinnedId(null); onOpenComments(activeComment.id); }}
        />
      )}
      {draftComment && draftAnchor && (
        <NewCommentPopover
          comment={draftComment}
          style={clampedStyle(draftAnchor)}
          onTextChange={(t) => setCommentText(draftComment.id, t)}
          onDone={clearFocus}
          onCancel={() => removeComment(draftComment.id)}
        />
      )}
    </>
  );
}
