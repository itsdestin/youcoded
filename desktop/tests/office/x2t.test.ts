import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { inflateSync } from 'node:zlib';
import { convert, exportFormatFor, exportParams, FORMAT, formatFor, killRunningConverters, pdfFontData, printParams, X2tError } from '../../src/main/office/x2t';

const ROOT = fileURLToPath(new URL('../../office-addon/', import.meta.url));
const MEMO = fileURLToPath(new URL('./fixtures/memo.docx', import.meta.url));
// 201 rows (a city with an umlaut on every other row), made with LibreOffice so its strings are shared.
const LEDGER = fileURLToPath(new URL('./fixtures/ledger.xlsx', import.meta.url));
const HAS_ADDON = existsSync(path.join(ROOT, 'manifest.json'));
if (!HAS_ADDON) console.warn('[x2t.test] skipping real-x2t tests: office-addon/manifest.json is missing (run scripts/fetch-office.mjs)');

// WHY a named budget: the first x2t run pays a one-time cost (loading its libraries and the
// font list from a cold disk cache). That belongs here, not inside a test's own timeout.
const X2T_WARMUP_BUDGET_MS = 120_000;

describe('formatFor', () => {
  it('maps the three document kinds case-insensitively and refuses others', () => {
    expect(formatFor('a.DOCX')).toBe(65);
    expect(formatFor('b.xlsx')).toBe(FORMAT.xlsx);
    expect(formatFor('c.pptx')).toBe(FORMAT.pptx);
    expect(formatFor('a.odt')).toBeNull();
    expect(formatFor('a.bin')).toBeNull();
  });
});

// Save As / Export (finish plan Task 2): what each kind of document may be written as.
describe('exportFormatFor', () => {
  it('offers each kind its own formats and PDF, case-insensitively', () => {
    expect(exportFormatFor('/d/a.docx', '/e/b.PDF')).toBe(FORMAT.pdf);
    expect(exportFormatFor('/d/a.docx', '/e/b.odt')).toBe(FORMAT.odt);
    expect(exportFormatFor('/d/a.docx', '/e/b.rtf')).toBe(FORMAT.rtf);
    expect(exportFormatFor('/d/a.docx', '/e/b.txt')).toBe(FORMAT.txt);
    expect(exportFormatFor('/d/a.DOCX', '/e/b.docx')).toBe(FORMAT.docx);
    expect(exportFormatFor('/d/a.xlsx', '/e/b.ods')).toBe(FORMAT.ods);
    expect(exportFormatFor('/d/a.xlsx', '/e/b.csv')).toBe(FORMAT.csv);
    expect(exportFormatFor('/d/a.pptx', '/e/b.odp')).toBe(FORMAT.odp);
    expect(exportFormatFor('/d/a.pptx', '/e/b.pdf')).toBe(FORMAT.pdf);
  });

  it("refuses another kind's formats, legacy formats and unknown ones", () => {
    expect(exportFormatFor('/d/a.docx', '/e/b.xlsx')).toBeNull();
    expect(exportFormatFor('/d/a.pptx', '/e/b.txt')).toBeNull();
    expect(exportFormatFor('/d/a.xlsx', '/e/b.odt')).toBeNull();
    expect(exportFormatFor('/d/a.docx', '/e/b.doc')).toBeNull();
    expect(exportFormatFor('/d/a.docx', '/e/b')).toBeNull();
    expect(exportFormatFor('/d/a.odt', '/e/b.pdf')).toBeNull();
  });
});

