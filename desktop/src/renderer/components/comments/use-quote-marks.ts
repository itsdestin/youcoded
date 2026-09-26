// Shared by CommentsMargin (Comments mode) and ReadingHighlights (Reading
// mode) — round 2 (Destin) made highlighting the PRIMARY way a comment shows
// (margin/markers moved into a distinct, opt-in "Comments mode"), so the
// mark-wrapping logic that used to live only inside CommentsMargin.tsx now
// needs to run for whichever mode is actually mounted. The two modes are
// mutually exclusive (ActiveArtifactView renders exactly one), so each
// simply calls this hook independently — never both at once, so there is no
// double-wrap risk to guard against.
import { useLayoutEffect, useState, type RefObject } from 'react';
import type { DocComment } from '../../state/doc-comments-store';

const MARK_ATTR = 'data-comment-mark';
// Soft accent tint (G-8 reads this as the "selected span" case — the same
// bg-accent/10-15 family FolderSwitcher and SettingsPanel already use for an
// active row) — an OPEN comment's anchor; resolved fades to neutral, matching
// the resolved card's own faded state.
//
// Coordinator review, round 3: a flat tint alone reads as a plain text
// SELECTION in Midnight (its accent is grey by design, G-8), not as "this
// span has a comment on it" — a real drag-selection is just as plausible a
// reading of a grey box. An underline is the one thing a native selection
// never draws, so it's added here as the disambiguating signal, not the
// tint. `decoration-2`/`underline-offset-2`: thin enough to read as an
// annotation mark, not a second bolder highlight.
// text-inherit (theme pass, 2026-09-26): the browser's own <mark> style
// paints the text BLACK (UA `color: MarkText`), which vanished on dark themes
// — Halftone Dimension's highlighted sentences were near-invisible. The text
// keeps the document's colour; only the tint and underline mark it.
const MARK_OPEN = 'text-inherit bg-accent/15 hover:bg-accent/25 rounded-sm cursor-pointer transition-colors underline decoration-2 decoration-accent/70 underline-offset-2';
const MARK_RESOLVED = 'bg-fg-muted/10 text-fg-muted rounded-sm cursor-pointer underline decoration-2 decoration-fg-muted/50 underline-offset-2';
// Exported: both CommentsMargin (Comments mode) and ReadingHighlights
// (Reading mode) toggle these on the SAME mark elements when linking a
// highlight to its card/hover-card, so the active look must be one constant.
//
// Round 3 (polish pass): this used to be a 2px accent RING — on a highlight
// that's just a soft tint, a hard ring reads as a focus-outline bug, not
// "this thread is open" (Destin's own words). The fix is more of the SAME
// tint, not a border: `!` forces it past the resting bg-accent/15 (or, on a
// resolved mark, bg-fg-muted/10) regardless of which utility the bundler
// happens to emit later in the stylesheet — Tailwind resolves two classes
// setting the same property by CSS source order, not DOM class order (the
// exact trap Button.tsx's mergeClasses exists to dodge; `!important` is the
// cheaper fix here since this is one property, not a whole conflict table).
export const ACTIVE_CLASSES = ['!bg-accent/30'];

// Spreadsheet cells (Excel's model: a comment belongs to a CELL). The cell
// itself becomes the "mark" — same data-comment-id, same hover/click/active
// wiring in ReadingHighlights and CommentsMargin — but it is never wrapped or
// replaced (React owns the <td>): classes and attributes are added, then
// removed on the next pass. `.comment-cell-mark` (globals.css) draws Excel's
// familiar corner triangle in the accent colour.
const CELL_ATTR = 'data-comment-cell';
const CELL_OPEN = 'comment-cell-mark';
const CELL_RESOLVED = 'comment-cell-mark comment-cell-mark--resolved';

/** One point in the document text: a text node and a character offset in it. */
interface TextPoint { node: Text; offset: number }

/**
 * Finds `quote` in `root`'s text even when it spans several text nodes.
 *
 * WHY whitespace-free matching across ALL text nodes (Destin, round 3: "the
 * tinted highlight … isn't even appearing" for comments he left on another
 * file): the earlier version searched ONE text node at a time, so it only
 * ever matched quotes that sat inside a single run of plain text. The seeded
 * fixture quotes were written that way; a real selection almost never is —
 * it crosses a **bold** word, a link, a list item or a paragraph break, and
 * `selection.toString()` then carries newlines the DOM's text nodes don't
 * have (or vice versa). Stripping whitespace on both sides and walking a
 * character→node index makes those selections match. Mockup-grade anchoring;
 * the real build stores prefix/suffix context (Web Annotation's
 * TextQuoteSelector) so a repeated phrase lands on the right occurrence.
 */
