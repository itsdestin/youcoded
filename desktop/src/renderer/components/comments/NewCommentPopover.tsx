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
// branch of the tree, sitting above it in z-order. Rather than plumb a
// "something is open" signal all the way up to SessionDrawer to hide the
// FAB, this shrinks the bounds it places INTO: `boundsHost` below reports a
// rect whose bottom is pulled up by the FAB's reserved footprint, so
// placeBubble's own clamp/flip treats that band as already outside the
// panel — the popup either sits higher or flips above, but never over it.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Textarea } from '../ui/Textarea';
import { Button } from '../ui/Button';
import { OverlayPanel, POPOVER_Z } from '../overlays/Overlay';
import { placeBubble } from '../ui/anchor-position';
import type { DocComment } from '../../state/doc-comments-store';

const GAP = 6;
// The Edit FAB sits `bottom-9` (36px) with ~44px of button height above
// that — 90px clears its full footprint plus a small gap, without needing
// its actual DOM rect (a different component tree, per the file's own WHY).
const FAB_RESERVED_BOTTOM = 90;

interface Props {
  comment: DocComment;
  /** Viewport rect of the selection that started this draft — the anchor. */
  anchorRect: DOMRect;
  /** The viewer's own content area — clamped inside it, never the header
   *  row above or the window. */
  boundsEl: HTMLElement | null;
  onTextChange: (text: string) => void;
  /** Non-empty text: keep the comment. Empty: delete the never-really-made draft. */
  onDone: () => void;
  onCancel: () => void;
}

export function NewCommentPopover({ comment, anchorRect, boundsEl, onTextChange, onDone, onCancel }: Props) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchorRect.left, top: anchorRect.bottom + GAP });

  // A duck-typed "host" (placeBubble/boundsFor only ever call
  // getBoundingClientRect on it — see anchor-position.ts) reporting the
  // viewer's content rect with FAB_RESERVED_BOTTOM already carved off the
  // bottom, so the FAB's corner is never inside the box the popup is
  // allowed to occupy.
  const boundsHost = useMemo(() => {
    if (!boundsEl) return null;
    return {
      getBoundingClientRect: () => {
        // DOMRect's left/top/right/bottom/width/height are PROTOTYPE
        // getters, not own properties — `{...r}` silently drops every one
        // of them. Read each explicitly instead.
        const r = boundsEl.getBoundingClientRect();
        const height = Math.max(0, r.height - FAB_RESERVED_BOTTOM);
        return {
          x: r.x, y: r.y, width: r.width, height,
          top: r.top, left: r.left, right: r.right, bottom: r.top + height,
          toJSON: () => ({}),
        } as DOMRect;
      },
    } as unknown as HTMLElement;
  }, [boundsEl]);

  useLayoutEffect(() => {
    const trigger = { getBoundingClientRect: () => anchorRect } as unknown as HTMLElement;
    const { left, top } = placeBubble(
      trigger,
      panelRef.current,
      { placement: 'bottom', align: 'start', gapBelow: GAP, gapAbove: GAP },
      boundsHost,
    );
    setPos({ left, top });
  }, [comment.id, anchorRect, boundsHost]);

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

  return (
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
      <p className="text-fg-muted italic line-clamp-2 mb-1.5 border-l-2 border-edge-dim pl-2">
        {comment.cell ? `Cell ${comment.cell}` : <>&ldquo;{comment.quote}&rdquo;</>}
      </p>
      <Textarea
        ref={textRef}
        size="sm"
        rows={3}
        value={comment.text}
        placeholder="Add a comment…"
        // artifact-edit-textarea: right-click here gets real cut/copy/paste
        // (build-menu.ts) — Electron ships no default context menu.
        className="artifact-edit-textarea w-full"
        onChange={(e) => onTextChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onDone();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="mt-1.5 flex items-center justify-end gap-1.5">
        {/* onMouseDown preventDefault: keeps focus (and the click-away
            listener's target check) on the textarea/panel rather than
            racing a blur against these buttons' own click. */}
        <Button variant="secondary" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={onDone}>
          Comment
        </Button>
      </div>
    </OverlayPanel>
  );
}
