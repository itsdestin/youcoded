// Excel (.xlsx) threaded-comment read/write: xl/threadedComments + xl/persons + the legacy commentsN.xml/vmlDrawingN.vml
// placeholder. Genuine legacy Notes are never surfaced or touched.
// Fixtures: tests/fixtures/doc-comments/ (q3-sales-by-rep = Notes only; xlsx-kitchen-sink = LibreOffice, many OOXML features;
// chartsheet-workbook) and shared-fixtures/doc-comments/ (docling = real Excel-365 file, threads F7 root+reply and G12, Notes A1/B2;
// elden = real Google Sheets export, x18tc:-prefixed, cell B19 has 5 threads; synthetic-worksheet-with-extlst; id-parse-test-vectors.json).
import { describe, it, expect } from 'vitest';
import { readFile, writeFile, mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import JSZip from 'jszip';
import { DOMParser } from 'linkedom';
import ExcelJS from 'exceljs';
import {
  readXlsxComments,
  addXlsxComment,
  replyToXlsxComment,
  resolveXlsxComment,
  reopenXlsxComment,
  moveXlsxComment,
  editXlsxComment,
  editXlsxReply,
  deleteXlsxComment,
  deleteXlsxReply,
} from '../src/main/doc-comments/xlsx-comments';
import { backupPathFor } from '../src/main/doc-comments/write-pipeline';
import { buildDeclaredOversizeZip, corruptLocalFileData } from './fixtures/doc-comments/oversized-zip';
import type { CommentSelector } from '../src/shared/doc-comments-types';

const execFileAsync = promisify(execFile);
const LOCAL = join(__dirname, 'fixtures', 'doc-comments');
const SHARED_FIXTURES = join(__dirname, '..', '..', 'shared-fixtures', 'doc-comments');
const THREADED_REF_DIR = join(SHARED_FIXTURES, 'xlsx-threaded-reference');
const FIXTURE = join(LOCAL, 'q3-sales-by-rep.xlsx');
const KITCHEN_SINK_FIXTURE = join(LOCAL, 'xlsx-kitchen-sink.xlsx');
const CHARTSHEET_FIXTURE = join(LOCAL, 'chartsheet-workbook.xlsx');
const DOCLING_FIXTURE = join(THREADED_REF_DIR, 'docling-xlsx-comments.xlsx');
const ELDEN_FIXTURE = join(THREADED_REF_DIR, 'elden-ring-completionist-checklist.xlsx');
const EXTLST_FIXTURE = join(SHARED_FIXTURES, 'synthetic-worksheet-with-extlst.xlsx');
const ID_VECTORS_PATH = join(SHARED_FIXTURES, 'id-parse-test-vectors.json');
const NO_SUCH_ID = 'xt-1-Z99-00000000-0000-0000-0000-000000000000';
const SORC = 'Sorceries & Incantations List';

const cellSelector = (cell: string, sheet?: string): CommentSelector =>
  ({ kind: 'cell', selector: { type: 'CellSelector', cell, ...(sheet ? { sheet } : {}) } });

async function withBytes<T>(bytes: Buffer, fn: (target: string) => Promise<T>, name = 'workbook.xlsx'): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ycd-xlsx-write-'));
  const target = join(dir, name);
  await writeFile(target, bytes);
  try {
    return await fn(target);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const withScratchCopy = async <T>(fixturePath: string, fn: (target: string) => Promise<T>) =>
  withBytes(await readFile(fixturePath), fn);

const parseXml = (xml: string) => new DOMParser().parseFromString(xml, 'text/xml') as any;
const elByTag = (node: any, tag: string): any[] => Array.from(node.getElementsByTagName(tag));
const zipOf = async (target: string) => JSZip.loadAsync(await readFile(target));
const partOf = async (target: string, name: string) => (await zipOf(target)).file(name)!.async('string');

async function zipEntryNames(bytes: Buffer): Promise<string[]> {
  const names: string[] = [];
  (await JSZip.loadAsync(bytes)).forEach((p, f) => { if (!f.dir) names.push(p); });
  return names.sort();
}

/** The "surgical, not rebuilding" contract: every part is byte-identical except the named ones. */
async function assertOnlyThesePartsChanged(before: Buffer, after: Buffer, expectedChangedOrNew: readonly string[]): Promise<void> {
  const beforeZip = await JSZip.loadAsync(before);
  const afterZip = await JSZip.loadAsync(after);
  const allowed = new Set(expectedChangedOrNew);
  for (const name of await zipEntryNames(before)) {
    if (allowed.has(name)) continue;
    const afterFile = afterZip.file(name);
    expect(afterFile, `part "${name}" was REMOVED by the write`).not.toBeNull();
    expect(await afterFile!.async('string'), `part "${name}" was NOT supposed to change but did`).toBe(await beforeZip.file(name)!.async('string'));
  }
}

function resolveRelTarget(baseDir: string, target: string): string {
  const out: string[] = [];
  for (const seg of [...baseDir.split('/'), ...target.split('/')].filter(Boolean)) {
    if (seg === '..') out.pop();
    else if (seg !== '.') out.push(seg);
  }
  return out.join('/');
}

/** Output would open in Excel: every relationship Target is a real part and every part has content-type coverage. */
async function assertStructurallyOpenable(bytes: Buffer): Promise<void> {
  const zip = await JSZip.loadAsync(bytes);
  const names = new Set(await zipEntryNames(bytes));
  for (const relsPath of Array.from(names).filter((n) => n.endsWith('.rels'))) {
    const baseDir = relsPath.includes('/_rels/') ? relsPath.slice(0, relsPath.indexOf('/_rels/')) : '';
    for (const rel of elByTag(parseXml(await zip.file(relsPath)!.async('string')), 'Relationship')) {
      const target = rel.getAttribute('Target') as string | null;
      if (!target || /^https?:/i.test(target)) continue;
      expect(names.has(resolveRelTarget(baseDir, target)), `dangling relationship in ${relsPath} -> ${target}`).toBe(true);
    }
  }
  const ct = parseXml(await zip.file('[Content_Types].xml')!.async('string'));
  const overrides = new Set(elByTag(ct, 'Override').map((el) => el.getAttribute('PartName')));
  const defaults = new Set(elByTag(ct, 'Default').map((el) => (el.getAttribute('Extension') ?? '').toLowerCase()));
  for (const name of names) {
    if (name === '[Content_Types].xml') continue;
    expect(overrides.has(`/${name}`) || defaults.has(name.split('.').pop()?.toLowerCase() ?? ''), `part "${name}" has no content-type coverage`).toBe(true);
  }
}

/** Opens the bytes in a REAL LibreOffice (PDF conversion); skipped silently when `soffice` is not installed. */
async function assertOpensInLibreOffice(bytes: Buffer): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ycd-xlsx-lo-check-'));
  try {
    const input = join(dir, 'check.xlsx');
    await writeFile(input, bytes);
    try {
      await execFileAsync('soffice', ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', dir, input], { timeout: 60_000 });
    } catch (e: any) {
      if (e?.code === 'ENOENT') return;
      throw e;
    }
    expect((await readFile(join(dir, 'check.pdf'))).length).toBeGreaterThan(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
/** A hand-built one-sheet workbook; `worksheetXml` is the whole sheet part, `extra` adds more parts. */
async function buildMinimalXlsx(worksheetXml: string, extra: Record<string, string> = {}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
  zip.file('xl/workbook.xml', `${XML}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_R}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${NS_R}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
  zip.file('xl/worksheets/sheet1.xml', worksheetXml);
  for (const [name, body] of Object.entries(extra)) zip.file(name, body);
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** A brand-new single-sheet workbook with no comments (so "add the only comment, delete it" starts from zero). */
async function minimalExcelJsBytes(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Sheet1').getCell('A1').value = 'hello';
  return Buffer.from(await wb.xlsx.writeBuffer());
}

type Comment = Extract<Awaited<ReturnType<typeof readXlsxComments>>, { ok: true }>['comments'][number];
const cellOf = (c: Comment) => (c.selector.kind === 'cell' ? c.selector.selector.cell : null);
async function commentsOf(source: Buffer | string, path = 'd.xlsx'): Promise<Comment[]> {
  const r = await readXlsxComments(typeof source === 'string' ? await readFile(source) : source, path);
  if (!r.ok) throw new Error(`read failed: ${r.error}`);
  return r.comments;
}
const threadAt = async (target: string, cell: string, path = 'd.xlsx') => (await commentsOf(target, path)).find((c) => cellOf(c) === cell)!;
const add = (target: string, cell: string, text = 'x', author: 'user' | 'assistant' = 'user', path = 'd.xlsx', sheet?: string) =>
  addXlsxComment({ absolutePath: target, path, selector: cellSelector(cell, sheet), text, author });

describe('xlsx-comments read', () => {
  it('reads Excel-authored threads: root+reply on F7, root-only on G12, never the genuine Notes A1/B2', async () => {
    const cs = await commentsOf(DOCLING_FIXTURE, 'docling-xlsx-comments.xlsx');
    expect(cs).toHaveLength(2);
    expect(cs.map(cellOf).sort()).toEqual(['F7', 'G12']);
    const f7 = cs.find((c) => cellOf(c) === 'F7')!;
    expect(f7).toMatchObject({ text: 'Minimum number of saltwater ducks', author: 'person:Jane Smith (JS)', resolved: false });
    expect(f7.replies).toHaveLength(1);
    expect(f7.replies[0]).toMatchObject({ text: 'I never thought it would be so low', author: 'person:Marcus Sterling (MS)' });
    expect(f7.id).toMatch(/^xt-\d+-F7-04C1C54B-2744-A647-93D1-A99C27C7EFDC$/i);
    expect(cs.find((c) => cellOf(c) === 'G12')).toMatchObject({ text: 'Maximum number of ducks', replies: [], resolved: false });
    // single-sheet workbook: no `sheet` on the selector
    for (const c of cs) if (c.selector.kind === 'cell') expect(c.selector.selector.sheet).toBeUndefined();
  });

  it('reads a Google-Sheets (x18tc:-prefixed) file namespace-agnostically: 5 independent threads on B19, sheet name stamped, done="0" unresolved', async () => {
    const cs = await commentsOf(ELDEN_FIXTURE, 'elden.xlsx');
    expect(cs.length).toBeGreaterThan(0); // a literal-tag walk would silently read ZERO from this file
    for (const c of cs) expect(c.id).toMatch(/^xt-\d+-[A-Z]+\d+-[0-9a-f-]{36}$/i);

    const atB19 = cs.filter((c) => cellOf(c) === 'B19');
    expect(atB19).toHaveLength(5);
    expect(new Set(atB19.map((c) => c.id)).size).toBe(5);
    for (const c of atB19) expect(c.resolved).toBe(true);
    if (atB19[0].selector.kind === 'cell') expect(atB19[0].selector.selector.sheet).toBeTruthy();
    // All replies of the one root sit flat in dT order, never chained.
    const withReplies = atB19.find((c) => c.replies.length > 0)!;
    expect(withReplies.replies.map((r) => r.text)).toEqual([
      'Marked as resolved',
      "To whoever took the time to make this, You're a Gem!\nRe-opened",
      'Thank you kind sir!\nMarked as resolved',
    ]);
    expect(cs.find((c) => cellOf(c) === 'C56')?.resolved).toBe(false);
  });

  it('returns ZERO comments for a Notes-only workbook, and does not crash on a chartsheet workbook', async () => {
    expect(await commentsOf(FIXTURE, 'reports/q3-sales-by-rep.xlsx')).toEqual([]);
    expect((await readXlsxComments(await readFile(CHARTSHEET_FIXTURE), 'chartsheet-workbook.xlsx')).ok).toBe(true);
  });

  it('parses every entry of the shared id-parse-test-vectors.json (contract with the Kotlin port)', async () => {
    const { vectors } = JSON.parse(await readFile(ID_VECTORS_PATH, 'utf8')) as { vectors: Array<{ case: string; input: string; sheetId: number; cell: string; guid: string }> };
    expect(vectors.length).toBeGreaterThanOrEqual(5);
    for (const v of vectors) {
      const m = /^xt-(\d+)-([^-]+)-(.+)$/.exec(v.input);
      expect(m, `vector "${v.case}" (${v.input}) failed to parse`).not.toBeNull();
      expect([Number.parseInt(m![1], 10), m![2], m![3]]).toEqual([v.sheetId, v.cell, v.guid]);
    }
  });

  it('refuses a declared-oversize xl/workbook.xml before ever decompressing it', async () => {
    const bytes = await buildDeclaredOversizeZip({ 'xl/workbook.xml': '<workbook/>', '[Content_Types].xml': '<Types/>' }, 'xl/workbook.xml', 500 * 1024 * 1024);
    expect(await readXlsxComments(bytes, 'bomb.xlsx')).toEqual({ ok: false, error: 'archive-too-large' });
  });

  // WHY: a corrupted entry has nothing to do with size and must not read as 'archive-too-large'.
  it("reports a corrupted xl/persons/person.xml as 'invalid-xlsx'", async () => {
    const bytes = corruptLocalFileData(await readFile(DOCLING_FIXTURE), 'xl/persons/person.xml');
    expect(await readXlsxComments(bytes, 'd.xlsx')).toEqual({ ok: false, error: 'invalid-xlsx' });
  });

  describe('record-count ceiling', () => {
    const MAX_COMMENT_RECORDS = 20000; // mirrors xlsx-comments.ts
    const manyThreads = (n: number) => {
      const elements = Array.from({ length: n }, (_, i) =>
        `<threadedComment ref="A1" dT="2026-01-01T00:00:00.00" personId="{00000000-0000-0000-0000-000000000000}" id="{${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000}"><text>x</text></threadedComment>`).join('');
      return buildMinimalXlsx(
        `${XML}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_R}"><sheetData><row r="1"><c r="A1"/></row></sheetData></worksheet>`,
        {
          'xl/worksheets/_rels/sheet1.xml.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2017/10/relationships/threadedComment" Target="../threadedComments/threadedComment1.xml"/></Relationships>`,
          'xl/threadedComments/threadedComment1.xml': `${XML}<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments" xmlns:x="${NS_MAIN}">${elements}</ThreadedComments>`,
        }
      );
    };
    it('refuses a read past the ceiling with a typed error', async () => {
      expect(await readXlsxComments(await manyThreads(MAX_COMMENT_RECORDS + 1), 'huge.xlsx')).toEqual({ ok: false, error: 'too-many-comments' });
    });
    it('allows a read exactly AT the ceiling', async () => {
      expect((await readXlsxComments(await manyThreads(MAX_COMMENT_RECORDS), 'at-limit.xlsx')).ok).toBe(true);
    });
  });
});

