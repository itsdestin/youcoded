// T18's own spike self-check (docs/active/specs/2026-09-26-doc-comments-
// build-design.md §4.3a, T18; review 2, F17): "a documented, watched risk...
// If exceljs is later bumped and its output shape changes even slightly...
// T19's Kotlin target silently stops matching what desktop's CURRENT
// `xlsx-comments.ts` actually produces... T18/T19's own re-run of desktop's
// writer against the fixture workbook re-diffs its output against the
// checked-in reference every time it runs, so drift fails loudly at test
// time... rather than only being caught by intuition."
//
// This is that re-diff, run on every `npm test`/CI: re-executes the EXACT
// same capture `tests/fixtures/doc-comments/generate-xlsx-note-reference.mjs`
// performs (same helper module, same minimal fixture, same real
// `addXlsxComment` write path) and asserts the result is byte-identical to
// the checked-in reference under `shared-fixtures/doc-comments/
// xlsx-note-reference/`. A failure here means either exceljs's own OOXML
// output changed (regenerate the reference and update T19's Kotlin writer to
// match) or this app's own write-path body-formatting convention changed
// (§4.1) — never something to silence by re-running the generator without
// reading why it changed first.
import { describe, it, expect } from 'vitest';
import { readFile, mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import ExcelJS from 'exceljs';
import { addXlsxComment } from '../src/main/doc-comments/xlsx-comments';
import { captureXlsxNoteParts, buildBlankSingleCellWorkbook } from './fixtures/doc-comments/xlsx-note-parts.mjs';

// desktop/tests -> desktop -> youcoded/ -> shared-fixtures/...
const REFERENCE_DIR = join(__dirname, '..', '..', 'shared-fixtures', 'doc-comments', 'xlsx-note-reference');

const RAW_PART_NAMES = [
  'content-types.xml',
  'workbook.xml',
  'workbook.xml.rels',
  'sheet1.xml.rels',
  'sheet1.xml',
  'comments1.xml',
  'vmlDrawing1.vml',
];

async function freshCapture() {
  const dir = await mkdtemp(join(tmpdir(), 'ycd-xlsx-note-ref-drift-'));
  try {
    const target = join(dir, 'blank.xlsx');
    const wb = await buildBlankSingleCellWorkbook(ExcelJS);
    await wb.xlsx.writeFile(target);

    const result = await addXlsxComment({
      absolutePath: target,
      path: 'reports/blank.xlsx',
      selector: { kind: 'cell', selector: { type: 'CellSelector', cell: 'A1' } },
      text: 'A brand new note.',
      author: 'user',
    });
    if (!result.ok) throw new Error(`addXlsxComment failed: ${result.error}`);

    const bytes = await readFile(target);
    return captureXlsxNoteParts(bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('xlsx-note-reference — the checked-in T19 target stays in sync with exceljs', () => {
  it('every raw OOXML part matches the checked-in reference byte-for-byte', async () => {
    const { rawParts } = await freshCapture();
    for (const name of RAW_PART_NAMES) {
      const checkedIn = await readFile(join(REFERENCE_DIR, name), 'utf8');
      expect(rawParts[name], `part "${name}" drifted from the checked-in reference`).toBe(checkedIn);
    }
  });

  it('the manifest (content-types strings, rels order, legacyDrawing position) matches', async () => {
    const { manifest } = await freshCapture();
    const checkedIn = JSON.parse(await readFile(join(REFERENCE_DIR, 'manifest.json'), 'utf8'));
    expect(manifest).toEqual(checkedIn);
  });

  // Not a drift check — a guard against silently capturing the WRONG file
  // (implementation-review-shaped risk this task's own row calls out:
  // "getting the reference capture wrong... undermines T19 and T21 both").
  it('the reference is a real, valid workbook exceljs can re-load, not hand-edited XML', async () => {
    const bytes = await readFile(join(REFERENCE_DIR, 'single-note.xlsx'));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as any);
    const cell = wb.worksheets[0].getCell('A1');
    expect(cell.note).toBeDefined();
  });
});
