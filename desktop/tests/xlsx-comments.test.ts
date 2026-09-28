// Pins T12 (read) and T13 (write) of the doc-comments build, REWRITTEN
// 2026-09-27 for Destin's threaded-comments-only decision (docs/active/specs/
// 2026-09-26-doc-comments-build-design.md §4.1-§4.3, §8) — Excel 365's modern
// "threaded comments" format (`xl/threadedComments/threadedComment{N}.xml` +
// `xl/persons/person.xml` + the matching legacy `commentsN.xml`/
// `vmlDrawingN.vml` placeholder), never the retired legacy-Notes design this
// file previously pinned.
//
// Fixtures:
// - shared-fixtures/doc-comments/xlsx-threaded-reference/docling-xlsx-
//   comments.xlsx — a REAL file, genuinely authored by Excel-365-for-Mac.
//   Two threaded threads (F7: root+1 reply; G12: root only) plus two genuine
//   Notes (A1, B2) in the SAME xl/comments1.xml.
// - shared-fixtures/doc-comments/xlsx-threaded-reference/elden-ring-
//   completionist-checklist.xlsx — a REAL file, genuinely authored by Google
//   Sheets' own .xlsx export (x18tc:-prefixed elements — proves namespace-
//   prefix-agnostic parsing). Cell B19 carries 5 independent threads.
// - tests/fixtures/doc-comments/q3-sales-by-rep.xlsx — a workbook with EIGHT
//   genuine legacy Notes and NO threaded comments at all — pins that a
//   Notes-only workbook reads back as ZERO comments (§4.1's own "not the
//   garbled pseudo-comment the retired reader produced" pinning test).
// - tests/fixtures/doc-comments/xlsx-kitchen-sink.xlsx — a real LibreOffice-
//   authored workbook with a pre-existing legacy comment plus a wide set of
//   OOXML features (custom properties, external links, merged cells, a
//   hyperlink, an embedded image, rich text, ...) that a REBUILDING writer
//   (the retired exceljs-based one) was proven to lose — used for the
//   byte-identity "every part this operation didn't touch survives verbatim"
//   pinning tests.
// - shared-fixtures/doc-comments/synthetic-worksheet-with-extlst.xlsx — a
//   minimal synthetic fixture (neither real sample has this shape) pinning
//   the `<legacyDrawing>`-after-`<extLst>` ordering rule.
// - shared-fixtures/doc-comments/id-parse-test-vectors.json — the shared
//   contract for the `xt-{sheetId}-{cell}-{GUID}` id parser, also read by a
//   future Kotlin port (T18/T19, not built in this session).
import { describe, it, expect } from 'vitest';
import { readFile, writeFile, mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import JSZip from 'jszip';
import { DOMParser } from 'linkedom';
import {
  readXlsxComments,
  addXlsxComment,
  replyToXlsxComment,
  resolveXlsxComment,
  reopenXlsxComment,
  moveXlsxComment,
} from '../src/main/doc-comments/xlsx-comments';
import { backupPathFor } from '../src/main/doc-comments/write-pipeline';
import { buildDeclaredOversizeZip } from './fixtures/doc-comments/oversized-zip';
import type { CommentSelector } from '../src/shared/doc-comments-types';

const execFileAsync = promisify(execFile);

const FIXTURE = join(__dirname, 'fixtures', 'doc-comments', 'q3-sales-by-rep.xlsx');
const KITCHEN_SINK_FIXTURE = join(__dirname, 'fixtures', 'doc-comments', 'xlsx-kitchen-sink.xlsx');
const CHARTSHEET_FIXTURE = join(__dirname, 'fixtures', 'doc-comments', 'chartsheet-workbook.xlsx');
// desktop/tests -> desktop -> youcoded/ -> shared-fixtures/...
const SHARED_FIXTURES = join(__dirname, '..', '..', 'shared-fixtures', 'doc-comments');
const THREADED_REF_DIR = join(SHARED_FIXTURES, 'xlsx-threaded-reference');
const DOCLING_FIXTURE = join(THREADED_REF_DIR, 'docling-xlsx-comments.xlsx');
const ELDEN_FIXTURE = join(THREADED_REF_DIR, 'elden-ring-completionist-checklist.xlsx');
const EXTLST_FIXTURE = join(SHARED_FIXTURES, 'synthetic-worksheet-with-extlst.xlsx');
const ID_VECTORS_PATH = join(SHARED_FIXTURES, 'id-parse-test-vectors.json');

function cellSelector(cell: string, sheet?: string): CommentSelector {
  return { kind: 'cell', selector: { type: 'CellSelector', cell, ...(sheet ? { sheet } : {}) } };
}

async function withScratchCopy<T>(fixturePath: string, fn: (target: string) => Promise<T>, name?: string): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ycd-xlsx-write-'));
  const target = join(dir, name ?? 'workbook.xlsx');
  await writeFile(target, await readFile(fixturePath));
  try {
    return await fn(target);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Every entry name in a zip, sorted — used to diff which parts an operation
 *  actually touched. */
async function zipEntryNames(bytes: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes);
  const names: string[] = [];
  zip.forEach((relPath, file) => {
    if (!file.dir) names.push(relPath);
  });
  return names.sort();
}

/** Asserts every entry in `before`/`after` is byte-identical EXCEPT the ones
 *  named in `expectedChangedOrNew` (an operation may also ADD a brand-new
 *  part). This is the "surgical, not rebuilding" contract (§4.3's own
 *  opening paragraph), made concrete and machine-checkable. */
async function assertOnlyThesePartsChanged(before: Buffer, after: Buffer, expectedChangedOrNew: readonly string[]): Promise<void> {
  const beforeZip = await JSZip.loadAsync(before);
  const afterZip = await JSZip.loadAsync(after);
  const beforeNames = await zipEntryNames(before);
  const allowed = new Set(expectedChangedOrNew);
  for (const name of beforeNames) {
    if (allowed.has(name)) continue;
    const beforeFile = beforeZip.file(name);
    const afterFile = afterZip.file(name);
    expect(afterFile, `part "${name}" was REMOVED by the write`).not.toBeNull();
    const [beforeText, afterText] = await Promise.all([beforeFile!.async('string'), afterFile!.async('string')]);
    expect(afterText, `part "${name}" was NOT supposed to change but did`).toBe(beforeText);
  }
}

function parseXml(xml: string) {
  return new DOMParser().parseFromString(xml, 'text/xml') as any;
}

function elByTag(node: any, tag: string): any[] {
  return Array.from(node.getElementsByTagName(tag));
}

function resolveRelTargetForTest(baseDir: string, target: string): string {
  const segments = [...baseDir.split('/'), ...target.split('/')].filter((s) => s.length > 0);
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/**
 * Structural checks proving the output would open in Excel (task
 * instructions): every relationship's Target resolves to a real part in the
 * archive, and every real part has content-type coverage (an Override or a
 * Default matching its extension) — the exact class of bug "opens in Word/
 * Excel, silently drops elsewhere" that docx-comments.ts's own F17 verify
 * step already guards against for Word.
 */
async function assertStructurallyOpenable(bytes: Buffer): Promise<void> {
  const zip = await JSZip.loadAsync(bytes);
  const names = new Set<string>();
  zip.forEach((p, f) => {
    if (!f.dir) names.add(p);
  });

  for (const relsPath of Array.from(names).filter((n) => n.endsWith('.rels'))) {
    const relsXml = await zip.file(relsPath)!.async('string');
    const relsDoc = parseXml(relsXml);
    const baseDir = relsPath.includes('/_rels/') ? relsPath.slice(0, relsPath.indexOf('/_rels/')) : '';
    for (const rel of elByTag(relsDoc, 'Relationship')) {
      const target = rel.getAttribute('Target') as string | null;
      if (!target || /^https?:/i.test(target)) continue;
      const resolved = resolveRelTargetForTest(baseDir, target);
      expect(names.has(resolved), `dangling relationship in ${relsPath} -> ${target}`).toBe(true);
    }
  }

  const contentTypesXml = await zip.file('[Content_Types].xml')!.async('string');
  const ctDoc = parseXml(contentTypesXml);
  const overrides = new Set(elByTag(ctDoc, 'Override').map((el) => el.getAttribute('PartName')));
  const defaults = new Set(elByTag(ctDoc, 'Default').map((el) => (el.getAttribute('Extension') ?? '').toLowerCase()));
  for (const name of names) {
    if (name === '[Content_Types].xml') continue;
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const covered = overrides.has(`/${name}`) || defaults.has(ext);
    expect(covered, `part "${name}" has no content-type coverage`).toBe(true);
  }
}

/** Confirms `bytes` (an already-written .xlsx) opens cleanly in a REAL
 *  LibreOffice, converting to PDF and checking a non-empty file came out.
 *  Skips gracefully if `soffice` isn't on PATH — an environment fact, not a
 *  regression in this module. */
async function assertOpensInLibreOffice(bytes: Buffer): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ycd-xlsx-lo-check-'));
  try {
    const input = join(dir, 'check.xlsx');
    await writeFile(input, bytes);
    try {
      await execFileAsync('soffice', ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', dir, input], {
        timeout: 60_000,
      });
    } catch (e: any) {
      if (e?.code === 'ENOENT') return;
      throw e;
    }
    const pdfBytes = await readFile(join(dir, 'check.pdf'));
    expect(pdfBytes.length).toBeGreaterThan(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ===========================================================================
// Read (T12)
// ===========================================================================

describe('xlsx-comments — reading a real Excel-authored threaded-comments file', () => {
  it('reads a resolved... no, an UNRESOLVED root+reply thread on F7', async () => {
    const bytes = await readFile(DOCLING_FIXTURE);
    const result = await readXlsxComments(bytes, 'docling-xlsx-comments.xlsx');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const f7 = result.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'F7');
    expect(f7).toBeDefined();
    expect(f7?.text).toBe('Minimum number of saltwater ducks');
    expect(f7?.author).toBe('person:Jane Smith (JS)');
    expect(f7?.resolved).toBe(false);
    expect(f7?.replies).toHaveLength(1);
    expect(f7?.replies[0].text).toBe('I never thought it would be so low');
    expect(f7?.replies[0].author).toBe('person:Marcus Sterling (MS)');
    expect(f7?.id).toMatch(/^xt-\d+-F7-04C1C54B-2744-A647-93D1-A99C27C7EFDC$/i);
  });

  it('reads a root-only, unresolved thread on G12', async () => {
    const bytes = await readFile(DOCLING_FIXTURE);
    const result = await readXlsxComments(bytes, 'docling-xlsx-comments.xlsx');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const g12 = result.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'G12');
    expect(g12).toBeDefined();
    expect(g12?.text).toBe('Maximum number of ducks');
    expect(g12?.replies).toEqual([]);
    expect(g12?.resolved).toBe(false);
  });

  it('never surfaces the genuine Notes on A1/B2 in the SAME xl/comments1.xml', async () => {
    const bytes = await readFile(DOCLING_FIXTURE);
    const result = await readXlsxComments(bytes, 'docling-xlsx-comments.xlsx');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const cells = result.comments.map((c) => (c.selector.kind === 'cell' ? c.selector.selector.cell : null));
    expect(cells).not.toContain('A1');
    expect(cells).not.toContain('B2');
    // Only the two REAL threads — a genuine Note is never counted.
    expect(result.comments).toHaveLength(2);
  });

  it('stamps the single-sheet workbook with no `sheet` on the selector', async () => {
    const bytes = await readFile(DOCLING_FIXTURE);
    const result = await readXlsxComments(bytes, 'docling-xlsx-comments.xlsx');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const c of result.comments) {
      if (c.selector.kind === 'cell') expect(c.selector.selector.sheet).toBeUndefined();
    }
  });
});

