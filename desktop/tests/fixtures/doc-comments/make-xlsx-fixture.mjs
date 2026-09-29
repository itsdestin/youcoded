#!/usr/bin/env node
// Generates q3-sales-by-rep.xlsx — the REAL workbook T12's pinning tests read
// (docs/active/specs/2026-09-26-doc-comments-build-design.md §4.2, §8 T12).
// Two sheets, same shape as the doc-comments MOCK's own
// `fixtures/sheets/make-by-rep.mjs` (Q3 + By rep), extended with real legacy
// cell Notes written by exceljs itself (the same library the real
// desktop/src/main/doc-comments/xlsx-comments.ts reader uses) so this is a
// genuine round-trip fixture, not hand-rolled OOXML:
//   - Q3!B2       — a plain single-author note on the FIRST sheet.
//   - Q3!B18      — a BORDERED, VALUE-LESS cell with a note (implementation-
//                   review F1 — pins `includeEmpty: true`; see the surgical
//                   post-processing step below for why this cell needs one).
//   - Q3!B19      — a foreign, colon-free note this app never wrote
//                   (implementation-review F5).
//   - Q3!B20      — a foreign note whose text happens to contain a colon
//                   that is NOT this app's "Name:" convention (F5).
//   - By rep!B4   — a plain note on a NON-FIRST sheet (T12: "multi-sheet
//                   cell targeting" — the read path must not assume sheet 0).
//   - By rep!B5   — a note with a reply thread AND the CURRENT resolve
//                   marker (§4.1, implementation-review F4), exercising the
//                   transcript-parsing half of xlsx-comments.ts's reader.
//   - By rep!B6   — a note with a reply thread AND the LEGACY resolve marker
//                   (F4: the reader must keep recognizing the old token so an
//                   already-resolved file never silently flips back open).
//   - By rep!B7   — a real, human-typed note whose text happens to end with
//                   the literal words "✓ Resolved" but carries NO leading
//                   zero-width space — must NOT be read as resolved (F4).
//
// WHY every commented cell except B18 also has a plain VALUE: measured
// against the installed exceljs@4.4.0 (2026-09-26) — a note on a cell with NO
// other value is silently dropped on its own read-back. `wb.xlsx.writeBuffer()`
// omits the `<c r="...">` element entirely for a value-less commented cell
// (only the enclosing `<row>` survives), so `xl/comments2.xml` still names the
// ref but nothing in `sheet2.xml`'s `sheetData` points back at it — and on
// load, exceljs's `worksheet-xform.js` only re-attaches a comment to a cell it
// finds while parsing `sheetData`, so the note never reappears via
// `cell.note`/`eachRow`. Every real-world commented cell in this fixture that
// needs a genuine round trip therefore also has a value.
//
// HOW B18 gets a real value-less-but-styled cell anyway: exceljs itself can't
// WRITE that shape (the limitation just above), so B18 is given a real
// placeholder VALUE plus a border, written normally, and then the generated
// archive is surgically patched afterward to remove just that one cell's
// `<v>…</v>` — leaving its style (the border) and its comments/vmlDrawing
// wiring untouched, exactly like a real Excel note on a styled-but-empty
// placeholder cell. This reuses exceljs's own correct comment/VML/rels/
// content-types wiring rather than hand-rolling the OOXML §4.3a warns is
// "closer to writing a tiny OOXML library" — only the one `<v>` node is
// touched, by direct string surgery on the already-written sheet XML.
//
// Run from desktop/:
//   node tests/fixtures/doc-comments/make-xlsx-fixture.mjs
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
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

// §4.1's current resolve marker (implementation-review F4): a leading
// zero-width space followed by plain, human-legible text — never a bracketed
// machine token (the ORIGINAL marker, kept below only so the fixture can also
// exercise backward-compatible reading of a file an earlier build resolved).
const RESOLVED_MARKER = '​✓ Resolved';
const LEGACY_RESOLVED_MARKER = '​[[yc:resolved]]';
// A real reply that happens to end with the same visible words as the
// marker, but typed by a human — no leading ZWSP. Must NOT be read as
// resolved (F4's own negative case).
const LOOKALIKE_NOT_A_MARKER = '✓ Resolved';

const wb = new ExcelJS.Workbook();

