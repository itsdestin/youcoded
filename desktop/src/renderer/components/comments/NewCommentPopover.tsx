// NewCommentPopover — Reading mode's "add a comment" flow (Destin, round 2):
// select text → a small popup box right at the selection; Enter saves,
// Shift+Enter newline, Esc cancels. Comments mode still uses the margin
// card's own inline textarea (autoFocus on the just-added draft) — this
// popover exists because Reading mode has no margin to hold that box.
//
// Round 3 (polish pass): positioning moved onto anchor-position.ts's
// placeBubble (same arithmetic AnchorTip/Tooltip use) instead of a
// hand-rolled clamp that was landing the popup over the viewer's HEADER row
// and clipping it — `boundsEl` is the viewer's own content area, never the
// window, so it can't happen again. Cancel/Comment buttons replace the old
// blur-to-commit: with real buttons on screen, a silent commit-on-blur would
// double-fire (blur, then the button's own click).
//
// Coordinator review, round 3: the popup could still land ON TOP of the
// floating Edit FAB (SessionDrawer.tsx, `bottom-9 right-4`) — a different
// branch of the tree, sitting above it in z-order. `reserveBottom` keeps that
// band at the bottom of the visible panel out of bounds, so the popup either
// sits higher or flips above, never over it.
//
// Comment-box fix (2026-11-22, Destin: "comment boxes sometimes show up in
// weird places, like the bottom left"): the anchor is no longer a rect frozen
// at the moment the comment was made. The caller passes `getAnchor`, read
// LIVE — at open, whenever the caller's anchor changes, and on every scroll or
// resize — so the box follows its words. Before, it was captured from the text
// selection, which adding the comment often destroys (drawing the highlight
// splits the selected text; a Word file redraws its text), and the fallback
// was the whole document's rect: the bottom-left corner.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ErrorState } from '../ui/states';
import { OverlayPanel, POPOVER_Z } from '../overlays/Overlay';
import { placeBubble, visibleRectOf } from '../ui/anchor-position';
import type { DocComment } from '../../state/doc-comments-store';
import { CommentComposer } from './CommentComposer';

const GAP = 6;
// The Edit FAB sits `bottom-9` (36px) with ~44px of button height above
// that — 90px clears its full footprint plus a small gap, without needing
// its actual DOM rect (a different component tree, per the file's own WHY).
const FAB_RESERVED_BOTTOM = 90;

interface Props {
  comment: DocComment;
  /** Where the words this comment is about are right now (viewport rect), or
   *  null while they are not drawn — read live, see the file's WHY. */
  getAnchor: () => DOMRect | null;
  /** The viewer's own content area — the box stays inside the VISIBLE part
   *  of it, never the header row above or the window. */
  boundsEl: HTMLElement | null;
  onTextChange: (text: string) => void;
  /** Non-empty text: keep the comment. Empty: delete the never-really-made draft. */
  onDone: () => void;
  onCancel: () => void;
}

