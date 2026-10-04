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
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { colLetter } from './exceljs-cell';
import { GRID, GUTTER_BG, GUTTER_FG, SEL } from './sheet-theme';
import {
  FALLBACK_VIEW, GUTTER_W, HEADER_H, expandForMerges, headerItems, indexMerges, planGrid, prefixSums, sameWin,
  windowFor, type GridPiece, type MergeBox, type MergeIndex, type RowItem, type Win,
} from './sheet-window';

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
  /** Cells whose text contains `qLower` (lower-case), in reading order, at most `cap` — for find-in-document. */
  findCells: (qLower: string, cap: number) => Array<[number, number]>;
}

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
  model: SheetGridModel;
}

// One drawn row. Memoised: scrolling adds rows at the edge but leaves the others alone, and a click redraws only
// the row losing the ring and the row gaining it (renderer-lists.md: a memoised row gets stable props).
const Row = memo(function Row({ r, height, items, selCol, model }: RowProps) {
  return (
    <tr style={{ height }}>
      <th style={{ ...gutterLeftStyle, height }}>{r + 1}</th>
      {items.map((it, i) => {
        // keyed by position for a gap (two gaps in a row can be the same width), by column for a cell
        if (it.kind === 'gap') return <td key={`g${i}`} colSpan={it.span} style={gapCell} />;
        const cell = model.cell(r, it.c);
        const style: CSSProperties = it.c === selCol ? { ...cell.style, outline: `2px solid ${SEL}`, outlineOffset: -2 } : cell.style;
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
          >
            {cell.text}
          </td>
        );
      })}
    </tr>
  );
}, (a, b) => a.r === b.r && a.height === b.height && a.selCol === b.selCol && a.model === b.model
  && a.items.length === b.items.length
  && a.items.every((x, i) => {
    const y = b.items[i];
    return x.kind === y.kind && (x.kind === 'gap' ? x.span === (y as typeof x).span
      : x.c === (y as typeof x).c && x.colSpan === (y as typeof x).colSpan && x.rowSpan === (y as typeof x).rowSpan);
  }));

export function SheetGrid({ model, sel, onSelect, pins = NO_PINS, scrollerProps, footer, selectOnContextMenu = false }: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const { rowCount, colCount, colWidths, rowHeights, merges } = model;

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

  // One click handler for the whole table instead of one closure per cell: stable props keep the memoised rows
  // memoised, and a 200,000-cell sheet does not carry 200,000 handlers.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const pick = useCallback((e: React.MouseEvent) => {
    const td = (e.target as Element).closest?.('td[data-r]');
    if (!td) return;
    onSelectRef.current(Number(td.getAttribute('data-r')), Number(td.getAttribute('data-c')));
  }, []);

  const totalW = GUTTER_W + geo.colOffsets[colCount];

  return (
    <div className="flex-1 overflow-auto" ref={scrollerRef} onScroll={recompute} style={{ position: 'relative' }} {...scrollerProps}>
      <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', fontSize: 13, width: totalW }}>
        <colgroup>
          <col style={{ width: GUTTER_W }} />
          {colWidths.map((w, i) => <col key={i} style={{ width: w }} />)}
        </colgroup>
        <thead>
          <tr style={{ height: HEADER_H }}>
            <th style={gutterCornerStyle} />
            {header.map((it, i) => it.kind === 'gap'
              ? <th key={`g${i}`} colSpan={it.span} style={{ ...gapCell, background: GUTTER_BG, position: 'sticky', top: 0, zIndex: 3 }} />
              : <th key={it.c} style={gutterTopStyle}>{colLetter(it.c + 1)}</th>)}
          </tr>
        </thead>
        <tbody onClick={pick} onContextMenu={selectOnContextMenu ? pick : undefined}>
          {pieces.map((p: GridPiece, i) => p.kind === 'gap'
            ? <tr key={`gap${i}`} aria-hidden style={{ height: p.height }}><td colSpan={colCount + 1} style={{ ...gapCell, height: p.height }} /></tr>
            : <Row key={p.r} r={p.r} height={rowHeights[p.r]} items={p.items} selCol={sel?.r === p.r ? sel.c : -1} model={model} />)}
        </tbody>
      </table>
      {footer}
    </div>
  );
}
