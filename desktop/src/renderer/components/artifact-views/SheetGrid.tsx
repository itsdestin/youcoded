// SheetGrid — the spreadsheet-style grid CsvView and XlsxView share, drawing only the cells that can be seen.
//
// WHY (2026-10-04, performance-gap-review 4c/4d): both viewers used to draw every cell of a 2,000 x 100 sheet.
// Now the page holds the visible rows and columns plus a margin (sheet-window.ts), and blank spacer space of the
// right size stands in for the rest, so the scrollbar, the sticky column letters and row numbers, merged cells
// and every cell's position are exactly what a fully drawn sheet gave. Opening, clicking, scrolling and closing
// cost the same for a 200,000-cell sheet as for a small one (renderer-lists.md: draw only what can be seen).
//
// Still a real <table>: dragging across cells and copying still pastes as tab-separated rows, and the viewers'
// existing hooks (comment highlighting finds `[data-cell]`, the right-click menu reads the <td>) are unchanged.
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { colLetter } from './exceljs-cell';
import { GRID, GUTTER_BG, GUTTER_FG, SEL } from './sheet-theme';
import {
  FALLBACK_VIEW, GUTTER_W, HEADER_H, ROW_H, expandForMerges, headerItems, indexAt, indexMerges, keyOf, planGrid, prefixSums, sameWin,
  windowFor, type GridPiece, type MergeBox, type MergeIndex, type RowItem, type Win,
} from './sheet-window';
import { rangeToTsv } from './sheet-copy';

/** What one cell shows. `style` is the cell's complete look (border, padding, alignment...) except the selection ring. */
export interface GridCell {
  text: string;
  style: CSSProperties;
  title?: string;
  /** The `data-cell` address ("C4") the comment highlighter and right-click menu look for. */
  addr?: string;
}

export interface SheetGridModel {
  rowCount: number;
  colCount: number;
  /** px, one per column / row (0-based). Fixed: the blank space stands in for them by exact size. */
  colWidths: number[];
  rowHeights: number[];
  merges: MergeBox[];
  /** The cell at (r, c), 0-based. Called only for cells actually drawn. */
  cell: (r: number, c: number) => GridCell;
  /** The shown text of a cell, 0-based (copy and find read this, never the page). */
  text: (r: number, c: number) => string;
  /** Rows / columns that hold data (the viewers pad the drawn grid past them with blank cells). */
  usedRows: number;
  usedCols: number;
  /** Cells whose shown text contains `qLower` (lower-case), in reading order — for find-in-document. */
  findCells: (qLower: string) => Array<[number, number]>;
}

/** What the viewers can ask of the grid: scroll to a cell and get its drawn <td>. */
export interface SheetGridHandle {
  reveal: (r: number, c: number) => Promise<HTMLElement | null>;
}

interface CellRange { r0: number; c0: number; r1: number; c1: number }
const RANGE_BG = 'rgba(33, 115, 70, 0.16)'; // the selection ring's green, as a wash

export interface Selection { r: number; c: number }

interface Props {
  model: SheetGridModel;
  sel: Selection | null;
  onSelect: (r: number, c: number) => void;
  /** Cells to keep in the page even when scrolled far away (a cell with a comment). 0-based [row, col]. */
  pins?: ReadonlyArray<readonly [number, number]>;
  /** Extra attributes for the scrolling box (XlsxView stamps data-sheet on it). */
  scrollerProps?: Record<string, string | number>;
  /** Shown under the grid inside the scroller (the "Large sheet" note). */
  footer?: ReactNode;
  /** A right-click also selects the cell (XlsxView: so the formula bar names the cell "Add comment" will use). */
  selectOnContextMenu?: boolean;
}

const NO_PINS: ReadonlyArray<readonly [number, number]> = [];

