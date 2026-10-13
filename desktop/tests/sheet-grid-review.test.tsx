// @vitest-environment jsdom
// Review fixes 2-5 (2026-10-04) for the windowed spreadsheet viewers: the windowed grid must not lose copied data,
// give an incomplete or scroll-dependent Find, cut formatted text short, or disagree with itself about row heights.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { Workbook } from 'exceljs';
import { CsvView } from '../src/renderer/components/artifact-views/CsvView';
import { SheetGrid } from '../src/renderer/components/artifact-views/SheetGrid';
import { buildSheet } from '../src/renderer/components/artifact-views/XlsxView';
import { ContentFindBar } from '../src/renderer/components/ContentFindBar';
import { getSheetFind } from '../src/renderer/components/artifact-views/artifact-find-bridge';
import { formatCellNumber } from '../src/renderer/components/artifact-views/exceljs-cell';
import { ColumnFitter } from '../src/renderer/components/artifact-views/sheet-measure';
import type { ArtifactViewProps } from '../src/renderer/components/artifact-views/types';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const csvProps = (content: string): ArtifactViewProps => ({ path: 'big.csv', content, absolutePath: '/tmp/big.csv', isEditable: false });
const bigCsv = (rows: number, cols: number) =>
  Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => `r${r}c${c}`).join(',')).join('\n');
const scroller = (c: HTMLElement) => c.querySelector('table')!.parentElement as HTMLElement;
function scrollTo(el: HTMLElement, top: number, left = 0) {
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: top });
  Object.defineProperty(el, 'scrollLeft', { configurable: true, writable: true, value: left });
  act(() => { fireEvent.scroll(el); });
}
/** What Ctrl+C would put on the clipboard right now (null when the grid left copy to the browser). */
function copyText(el: HTMLElement): string | null {
  let got: string | null = null;
  fireEvent.copy(el, { clipboardData: { setData: (_t: string, v: string) => { got = v; } } });
  return got;
}
const colX = (container: HTMLElement, c: number) => {
  const widths = [...container.querySelectorAll('colgroup col')].slice(1).map((x) => parseFloat((x as HTMLElement).style.width));
  return 38 + widths.slice(0, c).reduce((a, b) => a + b, 0) + widths[c] / 2;
};

describe('copy returns the whole selection, from the data', () => {
  it('select all in a 2,000 x 100 sheet copies 2,000 lines of 100 fields, no blank lines', () => {
    const { container } = render(<CsvView {...csvProps(bigCsv(2000, 100))} />);
    const el = scroller(container);
    fireEvent.keyDown(el, { key: 'a', ctrlKey: true });
    const text = copyText(el)!;
    expect(text).not.toBeNull();
    const lines = text.split('\n');
    expect(lines).toHaveLength(2000);
    expect(lines.every((l) => l.split('\t').length === 100)).toBe(true);
    expect(lines[0].startsWith('r0c0\tr0c1\t')).toBe(true);
    expect(lines[1999].endsWith('\tr1999c99')).toBe(true);
  });

  it('a 500-row drag copies exactly the rectangle dragged', () => {
    const { container } = render(<CsvView {...csvProps(bigCsv(2000, 100))} />);
    const el = scroller(container);
    fireEvent.mouseDown(container.querySelector('td[data-r="10"][data-c="3"]')!, { button: 0, clientX: 300, clientY: 24 + 10 * 24 + 5 });
    fireEvent.mouseMove(window, { buttons: 1, clientX: colX(container, 6), clientY: 24 + 509 * 24 + 5 });
    fireEvent.mouseUp(window);
    const lines = copyText(el)!.split('\n');
    expect(lines).toHaveLength(500);
    expect(lines[0]).toBe('r10c3\tr10c4\tr10c5\tr10c6');
    expect(lines[499]).toBe('r509c3\tr509c4\tr509c5\tr509c6');
  });

  it('a drag whose first row scrolls out of the page still copies from where it began', () => {
    const { container } = render(<CsvView {...csvProps(bigCsv(2000, 100))} />);
    const el = scroller(container);
    fireEvent.mouseDown(container.querySelector('td[data-r="10"][data-c="0"]')!, { button: 0, clientX: 60, clientY: 24 + 10 * 24 + 5 });
    scrollTo(el, 24 * 1400);                 // the anchor row is no longer in the page
    expect(container.querySelector('td[data-r="10"]')).toBeNull();
    fireEvent.mouseMove(window, { buttons: 1, clientX: colX(container, 1), clientY: 200 });
    fireEvent.mouseUp(window);
    const lines = copyText(el)!.split('\n');
    expect(lines[0]).toBe('r10c0\tr10c1');
    expect(lines.length).toBeGreaterThan(1300);
    expect(lines.at(-1)!.startsWith('r')).toBe(true);
  });

  it('shift-click extends from the clicked cell', () => {
    const { container } = render(<CsvView {...csvProps(bigCsv(100, 10))} />);
    fireEvent.click(container.querySelector('td[data-r="2"][data-c="1"]')!);
    fireEvent.mouseDown(container.querySelector('td[data-r="4"][data-c="2"]')!, { button: 0, shiftKey: true });
    expect(copyText(scroller(container))).toBe('r2c1\tr2c2\nr3c1\tr3c2\nr4c1\tr4c2');
  });

  it('with nothing selected the browser keeps its own copy; one clicked cell copies its text', () => {
    const { container } = render(<CsvView {...csvProps(bigCsv(20, 5))} />);
    expect(copyText(scroller(container))).toBeNull();
    fireEvent.click(container.querySelector('td[data-r="3"][data-c="2"]')!);
    expect(copyText(scroller(container))).toBe('r3c2');
  });

  it('a range crossing merged cells keeps the columns lined up (the hidden cell is an empty field)', () => {
    const wb = new Workbook(); const ws = wb.addWorksheet('S');
    for (let r = 1; r <= 5; r++) ws.addRow(Array.from({ length: 6 }, (_, c) => `${r}-${c + 1}`));
    ws.mergeCells('B2:C3');
    const sheet = buildSheet(ws);
    const { container } = render(<SheetGrid model={sheet.model} sel={null} onSelect={() => {}} />);
    const el = scroller(container);
    fireEvent.keyDown(el, { key: 'a', ctrlKey: true });
    const lines = copyText(el)!.split('\n');
    expect(lines).toHaveLength(5);
    expect(lines.every((l) => l.split('\t').length === 6)).toBe(true);
    expect(lines[1]).toBe('2-1\t2-2\t\t2-4\t2-5\t2-6');   // B2 holds the merged cell's text; C2 is hidden under it
    expect(lines[2]).toBe('3-1\t\t\t3-4\t3-5\t3-6');      // both hidden under it
  });
});

