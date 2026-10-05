# SUPERSEDED 2026-09-27 — legacy-Note reference

**Status: superseded, kept for history — not deleted, not modified.**

This directory captures the OOXML shape of an Excel **legacy cell Note** (`exceljs`'s `cell.note`),
produced for the doc-comments build's original design, which used legacy Notes as the product's
Excel comment format.

**Destin decided (2026-09-27, chat) that Excel comments use ONLY modern threaded comments** —
never old-style Notes as the product's write format. The design doc
(`docs/active/specs/2026-09-26-doc-comments-build-design.md`, §4) and the spike doc this directory
was originally captured for
(`docs/active/investigations/2026-09-27-xlsx-note-format-spike.md`, in the `youcoded-dev` workspace
repo) were both rewritten for the new format on the same date. **Do not use this directory as a
target for any NEW code** — the product never creates a legacy Note.

**This directory is still relevant, and is kept unmodified, for one reason**: the product still has
to *recognize* a genuine, pre-existing legacy Note in a file it opens (to leave it byte-for-byte
untouched, to keep it hidden from the comments pane, and to refuse `'cell-has-note'` if the user
tries to add a threaded comment on top of one — see the design doc §4.1). `single-note.xlsx` and its
raw parts are still the concrete example of what that recognition target looks like. The new
format's own equivalent reference — real Excel-365 and Google Sheets threaded-comment samples — lives
alongside this directory at `../xlsx-threaded-reference/`.

**Do not edit `manifest.json` or any raw part in this directory**: `desktop/tests/
xlsx-note-reference-drift.test.ts` asserts the checked-in `manifest.json` matches a fresh capture of
exceljs's own current output byte-for-byte (`toEqual`, not a subset check) — adding, removing, or
reordering ANY key would fail that test, which is unrelated to the format redesign and should keep
passing on its own terms until (if ever) that test itself is retired alongside the legacy-Notes write
path it was guarding.
