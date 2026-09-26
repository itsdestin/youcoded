// CommentsMargin — the right-hand rail that holds comment cards, each
// vertically aligned to its highlighted span (Docs/Word "Margin" style).
// Renders INSIDE the same scrolling container as the document text (a flex
// row sibling of the content column — see MarkdownView.tsx), so the margin
// scrolls together with the document for free, with no scroll-position code
// of our own. Below the narrow-viewport breakpoint it collapses to small
// markers that open a popover instead (narrow-viewport.md: "collapse into a
// menu/popover, never just hide a control").
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CommentCard } from './CommentCard';
import { CheckIcon } from '../Icons';
import { Scrim, OverlayPanel } from '../overlays/Overlay';
import { CloseButton } from '../ui/CloseButton';
import { EmptyState } from '../ui/states';
import { Button } from '../ui/Button';
import { readPaneVariant } from './pane-variant';
import { CommentsPaneFrame } from './CommentsPaneFrame';
import { revealSheet } from './sheet-reveal';
import { useDocComments, type DocComment } from '../../state/doc-comments-store';
// Round 2: mark-wrapping moved to a shared hook — ReadingHighlights (Reading
// mode) needs the identical highlight, and the two modes are mutually
// exclusive so sharing costs nothing (see use-quote-marks.ts's own WHY).
import { useQuoteMarks, ACTIVE_CLASSES } from './use-quote-marks';

const GAP_PX = 10;
// Fixed estimates rather than a measure-then-reflow pass: comment counts here
// are small (a handful per file, never a "list of the user's things" that
// renderer-lists.md governs), so an exact per-card height isn't worth a
// second render pass — an approximate stack that never overlaps is enough.
const OPEN_CARD_H = 150;
const REPLY_H = 46;
const RESOLVED_CARD_H = 46;
// Narrow mode's markers are 24px dots (see the `narrow` branch below), not
// cards — collision-avoidance stacking using the WIDE card heights here was
// spacing two 24px dots 150+px apart, pushing the second marker off the
// bottom of a short document entirely (found reviewing this mockup's own
// screenshots).
const MARKER_H = 28;

function estimateHeight(c: DocComment, narrow: boolean): number {
  if (narrow) return MARKER_H;
  return c.resolved ? RESOLVED_CARD_H : OPEN_CARD_H + c.replies.length * REPLY_H;
}

/** Each mark's offset from the top of the margin column — both columns are
 *  normal-flow children of the SAME scrolling ancestor, so plain
 *  getBoundingClientRect deltas stay correct at any scroll position without
 *  a scroll listener of our own. */
function useAnchorTops(
  marks: Map<string, HTMLElement[]>,
  marginRef: React.RefObject<HTMLElement | null>,
  containerRef: React.RefObject<HTMLElement | null>,
): Map<string, number> {
  const [tops, setTops] = useState<Map<string, number>>(new Map());
  useLayoutEffect(() => {
    const col = marginRef.current;
    if (!col) return;
    const measure = () => {
      const colTop = col.getBoundingClientRect().top;
      const next = new Map<string, number>();
      for (const [id, segs] of marks) {
        // Not clamped at 0: a spreadsheet's grid scrolls INSIDE the content
        // (CommentableDocument `fill`), so a commented cell scrolled above
        // the view has a negative top — the rail's overflow-hidden clips its
        // marker instead of piling it at the top of the rail.
        next.set(id, segs[0].getBoundingClientRect().top - colTop);
      }
      setTops(next);
    };
    measure();
    // WHY observe the CONTENT column, not (only) the margin: the narrow/wide
    // switch (use-container-narrow.ts) resolves over SEVERAL frames of its
    // own (ref-availability retry, then an async ResizeObserver callback),
    // and each width change RE-WRAPS the document's text — its height
    // changes, not the margin's (the margin's own height tracks the fixed
    // viewport row, not the document). Found reviewing this mockup's
    // screenshots: a marker's stored top was measured against a transient,
    // still-wide layout and never corrected once the page settled into its
    // final (narrower, more-wrapped) height, landing ~600px below the
    // highlight it belonged to. A height change on the content column is
    // exactly "the document reflowed" — re-measure whenever it fires.
    const target = containerRef.current ?? col;
    const ro = new ResizeObserver(measure);
    ro.observe(target);
    // A scroller INSIDE the content (the spreadsheet grid) moves cells without
    // resizing anything; scroll doesn't bubble, so listen in the capture phase.
    target.addEventListener('scroll', measure, { capture: true, passive: true });
    return () => {
      ro.disconnect();
      target.removeEventListener('scroll', measure, { capture: true });
    };
  }, [marks, marginRef, containerRef]);
  return tops;
}

function stackedTops(order: DocComment[], rawTop: Map<string, number>, narrow: boolean): Map<string, number> {
  const sorted = order.slice().sort((a, b) => (rawTop.get(a.id) ?? 0) - (rawTop.get(b.id) ?? 0));
  const out = new Map<string, number>();
  let cursor = -Infinity; // negative tops allowed — see useAnchorTops
  for (const c of sorted) {
    const top = Math.max(rawTop.get(c.id) ?? Math.max(cursor, 0), cursor);
    out.set(c.id, top);
    cursor = top + estimateHeight(c, narrow) + GAP_PX;
  }
  return out;
}

