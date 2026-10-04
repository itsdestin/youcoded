// @vitest-environment jsdom
// Fix 2 (2026-10-04): a 2,000 x 100 sheet used to draw all 200,000 cells (205,030 page elements, 10 s to open,
// a 7 s freeze, 0.5 s per click, a 7 s freeze to close). The sheet viewers now draw only the visible rows and
// columns plus a margin, with blank space of the exact size standing in for the rest. These tests pin that
// bound (renderer-lists.md: big list in, bounded drawn, seen red with the bound removed) and every behaviour
// the windowing could have broken: scrolling, selection, merged cells, gutters, comment cells, wrapped rows.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { Workbook } from 'exceljs';
import { CsvView, csvColumnWidths } from '../src/renderer/components/artifact-views/CsvView';
import { ContentFindBar } from '../src/renderer/components/ContentFindBar';
import { MAX_FIND_CELLS, getFindQueryForTest, publishFindQuery } from '../src/renderer/components/artifact-views/artifact-find-bridge';
import { SheetGrid } from '../src/renderer/components/artifact-views/SheetGrid';
import { buildSheet } from '../src/renderer/components/artifact-views/XlsxView';
import {
  ROW_H, expandForMerges, indexMerges, planGrid, prefixSums, windowFor, type GridPiece, type MergeBox,
} from '../src/renderer/components/artifact-views/sheet-window';
import type { ArtifactViewProps } from '../src/renderer/components/artifact-views/types';

afterEach(cleanup);

// The drawn-cell bound. A screenful is ~35 rows x ~12 columns; with the margins and the step rounding the
// window is ~80 x ~25 = 2,000. 4,000 leaves headroom without letting a full draw (200,000) through.
const DRAWN_BOUND = 4000;

const csvProps = (content: string): ArtifactViewProps => ({ path: 'big.csv', content, absolutePath: '/tmp/big.csv', isEditable: false });
const bigCsv = (rows: number, cols: number) =>
  Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => `r${r}c${c}`).join(',')).join('\n');

const cellCount = (c: HTMLElement) => c.querySelectorAll('td[data-r]').length;
const drawnRows = (c: HTMLElement) => new Set([...c.querySelectorAll('td[data-r]')].map((td) => td.getAttribute('data-r')));
const scroller = (c: HTMLElement) => c.querySelector('table')!.parentElement as HTMLElement;

function scrollTo(el: HTMLElement, top: number, left = 0) {
  Object.defineProperty(el, 'scrollTop', { configurable: true, value: top });
  Object.defineProperty(el, 'scrollLeft', { configurable: true, value: left });
  act(() => { fireEvent.scroll(el); });
}

