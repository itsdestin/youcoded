// @vitest-environment jsdom
// Second review round for the windowed spreadsheet viewers: a merged cell's value stays readable, Find stays marked
// while scrolling and works without the CSS Highlight API, wrapped rows are measured both ways, builds are cheap to
// start and possible to stop, and the selection / copy edge cases.
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { Workbook } from 'exceljs';
import { CsvView } from '../src/renderer/components/artifact-views/CsvView';
import { SheetGrid } from '../src/renderer/components/artifact-views/SheetGrid';
import { buildSheet, buildSheetAsync, createSheetBuilder } from '../src/renderer/components/artifact-views/XlsxView';
import { ContentFindBar } from '../src/renderer/components/ContentFindBar';
import { getSheetFind, notifySheetDrawn } from '../src/renderer/components/artifact-views/artifact-find-bridge';
import { buildContextMenu } from '../src/renderer/components/context-menu/build-menu';
import { rangeToTsv } from '../src/renderer/components/artifact-views/sheet-copy';
import type { ArtifactViewProps } from '../src/renderer/components/artifact-views/types';

const csvProps = (content: string): ArtifactViewProps => ({ path: 'big.csv', content, absolutePath: '/tmp/big.csv', isEditable: false });
const bigCsv = (rows: number, cols: number) =>
  Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => `r${r}c${c}`).join(',')).join('\n');
const scroller = (c: HTMLElement) => c.querySelector('table')!.parentElement as HTMLElement;
function scrollTo(el: HTMLElement, top: number, left = 0) {
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: top });
  Object.defineProperty(el, 'scrollLeft', { configurable: true, writable: true, value: left });
  act(() => { fireEvent.scroll(el); });
}
const settle = (ms = 120) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
function copyText(el: HTMLElement): string | null {
  let got: string | null = null;
  fireEvent.copy(el, { clipboardData: { setData: (_t: string, v: string) => { got = v; } } });
  return got;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); delete (globalThis as any).CSS; delete (window as any).Highlight; window.getSelection()?.removeAllRanges(); });

/** A stand-in for the CSS Highlight API, so a test can read what was marked. */
function installHighlights() {
  const map = new Map<string, { ranges: Range[] }>();
  (globalThis as any).CSS = { highlights: map };
  (window as any).Highlight = class { ranges: Range[]; constructor(...r: Range[]) { this.ranges = r; } };
  return map;
}
const withBar = (container: HTMLElement) => render(<ContentFindBar containerRef={{ current: container }} onClose={() => {}} resetKey="k" />);

describe('a merged cell stays readable wherever any part of it shows', () => {
  it('a merge too big to draw whole, scrolled so its top-left is gone, still shows its text', () => {
    const wb = new Workbook(); const ws = wb.addWorksheet('S');
    for (let r = 1; r <= 400; r++) ws.addRow(Array.from({ length: 30 }, (_, c) => `${r}-${c}`));
    ws.getCell('A1').value = 'MASTER VALUE';
    ws.mergeCells('A1:Z200');   // 5,200 cells: over the draw-whole limit
    const sheet = buildSheet(ws);
    const { container } = render(<SheetGrid model={sheet.model} sel={null} onSelect={() => {}} />);
    scrollTo(scroller(container), 24 * 120);
    expect(container.querySelector('td[data-r="0"]')).toBeNull();           // the top-left row is not drawn
    const shows = [...container.querySelectorAll('td')].filter((td) => td.textContent === 'MASTER VALUE');
    expect(shows).toHaveLength(1);
    expect(shows[0].getAttribute('data-cell')).toBe('A1');                   // it IS the merged cell's own address
    expect(Number(shows[0].getAttribute('rowspan'))).toBeGreaterThan(5);     // drawn as one tall cell, not scraps
  });
});