const q3 = wb.addWorksheet('Q3');
q3.columns = [{ width: 12 }, { width: 12 }, { width: 10 }, { width: 8 }];
q3.addRow(['Region', 'Rep', 'Amount', 'Month']).font = { bold: true };
for (const r of ROWS) q3.addRow(r);
// A plain, no-reply note on the FIRST sheet (Region column header row 2).
q3.getCell('B2').note = 'Priya Shah: West is Priya’s territory as of this quarter.';

// F1: a bordered, VALUE-LESS cell with a note — a styled placeholder the
// reader must still find with `includeEmpty: true`. Given a real value here
// (exceljs can't write a note-only cell at all — see header) so it round-
// trips normally; the value is stripped by direct XML surgery below, AFTER
// exceljs has already written the correct comments/vmlDrawing/rels wiring.
const borderedEmptyCell = q3.getCell('B18');
borderedEmptyCell.value = 0; // placeholder — removed by the post-write patch below
borderedEmptyCell.border = {
  top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' },
};
borderedEmptyCell.note = 'Priya Shah: Reserved for the September actuals once they post.';

// F5: a foreign note this app never wrote — no colon anywhere, so the old
// code's regex simply failed to match and (the actual bug) dropped the whole
// body. Must read back with its full text intact and a neutral author.
// (A placeholder value — same reason as B18, minus the strip: exceljs drops
// a note entirely on a truly value-less cell, so any cell that needs to
// round-trip through a real write must carry SOME value.)
q3.getCell('B19').value = 'flagged';
q3.getCell('B19').note = 'Diego mentioned this figure needs a second look before the board meeting.';
// F5: a foreign note whose text HAS a colon, but not in this app's own
// "Name:" shape (the words before the colon aren't a name — lowercase words
// follow the first). Must NOT be misread as authored by "Check this number".
q3.getCell('B20').value = 'flagged';
q3.getCell('B20').note = 'Check this number: 42 seems low for August.';

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
// A note with a reply thread AND the CURRENT resolve marker, on the same
// non-first sheet — exercises xlsx-comments.ts's transcript parsing end to
// end.
byRep.getCell('B5').note =
  'Priya Shah: Diego’s numbers look great this quarter.\n\n' +
  'Marcus Lee: Agreed — his new accounts are paying off.\n' +
  RESOLVED_MARKER;
// F4 (backward compatibility): the SAME shape, but resolved with the OLD
// bracketed-token marker — must still read as resolved.
byRep.getCell('B6').note =
  'Priya Shah: Did the refunds line get double-counted?\n\n' +
  'Marcus Lee: Checked — it did not, the total already excludes them.\n' +
  LEGACY_RESOLVED_MARKER;
// F4 (negative case): ends with the marker's own visible words, but with no
// leading ZWSP — a human could plausibly type this. Must read as unresolved.
// (Placeholder value — B7 falls outside the addRow-populated range above, so
// needs one to round-trip at all; same reason as B18/B19/B20.)
byRep.getCell('B7').value = 0;
byRep.getCell('B7').note = 'Marcus Lee: Following up next week. ' + LOOKALIKE_NOT_A_MARKER;

const rawBuf = Buffer.from(await wb.xlsx.writeBuffer());

// Surgically strip B18's <v>…</v> so it round-trips as the "bordered,
// value-less cell with a note" shape F1 needs — see the header comment for
// why this is done by patching exceljs's own correct output rather than
// hand-rolling the OOXML. Q3 is the first worksheet added, so it's
// xl/worksheets/sheet1.xml.
const zip = await JSZip.loadAsync(rawBuf);
const SHEET1_PATH = 'xl/worksheets/sheet1.xml';
const sheet1Xml = await zip.file(SHEET1_PATH).async('string');
const patched = sheet1Xml.replace(/(<c r="B18"[^>]*)>[\s\S]*?<\/c>/, '$1/>');
if (patched === sheet1Xml) {
  throw new Error('B18 patch did not match anything — fixture generator needs updating');
}
zip.file(SHEET1_PATH, patched);
const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

const out = join(dirname(fileURLToPath(import.meta.url)), 'q3-sales-by-rep.xlsx');
writeFileSync(out, buf);
console.log('wrote', out, buf.length, 'bytes');