interface Props {
  containerRef: React.RefObject<HTMLElement | null>;
  path: string;
  narrow: boolean;
  /** "Open in comments" (Reading mode's hover card) asked to focus this
   *  thread — scroll/highlight it once when this changes. ActiveArtifactView
   *  already made sure it's not hidden behind "Show resolved". */
  openThreadId?: string;
}

export function CommentsMargin({ containerRef, path, narrow, openThreadId }: Props) {
  // WHY read from the shared store, not a prop: CommentsPaneFooter owns the
  // "Show resolved" toggle's UI and the header's count reads the same store,
  // so all of them share ONE boolean without threading it through
  // ActiveArtifactView.
  const { comments, focusId, showResolved, setShowResolved, setCommentText, addReply, resolveComment, reopenComment, removeComment } = useDocComments(path);
  const visible = useMemo(
    () => comments.filter((c) => showResolved || !c.resolved).sort((a, b) => a.createdAt - b.createdAt),
    [comments, showResolved],
  );
  const marginRef = useRef<HTMLDivElement>(null);
  const marks = useQuoteMarks(containerRef, visible);
  const rawTops = useAnchorTops(marks, marginRef, containerRef);
  const tops = useMemo(() => stackedTops(visible, rawTops, narrow), [visible, rawTops, narrow]);
  const [openId, setOpenId] = useState<string | null>(null);
  // activeId = whatever the pointer is on (card or highlight); selectedId =
  // the thread last clicked, which stays lit until another is picked
  // (round 13: "clicking a comment should focus the relevant highlight").
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const litId = activeId ?? selectedId;
  const cardRefs = useRef(new Map<string, HTMLDivElement>());

  const jump = (id: string) => marks.get(id)?.[0]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  // Select a thread from either side: scroll the document to its highlight
  // and the list to its card, and keep both lit.
  // A cell comment on a sheet tab that isn't showing has no mark yet: ask
  // the viewer for that tab, and finish the jump once its cell is marked.
  const pendingJumpRef = useRef<string | null>(null);
  const focusThread = (id: string) => {
    setSelectedId(id);
    const c = comments.find((x) => x.id === id);
    if (!marks.has(id) && c?.sheet) { pendingJumpRef.current = id; revealSheet(path, c.sheet); }
    jump(id);
    cardRefs.current.get(id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  useEffect(() => {
    const id = pendingJumpRef.current;
    if (id && marks.has(id)) { pendingJumpRef.current = null; jump(id); }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- jump reads marks via closure; marks is the trigger
  }, [marks]);

  useEffect(() => {
    if (!openThreadId || !marks.has(openThreadId)) return;
    focusThread(openThreadId);
    if (narrow) setOpenId(openThreadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- jump/marks read via closure; openThreadId (+ marks becoming ready) is the real trigger
  }, [openThreadId, marks, narrow]);

  // Hovering or clicking the in-document highlight scrolls/highlights its
  // card; hovering the card (below) highlights the mark back — one DOM
  // listener pair per mark, since <mark> lives outside React's tree.
  useEffect(() => {
    const offs: Array<() => void> = [];
    // Every segment of a multi-node quote links to the same card.
    for (const [id, segs] of marks) for (const mark of segs) {
      const enter = () => setActiveId(id);
      const leave = () => setActiveId((cur) => (cur === id ? null : cur));
      const click = () => focusThread(id);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- jump reads marks via closure; marks is the real dep
  }, [marks]);

  useEffect(() => {
    for (const [id, segs] of marks) for (const mark of segs) {
      ACTIVE_CLASSES.forEach((cls) => mark.classList.toggle(cls, id === litId));
    }
  }, [marks, litId]);

  // Round 13 (Destin: "i want the comments to all snap upwards/to the
  // top"): the wide column is a plain top-down list, no longer pinned beside
  // each highlight — in DOCUMENT order (the order you meet the highlights
  // reading down), comments whose text couldn't be found last.
  const ordered = useMemo(() => {
    const withMark = visible.filter((c) => marks.has(c.id));
    withMark.sort((a, b) => {
      const pos = marks.get(a.id)![0].compareDocumentPosition(marks.get(b.id)![0]);
      return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : pos & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
    });
    return [...withMark, ...visible.filter((c) => !marks.has(c.id))];
  }, [visible, marks]);

  if (narrow) {
    const openComment = visible.find((c) => c.id === openId) ?? null;
    return (
      <>
        <div ref={marginRef} className="relative w-9 shrink-0 overflow-hidden border-l border-edge bg-panel" style={{ minHeight: '100%' }}>
          {visible.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setOpenId(c.id)}
              aria-label={`${c.resolved ? 'Resolved comment' : 'Comment'}: ${c.cell ?? c.quote}`}
              className={`absolute left-1.5 coarse-hit w-6 h-6 rounded-full border flex items-center justify-center text-2xs
                ${c.resolved ? 'bg-inset border-edge-dim text-fg-muted' : 'bg-panel border-edge text-fg-2'}`}
              style={{ top: tops.get(c.id) ?? 0 }}
            >
              {c.resolved ? <CheckIcon className="w-3 h-3" /> : '💬'}
            </button>
          ))}
        </div>
        {/* Portaled to <body> (phone check, 2026-09-24): rendered in place, the
            sheet lived inside the file drawer's stacking context, so the
            composer, quick chips and status bar painted OVER it and hid the
            reply box. Same createPortal + Scrim + OverlayPanel recipe Dialog.tsx
            uses. */}
        {openComment && createPortal(
          <>
            <Scrim layer={2} onClick={() => setOpenId(null)} />
            <OverlayPanel layer={2} className="fixed inset-x-3 bottom-3 max-h-3/4 overflow-auto p-2 rounded-lg">
              <div className="flex justify-end mb-1">
                <CloseButton onClick={() => setOpenId(null)} label="Close comment" />
              </div>
              <CommentCard
                comment={openComment}
                autoFocus={openComment.id === focusId}
                onTextChange={(t) => setCommentText(openComment.id, t)}
                onReply={(t) => addReply(openComment.id, 'user', t)}
                onResolve={() => { resolveComment(openComment.id, 'user'); setOpenId(null); }}
                onReopen={() => reopenComment(openComment.id)}
                onDelete={() => { removeComment(openComment.id); setOpenId(null); }}
              />
            </OverlayPanel>
          </>,
          document.body,
        )}
      </>
    );
  }

  const variant = readPaneVariant();
  const resolvedCount = comments.filter((c) => c.resolved).length;
  const list = (
    // data-comments-list: ActiveArtifactView measures this box to line the
    // floating comment actions up with the cards, whatever the framing.
    // pb-28: room to scroll the last card up past those floating actions.
    <div data-comments-list className="flex flex-col gap-2 p-2 pb-28">
      {ordered.length === 0 && <EmptyState message="No comments on this file yet." variant="inline" />}
      {ordered.map((c) => (
        <div
          key={c.id}
          ref={(el) => { if (el) cardRefs.current.set(c.id, el); else cardRefs.current.delete(c.id); }}
          // Clicking a card's background focuses its highlight; clicks on
          // the card's own controls (reply, send, resolve) are left alone.
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('button, input, textarea')) return;
            focusThread(c.id);
          }}
          className={`rounded-lg cursor-pointer transition-shadow ${c.id === litId ? 'ring-2 ring-accent/60' : ''}`}
          onMouseEnter={() => setActiveId(c.id)}
          onMouseLeave={() => setActiveId((cur) => (cur === c.id ? null : cur))}
        >
          <CommentCard
            comment={c}
            autoFocus={c.id === focusId}
            onTextChange={(t) => setCommentText(c.id, t)}
            onReply={(t) => addReply(c.id, 'user', t)}
            onResolve={() => resolveComment(c.id, 'user')}
            onReopen={() => reopenComment(c.id)}
            onDelete={() => removeComment(c.id)}
          />
        </div>
      ))}
    </div>
  );

  // The list is its own scroller in every framing (MarkdownView renders it
  // BESIDE the document's scroller): with cards no longer tied to their
  // highlights, scrolling the document must not carry the list away.
  // data-comments-pane: the framing's outer edge, measured by
  // ActiveArtifactView so Comments/Edit clear it.
  if (variant === 'combined') {
    return <CommentsPaneFrame path={path} frameRef={marginRef}>{list}</CommentsPaneFrame>;
  }
  if (variant === 'sheet') {
    return (
      <div ref={marginRef} data-comments-pane className="w-64 shrink-0 p-2">
        <div className="h-full rounded-xl border border-edge bg-panel overflow-y-auto">{list}</div>
      </div>
    );
  }
  if (variant === 'margin') {
    return (
      <div ref={marginRef} data-comments-pane className="w-64 shrink-0 overflow-y-auto">{list}</div>
    );
  }
  if (variant === 'titled') {
    return (
      <div ref={marginRef} data-comments-pane className="w-64 shrink-0 border-l border-edge bg-panel flex flex-col">
        {/* The Session Files pane's title row (SessionDrawer.tsx): same
            padding, border and title weight; the count is G-19's
            "label + muted numeral". Show resolved moves up here, so only Ask
            Your Assistant floats at the bottom in this framing. */}
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-edge shrink-0">
          <span className="font-semibold text-sm">Comments</span>
          {resolvedCount > 0 && (
            <Button variant="ghost" size="sm" aria-pressed={showResolved} onClick={() => setShowResolved(!showResolved)}>
              {showResolved ? 'Hide resolved' : 'Show resolved'} <span className="text-fg-muted">{resolvedCount}</span>
            </Button>
          )}
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">{list}</div>
      </div>
    );
  }
  return (
    <div ref={marginRef} data-comments-pane className="w-64 shrink-0 border-l border-edge bg-panel overflow-y-auto">{list}</div>
  );
}