const gutterBase: CSSProperties = {
  background: GUTTER_BG, color: GUTTER_FG, fontWeight: 500, textAlign: 'center',
  border: `1px solid ${GRID}`, userSelect: 'none', padding: 0, lineHeight: '16px',
};
const gutterTopStyle: CSSProperties = { ...gutterBase, position: 'sticky', top: 0, zIndex: 3, height: HEADER_H };
const gutterCornerStyle: CSSProperties = { ...gutterBase, position: 'sticky', top: 0, left: 0, zIndex: 4, width: GUTTER_W, minWidth: GUTTER_W, height: HEADER_H };
const gutterLeftStyle: CSSProperties = { ...gutterBase, position: 'sticky', left: 0, zIndex: 2, width: GUTTER_W, minWidth: GUTTER_W };
// Blank stand-in for cells and rows that are not drawn. No border, padding or content, so it adds nothing
// to the size it is told to be.
const gapCell: CSSProperties = { padding: 0, border: 0, lineHeight: 0, fontSize: 0 };

interface RowProps {
  r: number;
  height: number;
  items: RowItem[];
  /** The selected column when this row holds the selection, else -1 — so only that row redraws on a click. */
  selCol: number;
  /** The selected rectangle's columns when this row is inside it, else -1 / -1. */
  rc0: number;
  rc1: number;
  model: SheetGridModel;
}

// One drawn row. Memoised: scrolling adds rows at the edge but leaves the others alone, and a click redraws only
// the row losing the ring and the row gaining it (renderer-lists.md: a memoised row gets stable props).
const Row = memo(function Row({ r, height, items, selCol, rc0, rc1, model }: RowProps) {
  return (
    // data-tall: a taller-than-normal (wrapped) row, whose real height is measured after drawing
    <tr style={{ height }} aria-rowindex={r + 2} data-r={r} data-tall={model.rowHeights[r] > ROW_H ? '' : undefined}>
      <th style={{ ...gutterLeftStyle, height }} aria-colindex={1}>{r + 1}</th>
      {items.map((it, i) => {
        // keyed by position for a gap (two gaps in a row can be the same width), by column for a cell
        if (it.kind === 'gap') return <td key={`g${i}`} colSpan={it.span} style={gapCell} aria-hidden />;
        const cell = model.cell(r, it.c);
        let style: CSSProperties = cell.style;
        if (it.c >= rc0 && it.c <= rc1) style = { ...style, backgroundColor: RANGE_BG };
        if (it.c === selCol) style = { ...style, outline: `2px solid ${SEL}`, outlineOffset: -2 };
        return (
          <td
            key={it.c}
            colSpan={it.colSpan > 1 ? it.colSpan : undefined}
            rowSpan={it.rowSpan > 1 ? it.rowSpan : undefined}
            style={style}
            title={cell.title}
            data-r={r}
            data-c={it.c}
            data-cell={cell.addr}
            aria-colindex={it.c + 2}
          >
            {cell.text}
          </td>
        );
      })}
    </tr>
  );
}, (a, b) => a.r === b.r && a.height === b.height && a.selCol === b.selCol && a.rc0 === b.rc0 && a.rc1 === b.rc1 && a.model === b.model
  && a.items.length === b.items.length
  && a.items.every((x, i) => {
    const y = b.items[i];
    return x.kind === y.kind && (x.kind === 'gap' ? x.span === (y as typeof x).span
      : x.c === (y as typeof x).c && x.colSpan === (y as typeof x).colSpan && x.rowSpan === (y as typeof x).rowSpan);
  }));

const NO_FIX: ReadonlyMap<number, number> = new Map();