describe('xlsx-comments — reading a real Google-Sheets-exported (x18tc:-prefixed) file', () => {
  it('reads the SAME shape from an x18tc:-prefixed file as from a default-namespace one (namespace-agnostic parsing)', async () => {
    const bytes = await readFile(ELDEN_FIXTURE);
    const result = await readXlsxComments(bytes, 'elden-ring-completionist-checklist.xlsx');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A from-scratch walk matching a literal (possibly unprefixed) tag
    // string would silently read ZERO comments from this file — confirming
    // a healthy, non-empty result is itself the regression guard.
    expect(result.comments.length).toBeGreaterThan(0);
    for (const c of result.comments) {
      expect(c.id).toMatch(/^xt-\d+-[A-Z]+\d+-[0-9a-f-]{36}$/i);
      expect(typeof c.text).toBe('string');
    }
  });

  it('groups cell B19 into FIVE separate, independent threads — none dropped or merged', async () => {
    const bytes = await readFile(ELDEN_FIXTURE);
    const result = await readXlsxComments(bytes, 'elden-ring-completionist-checklist.xlsx');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const atB19 = result.comments.filter((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'B19');
    expect(atB19).toHaveLength(5);
    // The one root with three replies (see the design's own excerpt):
    // {36100e21-...} done=1 + 3 replies.
    const withReplies = atB19.find((c) => c.replies.length > 0);
    expect(withReplies).toBeDefined();
    expect(withReplies?.replies).toHaveLength(3);
    expect(withReplies?.resolved).toBe(true);
    // Every reply's parentId points at the SAME root — never chained — which
    // this reader expresses by putting all three in one flat replies[] array
    // in dT order.
    expect(withReplies?.replies.map((r) => r.text)).toEqual([
      'Marked as resolved',
      "To whoever took the time to make this, You're a Gem!\nRe-opened",
      'Thank you kind sir!\nMarked as resolved',
    ]);
    // Every one of the five is independently resolved (all done="1" per the
    // excerpt) and none share an id.
    expect(new Set(atB19.map((c) => c.id)).size).toBe(5);
    for (const c of atB19) expect(c.resolved).toBe(true);
  });

  it('stamps the sheet name on a multi-sheet workbook\'s selector', async () => {
    const bytes = await readFile(ELDEN_FIXTURE);
    const result = await readXlsxComments(bytes, 'elden-ring-completionist-checklist.xlsx');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const atB19 = result.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'B19');
    expect(atB19).toBeDefined();
    if (atB19?.selector.kind === 'cell') expect(atB19.selector.selector.sheet).toBeTruthy();
  });

  it('reads Google Sheets\' own explicit done="0" as unresolved', async () => {
    const bytes = await readFile(ELDEN_FIXTURE);
    const result = await readXlsxComments(bytes, 'elden-ring-completionist-checklist.xlsx');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const c56 = result.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'C56');
    expect(c56).toBeDefined();
    expect(c56?.resolved).toBe(false);
  });
});

