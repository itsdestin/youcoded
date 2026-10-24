// The part of opening a spreadsheet that does NOT need the page: reading the file with ExcelJS (unzip + XML
// parse, ~1.8 s on a 200,000-row sheet) and keeping just the cells the viewer can ever show.
//
// WHY this exists (freeze hunt, 2026-10-24): XlsxView used to parse the whole workbook on the page's own
// thread, which froze the app window for as long as the parse took. The parse now runs in a Web Worker
// (xlsx-parse.worker.ts) and sends back only what the viewer reads — the viewer draws at most MAX_ROWS x MAX_COLS
// cells, so a 200,000-row sheet becomes ~2,000 rows of plain data. `PlainSheet` stands in for the ExcelJS
// worksheet: it answers exactly the questions XlsxView's `buildSheet` asks (rowCount, columnCount, merges,
// findRow/eachCell, getCell, getColumn), so the sheet is sized and drawn by the SAME code as before.
// No React / DOM here: it runs in a worker, in jsdom tests, and on the page (the fallback).

/** Keep in step with XlsxView's MAX_ROWS / MAX_COLS (it imports these, so they cannot drift). */
export const MAX_ROWS = 2000;
export const MAX_COLS = 100;

/** One stored cell, with only the fields XlsxView / cellStyleToCss / formatCellNumber read. */
export interface PlainCell {
  c: number;           // 1-based column
  /** ExcelJS `cell.type !== Null` — the page's eachCell({includeEmpty:false}) skips the rest. */
  ne: boolean;
  v: unknown;          // cell.value
  f?: string;          // cell.formula
  nf?: string;         // cell.numFmt
  al?: any; fo?: any; fi?: any; bo?: any; // alignment, font, fill, border
}
export interface PlainSheetData {
  name: string;
  rowCount: number;     // the file's real size (can be 200,000); the viewer clamps it itself
  columnCount: number;
  merges: string[] | undefined;
  /** column widths for columns 1..min(columnCount, MAX_COLS) */
  colWidths: Array<number | undefined>;
  /** sparse: index = row number (1-based) for rows 1..MAX_ROWS that hold any cell */
  rows: Array<PlainCell[] | undefined>;
}

/** ExcelJS Workbook -> plain, structured-clone-safe data for every sheet the viewer shows. */
export function extractSheets(wb: any): PlainSheetData[] {
  // Skip hidden/veryHidden worksheets like real Excel does (openpyxl scratch sheets etc.). If EVERY sheet is hidden,
  // fall back to showing them all rather than an empty viewer. (Moved here unchanged from XlsxView.)
  const visible = wb.worksheets.filter((ws: any) => ws.state !== 'hidden' && ws.state !== 'veryHidden');
  return (visible.length ? visible : wb.worksheets).map((ws: any): PlainSheetData => {
    const rowCount = ws.rowCount || 0;
    const columnCount = ws.columnCount || 0;
    const usedRows = Math.min(rowCount, MAX_ROWS);
    const usedCols = Math.min(columnCount, MAX_COLS);
    const rows: Array<PlainCell[] | undefined> = [];
    for (let r = 1; r <= usedRows; r++) {
      const row = ws.findRow(r);
      if (!row) continue;
      const cells: PlainCell[] = [];
      row.eachCell({ includeEmpty: true }, (cell: any, c: number) => {
        if (c > usedCols) return;
        const ne = cell.type !== 0 /* ValueType.Null */;
        const al = cell.alignment, fo = cell.font, fi = cell.fill, bo = cell.border, nf = cell.numFmt;
        // A blank cell with no look at all is exactly what getCell() returns for a missing one: leave it out.
        if (!ne && !al && !fo && !fi && !bo && !nf) return;
        cells.push({ c, ne, v: ne ? cell.value : null, f: cell.formula || undefined, nf, al, fo, fi, bo });
      });
      if (cells.length) rows[r] = cells;
    }
    const colWidths: Array<number | undefined> = [];
    for (let c = 1; c <= usedCols; c++) colWidths.push(ws.getColumn(c)?.width);
    return { name: ws.name || 'Sheet', rowCount, columnCount, merges: ws.model?.merges, colWidths, rows };
  });
}

const BLANK = Object.freeze({ value: null, formula: undefined, numFmt: undefined, alignment: undefined, font: undefined, fill: undefined, border: undefined });

/** A stand-in for an ExcelJS worksheet, built from `PlainSheetData` (see the file header). */
export class PlainSheet {
  readonly name: string;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly model: { merges: string[] | undefined };
  private readonly data: PlainSheetData;
  private readonly cells = new Map<number, any>();
  constructor(data: PlainSheetData) {
    this.data = data;
    this.name = data.name;
    this.rowCount = data.rowCount;
    this.columnCount = data.columnCount;
    this.model = { merges: data.merges };
  }
  private toCell(p: PlainCell): any {
    return { value: p.v, formula: p.f, numFmt: p.nf, alignment: p.al, font: p.fo, fill: p.fi, border: p.bo };
  }
  findRow(r: number): { eachCell: (opts: any, cb: (cell: any, c: number) => void) => void } | undefined {
    const row = this.data.rows[r];
    if (!row) return undefined;
    return {
      // Only called by the viewer with includeEmpty:false, which skips Null cells — the `ne` flag.
      eachCell: (_opts, cb) => { for (const p of row) if (p.ne) cb(this.cellFor(r, p), p.c); },
    };
  }
  private cellFor(r: number, p: PlainCell): any {
    const key = r * 4096 + p.c;
    let cell = this.cells.get(key);
    if (!cell) { cell = this.toCell(p); this.cells.set(key, cell); }
    return cell;
  }
  getCell(r: number, c: number): any {
    const p = this.data.rows[r]?.find((x) => x.c === c);
    return p ? this.cellFor(r, p) : BLANK;
  }
  getColumn(c: number): { width: number | undefined } | undefined {
    return { width: this.data.colWidths[c - 1] };
  }
}