describe('xlsx-comments write — add', () => {
  it('creates/wires persons, threadedComment, comments and vmlDrawing parts and changes nothing else', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const before = await readFile(target);
      const result = await add(target, 'C3', 'A brand new thread.', 'user', 'docling.xlsx');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.id).toMatch(/^xt-\d+-C3-[0-9A-F-]{36}$/);
      const after = await readFile(target);
      expect((await commentsOf(after, 'docling.xlsx')).find((c) => c.id === result.id))
        .toMatchObject({ text: 'A brand new thread.', author: 'person:You', replies: [], resolved: false });
      await assertStructurallyOpenable(after);
      await assertOpensInLibreOffice(after);
      const beforeNames = new Set(await zipEntryNames(before));
      await assertOnlyThesePartsChanged(before, after, [
        ...(await zipEntryNames(after)).filter((n) => !beforeNames.has(n)),
        'xl/worksheets/sheet1.xml', 'xl/worksheets/_rels/sheet1.xml.rels', 'xl/comments1.xml', 'xl/drawings/vmlDrawing1.vml',
        '[Content_Types].xml', 'xl/_rels/workbook.xml.rels',
        'xl/persons/person.xml', 'xl/threadedComments/threadedComment1.xml', // docling already has both
      ]);
    });
  });

  it.each([
    ['A1', 'cell-has-note'],
    ['F7', 'cell-already-has-comment'],
  ])('refuses %s with %s', async (cell, error) => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      expect(await add(target, cell, 'Should not be allowed.', 'user', 'docling.xlsx')).toEqual({ ok: false, error });
    });
  });

  it('refuses an occupied cell in a Google-Sheets file (reading its x18tc: threads correctly) but adds to a free one', async () => {
    await withScratchCopy(ELDEN_FIXTURE, async (target) => {
      expect(await add(target, 'C4', 'x', 'user', 'elden.xlsx', 'Ashes of War List')).toEqual({ ok: false, error: 'cell-already-has-comment' });
      expect((await add(target, 'ZZ999', 'Brand new.', 'user', 'elden.xlsx', SORC)).ok).toBe(true);
      await assertStructurallyOpenable(await readFile(target));
    });
  });

  it('reuses this app\'s person entry across writes, and mints a fresh one per distinct display name', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      await add(target, 'C3', 'one');
      await add(target, 'D4', 'two');
      await add(target, 'E5', 'three', 'assistant');
      const mine = elByTag(parseXml(await partOf(target, 'xl/persons/person.xml')), 'person').filter((el: any) => el.getAttribute('providerId') === 'YouCoded');
      expect(mine.map((el: any) => el.getAttribute('displayName')).sort()).toEqual(['Assistant', 'You']); // "You" not duplicated
      expect(mine.find((el: any) => el.getAttribute('displayName') === 'You').getAttribute('userId')).toBeNull();
    });
  });

  // WHY: the schema puts <legacyDrawing> BEFORE <tableParts> and <extLst>; the opposite order made Excel report "a problem with some content".
  it('lands <legacyDrawing> before a worksheet-level <extLst> and before <tableParts>', async () => {
    await withScratchCopy(EXTLST_FIXTURE, async (target) => {
      const zip = await zipOf(target);
      const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
      zip.file('xl/worksheets/sheet1.xml', sheet.replace('<extLst>', '<tableParts count="0"/><extLst>'));
      await writeFile(target, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
      expect((await add(target, 'A1', 'first comment on a sheet with a table', 'user', 'synthetic.xlsx')).ok).toBe(true);
      const sheetXml = await partOf(target, 'xl/worksheets/sheet1.xml');
      const order = ['<legacyDrawing', '<tableParts', '<extLst>'].map((tag) => sheetXml.indexOf(tag));
      expect(order.every((i) => i > -1)).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
    });
  });

  it('declares xmlns:r on a worksheet root that lacked it before stamping legacyDrawing r:id', async () => {
    const bytes = await buildMinimalXlsx(`${XML}<worksheet xmlns="${NS_MAIN}"><sheetData><row r="1"><c r="A1"/></row></sheetData></worksheet>`);
    await withBytes(bytes, async (target) => {
      expect((await add(target, 'A1', 'x', 'user', 'minimal.xlsx')).ok).toBe(true);
      expect(await partOf(target, 'xl/worksheets/sheet1.xml')).toContain(`xmlns:r="${NS_R}"`);
      await assertStructurallyOpenable(await readFile(target));
    });
  });

  it('keeps the saved workbook compressed (266 KB file, several MB if re-stored uncompressed)', async () => {
    await withScratchCopy(ELDEN_FIXTURE, async (target) => {
      const before = await readFile(target);
      expect((await add(target, 'ZZ999', 'Brand new.', 'user', 'elden.xlsx', SORC)).ok).toBe(true);
      expect((await readFile(target)).length).toBeLessThan(before.length * 1.1);
    });
  });

  it('keeps genuine Notes byte-for-byte untouched across a write', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const notes = async () => {
        const doc = parseXml(await partOf(target, 'xl/comments1.xml'));
        return ['A1', 'B2'].map((ref) => elByTag(doc, 'comment').find((el: any) => el.getAttribute('ref') === ref).toString());
      };
      const before = await notes();
      await add(target, 'Z1', 'new');
      expect(await notes()).toEqual(before);
    });
  });

  it('leaves every other part of a complex LibreOffice-authored kitchen-sink workbook byte-identical', async () => {
    await withScratchCopy(KITCHEN_SINK_FIXTURE, async (target) => {
      const before = await readFile(target);
      expect((await add(target, 'A1', 'A brand new thread.', 'user', 'kitchen-sink.xlsx', 'Notes')).ok).toBe(true);
      const after = await readFile(target);
      const beforeNames = await zipEntryNames(before);
      // Resolve the "Notes" sheet part dynamically so only THAT worksheet's parts may change.
      const beforeZip = await JSZip.loadAsync(before);
      const wbDoc = parseXml(await beforeZip.file('xl/workbook.xml')!.async('string'));
      const relsDoc = parseXml(await beforeZip.file('xl/_rels/workbook.xml.rels')!.async('string'));
      const rId = elByTag(wbDoc, 'sheet').find((el: any) => el.getAttribute('name') === 'Notes')!.getAttribute('r:id');
      const rel = elByTag(relsDoc, 'Relationship').find((el: any) => el.getAttribute('Id') === rId);
      const sheetPath = `xl/${rel!.getAttribute('Target')}`;
      await assertOnlyThesePartsChanged(before, after, [
        ...(await zipEntryNames(after)).filter((n) => !beforeNames.includes(n)),
        sheetPath, sheetPath.replace(/\/([^/]+)$/, '/_rels/$1.rels'), '[Content_Types].xml', 'xl/_rels/workbook.xml.rels',
      ]);
      await assertStructurallyOpenable(after);
      await assertOpensInLibreOffice(after);
    });
  });

  // WHY strip instead of refuse: control characters arrive via paste, invisible to the user, so a refusal they cannot act on is worse.
  it('strips XML-illegal control characters from comment text and replies, but keeps tab/newline/CR', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const added = await add(target, 'C3', 'before\x01\x02\x1Fafter');
      expect(added).toEqual({ ok: true, id: expect.any(String), text: 'beforeafter' });
      expect((await commentsOf(target)).find((c) => added.ok && c.id === added.id)?.text).toBe('beforeafter');
      const f7 = await threadAt(target, 'F7');
      expect(await replyToXlsxComment({ absolutePath: target, path: 'd.xlsx', id: f7.id, text: 'x\x00y', author: 'user' }))
        .toEqual({ ok: true, reply: { id: expect.any(String), author: 'user', text: 'xy', createdAt: expect.any(Number) } });
      const ws = await add(target, 'C4', 'line one\nline two\ttabbed\rcr');
      expect(ws.ok && ws.text).toBe('line one\nline two\ttabbed\rcr');
    });
  });

  it('leaves a rolling backup at the documented hashed path after a successful write', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      await add(target, 'C3');
      expect(await readFile(backupPathFor(target, '.xlsx.bak')).catch(() => null)).not.toBeNull();
    });
  });
});