describe('Find counts every match in the data and reaches each one', () => {
  function withBar(container: HTMLElement) {
    const ref = { current: container };
    return render(<ContentFindBar containerRef={ref} onClose={() => {}} resetKey="k" />);
  }
  const brute = (rows: number, cols: number, q: string) => {
    const out: Array<[number, number]> = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (`r${r}c${c}`.includes(q)) out.push([r, c]);
    return out;
  };

  it('a search with thousands of matches shows the true total and can reach the first, middle and last', async () => {
    const view = render(<CsvView {...csvProps(bigCsv(2000, 100))} />);
    const bar = withBar(view.container);
    fireEvent.change(bar.getByLabelText('Find in document'), { target: { value: 'r1' } });
    const want = brute(2000, 100, 'r1');
    expect(want.length).toBeGreaterThan(300);
    await act(async () => {});
    expect(bar.container.textContent).toContain(`1/${want.length}`);
    const find = getSheetFind()!;
    expect(find.search('r1')).toBe(want.length);
    for (const i of [0, 299, 300, Math.floor(want.length / 2), want.length - 1]) {
      const td = await find.reveal(i);
      expect([td?.getAttribute('data-r'), td?.getAttribute('data-c')]).toEqual([String(want[i][0]), String(want[i][1])]);
    }
  });

  it('the same search gives the same matches before and after scrolling', async () => {
    const view = render(<CsvView {...csvProps(bigCsv(2000, 100))} />);
    withBar(view.container);
    const find = getSheetFind()!;
    const before = find.search('c77');
    const first = await find.reveal(0);
    scrollTo(scroller(view.container), 24 * 1700, 3000);
    const after = find.search('c77');
    expect(after).toBe(before);
    expect((await find.reveal(0))?.textContent).toBe(first?.textContent);
  });

  it('XLSX: dates, percentages and formatted numbers far from view are found by what they show', () => {
    const wb = new Workbook(); const ws = wb.addWorksheet('Data');
    for (let r = 1; r <= 2000; r++) ws.addRow(Array.from({ length: 30 }, (_, c) => `v${r}-${c}`));
    const date = new Date(2024, 4, 17);
    ws.getCell('C1500').value = date; ws.getCell('C1500').numFmt = 'yyyy-mm-dd';
    ws.getCell('D1600').value = 0.5; ws.getCell('D1600').numFmt = '0%';
    ws.getCell('E1700').value = 1234567.891; ws.getCell('E1700').numFmt = '#,##0.00';
    ws.getCell('F1800').value = { formula: 'D1600*2', result: 1 } as any;
    const sheet = buildSheet(ws);
    const hit = (q: string) => sheet.model.findCells(q.toLowerCase());
    expect(hit(formatCellNumber(date, 'yyyy-mm-dd'))).toEqual([[1499, 2]]);
    expect(hit('50%')).toEqual([[1599, 3]]);
    expect(hit('1,234,567.89')).toEqual([[1699, 4]]);
    expect(hit('0000-00-00')).toEqual([]);      // the sizing stand-ins are never searched
    expect(hit('00000000')).toEqual([]);
  });
});

