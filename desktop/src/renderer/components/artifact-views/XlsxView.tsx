import { useEffect, useMemo, useState, CSSProperties } from 'react';
import { Workbook } from 'exceljs';
import type { ArtifactViewProps } from './types';
import { BinaryContent } from './BinaryContent';
import {
  colLetter, formatCellNumber, cellRawValue, cellStyleToCss, colWidthToPx, parseMerges,
} from './exceljs-cell';
import { evalFormula, type CellValue } from './xlsx-formula';
// Theme-tinted "paper" constants shared with CsvView — see sheet-theme.ts.
// Doc comments (Destin, chat follow-up: Excel comments same as Word): cell
// comments share the markdown/Word comment layout; each <td> carries its
// address in data-cell so the comment's cell can be found and marked.
import { onSheetReveal } from '../comments/sheet-reveal';
import { CommentableDocument } from '../comments/CommentableDocument';
import { PAPER, GUTTER_BG, FBAR_BG, TAB_BG, GRID, GUTTER_FG, SEL, NOTE_FG, NOTE_BG, largeSheetNote } from './sheet-theme';

// Safety caps — agent sheets are small, but guard against a pathological file
// producing a million-cell DOM. Truncation is surfaced to the user.
const MAX_ROWS = 2000;
const MAX_COLS = 100;
// Pad the rendered grid with empty rows/cols past the used range so it reads like
// a real (effectively infinite) spreadsheet rather than a bare table floating in
// whitespace. Empty cells are still gridlined + selectable.
const MIN_ROWS = 50;
const MIN_COLS = 26; // A … Z


interface CellVM {
  r: number; c: number;
  display: string;
  css: CSSProperties;
  align: 'left' | 'right' | 'center';
  colSpan: number; rowSpan: number;
  formula: string | null;
}
interface SheetVM {
  name: string;
  colCount: number;
  colWidths: number[];      // px, index 0 unused (columns are 1-based)
  rows: { rowNum: number; cells: CellVM[] }[];
  byKey: Map<string, CellVM>;
  truncated: boolean;
  rowsTruncated: boolean;
  colsTruncated: boolean;
}

function buildSheet(ws: any): SheetVM {
  // usedRows/usedCols = the populated range; rowCount/colCount = what we RENDER
  // (padded out to the minimums so empty grid fills the panel).
  const usedRows = Math.min(ws.rowCount || 0, MAX_ROWS);
  const usedCols = Math.min(ws.columnCount || 0, MAX_COLS);
  const rowCount = Math.min(Math.max(usedRows, MIN_ROWS), MAX_ROWS);
  const colCount = Math.min(Math.max(usedCols, MIN_COLS), MAX_COLS);
  const rowsTruncated = (ws.rowCount || 0) > MAX_ROWS;
  const colsTruncated = (ws.columnCount || 0) > MAX_COLS;
  const truncated = rowsTruncated || colsTruncated;
  const merges = parseMerges(ws.model?.merges);

  const colWidths: number[] = [0];
  for (let c = 1; c <= colCount; c++) colWidths[c] = c <= usedCols ? colWidthToPx(ws.getColumn(c)?.width) : 80;

  // Formula resolution. Agent-generated files (openpyxl/pandas) store formulas
  // WITHOUT cached results, so we compute them ourselves to match what Excel
  // shows on open. resolveAddr is a memoized, cycle-guarded resolver: it prefers
  // a cached result when the file has one, otherwise evaluates the formula via
  // the lightweight engine (falling back to null on anything unsupported).
  const memo = new Map<string, CellValue>();
  const inProgress = new Set<string>();
  function resolveAddr(addr: string): CellValue {
    if (memo.has(addr)) return memo.get(addr)!;
    if (inProgress.has(addr)) return 0; // circular ref → treat as 0 (Excel errors; we degrade)
    inProgress.add(addr);
    let out: CellValue = null;
    const m = addr.match(/^([A-Z]+)(\d+)$/);
    if (m) {
      let col = 0;
      for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
      const row = parseInt(m[2], 10);
      if (row >= 1 && row <= usedRows && col >= 1 && col <= usedCols) {
        const cell = ws.getCell(row, col);
        const v = cell.value;
        if (v != null && typeof v === 'object' && !(v instanceof Date)) {
          if ('result' in v && (v as any).result != null && typeof (v as any).result !== 'object') {
            out = (v as any).result;
          } else if (cell.formula) {
            try { out = evalFormula(cell.formula, resolveAddr); } catch { out = null; }
          } else if ('richText' in v) {
            out = (v as any).richText.map((t: any) => t.text).join('');
          } else if ('text' in v) {
            out = String((v as any).text);
          }
        } else if (!(v instanceof Date)) {
          out = (v as number | string | boolean | null) ?? null;
        }
      }
    }
    inProgress.delete(addr);
    memo.set(addr, out);
    return out;
  }

  const rows: SheetVM['rows'] = [];
  const byKey = new Map<string, CellVM>();
  for (let r = 1; r <= rowCount; r++) {
    const cells: CellVM[] = [];
    for (let c = 1; c <= colCount; c++) {
      const key = `${r}:${c}`;
      if (merges.covered.has(key)) continue; // covered by a merge → skip
      // Padding cell (past the used range): render an empty, gridlined, still-
      // selectable cell — no ExcelJS getCell (avoids bloating its model).
      if (r > usedRows || c > usedCols) {
        cells.push({ r, c, display: '', css: {}, align: 'left', colSpan: 1, rowSpan: 1, formula: null });
        continue;
      }
      const cell = ws.getCell(r, c);
      const isFormula = !!cell.formula;
      // Formula cells: display the computed value (cached or evaluated), not the
      // raw { formula } object (which would stringify to "[object Object]").
      const resolved = isFormula ? resolveAddr(`${colLetter(c)}${r}`) : null;
      const display = isFormula
        ? formatCellNumber(resolved, cell.numFmt)
        : formatCellNumber(cell.value, cell.numFmt);
      const css = cellStyleToCss(cell);
      const isNumber = isFormula ? typeof resolved === 'number' : cellRawValue(cell.value).isNumber;
      const align: CellVM['align'] =
        (css.textAlign as any) || (isNumber ? 'right' : 'left');
      const span = merges.masters.get(key);
      const formula = cell.formula ? `=${cell.formula}` : null;
      const vm: CellVM = {
        r, c, display, css, align,
        colSpan: span?.colSpan ?? 1, rowSpan: span?.rowSpan ?? 1, formula,
      };
      cells.push(vm);
      byKey.set(key, vm);
    }
    rows.push({ rowNum: r, cells });
  }
  return { name: ws.name || 'Sheet', colCount, colWidths, rows, byKey, truncated, rowsTruncated, colsTruncated };
}