describe('xlsx-comments write — reply / resolve / reopen', () => {
  it('appends a reply whose parentId targets the ROOT, never chaining to another reply, and rebuilds the legacy placeholder', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const f7 = await threadAt(target, 'F7');
      expect((await replyToXlsxComment({ absolutePath: target, path: 'd.xlsx', id: f7.id, text: 'A second reply.', author: 'assistant' })).ok).toBe(true);
      const updated = (await commentsOf(target)).find((c) => c.id === f7.id);
      expect(updated?.replies).toHaveLength(2);
      expect(updated?.replies[1]).toMatchObject({ text: 'A second reply.', author: 'person:Assistant' });

      const doc = parseXml(await partOf(target, 'xl/threadedComments/threadedComment1.xml'));
      const tcs = elByTag(doc, 'threadedComment').filter((el: any) => el.getAttribute('ref') === 'F7');
      const rootId = tcs.find((el: any) => !el.getAttribute('parentId')).getAttribute('id');
      const replies = tcs.filter((el: any) => el.getAttribute('parentId'));
      expect(replies).toHaveLength(2);
      for (const r of replies) expect(r.getAttribute('parentId')).toBe(rootId);
    });
  });

  it('rebuilds the legacy placeholder body to include the new reply, in real-Excel layout', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const g12 = await threadAt(target, 'G12');
      await replyToXlsxComment({ absolutePath: target, path: 'd.xlsx', id: g12.id, text: 'A reply.', author: 'user' });
      expect(await partOf(target, 'xl/comments1.xml')).toContain('Comment:\n    Maximum number of ducks\nReply:\n    A reply.');
    });
  });

  it('resolve sets done="1" on the ROOT without touching the legacy placeholder; reopen REMOVES done (never writes done="0")', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const placeholder = await partOf(target, 'xl/comments1.xml');
      const f7 = await threadAt(target, 'F7');
      expect((await resolveXlsxComment({ absolutePath: target, path: 'd.xlsx', id: f7.id })).ok).toBe(true);
      expect((await commentsOf(target)).find((c) => c.id === f7.id)?.resolved).toBe(true);
      expect(await partOf(target, 'xl/comments1.xml')).toBe(placeholder);

      await reopenXlsxComment({ absolutePath: target, path: 'd.xlsx', id: f7.id });
      const xml = await partOf(target, 'xl/threadedComments/threadedComment1.xml');
      const root = elByTag(parseXml(xml), 'threadedComment').find((el: any) => el.getAttribute('ref') === 'F7' && !el.getAttribute('parentId'));
      expect(root.getAttribute('done')).toBeNull();
      expect(xml).not.toContain('done="0"');
    });
  });

  it('reopening / deleting one of FIVE independent threads on one cell never disturbs its siblings', async () => {
    const siblingsIntact = async (op: (target: string, victim: Comment) => Promise<unknown>, victimGone: boolean) => {
      await withScratchCopy(ELDEN_FIXTURE, async (target) => {
        const atB19 = (await commentsOf(target, 'elden.xlsx')).filter((c) => cellOf(c) === 'B19');
        expect(atB19).toHaveLength(5);
        const [victim, ...others] = atB19;
        await op(target, victim);
        const after = await commentsOf(target, 'elden.xlsx');
        if (victimGone) expect(after.some((c) => c.id === victim.id)).toBe(false);
        for (const o of others) {
          const now = after.find((c) => c.id === o.id);
          expect([now?.resolved, now?.text, now?.replies.map((r) => r.text)]).toEqual([o.resolved, o.text, o.replies.map((r) => r.text)]);
        }
      });
    };
    await siblingsIntact(async (t, v) => expect((await reopenXlsxComment({ absolutePath: t, path: 'elden.xlsx', id: v.id })).ok).toBe(true), false);
    await siblingsIntact(async (t, v) => expect(await deleteXlsxComment({ absolutePath: t, path: 'elden.xlsx', id: v.id })).toEqual({ ok: true }), true);
  });
});

