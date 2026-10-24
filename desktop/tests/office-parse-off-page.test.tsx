// @vitest-environment jsdom
// Freeze hunt, 2026-10-24: opening a big spreadsheet or Word file froze the app window while ExcelJS / mammoth read
// it ON THE PAGE'S OWN THREAD (200,000-row sheet 1.8 s; ~800-page text document 0.5 s). The reading now runs in a
// Web Worker. These tests pin two things:
//   1. WHERE: with a Worker available, the viewers never read the file on the page (red on the old code, which
//      always did), and with no Worker they still open the file the old way (the safety net).
//   2. WHAT: what the worker hands back draws EXACTLY the sheet / HTML the old in-page read drew, over fixtures
//      with styles, merges, formulas, dates, hidden sheets, wide columns, wrapped text and more rows than shown.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import { Workbook } from 'exceljs';
import JSZip from 'jszip';

// A stand-in for the bundler's worker constructor that runs the REAL worker module's handler, in-process, with the
// reply passed through structuredClone (what postMessage does), so the test sees exactly what the page would get.
const spawned: Array<{ kind: string }> = [];
// Each worker module installs its handler as the global `onmessage` when it loads; both do, so remember each one's own.
const handlers: Partial<Record<'xlsx' | 'docx', (e: any) => Promise<void>>> = {};
async function handlerFor(kind: 'xlsx' | 'docx') {
  if (!handlers[kind]) {
    await import(kind === 'xlsx' ? '../src/renderer/components/artifact-views/xlsx-parse.worker' : '../src/renderer/components/artifact-views/docx-convert.worker');
    handlers[kind] = (globalThis as any).onmessage;
  }
  return handlers[kind]!;
}
function makeFakeWorker(kind: 'xlsx' | 'docx') {
  return class FakeWorker {
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: any) => void) | null = null;
    terminated = false;
    constructor() { spawned.push({ kind }); }
    terminate() { this.terminated = true; }
    postMessage(data: { bytes: ArrayBuffer }) {
      void (async () => {
        const scope = globalThis as any;
        const prev = scope.postMessage;
        let reply: unknown;
        scope.postMessage = (r: unknown) => { reply = structuredClone(r); };
        try {
          await (await handlerFor(kind))({ data: { bytes: data.bytes } });
        } finally { scope.postMessage = prev; }
        this.onmessage?.({ data: reply } as MessageEvent);
      })();
    }
  };
}
vi.mock('../src/renderer/components/artifact-views/xlsx-parse.worker?worker', () => ({ default: makeFakeWorker('xlsx') }));
vi.mock('../src/renderer/components/artifact-views/docx-convert.worker?worker', () => ({ default: makeFakeWorker('docx') }));

import { parseXlsx } from '../src/renderer/components/artifact-views/xlsx-parse-jobs';
import { convertDocx } from '../src/renderer/components/artifact-views/docx-convert-jobs';
import { extractSheets, PlainSheet } from '../src/renderer/components/artifact-views/xlsx-extract';
import { buildSheet } from '../src/renderer/components/artifact-views/XlsxView';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); spawned.length = 0; });