// Task 2 fix round 1: the editor's export choices, checked before x2t sees them.
describe('printParams', () => {
  it('passes a document or presentation page list, and nothing for the whole document', () => {
    expect(printParams('docx', JSON.stringify({ nativeOptions: { pages: '2-3,5', printer: 'Office', copies: 3 } }))).toEqual({ json: '{"nativeOptions":{"pages":"2-3,5"}}' });
    expect(printParams('pptx', JSON.stringify({ nativeOptions: { pages: ' 2 ' } }))).toEqual({ json: '{"nativeOptions":{"pages":"2"}}' });
    expect(printParams('docx', JSON.stringify({ nativeOptions: { pages: 'all' } }))).toEqual({});
    expect(printParams('docx', undefined)).toEqual({});
    expect(printParams('docx', 'not json')).toEqual({});
  });
  it('drops a malformed page list rather than pass it on', () => {
    for (const pages of ['0', '1-', '1;2', 'a', '<x/>', '1'.repeat(10), 5]) {
      expect(printParams('docx', JSON.stringify({ nativeOptions: { pages } }))).toEqual({});
    }
  });
  it('names a selection print, which x2t cannot do from the saved document', () => {
    expect(printParams('docx', JSON.stringify({ printOptions: { selection: 1 } }))).toBe('selection');
    expect(printParams('pptx', JSON.stringify({ printOptions: { selection: 1 }, nativeOptions: { pages: '1' } }))).toBe('selection');
    expect(printParams('xlsx', JSON.stringify({ adjustOptions: { printType: 2 } }))).toBe('selection');
  });
  it("gives a workbook the same checked range as its PDF export", () => {
    const json = JSON.stringify({ adjustOptions: { printType: 1, startPageIndex: 1, endPageIndex: 2, bogus: 'x' }, spreadsheetLayout: { ignorePrintArea: true } });
    expect(printParams('xlsx', json)).toEqual(exportParams(FORMAT.pdf, 'xlsx', undefined, json));
    expect(printParams('xlsx', undefined)).toEqual({});
  });
});

describe('exportParams', () => {
  it("passes a CSV's encoding index and delimiter, as the editor sends them", () => {
    expect(exportParams(FORMAT.csv, 'xlsx', { codePage: 44, delimiter: [2], delimiterChar: null }, '')).toEqual({ csvEncoding: 44, csvDelimiter: 2 });
    expect(exportParams(FORMAT.csv, 'xlsx', { codePage: 46, delimiter: [], delimiterChar: '|' }, '')).toEqual({ csvEncoding: 46, csvDelimiterChar: '|' });
  });

  it('drops anything malformed or unknown', () => {
    expect(exportParams(FORMAT.csv, 'xlsx', { codePage: 999, delimiter: [9], delimiterChar: '"' }, '')).toEqual({});
    expect(exportParams(FORMAT.csv, 'xlsx', { codePage: '44', delimiter: '2', delimiterChar: 'ab' }, '')).toEqual({});
    expect(exportParams(FORMAT.csv, 'xlsx', { codePage: 1.5, delimiter: [], delimiterChar: '\n' }, '')).toEqual({});
    expect(exportParams(FORMAT.csv, 'xlsx', 'junk', '')).toEqual({});
    // Only a CSV takes text options; a TXT's encoding is one x2t ignores (the editor's dialog is hidden).
    expect(exportParams(FORMAT.txt, 'docx', { codePage: 44 }, '')).toEqual({});
  });

  it("keeps only a spreadsheet PDF's print range, and only when its print type came with it", () => {
    const json = JSON.stringify({
      spreadsheetLayout: { ignorePrintArea: true, sheetsProps: [{ big: 'model copy' }] },
      adjustOptions: { printType: 1, startPageIndex: 2, endPageIndex: 3, activeSheetsArray: [0, 2] },
      translate: { lots: 'of strings' },
    });
    const out = exportParams(FORMAT.pdf, 'xlsx', null, json);
    expect(JSON.parse(out.json!)).toEqual({ spreadsheetLayout: { ignorePrintArea: true }, adjustOptions: { printType: 1, startPageIndex: 2, endPageIndex: 3, activeSheetsArray: [0, 2] } });
    // No print type: sdkjs would print the whole workbook, so nothing is passed.
    expect(exportParams(FORMAT.pdf, 'xlsx', null, JSON.stringify({ adjustOptions: { startPageIndex: 1 } }))).toEqual({});
    expect(exportParams(FORMAT.pdf, 'xlsx', null, JSON.stringify({ adjustOptions: { printType: 7, activeSheetsArray: ['x'] } }))).toEqual({});
    expect(exportParams(FORMAT.pdf, 'xlsx', null, '{not json')).toEqual({});
    expect(exportParams(FORMAT.pdf, 'docx', null, JSON.stringify({ adjustOptions: { printType: 0 } }))).toEqual({});
  });
});

