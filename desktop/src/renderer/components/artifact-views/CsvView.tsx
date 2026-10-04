// CsvView — spreadsheet-style grid for CSV/TSV files. Shares the theme-tinted
// "paper" visual language with XlsxView (sheet-theme.ts): column-letter + row-
// number gutters, gridlines, click-to-select, and padding out to a minimum
// grid so it reads like a sheet rather than a table floating in whitespace.
// CSV is TEXT — content arrives via the host's artifacts.get read (the same
// `content` prop MarkdownView/CodeView use); no binary IPC involved.
import { useCallback, useDeferredValue, useEffect, useMemo, useState, CSSProperties } from 'react';
import type { ArtifactViewProps } from './types';
import { detectDelimiter, parseDelimited } from './csv-parse';
import { PAPER, GRID, NOTE_FG, NOTE_BG, largeSheetNote } from './sheet-theme';
import { SheetGrid, type GridCell, type Selection, type SheetGridModel } from './SheetGrid';
import { ROW_H } from './sheet-window';
import { MAX_FIND_CELLS, requestFindRewalk, useArtifactFindQuery } from './artifact-find-bridge';

const MAX_ROWS = 2000;
// Safety cap — matches XlsxView (XlsxView.tsx:14-15). CSV rows have no upper
// bound on column count (a stray delimiter in one bad row inflates every
// row's max), so an agent-produced or malformed file could otherwise render
// a million-cell DOM. CsvView has no edit/save path, so clipping the display
// never loses data — the file on disk is untouched.
const MAX_COLS = 100;
const MIN_ROWS = 50;
const MIN_COLS = 26; // A … Z

// Column widths. WHY computed up front (Fix 2, 2026-10-04): the grid draws only the visible columns, so every
// column's width has to be known without drawing it. The old table let each column grow to fit its widest cell
// (between 110 and 300 px); this reproduces that from the text length (about 7.2 px a character at 13 px, plus
// the cell's padding), so columns come out as wide as before to within a few pixels.
const MIN_COL_W = 110;
const MAX_COL_W = 300;
const CHAR_PX = 7.2;
const CELL_PAD_PX = 18;
export function csvColumnWidths(rows: string[][], colCount: number): number[] {
  const longest = new Array<number>(colCount).fill(0);
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) if (row[c].length > longest[c]) longest[c] = row[c].length;
  }
  return longest.map((len) => Math.max(MIN_COL_W, Math.min(MAX_COL_W, Math.ceil(len * CHAR_PX + CELL_PAD_PX))));
}

// Right-align numeric cells like a real sheet.
const isNumeric = (v: string) => v !== '' && !Number.isNaN(Number(v));

export function CsvView({ path, content }: ArtifactViewProps) {
  const [sel, setSel] = useState<Selection | null>(null);

  const grid = useMemo(() => {
    if (content == null) return null;
    const ext = path.split('.').pop()?.toLowerCase();
    const rows = parseDelimited(content, detectDelimiter(content, ext));
    const rowsTruncated = rows.length > MAX_ROWS;
    const usedRows = rowsTruncated ? rows.slice(0, MAX_ROWS) : rows;
    const rawCols = usedRows.reduce((m, r) => Math.max(m, r.length), 0);
    const colsTruncated = rawCols > MAX_COLS;
    const usedCols = Math.min(rawCols, MAX_COLS);
    // Clip each row too, not just colCount — a 300-column row otherwise stays
    // in memory in full even though only 100 columns ever render.
    const used = colsTruncated ? usedRows.map((r) => r.slice(0, MAX_COLS)) : usedRows;
    const rowCount = Math.min(Math.max(used.length, MIN_ROWS), MAX_ROWS);
    const colCount = Math.max(usedCols, MIN_COLS);
    // Lower-cased once, on the first search (not on open): 200,000 short strings.
    let lower: string[][] | null = null;
    const model: SheetGridModel = {
      findCells: (q, cap) => {
        lower ??= used.map((row) => row.map((v) => v.toLowerCase()));
        const out: Array<[number, number]> = [];
        for (let r = 0; r < lower.length && out.length < cap; r++) {
          const row = lower[r];
          for (let c = 0; c < row.length && out.length < cap; c++) if (row[c].includes(q)) out.push([r, c]);
        }
        return out;
      },
      rowCount, colCount,
      colWidths: csvColumnWidths(used, colCount),
      rowHeights: new Array<number>(rowCount).fill(ROW_H),
      merges: [],
      // Built only for the cells actually drawn (SheetGrid asks per visible cell).
      cell: (r, c): GridCell => {
        const value = used[r]?.[c] ?? '';
        const numeric = isNumeric(value);
        const style: CSSProperties = {
          border: `1px solid ${GRID}`,
          padding: '2px 8px', lineHeight: '16px', whiteSpace: 'nowrap', cursor: 'cell',
          maxWidth: MAX_COL_W, overflow: 'hidden', textOverflow: 'ellipsis',
          textAlign: numeric ? 'right' : 'left',
          fontVariantNumeric: numeric ? 'tabular-nums' : undefined,
        };
        return { text: value, style, title: value.length > 40 ? value : undefined };
      },
    };
    return {
      model,
      truncated: rowsTruncated || colsTruncated,
      rowsTruncated,
      colsTruncated,
    };
  }, [content, path]);

  const select = useCallback((r: number, c: number) => setSel({ r, c }), []);

  // Ctrl+F: keep the cells that match what is typed in the page, so the find bar can count and reach them even
  // when they are far from what is on screen (artifact-find-bridge.ts), then ask it to look again.
  // deferred so typing stays responsive while a big sheet is searched
  const findQuery = useDeferredValue(useArtifactFindQuery());
  const pins = useMemo(() => (grid && findQuery ? grid.model.findCells(findQuery.toLowerCase(), MAX_FIND_CELLS) : []), [grid, findQuery]);
  useEffect(() => { if (findQuery) requestFindRewalk(); }, [pins, findQuery]);

  if (!grid) return <div className="flex items-center justify-center h-full text-fg-muted text-sm p-4">Loading…</div>;

  return (
    <div className="flex flex-col h-full" style={{ background: PAPER, color: '#1d1d1d' }}>
      <SheetGrid
        model={grid.model}
        sel={sel}
        onSelect={select}
        pins={pins}
        footer={grid.truncated && (
          // Same wording XlsxView shows for its own row/column cap (one shared
          // function), so the two spreadsheet-style viewers read as one behavior.
          <div style={{ padding: '8px 12px', fontSize: 12, color: NOTE_FG, background: NOTE_BG }}>
            {largeSheetNote(grid.rowsTruncated, grid.colsTruncated, MAX_ROWS, MAX_COLS)}
          </div>
        )}
      />
    </div>
  );
}
