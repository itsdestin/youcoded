import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, CSSProperties } from 'react';
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
import { PAPER, FBAR_BG, TAB_BG, GRID, SEL, NOTE_FG, NOTE_BG, largeSheetNote } from './sheet-theme';
import { SheetGrid, type GridCell, type Selection, type SheetGridModel } from './SheetGrid';
import { ROW_H, type MergeBox } from './sheet-window';
import { useDocComments } from '../../state/doc-comments-store';
import { MAX_FIND_CELLS, requestFindRewalk, useArtifactFindQuery } from './artifact-find-bridge';

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
  /** What SheetGrid draws: sizes, merges, and a per-visible-cell builder. */
  model: SheetGridModel;
  /** One cell, 1-based (the formula bar reads it). Built on first ask and kept. */
  cellAt: (r: number, c: number) => CellVM;
  truncated: boolean;
  rowsTruncated: boolean;
  colsTruncated: boolean;
}

// Sizing without drawing. WHY (Fix 2, 2026-10-04): the grid draws only the visible cells, so every column's width
// and every row's height has to be known up front. The old table let a column grow to fit its widest cell and a
// wrapped cell grow its row; both are reproduced here from the text length (about 7.2 px a character at 13 px).
const CHAR_PX = 7.2;
const CELL_PAD_PX = 18;
const MAX_FIT_COL_W = 400;   // a column never grows past this to fit text (the old table had no limit)
const LINE_H = 16;

/** The text a cell will roughly show, for sizing only (exact formatting happens per visible cell). */
function sizingText(v: any): string {
  if (v == null) return '';
  if (v instanceof Date) return '0000-00-00';
  if (typeof v === 'object') {
    if ('result' in v && v.result != null && typeof v.result !== 'object') return String(v.result);
    if ('richText' in v) return v.richText.map((t: any) => t.text).join('');
    if ('text' in v) return String(v.text);
    return '00000000'; // an unevaluated formula: about a number's width
  }
  return String(v);
}

