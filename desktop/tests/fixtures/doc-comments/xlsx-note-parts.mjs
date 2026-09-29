// Shared capture logic for T18's xlsx OOXML spike
// (docs/active/specs/2026-09-26-doc-comments-build-design.md §4.3a, T18).
//
// WHY this exists as its OWN small module rather than living inline in the
// generator script: it is imported by BOTH
// `generate-xlsx-note-reference.mjs` (hand-run, regenerates the checked-in
// reference under `shared-fixtures/doc-comments/xlsx-note-reference/`) and
// `desktop/tests/xlsx-note-reference-drift.test.ts` (runs on every `npm
// test`/CI, re-diffing a FRESH capture against that same checked-in
// reference — review 2, F17's own "re-diffs its output against the checked-in
// reference every time it runs, so drift fails loudly" instruction). Both
// need byte-identical extraction logic, or a change to one but not the other
// would make the drift check meaningless.
//
// Plain ESM/JS (no TypeScript syntax) so it loads unmodified from a bare
// `node generate-xlsx-note-reference.mjs` invocation (no transpiler) AND from
// vitest's own transpiling test runner — same reasoning
// `make-xlsx-fixture.mjs`/`oversized-zip.ts` already split along (this file
// has no TS-only syntax, so unlike `oversized-zip.ts` it doesn't need the
// `.ts` extension to be importable from a `.test.ts` file).
//
// WHAT is captured, and why these specific parts: §4.3a names exactly four
// pieces exceljs's `cell.note` setter writes beyond the note TEXT itself —
// (a) the VML preamble/namespaces verbatim, (b) `legacyDrawing`'s required
// position after `extLst`, (c) the vml Content-Types `Default` entry's exact
// non-`+xml` content type string, (d) both worksheet-rels entries in the same
// relative order exceljs emits them. This module captures all four, plus the
// raw `comments<N>.xml`/`vmlDrawing<N>.vml` text a Kotlin writer (T19, not
// this task) must reproduce byte-for-byte-equivalent shapes of.
import JSZip from 'jszip';

/**
 * @param {Buffer | Uint8Array} bytes — an .xlsx written with a SINGLE legacy
 *   Note on its first (only) worksheet's A1 cell, added via the real
 *   `addXlsxComment` write path (desktop's own §4.3 wiring), so the note BODY
 *   text reflects this app's own "Name: text" convention, not a bare exceljs
 *   default.
 * @returns {Promise<{rawParts: Record<string,string>, manifest: object}>}
 */
export async function captureXlsxNoteParts(bytes) {
  const zip = await JSZip.loadAsync(bytes);

  async function readText(path) {
    const file = zip.file(path);
    if (!file) throw new Error(`captureXlsxNoteParts: missing expected part "${path}"`);
    return file.async('string');
  }

  const contentTypesXml = await readText('[Content_Types].xml');
  const workbookXml = await readText('xl/workbook.xml');
  const workbookRelsXml = await readText('xl/_rels/workbook.xml.rels');
  const sheet1RelsXml = await readText('xl/worksheets/_rels/sheet1.xml.rels');
  const sheet1Xml = await readText('xl/worksheets/sheet1.xml');
  const comments1Xml = await readText('xl/comments1.xml');
  const vmlDrawing1Vml = await readText('xl/drawings/vmlDrawing1.vml');

  // (c): the vml Default entry's exact, non-"+xml" content type string —
  // pulled out of the raw XML by regex rather than a full XML parse, since
  // this capture script's whole point is to record the LITERAL string a
  // from-scratch Kotlin writer must match, not a re-interpreted value.
  const vmlDefaultMatch = /<Default Extension="vml" ContentType="([^"]+)"\/>/.exec(contentTypesXml);
  const commentsOverrideMatch = /<Override PartName="\/xl\/comments1\.xml" ContentType="([^"]+)"\/>/.exec(
    contentTypesXml
  );

  // (b): legacyDrawing's position relative to extLst — this fixture's sheet
  // has no <extLst> (a plain workbook with no data validation/conditional
  // formatting extensions never gets one), so the OBSERVABLE fact here is
  // "legacyDrawing is the LAST child of <worksheet>, whatever precedes it" —
  // confirmed against exceljs's own worksheet-xform.js source (§4.3a's own
  // citation, `worksheet-xform.js:345-351`): `this.map.extLst.render(...)`
  // is called immediately before the `legacyDrawing` loop, with nothing
  // rendered after either. Fixtures that DO carry a real `<extLst>` (data
  // validation, conditional formatting) would show `legacyDrawing` right
  // after it — not captured here since this reference targets the plain
  // "add a note" case T19 actually needs to build first.
  const legacyDrawingMatch = /<legacyDrawing r:id="([^"]+)"\/><\/worksheet>/.exec(sheet1Xml);

  // (d): both worksheet-rels entries, in ORDER — extracted as a plain ordered
  // list of {Id, Type, Target} so the drift test can assert order AND values
  // without re-parsing full XML semantics.
  const relEntries = [...sheet1RelsXml.matchAll(/<Relationship Id="([^"]+)" Type="([^"]+)" Target="([^"]+)"\/>/g)].map(
    (m) => ({ id: m[1], type: m[2], target: m[3] })
  );

  const manifest = {
    contentTypes: {
      vmlDefaultContentType: vmlDefaultMatch?.[1] ?? null,
      commentsOverrideContentType: commentsOverrideMatch?.[1] ?? null,
    },
    worksheetRels: relEntries,
    legacyDrawingImmediatelyPrecedesClosingWorksheetTag: legacyDrawingMatch !== null,
    legacyDrawingRelationshipId: legacyDrawingMatch?.[1] ?? null,
  };

  const rawParts = {
    'content-types.xml': contentTypesXml,
    'workbook.xml': workbookXml,
    'workbook.xml.rels': workbookRelsXml,
    'sheet1.xml.rels': sheet1RelsXml,
    'sheet1.xml': sheet1Xml,
    'comments1.xml': comments1Xml,
    'vmlDrawing1.vml': vmlDrawing1Vml,
  };

  return { rawParts, manifest };
}

/** Builds the minimal single-sheet, single-cell fixture this capture targets
 *  (§4.3a's own "produce OOXML matching this reference's shape for a NEW
 *  note" framing — the simplest case a from-scratch Kotlin writer needs to
 *  get right first). Exported so the generator and the drift test build the
 *  EXACT same starting workbook. */
export async function buildBlankSingleCellWorkbook(ExcelJS) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Sheet1');
  sheet.getCell('A1').value = 'Hello';
  return wb;
}