describe.skipIf(!HAS_ADDON)('convert with the bundled x2t', () => {
  let dir: string;

  beforeAll(async () => {
    const warm = await mkdtemp(path.join(tmpdir(), 'x2t-warm-'));
    try {
      await convert(ROOT, MEMO, path.join(warm, 'Editor.bin'), FORMAT.bin, warm);
    } finally {
      await rm(warm, { recursive: true, force: true, maxRetries: 3 });
    }
  }, X2T_WARMUP_BUDGET_MS);

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'x2t-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('round-trips a docx through the editor form back to a real docx', async () => {
    const bin = path.join(dir, 'Editor.bin');
    const back = path.join(dir, 'back.docx');
    await convert(ROOT, MEMO, bin, FORMAT.bin, dir);
    await convert(ROOT, bin, back, FORMAT.docx, dir);
    expect((await stat(back)).size).toBeGreaterThan(1024);
  });

  // WHY each check (measured 2026-09-29): without the add-on's matching native.js x2t's PDF
  // renderer crashed and wrote nothing; without font data listing real font files it wrote a
  // PDF whose every character was glyph 0 — a blank page. So the test reads the glyphs back.
  it('writes a real PDF, with its text drawn, from the editor form', async () => {
    const bin = path.join(dir, 'Editor.bin');
    const pdf = path.join(dir, 'out.pdf');
    await convert(ROOT, MEMO, bin, FORMAT.bin, dir);
    const fonts = await pdfFontData(ROOT, dir);
    await convert(ROOT, bin, pdf, FORMAT.pdf, dir, undefined, { allFontsPath: fonts });
    const bytes = await readFile(pdf);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const glyphs: string[] = [];
    for (const m of bytes.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
      let text: string;
      try { text = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { continue; }
      for (const g of text.matchAll(/<([0-9A-Fa-f]{4})>/g)) glyphs.push(g[1]);
    }
    expect(glyphs.length).toBeGreaterThan(0);
    expect(glyphs.some((g) => g !== '0000')).toBe(true);
  }, X2T_WARMUP_BUDGET_MS);

  // Measured before this was written (2026-09-29): x2t reads these exactly so.
  it("writes a CSV in the chosen encoding with the chosen delimiter", async () => {
    const bin = path.join(dir, 'Editor.bin');
    await convert(ROOT, LEDGER, bin, FORMAT.bin, dir);
    const csv = path.join(dir, 'out.csv');
    await convert(ROOT, bin, csv, FORMAT.csv, dir, undefined, { params: { csvEncoding: 44, csvDelimiter: 2 } });
    const bytes = await readFile(csv);
    expect(bytes.subarray(0, 12).toString('latin1')).toBe('City;Amount;');
    expect(bytes.includes(Buffer.from('Z\xfcrich', 'latin1'))).toBe(true); // windows-1252, no BOM
    await convert(ROOT, bin, csv, FORMAT.csv, dir, undefined, { params: { csvEncoding: 46, csvDelimiterChar: '|' } });
    expect((await readFile(csv, 'utf8')).replace(/^\uFEFF/, '').startsWith('City|Amount|Note')).toBe(true);
  }, X2T_WARMUP_BUDGET_MS);

  it("prints only the spreadsheet PDF's chosen pages", async () => {
    const bin = path.join(dir, 'Editor.bin');
    await convert(ROOT, LEDGER, bin, FORMAT.bin, dir);
    const fonts = await pdfFontData(ROOT, dir);
    const pages = async (json?: string) => {
      const pdf = path.join(dir, `p-${Math.random().toString(36).slice(2)}.pdf`);
      await convert(ROOT, bin, pdf, FORMAT.pdf, dir, undefined, { allFontsPath: fonts, params: json ? { json } : undefined });
      return [...(await readFile(pdf)).toString('latin1').matchAll(/\/Type\s*\/Page(?![s\w])/g)].length;
    };
    const all = await pages();
    expect(all).toBeGreaterThan(1);
    expect(await pages(JSON.stringify({ adjustOptions: { printType: 0, endPageIndex: 1 } }))).toBe(1);
  }, X2T_WARMUP_BUDGET_MS);

  it('makes the font data once per temp base and reuses it', async () => {
    const a = await pdfFontData(ROOT, dir);
    const b = await pdfFontData(ROOT, dir);
    expect(a).toBe(b);
    expect(a.startsWith(dir)).toBe(true);
    expect((await stat(a)).size).toBeGreaterThan(0);
  }, X2T_WARMUP_BUDGET_MS);

  it('leaves no job folders behind in the temp base', async () => {
    await convert(ROOT, MEMO, path.join(dir, 'Editor.bin'), FORMAT.bin, dir);
    expect((await readdir(dir)).filter((n) => n.startsWith('job-'))).toEqual([]);
  });

  it('rejects with X2tError when the input file does not exist', async () => {
    await expect(convert(ROOT, path.join(dir, 'missing.docx'), path.join(dir, 'Editor.bin'), FORMAT.bin, dir)).rejects.toBeInstanceOf(
      X2tError,
    );
    expect((await readdir(dir)).filter((n) => n.startsWith('job-'))).toEqual([]);
  });

  it('handles a folder name containing XML special characters', async () => {
    // WHY a smaller set on Windows: < > " cannot be in a Windows file name at all; & and ' can.
    const odd = await mkdtemp(path.join(dir, process.platform === 'win32' ? "Tom & Jerry's-" : 'Tom & <Jerry> "q"-'));
    const bin = path.join(odd, 'Editor.bin');
    await convert(ROOT, MEMO, bin, FORMAT.bin, dir);
    expect((await stat(bin)).size).toBeGreaterThan(0);
  });
});