export function findQuote(root: HTMLElement, quote: string): { start: TextPoint; end: TextPoint } | null {
  const needle = quote.replace(/\s+/g, '');
  if (!needle) return null;
  const points: TextPoint[] = [];
  let compact = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const text = n.data;
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text[i])) continue;
      compact += text[i];
      points.push({ node: n, offset: i });
    }
  }
  const idx = compact.indexOf(needle);
  if (idx === -1) return null;
  const last = points[idx + needle.length - 1];
  return { start: points[idx], end: { node: last.node, offset: last.offset + 1 } };
}

/** Wraps [start, end) in one `<mark>` per text node it touches. */
function wrapSegments(root: HTMLElement, start: TextPoint, end: TextPoint, make: () => HTMLElement): HTMLElement[] {
  // Collect the text nodes first — splitting them while a TreeWalker is
  // mid-walk would make it skip or revisit nodes.
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let inside = false;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (n === start.node) inside = true;
    if (inside) nodes.push(n);
    if (n === end.node) break;
  }
  const out: HTMLElement[] = [];
  for (const node of nodes) {
    const from = node === start.node ? start.offset : 0;
    const to = node === end.node ? end.offset : node.data.length;
    // WHY skip whitespace-only pieces: the "\n" text nodes React leaves
    // between paragraphs/list items would otherwise become stray tinted
    // blobs in the gaps between blocks.
    if (!node.data.slice(from, to).trim()) continue;
    let target = node;
    if (to < target.data.length) target.splitText(to);
    if (from > 0) target = target.splitText(from);
    const mark = make();
    target.parentNode?.insertBefore(mark, target);
    mark.appendChild(target);
    out.push(mark);
  }
  return out;
}

/**
 * Wraps each visible comment's quote text in `<mark>`s inside `container` —
 * one per text node the quote touches, all sharing `data-comment-id`, so a
 * quote spanning bold text, links or several paragraphs still highlights as
 * one comment. Returns every segment per comment; callers use `[0]` for
 * position/scrolling and wire hover/active state on all of them.
 * First-occurrence matching: a phrase that also appears earlier in the
 * document lands on that earlier copy (see findQuote's WHY). The card and
 * hover-card still render either way.
 */
export function useQuoteMarks(
  containerRef: RefObject<HTMLElement | null>,
  comments: DocComment[],
): Map<string, HTMLElement[]> {
  const [marks, setMarks] = useState<Map<string, HTMLElement[]>>(new Map());
  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) {
      setMarks(new Map());
      return;
    }
    // WHY a MutationObserver: Word and Excel files render ASYNCHRONOUSLY
    // (mammoth / exceljs parse after mount), and switching sheet tabs swaps
    // every cell — a pass that only ran when `comments` changed would find
    // no text and no cells, and never look again. The observer is paused
    // during our own pass, so our <mark> wrapping never re-triggers it.
    const observer = new MutationObserver(() => pass());
    const pass = () => {
      observer.disconnect();
      setMarks(markAll(root, comments));
      observer.takeRecords();
      observer.observe(root, { childList: true, subtree: true });
    };
    pass();
    return () => observer.disconnect();
  }, [containerRef, comments]);
  return marks;
}

function markAll(root: HTMLElement, comments: DocComment[]): Map<string, HTMLElement[]> {
  // Undo the previous pass's marks first so re-highlighting never nests
  // <mark>s inside <mark>s as comments/content change.
  root.querySelectorAll(`[${MARK_ATTR}]`).forEach((el) => {
    el.replaceWith(document.createTextNode(el.textContent ?? ''));
  });
  root.querySelectorAll<HTMLElement>(`[${CELL_ATTR}]`).forEach((el) => {
    el.removeAttribute(CELL_ATTR);
    el.removeAttribute('data-comment-id');
    el.classList.remove(...CELL_RESOLVED.split(' '), ...ACTIVE_CLASSES);
  });
  root.normalize();
  const found = new Map<string, HTMLElement[]>();
  for (const c of comments) {
    if (c.cell) {
      const td = root.querySelector<HTMLElement>(`[data-cell="${c.cell}"]`);
      if (!td) continue;
      td.setAttribute(CELL_ATTR, '');
      td.setAttribute('data-comment-id', c.id);
      td.classList.add(...(c.resolved ? CELL_RESOLVED : CELL_OPEN).split(' '));
      found.set(c.id, [td]);
      continue;
    }
    const hit = findQuote(root, c.quote);
    if (!hit) continue;
    const segs = wrapSegments(root, hit.start, hit.end, () => {
      const mark = document.createElement('mark');
      mark.setAttribute(MARK_ATTR, '');
      mark.setAttribute('data-comment-id', c.id);
      mark.className = c.resolved ? MARK_RESOLVED : MARK_OPEN;
      return mark;
    });
    if (segs.length) found.set(c.id, segs);
  }
  return found;
}

/** One rect spanning every segment — anchors hover cards below the WHOLE
 *  quote, not just its first line. */
export function segmentsRect(segs: HTMLElement[]): DOMRect {
  const rects = segs.map((s) => s.getBoundingClientRect());
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}
