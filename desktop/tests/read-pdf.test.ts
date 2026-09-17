import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReadTool } from '../src/main/harness/tools/read';
import { parsePagesArg, MAX_PDF_PAGES_PER_CALL, DEFAULT_PDF_PAGES } from '../src/main/harness/pdf-text';
import type { ToolContext } from '../src/main/harness/tools/types';

// Ledger G-6: Read extracts a PDF's text layer page by page. These cases pin the
// honesty rules (scanned pages are NAMED, never silently dropped; pdf.js's own
// error wording surfaces; the "binary file" refusal never fires for a PDF) and
// the paging contract (10 pages by default, 20 max per call, `pages` param).

/** Hand-written PDF writer — one page per entry; an empty string yields a page
 *  with NO text (what a scanned page looks like to a text extractor). Kept
 *  deliberately tiny: Helvetica, no parentheses in the text. Every text page
 *  also carries a line of body filler so it clears the "no text layer"
 *  threshold the way a real page does (a bare heading alone would not). */
const FILLER = 'Body text follows the heading, as it does on any real page of a document.';
function makePdf(pageTexts: string[]): string {
  const objs: string[] = [];
  const add = (s: string) => {
    objs.push(s);
    return objs.length;
  };
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pagesRef = 1 + pageTexts.length * 2 + 1; // font + (stream+page)*N + this /Pages object
  const pageIds: number[] = [];
  for (const text of pageTexts) {
    const content = text ? `BT /F1 10 Tf 72 700 Td (${text}) Tj 0 -30 Td (${FILLER}) Tj ET` : '';
    const stream = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 612 792] /Contents ${stream} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
  }
  const pages = add(`<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  const cat = add(`<< /Type /Catalog /Pages ${pages} 0 R >>`);
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${cat} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

let dir: string;
let ctx: ToolContext;

function makeCtx(cwd: string, supportsVision = false): ToolContext {
  return {
    sessionId: 'test',
    cwd,
    signal: new AbortController().signal,
    readRegistry: new Map(),
    todos: [],
    supportsVision,
  };
}

function writePdf(name: string, pageTexts: string[]): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, makePdf(pageTexts), 'latin1');
  return p;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-pdf-'));
  ctx = makeCtx(dir);
});
afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('parsePagesArg', () => {
  it('accepts a single page and a range', () => {
    expect(parsePagesArg('3')).toEqual({ from: 3, to: 3 });
    expect(parsePagesArg('1-5')).toEqual({ from: 1, to: 5 });
    expect(parsePagesArg(' 2 - 4 ')).toEqual({ from: 2, to: 4 });
  });
  it('rejects malformed, inverted, zero, and over-wide ranges by name', () => {
    expect(parsePagesArg('x')).toMatchObject({ error: expect.stringContaining('"x"') });
    expect(parsePagesArg('5-2')).toMatchObject({ error: expect.stringContaining('5-2') });
    expect(parsePagesArg('0')).toMatchObject({ error: expect.any(String) });
    expect(parsePagesArg('1-21')).toMatchObject({ error: expect.stringContaining(`${MAX_PDF_PAGES_PER_CALL}`) });
    expect(parsePagesArg('1-20')).toEqual({ from: 1, to: 20 });
  });
});

describe('Read: PDF text layer (ledger G-6)', () => {
  it('extracts every page of a short PDF with page headers, no binary refusal', async () => {
    writePdf('syllabus.pdf', ['Hello page one', 'Second page text', 'Third page here']);
    const r = await ReadTool.execute({ file_path: 'syllabus.pdf' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).not.toContain('binary file');
    expect(r.text).toContain('--- page 1 ---');
    expect(r.text).toContain('Hello page one');
    expect(r.text).toContain('--- page 3 ---');
    expect(r.text).toContain('Third page here');
    // 3 pages ≤ the default window, so nothing was omitted and no bound is declared.
    expect(r.bounds).toBeUndefined();
  });

  it('records the read in readRegistry exactly as a text read does', async () => {
    const p = writePdf('notes.pdf', ['Some notes text here']);
    await ReadTool.execute({ file_path: 'notes.pdf' }, ctx);
    // Since 2026-09-16 the registry holds a content fingerprint, not an mtime —
    // the same one a text Read of the same bytes would record.
    const { fingerprintFile } = await import('../src/main/harness/tools/file-fingerprint');
    expect([...ctx.readRegistry.values()]).toContain(fingerprintFile(p));
  });

  it('honours a pages range and declares bounds for the pages after it', async () => {
    const texts = Array.from({ length: 12 }, (_, i) => `Page number ${i + 1} content`);
    writePdf('book.pdf', texts);
    const r = await ReadTool.execute({ file_path: 'book.pdf', pages: '2-3' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).not.toContain('--- page 1 ---');
    expect(r.text).toContain('--- page 2 ---');
    expect(r.text).toContain('Page number 3 content');
    expect(r.text).not.toContain('--- page 4 ---');
    expect(r.bounds).toMatchObject({ shown: 2, total: 12, unit: 'pages' });
    expect(r.bounds!.moreHint).toContain('pages="4-12"');
  });

  it('a >10-page PDF with no pages arg returns pages 1-10 and declares bounds', async () => {
    const texts = Array.from({ length: 25 }, (_, i) => `Page number ${i + 1} content`);
    writePdf('long.pdf', texts);
    const r = await ReadTool.execute({ file_path: 'long.pdf' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain(`--- page ${DEFAULT_PDF_PAGES} ---`);
    expect(r.text).not.toContain(`--- page ${DEFAULT_PDF_PAGES + 1} ---`);
    expect(r.bounds).toMatchObject({ shown: DEFAULT_PDF_PAGES, total: 25, unit: 'pages' });
    expect(r.bounds!.moreHint).toContain('pages="11-20"');
    // defineTool renders the bound into the text using the tool's own vocabulary.
    expect(r.text).toMatch(/showing 10 of 25 pages/);
  });

  it('rejects a range wider than 20 pages with a specific message', async () => {
    const texts = Array.from({ length: 25 }, (_, i) => `Page number ${i + 1} content`);
    writePdf('long.pdf', texts);
    const r = await ReadTool.execute({ file_path: 'long.pdf', pages: '1-21' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Read failed:/);
    expect(r.text).toContain('20');
  });

  it('a range starting past the last page fails with the real page count', async () => {
    writePdf('short.pdf', ['Only one page of text']);
    const r = await ReadTool.execute({ file_path: 'short.pdf', pages: '5-6' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('1 page');
  });

  it('PREPENDS a note naming scanned (textless) pages — vision wording', async () => {
    writePdf('scan.pdf', ['Cover page with text', '', '', 'Closing page with text']);
    const r = await ReadTool.execute({ file_path: 'scan.pdf' }, makeCtx(dir, true));
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/^Pages 2–3 contain no text layer/);
    expect(r.text).toContain('pdftoppm -png -f 2 -l 3');
    expect(r.text).toContain('Read the PNGs');
    // The note comes BEFORE page 1 so a paged read still surfaces it.
    expect(r.text.indexOf('no text layer')).toBeLessThan(r.text.indexOf('--- page 1 ---'));
    expect(r.text).toContain('Closing page with text');
  });

  it('scanned-page note for a text-only model never suggests rendering to images', async () => {
    writePdf('scan2.pdf', ['Cover page with text', '', 'Closing page with text']);
    const r = await ReadTool.execute({ file_path: 'scan2.pdf' }, makeCtx(dir, false));
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/^Page 2 contains no text layer/);
    expect(r.text).not.toContain('pdftoppm');
    expect(r.text).not.toMatch(/PNG/i);
  });

  it('a wholly textless document is an error naming the page count', async () => {
    writePdf('allscan.pdf', ['', '', '']);
    const r = await ReadTool.execute({ file_path: 'allscan.pdf' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('no text layer');
    expect(r.text).toContain('3 pages');
    expect(r.text).not.toContain('pdftoppm');
  });

  it('a corrupt PDF surfaces pdf.js\'s own message, never "binary file"', async () => {
    fs.writeFileSync(path.join(dir, 'broken.pdf'), '%PDF-1.4\n  garbage garbage');
    const r = await ReadTool.execute({ file_path: 'broken.pdf' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Read failed:/);
    expect(r.text).not.toContain('binary file');
    expect(r.text).toMatch(/Invalid PDF structure/i);
  });

  it('serializes concurrent extractions instead of parsing several files at once', async () => {
    // The 2026-08-27 OOM was N simultaneous parses; two Reads fired together
    // must both succeed AND never overlap. We can only observe the outcome here
    // (both correct), the ordering pin lives in pdf-text's module chain.
    writePdf('a.pdf', ['Alpha document text']);
    writePdf('b.pdf', ['Bravo document text']);
    const [a, b] = await Promise.all([
      ReadTool.execute({ file_path: 'a.pdf' }, ctx),
      ReadTool.execute({ file_path: 'b.pdf' }, ctx),
    ]);
    expect(a.text).toContain('Alpha document text');
    expect(b.text).toContain('Bravo document text');
  });

  it('all three description tiers tell the model Read handles PDFs', () => {
    expect(ReadTool.description).toMatch(/PDF/);
    expect(ReadTool.description).toMatch(/scanned/);
    expect(ReadTool.shortDescription).toMatch(/PDF/);
    expect(ReadTool.descriptionFor!({ supportsVision: true })).toMatch(/PDF/);
    expect(ReadTool.descriptionFor!({ supportsVision: true })).toMatch(/scanned/);
    expect(ReadTool.shortDescriptionFor!({ supportsVision: true })).toMatch(/PDF/);
  });

  it('the static pipeline-cap moreHint mentions pages, so a huge PDF page gets real advice', () => {
    expect(ReadTool.moreHint).toMatch(/pages/);
  });
});

// ---------------------------------------------------------------------------
// pdf.js "factory url" contract (Windows regression, 2026-08-28)
// ---------------------------------------------------------------------------
describe('pdfjsAssetDirs — pdf.js factory-url contract', () => {
  it('ends both asset dirs with a FORWARD slash, on every platform', async () => {
    // pdf.js validates these inside getDocument():
    //   if (val.endsWith("/")) return val;
    //   throw new Error(`Invalid factory url: "${val}" must include trailing slash.`)
    // so a backslash tail makes EVERY PDF read throw before any parsing.
    const { pdfjsAssetDirs } = await import('../src/main/harness/pdf-text');
    const dirs = pdfjsAssetDirs();
    expect(dirs.standardFontDataUrl?.endsWith('/')).toBe(true);
    expect(dirs.cMapUrl?.endsWith('/')).toBe(true);
  });
  // WHY no source scan here any more: on Linux and macOS `path.sep` IS '/', so the
  // case above passes whether the bug is present or not. The "never path.sep"
  // half is the ast-grep rule pdfjs-asset-dirs-no-path-sep (youcoded-dev
  // scripts/ast-grep/), which fails on the developer's own machine (Plan B, 2026-09-16).
});