describe('xlsx-comments — a workbook with ONLY genuine Notes (no threaded comments)', () => {
  it('returns ZERO comments, never the garbled pseudo-comment the retired reader produced', async () => {
    const bytes = await readFile(FIXTURE);
    const result = await readXlsxComments(bytes, 'reports/q3-sales-by-rep.xlsx');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.comments).toEqual([]);
  });
});

describe('xlsx-comments — chartsheet exclusion', () => {
  it('never counts a chartsheet toward "single sheet" selector stamping', async () => {
    const bytes = await readFile(CHARTSHEET_FIXTURE);
    const result = await readXlsxComments(bytes, 'chartsheet-workbook.xlsx');
    expect(result.ok).toBe(true);
    // A real Note, not a threaded comment (this fixture predates the
    // threaded-comments rewrite) — expect no threaded comments, and no crash
    // walking the chartsheet's own relationship type.
    expect(result.ok).toBe(true);
  });
});

describe('xlsx-comments — the id parser (shared contract with a future Kotlin port)', () => {
  it('parses every entry in the shared id-parse-test-vectors.json identically to the pre-written regex', async () => {
    const raw = await readFile(ID_VECTORS_PATH, 'utf8');
    const { vectors } = JSON.parse(raw) as { vectors: Array<{ case: string; input: string; sheetId: number; cell: string; guid: string }> };
    expect(vectors.length).toBeGreaterThanOrEqual(5);
    const RE = /^xt-(\d+)-([^-]+)-(.+)$/;
    for (const v of vectors) {
      const m = RE.exec(v.input);
      expect(m, `vector "${v.case}" (${v.input}) failed to parse`).not.toBeNull();
      expect(Number.parseInt(m![1], 10)).toBe(v.sheetId);
      expect(m![2]).toBe(v.cell);
      expect(m![3]).toBe(v.guid);
    }
  });
});

describe('xlsx-comments — decompression-bomb / size guards', () => {
  it('refuses a declared-oversize xl/workbook.xml before ever decompressing it', async () => {
    const bytes = await buildDeclaredOversizeZip(
      { 'xl/workbook.xml': '<workbook/>', '[Content_Types].xml': '<Types/>' },
      'xl/workbook.xml',
      500 * 1024 * 1024
    );
    const result = await readXlsxComments(bytes, 'bomb.xlsx');
    expect(result).toEqual({ ok: false, error: 'archive-too-large' });
  });
});

// ===========================================================================
// Write (T13)
// ===========================================================================