// ---------- fixtures ----------
async function workbookBytes(fill: (wb: Workbook) => void): Promise<Uint8Array> {
  const wb = new Workbook();
  fill(wb);
  return new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer);
}
async function load(bytes: Uint8Array): Promise<Workbook> {
  const wb = new Workbook();
  await wb.xlsx.load(bytes.slice().buffer as any);
  return wb;
}
const FIXTURES: Record<string, (wb: Workbook) => void> = {
  'styles, merges, widths, wrapped text': (wb) => {
    const ws = wb.addWorksheet('Report');
    ws.columns = [{ width: 12 }, { width: 40 }, { width: 8 }, { width: 25 }];
    ws.addRow(['Region', 'Notes', 'Amount', 'Share']);
    ws.getRow(1).font = { bold: true, italic: true, color: { argb: 'FF1A6DC4' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
    ws.addRow(['West', 'A long note that should wrap across several lines in a narrow column ok', 1234.5, 0.256]);
    ws.getCell('B2').alignment = { wrapText: true, vertical: 'top', horizontal: 'left' };
    ws.getCell('C2').numFmt = '#,##0.00';
    ws.getCell('D2').numFmt = '0.0%';
    ws.getCell('C2').border = { top: { style: 'thick', color: { argb: 'FFFF0000' } }, bottom: { style: 'dashed' } };
    ws.mergeCells('A4:C5');
    ws.getCell('A4').value = 'Merged heading';
    ws.getCell('A4').alignment = { horizontal: 'center' };
    ws.mergeCells('D6:D8');
    ws.getCell('D6').value = 'tall merge';
  },
  'formulas with and without stored results': (wb) => {
    const ws = wb.addWorksheet('Calc');
    ws.addRow([10, 20, 30]);
    ws.addRow([{ formula: 'SUM(A1:C1)', result: 60 }, { formula: 'A1*B1' }, { formula: 'IF(A1>5,"big","small")' }]);
    ws.addRow([{ formula: 'A2+B2', result: undefined } as any, { formula: 'C1/0' }, { formula: 'UNKNOWNFN(1)' }]);
  },
  'dates, booleans, rich text, hyperlinks, hidden row': (wb) => {
    const ws = wb.addWorksheet('Mixed');
    ws.addRow([new Date(Date.UTC(2026, 9, 24, 13, 5)), true, { richText: [{ text: 'rich ' }, { text: 'text', font: { bold: true } }] }, { text: 'site', hyperlink: 'https://example.com' }]);
    ws.getCell('A1').numFmt = 'yyyy-mm-dd';
    ws.getCell('A2').value = new Date(Date.UTC(2026, 0, 2, 3, 4));
    ws.getCell('A2').numFmt = 'h:mm';
    ws.addRow(['hidden', 'row']);
    ws.getRow(2).hidden = true;
    ws.getCell('E1').value = 1e21;
    ws.getCell('F1').value = 0.1 + 0.2;
  },
  'hidden sheets are skipped, visible kept in order': (wb) => {
    wb.addWorksheet('Scratch').state = 'hidden';
    wb.addWorksheet('Data').addRow(['a', 'b']);
    wb.addWorksheet('Second').addRow([1, 2]);
  },
  'more rows and columns than the viewer shows': (wb) => {
    const ws = wb.addWorksheet('Big');
    for (let r = 1; r <= 2300; r++) ws.addRow(Array.from({ length: 105 }, (_, c) => (r + c) % 7 === 0 ? `t${r}-${c}` : r * c));
    ws.mergeCells('B3:C4');
  },
};

// Everything the viewer can show about a built sheet: sizes, merges, find index, and every cell as drawn.
function describeSheet(ws: any) {
  const vm = buildSheet(ws);
  const m = vm.model;
  const cells: unknown[] = [];
  for (let r = 0; r < m.rowCount; r++) for (let c = 0; c < m.colCount; c++) {
    const cell = m.cell(r, c);
    cells.push([r, c, cell.text, cell.addr, cell.title, JSON.stringify(cell.style), vm.cellAt(r + 1, c + 1).formula, vm.cellAt(r + 1, c + 1).colSpan, vm.cellAt(r + 1, c + 1).rowSpan]);
  }
  return {
    name: vm.name, truncated: [vm.truncated, vm.rowsTruncated, vm.colsTruncated],
    sizes: [m.rowCount, m.colCount, m.usedRows, m.usedCols], colWidths: m.colWidths, rowHeights: m.rowHeights,
    merges: m.merges, wrapRows: [...(m.wrapRows ?? [])].sort(), find: ['t1', '5', 'big', 'wrap', 'merged', '%', '2026'].map((q) => m.findCells(q)),
    cells,
  };
}

describe('the spreadsheet a worker hands back draws the same sheet the in-page read drew', () => {
  for (const [name, fill] of Object.entries(FIXTURES)) {
    it(name, async () => {
      const bytes = await workbookBytes(fill);
      const real = await load(bytes);
      const visible = real.worksheets.filter((w: any) => w.state !== 'hidden' && w.state !== 'veryHidden');
      // through the worker path (real worker code, structured-cloned reply)...
      const viaWorker = await parseXlsx(bytes, () => new (makeFakeWorker('xlsx') as any)()).promise;
      expect(viaWorker.map((s) => s.name)).toEqual(visible.map((w: any) => w.name));
      viaWorker.forEach((sheet, i) => expect(describeSheet(sheet)).toEqual(describeSheet(visible[i])));
      // ...and through the no-worker safety net.
      const viaPage = await parseXlsx(bytes, null).promise;
      viaPage.forEach((sheet, i) => expect(describeSheet(sheet)).toEqual(describeSheet(visible[i])));
    }, 60_000);
  }

  it('a workbook whose every sheet is hidden still shows them all', async () => {
    const bytes = await workbookBytes((wb) => { wb.addWorksheet('A').state = 'hidden'; wb.addWorksheet('B').state = 'veryHidden'; });
    const sheets = extractSheets(await load(bytes)).map((s) => s.name);
    expect(sheets).toEqual(['A', 'B']);
  });

  it('keeps only what the viewer can draw: a 5,000-row sheet comes back as 2,000 rows of data', async () => {
    const bytes = await workbookBytes((wb) => { const ws = wb.addWorksheet('S'); for (let r = 1; r <= 5000; r++) ws.addRow([r, `x${r}`]); });
    const [data] = extractSheets(await load(bytes));
    expect(data.rowCount).toBe(5000);                 // the real size is still reported (the "showing the first 2,000" note)
    expect(data.rows.length).toBeLessThanOrEqual(2001);
    expect(new PlainSheet(data).rowCount).toBe(5000);
  });

  it('a file that is not a spreadsheet fails (it does not hang or open empty)', async () => {
    await expect(parseXlsx(new TextEncoder().encode('not a zip'), () => new (makeFakeWorker('xlsx') as any)()).promise).rejects.toBeTruthy();
  });

  it('a worker that cannot start falls back to reading on the page', async () => {
    const bytes = await workbookBytes(FIXTURES['hidden sheets are skipped, visible kept in order']);
    const job = parseXlsx(bytes, () => { throw new Error('no workers here'); });
    expect((await job.promise).map((s) => s.name)).toEqual(['Data', 'Second']);
  });
});

// ---------- Word ----------
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
async function docxBytes(paragraphs = 3): Promise<Uint8Array> {
  const zip = new JSZip();
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
  const p = (t: string, extra = '') => `<w:p>${extra}<w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  const body = [
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>`,
    `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t> italic</w:t></w:r></w:p>`,
    `<w:p><w:hyperlink r:id="rIdL"><w:r><w:t>a link</w:t></w:r></w:hyperlink></w:p>`,
    `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>c1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>c2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`,
    `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="95250" cy="95250"/><wp:docPr id="1" name="pic" descr="tiny"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="pic"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdI"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
    ...Array.from({ length: paragraphs }, (_, i) => p(`Paragraph number ${i} &amp; some text`)),
  ].join('');
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdL" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/><Relationship Id="rIdI" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/x.png"/></Relationships>');
  zip.file('word/media/x.png', PNG);
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`);
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
}

describe('the Word file a worker converts is the same HTML the in-page conversion made', () => {
  it('headings, bold, links, a table and an embedded picture come back identical', async () => {
    const bytes = await docxBytes(40);
    const viaPage = await convertDocx(bytes, null).promise;
    const viaWorker = await convertDocx(bytes, () => new (makeFakeWorker('docx') as any)()).promise;
    expect(viaPage).toContain('<h1>Title</h1>');
    expect(viaPage).toContain('<table>');
    expect(viaPage).toContain('data:image/png;base64');
    expect(viaWorker).toBe(viaPage);
  }, 60_000);
  it('a file that is not a Word document fails', async () => {
    await expect(convertDocx(new TextEncoder().encode('nope'), () => new (makeFakeWorker('docx') as any)()).promise).rejects.toBeTruthy();
  });
});

// ---------- WHERE the work happens ----------
vi.mock('../src/renderer/components/artifact-views/BinaryContent', async (orig) => {
  const real = await orig<typeof import('../src/renderer/components/artifact-views/BinaryContent')>();
  return { ...real, BinaryContent: ({ children, absolutePath }: any) => children((globalThis as any).__officeBytes[absolutePath]) };
});

describe('the viewers read the file off the page when a Worker exists', () => {
  it('XlsxView hands the file to a worker instead of reading it on the page', async () => {
    const bytes = await workbookBytes(FIXTURES['hidden sheets are skipped, visible kept in order']);
    (globalThis as any).__officeBytes = { '/t/a.xlsx': bytes };
    vi.stubGlobal('Worker', makeFakeWorker('xlsx')); // a Worker exists on this platform
    const { XlsxView } = await import('../src/renderer/components/artifact-views/XlsxView');
    const { container } = render(<XlsxView path="a.xlsx" absolutePath="/t/a.xlsx" content="" isEditable={false} />);
    await waitFor(() => expect(container.querySelector('table')).not.toBeNull(), { timeout: 20_000 });
    expect(spawned.filter((s) => s.kind === 'xlsx')).toHaveLength(1);   // red on the old code: it never made a worker
    expect(container.textContent).toContain('Data');
  }, 60_000);

  it('DocxView converts in the worker and still cleans the result before showing it', async () => {
    const bytes = await docxBytes(2);
    (globalThis as any).__officeBytes = { '/t/a.docx': bytes };
    vi.stubGlobal('Worker', makeFakeWorker('docx'));
    const { DocxView } = await import('../src/renderer/components/artifact-views/DocxView');
    const { container } = render(<DocxView path="a.docx" absolutePath="/t/a.docx" content="" isEditable={false} />);
    await waitFor(() => expect(container.textContent).toContain('Paragraph number 1'), { timeout: 20_000 });
    expect(spawned.filter((s) => s.kind === 'docx')).toHaveLength(1);
    const link = container.querySelector('a[href="https://example.com"]');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer'); // sanitizeDocHtml still ran on the worker's output
  }, 60_000);
});
