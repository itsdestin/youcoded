// Shared by CommentsMargin (Comments mode) and ReadingHighlights (Reading
// mode) — round 2 (Destin) made highlighting the PRIMARY way a comment shows
// (margin/markers moved into a distinct, opt-in "Comments mode"), so the
// mark-wrapping logic that used to live only inside CommentsMargin.tsx now
// needs to run for whichever mode is actually mounted. The two modes are
// mutually exclusive (ActiveArtifactView renders exactly one), so each
// simply calls this hook independently — never both at once, so there is no
// double-wrap risk to guard against.
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { setCommentStatus, anchorSignature, type DocComment } from '../../state/doc-comments-store';
// T14 (docs/active/specs/2026-09-26-doc-comments-build-design.md §2.2/§2.3):
// the real anchoring algorithm, shared with the main process and the MCP
// script — swapped in below for the mockup's own `findQuote` search
// (`findQuote` itself stays, exported, for use-ref-source-highlight.ts's
// unrelated "Ask about this" chip flash, which was never part of this task).
import { resolveSelector, resolveCellSelector, cellSelectorKey } from '../../../shared/doc-comments-anchor';
import type { TextQuoteSelector, CellSelector } from '../../../shared/doc-comments-types';
// F6 (T14 review): interaction-state placeholder text (ChatImage's "Image
// from … · Show") must never enter the text `resolveSelector` searches.
import { isAnchorSkipped } from './anchor-skip';

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

/** The rendered cell a comment names. With a sheet, only on that sheet's
 *  grid (XlsxView stamps data-sheet on it) — a C4 on another tab is a
 *  different cell, and is found once that tab is showing. */