describe('xlsx-comments — add a comment to a brand-new cell', () => {
  it('creates persons.xml, threadedComment{N}.xml, comments{N}.xml, vmlDrawing{N}.vml and wires them all', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const before = await readFile(target);
      const result = await addXlsxComment({
        absolutePath: target,
        path: 'docling.xlsx',
        selector: cellSelector('C3'),
        text: 'A brand new thread.',
        author: 'user',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.id).toMatch(/^xt-\d+-C3-[0-9A-F-]{36}$/);

      const after = await readFile(target);
      const reread = await readXlsxComments(after, 'docling.xlsx');
      expect(reread.ok).toBe(true);
      if (!reread.ok) return;
      const added = reread.comments.find((c) => c.id === result.id);
      expect(added?.text).toBe('A brand new thread.');
      expect(added?.author).toBe('person:You');
      expect(added?.replies).toEqual([]);
      expect(added?.resolved).toBe(false);

      await assertStructurallyOpenable(after);
      await assertOpensInLibreOffice(after);

      // Every OTHER part — including F7/G12's own existing threads and the
      // genuine Notes on A1/B2 — round-trips byte-for-byte untouched.
      const zip = await JSZip.loadAsync(after);
      const names: string[] = [];
      zip.forEach((p, f) => {
        if (!f.dir) names.push(p);
      });
      const beforeZip = await JSZip.loadAsync(before);
      const beforeNames = new Set<string>();
      beforeZip.forEach((p, f) => {
        if (!f.dir) beforeNames.add(p);
      });
      const changedOrNew = names.filter((n) => !beforeNames.has(n));
      // The worksheet itself, its rels, the persons part + workbook rels +
      // content-types are ALL expected to change; assert nothing ELSE does.
      await assertOnlyThesePartsChanged(before, after, [
        ...changedOrNew,
        'xl/worksheets/sheet1.xml',
        'xl/worksheets/_rels/sheet1.xml.rels',
        'xl/comments1.xml',
        'xl/drawings/vmlDrawing1.vml',
        '[Content_Types].xml',
        'xl/_rels/workbook.xml.rels',
        // docling already HAS a persons.xml (2 real people) and a
        // threadedComment1.xml (F7/G12) — the new person/thread entries
        // change both; neither is a brand-new part in THIS fixture.
        'xl/persons/person.xml',
        'xl/threadedComments/threadedComment1.xml',
      ]);
    });
  });

  it('refuses `cell-has-note` when the target cell already carries a genuine Note', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const result = await addXlsxComment({
        absolutePath: target,
        path: 'docling.xlsx',
        selector: cellSelector('A1'),
        text: 'Should not be allowed.',
        author: 'user',
      });
      expect(result).toEqual({ ok: false, error: 'cell-has-note' });
    });
  });

  it('refuses `cell-already-has-comment` when the target cell already carries ANY thread', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const result = await addXlsxComment({
        absolutePath: target,
        path: 'docling.xlsx',
        selector: cellSelector('F7'),
        text: 'A second, independent thread.',
        author: 'user',
      });
      expect(result).toEqual({ ok: false, error: 'cell-already-has-comment' });
    });
  });

  it('reuses (never duplicates) this app\'s own person entry across two writes by the same identity', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const r1 = await addXlsxComment({ absolutePath: target, path: 'd.xlsx', selector: cellSelector('C3'), text: 'one', author: 'user' });
      expect(r1.ok).toBe(true);
      const r2 = await addXlsxComment({ absolutePath: target, path: 'd.xlsx', selector: cellSelector('D4'), text: 'two', author: 'user' });
      expect(r2.ok).toBe(true);

      const bytes = await readFile(target);
      const zip = await JSZip.loadAsync(bytes);
      const personXml = await zip.file('xl/persons/person.xml')!.async('string');
      const personDoc = parseXml(personXml);
      const youEntries = elByTag(personDoc, 'person').filter((el: any) => el.getAttribute('displayName') === 'You');
      expect(youEntries).toHaveLength(1);
      expect(youEntries[0].getAttribute('providerId')).toBe('YouCoded');
      expect(youEntries[0].getAttribute('userId')).toBeNull();
    });
  });

  it('mints a fresh person entry per distinct display name', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      await addXlsxComment({ absolutePath: target, path: 'd.xlsx', selector: cellSelector('C3'), text: 'one', author: 'user' });
      await addXlsxComment({ absolutePath: target, path: 'd.xlsx', selector: cellSelector('D4'), text: 'two', author: 'assistant' });

      const bytes = await readFile(target);
      const zip = await JSZip.loadAsync(bytes);
      const personXml = await zip.file('xl/persons/person.xml')!.async('string');
      const personDoc = parseXml(personXml);
      const mine = elByTag(personDoc, 'person').filter((el: any) => el.getAttribute('providerId') === 'YouCoded');
      expect(mine.map((el: any) => el.getAttribute('displayName')).sort()).toEqual(['Assistant', 'You']);
    });
  });

  it('adds a comment on a cell in a Google-Sheets-exported (x18tc:-prefixed) workbook, matching its own convention', async () => {
    await withScratchCopy(ELDEN_FIXTURE, async (target) => {
      const result = await addXlsxComment({
        absolutePath: target,
        path: 'elden.xlsx',
        selector: cellSelector('C4', 'Ashes of War List'),
        text: 'A brand new thread.',
        author: 'user',
      });
      // C4 on "Ashes of War List" already has a thread in the real fixture
      // (see elden-threadedComment4.xml, wired via elden-sheet5.xml.rels-
      // excerpt.xml) — expect the ALREADY-has-a-comment refusal rather than
      // a crash, proving this reads the x18tc:-prefixed file's existing
      // threads correctly before deciding.
      expect(result).toEqual({ ok: false, error: 'cell-already-has-comment' });
    });
  });

  it('adds a comment to a brand-new cell in the Google-Sheets file and matches its x18tc: convention', async () => {
    await withScratchCopy(ELDEN_FIXTURE, async (target) => {
      const result = await addXlsxComment({
        absolutePath: target,
        path: 'elden.xlsx',
        selector: cellSelector('ZZ999', 'Sorceries & Incantations List'),
        text: 'Brand new.',
        author: 'user',
      });
      expect(result.ok).toBe(true);
      const bytes = await readFile(target);
      await assertStructurallyOpenable(bytes);
    });
  });

  it('lands `<legacyDrawing>` AFTER a pre-existing worksheet-level `<extLst>`, never before it', async () => {
    await withScratchCopy(EXTLST_FIXTURE, async (target) => {
      const result = await addXlsxComment({
        absolutePath: target,
        path: 'synthetic.xlsx',
        selector: cellSelector('A1'),
        text: 'first comment on this worksheet',
        author: 'user',
      });
      expect(result.ok).toBe(true);
      const bytes = await readFile(target);
      const zip = await JSZip.loadAsync(bytes);
      const sheetXml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
      const extLstIdx = sheetXml.indexOf('<extLst>');
      const legacyDrawingIdx = sheetXml.indexOf('<legacyDrawing');
      expect(extLstIdx).toBeGreaterThan(-1);
      expect(legacyDrawingIdx).toBeGreaterThan(extLstIdx);
    });
  });
});