describe('convert when its temp base is gone', () => {
  it('rejects without recreating a removed temp base', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'x2t-gone-'));
    try {
      const gone = path.join(parent, 'base');
      await expect(convert('/unused', '/unused/in.docx', path.join(parent, 'Editor.bin'), FORMAT.bin, gone)).rejects.toThrow();
      expect(existsSync(gone)).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

// A stand-in converter: a tiny shell script at <root>/converter/x2t. POSIX only (it is a
// shell script); it lets the failure shapes be tested without the real x2t.
describe.skipIf(process.platform === 'win32')('convert failure shapes with a stand-in converter', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'x2t-fake-'));
    await mkdir(path.join(root, 'converter'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  async function fakeX2t(script: string) {
    const bin = path.join(root, 'converter', 'x2t');
    await writeFile(bin, `#!/bin/sh\n${script}\n`);
    await chmod(bin, 0o755);
  }

  it('reports output overflowing its buffer as its own failure, not a timeout', async () => {
    await fakeX2t('head -c 70000000 /dev/zero');
    const err = await convert(root, '/in.docx', path.join(root, 'out.bin'), FORMAT.bin, root).catch((e) => e);
    expect(err).toBeInstanceOf(X2tError);
    expect((err as X2tError).code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
  });

  it("stops one document's converter when its abort signal fires, and reports it as stopped", async () => {
    const started = path.join(root, 'started');
    await fakeX2t(`touch '${started}'; exec sleep 30`);
    const stop = new AbortController();
    const pending = convert(root, '/in.docx', path.join(root, 'out.bin'), FORMAT.bin, root, stop.signal).catch((e) => e);
    // Wait until it is really running (positive signal) before stopping it.
    await vi.waitFor(() => expect(existsSync(started)).toBe(true));
    stop.abort();
    const err = await pending;
    expect(err).toBeInstanceOf(X2tError);
    expect((err as X2tError).code).toBe('stopped');
  });

  // Task 2 fix round 1: the PDF font list runs through the same spawn-and-classify helper as a
  // translation, so it too is stopped at quit (and reports a timeout as 'timeout', same code path).
  it('stops a running font-list job at quit and reports it as stopped', async () => {
    await fakeX2t('echo started; exec sleep 30');
    const pending = pdfFontData(root, root).catch((e) => e);
    await vi.waitFor(() => expect(killRunningConverters()).toBeGreaterThan(0));
    const err = await pending;
    expect(err).toBeInstanceOf(X2tError);
    expect((err as X2tError).code).toBe('stopped');
  });

  // Add-on v0.1.37: a presentation that took one of PowerPoint's standard themes points at the
  // theme's pictures as "theme<N>/media/…", which x2t finds only under the task's theme folder.
  // Measured 2026-10-01: without it a saved presentation lost every theme background picture.
  it("names the add-on's slide theme folder in every task, so a standard theme's pictures are saved", async () => {
    const task = path.join(root, 'task.xml');
    const out = path.join(root, 'out.pptx');
    await fakeX2t(`cp "$1" '${task}'; printf x > '${out}'`);
    await convert(root, path.join(root, 'Editor.bin'), out, FORMAT.pptx, root);
    const xml = await readFile(task, 'utf8');
    expect(xml).toContain(`<m_sThemeDir>${path.join(root, 'editors', 'sdkjs', 'slide', 'themes')}</m_sThemeDir>`);
  });

  it('stops a running converter at quit and reports it as stopped', async () => {
    await fakeX2t('echo started; exec sleep 30');
    const pending = convert(root, '/in.docx', path.join(root, 'out.bin'), FORMAT.bin, root).catch((e) => e);
    // Wait for the child to exist (positive signal) before stopping it.
    await vi.waitFor(() => expect(killRunningConverters()).toBeGreaterThan(0));
    const err = await pending;
    expect(err).toBeInstanceOf(X2tError);
    expect((err as X2tError).code).toBe('stopped');
  });
});
