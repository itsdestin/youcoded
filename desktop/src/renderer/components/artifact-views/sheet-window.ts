// sheet-window — the arithmetic behind drawing only the part of a big spreadsheet that is on screen.
//
// WHY (2026-10-04, docs/active/investigations/2026-10-04-performance-gap-review.md 4c/4d): CsvView and XlsxView drew
// EVERY cell (a 2,000 x 100 sheet = 200,000 cells = 205,030 page elements): 10 s to open with a 7 s freeze, 0.5 s
// per cell click, a 7 s freeze to close. Rows and columns that cannot be seen are now blank spacer space instead
// (renderer-lists.md: "draw only what can be seen").
//
// Pure functions only, so the bound can be pinned by a test without drawing anything. Everything here is 0-based.

export const ROW_H = 24;          // a normal row, px. Fixed on purpose: the spacers need exact heights.
export const GUTTER_W = 38;       // the row-number column, px
export const HEADER_H = 24;       // the column-letter strip, px (the same height as a normal row)

// How far past the visible edge to draw, and how coarsely the drawn window moves. Overscan keeps a fast scroll
// from showing blank space before the next draw lands; the step makes the window change once per few rows
// instead of once per pixel, so scrolling does not redraw on every scroll event.
const ROW_OVERSCAN = 20;
const ROW_STEP = 10;
const COL_OVERSCAN = 4;
const COL_STEP = 4;
// Used until the real viewport has been measured (and in tests, where nothing has a size).
export const FALLBACK_VIEW = { w: 1400, h: 900 };

/** A merged range: top-left (r0,c0) to bottom-right (r1,c1), inclusive. */
export interface MergeBox { r0: number; c0: number; r1: number; c1: number }
/** The drawn rectangle of the grid, inclusive. */
export interface Win { r0: number; r1: number; c0: number; c1: number }

/** offsets[i] = where item i starts; offsets[n] = the total. */
export function prefixSums(sizes: number[]): number[] {
  const out = new Array<number>(sizes.length + 1);
  out[0] = 0;
  for (let i = 0; i < sizes.length; i++) out[i + 1] = out[i] + sizes[i];
  return out;
}

/** The index of the item that contains `pos` (clamped to the first / last item). */
function indexAt(offsets: number[], pos: number): number {
  const n = offsets.length - 1;
  if (n <= 0) return 0;
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= pos) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** The window to draw for a scroller at (scrollTop, scrollLeft) showing (viewH x viewW) px. */
export function windowFor(
  rowOffsets: number[], colOffsets: number[],
  scrollTop: number, scrollLeft: number, viewH: number, viewW: number,
): Win {
  const nRows = rowOffsets.length - 1, nCols = colOffsets.length - 1;
  // The column-letter strip and the number gutter sit INSIDE the scroller, so the first data row starts HEADER_H
  // below the scroll origin and the first data column GUTTER_W to its right.
  const rFirst = indexAt(rowOffsets, scrollTop - HEADER_H);
  const rLast = indexAt(rowOffsets, scrollTop + viewH - HEADER_H);
  const cFirst = indexAt(colOffsets, scrollLeft - GUTTER_W);
  const cLast = indexAt(colOffsets, scrollLeft + viewW - GUTTER_W);
  return {
    r0: Math.floor(Math.max(0, rFirst - ROW_OVERSCAN) / ROW_STEP) * ROW_STEP,
    r1: Math.min(nRows - 1, Math.ceil((rLast + ROW_OVERSCAN + 1) / ROW_STEP) * ROW_STEP - 1),
    c0: Math.floor(Math.max(0, cFirst - COL_OVERSCAN) / COL_STEP) * COL_STEP,
    c1: Math.min(nCols - 1, Math.ceil((cLast + COL_OVERSCAN + 1) / COL_STEP) * COL_STEP - 1),
  };
}

export const sameWin = (a: Win, b: Win) => a.r0 === b.r0 && a.r1 === b.r1 && a.c0 === b.c0 && a.c1 === b.c1;

/**
 * Grow the window until it holds every merged range it touches in full. WHY: a merged cell is ONE element that
 * spans several rows/columns; drawing half of one (its top-left corner without the rows/columns it covers)
 * would make the table lay out wrongly. Iterates because enlarging for one merge can reach another.
 */
export function expandForMerges(win: Win, merges: MergeBox[]): Win {
  if (!merges.length) return win;
  let { r0, r1, c0, c1 } = win;
  for (let changed = true; changed;) {
    changed = false;
    for (const m of merges) {
      if (m.r1 < r0 || m.r0 > r1 || m.c1 < c0 || m.c0 > c1) continue; // does not touch the window
      if (m.r0 < r0) { r0 = m.r0; changed = true; }
      if (m.r1 > r1) { r1 = m.r1; changed = true; }
      if (m.c0 < c0) { c0 = m.c0; changed = true; }
      if (m.c1 > c1) { c1 = m.c1; changed = true; }
    }
  }
  return { r0, r1, c0, c1 };
}

/** One piece of a drawn row, left to right: blank space for `span` columns, or a real cell. */
export type RowItem =
  | { kind: 'gap'; span: number }
  | { kind: 'cell'; c: number; colSpan: number; rowSpan: number };
/** One piece of the grid, top to bottom: blank space `height` px tall, or a drawn row. */
export type GridPiece =
  | { kind: 'gap'; height: number }
  | { kind: 'row'; r: number; items: RowItem[] };