describe('Find marks what is on screen, also after scrolling, and only data cells', () => {
  it('marks matches in data cells only, re-marks rows that mount while scrolling, and marks the current match', async () => {
    const marks = installHighlights();
    const view = render(<CsvView {...csvProps(bigCsv(2000, 100))} />);
    const bar = withBar(view.container);
    fireEvent.change(bar.getByLabelText('Find in document'), { target: { value: '1' } });
    await settle();
    const all = () => marks.get('artifact-find')!.ranges;
    expect(all().length).toBeGreaterThan(50);
    // row numbers / column letters hold "1" too and are not counted, so they are not marked
    expect(all().every((r) => !!(r.startContainer.parentElement as HTMLElement).closest('td[data-r]'))).toBe(true);
    expect(marks.get('artifact-find-current')?.ranges).toHaveLength(1);
    // scroll far down: rows that mount now must be marked too (no Next / Previous pressed)
    scrollTo(scroller(view.container), 24 * 1300);
    act(() => notifySheetDrawn());
    await settle();
    const texts = all().map((r) => r.startContainer.textContent ?? '');
    expect(texts.some((t) => /^r13\d\dc/.test(t))).toBe(true);
    expect(texts.some((t) => /^r0c/.test(t))).toBe(false);
  });

  it('without the Highlight API the count is right, Next scrolls there, and the current cell gets an outline', async () => {
    const view = render(<CsvView {...csvProps(bigCsv(2000, 100))} />);
    const bar = withBar(view.container);
    const input = bar.getByLabelText('Find in document');
    fireEvent.change(input, { target: { value: 'r1999c99' } });
    await settle();
    expect(bar.container.textContent).toContain('1/1');
    expect(getSheetFind()!.search('r1999c99')).toBe(1);
    fireEvent.change(input, { target: { value: 'r1500c' } });
    await settle();
    expect(bar.container.textContent).toContain('/100');
    fireEvent.keyDown(input, { key: 'Enter' });
    await settle(250);
    const marked = [...view.container.querySelectorAll<HTMLElement>('td[data-r]')].filter((td) => td.style.boxShadow);
    expect(marked).toHaveLength(1);
    expect(marked[0].textContent).toBe('r1500c1');
    // clearing the search clears the outline
    fireEvent.change(input, { target: { value: '' } });
    await settle();
    expect([...view.container.querySelectorAll<HTMLElement>('td[data-r]')].some((td) => td.style.boxShadow)).toBe(false);
  });
});

describe('wrapped rows are measured whichever way the estimate was wrong', () => {
  const heightOf = (c: HTMLElement, r: number) => parseFloat((c.querySelector(`tr[data-r="${r}"]`) as HTMLElement).style.height);
  function wrapSheet() {
    const wb = new Workbook(); const ws = wb.addWorksheet('S');
    for (let r = 1; r <= 100; r++) ws.addRow(['a', 'b']);
    ws.getCell('A5').value = 'x'.repeat(200); ws.getCell('A5').alignment = { wrapText: true };   // estimated tall
    ws.getCell('A8').value = 'short'; ws.getCell('A8').alignment = { wrapText: true };           // estimated one line
    return buildSheet(ws);
  }
  it('a row estimated too tall shrinks, a one-line estimate that really wraps grows, and it settles', () => {
    const sheet = wrapSheet();
    expect(sheet.model.rowHeights[7]).toBe(24);       // the one-line estimate
    expect(sheet.model.wrapRows!.has(7)).toBe(true);  // ...is still marked for measuring
    let calls = 0;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      calls++;
      const r = this.getAttribute('data-r');
      return { height: r === '4' ? 40 : r === '7' ? 70 : 24, width: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
    });
    const { container } = render(<SheetGrid model={sheet.model} sel={null} onSelect={() => {}} />);
    expect(heightOf(container, 4)).toBe(40);
    expect(heightOf(container, 7)).toBe(70);
    const before = calls;
    act(() => notifySheetDrawn());
    expect(heightOf(container, 4)).toBe(40);          // no oscillation
    expect(calls - before).toBeLessThan(10);
  });
});

describe('building a big sheet', () => {
  function bigWs() {
    const wb = new Workbook(); const ws = wb.addWorksheet('S');
    for (let r = 1; r <= 2000; r++) ws.addRow(Array.from({ length: 100 }, (_, c) => `v${r}-${c}`));
    return ws;
  }
  it('hands the thread back without setTimeout(0) timers', async () => {
    const ws = bigWs();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const sheet = await buildSheetAsync(ws);
    expect(sheet.model.usedRows).toBe(2000);
    const zeroDelay = spy.mock.calls.filter((c) => !c[1]);
    expect(zeroDelay).toHaveLength(0);
  });
  it('asking twice for one sheet builds it once', async () => {
    const ws = bigWs();
    const rows = vi.spyOn(ws, 'findRow');
    const b = createSheetBuilder();
    const p1 = b.get(ws), p2 = b.get(ws);
    expect(p2).toBe(p1);
    await p1;
    expect(rows.mock.calls.length).toBeLessThan(2000 * 2); // not twice over
    expect(b.inFlight()).toBe(0);
  });
  it('a cancelled build stops working and rejects', async () => {
    // formatted numbers: slow enough that the build takes many slices
    const wb = new Workbook(); const ws = wb.addWorksheet('S');
    for (let r = 1; r <= 2000; r++) ws.addRow(Array.from({ length: 100 }, (_, c) => (r * 7919 + c * 104729) % 100000 / 100));
    for (let r = 1; r <= 2000; r++) ws.getRow(r).eachCell((cell) => { cell.numFmt = '#,##0.00'; });
    const b = createSheetBuilder();
    // the viewer closes part-way through (here: after 300 rows have been read)
    const real = ws.findRow.bind(ws);
    let calls = 0;
    vi.spyOn(ws, 'findRow').mockImplementation((r: number) => { if (++calls === 300) b.cancel(ws); return real(r); });
    const p = b.get(ws);
    await expect(p).rejects.toThrow('cancelled');
    const counted = calls;
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toBe(counted);                       // nothing ran after the cancel
    expect(counted).toBeLessThan(2000);                // and it never finished
    const p2 = b.get(ws); b.cancelAll();
    await expect(p2).rejects.toThrow('cancelled');
    expect(calls).toBeLessThanOrEqual(counted + 1);
  });
});