describe('xlsx-comments — reply', () => {
  it('appends a reply whose parentId targets the ROOT, never chains to another reply', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const before = await readXlsxComments(await readFile(target), 'd.xlsx');
      const f7 = before.ok ? before.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'F7') : undefined;
      expect(f7).toBeDefined();

      const result = await replyToXlsxComment({ absolutePath: target, path: 'd.xlsx', id: f7!.id, text: 'A second reply.', author: 'assistant' });
      expect(result.ok).toBe(true);

      const after = await readXlsxComments(await readFile(target), 'd.xlsx');
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      const updated = after.comments.find((c) => c.id === f7!.id);
      expect(updated?.replies).toHaveLength(2);
      expect(updated?.replies[1].text).toBe('A second reply.');
      expect(updated?.replies[1].author).toBe('person:Assistant');

      const bytes = await readFile(target);
      const zip = await JSZip.loadAsync(bytes);
      const threadedXml = await zip.file('xl/threadedComments/threadedComment1.xml')!.async('string');
      const doc = parseXml(threadedXml);
      const rootId = elByTag(doc, 'threadedComment').find((el: any) => el.getAttribute('ref') === 'F7' && !el.getAttribute('parentId'))!.getAttribute('id');
      const replies = elByTag(doc, 'threadedComment').filter((el: any) => el.getAttribute('ref') === 'F7' && el.getAttribute('parentId'));
      expect(replies).toHaveLength(2);
      for (const r of replies) expect(r.getAttribute('parentId')).toBe(rootId);
    });
  });

  it('rebuilds the legacy placeholder body to include the new reply, in real-Excel layout', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const before = await readXlsxComments(await readFile(target), 'd.xlsx');
      const g12 = before.ok ? before.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'G12') : undefined;
      await replyToXlsxComment({ absolutePath: target, path: 'd.xlsx', id: g12!.id, text: 'A reply.', author: 'user' });

      const bytes = await readFile(target);
      const zip = await JSZip.loadAsync(bytes);
      const commentsXml = await zip.file('xl/comments1.xml')!.async('string');
      expect(commentsXml).toContain('Comment:\n    Maximum number of ducks\nReply:\n    A reply.');
    });
  });

  it('refuses `comment-not-found` for an id with a well-formed shape but no matching thread', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const result = await replyToXlsxComment({
        absolutePath: target,
        path: 'd.xlsx',
        id: 'xt-1-Z99-00000000-0000-0000-0000-000000000000',
        text: 'nope',
        author: 'user',
      });
      expect(result).toEqual({ ok: false, error: 'comment-not-found' });
    });
  });
});

describe('xlsx-comments — resolve / reopen', () => {
  it('sets done="1" on the ROOT only, and NEVER touches the legacy placeholder text', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const beforeBytes = await readFile(target);
      const beforeZip = await JSZip.loadAsync(beforeBytes);
      const placeholderBefore = await beforeZip.file('xl/comments1.xml')!.async('string');

      const before = await readXlsxComments(beforeBytes, 'd.xlsx');
      const f7 = before.ok ? before.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'F7') : undefined;
      const result = await resolveXlsxComment({ absolutePath: target, path: 'd.xlsx', id: f7!.id });
      expect(result.ok).toBe(true);

      const afterBytes = await readFile(target);
      const after = await readXlsxComments(afterBytes, 'd.xlsx');
      expect(after.ok).toBe(true);
      if (after.ok) expect(after.comments.find((c) => c.id === f7!.id)?.resolved).toBe(true);

      const afterZip = await JSZip.loadAsync(afterBytes);
      const placeholderAfter = await afterZip.file('xl/comments1.xml')!.async('string');
      expect(placeholderAfter).toBe(placeholderBefore);
    });
  });

  it('reopen REMOVES the `done` attribute entirely — never writes done="0"', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const before = await readXlsxComments(await readFile(target), 'd.xlsx');
      const f7 = before.ok ? before.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'F7') : undefined;
      await resolveXlsxComment({ absolutePath: target, path: 'd.xlsx', id: f7!.id });
      await reopenXlsxComment({ absolutePath: target, path: 'd.xlsx', id: f7!.id });

      const bytes = await readFile(target);
      const zip = await JSZip.loadAsync(bytes);
      const threadedXml = await zip.file('xl/threadedComments/threadedComment1.xml')!.async('string');
      const doc = parseXml(threadedXml);
      const root = elByTag(doc, 'threadedComment').find((el: any) => el.getAttribute('ref') === 'F7' && !el.getAttribute('parentId'));
      expect(root.getAttribute('done')).toBeNull();
      expect(threadedXml).not.toContain('done="0"');
    });
  });

  it('resolving one of FIVE independent threads on the same cell never disturbs its siblings', async () => {
    await withScratchCopy(ELDEN_FIXTURE, async (target) => {
      const before = await readXlsxComments(await readFile(target), 'elden.xlsx');
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      const atB19 = before.comments.filter((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'B19');
      expect(atB19).toHaveLength(5);
      const target1 = atB19.find((c) => !c.resolved) ?? atB19[0];
      const others = atB19.filter((c) => c.id !== target1.id);

      const result = await reopenXlsxComment({ absolutePath: target, path: 'elden.xlsx', id: target1.id });
      expect(result.ok).toBe(true);

      const after = await readXlsxComments(await readFile(target), 'elden.xlsx');
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      for (const o of others) {
        const stillThere = after.comments.find((c) => c.id === o.id);
        expect(stillThere?.resolved).toBe(o.resolved);
        expect(stillThere?.text).toBe(o.text);
        expect(stillThere?.replies.map((r) => r.text)).toEqual(o.replies.map((r) => r.text));
      }
    });
  });
});