export function NewCommentPopover({ comment, getAnchor, boundsEl, onTextChange, onDone, onCancel }: Props) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  // The last real anchor: while the words are briefly not drawn (a Word file
  // redrawing its text), the box stays where it was instead of jumping.
  const lastAnchorRef = useRef<DOMRect | null>(null);

  const place = useCallback(() => {
    const live = getAnchor();
    if (live) lastAnchorRef.current = live;
    // Nothing to point at yet: the top-left of the visible panel — never the
    // whole document's rect (that was the bottom-left-corner bug).
    const rect = live ?? lastAnchorRef.current
      ?? (boundsEl ? (() => { const v = visibleRectOf(boundsEl); return new DOMRect(v.left, v.top, 0, 0); })() : new DOMRect());
    const trigger = { getBoundingClientRect: () => rect } as unknown as HTMLElement;
    const next = placeBubble(
      trigger,
      panelRef.current,
      { placement: 'bottom', align: 'start', gapBelow: GAP, gapAbove: GAP, reserveBottom: FAB_RESERVED_BOTTOM },
      boundsEl,
    );
    setPos((p) => (p.left === next.left && p.top === next.top ? p : next));
  }, [getAnchor, boundsEl]);

  useLayoutEffect(() => { place(); }, [place, comment.id]);

  // Follow the words while the page scrolls or the window resizes — one
  // placement per frame at most (performance.md rule 6). Capture phase: the
  // viewer's own scroller does not bubble its scroll events to window.
  useEffect(() => {
    let frame = 0;
    const onMove = (e: Event) => {
      // Only scrolls that can move the words (the viewer's own scroller or
      // one around it) — never the chat, a terminal or this box's own text.
      const t = e.target;
      if (e.type === 'scroll' && boundsEl && t instanceof Node && t !== document && !t.contains(boundsEl)) return;
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; place(); });
    };
    window.addEventListener('scroll', onMove, { capture: true, passive: true });
    window.addEventListener('resize', onMove);
    // WHY also watch the file's own size (2026-11-27): its text can re-wrap
    // with no scroll or window resize — the app's font finishing loading,
    // dragging the file panel's divider, a picture in the file loading — and
    // the words then moved ~100 px while the box stayed on top of them. Any
    // such re-wrap changes the content element's size, so this catches it.
    // Same one-placement-per-frame guard as scrolling.
    const ro = boundsEl && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => onMove(new Event('reflow'))) : null;
    if (ro && boundsEl) ro.observe(boundsEl);
    return () => {
      ro?.disconnect();
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onMove, { capture: true });
      window.removeEventListener('resize', onMove);
    };
  }, [place, boundsEl]);

  useEffect(() => { textRef.current?.focus(); }, []);

  // Click-away commit (Docs-style): a non-empty note is kept, a
  // never-really-made one is dropped — same rule Esc carries explicitly.
  // Buttons below stop their own mousedown so this never races them.
  useEffect(() => {
    const onDown = (e: Event) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      if (comment.text.trim()) onDone(); else onCancel();
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, [comment.text, onDone, onCancel]);

  // WHY portal: the file pane's glass and scroll masks are backdrop roots. A popup
  // inside them cannot frost the content behind the pane, and may be clipped by its fade.
  // Keep the shared theme-controlled surface and the viewer-bound positioning above.
  return createPortal(
    // Round 7: shared popup surface, same as the right-click menu (see
    // HighlightHoverCard); p-3 = the guide's 12px card padding.
    <OverlayPanel
      ref={panelRef}
      layer={4}
      className="fixed w-64 p-3 text-xs"
      style={{ zIndex: POPOVER_Z, left: pos.left, top: pos.top, borderRadius: 'var(--radius-lg)' }}
    >
      {/* A cell comment names its cell ("Cell C6"): the value alone ("88")
          would not say which of many identical-looking numbers it is. */}
      {/* 2026-09-28 (Destin: "fix the gross thumbnail styling of the quote
          text"): one quiet line — no italic, no bar down the side — just
          enough to say which words this note is about. */}
      <p className="text-2xs text-fg-muted truncate mb-1.5">
        {comment.cell ? `Cell ${comment.cell}${comment.sheet ? ` on ${comment.sheet}` : ''}` : <>&ldquo;{comment.quote}&rdquo;</>}
      </p>
      {/* Same send control as ReplyField/CommentCard's draft box (the round
          arrow inside the field) instead of Cancel/Comment buttons below it
          — Destin, 2026-09-28. Enter still posts, Escape still discards,
          and the window-level mousedown listener above still commits a
          non-empty note or drops an empty one on click-away; only the
          on-screen buttons are gone. */}
      <CommentComposer
        textRef={textRef}
        value={comment.text}
        onChange={onTextChange}
        onSubmit={onDone}
        onEscape={onCancel}
        placeholder="Add a comment…"
        ariaLabel="New comment"
        sendLabel="Post comment"
        keepFocusOnSend
      />
      {/* F7 fix (T5 review): a failed `docComments:add` now keeps the draft
          open (doc-comments-store.ts's `persistNewComment`) with the real,
          typed cause here — error-message-standards.md's "specific and
          accurate" branch, Retry replaying the exact same call — instead of
          silently discarding the note or routing it to a global toast. */}
      {comment.error && (
        <ErrorState className="mt-1.5" message={comment.error.message} onRetry={comment.error.onRetry} />
      )}
    </OverlayPanel>,
    document.body,
  );
}