describe('xlsx-comments write — move', () => {
  it('relocates a thread: root, every reply and the one legacy comment entry follow; the old cell is empty', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const f7 = await threadAt(target, 'F7');
      const moved = await moveXlsxComment({ absolutePath: target, path: 'd.xlsx', id: f7.id, newSelector: cellSelector('H20') });
      expect(moved.ok).toBe(true);
      if (!moved.ok) return;
      const cs = await commentsOf(target);
      expect(cs.some((c) => cellOf(c) === 'F7')).toBe(false);
      const at = cs.find((c) => cellOf(c) === 'H20');
      expect(at).toMatchObject({ text: 'Minimum number of saltwater ducks' });
      expect(at?.replies.map((r) => r.text)).toEqual(['I never thought it would be so low']);
      const refs = elByTag(parseXml(await partOf(target, 'xl/comments1.xml')), 'comment').map((el: any) => el.getAttribute('ref'));
      expect(refs).not.toContain('F7');
      expect(refs).toContain('H20');
      // The returned id embeds the new cell, so the next call skips the fallback scan.
      expect(moved.id).toMatch(/^xt-\d+-H20-/);
      expect((await replyToXlsxComment({ absolutePath: target, path: 'd.xlsx', id: moved.id, text: 'thanks', author: 'user' })).ok).toBe(true);
    });
  });

  it.each([
    ['G12', 'destination-cell-occupied'],
    ['A1', 'cell-has-note'],
  ])('refuses a move onto %s with %s', async (cell, error) => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const f7 = await threadAt(target, 'F7');
      expect(await moveXlsxComment({ absolutePath: target, path: 'd.xlsx', id: f7.id, newSelector: cellSelector(cell) })).toEqual({ ok: false, error });
    });
  });

  it('keeps reply history and resolve state exactly (no fresh GUIDs)', async () => {
    await withScratchCopy(ELDEN_FIXTURE, async (target) => {
      const root = (await commentsOf(target, 'elden.xlsx')).find((c) => cellOf(c) === 'B19' && c.replies.length === 3)!;
      expect((await moveXlsxComment({ absolutePath: target, path: 'elden.xlsx', id: root.id, newSelector: cellSelector('ZZ1', SORC) })).ok).toBe(true);
      const moved = await threadAt(target, 'ZZ1', 'elden.xlsx');
      expect([moved.resolved, moved.text, moved.replies.map((r) => r.text)]).toEqual([root.resolved, root.text, root.replies.map((r) => r.text)]);
    });
  });

  // WHY: move once minted a duplicate legacy <author> entry every time.
  it('reuses the same legacy <author> entry across repeated moves', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const authors = async () => elByTag(parseXml(await partOf(target, 'xl/comments1.xml')), 'author').length;
      const added = await add(target, 'C3');
      if (!added.ok) throw new Error('add failed');
      const n = await authors();
      const m1 = await moveXlsxComment({ absolutePath: target, path: 'd.xlsx', id: added.id, newSelector: cellSelector('D4') });
      if (!m1.ok) throw new Error('move failed');
      expect(await authors()).toBe(n);
      expect((await moveXlsxComment({ absolutePath: target, path: 'd.xlsx', id: m1.id, newSelector: cellSelector('E5') })).ok).toBe(true);
      expect(await authors()).toBe(n);
    });
  });
});

