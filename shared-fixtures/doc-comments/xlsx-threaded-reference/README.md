# Excel 365 threaded-comments reference fixtures

Companion to `../xlsx-note-reference/` (legacy Notes only). This directory captures the
modern "threaded comments" OOXML format at byte level, from real Excel-365-family-authored
`.xlsx` files, for a future hand-rolled writer. See `manifest.json` for machine-checkable
facts; this file explains what each saved file is, where it came from, its license, and what
it demonstrates.

## Full .xlsx files

### `docling-xlsx-comments.xlsx`
- **Source:** https://github.com/docling-project/docling/blob/main/tests/data/xlsx/sources/xlsx_comments.xlsx
- **License:** MIT (docling-project/docling)
- **Authored by:** Microsoft **Macintosh** Excel (docProps/app.xml: `<Application>Microsoft Macintosh Excel</Application>`, AppVersion 16.0300) -- a genuine real-Excel-authored file, not synthetic.
- **Demonstrates:** cell F7 has a threaded-comment thread with a root comment plus one reply (unresolved, no `done`); cell G12 has a threaded-comment thread with a root only (unresolved). Cells A1 and B2 have ordinary, non-threaded legacy Notes in the *same* `xl/comments1.xml` -- proof a single workbook can mix real Notes and threaded comments on different cells.

### `elden-ring-completionist-checklist.xlsx`
- **Source:** https://github.com/Mjolniar/elden-ring-index-build-planner/blob/main/Elden%20Ring%20Completionist%20Checklist.xlsx
- **License:** MIT (Mjolniar/elden-ring-index-build-planner)
- **Authored by:** Google Sheets' own `.xlsx` export (no `docProps/app.xml` part at all; every `<person>` carries `providerId="google-sheets"`). This is the primary evidence in this fixture set that **Google Sheets exports genuine modern threaded comments**, not just legacy Notes -- confirmed by unzipping the real file, not by a claim.
- **Demonstrates:** `done="1"` resolved threads, `done="0"` explicit-unresolved threads, multi-reply threads (parentId flattened to root), and -- the most surprising finding in this research -- **multiple independent comment threads sharing one cell reference** (cell B19 has 5 separate threaded-comment roots, some resolved, some not, posted months apart). It also has an unrelated Google-Sheets-specific `xl/documenttasks/` part (task/action-item metadata) riding alongside the comments machinery; noted for awareness, out of scope here.

This file is larger (~260KB) than the note-reference fixture because the source spreadsheet has ~150 comment threads and ~150 named tables; it was kept as a real, unmodified file rather than hand-trimmed, so its byte structure stays trustworthy. The individual excerpt files below pull out just the parts relevant to this research.

## Raw part files -- `docling-*`

Extracted from `docling-xlsx-comments.xlsx`, in full (all are small):

| File | What it is |
|---|---|
| `docling-content-types.xml` | Full `[Content_Types].xml` -- shows the `application/vnd.ms-excel.threadedcomments+xml` and `application/vnd.ms-excel.person+xml` Override entries alongside the unchanged legacy-comments Override. |
| `docling-workbook.xml.rels` | Workbook-level rels -- shows the Persons-part relationship (`.../2017/10/relationships/person`) lives here, not in the worksheet rels. |
| `docling-sheet1.xml.rels` | Worksheet-level rels -- shows the ThreadedComments relationship (`.../2017/10/relationships/threadedComment`) and legacy comments relationship both live here, same as Notes-only files. |
| `docling-threadedComment1.xml` | The real thread data: F7 (root+reply) and G12 (root only). |
| `docling-person.xml` | The 2-person `personList` for this workbook. |
| `docling-comments1.xml` | Legacy placeholders for F7/G12 PLUS two genuine legacy Notes (A1, B2) in the same part. |
| `docling-vmlDrawing1.vml` | VML for all four comment shapes (2 real Notes + 2 threaded placeholders) -- same `ObjectType="Note"` shape used for both kinds. |

## Raw part files -- `elden-*`

Extracted/excerpted from `elden-ring-completionist-checklist.xlsx`. Full files where small
enough; excerpts (clearly marked with an XML comment explaining what was cut) where the
source part is large and mostly irrelevant (e.g. hundreds of `xl/tables/tableN.xml`
relationships).

| File | What it is |
|---|---|
| `elden-content-types-excerpt.xml` | Excerpt of `[Content_Types].xml` -- same threadedcomments/person Override pattern as docling, from an independent (Google Sheets) writer. |
| `elden-workbook.xml.rels` | Full workbook rels (only 14 entries -- kept whole). Shows the same Persons-part relationship pattern. |
| `elden-sheet1.xml.rels-excerpt.xml` | Excerpt of sheet1's rels (46 total, mostly `xl/tables/*` and external hyperlinks) -- just the comments/threadedComment/vmlDrawing three. |
| `elden-sheet5.xml.rels-excerpt.xml` | Same excerpt, for the sheet backing the small `done="0"` example below. |
| `elden-threadedComment1-B19-excerpt.xml` | The single most important excerpt in this set: cell B19's **five separate, independent** threaded-comment roots (see manifest `multipleThreadsPerCell`). |
| `elden-comments1-B19-excerpt.xml` | The five matching legacy `<comment ref="B19">` placeholders, one per root, proving legacy placeholders can repeat a `ref`. |
| `elden-threadedComment4.xml` | Full small file: two independent, unresolved (`done="0"`) single-message threads (cells C56, C4). Shows Google Sheets writes `done="0"` explicitly rather than omitting the attribute. |
| `elden-comments4.xml` | Full small file: the matching legacy placeholders for the above, showing the Google-Sheets whitespace variant of the placeholder text (tab indent, no blank lines, trailing newline, explicit `xml:space="preserve"`). |
| `elden-person.xml` | Full person list (57 people) -- every entry has `providerId="google-sheets"` and none has `userId`, unlike the docling (Excel) sample. |
| `elden-vmlDrawing4.vml` | VML for the C4/C56 placeholders -- same `ObjectType="Note"` shape as docling's, and likewise omits `<x:Locked>`/`<x:LockText>` (present in the legacy-Notes-only reference fixture but absent here). |

## What this does NOT include

- A Windows-Excel-authored `.xlsx` with a genuine threaded comment. One was found and inspected for verification (`0ccas10n/homestay-management` on GitHub) but that repository has **no license file**, so nothing from it was copied into this repo -- it was used only to cross-check facts (see the accompanying research report for what it confirmed: same VML shape, same omission of `<x:Locked>`/`<x:LockText>`).
- A same-cell Note-plus-threaded-comment example (neither sample has one; not established either way by file inspection).
- SheetJS/test_files was not usable: that repository has been **disabled by GitHub** (ToS action), so no files could be fetched from it.
- Apache POI's own `test-data` repository (which has a `64759.xlsx` fixture referenced by a POI unit test, apparently containing both a threaded comment and a genuine Note) is not published on GitHub as a browsable/clonable location from this sandbox -- POI test-data ships via a separate download outside GitHub. Not fetched; noted as a gap.