export function cellSelector(c: { cell?: string; sheet?: string }): string {
  const cell = `[data-cell="${CSS.escape(c.cell ?? '')}"]`;
  return c.sheet ? `[data-sheet="${CSS.escape(c.sheet)}"] ${cell}` : cell;
}
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
 * character→node index makes those selections match.
 *
 * T14: this is no longer the comment-highlight anchor (see `markAll` below,
 * which now resolves comments via `resolveSelector` against the SAME
 * prefix/suffix/occurrence context build-menu.ts captured at save time).
 * `findQuote` stays exported and unchanged for `use-ref-source-highlight.ts`'s
 * "Ask about this" chip flash — a different, best-effort feature (highlight
 * whatever still looks like the chip's quote) that was never part of this
 * anchoring rewrite.
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

/**
 * Everything one highlight pass changed inside a root, so the next pass (or
 * an unmount) can put the page back EXACTLY as React left it.
 *
 * WHY (2026-09-28 PR review): the page under the highlights belongs to React.
 * The old undo swapped each <mark> for a brand-new text node and then called
 * `root.normalize()`, which merges EVERY pair of neighbouring text nodes in
 * the document — including ones React created for `{a}{b}` and still holds
 * references to. React's later updates then went to detached nodes, so the
 * file showed stale words even when it had no comments at all. Now only nodes
 * this hook created are removed, React's own text nodes get their text back,
 * and nothing React created is ever merged away.
 */
interface WrapRecord {
  /** Nodes this hook created (marks and split-off text pieces). */
  created: Set<Node>;
  /** React-owned text nodes this hook split: their text before the split,
   *  and what the split left in them (to tell whether React changed them). */
  splits: Map<Text, { original: string; left: string }>;
}
const wrapRecords = new WeakMap<HTMLElement, WrapRecord>();

/** Undoes the previous pass in `root` (see `WrapRecord`). */
function unwrapAll(root: HTMLElement): void {
  const record = wrapRecords.get(root);
  if (!record) return;
  wrapRecords.delete(root);
  // Marks first: their children (React's own nodes or our pieces) go back
  // exactly where the mark stood.
  for (const node of record.created) {
    if (node instanceof HTMLElement && node.parentNode) node.replaceWith(...Array.from(node.childNodes));
  }
  for (const node of record.created) {
    if (!(node instanceof HTMLElement)) node.parentNode?.removeChild(node);
  }
  for (const [text, { original, left }] of record.splits) {
    // Only restore a node React hasn't rewritten since the split — if it
    // has, React's newer text wins and our pieces (already removed) are gone.
    if (text.data === left) text.data = original;
  }
}

/** Wraps [start, end) in one `<mark>` per text node it touches, recording
 *  every change in `record`. */
function wrapSegments(root: HTMLElement, start: TextPoint, end: TextPoint, make: () => HTMLElement, record: WrapRecord): HTMLElement[] {
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
    if ((from > 0 || to < node.data.length) && !record.created.has(node) && !record.splits.has(node)) {
      record.splits.set(node, { original: node.data, left: '' });
    }
    let target = node;
    if (to < target.data.length) record.created.add(target.splitText(to));
    if (from > 0) {
      target = target.splitText(from);
      record.created.add(target);
    }
    const mark = make();
    record.created.add(mark);
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
 *
 * T14 (§2.2/§2.3): the anchor for each text comment is
 * `resolveSelector(fullText, sel)` — a repeated phrase resolves to whichever
 * occurrence its `prefix`/`suffix` context actually matches, not always the
 * first copy, and text that moved elsewhere in the document still highlights
 * (see `doc-comments-anchor.ts`). A comment `resolveSelector` cannot find at
 * all gets no mark and its `status` set to `'detached'` (via
 * `setCommentStatus`) — the card and hover-card still render either way
 * (`CommentsMargin.tsx`'s own "no mark" fallback); the dedicated "text no
 * longer found" treatment is T6's, not this hook's.
 */
export function useQuoteMarks(
  containerRef: RefObject<HTMLElement | null>,
  comments: DocComment[],
): Map<string, HTMLElement[]> {
  const [marks, setMarks] = useState<Map<string, HTMLElement[]>>(new Map());
  // F4 (T14 review, performance.md rule 5): `comments` gets a BRAND NEW array
  // reference on every keystroke typed into any comment's own note/reply box
  // (doc-comments-store.ts's `setCommentText`/`addReply` republish the whole
  // array for that file) — a plain `[containerRef, comments]` dependency
  // reran this WHOLE-DOCUMENT anchoring pass (`markAll`'s tree walk plus one
  // `resolveSelector` call per comment) on every such keystroke, for every
  // comment in the file, not just the one being typed into. `signature`
  // (doc-comments-store.ts's `anchorSignature`) only changes when something
  // that actually affects an anchor's position or look changes (id, quote,
  // selector prefix/suffix/occurrence, cell, sheet, resolved) — typing
  // text/replies leaves it unchanged, so the effect below simply skips the
  // pass. `commentsRef` (the same "latest ref" idiom renderer-lists.md's own
  // SkillCard/SessionDrawer use for handlers) hands the effect body the
  // CURRENT comments to anchor against without making the array reference
  // itself a dependency.
  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const signature = anchorSignature(comments);
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
      setMarks(markAll(root, commentsRef.current));
      observer.takeRecords();
      observer.observe(root, { childList: true, subtree: true });
    };
    pass();
    return () => {
      observer.disconnect();
      // Leave nothing behind for React to trip over once highlights stop
      // (file closed, switched to edit mode, comments mode changed).
      unwrapAll(root);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- commentsRef always holds the latest comments; signature (not the array reference) is the real re-anchor trigger, see the WHY above
  }, [containerRef, signature]);
  return marks;
}

/**
 * Every character of `root`'s rendered text, alongside the exact DOM position
 * (text node + offset) each one came from — the same "flatten every text
 * node in document order" model build-menu.ts's `quoteContextAt` callers use
 * to capture prefix/suffix/occurrence at SAVE time (`selectionOffsets`/
 * `rangeTextOffsets`), so `resolveSelector`'s returned offsets land back on
 * the exact same span it was captured from (T14's own consistency
 * requirement). Unlike `findQuote` above, whitespace is NOT stripped here:
 * `resolveSelector` does its own whitespace-collapsed comparison internally
 * and returns offsets into the ORIGINAL (whitespace-included) text, so this
 * array must index that same original text 1:1.
 */
function collectText(root: Node): { text: string; points: TextPoint[] } {
  let text = '';
  const points: TextPoint[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    // F6 (T14 review): interaction-state placeholder text (ChatImage's
    // "Image from … · Show") is never part of the searched text — must agree
    // with build-menu.ts's rangeTextOffsets, which skips the SAME nodes at
    // save time via the SAME predicate.
    if (isAnchorSkipped(n)) continue;
    const s = n.data;
    for (let i = 0; i < s.length; i++) {
      text += s[i];
      points.push({ node: n, offset: i });
    }
  }
  return { text, points };
}

// F3 (T14 review): this cites Rule 4 (performance.md: "per-event work does
// not grow with history or session count"), not Rule 6 (layout/paint) as an
// earlier version of this comment mistakenly said — bounds the one genuinely
// O(document-length) cost this pass has: a pathological multi-megabyte file
// skips the tree-walk/resolveSelector work entirely rather than allocating a
// same-length TextPoint array and running resolveSelector's own (already
// individually bounded — doc-comments-anchor.ts's MAX_SCORED_OCCURRENCES/
// EXACT_SAMPLE_CHARS) scoring over it. 2M characters is far past any real
// note/plan/code file this feature targets. Exported so
// use-code-comment-anchors.ts's own bound (CodeMirror's live document can be
// just as large as a rendered file's DOM text) uses the exact same number —
// one constant, not two that could quietly drift apart.
export const MAX_ANCHOR_TEXT_CHARS = 2_000_000;

/** The element whose flattened text is the SAME text `quoteContextAt`/
 *  `resolveSelector` were given at save time (build-menu.ts's
 *  `selectionOffsets`): 'raw' quotes the `<pre>`, 'rendered' quotes the whole
 *  content column. One function so a future third text source can't
 *  silently pick a different root than the one that captured its selector. */
function textRootFor(root: HTMLElement): HTMLElement | null {
  return root.getAttribute('data-artifact-source') === 'raw' ? root.querySelector('pre') : root;
}

/** §2.2: "a cell either is or isn't in the current sheet" — but XlsxView only
 *  ever renders the ACTIVE sheet tab's cells into the DOM (`XlsxView.tsx`'s
 *  `XlsxSheets`), so a comment on a DIFFERENT tab has no DOM evidence either
 *  way right now. Returning `undefined` there leaves the comment's
 *  last-known status alone instead of wrongly flipping it to 'detached'
 *  every time another tab happens to be showing. */
function cellStatus(root: HTMLElement, sel: CellSelector): 'anchored' | 'detached' | undefined {
  const sheetEl = root.querySelector<HTMLElement>('[data-sheet]');
  if (!sheetEl) return undefined;
  const activeSheet = sheetEl.getAttribute('data-sheet') ?? undefined;
  if (sel.sheet && sel.sheet !== activeSheet) return undefined;
  const present = new Set<string>();
  sheetEl.querySelectorAll<HTMLElement>('[data-cell]').forEach((el) => {
    const addr = el.getAttribute('data-cell');
    if (addr) present.add(cellSelectorKey({ type: 'CellSelector', cell: addr, sheet: sel.sheet }));
  });
  return resolveCellSelector(sel, present);
}

function markAll(root: HTMLElement, comments: DocComment[]): Map<string, HTMLElement[]> {
  // Undo the previous pass first so re-highlighting never nests <mark>s
  // inside <mark>s as comments/content change — and never merges React's own
  // text nodes (see `WrapRecord`).
  unwrapAll(root);
  root.querySelectorAll<HTMLElement>(`[${CELL_ATTR}]`).forEach((el) => {
    el.removeAttribute(CELL_ATTR);
    el.removeAttribute('data-comment-id');
    el.classList.remove(...CELL_RESOLVED.split(' '), ...ACTIVE_CLASSES);
  });
  const record: WrapRecord = { created: new Set(), splits: new Map() };
  const found = new Map<string, HTMLElement[]>();

  // Cell comments (spreadsheets): §2.2's trivial presence check.
  for (const c of comments) {
    if (!c.cell) continue;
    const status = cellStatus(root, { type: 'CellSelector', cell: c.cell, sheet: c.sheet });
    if (status) setCommentStatus(c.id, status);
    const td = root.querySelector<HTMLElement>(cellSelector(c));
    if (!td) continue;
    td.setAttribute(CELL_ATTR, '');
    td.setAttribute('data-comment-id', c.id);
    td.classList.add(...(c.resolved ? CELL_RESOLVED : CELL_OPEN).split(' '));
    found.set(c.id, [td]);
  }

  // Text comments (markdown/plain-text/docx): T14's real anchoring pass —
  // resolveSelector against the SAME rendered-text model build-menu.ts used
  // to capture prefix/suffix/occurrence when the comment was made, so a
  // repeated phrase re-resolves to the exact copy it was made on (§2.3).
  const textComments = comments.filter((c) => !c.cell && c.quote);
  const textRoot = textComments.length ? textRootFor(root) : null;
  if (textRoot) {
    const { text, points } = collectText(textRoot);
    if (text.length > MAX_ANCHOR_TEXT_CHARS) {
      // F3 (T14 review): before this fix, going over the bound left `status`
      // untouched — an oversized file's comments showed NEITHER a highlight
      // NOR T6's "text no longer found" note, indistinguishable from "hasn't
      // been checked yet" (which is, in fact, exactly what happened — but
      // silently). 'unchecked' says that explicitly and never claims the text
      // is gone (it might still be there); CommentCard renders it as its own
      // honest line ("This file is too large to show where this comment
      // points."), never reusing 'detached'’s wording, which would be a
      // guessed cause (error-message-standards.md).
      for (const c of textComments) setCommentStatus(c.id, 'unchecked');
    } else {
      for (const c of textComments) {
        const sel: TextQuoteSelector = {
          type: 'TextQuoteSelector',
          exact: c.quote,
          prefix: c.selectorPrefix ?? '',
          suffix: c.selectorSuffix ?? '',
          occurrence: c.selectorOccurrence ?? 0,
        };
        const resolved = resolveSelector(text, sel);
        if (resolved === 'detached') {
          // §2.3: no highlight for a detached comment — it stays in the
          // list (CommentsMargin's own "no mark" fallback), just unmarked.
          setCommentStatus(c.id, 'detached');
          continue;
        }
        setCommentStatus(c.id, 'anchored');
        const startPoint = points[resolved.start];
        const lastPoint = points[resolved.end - 1];
        if (!startPoint || !lastPoint) continue; // defensive: resolveSelector's own offsets are always in range
        const endPoint: TextPoint = { node: lastPoint.node, offset: lastPoint.offset + 1 };
        const segs = wrapSegments(textRoot, startPoint, endPoint, () => {
          const mark = document.createElement('mark');
          mark.setAttribute(MARK_ATTR, '');
          mark.setAttribute('data-comment-id', c.id);
          mark.className = c.resolved ? MARK_RESOLVED : MARK_OPEN;
          return mark;
        }, record);
        if (segs.length) found.set(c.id, segs);
      }
    }
  }
  if (record.created.size) {
    for (const [text, entry] of record.splits) entry.left = text.data;
    wrapRecords.set(root, record);
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