// Exported only so tests can build a sheet from an in-memory workbook without parsing a file.
export function buildSheet(ws: any): SheetVM {
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

  // Column widths: the file's own width, widened to fit the text in the column (as the old table did by itself),
  // from ONE pass over the stored cells — and a note of the wrapped cells met on the way, for the row heights.
  const colWidths: number[] = [];
  for (let c = 1; c <= colCount; c++) colWidths.push(c <= usedCols ? colWidthToPx(ws.getColumn(c)?.width) : 80);
  const wrapped: Array<{ r: number; c: number; text: string }> = [];
  for (let r = 1; r <= usedRows; r++) {
    const row = ws.findRow(r);
    if (!row) continue;
    row.eachCell({ includeEmpty: false }, (cell: any, c: number) => {
      if (c > usedCols) return;
      const text = sizingText(cell.value);
      if (cell.alignment?.wrapText) { wrapped.push({ r, c, text }); return; } // wrapped text grows the ROW, not the column
      const w = Math.min(MAX_FIT_COL_W, Math.ceil(text.length * CHAR_PX + CELL_PAD_PX));
      if (w > colWidths[c - 1]) colWidths[c - 1] = w;
    });
  }
  // Row heights: a normal row is ROW_H; a row holding a wrapped cell is as tall as its most-wrapped cell needs.
  const rowHeights = new Array<number>(rowCount).fill(ROW_H);
  for (const { r, c, text } of wrapped) {
    const room = Math.max(20, colWidths[c - 1] - CELL_PAD_PX);
    let lines = 0;
    for (const part of text.split('\n')) lines += Math.max(1, Math.ceil((part.length * CHAR_PX) / room));
    if (lines > 1) rowHeights[r - 1] = Math.max(rowHeights[r - 1], lines * LINE_H + 8);
  }

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

  // WHY lazy (Fix 2): the old build made a view-model for EVERY cell up front — number formatting, style
  // conversion — which was most of the open time of a big sheet. Now a cell is made the first time it is drawn
  // (or asked for by the formula bar) and kept.
  const made = new Map<number, CellVM>();
  const blank = (r: number, c: number): CellVM => ({ r, c, display: '', css: {}, align: 'left', colSpan: 1, rowSpan: 1, formula: null });
  const cellAt = (r: number, c: number): CellVM => {
    const key = r * 4096 + c;
    const hit = made.get(key);
    if (hit) return hit;
    let vm: CellVM;
    // Padding cell (past the used range): an empty, gridlined, still-selectable cell — no ExcelJS getCell
    // (avoids bloating its model).
    if (r > usedRows || c > usedCols) {
      vm = blank(r, c);
    } else {
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
      const align: CellVM['align'] = (css.textAlign as any) || (isNumber ? 'right' : 'left');
      const span = merges.masters.get(`${r}:${c}`);
      vm = {
        r, c, display, css, align,
        colSpan: span?.colSpan ?? 1, rowSpan: span?.rowSpan ?? 1, formula: cell.formula ? `=${cell.formula}` : null,
      };
    }
    made.set(key, vm);
    return vm;
  };

  // Merge ranges as 0-based boxes for the grid (masters carry spans; the box is top-left plus its spans).
  const boxes: MergeBox[] = [];
  for (const [key, span] of merges.masters) {
    const [r, c] = key.split(':').map(Number);
    boxes.push({ r0: r - 1, c0: c - 1, r1: r - 1 + span.rowSpan - 1, c1: c - 1 + span.colSpan - 1 });
  }

  const model: SheetGridModel = {
    rowCount, colCount, colWidths, rowHeights, merges: boxes,
    // Find-in-document. Searches the shown text of cells already built and the stored value of the rest (building
    // all 200,000 cells' number formats on the first keystroke would freeze the app the windowing just saved), so
    // a number shown with a format ("50%", "1,234") is found when it is on screen but may be missed far away.
    findCells: (q, cap) => {
      const out: Array<[number, number]> = [];
      for (let r = 1; r <= usedRows && out.length < cap; r++) {
        const row = ws.findRow(r);
        if (!row) continue;
        row.eachCell({ includeEmpty: false }, (cell: any, c: number) => {
          if (out.length >= cap || c > usedCols || merges.covered.has(`${r}:${c}`)) return;
          const text = made.get(r * 4096 + c)?.display ?? sizingText(cell.value);
          if (text.toLowerCase().includes(q)) out.push([r - 1, c - 1]);
        });
      }
      return out;
    },
    cell: (r0, c0): GridCell => {
      const cell = cellAt(r0 + 1, c0 + 1);
      const style: CSSProperties = {
        borderTop: `1px solid ${GRID}`, borderRight: `1px solid ${GRID}`,
        borderBottom: `1px solid ${GRID}`, borderLeft: `1px solid ${GRID}`,
        padding: '2px 8px', lineHeight: `${LINE_H}px`, whiteSpace: 'nowrap', cursor: 'cell',
        overflow: 'hidden', textOverflow: 'ellipsis',
        textAlign: cell.align, fontVariantNumeric: cell.align === 'right' ? 'tabular-nums' : undefined,
        ...cell.css,
      };
      return { text: cell.display, style, addr: `${colLetter(c0 + 1)}${r0 + 1}` };
    },
  };
  return { name: ws.name || 'Sheet', model, cellAt, truncated, rowsTruncated, colsTruncated };
}

export function XlsxView({ absolutePath, path, commentsMode, onOpenComments, focusThreadId, projectRoot }: ArtifactViewProps) {
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
          projectRoot={projectRoot}
          source="sheet"
          fill
        >
          <XlsxSheets bytes={bytes} path={path} projectRoot={projectRoot} />
        </CommentableDocument>
      )}
    </BinaryContent>
  );
}