export function XlsxView({ absolutePath, path, commentsMode, onOpenComments, focusThreadId }: ArtifactViewProps) {
  // BinaryContent owns loading/error for the byte read and remounts the inner
  // component per file, so sheets/selection/parse errors reset on switch.
  return (
    <BinaryContent absolutePath={absolutePath} noun="spreadsheet">
      {(bytes) => (
        <CommentableDocument
          path={path}
          commentsMode={commentsMode}
          onOpenComments={onOpenComments}
          focusThreadId={focusThreadId}
          source="sheet"
          fill
        >
          <XlsxSheets bytes={bytes} path={path} />
        </CommentableDocument>
      )}
    </BinaryContent>
  );
}

function XlsxSheets({ bytes, path }: { bytes: Uint8Array; path: string }) {
  const [sheets, setSheets] = useState<SheetVM[] | null>(null);
  const [active, setActive] = useState(0);
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const wb = new Workbook();
        await wb.xlsx.load(bytes.buffer as any);
        if (cancelled) return;
        // Skip hidden/veryHidden worksheets like real Excel does (openpyxl
        // scratch sheets etc.). If EVERY sheet is hidden, fall back to showing
        // them all rather than an empty viewer.
        const visible = wb.worksheets.filter((ws: any) => ws.state !== 'hidden' && ws.state !== 'veryHidden');
        const built = (visible.length ? visible : wb.worksheets).map(buildSheet);
        setSheets(built.length ? built : null);
        setActive(0);
        setSel(null);
        setParseError(built.length ? null : 'empty');
      } catch (e: any) {
        if (!cancelled) setParseError(String(e?.message ?? e));
      }
    })();
    return () => { cancelled = true; };
  }, [bytes]);

  // A comment on another tab (its card clicked, or its chip) asks for that
  // tab to be shown so its cell can be found — comments/sheet-reveal.ts.
  useEffect(() => onSheetReveal(path, (name) => {
    const i = sheets?.findIndex((s) => s.name === name) ?? -1;
    if (i >= 0) { setActive(i); setSel(null); }
  }), [path, sheets]);

  const sheet = sheets?.[active];
  // Formula bar contents for the selected cell: its formula if any, else value.
  const selInfo = useMemo(() => {
    if (!sheet || !sel) return { addr: '', content: '', isFormula: false };
    const vm = sheet.byKey.get(`${sel.r}:${sel.c}`);
    return {
      addr: `${colLetter(sel.c)}${sel.r}`,
      content: vm?.formula ?? vm?.display ?? '',
      isFormula: !!vm?.formula,
    };
  }, [sheet, sel]);

  if (parseError || (sheets && !sheet)) return <Center>Couldn’t open this spreadsheet.</Center>;
  if (!sheets || !sheet) return <Center>Loading spreadsheet…</Center>;

  return (
    <div className="flex flex-col h-full" style={{ background: PAPER, color: '#1d1d1d' }}>
      {/* Formula bar — Name Box + fx + selected cell contents (reveals formulas). */}
      <div className="flex items-center gap-2 shrink-0" style={{ background: FBAR_BG, borderBottom: `1px solid ${GRID}`, padding: '5px 8px' }}>
        <span style={{ minWidth: 60, textAlign: 'center', fontSize: 12, background: '#ffffff', border: `1px solid ${GRID}`, borderRadius: 4, padding: '2px 6px' }}>
          {selInfo.addr || '—'}
        </span>
        <span style={{ color: '#999', fontStyle: 'italic', fontSize: 13, paddingRight: 6, borderRight: `1px solid ${GRID}` }}>fx</span>
        <span style={{ fontSize: 13, fontFamily: '"Cascadia Code", Consolas, monospace', color: selInfo.isFormula ? '#1a6dc4' : '#1d1d1d', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {selInfo.content}
        </span>
      </div>

      {/* Grid. data-sheet / data-sheet-count: which tab these cells belong to,
          so a cell comment on another tab never lands on this tab's C4
          (use-quote-marks.ts cellSelector), and the right-click menu can name
          the tab when there is more than one (build-menu.ts cellEntries). */}
      <div className="flex-1 overflow-auto" style={{ position: 'relative' }} data-sheet={sheet.name} data-sheet-count={sheets.length}>
        <table style={{ borderCollapse: 'collapse', fontSize: 13, width: 'max-content' }}>
          <colgroup>
            <col style={{ width: 38 }} />
            {Array.from({ length: sheet.colCount }, (_, i) => (
              <col key={i} style={{ width: sheet.colWidths[i + 1] }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th style={gutterCornerStyle} />
              {Array.from({ length: sheet.colCount }, (_, i) => (
                <th key={i} style={gutterTopStyle}>{colLetter(i + 1)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row) => (
              <tr key={row.rowNum}>
                <th style={gutterLeftStyle}>{row.rowNum}</th>
                {row.cells.map((cell) => {
                  const selected = sel?.r === cell.r && sel?.c === cell.c;
                  const style: CSSProperties = {
                    borderTop: `1px solid ${GRID}`, borderRight: `1px solid ${GRID}`,
                    borderBottom: `1px solid ${GRID}`, borderLeft: `1px solid ${GRID}`,
                    padding: '2px 8px', height: 24, whiteSpace: 'nowrap', cursor: 'cell',
                    textAlign: cell.align, fontVariantNumeric: cell.align === 'right' ? 'tabular-nums' : undefined,
                    ...cell.css,
                    ...(selected ? { outline: `2px solid ${SEL}`, outlineOffset: -2 } : null),
                  };
                  return (
                    <td
                      key={cell.c}
                      colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
                      rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
                      style={style}
                      data-cell={`${colLetter(cell.c)}${cell.r}`}
                      onClick={() => setSel({ r: cell.r, c: cell.c })}
                      // Right-click selects the cell too, so the formula bar
                      // shows which cell "Add comment" is about to attach to.
                      onContextMenu={() => setSel({ r: cell.r, c: cell.c })}
                    >
                      {cell.display}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {sheet.truncated && (
          // Wording shared with CsvView — see largeSheetNote in sheet-theme.ts.
          <div style={{ padding: '8px 12px', fontSize: 12, color: NOTE_FG, background: NOTE_BG }}>
            {largeSheetNote(sheet.rowsTruncated, sheet.colsTruncated, MAX_ROWS, MAX_COLS)}
          </div>
        )}
      </div>

      {/* Sheet tabs (bottom, like Excel) */}
      {sheets.length > 1 && (
        <div className="flex items-stretch shrink-0" style={{ background: TAB_BG, borderTop: `1px solid ${GRID}`, fontSize: 12 }}>
          {sheets.map((s, i) => (
            <button
              key={s.name + i}
              onClick={() => { setActive(i); setSel(null); }}
              style={{
                padding: '5px 16px', borderRight: `1px solid ${GRID}`,
                color: i === active ? SEL : '#555', fontWeight: i === active ? 600 : 400,
                background: i === active ? PAPER : 'transparent',
                borderTop: i === active ? `2px solid ${SEL}` : '2px solid transparent',
              }}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-center h-full text-fg-muted text-sm p-4">{children}</div>;
}

// Sticky gutter styles (column letters across the top, row numbers down the left).
const gutterBase: CSSProperties = {
  background: GUTTER_BG, color: GUTTER_FG, fontWeight: 500, textAlign: 'center',
  border: `1px solid ${GRID}`, userSelect: 'none', height: 24,
};
const gutterTopStyle: CSSProperties = { ...gutterBase, position: 'sticky', top: 0, zIndex: 3 };
const gutterLeftStyle: CSSProperties = { ...gutterBase, position: 'sticky', left: 0, zIndex: 2, minWidth: 38, width: 38 };
const gutterCornerStyle: CSSProperties = { ...gutterBase, position: 'sticky', top: 0, left: 0, zIndex: 4, minWidth: 38, width: 38 };
