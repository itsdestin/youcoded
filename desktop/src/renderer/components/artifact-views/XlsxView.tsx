import { useCallback, useEffect, useMemo, useRef, useState, CSSProperties } from 'react';
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
import { SheetGrid, type GridCell, type Selection, type SheetGridHandle, type SheetGridModel } from './SheetGrid';
import { ColumnFitter, fontsReady, useFontEpoch } from './sheet-measure';
import { ROW_H, type MergeBox } from './sheet-window';
import { useDocComments } from '../../state/doc-comments-store';
import { registerSheetFind, requestFindRewalk } from './artifact-find-bridge';

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
// wrapped cell grow its row; both are reproduced here from the text each cell will SHOW (review fix 4), with the
// widest-looking text per column measured by a canvas (sheet-measure.ts).
const CELL_PAD_PX = 18;
const CHAR_PX = 7.4;         // wrapped-row estimate only; the grid measures a wrapped row once drawn
const LINE_H = 16;
const SLICE_MS = 20;         // the build yields to the page about this often (see buildSheetAsync)

/** What a stored value looks like before formatting, for the long-text and wrapped-row estimates. */
function plainLength(text: string): number { return text.length; }

/**
 * Builds a sheet in small steps: a generator that yields between rows. WHY (review fix 3/4): formatting every
 * cell's shown text (needed to size columns from it, and for Find and copy) costs ~0.5 s on a 2,000 x 100 sheet.
 * `buildSheetAsync` runs it in ~20 ms slices so the app never freezes; `buildSheet` runs it straight through
 * (tests).
 */