describe('columns are sized from what is shown', () => {
  it('a formatted number, a date and wide text get room; a number is never cut short', () => {
    const wb = new Workbook(); const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = 1234567890.123; ws.getCell('A1').numFmt = '#,##0.00';
    ws.getCell('B1').value = '日本語日本語日本語日本語'; // 12 wide glyphs
    ws.getCell('C1').value = 'ABCDEFGHIJKLM';          // capitals
    ws.getCell('D1').value = 'abcdefghijklm';          // same length, lower case
    ws.getCell('E1').value = 1e60; ws.getCell('E1').numFmt = '#,##0.00';   // a number far wider than any text cap
    ws.getCell('F1').value = 'x'.repeat(200);
    const { model } = buildSheet(ws);
    const w = model.colWidths;
    expect(w[0]).toBeGreaterThanOrEqual(110); // 16 shown characters, not the 8 of the stored number
    expect(w[1]).toBeGreaterThan(w[3] * 1.5);           // wide glyphs count double
    expect(w[2]).toBeGreaterThan(w[3]);                 // capitals are wider
    expect(w[4]).toBeGreaterThan(400);                  // a number is never held to the text cap
    expect(w[5]).toBe(400);                             // long text is capped...
    expect(model.cell(0, 5).title).toBe('x'.repeat(200)); // ...and keeps its full text on hover
  });

  it('the fitter measures only the widest-looking text per column', () => {
    const f = new ColumnFitter(2);
    for (let i = 0; i < 1000; i++) f.observe(0, 'a'.repeat(i % 20), false);
    expect(f.width(0, 80)).toBeGreaterThan(80);
    expect(f.width(1, 80)).toBe(80);
  });
});

describe('rows, accessibility and huge merges', () => {
  it('a wrapped row that draws taller than estimated is corrected so blank space and drawn rows agree', () => {
    const wb = new Workbook(); const ws = wb.addWorksheet('S');
    for (let r = 1; r <= 300; r++) ws.addRow(['a', 'b']);
    ws.getCell('A5').value = 'a few words that wrap'; ws.getCell('A5').alignment = { wrapText: true };
    const sheet = buildSheet(ws);
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return { height: this.hasAttribute('data-tall') ? 140 : 24, width: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
    });
    const { container } = render(<SheetGrid model={sheet.model} sel={null} onSelect={() => {}} />);
    spy.mockRestore?.();
    const trs = [...container.querySelectorAll('tbody > tr')] as HTMLElement[];
    const tall = trs.find((t) => t.getAttribute('data-r') === '4')!;
    expect(parseFloat(tall.style.height)).toBe(140);
    const total = trs.reduce((s, t) => s + parseFloat(t.style.height), 0);
    expect(total).toBe(sheet.model.rowCount * 24 + (140 - 24));
  });

  it('the table says how big the sheet is, rows and cells say where they are, spacers are hidden', () => {
    const { container } = render(<CsvView {...csvProps(bigCsv(2000, 100))} />);
    scrollTo(scroller(container), 24 * 800);
    const table = container.querySelector('table')!;
    expect(table.getAttribute('aria-rowcount')).toBe('2001');
    expect(table.getAttribute('aria-colcount')).toBe('101');
    expect(container.querySelector('tr[data-r="800"]')!.getAttribute('aria-rowindex')).toBe('802');
    expect(container.querySelector('td[data-r="800"][data-c="5"]')!.getAttribute('aria-colindex')).toBe('7');
    const gaps = [...container.querySelectorAll('tbody > tr')].filter((t) => !t.hasAttribute('data-r'));
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.every((g) => g.getAttribute('aria-hidden') === 'true')).toBe(true);
  });

  it('a merge covering the whole 2,000 x 100 sheet does not make the page draw everything', () => {
    const wb = new Workbook(); const ws = wb.addWorksheet('S');
    for (let r = 1; r <= 2000; r++) ws.addRow(Array.from({ length: 100 }, (_, c) => `${r}-${c}`));
    ws.mergeCells('A1:CV2000');
    const sheet = buildSheet(ws);
    const { container } = render(<SheetGrid model={sheet.model} sel={null} onSelect={() => {}} />);
    expect(container.querySelectorAll('td[data-r]').length).toBeLessThan(4000);
  });
});