export const SheetGrid = forwardRef<SheetGridHandle, Props>(function SheetGrid(
  { model, sel, onSelect, pins = NO_PINS, scrollerProps, footer, selectOnContextMenu = false }, handleRef,
) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const { rowCount, colCount, colWidths, merges } = model;

  // Wrapped rows: the height the sheet's text estimate gave is only a minimum. After drawing, a row that came out
  // taller is measured and the measured height is used for the offsets too, so blank space and drawn rows can
  // never disagree (review fix 5: no scroll jump from a wrong estimate).
  // Kept WITH the model it was measured for, so a different sheet starts clean without an effect to reset it.
  const [fixed, setFixed] = useState<{ model: SheetGridModel; map: ReadonlyMap<number, number> }>({ model, map: NO_FIX });
  const fix = fixed.model === model ? fixed.map : NO_FIX;
  const setFix = useCallback((map: ReadonlyMap<number, number>) => setFixed({ model, map }), [model]);
  const rowHeights = useMemo(
    () => (fix.size ? model.rowHeights.map((h, r) => Math.max(h, fix.get(r) ?? 0)) : model.rowHeights),
    [model, fix],
  );

  // Heavy but only when the sheet itself changes (a different file or tab): positions and merge lookups.
  const geo = useMemo(() => ({
    rowOffsets: prefixSums(rowHeights),
    colOffsets: prefixSums(colWidths),
    mergeIndex: indexMerges(merges) as MergeIndex,
  }), [rowHeights, colWidths, merges]);

  // The viewport size is measured by a ResizeObserver (no layout reads while scrolling); the scroll position is
  // read in the scroll handler. Until both are known the fallback size draws a screenful.
  const view = useRef({ w: FALLBACK_VIEW.w, h: FALLBACK_VIEW.h });
  const [win, setWin] = useState<Win>(() => windowFor(geo.rowOffsets, geo.colOffsets, 0, 0, FALLBACK_VIEW.h, FALLBACK_VIEW.w));

  const recompute = useCallback(() => {
    const el = scrollerRef.current;
    const next = windowFor(geo.rowOffsets, geo.colOffsets, el?.scrollTop ?? 0, el?.scrollLeft ?? 0, view.current.h, view.current.w);
    // Same window -> same state object -> no redraw. The window only moves in steps (sheet-window.ts).
    setWin((prev) => (sameWin(prev, next) ? prev : next));
  }, [geo]);

  // A different sheet (new file, new tab) re-reads the position; a tab switch can leave the scroller further
  // down than the new, shorter sheet reaches.
  useLayoutEffect(() => { recompute(); }, [recompute]);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      // A hidden (display:none) pane reports 0 x 0: keep the last real size rather than drawing nothing.
      if (el.clientHeight > 0 && el.clientWidth > 0) { view.current = { w: el.clientWidth, h: el.clientHeight }; recompute(); }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [recompute]);

  // WHY the clamp: for one render after a different sheet arrives, `win` still belongs to the previous (possibly
  // bigger) sheet; the layout effect above corrects it before paint, but this render must not index past the end.
  const drawn = useMemo(() => {
    const w = expandForMerges(win, merges);
    const r1 = Math.min(w.r1, rowCount - 1), c1 = Math.min(w.c1, colCount - 1);
    return { r0: Math.min(w.r0, r1), r1, c0: Math.min(w.c0, c1), c1 };
  }, [win, merges, rowCount, colCount]);
  const pieces = useMemo(
    () => planGrid({ win: drawn, rowCount, colCount, rowOffsets: geo.rowOffsets, merges, mergeIndex: geo.mergeIndex, pins }),
    [drawn, rowCount, colCount, geo, merges, pins],
  );
  const header = useMemo(() => headerItems(drawn, colCount), [drawn, colCount]);

  // Measure the wrapped rows that are on screen (only those carry data-tall, so this is a handful of reads).
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let next: Map<number, number> | null = null;
    el.querySelectorAll<HTMLElement>('tr[data-tall]').forEach((tr) => {
      const r = Number(tr.getAttribute('data-r'));
      const h = tr.getBoundingClientRect().height;
      if (h > rowHeights[r] + 1) (next ??= new Map(fix)).set(r, Math.ceil(h));
    });
    if (next) setFix(next);
  }, [pieces, rowHeights, fix, setFix]);

  // ── Selection: a clicked cell (owned by the viewer, drawn as a ring) and a dragged / shift-clicked / select-all
  // rectangle (owned here). WHY by cell index and not the browser's own text selection: the cells a drag started
  // from can scroll out of the page and be removed, which would collapse a browser selection (review fix 2).
  const [range, setRange] = useState<CellRange | null>(null);
  useEffect(() => { setRange(null); }, [model]);
  const rangeRef = useRef(range); rangeRef.current = range;
  const selRef = useRef(sel); selRef.current = sel;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const cellAtPoint = useCallback((clientX: number, clientY: number): { r: number; c: number } | null => {
    const el = scrollerRef.current;
    if (!el) return null;
    const box = el.getBoundingClientRect();
    const x = clientX - box.left + el.scrollLeft - GUTTER_W;
    const y = clientY - box.top + el.scrollTop - HEADER_H;
    return { r: indexAt(geo.rowOffsets, Math.max(0, y)), c: indexAt(geo.colOffsets, Math.max(0, x)) };
  }, [geo]);

  const drag = useRef<{ anchor: { r: number; c: number }; moved: boolean; x: number; y: number; raf: number | null } | null>(null);
  useEffect(() => () => {
    if (drag.current?.raf != null) cancelAnimationFrame(drag.current.raf);
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const td = (e.target as Element).closest?.('td[data-r]');
    if (!td) return;
    const cell = { r: Number(td.getAttribute('data-r')), c: Number(td.getAttribute('data-c')) };
    scrollerRef.current?.focus({ preventScroll: true });
    // Shift+click: the rectangle from the selected cell to this one.
    if (e.shiftKey && selRef.current) {
      e.preventDefault();
      const a = selRef.current;
      setRange({ r0: Math.min(a.r, cell.r), c0: Math.min(a.c, cell.c), r1: Math.max(a.r, cell.r), c1: Math.max(a.c, cell.c) });
      return;
    }
    setRange(null);
    const d = { anchor: cell, moved: false, x: e.clientX, y: e.clientY, raf: null as number | null };
    drag.current = d;
    const el = scrollerRef.current;
    const extend = () => {
      const at = cellAtPoint(d.x, d.y);
      if (!at) return;
      if (!d.moved && at.r === d.anchor.r && at.c === d.anchor.c) return;
      if (!d.moved) {
        // the pointer left the first cell: this is a rectangle drag now, not text selection inside one cell
        d.moved = true;
        onSelectRef.current(d.anchor.r, d.anchor.c);
        window.getSelection()?.removeAllRanges();
        if (el) el.style.userSelect = 'none';
      }
      setRange({ r0: Math.min(d.anchor.r, at.r), c0: Math.min(d.anchor.c, at.c), r1: Math.max(d.anchor.r, at.r), c1: Math.max(d.anchor.c, at.c) });
    };
    // Scrolling while the pointer is held near or past an edge (the browser's own drag-scroll stops once the
    // text selection is cancelled above, and cells it started from may be gone anyway).
    const tick = () => {
      d.raf = null;
      if (!drag.current || !el) return;
      const box = el.getBoundingClientRect();
      const edge = 36;
      const dy = d.y < box.top + HEADER_H + edge ? d.y - (box.top + HEADER_H + edge) : d.y > box.bottom - edge ? d.y - (box.bottom - edge) : 0;
      const dx = d.x < box.left + GUTTER_W + edge ? d.x - (box.left + GUTTER_W + edge) : d.x > box.right - edge ? d.x - (box.right - edge) : 0;
      if (d.moved && (dx || dy)) {
        el.scrollTop += Math.max(-60, Math.min(60, dy / 2));
        el.scrollLeft += Math.max(-60, Math.min(60, dx / 2));
        extend();
      }
      d.raf = requestAnimationFrame(tick);
    };
    const move = (ev: MouseEvent) => { d.x = ev.clientX; d.y = ev.clientY; extend(); };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (d.raf != null) cancelAnimationFrame(d.raf);
      if (el) el.style.userSelect = '';
      drag.current = null;
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    d.raf = requestAnimationFrame(tick);
  }, [cellAtPoint]);

  const copy = useCallback((e: React.ClipboardEvent) => {
    const isCovered = (r: number, c: number) => geo.mergeIndex.covered.has(keyOf(r, c));
    const rg = rangeRef.current;
    let text: string | null = null;
    if (rg) text = rangeToTsv(model, isCovered, rg.r0, rg.c0, rg.r1, rg.c1);
    else if (selRef.current && !window.getSelection()?.toString()) text = rangeToTsv(model, isCovered, selRef.current.r, selRef.current.c, selRef.current.r, selRef.current.c);
    if (text == null) return; // text selected inside one cell: the browser's own copy is right
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
  }, [model, geo]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setRange({ r0: 0, c0: 0, r1: model.rowCount - 1, c1: model.colCount - 1 });
    } else if (e.key === 'Escape' && rangeRef.current) {
      setRange(null);
    }
  }, [model]);

  // ── Find: scroll to a cell and hand back its drawn <td> (artifact-find-bridge.ts).
  useImperativeHandle(handleRef, () => ({
    reveal: (r, c) => {
      const el = scrollerRef.current;
      if (!el) return Promise.resolve(null);
      const top = geo.rowOffsets[r] + HEADER_H, left = geo.colOffsets[c] + GUTTER_W;
      const h = rowHeights[r], w = colWidths[c];
      const { h: vh, w: vw } = view.current;
      const seen = top - el.scrollTop >= HEADER_H && top + h - el.scrollTop <= vh && left - el.scrollLeft >= GUTTER_W && left + w - el.scrollLeft <= vw;
      if (!seen) {
        el.scrollTop = Math.max(0, top - vh / 2);
        el.scrollLeft = Math.max(0, left - vw / 2);
      }
      recompute();
      return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
        res(el.querySelector<HTMLElement>(`td[data-r="${r}"][data-c="${c}"]`));
      })));
    },
  }), [geo, rowHeights, colWidths, recompute]);

  // One click handler for the whole table instead of one closure per cell: stable props keep the memoised rows
  // memoised, and a 200,000-cell sheet does not carry 200,000 handlers.
  const pick = useCallback((e: React.MouseEvent) => {
    const td = (e.target as Element).closest?.('td[data-r]');
    if (!td) return;
    onSelectRef.current(Number(td.getAttribute('data-r')), Number(td.getAttribute('data-c')));
  }, []);

  const totalW = GUTTER_W + geo.colOffsets[colCount];

  return (
    <div
      className="flex-1 overflow-auto" ref={scrollerRef} onScroll={recompute} tabIndex={0}
      onKeyDown={onKeyDown} onCopy={copy} style={{ position: 'relative', outline: 'none' }} {...scrollerProps}
    >
      <table
        style={{ borderCollapse: 'collapse', tableLayout: 'fixed', fontSize: 13, width: totalW }}
        aria-rowcount={rowCount + 1} aria-colcount={colCount + 1}
      >
        <colgroup>
          <col style={{ width: GUTTER_W }} />
          {colWidths.map((w, i) => <col key={i} style={{ width: w }} />)}
        </colgroup>
        <thead>
          <tr style={{ height: HEADER_H }} aria-rowindex={1}>
            <th style={gutterCornerStyle} aria-colindex={1} />
            {header.map((it, i) => it.kind === 'gap'
              ? <th key={`g${i}`} colSpan={it.span} style={{ ...gapCell, background: GUTTER_BG, position: 'sticky', top: 0, zIndex: 3 }} aria-hidden />
              : <th key={it.c} style={gutterTopStyle} aria-colindex={it.c + 2}>{colLetter(it.c + 1)}</th>)}
          </tr>
        </thead>
        <tbody onClick={pick} onMouseDown={onMouseDown} onContextMenu={selectOnContextMenu ? pick : undefined}>
          {pieces.map((p: GridPiece, i) => {
            if (p.kind === 'gap') return <tr key={`gap${i}`} aria-hidden style={{ height: p.height }}><td colSpan={colCount + 1} style={{ ...gapCell, height: p.height }} /></tr>;
            const inRange = range && p.r >= range.r0 && p.r <= range.r1;
            return (
              <Row
                key={p.r} r={p.r} height={rowHeights[p.r]} items={p.items} selCol={sel?.r === p.r ? sel.c : -1}
                rc0={inRange ? range.c0 : -1} rc1={inRange ? range.c1 : -1} model={model}
              />
            );
          })}
        </tbody>
      </table>
      {footer}
    </div>
  );
});