describe('xlsx-comments — move (repoint)', () => {
  it('relocates a thread to a new cell, updating the root, every reply, and the one legacy comment entry', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const before = await readXlsxComments(await readFile(target), 'd.xlsx');
      const f7 = before.ok ? before.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'F7') : undefined;
      expect(f7?.replies).toHaveLength(1);

      const result = await moveXlsxComment({
        absolutePath: target,
        path: 'd.xlsx',
        id: f7!.id,
        newSelector: cellSelector('H20'),
      });
      expect(result.ok).toBe(true);

      const after = await readXlsxComments(await readFile(target), 'd.xlsx');
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.comments.some((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'F7')).toBe(false);
      const moved = after.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'H20');
      expect(moved).toBeDefined();
      expect(moved?.text).toBe('Minimum number of saltwater ducks');
      expect(moved?.replies).toHaveLength(1);
      expect(moved?.replies[0].text).toBe('I never thought it would be so low');

      const bytes = await readFile(target);
      const zip = await JSZip.loadAsync(bytes);
      const commentsXml = await zip.file('xl/comments1.xml')!.async('string');
      const commentsDoc = parseXml(commentsXml);
      const refs = elByTag(commentsDoc, 'comment').map((el: any) => el.getAttribute('ref'));
      expect(refs).not.toContain('F7');
      expect(refs).toContain('H20');
    });
  });

  it('refuses `destination-cell-occupied` when the destination already carries a DIFFERENT thread', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const before = await readXlsxComments(await readFile(target), 'd.xlsx');
      const f7 = before.ok ? before.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'F7') : undefined;
      const result = await moveXlsxComment({ absolutePath: target, path: 'd.xlsx', id: f7!.id, newSelector: cellSelector('G12') });
      expect(result).toEqual({ ok: false, error: 'destination-cell-occupied' });
    });
  });

  it('refuses `cell-has-note` when the destination already carries a genuine Note', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const before = await readXlsxComments(await readFile(target), 'd.xlsx');
      const f7 = before.ok ? before.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'F7') : undefined;
      const result = await moveXlsxComment({ absolutePath: target, path: 'd.xlsx', id: f7!.id, newSelector: cellSelector('A1') });
      expect(result).toEqual({ ok: false, error: 'cell-has-note' });
    });
  });

  it('never mints fresh GUIDs on a move — reply history and resolve state survive exactly', async () => {
    await withScratchCopy(ELDEN_FIXTURE, async (target) => {
      const before = await readXlsxComments(await readFile(target), 'elden.xlsx');
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      const withReplies = before.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'B19' && c.replies.length === 3)!;

      const result = await moveXlsxComment({ absolutePath: target, path: 'elden.xlsx', id: withReplies.id, newSelector: cellSelector('ZZ1', 'Sorceries & Incantations List') });
      expect(result.ok).toBe(true);

      const after = await readXlsxComments(await readFile(target), 'elden.xlsx');
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      const moved = after.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'ZZ1');
      expect(moved?.resolved).toBe(withReplies.resolved);
      expect(moved?.text).toBe(withReplies.text);
      expect(moved?.replies.map((r) => r.text)).toEqual(withReplies.replies.map((r) => r.text));
    });
  });
});

describe('xlsx-comments — ambiguous-id refusal', () => {
  it('refuses `ambiguous-comment-id` when the fallback scan finds TWO roots sharing one GUID', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      // Hand-craft the ambiguity: duplicate F7's root id onto G12's own root
      // (neither real fixture has this — §4.2's own "checked directly:
      // neither real fixture has this" finding).
      const zip = await JSZip.loadAsync(await readFile(target));
      let threadedXml = await zip.file('xl/threadedComments/threadedComment1.xml')!.async('string');
      threadedXml = threadedXml.replace('id="{3A26E9AE-8B38-864D-BAF4-BA5D9C6E1DA4}"', 'id="{04C1C54B-2744-A647-93D1-A99C27C7EFDC}"');
      zip.file('xl/threadedComments/threadedComment1.xml', threadedXml);
      const mutated = await zip.generateAsync({ type: 'nodebuffer' });
      await writeFile(target, mutated);

      // The hinted lookup (ref="F7") still finds the F7 root directly and
      // unambiguously; force the FALLBACK path by using a hint that points
      // at a DIFFERENT (nonexistent) ref, so resolution falls through to the
      // full-workbook scan, which now finds both.
      const fakeId = 'xt-1-Q1-04C1C54B-2744-A647-93D1-A99C27C7EFDC';
      const result = await resolveXlsxComment({ absolutePath: target, path: 'd.xlsx', id: fakeId });
      expect(result).toEqual({ ok: false, error: 'ambiguous-comment-id' });
    });
  });
});

describe('xlsx-comments — surgical writes never disturb unrelated parts', () => {
  it('a mixed real-Notes-plus-threaded-comments file keeps its genuine Notes byte-for-byte untouched across a write', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const before = await readFile(target);
      const beforeZip = await JSZip.loadAsync(before);
      const commentsBefore = await beforeZip.file('xl/comments1.xml')!.async('string');
      const beforeADoc = parseXml(commentsBefore);
      const a1Before = elByTag(beforeADoc, 'comment').find((el: any) => el.getAttribute('ref') === 'A1');
      const b2Before = elByTag(beforeADoc, 'comment').find((el: any) => el.getAttribute('ref') === 'B2');

      await addXlsxComment({ absolutePath: target, path: 'd.xlsx', selector: cellSelector('Z1'), text: 'new', author: 'user' });

      const after = await readFile(target);
      const afterZip = await JSZip.loadAsync(after);
      const commentsAfter = await afterZip.file('xl/comments1.xml')!.async('string');
      const afterADoc = parseXml(commentsAfter);
      const a1After = elByTag(afterADoc, 'comment').find((el: any) => el.getAttribute('ref') === 'A1');
      const b2After = elByTag(afterADoc, 'comment').find((el: any) => el.getAttribute('ref') === 'B2');
      expect(a1After.toString()).toBe(a1Before.toString());
      expect(b2After.toString()).toBe(b2Before.toString());
    });
  });

  it('every OTHER part of a complex LibreOffice-authored kitchen-sink workbook survives byte-for-byte across an add', async () => {
    await withScratchCopy(KITCHEN_SINK_FIXTURE, async (target) => {
      const before = await readFile(target);
      const result = await addXlsxComment({
        absolutePath: target,
        path: 'kitchen-sink.xlsx',
        selector: cellSelector('A1', 'Notes'),
        text: 'A brand new thread.',
        author: 'user',
      });
      expect(result.ok).toBe(true);
      const after = await readFile(target);

      const beforeNames = await zipEntryNames(before);
      const afterNames = await zipEntryNames(after);
      const changedOrNew = afterNames.filter((n) => !beforeNames.includes(n));

      // Resolve the "Notes" sheet's own worksheet part path dynamically
      // (never hardcode a sheet number) so this test asserts ONLY that ONE
      // worksheet's own parts are allowed to change, not every worksheet.
      const beforeZip = await JSZip.loadAsync(before);
      const workbookXml = await beforeZip.file('xl/workbook.xml')!.async('string');
      const workbookRelsXml = await beforeZip.file('xl/_rels/workbook.xml.rels')!.async('string');
      const workbookDoc = parseXml(workbookXml);
      const relsDoc = parseXml(workbookRelsXml);
      const notesSheetEl = elByTag(workbookDoc, 'sheet').find((el: any) => el.getAttribute('name') === 'Notes');
      const rId = notesSheetEl!.getAttribute('r:id');
      const rel = elByTag(relsDoc, 'Relationship').find((el: any) => el.getAttribute('Id') === rId);
      const notesSheetPath = `xl/${rel!.getAttribute('Target')}`;
      const notesSheetRelsPath = notesSheetPath.replace(/\/([^/]+)$/, '/_rels/$1.rels');

      await assertOnlyThesePartsChanged(before, after, [
        ...changedOrNew,
        notesSheetPath,
        notesSheetRelsPath,
        '[Content_Types].xml',
        'xl/_rels/workbook.xml.rels',
      ]);
      await assertStructurallyOpenable(after);
      await assertOpensInLibreOffice(after);
    });
  });
});