describe('CSV viewer draws only what can be seen', () => {
  it('a 2,000 x 100 file draws a bounded number of cells, not 200,000', () => {
    const { container } = render(<CsvView {...csvProps(bigCsv(2000, 100))} />);
    const n = cellCount(container);
    expect(n).toBeGreaterThan(100);       // it does draw a screenful
    expect(n).toBeLessThan(DRAWN_BOUND);  // and nowhere near everything
    // the full column strip is still there (the scrollbar and widths depend on it)
    expect(container.querySelectorAll('colgroup col').length).toBe(101);
  });

  it('scrolling far down draws the rows there and lets go of the ones left behind', () => {
    const { container } = render(<CsvView {...csvProps(bigCsv(2000, 100))} />);
    expect(drawnRows(container).has('0')).toBe(true);
    scrollTo(scroller(container), 24 * 1200);
    const rows = drawnRows(container);
    expect(rows.has('1200')).toBe(true);
    expect(rows.has('0')).toBe(false);
    expect(cellCount(container)).toBeLessThan(DRAWN_BOUND);
    // and the last row is reachable
    scrollTo(scroller(container), 24 * 1990);
    expect(drawnRows(container).has('1999')).toBe(true);
  });

  it('scrolling sideways draws the columns there', () => {
    const { container } = render(<CsvView {...csvProps(bigCsv(300, 100))} />);
    expect(container.querySelector('td[data-c="90"]')).toBeNull();
    scrollTo(scroller(container), 0, 38 + 110 * 90);
    expect(container.querySelector('td[data-r="0"][data-c="90"]')?.textContent).toBe('r0c90');
    expect(cellCount(container)).toBeLessThan(DRAWN_BOUND);
  });

  it('the blank space keeps the sheet exactly as tall as a full draw would be', () => {
    const { container } = render(<CsvView {...csvProps(bigCsv(2000, 100))} />);
    scrollTo(scroller(container), 24 * 700);
    const rows = [...container.querySelectorAll('tbody > tr')];
    let total = 0;
    for (const tr of rows) {
      const h = parseFloat((tr as HTMLElement).style.height);
      total += h;
    }
    expect(total).toBe(2000 * ROW_H);
  });

  it('shows the same cells, row numbers and column letters as before', () => {
    const { container } = render(<CsvView {...csvProps('a,b\n1,2\n')} />);
    expect(container.querySelector('td[data-r="0"][data-c="0"]')?.textContent).toBe('a');
    expect(container.querySelector('td[data-r="1"][data-c="1"]')?.textContent).toBe('2');
    const letters = [...container.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(letters.slice(0, 4)).toEqual(['', 'A', 'B', 'C']);
    expect(container.querySelector('tbody th')?.textContent).toBe('1');
    // numbers right-aligned, text left
    expect((container.querySelector('td[data-r="1"][data-c="0"]') as HTMLElement).style.textAlign).toBe('right');
    expect((container.querySelector('td[data-r="0"][data-c="0"]') as HTMLElement).style.textAlign).toBe('left');
    // still padded out to a sheet-sized grid
    expect(container.querySelectorAll('colgroup col').length).toBe(27);
  });

  it('clicking a cell rings that cell only, and moving the click moves the ring', () => {
    const { container } = render(<CsvView {...csvProps(bigCsv(100, 10))} />);
    const ringed = () => [...container.querySelectorAll('td[data-r]')].filter((td) => (td as HTMLElement).style.outline);
    expect(ringed()).toHaveLength(0);
    fireEvent.click(container.querySelector('td[data-r="3"][data-c="2"]')!);
    expect(ringed().map((td) => td.getAttribute('data-r') + ',' + td.getAttribute('data-c'))).toEqual(['3,2']);
    fireEvent.click(container.querySelector('td[data-r="7"][data-c="5"]')!);
    expect(ringed().map((td) => td.getAttribute('data-r') + ',' + td.getAttribute('data-c'))).toEqual(['7,5']);
  });

  it('a long cell still shows its full text on hover, and wide columns widen to fit as the old table did', () => {
    const long = 'x'.repeat(120);
    const { container } = render(<CsvView {...csvProps(`${long},b\n1,2`)} />);
    expect(container.querySelector('td[data-r="0"][data-c="0"]')?.getAttribute('title')).toBe(long);
    expect(csvColumnWidths([[long, 'b']], 3)).toEqual([300, 110, 110]); // capped at 300, floor 110
  });
});

describe('the window arithmetic', () => {
  const rowOffsets = prefixSums(new Array(2000).fill(ROW_H));
  const colOffsets = prefixSums(new Array(100).fill(110));

  it('draws a bounded window anywhere in a 2,000 x 100 sheet', () => {
    for (const top of [0, 5000, 24000, 47000, 1e9]) {
      const w = windowFor(rowOffsets, colOffsets, top, top / 10, 800, 1200);
      expect((w.r1 - w.r0 + 1) * (w.c1 - w.c0 + 1)).toBeLessThan(DRAWN_BOUND);
      expect(w.r0).toBeGreaterThanOrEqual(0);
      expect(w.r1).toBeLessThanOrEqual(1999);
    }
  });

  it('every drawn row accounts for every column, with merged cells and pinned far cells', () => {
    const merges: MergeBox[] = [{ r0: 5, c0: 2, r1: 7, c1: 4 }, { r0: 900, c0: 1, r1: 900, c1: 3 }];
    const idx = indexMerges(merges);
    const win = expandForMerges({ r0: 6, r1: 40, c0: 3, c1: 20 }, merges); // touches the first merge only
    expect(win.r0).toBe(5);  // grown to hold the whole merged cell
    expect(win.c0).toBe(2);
    const pieces = planGrid({ win, rowCount: 2000, colCount: 100, rowOffsets, merges, mergeIndex: idx, pins: [[900, 1], [1500, 60]] });
    const rows = pieces.filter((p): p is Extract<GridPiece, { kind: 'row' }> => p.kind === 'row');
    expect(rows.map((r) => r.r)).toContain(900);   // pinned rows are drawn
    expect(rows.map((r) => r.r)).toContain(1500);
    const r1500 = rows.find((r) => r.r === 1500)!;
    expect(r1500.items.some((i) => i.kind === 'cell' && i.c === 60)).toBe(true);
    // total height of blank + drawn rows is the whole sheet
    const height = pieces.reduce((s, p) => s + (p.kind === 'gap' ? p.height : ROW_H), 0);
    expect(height).toBe(2000 * ROW_H);
    // each row's items cover the 100 columns exactly once, counting the slots a merged cell above reserves
    for (const row of rows) {
      let slots = 0;
      for (const it of row.items) slots += it.kind === 'gap' ? it.span : it.colSpan;
      // the covered-by-a-merge-above slots (rows 6-7, cols 2-4) are reserved by the browser, not drawn here
      const reserved = row.r === 6 || row.r === 7 ? 3 : 0;
      expect(slots + reserved).toBe(100);
    }
  });
});

describe('XLSX viewer model', () => {
  async function bigSheet() {
    const wb = new Workbook();
    const ws = wb.addWorksheet('Data');
    for (let r = 1; r <= 2000; r++) ws.addRow(Array.from({ length: 100 }, (_, c) => (r + c) % 5 === 0 ? `item-${r}-${c}` : r * c));
    ws.mergeCells('B2:D3');
    ws.getCell('A10').value = 'a long piece of wrapped text that needs several lines to show';
    ws.getCell('A10').alignment = { wrapText: true };
    ws.getColumn(1).width = 8;
    ws.getCell('F1').value = 'a really quite wide heading that must not be clipped by the column';
    return buildSheet(ws);
  }

  it('draws a bounded number of cells for a 2,000 x 100 workbook, merged cell and cell addresses intact', async () => {
    const sheet = await bigSheet();
    const { container } = render(<SheetGrid model={sheet.model} sel={null} onSelect={() => {}} />);
    expect(cellCount(container)).toBeLessThan(DRAWN_BOUND);
    const merged = container.querySelector('td[data-cell="B2"]') as HTMLElement;
    expect(merged.getAttribute('colspan')).toBe('3');
    expect(merged.getAttribute('rowspan')).toBe('2');
    expect(container.querySelector('td[data-cell="C2"]')).toBeNull(); // covered by the merge, as before
    expect(container.querySelector('td[data-cell="A1"]')?.textContent).toBe('0'); // row 1, column A: 1 * 0
  });

  it('a cell with a comment stays in the page when scrolled far away (the highlighter finds it by looking)', async () => {
    const sheet = await bigSheet();
    const { container } = render(<SheetGrid model={sheet.model} sel={null} onSelect={() => {}} pins={[[1500, 60]]} />);
    expect(container.querySelector('td[data-cell="BI1501"]')).not.toBeNull();
    expect(container.querySelector('td[data-cell="BI1500"]')).toBeNull(); // its neighbour is not
    expect(cellCount(container)).toBeLessThan(DRAWN_BOUND);
  });

  it('sizes without drawing: wide text widens its column, wrapped text makes its row taller', async () => {
    const sheet = await bigSheet();
    const { colWidths, rowHeights } = sheet.model;
    expect(colWidths[5]).toBeGreaterThan(300);        // column F fits its long heading
    expect(colWidths[0]).toBeLessThan(colWidths[5]);  // column A kept its narrow declared width (or near it)
    expect(rowHeights[9]).toBeGreaterThan(ROW_H);     // row 10 holds the wrapped cell
    expect(rowHeights[0]).toBe(ROW_H);
    expect(sheet.model.rowCount).toBe(2000);
  });

  it('builds cells only when asked (a 200,000-cell sheet is not formatted up front)', async () => {
    const sheet = await bigSheet();
    let asked = 0;
    const model = { ...sheet.model, cell: (r: number, c: number) => { asked++; return sheet.model.cell(r, c); } };
    render(<SheetGrid model={model} sel={null} onSelect={() => {}} />);
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThan(DRAWN_BOUND);
  });
});


// Ctrl+F searches the page's text. A sheet draws only what is visible, so matches far away must be kept in the
// page for the find bar to count and reach them.
describe('find-in-document still reaches every part of a big sheet', () => {
  afterEach(() => act(() => publishFindQuery('')));

  it('a match far below the visible rows is put in the page, and leaves again when the search is cleared', () => {
    const { container } = render(<CsvView {...csvProps(bigCsv(2000, 100))} />);
    expect(container.querySelector('td[data-r="1500"][data-c="60"]')).toBeNull();
    act(() => publishFindQuery('R1500C60'));            // case does not matter
    expect(container.querySelector('td[data-r="1500"][data-c="60"]')?.textContent).toBe('r1500c60');
    expect(cellCount(container)).toBeLessThan(DRAWN_BOUND);
    act(() => publishFindQuery(''));
    expect(container.querySelector('td[data-r="1500"][data-c="60"]')).toBeNull();
  });

  it('a search matching thousands of cells keeps only the first batch, in reading order, in the page', () => {
    const { container } = render(<CsvView {...csvProps(bigCsv(2000, 100))} />);
    act(() => publishFindQuery('r1'));   // matches ~half the sheet
    expect(cellCount(container)).toBeLessThan(DRAWN_BOUND + 300 * 30);
    // the reachable matches are the first ones (top of the sheet), not an arbitrary spread
    const rows = [...drawnRows(container)].map(Number);
    expect(Math.max(...rows)).toBeLessThan(400);
  });

  it('XLSX: finds cells by their text anywhere in the workbook', async () => {
    const wb = new Workbook(); const ws = wb.addWorksheet('Data');
    for (let r = 1; r <= 2000; r++) ws.addRow(Array.from({ length: 30 }, (_, c) => `v${r}-${c}`));
    const sheet = buildSheet(ws);
    expect(sheet.model.findCells('v1500-7', MAX_FIND_CELLS)).toEqual([[1499, 7]]);
    expect(sheet.model.findCells('v1-', 5)).toHaveLength(5); // capped
    expect(sheet.model.findCells('no such text', 5)).toEqual([]);
  });

  it('the find bar publishes what is typed, and "" when it closes', () => {
    const ref = { current: document.createElement('div') };
    const { getByLabelText, unmount } = render(<ContentFindBar containerRef={ref} onClose={() => {}} resetKey="a" />);
    fireEvent.change(getByLabelText('Find in document'), { target: { value: 'abc' } });
    expect(getFindQueryForTest()).toBe('abc');
    unmount();
    expect(getFindQueryForTest()).toBe('');
  });

  it('the chat timeline\'s find bar does not publish (its search is its own)', () => {
    const ref = { current: document.createElement('div') };
    const { getByLabelText } = render(<ContentFindBar containerRef={ref} onClose={() => {}} resetKey="a" highlightName="chat-find" placeholder="Find in chat" />);
    fireEvent.change(getByLabelText('Find in chat'), { target: { value: 'zzz' } });
    expect(getFindQueryForTest()).toBe('');
  });
});