describe('selection and copy edge cases', () => {
  it('text the user selected themselves beats a stale green range on copy', () => {
    const { container } = render(<CsvView {...csvProps(bigCsv(50, 5))} />);
    const el = scroller(container);
    fireEvent.keyDown(el, { key: 'a', ctrlKey: true });
    expect(copyText(el)).not.toBeNull();
    // part of a cell selected natively
    const td = container.querySelector('td[data-r="2"][data-c="1"]')!;
    const range = document.createRange(); range.setStart(td.firstChild!, 0); range.setEnd(td.firstChild!, 2);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    expect(copyText(el)).toBeNull();      // left to the browser: copies "r2"
    // a selection outside the grid, too
    const outside = document.createElement('p'); outside.textContent = 'elsewhere'; document.body.appendChild(outside);
    const r2 = document.createRange(); r2.selectNodeContents(outside);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(r2);
    expect(copyText(el)).toBeNull();
    outside.remove();
  });

  it('a drag stops when the button is no longer held, and when the window loses focus', () => {
    const { container } = render(<CsvView {...csvProps(bigCsv(300, 10))} />);
    const el = scroller(container);
    const down = () => fireEvent.mouseDown(container.querySelector('td[data-r="2"][data-c="2"]')!, { button: 0, clientX: 200, clientY: 24 + 2 * 24 + 5 });
    down();
    fireEvent.mouseMove(window, { buttons: 0, clientX: 300, clientY: 24 + 9 * 24 }); // mouse-up happened elsewhere
    fireEvent.mouseMove(window, { buttons: 1, clientX: 300, clientY: 24 + 20 * 24 });
    expect(copyText(el)).toBeNull();      // the drag was over: no range
    down();
    fireEvent.blur(window);
    fireEvent.mouseMove(window, { buttons: 1, clientX: 300, clientY: 24 + 20 * 24 });
    expect(copyText(el)).toBeNull();
    expect(el.style.userSelect).toBe('');
  });

  it('the right-click menu Copy takes the green selection', async () => {
    const wrap = document.createElement('div');
    wrap.setAttribute('data-artifact-viewer', 'true'); wrap.setAttribute('data-doc-path', 'a.csv'); wrap.setAttribute('data-artifact-source', 'sheet');
    document.body.appendChild(wrap);
    const view = render(<CsvView {...csvProps(bigCsv(20, 4))} />, { container: wrap });
    const el = scroller(view.container);
    fireEvent.click(view.container.querySelector('td[data-r="1"][data-c="1"]')!);
    fireEvent.mouseDown(view.container.querySelector('td[data-r="3"][data-c="2"]')!, { button: 0, shiftKey: true });
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t: string) => { written.push(t); } }, configurable: true });
    const entries = buildContextMenu(view.container.querySelector('td[data-r="2"][data-c="1"]') as HTMLElement)!;
    const copy = entries.find((e) => e.type === 'item' && e.id === 'copy');
    expect(copy && copy.type === 'item' && !copy.disabled).toBe(true);
    if (copy && copy.type === 'item') copy.run();
    await settle(20);
    expect(written[0]).toBe('r1c1\tr1c2\nr2c1\tr2c2\nr3c1\tr3c2');
    void el; wrap.remove();
  });

  it('a cell holding a tab, a line break or a quote copies as ONE quoted cell', () => {
    const model = { usedRows: 1, usedCols: 3, text: (_r: number, c: number) => ['plain', 'two\nlines', 'say "hi"\tnow'][c] };
    expect(rangeToTsv(model, () => false, 0, 0, 0, 2)).toBe('plain\t"two\nlines"\t"say ""hi""\tnow"');
  });
});