export interface MergeIndex {
  /** top-left cell → its box, keyed r * KEY + c */
  masters: Map<number, MergeBox>;
  /** every other cell inside a box (they are drawn by the master), keyed r * KEY + c */
  covered: Set<number>;
}
const KEY = 4096; // > any column count (the viewers cap at 100)
const keyOf = (r: number, c: number) => r * KEY + c;

export function indexMerges(merges: MergeBox[]): MergeIndex {
  const masters = new Map<number, MergeBox>();
  const covered = new Set<number>();
  for (const m of merges) {
    masters.set(keyOf(m.r0, m.c0), m);
    for (let r = m.r0; r <= m.r1; r++) {
      for (let c = m.c0; c <= m.c1; c++) if (r !== m.r0 || c !== m.c0) covered.add(keyOf(r, c));
    }
  }
  return { masters, covered };
}

/** Walk one row's included columns left to right, filling skipped stretches with gaps. */
function rowItems(r: number, cols: number[], colCount: number, idx: MergeIndex): RowItem[] {
  const items: RowItem[] = [];
  let cursor = 0; // the next column slot not yet accounted for
  for (const c of cols) {
    if (c < cursor) continue; // already inside a wide merged cell drawn earlier in this row
    if (c > cursor) items.push({ kind: 'gap', span: c - cursor });
    cursor = c;
    // Covered by a merged cell: the browser reserves its slot (a tall merge reaching down from a row above) or
    // we already drew it (a wide merge reaching right), so nothing is drawn for this slot.
    if (idx.covered.has(keyOf(r, c))) { cursor = c + 1; continue; }
    const box = idx.masters.get(keyOf(r, c));
    const colSpan = box ? box.c1 - box.c0 + 1 : 1;
    items.push({ kind: 'cell', c, colSpan, rowSpan: box ? box.r1 - box.r0 + 1 : 1 });
    cursor = c + colSpan;
  }
  if (cursor < colCount) items.push({ kind: 'gap', span: colCount - cursor });
  return items;
}

/**
 * What to draw: the window's rows and columns, PLUS any `pins` (cells that must exist in the page even when
 * scrolled far away — a spreadsheet cell with a comment, because the comment highlighter finds its cell by
 * looking in the page). Everything else is blank space of the right size, so the scrollbar and every drawn
 * cell stay exactly where a fully drawn sheet would have put them.
 */
export function planGrid(args: {
  win: Win; rowCount: number; colCount: number; rowOffsets: number[];
  merges: MergeBox[]; mergeIndex: MergeIndex; pins: ReadonlyArray<readonly [number, number]>;
}): GridPiece[] {
  const { win, rowCount, colCount, rowOffsets, merges, mergeIndex, pins } = args;
  // Pinned cells outside the window: remember, per row, which extra columns to draw. A pinned merged cell brings
  // its whole box (same reason as expandForMerges); an absurdly large box is skipped rather than drawn.
  const extra = new Map<number, Set<number>>();
  const addExtra = (r: number, c: number) => {
    if (r < 0 || r >= rowCount || c < 0 || c >= colCount) return;
    if (r >= win.r0 && r <= win.r1 && c >= win.c0 && c <= win.c1) return;
    (extra.get(r) ?? extra.set(r, new Set()).get(r)!).add(c);
  };
  for (const [r, c] of pins) {
    if (r < 0 || r >= rowCount || c < 0 || c >= colCount) continue;
    if (mergeIndex.covered.has(keyOf(r, c))) continue; // a covered cell is not drawn at all, as before
    const box = mergeIndex.masters.get(keyOf(r, c));
    if (box && (box.r1 - box.r0 + 1) * (box.c1 - box.c0 + 1) > 2000) continue;
    if (!box) { addExtra(r, c); continue; }
    for (let rr = box.r0; rr <= box.r1; rr++) for (let cc = box.c0; cc <= box.c1; cc++) addExtra(rr, cc);
  }
  void merges;

  const winCols: number[] = [];
  for (let c = win.c0; c <= win.c1; c++) winCols.push(c);

  const rows = new Set<number>(extra.keys());
  for (let r = win.r0; r <= win.r1; r++) rows.add(r);
  const sorted = [...rows].sort((a, b) => a - b);

  const pieces: GridPiece[] = [];
  let next = 0; // the next row index not yet accounted for (drawn or blank)
  for (const r of sorted) {
    if (r > next) pieces.push({ kind: 'gap', height: rowOffsets[r] - rowOffsets[next] });
    const ex = extra.get(r);
    const cols = ex ? [...new Set([...winCols, ...ex])].sort((a, b) => a - b) : winCols;
    pieces.push({ kind: 'row', r, items: rowItems(r, cols, colCount, mergeIndex) });
    next = r + 1;
  }
  if (next < rowCount) pieces.push({ kind: 'gap', height: rowOffsets[rowCount] - rowOffsets[next] });
  return pieces;
}

/** The column-letter strip: the window's columns with blank stretches between. */
export function headerItems(win: Win, colCount: number): RowItem[] {
  const items: RowItem[] = [];
  if (win.c0 > 0) items.push({ kind: 'gap', span: win.c0 });
  for (let c = win.c0; c <= win.c1; c++) items.push({ kind: 'cell', c, colSpan: 1, rowSpan: 1 });
  if (win.c1 < colCount - 1) items.push({ kind: 'gap', span: colCount - 1 - win.c1 });
  return items;
}