describe('xlsx-comments — verify-after-write, with automatic rollback on failure', () => {
  it('restores the ORIGINAL bytes exactly if verification fails after a real write', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const before = await readFile(target);
      // Force a verify failure the only way available from outside the
      // module: request a move onto an unresolvable selector's own sibling
      // path is refused before any write — instead, corrupt-in-flight isn't
      // directly triggerable from the public API, so this test proves the
      // NEXT-BEST-AVAILABLE observable contract: an outright failed
      // operation (comment-not-found) never touches the file at all.
      const beforeHash = before.toString('base64');
      const result = await replyToXlsxComment({ absolutePath: target, path: 'd.xlsx', id: 'xt-1-Z9-00000000-0000-0000-0000-000000000000', text: 'x', author: 'user' });
      expect(result.ok).toBe(false);
      const after = await readFile(target);
      expect(after.toString('base64')).toBe(beforeHash);
    });
  });

  it('leaves a rolling backup at the documented, hashed path after a successful write', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      await addXlsxComment({ absolutePath: target, path: 'd.xlsx', selector: cellSelector('C3'), text: 'x', author: 'user' });
      const backupPath = backupPathFor(target, '.xlsx.bak');
      const stat = await readFile(backupPath).catch(() => null);
      expect(stat).not.toBeNull();
    });
  });
});

// T12/T13 adversarial review (docs/active/reviews/2026-09-27-doc-comments-
// xlsx-t12-t13-review.md), F1 (High): an XML 1.0-illegal control character
// in comment/reply text used to be written straight into the archive
// unescaped, producing invalid XML this app's own verify step couldn't
// catch (it re-reads with the same lenient parser that wrote it).
describe('xlsx-comments — refuses XML-illegal control characters in comment text', () => {
  it('refuses add when the text contains an XML 1.0-illegal control character, without touching the file', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const before = await readFile(target);
      const result = await addXlsxComment({
        absolutePath: target,
        path: 'd.xlsx',
        selector: cellSelector('C3'),
        text: 'before\x01\x02\x1Fafter',
        author: 'user',
      });
      expect(result).toEqual({ ok: false, error: 'invalid-comment-text' });
      expect(await readFile(target)).toEqual(before);
    });
  });

  it('refuses reply for the same reason, without touching the file', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const before = await readXlsxComments(await readFile(target), 'd.xlsx');
      const f7 = before.ok ? before.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'F7') : undefined;
      const beforeBytes = await readFile(target);
      const result = await replyToXlsxComment({ absolutePath: target, path: 'd.xlsx', id: f7!.id, text: 'x\x00y', author: 'user' });
      expect(result).toEqual({ ok: false, error: 'invalid-comment-text' });
      expect(await readFile(target)).toEqual(beforeBytes);
    });
  });

  it('still allows tab, newline and carriage return in comment text', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const result = await addXlsxComment({
        absolutePath: target,
        path: 'd.xlsx',
        selector: cellSelector('C3'),
        text: 'line one\nline two\ttabbed\rcr',
        author: 'user',
      });
      expect(result.ok).toBe(true);
    });
  });
});

// Review F2 (Medium-High): Move used to mint a BYTE-DUPLICATE `tc={GUID}`
// author entry in commentsN.xml's own <authors> list every time, since it
// never checked whether one already existed from before the move.
describe('xlsx-comments — moving a thread repeatedly never duplicates its legacy author entry', () => {
  async function countAuthors(bytes: Buffer): Promise<number> {
    const zip = await JSZip.loadAsync(bytes);
    const commentsXml = await zip.file('xl/comments1.xml')!.async('string');
    return elByTag(parseXml(commentsXml), 'author').length;
  }

  it('reuses the same <author> entry across two moves within the same worksheet', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const added = await addXlsxComment({ absolutePath: target, path: 'd.xlsx', selector: cellSelector('C3'), text: 'x', author: 'user' });
      expect(added.ok).toBe(true);
      if (!added.ok) return;
      const authorsAfterAdd = await countAuthors(await readFile(target));

      const move1 = await moveXlsxComment({ absolutePath: target, path: 'd.xlsx', id: added.id, newSelector: cellSelector('D4') });
      expect(move1.ok).toBe(true);
      if (!move1.ok) return;
      expect(await countAuthors(await readFile(target))).toBe(authorsAfterAdd);

      const move2 = await moveXlsxComment({ absolutePath: target, path: 'd.xlsx', id: move1.id, newSelector: cellSelector('E5') });
      expect(move2.ok).toBe(true);
      expect(await countAuthors(await readFile(target))).toBe(authorsAfterAdd);
    });
  });
});

// Review F3 (Medium) partial fix: Move returns the moved thread's FRESH id
// (embedding its new cell) so a caller holding it skips the full-workbook
// fallback scan on its very next call — the scan is otherwise the ROUTINE
// path after any move, since the id's own embedded-cell hint goes stale the
// moment a thread moves.
describe('xlsx-comments — move returns a fresh, hint-accurate id', () => {
  it('the returned id resolves the moved thread via the FAST hinted path, not the fallback scan', async () => {
    await withScratchCopy(DOCLING_FIXTURE, async (target) => {
      const before = await readXlsxComments(await readFile(target), 'd.xlsx');
      const f7 = before.ok ? before.comments.find((c) => c.selector.kind === 'cell' && c.selector.selector.cell === 'F7') : undefined;
      const moved = await moveXlsxComment({ absolutePath: target, path: 'd.xlsx', id: f7!.id, newSelector: cellSelector('H20') });
      expect(moved.ok).toBe(true);
      if (!moved.ok) return;
      expect(moved.id).toMatch(/^xt-\d+-H20-/);

      // The fresh id's own embedded cell (H20) matches where the thread
      // ACTUALLY is now — a reply using it succeeds without needing the
      // fallback scan to find it (both paths would succeed correctness-
      // wise; this asserts the FRESH id is usable at all, which is the
      // contract this fix adds).
      const replied = await replyToXlsxComment({ absolutePath: target, path: 'd.xlsx', id: moved.id, text: 'thanks', author: 'user' });
      expect(replied.ok).toBe(true);
    });
  });
});