describe('xlsx-comments write — edit / delete', () => {
  it('edit overwrites the ROOT text and rebuilds the legacy placeholder, leaving ref/dT/person/id untouched', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const f7 = await threadAt(target, 'F7');
      expect(await editXlsxComment({ absolutePath: target, path: 'd.xlsx', id: f7.id, text: 'Rewritten root.' })).toEqual({ ok: true, text: 'Rewritten root.' });
      const edited = (await commentsOf(target)).find((c) => c.id === f7.id);
      expect(edited?.text).toBe('Rewritten root.');
      expect(edited).toMatchObject({ author: f7.author, createdAt: f7.createdAt, selector: f7.selector });
      expect(edited?.replies.map((r) => r.text)).toEqual(f7.replies.map((r) => r.text));
      expect(await partOf(target, 'xl/comments1.xml')).toContain('Comment:\n    Rewritten root.');
    });
  });

  it('editXlsxReply overwrites one reply, returns the persisted reply and leaves the root untouched', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const f7 = await threadAt(target, 'F7');
      const reply = f7.replies[0];
      expect(await editXlsxReply({ absolutePath: target, path: 'd.xlsx', id: f7.id, replyId: reply.id, text: 'Edited reply.' }))
        .toEqual({ ok: true, reply: { id: reply.id, author: reply.author, text: 'Edited reply.', createdAt: reply.createdAt } });
      const parent = (await commentsOf(target)).find((c) => c.id === f7.id);
      expect(parent?.text).toBe(f7.text);
      expect(parent?.replies).toEqual([{ ...reply, text: 'Edited reply.' }]);
    });
  });

  it('delete removes the root, its reply and the ONE legacy placeholder, leaving G12 and the genuine Notes', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const f7 = await threadAt(target, 'F7');
      expect(await deleteXlsxComment({ absolutePath: target, path: 'd.xlsx', id: f7.id })).toEqual({ ok: true });
      const cs = await commentsOf(target);
      expect(cs.some((c) => c.id === f7.id)).toBe(false);
      expect(cs.some((c) => cellOf(c) === 'G12')).toBe(true);
      await assertStructurallyOpenable(await readFile(target));
      const commentsXml = await partOf(target, 'xl/comments1.xml'); // other comments remain, so cleanup must NOT fire
      expect(commentsXml).not.toContain('F7');
      expect(commentsXml).toContain('A1');
    });
  });

  it("deleting a sheet's LAST comment removes the now-empty parts, rels, content-type overrides and <legacyDrawing>", async () => {
    await withBytes(await minimalExcelJsBytes(), async (target) => {
      expect(await zipEntryNames(await readFile(target))).not.toContain('xl/comments1.xml');
      const added = await add(target, 'A1', 'only comment', 'user', 'fresh.xlsx');
      if (!added.ok) throw new Error('add failed');
      const parts = ['xl/comments1.xml', 'xl/drawings/vmlDrawing1.vml', 'xl/threadedComments/threadedComment1.xml'];
      for (const p of parts) expect(await zipEntryNames(await readFile(target))).toContain(p);

      expect(await deleteXlsxComment({ absolutePath: target, path: 'fresh.xlsx', id: added.id })).toEqual({ ok: true });
      const finalBytes = await readFile(target);
      for (const p of parts) expect(await zipEntryNames(finalBytes)).not.toContain(p);
      expect(await partOf(target, 'xl/worksheets/sheet1.xml')).not.toContain('legacyDrawing');
      const rels = await partOf(target, 'xl/worksheets/_rels/sheet1.xml.rels');
      for (const p of ['comments1.xml', 'vmlDrawing1.vml', 'threadedComment1.xml']) expect(rels).not.toContain(p);
      const ct = await partOf(target, '[Content_Types].xml');
      expect(ct).not.toContain('/xl/comments1.xml');
      expect(ct).not.toContain('/xl/threadedComments/threadedComment1.xml');
      await assertStructurallyOpenable(finalBytes);
      await assertOpensInLibreOffice(finalBytes);
      expect(await readXlsxComments(finalBytes, 'fresh.xlsx')).toEqual({ ok: true, comments: [] });
    });
  });

  it('deleteXlsxReply removes ONE reply, rebuilds the placeholder, and leaves the root', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const f7 = await threadAt(target, 'F7');
      expect(await deleteXlsxReply({ absolutePath: target, path: 'd.xlsx', id: f7.id, replyId: f7.replies[0].id })).toEqual({ ok: true });
      const root = (await commentsOf(target)).find((c) => c.id === f7.id);
      expect(root?.replies).toHaveLength(0);
      expect(root?.text).toBe(f7.text);
      expect(await partOf(target, 'xl/comments1.xml')).not.toContain('Reply:');
    });
  });

  const p = { absolutePath: '', path: 'd.xlsx' };
  it.each([
    ['reply', (a: typeof p) => replyToXlsxComment({ ...a, id: NO_SUCH_ID, text: 'nope', author: 'user' })],
    ['edit', (a: typeof p) => editXlsxComment({ ...a, id: NO_SUCH_ID, text: 'x' })],
    ['delete', (a: typeof p) => deleteXlsxComment({ ...a, id: NO_SUCH_ID })],
  ])('%s refuses an id with a valid shape but no matching thread, leaving the file byte-identical', async (_n, op) => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const before = await readFile(target);
      expect(await op({ ...p, absolutePath: target })).toEqual({ ok: false, error: 'comment-not-found' });
      expect(await readFile(target)).toEqual(before);
    });
  });

  it.each([
    ['edit reply', editXlsxReply, { text: 'x' }],
    ['delete reply', deleteXlsxReply, {}],
  ] as const)('%s refuses an unknown replyId', async (_n, op, extra) => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const f7 = await threadAt(target, 'F7');
      expect(await (op as any)({ absolutePath: target, path: 'd.xlsx', id: f7.id, replyId: `${f7.id}-r9`, ...extra })).toEqual({ ok: false, error: 'comment-not-found' });
    });
  });
});

