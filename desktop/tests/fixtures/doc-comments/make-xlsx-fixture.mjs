#!/usr/bin/env node
// Generates q3-sales-by-rep.xlsx — the REAL workbook T12's pinning tests read
// (docs/active/specs/2026-09-26-doc-comments-build-design.md §4.2, §8 T12).
// Two sheets, same shape as the doc-comments MOCK's own
// `fixtures/sheets/make-by-rep.mjs` (Q3 + By rep), extended with THREE real
// legacy cell Notes written by exceljs itself (the same library the real
// desktop/src/main/doc-comments/xlsx-comments.ts reader uses) so this is a
// genuine round-trip fixture, not hand-rolled OOXML:
//   - Q3!B2       — a plain single-author note on the FIRST sheet.
//   - By rep!B4   — a plain note on a NON-FIRST sheet (T12: "multi-sheet
//                   cell targeting" — the read path must not assume sheet 0).
//   - By rep!B5   — a note with a reply thread AND the resolve marker
//                   (§4.1's `​[[yc:resolved]]` token), exercising the
//                   transcript-parsing half of xlsx-comments.ts's reader.
//
// WHY every commented cell also has a plain VALUE (not just a note): measured
// against the installed exceljs@4.4.0 (2026-09-26) — a note on a cell with NO
// other value is silently dropped on its own read-back. `wb.xlsx.writeBuffer()`
// omits the `<c r="...">` element entirely for a value-less commented cell
// (only the enclosing `<row>` survives), so `xl/comments2.xml` still names the
// ref but nothing in `sheet2.xml`'s `sheetData` points back at it — and on
// load, exceljs's `worksheet-xform.js` only re-attaches a comment to a cell it
// finds while parsing `sheetData`, so the note never reappears via
// `cell.note`/`eachRow`. Every real-world commented cell in this fixture has a
// value, matching the common case (annotating a number that's actually there);
// a note-only cell is a known exceljs limitation, not something T12 pins.
//
// Run from desktop/:
//   node tests/fixtures/doc-comments/make-xlsx-fixture.mjs
import ExcelJS from 'exceljs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROWS = [
  ['West', 'Priya', 128, 'Jul'], ['East', 'Marcus', 96, 'Jul'], ['North', 'Lena', 41, 'Jul'],
  ['South', 'Diego', 151, 'Jul'], ['Central', 'Aisha', 88, 'Jul'], ['West', 'Priya', 112, 'Aug'],
  ['East', 'Marcus', 134, 'Aug'], ['North', 'Lena', 57, 'Aug'], ['South', 'Diego', 122, 'Aug'],
  ['Central', 'Aisha', 91, 'Aug'], ['West', 'Priya', 143, 'Sep'], ['East', 'Marcus', 108, 'Sep'],
  ['North', 'Lena', 63, 'Sep'], ['South', 'Diego', 167, 'Sep'], ['Central', 'Aisha', 99, 'Sep'],
];

// The exact machine-readable resolve marker §4.1 specifies: a leading
// zero-width space plus a bracketed token, inert in ordinary prose so a
// legitimate reply can never accidentally read as resolved.
const RESOLVED_MARKER = '​[[yc:resolved]]';

const wb = new ExcelJS.Workbook();

const q3 = wb.addWorksheet('Q3');
q3.columns = [{ width: 12 }, { width: 12 }, { width: 10 }, { width: 8 }];
q3.addRow(['Region', 'Rep', 'Amount', 'Month']).font = { bold: true };
for (const r of ROWS) q3.addRow(r);
// A plain, no-reply note on the FIRST sheet (Region column header row 2).
q3.getCell('B2').note = 'Priya Shah: West is Priya’s territory as of this quarter.';

// Rep order Priya, Marcus, Lena… so Lena's total lands in B4 (matches the
// doc-comments mockup's own seed comment position).
const byRep = wb.addWorksheet('By rep');
byRep.columns = [{ width: 12 }, { width: 12 }];
byRep.addRow(['Rep', 'Q3 total']).font = { bold: true };
for (const rep of ['Priya', 'Marcus', 'Lena', 'Diego', 'Aisha']) {
  byRep.addRow([rep, ROWS.filter((r) => r[1] === rep).reduce((a, r) => a + r[2], 0)]);
}
// A plain note on a NON-FIRST sheet — the case T12's own test list names.
byRep.getCell('B4').note = 'Priya Shah: North looks low for July — was the Denver account left out?';
// A note with a reply thread AND the resolve marker, on the same non-first
// sheet — exercises xlsx-comments.ts's transcript parsing end to end.
byRep.getCell('B5').note =
  'Priya Shah: Diego’s numbers look great this quarter.\n\n' +
  'Marcus Lee: Agreed — his new accounts are paying off.\n' +
  RESOLVED_MARKER;

const buf = Buffer.from(await wb.xlsx.writeBuffer());
const out = join(dirname(fileURLToPath(import.meta.url)), 'q3-sales-by-rep.xlsx');
writeFileSync(out, buf);
console.log('wrote', out, buf.length, 'bytes');