function* buildSheetSteps(ws: any): Generator<void, SheetVM, void> {
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

  // The shown text of a cell and whether it is a number (right-aligned), exactly as the old table showed it.
  const showOf = (r: number, c: number, cell: any): { display: string; isNumber: boolean } => {
    const isFormula = !!cell.formula;
    // Formula cells: display the computed value (cached or evaluated), not the
    // raw { formula } object (which would stringify to "[object Object]").
    const resolved = isFormula ? resolveAddr(`${colLetter(c)}${r}`) : null;
    const display = isFormula ? formatCellNumber(resolved, cell.numFmt) : formatCellNumber(cell.value, cell.numFmt);
    const isNumber = isFormula ? typeof resolved === 'number' : cellRawValue(cell.value).isNumber;
    return { display, isNumber };
  };

  // ONE pass over the stored cells: shown text (kept, with a lower-case copy for Find), the width each column
  // needs, and the wrapped cells (for row heights).
  const texts: Array<Array<string | undefined> | undefined> = new Array(usedRows);
  const lowers: Array<Array<string | undefined> | undefined> = new Array(usedRows);
  const fit = new ColumnFitter(colCount);
  const wrapped: Array<{ r: number; c: number; text: string }> = [];
  let sliceStart = performance.now();
  for (let r = 1; r <= usedRows; r++) {
    const row = ws.findRow(r);
    if (row) {
      const rowTexts: Array<string | undefined> = [];
      const rowLowers: Array<string | undefined> = [];
      row.eachCell({ includeEmpty: false }, (cell: any, c: number) => {
        if (c > usedCols || merges.covered.has(`${r}:${c}`)) return; // a cell under a merge shows nothing
        const { display, isNumber } = showOf(r, c, cell);
        rowTexts[c - 1] = display;
        rowLowers[c - 1] = display.toLowerCase();
        const span = merges.masters.get(`${r}:${c}`);
        if (span && span.colSpan > 1) return; // a wide merged cell does not size one column
        if (cell.alignment?.wrapText) { wrapped.push({ r, c, text: display }); return; } // wrapped text grows the ROW
        fit.observe(c - 1, display, isNumber && !cell.alignment?.horizontal);
      });
      texts[r - 1] = rowTexts;
      lowers[r - 1] = rowLowers;
    }
    if (performance.now() - sliceStart > SLICE_MS) { yield; sliceStart = performance.now(); }
  }

  // Column widths: the file's own width, widened to fit the shown text (as the old table did by itself).
  const colWidths: number[] = [];
  for (let c = 1; c <= colCount; c++) colWidths.push(fit.width(c - 1, c <= usedCols ? colWidthToPx(ws.getColumn(c)?.width) : 80));
  // Row heights: a normal row is ROW_H; a row holding a wrapped cell gets an estimate (a minimum — the grid
  // measures the drawn row and corrects it).
  const rowHeights = new Array<number>(rowCount).fill(ROW_H);
  for (const { r, c, text } of wrapped) {
    const room = Math.max(20, colWidths[c - 1] - CELL_PAD_PX);
    let lines = 0;
    for (const part of text.split('\n')) lines += Math.max(1, Math.ceil((plainLength(part) * CHAR_PX) / room));
    if (lines > 1) rowHeights[r - 1] = Math.max(rowHeights[r - 1], lines * LINE_H + 8);
  }

  // WHY lazy for the rest (Fix 2): style conversion (fills, fonts, borders) is built only for cells actually
  // drawn (or asked for by the formula bar) and kept.
  const made = new Map<number, CellVM>();
  const textOf = (r: number, c: number): string => texts[r - 1]?.[c - 1] ?? '';
  const cellAt = (r: number, c: number): CellVM => {
    const key = r * 4096 + c;
    const hit = made.get(key);
    if (hit) return hit;
    let vm: CellVM;
    // Padding cell (past the used range): an empty, gridlined, still-selectable cell — no ExcelJS getCell
    // (avoids bloating its model).
    if (r > usedRows || c > usedCols) {
      vm = { r, c, display: '', css: {}, align: 'left', colSpan: 1, rowSpan: 1, formula: null };
    } else {
      const cell = ws.getCell(r, c);
      const covered = merges.covered.has(`${r}:${c}`);
      const css = cellStyleToCss(cell);
      const isNumber = covered ? false : showOf(r, c, cell).isNumber;
      const align: CellVM['align'] = (css.textAlign as any) || (isNumber ? 'right' : 'left');
      const span = merges.masters.get(`${r}:${c}`);
      vm = {
        r, c, display: covered ? '' : textOf(r, c), css, align,
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
    usedRows, usedCols,
    wrapRows: new Set(wrapped.map((w) => w.r - 1)),
    text: (r0, c0) => textOf(r0 + 1, c0 + 1),
    // Find-in-document: every cell's SHOWN text (dates, "50%", "1,234", formula results), lower-cased during the
    // build — so the answer never depends on what has been drawn or scrolled past.
    findCells: (q) => {
      const out: Array<[number, number]> = [];
      for (let r = 0; r < lowers.length; r++) {
        const row = lowers[r];
        if (!row) continue;
        for (let c = 0; c < row.length; c++) if (row[c] !== undefined && row[c]!.includes(q)) out.push([r, c]);
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
      // the full text on hover when it may not fit (the formula bar shows it in full too)
      return { text: cell.display, style, addr: `${colLetter(c0 + 1)}${r0 + 1}`, title: cell.display.length > 40 ? cell.display : undefined };
    },
  };
  return { name: ws.name || 'Sheet', model, cellAt, truncated, rowsTruncated, colsTruncated };
}

// Exported only so tests can build a sheet from an in-memory workbook without parsing a file.
export function buildSheet(ws: any): SheetVM {
  const it = buildSheetSteps(ws);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}

/** Thrown inside a build that was cancelled (the viewer closed, another file or tab opened). */
class BuildCancelled extends Error { constructor() { super('cancelled'); } }

/**
 * Hand the thread back to the page for one task. WHY not setTimeout(0): Chromium holds a nested zero-delay timer
 * to at least 4 ms, so ~25 slices cost 100+ ms of pure waiting. A scheduler task (or a message-channel hop) comes
 * straight back, and input events still run in between.
 */
let channel: MessageChannel | null = null;
export function yieldToPage(): Promise<void> {
  const sched = (globalThis as any).scheduler;
  if (sched?.postTask) return sched.postTask(() => undefined, { priority: 'user-visible' });
  if (typeof MessageChannel !== 'undefined') {
    channel ??= new MessageChannel();
    const ch = channel;
    return new Promise((res) => { ch.port1.onmessage = () => res(); ch.port2.postMessage(0); });
  }
  return new Promise((res) => setTimeout(res, 0));
}

/** The same build in ~20 ms slices, so a big sheet never freezes the page (it is shown as "Loading" meanwhile). */
export async function buildSheetAsync(ws: any, token: { cancelled: boolean } = { cancelled: false }): Promise<SheetVM> {
  // The widths are measured in the page's font: give a theme's web font a moment (bounded) to arrive first. A
  // font that arrives later re-sizes the sheet anyway (useFontEpoch).
  await fontsReady(1500);
  const it = buildSheetSteps(ws);
  for (;;) {
    if (token.cancelled) throw new BuildCancelled();
    const r = it.next();
    if (r.done) return r.value;
    await yieldToPage();
  }
}

/**
 * One build per worksheet at a time (asking again while one runs returns the same promise), and every build can be
 * stopped: cancelling flips a flag the loop checks each slice, so closing the viewer or opening another file stops
 * the work instead of letting it finish unseen.
 */
export function createSheetBuilder() {
  const jobs = new Map<object, { promise: Promise<SheetVM>; token: { cancelled: boolean } }>();
  return {
    get(ws: object): Promise<SheetVM> {
      let job = jobs.get(ws);
      if (!job) {
        const token = { cancelled: false };
        const made = { promise: buildSheetAsync(ws, token), token };
        job = made;
        jobs.set(ws, made);
        made.promise.then(() => { if (jobs.get(ws) === made) jobs.delete(ws); }, () => { if (jobs.get(ws) === made) jobs.delete(ws); });
      }
      return job.promise;
    },
    cancel(ws: object) { const j = jobs.get(ws); if (j) { j.token.cancelled = true; jobs.delete(ws); } },
    cancelAll() { for (const j of jobs.values()) j.token.cancelled = true; jobs.clear(); },
    inFlight: () => jobs.size,
  };
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

  // Built sheets, kept per worksheet (and per font epoch: a font or theme change re-sizes them). A tab is built (in
  // slices) the first time it is shown; one build at a time per sheet, stopped when the tab or file goes away.
  const epoch = useFontEpoch();
  const vmCache = useRef<{ epoch: number; map: WeakMap<object, SheetVM> }>({ epoch, map: new WeakMap() });
  if (vmCache.current.epoch !== epoch) vmCache.current = { epoch, map: new WeakMap() };
  const builder = useRef<ReturnType<typeof createSheetBuilder> | undefined>(undefined);
  builder.current ??= createSheetBuilder();
  const [, setBuiltTick] = useState(0);
  const entry = sheets?.[active];
  const sheet = entry ? vmCache.current.map.get(entry.ws) : undefined;
  useEffect(() => {
    if (!entry || vmCache.current.map.has(entry.ws)) return undefined;
    let live = true;
    const b = builder.current!;
    const map = vmCache.current.map;
    b.get(entry.ws).then((vm) => {
      map.set(entry.ws, vm);
      if (live) setBuiltTick((t) => t + 1);
    }).catch((e) => { if (live && !(e instanceof BuildCancelled)) setParseError(String(e?.message ?? e)); });
    return () => { live = false; b.cancel(entry.ws); };
  }, [entry, epoch]);
  useEffect(() => () => { builder.current?.cancelAll(); }, []);
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
  // Ctrl+F: the find bar counts matches in the sheet's data and asks the grid to scroll to match N
  // (artifact-find-bridge.ts).
  const gridRef = useRef<SheetGridHandle>(null);
  useEffect(() => {
    if (!sheet) return undefined;
    let q = '', matches: Array<[number, number]> = [];
    const off = registerSheetFind({
      search: (query) => { const lq = query.toLowerCase(); if (lq !== q) { q = lq; matches = sheet.model.findCells(lq); } return matches.length; },
      reveal: (i) => { const m = matches[i]; return m && gridRef.current ? gridRef.current.reveal(m[0], m[1]) : Promise.resolve(null); },
    });
    requestFindRewalk();
    return off;
  }, [sheet]);
  const select = useCallback((r: number, c: number) => setSel({ r, c }), []);

  if (parseError) return <Center>Couldn’t open this spreadsheet.</Center>;
  if (!sheets) return <Center>Loading spreadsheet…</Center>;

  return (
    <div className="flex flex-col h-full" style={{ background: PAPER, color: '#1d1d1d' }}>
      {/* Formula bar — Name Box + fx + selected cell contents (reveals formulas). */}
      <div className="flex items-center gap-2 shrink-0" style={{ background: FBAR_BG, borderBottom: `1px solid ${GRID}`, padding: '5px 8px' }}>
        <span style={{ minWidth: 60, textAlign: 'center', fontSize: 12, background: '#ffffff', border: `1px solid ${GRID}`, borderRadius: 4, padding: '2px 6px' }}>
          {selInfo.addr || '—'}
        </span>
        <span style={{ color: '#999', fontStyle: 'italic', fontSize: 13, paddingRight: 6, borderRight: `1px solid ${GRID}` }}>fx</span>
        {/* the whole value, wrapped (up to about four lines, then scrolls) — long text used to end in "…" */}
        <span style={{ fontSize: 13, fontFamily: '"Cascadia Code", Consolas, monospace', color: selInfo.isFormula ? '#1a6dc4' : '#1d1d1d', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 76, overflowY: 'auto', minWidth: 0 }}>
          {selInfo.content}
        </span>
      </div>

      {/* Grid. data-sheet / data-sheet-count: which tab these cells belong to,
          so a cell comment on another tab never lands on this tab's C4
          (use-quote-marks.ts cellSelector), and the right-click menu can name
          the tab when there is more than one (build-menu.ts cellEntries). */}
      {!sheet ? <div className="flex-1"><Center>Loading sheet…</Center></div> : (
      <SheetGrid
        ref={gridRef}
        model={sheet.model}
        sel={sel}
        onSelect={select}
        pins={commentPins}
        selectOnContextMenu
        scrollerProps={{ 'data-sheet': sheet.name, 'data-sheet-count': sheets.length }}
        footer={sheet.truncated && (
          // Wording shared with CsvView — see largeSheetNote in sheet-theme.ts.
          <div style={{ padding: '8px 12px', fontSize: 12, color: NOTE_FG, background: NOTE_BG }}>
            {largeSheetNote(sheet.rowsTruncated, sheet.colsTruncated, MAX_ROWS, MAX_COLS)}
          </div>
        )}
      />)}

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