describe('xlsx-comments write — ambiguity refusals', () => {
  it('refuses ambiguous-comment-id when the fallback scan finds TWO roots sharing one GUID', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      // Hand-crafted: give G12's root F7's GUID (neither real fixture has this).
      const zip = await zipOf(target);
      const xml = await zip.file('xl/threadedComments/threadedComment1.xml')!.async('string');
      zip.file('xl/threadedComments/threadedComment1.xml', xml.replace('id="{3A26E9AE-8B38-864D-BAF4-BA5D9C6E1DA4}"', 'id="{04C1C54B-2744-A647-93D1-A99C27C7EFDC}"'));
      await writeFile(target, await zip.generateAsync({ type: 'nodebuffer' }));
      // A hint pointing at a nonexistent cell forces the full-workbook fallback scan, which now finds both.
      expect(await resolveXlsxComment({ absolutePath: target, path: 'd.xlsx', id: 'xt-1-Q1-04C1C54B-2744-A647-93D1-A99C27C7EFDC' }))
        .toEqual({ ok: false, error: 'ambiguous-comment-id' });
    });
  });

  // WHY: the fallback scan used to skip an ambiguously-wired sheet, so a trapped thread read as "gone" instead of "found but unsafe".
  it('reports ambiguous-comment-wiring when the fallback scan passes through a sheet with malformed comment wiring', async () => {
    await withScratchCopy(ELDEN_FIXTURE, async (target) => {
      const zip = await zipOf(target);
      const original = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
      const corrupted = original.replace(/<legacyDrawing r:id="[^"]+"\/>/, '<legacyDrawing r:id="rId999"/>');
      expect(corrupted).not.toBe(original);
      zip.file('xl/worksheets/sheet1.xml', corrupted);
      await writeFile(target, await zip.generateAsync({ type: 'nodebuffer' }));
      expect(await resolveXlsxComment({ absolutePath: target, path: 'elden.xlsx', id: 'xt-2-Z1-00000000-0000-0000-0000-000000000000' }))
        .toEqual({ ok: false, error: 'ambiguous-comment-wiring' });
    });
  });
});
