// CommentsMargin — the right-hand rail that holds comment cards, each
// vertically aligned to its highlighted span (Docs/Word "Margin" style).
// Renders INSIDE the same scrolling container as the document text (a flex
// row sibling of the content column — see MarkdownView.tsx), so the margin
// scrolls together with the document for free, with no scroll-position code
// of our own. Below the narrow-viewport breakpoint it collapses to small
// markers that open a popover instead (narrow-viewport.md: "collapse into a
// menu/popover, never just hide a control").
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CommentCard } from './CommentCard';
import { CheckIcon } from '../Icons';
import { Scrim, OverlayPanel } from '../overlays/Overlay';
import { CloseButton } from '../ui/CloseButton';
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
        next.set(id, Math.max(0, segs[0].getBoundingClientRect().top - colTop));
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
    return () => ro.disconnect();
  }, [marks, marginRef, containerRef]);
  return tops;
}

function stackedTops(order: DocComment[], rawTop: Map<string, number>, narrow: boolean): Map<string, number> {
  const sorted = order.slice().sort((a, b) => (rawTop.get(a.id) ?? 0) - (rawTop.get(b.id) ?? 0));
  const out = new Map<string, number>();
  let cursor = 0;
  for (const c of sorted) {
    const top = Math.max(rawTop.get(c.id) ?? cursor, cursor);
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
  const { comments, focusId, showResolved, setCommentText, addReply, resolveComment, reopenComment, removeComment } = useDocComments(path);
  const visible = useMemo(
    () => comments.filter((c) => showResolved || !c.resolved).sort((a, b) => a.createdAt - b.createdAt),
    [comments, showResolved],
  );
  const marginRef = useRef<HTMLDivElement>(null);
  const marks = useQuoteMarks(containerRef, visible);
  const rawTops = useAnchorTops(marks, marginRef, containerRef);
  const tops = useMemo(() => stackedTops(visible, rawTops, narrow), [visible, rawTops, narrow]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const jump = (id: string) => marks.get(id)?.[0]?.scrollIntoView({ block: 'center', behavior: 'smooth' });

  useEffect(() => {
    if (!openThreadId || !marks.has(openThreadId)) return;
    jump(openThreadId);
    setActiveId(openThreadId);
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
      const click = () => jump(id);
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
      ACTIVE_CLASSES.forEach((cls) => mark.classList.toggle(cls, id === activeId));
    }
  }, [marks, activeId]);

  if (narrow) {
    const openComment = visible.find((c) => c.id === openId) ?? null;
    return (
      <>
        <div ref={marginRef} className="relative w-9 shrink-0 border-l border-edge bg-panel" style={{ minHeight: '100%' }}>
          {visible.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setOpenId(c.id)}
              aria-label={c.resolved ? `Resolved comment: ${c.quote}` : `Comment: ${c.quote}`}
              className={`absolute left-1.5 coarse-hit w-6 h-6 rounded-full border flex items-center justify-center text-2xs
                ${c.resolved ? 'bg-inset border-edge-dim text-fg-muted' : 'bg-panel border-edge text-fg-2'}`}
              style={{ top: tops.get(c.id) ?? 0 }}
            >
              {c.resolved ? <CheckIcon className="w-3 h-3" /> : '💬'}
            </button>
          ))}
        </div>
        {openComment && (
          <>
            <Scrim layer={2} onClick={() => setOpenId(null)} />
            <OverlayPanel layer={2} className="fixed inset-x-3 bottom-3 max-h-[70vh] overflow-auto p-2 rounded-lg">
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
          </>
        )}
      </>
    );
  }

  return (
    <div ref={marginRef} className="relative w-64 shrink-0 border-l border-edge bg-panel" style={{ minHeight: '100%' }}>
      {visible.map((c) => (
        <div
          key={c.id}
          className={`absolute left-2 right-2 rounded-lg transition-shadow ${c.id === activeId ? 'ring-2 ring-accent/60' : ''}`}
          style={{ top: tops.get(c.id) ?? 0 }}
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
}