// Cell address "C4" -> 0-based [row, col]; null for anything else.
function parseAddr(addr: string | undefined): [number, number] | null {
  const m = addr?.match(/^([A-Z]+)(\d+)$/);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return [parseInt(m[2], 10) - 1, col - 1];
}

function XlsxSheets({ bytes, path, projectRoot }: { bytes: Uint8Array; path: string; projectRoot?: string }) {
  // The workbook's visible sheets as raw ExcelJS worksheets; each is turned into a SheetVM only when its tab is
  // shown (below) — building one means sizing its columns and rows, which is wasted on a tab nobody opens.
  const [sheets, setSheets] = useState<Array<{ name: string; ws: any }> | null>(null);
  const [active, setActive] = useState(0);
  const [sel, setSel] = useState<Selection | null>(null);
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
        const built = (visible.length ? visible : wb.worksheets).map((ws: any) => ({ name: ws.name || 'Sheet', ws }));
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

  const vmCache = useRef(new WeakMap<object, SheetVM>());
  const sheet = useMemo(() => {
    const entry = sheets?.[active];
    if (!entry) return undefined;
    let vm = vmCache.current.get(entry.ws);
    if (!vm) { vm = buildSheet(entry.ws); vmCache.current.set(entry.ws, vm); }
    return vm;
  }, [sheets, active]);
  // Formula bar contents for the selected cell: its formula if any, else value.
  const selInfo = useMemo(() => {
    if (!sheet || !sel) return { addr: '', content: '', isFormula: false };
    const vm = sheet.cellAt(sel.r + 1, sel.c + 1);
    return {
      addr: `${colLetter(sel.c + 1)}${sel.r + 1}`,
      content: vm.formula ?? vm.display ?? '',
      isFormula: !!vm.formula,
    };
  }, [sheet, sel]);

  // Cells that carry a comment stay in the page even when scrolled far from view: the comment highlighter finds
  // a cell by looking in the page, so a cell that was not drawn would read as "detached" and its card could not
  // scroll to it. A comment with no sheet name matches any tab (as the highlighter does).
  const { comments } = useDocComments(path, projectRoot);
  const pinKey = (comments ?? [])
    .filter((c) => c.cell && (!c.sheet || c.sheet === sheet?.name))
    .map((c) => c.cell).sort().join(',');
  const commentPins = useMemo(
    () => (pinKey ? pinKey.split(',').map(parseAddr).filter((p): p is [number, number] => !!p) : []),
    [pinKey],
  );
  // Ctrl+F: the cells matching what is typed stay in the page too (artifact-find-bridge.ts).
  // deferred so typing stays responsive while a big sheet is searched
  const findQuery = useDeferredValue(useArtifactFindQuery());
  const findPins = useMemo(() => (sheet && findQuery ? sheet.model.findCells(findQuery.toLowerCase(), MAX_FIND_CELLS) : []), [sheet, findQuery]);
  const pins = useMemo(() => (findPins.length ? [...commentPins, ...findPins] : commentPins), [commentPins, findPins]);
  useEffect(() => { if (findQuery) requestFindRewalk(); }, [findPins, findQuery]);
  const select = useCallback((r: number, c: number) => setSel({ r, c }), []);

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
      <SheetGrid
        model={sheet.model}
        sel={sel}
        onSelect={select}
        pins={pins}
        selectOnContextMenu
        scrollerProps={{ 'data-sheet': sheet.name, 'data-sheet-count': sheets.length }}
        footer={sheet.truncated && (
          // Wording shared with CsvView — see largeSheetNote in sheet-theme.ts.
          <div style={{ padding: '8px 12px', fontSize: 12, color: NOTE_FG, background: NOTE_BG }}>
            {largeSheetNote(sheet.rowsTruncated, sheet.colsTruncated, MAX_ROWS, MAX_COLS)}
          </div>
        )}
      />

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