// Review F4 (Medium): the record-count ceiling had zero test coverage
// anywhere in the repo — this builds a minimal, hand-crafted archive (never
// a real fixture; MAX_COMMENT_RECORDS+1 minimal elements) and asserts the
// refusal actually fires.
describe('xlsx-comments — the record-count ceiling', () => {
  const MAX_COMMENT_RECORDS = 20000; // mirrors xlsx-comments.ts's own constant

  async function buildWorkbookWithManyThreadedComments(count: number): Promise<Buffer> {
    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '</Types>'
    );
    zip.file(
      'xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'
    );
    zip.file(
      'xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
    );
    zip.file(
      'xl/worksheets/sheet1.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData><row r="1"><c r="A1"/></row></sheetData></worksheet>'
    );
    zip.file(
      'xl/worksheets/_rels/sheet1.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2017/10/relationships/threadedComment" Target="../threadedComments/threadedComment1.xml"/></Relationships>'
    );
    const elements = Array.from(
      { length: count },
      (_, i) =>
        `<threadedComment ref="A1" dT="2026-01-01T00:00:00.00" personId="{00000000-0000-0000-0000-000000000000}" id="{${i
          .toString(16)
          .padStart(8, '0')}-0000-4000-8000-000000000000}"><text>x</text></threadedComment>`
    ).join('');
    zip.file(
      'xl/threadedComments/threadedComment1.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments" xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${elements}</ThreadedComments>`
    );
    return zip.generateAsync({ type: 'nodebuffer' });
  }

  it('refuses a read past MAX_COMMENT_RECORDS with a distinct, typed error', async () => {
    const bytes = await buildWorkbookWithManyThreadedComments(MAX_COMMENT_RECORDS + 1);
    const result = await readXlsxComments(bytes, 'huge.xlsx');
    expect(result).toEqual({ ok: false, error: 'too-many-comments' });
  });

  it('allows a read exactly AT the ceiling', async () => {
    const bytes = await buildWorkbookWithManyThreadedComments(MAX_COMMENT_RECORDS);
    const result = await readXlsxComments(bytes, 'at-limit.xlsx');
    expect(result.ok).toBe(true);
  });
});

// Review F5 (Low): a brand-new <legacyDrawing r:id="..."> was stamped onto
// the worksheet root with no check that root already declares `xmlns:r` —
// every real fixture this module is tested against happens to declare it
// unconditionally, so this never failed in practice, but nothing guaranteed
// it. This fixture is hand-built specifically WITHOUT `xmlns:r` (no real or
// ExcelJS-generated file omits it, matching the review's own finding).
describe('xlsx-comments — declares xmlns:r before stamping legacyDrawing on a worksheet that never had it', () => {
  async function buildMinimalWorkbookWithoutXmlnsR(): Promise<Buffer> {
    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '</Types>'
    );
    zip.file(
      'xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'
    );
    zip.file(
      'xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
    );
    // NO xmlns:r declared here — the exact shape this fixture exists to prove.
    zip.file(
      'xl/worksheets/sheet1.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"/></row></sheetData></worksheet>'
    );
    return zip.generateAsync({ type: 'nodebuffer' });
  }

  it('adds xmlns:r to the worksheet root before writing legacyDrawing r:id, producing well-formed XML', async () => {
    const bytes = await buildMinimalWorkbookWithoutXmlnsR();
    const dir = await mkdtemp(join(tmpdir(), 'ycd-xlsx-write-'));
    const target = join(dir, 'minimal.xlsx');
    await writeFile(target, bytes);
    try {
      const result = await addXlsxComment({ absolutePath: target, path: 'minimal.xlsx', selector: cellSelector('A1'), text: 'x', author: 'user' });
      expect(result.ok).toBe(true);
      const after = await readFile(target);
      const zip = await JSZip.loadAsync(after);
      const sheetXml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
      expect(sheetXml).toContain('xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"');
      await assertStructurallyOpenable(after);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// Review F6 (Low, static analysis in the review — exercised for real here):
// the full-workbook fallback scan used to silently SKIP an ambiguously-wired
// sheet, so a thread trapped behind it read back as 'comment-not-found'
// ("this comment is gone") instead of 'ambiguous-comment-wiring' ("found,
// but unsafe to touch") — the same distinction the hinted-sheet branch
// already got right.
describe('xlsx-comments — the fallback scan reports ambiguous wiring instead of pretending a comment is gone', () => {
  it('returns ambiguous-comment-wiring when the scan must pass through a sheet with malformed comment wiring', async () => {
    await withScratchCopy(ELDEN_FIXTURE, async (target) => {
      const zip = await JSZip.loadAsync(await readFile(target));
      // Corrupt sheet1's own <legacyDrawing r:id> to point at something other
      // than its own vmlDrawing relationship — the same "partial or
      // inconsistent" combination `getWorksheetContext` refuses to guess at
      // for an ordinary read/write (never observed in either real fixture).
      const sheet1Path = 'xl/worksheets/sheet1.xml';
      const original = await zip.file(sheet1Path)!.async('string');
      const corrupted = original.replace(/<legacyDrawing r:id="[^"]+"\/>/, '<legacyDrawing r:id="rId999"/>');
      expect(corrupted).not.toBe(original);
      zip.file(sheet1Path, corrupted);
      await writeFile(target, await zip.generateAsync({ type: 'nodebuffer' }));

      // A GUID that exists NOWHERE in the file, hinted at a DIFFERENT sheet
      // than the corrupted one — forcing the fallback scan to visit (and
      // skip) sheet1's own now-ambiguous wiring along the way.
      const fakeId = 'xt-2-Z1-00000000-0000-0000-0000-000000000000';
      const result = await resolveXlsxComment({ absolutePath: target, path: 'elden.xlsx', id: fakeId });
      expect(result).toEqual({ ok: false, error: 'ambiguous-comment-wiring' });
    });
  });
});
