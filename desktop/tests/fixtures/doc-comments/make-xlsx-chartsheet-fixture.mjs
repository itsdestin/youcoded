#!/usr/bin/env node
// Generates chartsheet-workbook.xlsx — the shared fixture for F2 (parity
// review of T18/XlsxComments.kt, docs/active/specs/2026-09-26-doc-comments-
// build-design.md §4.2/§4.3a): a workbook with exactly ONE real worksheet
// plus one CHARTSHEET, used to pin that a chartsheet must never be counted
// as a worksheet when deciding whether a workbook is "single-sheet" (which
// controls whether `sheet` is stamped onto a comment's own selector, §4.2).
//
// WHY this can't be built with exceljs alone: exceljs's own writer has NO
// chartsheet support at all (`workbook-xform.js`'s own `reconcile()` source
// comment: "As we don't have the infrastructure to support chartsheets, we
// will ignore them for now") — there is no `wb.addChartsheet()` API. This
// script therefore builds an ordinary one-worksheet workbook with exceljs
// (a real note, so the fixture also exercises the normal read path, not just
// the sheet-counting edge case), then SURGICALLY splices in a minimal,
// schema-valid chartsheet part by hand:
//   1. `xl/chartsheets/sheet2.xml` — a bare `<chartsheet>` part. Never read by
//      either reader under test (Android's `XlsxComments.kt` only resolves a
//      sheet's relationship Type before ever opening its target; desktop's
//      exceljs skips it during `reconcile()`, per the citation above), so it
//      needs no real chart content to prove the sheet-counting behaviour.
//   2. `xl/workbook.xml` — a second `<sheet>` entry naming it.
//   3. `xl/_rels/workbook.xml.rels` — a relationship whose Type ends in
//      `/relationships/chartsheet` (never `/relationships/worksheet`) —
//      the ONE OOXML-correct signal that tells a worksheet from a chartsheet
//      apart (never file extension or target-path guessing).
//   4. `[Content_Types].xml` — an Override for the new part.
//
// Run from desktop/:
//   node tests/fixtures/doc-comments/make-xlsx-chartsheet-fixture.mjs
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CHARTSHEET_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<chartsheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<sheetPr/><sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
  '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
  '</chartsheet>';

const CHARTSHEET_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet';
const CHARTSHEET_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml';

const wb = new ExcelJS.Workbook();
const data = wb.addWorksheet('Data');
data.columns = [{ width: 12 }, { width: 24 }];
data.addRow(['Metric', 'Value']).font = { bold: true };
data.addRow(['Revenue', 128000]);
data.addRow(['Costs', 96000]);
// A plain, single-author note — proves the normal read path still works on
// this fixture, not just the sheet-counting edge case.
data.getCell('B2').note = 'Priya Shah: Confirm this against the finance close.';

const rawBuf = Buffer.from(await wb.xlsx.writeBuffer());
const zip = await JSZip.loadAsync(rawBuf);

// 1. The chartsheet part itself.
zip.file('xl/chartsheets/sheet2.xml', CHARTSHEET_XML);

// 2. workbook.xml: append a second <sheet> entry for the chartsheet.
const WORKBOOK_PATH = 'xl/workbook.xml';
const workbookXml = await zip.file(WORKBOOK_PATH).async('string');
const patchedWorkbook = workbookXml.replace(
  /<\/sheets>/,
  '<sheet name="Chart1" sheetId="2" r:id="rId2"/></sheets>',
);
if (patchedWorkbook === workbookXml) {
  throw new Error('workbook.xml patch did not match anything — fixture generator needs updating');
}
zip.file(WORKBOOK_PATH, patchedWorkbook);

// 3. workbook.xml.rels: a relationship whose Type is chartsheet, never
// worksheet — this is the exact field F2's fix filters on.
const RELS_PATH = 'xl/_rels/workbook.xml.rels';
const relsXml = await zip.file(RELS_PATH).async('string');
const patchedRels = relsXml.replace(
  /<\/Relationships>/,
  `<Relationship Id="rId2" Type="${CHARTSHEET_REL_TYPE}" Target="chartsheets/sheet2.xml"/></Relationships>`,
);
if (patchedRels === relsXml) {
  throw new Error('workbook.xml.rels patch did not match anything — fixture generator needs updating');
}
zip.file(RELS_PATH, patchedRels);

// 4. [Content_Types].xml: an Override for the new part — a real Excel-written
// file always carries one; omitting it would make this fixture a weaker proof
// that the reader keys off the RELATIONSHIP TYPE, not the part's mere
// presence.
const CONTENT_TYPES_PATH = '[Content_Types].xml';
const contentTypesXml = await zip.file(CONTENT_TYPES_PATH).async('string');
const patchedContentTypes = contentTypesXml.replace(
  /<\/Types>/,
  `<Override PartName="/xl/chartsheets/sheet2.xml" ContentType="${CHARTSHEET_CONTENT_TYPE}"/></Types>`,
);
if (patchedContentTypes === contentTypesXml) {
  throw new Error('[Content_Types].xml patch did not match anything — fixture generator needs updating');
}
zip.file(CONTENT_TYPES_PATH, patchedContentTypes);

const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

const out = join(dirname(fileURLToPath(import.meta.url)), 'chartsheet-workbook.xlsx');
writeFileSync(out, buf);
console.log('wrote', out, buf.length, 'bytes');
