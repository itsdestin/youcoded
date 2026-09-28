#!/usr/bin/env node
// Generates synthetic-worksheet-with-extlst.xlsx — the shared fixture for the
// <legacyDrawing>-after-<extLst> ordering rule (docs/active/specs/2026-09-26-
// doc-comments-build-design.md §4.3 step 1, design review round 2 F4): a
// worksheet with a pre-existing worksheet-level <extLst> element and NO
// comments/threaded-comments wiring yet, used to pin that a brand-new
// <legacyDrawing> this app's writer inserts lands AFTER that <extLst>, never
// before it (a naive schema-order `insertBefore` would get this wrong).
//
// WHY a synthetic fixture, not one of the two real threaded-comments samples:
// neither `docling-xlsx-comments.xlsx` nor `elden-ring-completionist-
// checklist.xlsx` has a worksheet-level <extLst> at all (confirmed directly —
// see the design doc's own §4.3 citation), so a regression here would go
// completely unnoticed against either real fixture.
//
// Shared between this task's own TS pinning test (xlsx-comments.test.ts) and
// the Kotlin equivalent (T18/T19, XlsxComments.kt, not built in this
// session) — ONE fixture, not two independently hand-built ones, so a
// Kotlin-side and a TS-side element-ordering bug can't each independently
// pass against a fixture the other platform's own version doesn't share.
//
// Run from desktop/:
//   node tests/fixtures/doc-comments/make-synthetic-extlst-fixture.mjs
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const wb = new ExcelJS.Workbook();
const sheet = wb.addWorksheet('Notes');
sheet.getCell('A1').value = 'placeholder';

const rawBuf = Buffer.from(await wb.xlsx.writeBuffer());
const zip = await JSZip.loadAsync(rawBuf);

const SHEET_PATH = 'xl/worksheets/sheet1.xml';
const sheetXml = await zip.file(SHEET_PATH).async('string');
// A plausible real-world worksheet-level extLst (shaped like the kind a
// conditional-formatting or sparkline extension would leave behind) —
// content is never read by this app's writer, only its PRESENCE and
// POSITION matter for this fixture's purpose.
const injectedExtLst =
  '<extLst><ext uri="{05C60535-1F16-4FD2-B633-F4F36F0B64E0}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:id>{00000000-0000-0000-0000-000000000000}</x14:id></ext></extLst>';
const patched = sheetXml.replace('</worksheet>', `${injectedExtLst}</worksheet>`);
if (patched === sheetXml) {
  throw new Error('sheet1.xml patch did not match anything — fixture generator needs updating');
}
zip.file(SHEET_PATH, patched);

const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

// desktop/tests/fixtures/doc-comments -> desktop -> youcoded/ -> shared-fixtures/...
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const out = join(REPO_ROOT, 'shared-fixtures', 'doc-comments', 'synthetic-worksheet-with-extlst.xlsx');
writeFileSync(out, buf);
console.log('wrote', out, buf.length, 'bytes');
