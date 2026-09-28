# Cross-platform WRITE parity goldens (T17/T21)

Real desktop-writer output (`docx-comments.ts`/`xlsx-comments.ts`), one `.docx`/`.xlsx` per
case plus a `.json` recipe recording the exact operation/arguments used — see
`docs/active/specs/2026-09-26-doc-comments-build-design.md` §3.3/§4.3/§9.3/§8 T17/T21, and
§"Edit and delete" for the edit/delete cases added 2026-09-28. `manifest.json` in this
directory is the machine-checkable index (case name → format/fixture/path/ops); this file
explains what each case is for and how the set fits together.

## Regenerating

Never by hand-editing the committed `.docx`/`.xlsx`/`.json` files. Run the generator that owns
each format after a fixture or the writer's own output shape changes:

- `node desktop/tests/fixtures/doc-comments/generate-docx-write-golden.mjs`
- `node desktop/tests/fixtures/doc-comments/generate-xlsx-write-golden.mjs`

Both are run BY HAND, never part of `npm test`/CI, and regenerate every case in their own
file — see each script's own header comment for the full rationale (why the real writer runs
instead of hand-transcribing expected bytes, and why `createdAt`/a brand-new xlsx thread's own
GUID are the only fields excluded from any comparison against these goldens).

## Consumers

- `desktop/tests/doc-comments-write-golden-staleness.test.ts` — replays every recipe here
  against a FRESH copy of the same original fixture with desktop's CURRENT writer, and fails
  loudly if the result no longer matches the committed golden (drift self-check).
- `app/src/test/kotlin/com/youcoded/app/doccomments/DocxCommentsCrossPlatformParityTest.kt` /
  `XlsxCommentsCrossPlatformParityTest.kt` — replay the SAME recipe with the Kotlin writer
  against a fresh copy of the same original fixture, then compare against the committed golden
  (copied verbatim into `app/src/test/resources/doc-comments/write-golden/`).

## Case groups

**docx** (`launch-brief.docx`'s real `w-0` (no reply) and `w-1` (one reply, `w-1-r1`);
`spanning-comment.docx`; `word365-realistic.docx`): one case per op — `add`, `reply`,
`resolve`, `reopen`, `move`, and (2026-09-28) `edit`, `edit-reply`, `delete-reply`, `delete`
(the whole thread — root + its one reply).

**xlsx** (`docling-xlsx-comments.xlsx`'s real `F7` (root + one reply) and `G12` (root only);
`elden-ring-completionist-checklist.xlsx`'s real ~700-thread workbook, including the 5
independent threads sharing cell `B19`): `add-docling`/`move-docling` (per-operation breadth
against a real Excel-authored file), `resolve-b19-sibling` (a resolve on one of 5 independent
same-cell threads must never disturb its siblings), `elden-sequence` (one thread's full
add → reply → resolve → reopen → move lifecycle, crossing from a sheet with no prior comment
parts to one that already has some), and (2026-09-28) `edit-docling`/`edit-reply-docling`/
`delete-reply-docling`/`delete-thread-docling` (same F7/G12 reuse) plus
`delete-last-comment-fresh` — the ONE case that starts from a brand-new, comment-free
workbook (`../fresh-single-comment.xlsx`, built the same way `xlsx-comments.test.ts`'s own
`writeMinimalXlsxTo` does, via `exceljs`) specifically to prove deleting a sheet's LAST
comment removes every comment part/rel/content-type override/`<legacyDrawing>` — none of the
other cases can exercise that cleanup path, since they always leave a sibling thread behind.

## Reverse direction (Kotlin writes, desktop reads)

Not in this directory — `shared-fixtures/doc-comments/kotlin-write-golden/` holds the reverse
set (one snapshot of a JVM run each), read by
`desktop/tests/doc-comments-kotlin-write-golden.test.ts`. See that directory's own README.
