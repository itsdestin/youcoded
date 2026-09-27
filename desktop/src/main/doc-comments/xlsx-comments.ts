// Excel (.xlsx) comment READING — T12 of the doc-comments build
// (docs/active/specs/2026-09-26-doc-comments-build-design.md §4.1-§4.3, §8
// T12). Reads exceljs legacy cell Notes (`cell.note`) into PersistedComment-
// shaped cell records, run in the Electron MAIN process for the same reason
// docx-comments.ts (T10) is: T8's native harness tools and T9's MCP
// pending-mutation queue must be able to read an Excel comment with no
// renderer window open on that file at all.
//
// exceljs is already a direct dependency (`XlsxView.tsx` already uses it
// read-only for cell VALUES) — no new dependency for the READ path, unlike
// T10's jszip promotion. The WRITE path below (rewritten this session — see
// its own header) additionally uses `linkedom`'s `DOMParser` for surgical
// OOXML edits, mirroring docx-comments.ts's own T10/T11 choice (already a
// direct dependency — `src/main/harness/tools/web-fetch.ts` and
// docx-comments.ts both already import it).
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { DOMParser } from 'linkedom';
import type { CellSelector, CommentAuthor, CommentReply, CommentSelector, PersistedComment } from '../../shared/doc-comments-types';
import { checkTotalWithinCeiling, decompressBounded } from './zip-size-guard';
import { writeFileMutation } from './write-pipeline';

// Not exported (same convention as docx-comments.ts's DocxReadError, and
// doc-comments-store.ts's DocCommentsError): nothing outside this module
// needs the error union by name — knip flags an exported type nothing ever
// imports as dead code. Callers only need `XlsxReadResult`, which IS exported.
//
// 'archive-too-large' (implementation-review F2 — major): refused after a
// JSZip pre-scan of the raw archive, BEFORE handing the same bytes to
// exceljs's own loader — exceljs has no hook to check declared entry sizes
// itself before it starts unzipping (see zip-size-guard.ts).
type XlsxReadError = 'invalid-xlsx' | 'archive-too-large';
export type XlsxReadResult = { ok: true; comments: PersistedComment[] } | { ok: false; error: XlsxReadError };

// §4.1's fixed, non-natural-language resolve marker, appended as the note
// body's own trailing LINE (never just a trailing substring — see
// `stripResolvedMarker` below). Inert in ordinary prose so a legitimate reply
// that happens to end with resolve-like words is never misread as this app's
// own resolve marker.
//
// Implementation-review F4: the original `​[[yc:resolved]]` token (a leading
// zero-width space plus a bracketed machine token) works as a signal but
// reads as literal garbage code to anyone opening the file in real Excel or
// Google Sheets — exactly the surface this app promises stays human-legible
// (R8/R9). The new marker is a leading zero-width space (still what makes it
// inert/never something a human types) followed by plain, readable text
// ("✓ Resolved") instead of a bracketed token. `RESOLVED_MARKER` is the only
// marker this app WRITES going forward (a writer-facing constant — T13, the
// xlsx write path, imports this same export rather than re-deriving it).
// `LEGACY_RESOLVED_MARKER` is never written again but is still READ, so a
// file an earlier build already marked resolved doesn't silently flip back
// to unresolved just because the token format changed.
//
// Not exported YET: T13 (the xlsx write path) doesn't exist in this codebase
// yet, so there is no real consumer to import this — `knip`'s unused-export
// ratchet (knip-baseline.json: "never raise it, delete the unused export
// instead") correctly flags an `export` nothing calls as dead code. T13
// should import this constant from here rather than re-deriving the string;
// exporting it is a one-line change for whoever builds T13, once there's an
// actual caller.
const RESOLVED_MARKER = '​✓ Resolved';
const LEGACY_RESOLVED_MARKER = '​[[yc:resolved]]';

/** Turn an exceljs `cell.note` (a plain string OR a rich-text object with
 *  `texts`) into plain text — the same normalization §4.1 assumes when it
 *  describes the note body as a formatted transcript. */
function noteToPlainText(note: ExcelJS.Comment | string): string {
  if (typeof note === 'string') return note;
  const texts = note.texts;
  if (!Array.isArray(texts)) return '';
  return texts.map((t) => t.text ?? '').join('');
}

// Implementation-review F5: this app's OWN write convention (§4.1 — "the
// author's name goes as the first line of the note body") only ever writes a
// REAL DISPLAY NAME there — "Priya Shah", "Marcus Lee", "You" — never a
// sentence. The precise shape of a name this app writes: 1 to 4
// space-separated words, EVERY word starting with a capital letter (letters,
// apostrophe, or hyphen after that). A foreign note's prose almost never
// matches this exactly, because natural sentences have lowercase words after
// the first ("Check this number: 42", "Please review before Friday: thanks")
// — those fail the all-words-capitalized test and so are never mistaken for
// this app's own "Name:" prefix. This is a precise, checkable rule, not a
// fuzzy heuristic: it either matches the write convention exactly or it
// doesn't.
const APP_AUTHOR_PREFIX_RE = /^([A-Z][A-Za-z'’-]*(?: [A-Z][A-Za-z'’-]*){0,3}):\s([\s\S]*)$/;

// Review F10 (implementation review, this session): the shape check above
// (1-4 Capitalized words before a colon) also matches a colleague's own
// ORDINARY heading that happens to be Title Case — "Action Items: buy milk",
// "Next Steps: ...", "Follow Up: ..." — misattributing that heading as if it
// were a person's NAME. A "known author list" cross-reference (the task's own
// suggested fix) was tried and rejected: xlsx's own OOXML `<authors>` list is
// no help (§4.1/the T18 spike: this app always writes the literal placeholder
// "Author" there, and real Excel/LibreOffice write their OWN placeholder —
// "Unknown Author" for LibreOffice, confirmed against the kitchen-sink
// fixture — never a real name, so it carries no corroborating signal for
// ANY file any tool wrote), and cross-referencing names against OTHER turns
// in the SAME workbook breaks a real, single-occurrence colleague name this
// reader already gets right today (q3-sales-by-rep.xlsx: "Marcus Lee"
// appears exactly ONCE, as By rep!B5's only reply, and the existing pinning
// test correctly expects it attributed to him, not "Unknown" — requiring
// recurrence would misattribute every genuine one-off commenter). A denylist
// of common Title-Case task-note headings is the narrower, honest fix that
// closes the specific gap named without weakening recognition of a real name
// that only ever appears once. This is a documented, INCOMPLETE heuristic
// (a heading not on this list can still slip through), not a general name
// detector — once real accounts exist (§1.2) a roster to check names against
// would be a stronger fix; filed as a documented limitation, not a blocker.
const NON_NAME_HEADINGS = new Set([
  'Action Item',
  'Action Items',
  'Next Steps',
  'Next Step',
  'To Do',
  'Follow Up',
  'Follow-Up',
  'Key Takeaways',
  'Open Questions',
  'Summary',
  'Notes',
]);

/**
 * Splits a note body into "turns" — §4.1's transcript format is one turn per
 * blank-line-separated paragraph, each shaped `"Author: text"` (the ONLY
 * place §4.1 says the author's name goes is "as the first line of the note
 * body" — for a single, no-reply comment that first line IS the whole body,
 * `"Name: text"`).
 *
 * Implementation-review F5 (major): the previous version treated ANY
 * `"<=60 chars>: rest"` shape as an author split, which misreads a foreign
 * note like "Check this number: 42" as authored by "Check this number" —
 * and, worse, a colon-free foreign note fell through to `{author: p, text:
 * ''}`, silently DROPPING the entire comment body (§1.1: "nothing silently
 * lost" — a real bug, not just a misattribution). Fixed: a leading `"Name:
 * "` is only read as an author when it matches `APP_AUTHOR_PREFIX_RE` above
 * (this app's own precise write convention) AND is not a known non-name
 * heading (F10, above); anything else — no colon at all, a colon whose
 * prefix isn't shaped like a name this app would have written, or a prefix
 * that IS shaped like a name but is a known non-name heading — keeps the
 * WHOLE paragraph as the comment's TEXT, with a neutral, nameless author
 * (`toCommentAuthor('')` → `person:Unknown`; exceljs exposes no per-note
 * author field to fall back to instead — §4.1, review 1 F15, confirmed
 * against the installed version's `Comment` interface).
 */
function splitTurns(body: string): Array<{ author: string; text: string }> {
  const paragraphs = body.split(/\n{2,}/);
  return paragraphs
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => {
      const match = APP_AUTHOR_PREFIX_RE.exec(p);
      if (match && !NON_NAME_HEADINGS.has(match[1])) return { author: match[1], text: match[2] };
      // Neutral author, WHOLE paragraph kept as text — never dropped.
      return { author: '', text: p };
    });
}

function toCommentAuthor(name: string): CommentAuthor {
  return `person:${name || 'Unknown'}`;
}

/**
 * F4: the marker is recognized only when it is the note body's exact LAST
 * LINE (never a bare trailing-substring match) — a real reply that happens
 * to literally end with "✓ Resolved" but has NO leading zero-width space
 * (nothing this app wrote, since it never types a ZWSP) is not the marker,
 * even though a plain `.endsWith()` on the visible text would wrongly match
 * it. Both the current and legacy marker are recognized (never written
 * again, but a file an earlier build already resolved must not silently
 * flip back to unresolved just because the token format changed).
 */
function stripResolvedMarker(rawBody: string): { resolved: boolean; body: string } {
  const lines = rawBody.split('\n');
  const last = lines[lines.length - 1];
  if (last === RESOLVED_MARKER || last === LEGACY_RESOLVED_MARKER) {
    return { resolved: true, body: lines.slice(0, -1).join('\n') };
  }
  return { resolved: false, body: rawBody };
}

/**
 * Reads every legacy cell Note in a workbook's raw bytes into
 * PersistedComment-shaped records. `path` is stamped onto each record the
 * same way docx-comments.ts's `readDocxComments` does (§1.1: these are never
 * stored in a JSON sidecar, but the field still identifies the source file).
 *
 * Every worksheet cell is walked with `includeEmpty: true` (implementation-
 * review F1 — major): a Note is a property of the cell object itself,
 * independent of whether that cell also carries a value, so a bordered-but-
 * value-less cell (a styled placeholder a user annotated before filling it
 * in) still has a real `.note` — but exceljs's own `eachRow`/`eachCell`
 * SKIP any cell whose type is `Null` (no value) when `includeEmpty` is left
 * at its default `false` (confirmed by reading `exceljs/lib/doc/row.js`'s
 * `eachCell`/`hasValues` before writing this fix), silently dropping exactly
 * that comment. `includeEmpty: true` visits every touched row/cell instead;
 * the existing `if (!note) return;` immediately below already handles the
 * (much more common) case of a plain empty cell with no note at all, so
 * this costs nothing extra for ordinary workbooks.
 */
export async function readXlsxComments(bytes: Uint8Array | Buffer, path: string): Promise<XlsxReadResult> {
  // F2 (major): pre-scan the raw archive with JSZip BEFORE handing the same
  // bytes to exceljs's own loader — exceljs has no hook of its own to check
  // a decompression-bomb-shaped entry's declared size ahead of unzipping it
  // (zip-size-guard.ts explains why this check is possible cheaply, and
  // docx-comments.ts's own §3.2 guard does the equivalent check for Word).
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return { ok: false, error: 'invalid-xlsx' };
  }
  const sizeCheck = checkTotalWithinCeiling(zip);
  if (!sizeCheck.ok) return { ok: false, error: sizeCheck.error };

  // F3 (implementation review): the declared-size pre-scan above only ever
  // reads central-directory METADATA (zip-size-guard.ts's own header) — a
  // crafted entry can simply lie about it. Unlike docx-comments.ts's own read
  // path, this module never reads a NAMED part itself — the actual per-entry
  // decompression happens entirely inside exceljs's own `.xlsx.load()`, a
  // black box with no hook of its own to bound it. So every entry is inflated
  // HERE, through JSZip's own streaming API (`decompressBounded`), with a
  // byte-counting cap — the decompressed text itself is discarded immediately
  // (only whether it stayed under the ceiling matters for this check) —
  // BEFORE the same bytes are ever handed to exceljs's loader.
  const entries: JSZip.JSZipObject[] = [];
  zip.forEach((_relativePath, file) => {
    if (!file.dir) entries.push(file);
  });
  for (const entry of entries) {
    const bounded = await decompressBounded(entry);
    if (!bounded.ok) return { ok: false, error: bounded.error };
  }

  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs's own .d.ts types `.load()` as taking a plain (non-generic)
    // `Buffer`, which this repo's newer @types/node's generic `Buffer<T>`
    // doesn't structurally match even for a real Buffer instance — the SAME
    // mismatch XlsxView.tsx already works around with `as any` for its own
    // `.load()` call (`bytes.buffer as any`). `Buffer.from(bytes)` always
    // copies into a real Buffer first (never `bytes.buffer`, which would
    // alias a Uint8Array's backing ArrayBuffer and could hand exceljs a
    // slice-relative view for a sub-array).
    await workbook.xlsx.load(Buffer.from(bytes) as any);
  } catch {
    return { ok: false, error: 'invalid-xlsx' };
  }

  // §4.2: `sheet` is required on the selector only when the workbook has
  // more than one tab — matches the mock's own `sourceLabel` convention
  // (doc-comments-store.ts:249,281,298: "By rep · B4" vs plain "C4").
  const singleSheet = workbook.worksheets.length <= 1;

  const comments: PersistedComment[] = [];
  for (const worksheet of workbook.worksheets) {
    worksheet.eachRow({ includeEmpty: true }, (row) => {
      row.eachCell({ includeEmpty: true }, (cell) => {
        const note = cell.note;
        if (!note) return;
        const rawBody = noteToPlainText(note);
        const { resolved, body } = stripResolvedMarker(rawBody);
        const turns = splitTurns(body);
        if (turns.length === 0) return;
        const [first, ...rest] = turns;

        const cellSelector: CellSelector = {
          type: 'CellSelector',
          cell: cell.address,
          ...(singleSheet ? {} : { sheet: worksheet.name }),
        };
        const selector: CommentSelector = { kind: 'cell', selector: cellSelector };

        const replies: CommentReply[] = rest.map((turn, i) => ({
          id: `x-${worksheet.id}-${cell.address}-r${i + 1}`,
          author: toCommentAuthor(turn.author),
          text: turn.text,
          createdAt: Date.now(),
        }));

        comments.push({
          id: `x-${worksheet.id}-${cell.address}`,
          path,
          selector,
          text: first.text,
          author: toCommentAuthor(first.author),
          // exceljs's legacy Note carries no timestamp of its own — never
          // invent one; the read time is the only honest value available.
          createdAt: Date.now(),
          replies,
          resolved,
          // Same reasoning as docx-comments.ts: no separate resolve/reopen
          // audit trail exists in the note itself, only the current marker
          // bit — `history` starts empty on a freshly-read native comment.
          history: [],
        });
      });
    });
  }

  return { ok: true, comments };
}

// =============================================================================
// Excel (.xlsx) comment WRITING — T13 of the doc-comments build, REWRITTEN
// this session (docs/active/specs/2026-09-26-doc-comments-build-design.md
// §4.3, §4.1, §8 T13; original commit a4275bf23; review that prompted this
// rewrite: a real-LibreOffice-authored workbook round-tripped through the
// exceljs write path came back with docProps/custom.xml GONE,
// xl/externalLinks/* GONE (breaking formula references), defined names'
// `$`-absoluteness ALTERED, ignoredErrors/customSheetViews GONE, and a
// resized comment box reset to the default size).
//
// WHY exceljs's own `workbook.xlsx.writeBuffer()` can never fix this: it
// REBUILDS every OOXML part from its own in-memory model — it never copies
// through a part it didn't parse into that model, and its model has no slot
// for custom properties, external links, or several other whole part types
// at all. A feature-denylist approach (the OLD code's `UNSUPPORTED_FEATURES`
// scan, refusing on charts/pivots/slicers/etc.) can never be COMPLETE — it
// can only refuse on parts someone thought to name, while docProps/custom.xml
// and xl/externalLinks/* were both lost SILENTLY, with no refusal at all,
// because nobody had named them. The only fix that is complete BY
// CONSTRUCTION is to stop rebuilding the workbook at all.
//
// THE FIX: exactly the shape docx-comments.ts's own write path (§3.3) already
// uses — surgical JSZip edits. A legacy Note touches, at most, five parts:
// the target worksheet's own comments part (xl/commentsN.xml), its VML
// drawing (xl/drawings/vmlDrawingN.vml), that worksheet's own rels file, the
// worksheet's `<legacyDrawing r:id>` element, and `[Content_Types].xml` —
// every OTHER part in the archive (styles, shared strings, other worksheets,
// docProps/custom.xml, xl/externalLinks/*, defined names, images, everything)
// is NEVER PARSED, NEVER TOUCHED, and comes back through JSZip's own
// unmodified-entry passthrough exactly as it went in. Where a target
// worksheet already has comments/VML from a REAL Excel/LibreOffice author,
// this edits them IN PLACE — adding or replacing only the target cell's
// `<comment>` and `<v:shape>`, never re-serializing (and so never resizing or
// repositioning) any OTHER shape already in that file.
//
// Exact byte shapes for a BRAND-NEW comments/VML pair (when a worksheet has
// no notes yet) follow ../docs/active/investigations/2026-09-27-xlsx-note-
// format-spike.md and shared-fixtures/doc-comments/xlsx-note-reference/
// verbatim — the same reference T19 (Android's own from-scratch Kotlin
// writer, not built by this task) targets, so this rewrite does not move that
// target: Android's future writer and desktop's writer now both need to
// produce (and, for existing files, edit) the identical shape.
//
// Every mutation still goes through `write-pipeline.ts`'s `writeFileMutation`:
// backup-before-write, atomic tmp-then-rename replace, and verify-after-write
// with AUTOMATIC ROLLBACK on failure — unchanged from the original T13.
// =============================================================================

// -----------------------------------------------------------------------
// Feature refusal (write path only). The OLD denylist named nine feature
// classes exceljs's REBUILD would silently drop (charts, pivots, slicers,
// timelines, VBA, threaded comments, rich data types, embedded objects, form
// controls). A surgical writer never rebuilds anything it doesn't touch, so
// eight of those nine are no longer at risk here — a workbook carrying a
// chart, a pivot table, a macro, or an embedded OLE object round-trips that
// content byte-for-byte the same way it round-trips styles.xml, because this
// writer never opens xl/charts/1.xml (etc.) at all, let alone rebuilds it.
// Removing those eight refusals is not "loosening a safety check" — it is
// recognizing that the SPECIFIC failure mode they existed to prevent (silent
// rebuild-loss) cannot occur here.
//
// ONE refusal remains, for a genuinely different reason: modern THREADED
// comments (Excel 2019+, `xl/threadedComments/` + `xl/persons.xml`) live in
// parts separate from the legacy Notes this module reads/writes, but a
// threaded comment ALSO leaves a legacy-shaped compatibility placeholder
// behind in the very same `xl/commentsN.xml` this writer edits ("[Threaded
// comment]... your version of Excel allows you to read this threaded
// comment; however, any edits to it will get removed if the file is opened
// in a newer version of Excel."). Editing that placeholder in place — which
// this module would otherwise do exactly like any other legacy note — would
// desynchronize it from the real threaded thread it fronts for, producing a
// file where Excel's own UI shows one thing and this app's reply/resolve
// history reflects another. That is exactly the "comments/VML parts are
// ambiguous" case the task brief calls out to keep refusing. Scope: the
// refusal is WORKBOOK-WIDE (matching the old code's own granularity) rather
// than per-cell, since a per-cell placeholder detector would be one more
// heuristic that could itself be wrong in either direction.
// -----------------------------------------------------------------------

type FeatureCheckResult = { ok: true } | { ok: false; error: 'unsupported-workbook-features'; features: string[] };

function checkNoUnsupportedFeatures(zip: JSZip): FeatureCheckResult {
  let hasThreadedComments = false;
  zip.forEach((relativePath) => {
    const name = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
    if (name.startsWith('xl/threadedComments/') || name === 'xl/persons.xml') hasThreadedComments = true;
  });
  if (!hasThreadedComments) return { ok: true };
  return { ok: false, error: 'unsupported-workbook-features', features: ['modern threaded comments'] };
}

// Not exported: same knip convention as `XlsxReadError` above — callers only
// need the exported `XlsxWriteResult` shape.
//
// 'comment-not-found': a reply/resolve/reopen/move `id` that isn't (or is no
//   longer) a real cell note in this workbook.
// 'invalid-selector': add's `selector` (or move's `newSelector`) isn't a
//   `kind: 'cell'` selector, names a malformed cell reference, or omits
//   `sheet` on a workbook with more than one tab (§4.2: required only then) —
//   a caller bug (dispatch should never construct one of these), refused
//   honestly rather than silently guessed at.
// 'sheet-not-found': a named `sheet` doesn't exist in the workbook (or names
//   a chartsheet, which never carries cell notes).
// 'cell-already-has-comment': `add` targeted a cell that already carries a
//   note — this app's own comment thread lives in ONE note body per cell, so
//   a second `add` at the same address would have to either silently merge
//   into or clobber the existing thread; refused instead (R6).
// 'destination-cell-occupied': `move`'s `newSelector` names a DIFFERENT cell
//   that already has its OWN note — writing over it would silently destroy
//   that other comment (R6), so this refuses rather than clobbering.
// 'ambiguous-comment-wiring' (NEW this rewrite): the target worksheet's own
//   `<legacyDrawing>` element / comments relationship / vmlDrawing
//   relationship exist in some PARTIAL or inconsistent combination (e.g. a
//   vmlDrawing relationship with no matching comments relationship, or a
//   `<legacyDrawing r:id>` that doesn't match the vmlDrawing relationship's
//   own id) — a shape no real Excel/LibreOffice writer produces for an
//   ordinary legacy note, so editing it surgically would risk guessing at
//   wiring this module cannot safely reconstruct. Refused honestly (R6)
//   rather than risked; a workbook a user actually opens should essentially
//   never hit this.
//
// 'cell-has-no-value' — KEPT this rewrite, but for a DIFFERENT, verified
// reason than the old exceljs-based writer's (which refused because
// `workbook.xlsx.writeBuffer()` omitted the `<c r="...">` element entirely
// for a value-less cell it never loaded). A legacy Note's OOXML wiring
// itself has no such dependency — this surgical writer CAN insert a bare
// `<c r="...">` into sheetData at the right sorted position with no problem.
// The blocker is downstream, in exceljs's OWN reader (kept unchanged, per
// this rewrite's scope, for both READING and this writer's own verify-by-
// reread step): confirmed by reading the installed exceljs@4.4.0's
// `cell-xform.js` `parseClose('c')` — a `<c>` with NO value AND NO `s`
// (style) attribute is classified `Enums.ValueType.Merge` (exceljs's own
// heuristic for "this is a merged-range placeholder cell", not anything the
// OOXML spec itself distinguishes), and `row.js`'s `set model()` explicitly
// SKIPS any cell of type `Merge` — it never even enters the row's own
// `_cells` array, so `eachCell({includeEmpty:true})` never visits it and its
// comment (correctly present in `commentsN.xml`) never gets reattached.
// Confirmed empirically while building this rewrite: an add on a bare,
// never-touched cell produces valid OOXML a real Excel/LibreOffice show
// correctly, but this app's OWN reader reports it as if the comment weren't
// there at all — an honest 'verify-failed'-and-rollback, not data loss, but
// not a real fix either. Giving the new `<c>` a non-zero `s` (style) index
// avoids the Merge misclassification, but the only style index guaranteed
// safe to reuse without silently changing the cell's visible formatting
// (font/border/fill) would be a freshly-cloned duplicate of the workbook's
// own default style, appended to `xl/styles.xml` — a real, separate part
// this rewrite's own "touch only the parts a note needs" scope doesn't take
// on. Refused honestly (R6) rather than either an invisible comment or
// borrowed formatting; a cell that already has ANY `<c>` element (a real
// value, OR just a style like the kitchen-sink/q3 fixtures' own B18/E1
// precedent) is unaffected — this refusal never revisits an already-
// commentable cell, only a genuinely untouched one.
type XlsxWriteError =
  | XlsxReadError
  | 'comment-not-found'
  | 'invalid-selector'
  | 'sheet-not-found'
  | 'cell-already-has-comment'
  | 'destination-cell-occupied'
  | 'cell-has-no-value'
  | 'ambiguous-comment-wiring'
  | 'read-failed'
  | 'backup-failed'
  | 'write-failed'
  | 'verify-failed';

export type XlsxWriteResult<Extra extends Record<string, unknown> = {}> =
  | ({ ok: true } & Extra)
  | { ok: false; error: XlsxWriteError }
  | { ok: false; error: 'unsupported-workbook-features'; features: string[] };

// A1-style reference, 1-3 letters then 1-7 digits — generous enough for any
// real worksheet (Excel's own max column is XFD, max row 1,048,576) while
// still rejecting a malformed or empty string outright.
const CELL_ADDRESS_RE = /^[A-Z]{1,3}[1-9][0-9]{0,6}$/;

function isValidCellAddress(addr: string): boolean {
  return CELL_ADDRESS_RE.test(addr);
}

/** `"B5"` -> `{col: 2, row: 5}`, BOTH 1-based (Excel-native) — the shape the
 *  VML shape's `<x:Anchor>` default-rect math and `<x:Row>`/`<x:Column>`
 *  (which subtract 1 themselves) both need. Caller must already have
 *  validated the address with `isValidCellAddress`. */
function colLettersToNumber(letters: string): number {
  let col = 0;
  for (let i = 0; i < letters.length; i++) col = col * 26 + (letters.charCodeAt(i) - 64);
  return col;
}

function parseCellRef(addr: string): { col: number; row: number } {
  const m = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(addr)!;
  return { col: colLettersToNumber(m[1]), row: Number.parseInt(m[2], 10) };
}

/** True when `cellAddr` has NO `<c>` element at all in the worksheet's own
 *  `<sheetData>` — the exact shape `'cell-has-no-value'` (above) refuses on.
 *  A cell that already has a `<c>` element — a real value, OR just a style
 *  with none, matching the fixtures' own B18/E1 precedent — is fine to
 *  comment on; only a cell with ZERO sheetData presence trips this, since
 *  that's the shape exceljs's own reader (see the error union's own doc
 *  comment above) cannot reliably reconcile a comment onto. */
function cellExistsInSheetData(worksheetDoc: Document, cellAddr: string): boolean {
  const sheetData = elementsByTag(worksheetDoc, 'sheetData')[0];
  if (!sheetData) return false;
  for (const row of elementsByTag(sheetData, 'row')) {
    if (elementsByTag(row, 'c').some((c) => c.getAttribute('r') === cellAddr)) return true;
  }
  return false;
}

// The `{ok:false, ...}` half of `XlsxWriteResult`/`XlsxMutateResult`'s union,
// pulled out on its own so it can be passed as `writeFileMutation`'s explicit
// `ErrorResult` type argument at each call site below — TypeScript cannot
// reliably INFER a generic split between "the ok:true branch plus Extra" and
// "everything else" out of a pre-existing union return type, so every call
// below names both type arguments explicitly rather than leaning on
// inference across the two richer-than-`{error: string}` error shapes here.
type XlsxErrorResult =
  | { ok: false; error: XlsxWriteError }
  | { ok: false; error: 'unsupported-workbook-features'; features: string[] };

type XlsxMutateResult<Extra extends Record<string, unknown>> = ({ ok: true } & Extra) | XlsxErrorResult;

/** §3.4/§4.1's own rule, mirrored from docx-comments.ts's
 *  `commentAuthorToDisplayName` (duplicated here rather than imported — the
 *  two write modules are deliberately independent, same reasoning as
 *  write-pipeline.ts's own header): a reply/add made from this app must
 *  round-trip into the note body naming "the account's display name or
 *  'You'", never overwriting a colleague's own turn. No accounts exist yet
 *  (§1.2), so 'user' is literally "You"; 'assistant' is a plain, honest label. */
function commentAuthorToDisplayName(author: CommentAuthor): string {
  if (author === 'user') return 'You';
  if (author === 'assistant') return 'Assistant';
  if (author.startsWith('person:')) return author.slice('person:'.length) || 'Unknown';
  return 'Unknown';
}

// -----------------------------------------------------------------------
// Small, format-agnostic path helpers — OOXML relationship `Target`s are
// always relative to the REFERRING part's own directory, never absolute.
// -----------------------------------------------------------------------

function dirnameOfPart(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

function basenameOfPart(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

/** Resolves a relationship `Target` (e.g. `"../comments1.xml"`,
 *  `"worksheets/sheet2.xml"`) against the directory the REFERRING part
 *  lives in, normalizing `..`/`.` segments — the general form of what OOXML
 *  relationship resolution always does, used for both workbook.xml.rels
 *  (base `xl`) and a worksheet's own rels (base `xl/worksheets`). */
function resolveRelTarget(baseDir: string, target: string): string {
  const segments = [...baseDir.split('/'), ...target.split('/')].filter((s) => s.length > 0);
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/** The inverse of `resolveRelTarget`: expresses `toPath` as a path relative
 *  to `fromDir`, the shape a NEW `Relationship`'s own `Target` attribute
 *  needs (e.g. worksheet dir `xl/worksheets` + new part `xl/comments2.xml`
 *  -> `"../comments2.xml"`, matching the T18 spike's own captured shape). */
function relativizeTarget(fromDir: string, toPath: string): string {
  const fromParts = fromDir.split('/').filter(Boolean);
  const toParts = toPath.split('/').filter(Boolean);
  let i = 0;
  while (i < fromParts.length && i < toParts.length - 1 && fromParts[i] === toParts[i]) i++;
  const ups = fromParts.length - i;
  const downs = toParts.slice(i);
  return [...Array(ups).fill('..'), ...downs].join('/');
}

function worksheetRelsPathFor(partPath: string): string {
  return `${dirnameOfPart(partPath)}/_rels/${basenameOfPart(partPath)}.rels`;
}

// -----------------------------------------------------------------------
// Minimal XML plumbing — mirrors docx-comments.ts's own linkedom-based
// parse/serialize helpers (duplicated rather than imported: the two write
// modules are deliberately independent, same reasoning as write-pipeline.ts's
// own header and `commentAuthorToDisplayName` above).
// -----------------------------------------------------------------------

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
}

function elementsByTag(node: Document | Element, tag: string): Element[] {
  return Array.from((node as unknown as { getElementsByTagName(t: string): ArrayLike<Element> }).getElementsByTagName(tag));
}

/** Sets every `[name, value]` pair in `attrs` so the element SERIALIZES in
 *  exactly that order — confirmed empirically (not documented anywhere in
 *  linkedom's own README/types) that its `Element.toString()` emits
 *  attributes in the REVERSE of their `setAttribute()` call order, not
 *  insertion order as every other DOM implementation does. This matters here
 *  specifically because the T18 spike's own checked-in reference (and this
 *  module's own drift-pinning test against it) asserts EXACT attribute order
 *  for a brand-new comment/VML shape/relationship/content-type entry — a
 *  from-scratch Kotlin writer (T19) targets that same literal byte shape.
 *  Calling `setAttribute` in reverse of `attrs`' own order is what makes the
 *  OUTPUT come out in `attrs`' order. */
function setOrderedAttributes(el: Element, attrs: ReadonlyArray<readonly [string, string]>): void {
  for (let i = attrs.length - 1; i >= 0; i--) el.setAttribute(attrs[i][0], attrs[i][1]);
}

const XML_DECL_RE = /^<\?xml[^>]*\?>/;
// Matches a self-closing tag's OPENING `<tag ...` up to the space linkedom
// inserts before `/>` — requiring the leading `<` is what keeps this from
// ever touching plain text content (a literal `<` in XML text is always
// escaped as `&lt;`). Identical to docx-comments.ts's own regex of the same
// name/purpose.
const SELF_CLOSING_SPACE_RE = /(<[\w:.-]+(?:\s+[^<>]*)?) \/>/g;

/** Re-serializes `doc` through linkedom, then restores the ORIGINAL XML
 *  declaration verbatim (linkedom's own `toString()` lowercases `encoding`
 *  and drops `standalone="yes"`) and undoes the space linkedom adds before a
 *  self-closing tag's `/>`. `originalXml` is the part's real prior bytes for
 *  an EXISTING part, or this module's own `EMPTY_*_XML` template for a
 *  brand-new one (so a freshly-minted part's declaration still matches the
 *  T18 spike's exact captured format, never linkedom's own mangled one). */
function serializeXlsxPart(doc: Document, originalXml: string): string {
  let out = doc.toString();
  const originalDecl = originalXml.match(XML_DECL_RE);
  out = originalDecl ? out.replace(XML_DECL_RE, originalDecl[0]) : out.replace(XML_DECL_RE, '');
  return out.replace(SELF_CLOSING_SPACE_RE, '$1/>');
}

function writeXlsxPart(zip: JSZip, name: string, doc: Document, originalXml: string): void {
  zip.file(name, serializeXlsxPart(doc, originalXml));
}

// -----------------------------------------------------------------------
// Exact OOXML shapes for a BRAND-NEW comments/VML pair — verbatim from
// ../docs/active/investigations/2026-09-27-xlsx-note-format-spike.md and
// shared-fixtures/doc-comments/xlsx-note-reference/, so a from-scratch
// Kotlin writer (T19, not this task) has the SAME byte-level target this
// writer produces, not a second, silently-different one.
// -----------------------------------------------------------------------

const SML_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const COMMENTS_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml';
// The T18 spike's own finding (c): NO `+xml` suffix, unlike every other XML
// part's content type in the same file — an easy mismatch to introduce by
// analogy with the Overrides around it, so this is a named constant, never
// re-typed at each call site.
const VML_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.vmlDrawing';
const COMMENTS_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';
const VML_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing';

// A LEADING NEWLINE after the XML declaration in every one of these three
// templates is deliberate, not incidental formatting: linkedom PRESERVES
// whatever followed the declaration in the STRING it originally parsed
// (confirmed empirically — re-parsing a source with `?>\n<root>` round-trips
// that same `\n` on `.toString()`, but a source with no newline never gains
// one). The T18 spike's own checked-in reference — captured from exceljs's
// REAL output — has this exact newline in `comments1.xml`/`vmlDrawing1.vml`/
// `sheet1.xml.rels`, so it has to be here too for a from-scratch part to
// byte-match that reference (`xlsx-note-reference-drift.test.ts`).
const EMPTY_COMMENTS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<comments xmlns="${SML_NS}"><authors><author>Author</author></authors><commentList></commentList></comments>`;
const EMPTY_VML_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype></xml>`;
const EMPTY_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${REL_NS}"></Relationships>`;

/** Builds one `<v:shape>` element for a brand-new note at 1-based `(col,
 *  row)`, attribute order and every literal value matching the spike's own
 *  captured reference exactly (the default box position/size is a FIXED
 *  constant regardless of cell — confirmed against exceljs's own
 *  `vml-shape-xform.js`: only `<x:Anchor>`/`<x:Row>`/`<x:Column>` vary per
 *  cell). `idNumber` is `_x0000_s<idNumber>` — see `nextVmlShapeId` below for
 *  how the caller picks a number that can never collide with an existing
 *  shape already in this same VML part. */
function buildVmlShapeElement(doc: Document, idNumber: number, col: number, row: number): Element {
  const shape = doc.createElement('v:shape');
  setOrderedAttributes(shape, [
    ['id', `_x0000_s${idNumber}`],
    ['type', '#_x0000_t202'],
    ['style', 'position:absolute; margin-left:105.3pt;margin-top:10.5pt;width:97.8pt;height:59.1pt;z-index:1;visibility:hidden'],
    ['fillcolor', 'infoBackground [80]'],
    ['strokecolor', 'none [81]'],
    ['o:insetmode', 'auto'],
  ]);

  const fill = doc.createElement('v:fill');
  fill.setAttribute('color2', 'infoBackground [80]');
  shape.appendChild(fill);
  const shadow = doc.createElement('v:shadow');
  setOrderedAttributes(shadow, [
    ['color', 'none [81]'],
    ['obscured', 't'],
  ]);
  shape.appendChild(shadow);
  const vpath = doc.createElement('v:path');
  vpath.setAttribute('o:connecttype', 'none');
  shape.appendChild(vpath);

  const textbox = doc.createElement('v:textbox');
  setOrderedAttributes(textbox, [
    ['style', 'mso-direction-alt:auto'],
    ['inset', '1.3mm,1.3mm,2.5mm,2.5mm'],
  ]);
  const div = doc.createElement('div');
  div.setAttribute('style', 'text-align:left');
  textbox.appendChild(div);
  shape.appendChild(textbox);

  const clientData = doc.createElement('x:ClientData');
  clientData.setAttribute('ObjectType', 'Note');
  clientData.appendChild(doc.createElement('x:MoveWithCells'));
  clientData.appendChild(doc.createElement('x:SizeWithCells'));
  // Default anchor rect (exceljs's own `vml-anchor-xform.js` `getDefaultRect`,
  // `ref.col`/`ref.row` 1-based): l=col, t=max(row-2,0), r=col+2, b=t+4, with
  // fixed sub-cell fractions 6/14/2/16 — reproduced verbatim rather than
  // re-derived, since the T18 spike confirms this exact formula against a
  // real captured A1 note (`1, 6, 0, 14, 3, 2, 4, 16`).
  const l = col;
  const t = Math.max(row - 2, 0);
  const r = col + 2;
  const b = t + 4;
  const anchor = doc.createElement('x:Anchor');
  anchor.textContent = [l, 6, t, 14, r, 2, b, 16].join(', ');
  clientData.appendChild(anchor);
  const locked = doc.createElement('x:Locked');
  locked.textContent = 'True';
  clientData.appendChild(locked);
  const autoFill = doc.createElement('x:AutoFill');
  autoFill.textContent = 'False';
  clientData.appendChild(autoFill);
  const lockText = doc.createElement('x:LockText');
  lockText.textContent = 'True';
  clientData.appendChild(lockText);
  const rowEl = doc.createElement('x:Row');
  rowEl.textContent = String(row - 1);
  clientData.appendChild(rowEl);
  const colEl = doc.createElement('x:Column');
  colEl.textContent = String(col - 1);
  clientData.appendChild(colEl);
  shape.appendChild(clientData);

  return shape;
}

/** Scans the CURRENT `<v:shape id="_x0000_sNNNN">` ids already in `vmlDoc`
 *  (a foreign shape named some other way, e.g. LibreOffice's own
 *  `id="shape_0"`, simply never matches and is ignored — this app's own ids
 *  only ever need to be unique among THEMSELVES, not sequential across every
 *  tool that ever touched the file) and returns the next number to use —
 *  1025 if none exist yet, matching the spike's own "first note on a
 *  worksheet starts at _x0000_s1025" finding. */
function nextVmlShapeId(vmlDoc: Document): number {
  let max = 1024;
  for (const el of elementsByTag(vmlDoc, 'v:shape')) {
    const m = /^_x0000_s(\d+)$/.exec(el.getAttribute('id') ?? '');
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return max + 1;
}

/** F10-adjacent correctness fix (found while building this rewrite, not in
 *  any prior review): this app's OWN comments always tag `authorId="0"`
 *  (§4.1: exceljs itself hardcodes this, and this reader/writer's real
 *  author lives in the note BODY's first line, never OOXML's own author
 *  slot). The OLD exceljs-based writer never had to worry about what
 *  `authorId="0"` actually POINTS at, because it always rebuilt `<authors>`
 *  from scratch with exactly one entry, "Author", at index 0. This writer
 *  EDITS an existing `<authors>` list in place (never rebuilds it), so a
 *  file with REAL authors already listed (or, per the kitchen-sink fixture,
 *  LibreOffice's own "Unknown Author" placeholder) at index 0 would
 *  otherwise make a brand-new app-authored comment display, in Excel's UI,
 *  as written by whoever else is already at index 0 — a real misattribution
 *  this rewrite must not introduce. Fix: reuse an existing `<author>Author
 *  </author>` entry's index if this app already added one to this part
 *  before; otherwise APPEND a new one (never overwrite an existing entry)
 *  and use its new index. */
function resolveAuthorIndex(commentsDoc: Document): number {
  const authorsEl = elementsByTag(commentsDoc, 'authors')[0];
  const authorEls = authorsEl ? elementsByTag(authorsEl, 'author') : [];
  const existingIdx = authorEls.findIndex((el) => el.textContent === 'Author');
  if (existingIdx !== -1) return existingIdx;
  const authors =
    authorsEl ??
    (() => {
      const el = commentsDoc.createElement('authors');
      commentsDoc.documentElement.insertBefore(el, commentsDoc.documentElement.firstChild);
      return el;
    })();
  const newAuthor = commentsDoc.createElement('author');
  newAuthor.textContent = 'Author';
  authors.appendChild(newAuthor);
  return authorEls.length;
}

function findXlsxComment(commentsDoc: Document, cellAddr: string): Element | null {
  return elementsByTag(commentsDoc, 'comment').find((el) => el.getAttribute('ref') === cellAddr) ?? null;
}

/** Replaces (or, for a brand-new `<comment>`, sets for the first time)
 *  `commentEl`'s own `<text>` child with a SINGLE `<r><t>` run holding the
 *  full body — this app's own convention (§4.1) is one note body per cell as
 *  a plain transcript, never per-turn rich runs, so a reply/resolve/reopen
 *  necessarily flattens any rich formatting a FOREIGN multi-run note might
 *  have carried on that one cell (an accepted, pre-existing simplification —
 *  the OLD exceljs-based writer did the same via a plain-string `cell.note =`
 *  assignment). `xml:space="preserve"` is added under the same condition
 *  exceljs's own `text-xform.js` uses (leading/trailing whitespace or an
 *  embedded newline), matching the spike's own documented convention. */
function setXlsxCommentBody(doc: Document, commentEl: Element, bodyText: string): void {
  for (const existing of elementsByTag(commentEl, 'text')) {
    existing.parentNode?.removeChild(existing as unknown as Node);
  }
  const textEl = doc.createElement('text');
  const rEl = doc.createElement('r');
  const tEl = doc.createElement('t');
  if (/^\s|\n|\s$/.test(bodyText)) tEl.setAttribute('xml:space', 'preserve');
  tEl.textContent = bodyText;
  rEl.appendChild(tEl);
  textEl.appendChild(rEl);
  commentEl.appendChild(textEl);
}

function appendXlsxComment(commentsDoc: Document, cellAddr: string, authorIdx: number, bodyText: string): void {
  const commentList = elementsByTag(commentsDoc, 'commentList')[0];
  const commentEl = commentsDoc.createElement('comment');
  setOrderedAttributes(commentEl, [
    ['ref', cellAddr],
    ['authorId', String(authorIdx)],
  ]);
  setXlsxCommentBody(commentsDoc, commentEl, bodyText);
  commentList.appendChild(commentEl);
}

/** Concatenates every `<r><t>` under `commentEl`'s own `<text>`, in document
 *  order — the same "never assume a single run" reconstruction rule T12's
 *  reader already documents (a FOREIGN note, e.g. one with bold mid-sentence
 *  text, is genuinely multi-run), used here so Reply/Resolve/Reopen/Move
 *  read the CURRENT body verbatim before rewriting or relocating it. */
function rawBodyOfXlsxComment(commentEl: Element): string {
  return elementsByTag(commentEl, 't')
    .map((t) => t.textContent ?? '')
    .join('');
}

// -----------------------------------------------------------------------
// Per-worksheet wiring: resolving where a cell's comment/VML data lives (or
// would need to be created), and whether that wiring is safe to edit at all.
// -----------------------------------------------------------------------

interface SheetMeta {
  name: string;
  sheetId: number;
  rId: string;
  partPath: string;
  isChartsheet: boolean;
}

interface WorksheetContext {
  partPath: string;
  sheetId: number;
  sheetName: string;
  worksheetDoc: Document;
  worksheetXmlOriginal: string;
  worksheetChanged: boolean;
  relsPartPath: string;
  relsDoc: Document;
  relsXmlOriginal: string;
  relsChanged: boolean;
  wiring: 'none' | 'existing' | 'ambiguous';
  commentsPartPath: string | null;
  commentsDoc: Document | null;
  commentsXmlOriginal: string;
  commentsChanged: boolean;
  vmlPartPath: string | null;
  vmlDoc: Document | null;
  vmlXmlOriginal: string;
  vmlChanged: boolean;
}

interface XlsxArchive {
  zip: JSZip;
  sheets: SheetMeta[];
  contentTypesDoc: Document;
  contentTypesXmlOriginal: string;
  contentTypesChanged: boolean;
  worksheetContexts: Map<string, WorksheetContext>;
}

/** Parses `xl/workbook.xml`'s `<sheets>` against `xl/_rels/workbook.xml.rels`
 *  to resolve each `<sheet>`'s real worksheet PART path and whether it's a
 *  chartsheet (a `.../relationships/chartsheet` relationship rather than
 *  `.../relationships/worksheet`) — chartsheets are excluded from every
 *  cell-comment operation below (T12's reader already excludes them from
 *  "single sheet" counting the same way; a chartsheet has no cells at all). */
function parseSheetsFromWorkbook(workbookXml: string, workbookRelsXml: string): SheetMeta[] {
  const workbookDoc = parseXml(workbookXml);
  const relsDoc = parseXml(workbookRelsXml);
  const relMap = new Map<string, { target: string; type: string }>();
  for (const el of elementsByTag(relsDoc, 'Relationship')) {
    const id = el.getAttribute('Id');
    if (id) relMap.set(id, { target: el.getAttribute('Target') ?? '', type: el.getAttribute('Type') ?? '' });
  }
  const sheets: SheetMeta[] = [];
  for (const el of elementsByTag(workbookDoc, 'sheet')) {
    const name = el.getAttribute('name') ?? '';
    const sheetId = Number.parseInt(el.getAttribute('sheetId') ?? '', 10);
    const rId = el.getAttribute('r:id') ?? '';
    const rel = relMap.get(rId);
    if (!rel || Number.isNaN(sheetId)) continue; // malformed wiring — this sheet is simply not addressable
    sheets.push({
      name,
      sheetId,
      rId,
      partPath: resolveRelTarget('xl', rel.target),
      isChartsheet: rel.type.endsWith('/chartsheet'),
    });
  }
  return sheets;
}

async function loadXlsxArchiveForWrite(bytes: Buffer): Promise<{ ok: true; archive: XlsxArchive } | XlsxErrorResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return { ok: false, error: 'invalid-xlsx' };
  }
  const sizeCheck = checkTotalWithinCeiling(zip);
  if (!sizeCheck.ok) return { ok: false, error: sizeCheck.error };

  const featureCheck = checkNoUnsupportedFeatures(zip);
  if (!featureCheck.ok) return featureCheck;

  const workbookFile = zip.file('xl/workbook.xml');
  const contentTypesFile = zip.file('[Content_Types].xml');
  if (!workbookFile || !contentTypesFile) return { ok: false, error: 'invalid-xlsx' };
  const workbookRelsFile = zip.file('xl/_rels/workbook.xml.rels');

  let workbookXml: string;
  let contentTypesXml: string;
  let workbookRelsXml: string;
  try {
    [workbookXml, contentTypesXml, workbookRelsXml] = await Promise.all([
      workbookFile.async('string'),
      contentTypesFile.async('string'),
      workbookRelsFile ? workbookRelsFile.async('string') : Promise.resolve(EMPTY_RELS_XML),
    ]);
  } catch {
    return { ok: false, error: 'invalid-xlsx' };
  }

  const sheets = parseSheetsFromWorkbook(workbookXml, workbookRelsXml);
  return {
    ok: true,
    archive: {
      zip,
      sheets,
      contentTypesDoc: parseXml(contentTypesXml),
      contentTypesXmlOriginal: contentTypesXml,
      contentTypesChanged: false,
      worksheetContexts: new Map(),
    },
  };
}

/** Loads (or returns the already-loaded, cached-by-partPath) context for one
 *  worksheet: its own XML, its own rels, and — if wiring is unambiguous —
 *  the comments/VML parts it already points at. Determines `wiring`:
 *  - `'none'`: no `<legacyDrawing>`, no comments relationship, no vmlDrawing
 *    relationship — a worksheet with zero legacy notes so far.
 *  - `'existing'`: all three present AND internally consistent (the
 *    `<legacyDrawing r:id>` names exactly the vmlDrawing relationship's own
 *    `Id`), and both parts it points at are actually present in the archive.
 *  - `'ambiguous'`: anything else — a partial combination, a dangling
 *    reference, or a `<legacyDrawing>` pointing at something other than the
 *    vmlDrawing relationship. Refused by every caller (see
 *    `'ambiguous-comment-wiring'`'s own doc comment above) rather than
 *    guessed at. */
async function getWorksheetContext(
  archive: XlsxArchive,
  sheetMeta: SheetMeta
): Promise<{ ok: true; ctx: WorksheetContext } | { ok: false; error: 'invalid-selector' }> {
  const cached = archive.worksheetContexts.get(sheetMeta.partPath);
  if (cached) return { ok: true, ctx: cached };

  const worksheetFile = archive.zip.file(sheetMeta.partPath);
  if (!worksheetFile) return { ok: false, error: 'invalid-selector' };
  let worksheetXmlOriginal: string;
  try {
    worksheetXmlOriginal = await worksheetFile.async('string');
  } catch {
    return { ok: false, error: 'invalid-selector' };
  }
  const worksheetDoc = parseXml(worksheetXmlOriginal);

  const relsPartPath = worksheetRelsPathFor(sheetMeta.partPath);
  const relsFile = archive.zip.file(relsPartPath);
  const relsXmlOriginal = relsFile ? await relsFile.async('string') : EMPTY_RELS_XML;
  const relsDoc = parseXml(relsXmlOriginal);

  const legacyDrawingEl = elementsByTag(worksheetDoc, 'legacyDrawing')[0] ?? null;
  const relationshipEls = elementsByTag(relsDoc, 'Relationship');
  const commentsRel = relationshipEls.find((el) => el.getAttribute('Type') === COMMENTS_REL_TYPE) ?? null;
  const vmlRel = relationshipEls.find((el) => el.getAttribute('Type') === VML_REL_TYPE) ?? null;

  let wiring: WorksheetContext['wiring'];
  let commentsPartPath: string | null = null;
  let vmlPartPath: string | null = null;
  let commentsXmlOriginal = EMPTY_COMMENTS_XML;
  let vmlXmlOriginal = EMPTY_VML_XML;
  let commentsDoc: Document | null = null;
  let vmlDoc: Document | null = null;

  if (!legacyDrawingEl && !commentsRel && !vmlRel) {
    wiring = 'none';
  } else if (legacyDrawingEl && commentsRel && vmlRel && legacyDrawingEl.getAttribute('r:id') === vmlRel.getAttribute('Id')) {
    const worksheetDir = dirnameOfPart(sheetMeta.partPath);
    commentsPartPath = resolveRelTarget(worksheetDir, commentsRel.getAttribute('Target') ?? '');
    vmlPartPath = resolveRelTarget(worksheetDir, vmlRel.getAttribute('Target') ?? '');
    const commentsFile = archive.zip.file(commentsPartPath);
    const vmlFile = archive.zip.file(vmlPartPath);
    if (!commentsFile || !vmlFile) {
      wiring = 'ambiguous';
      commentsPartPath = null;
      vmlPartPath = null;
    } else {
      let loadedOk = true;
      try {
        [commentsXmlOriginal, vmlXmlOriginal] = await Promise.all([commentsFile.async('string'), vmlFile.async('string')]);
      } catch {
        loadedOk = false;
      }
      if (loadedOk) {
        commentsDoc = parseXml(commentsXmlOriginal);
        vmlDoc = parseXml(vmlXmlOriginal);
        wiring = 'existing';
      } else {
        wiring = 'ambiguous';
        commentsPartPath = null;
        vmlPartPath = null;
      }
    }
  } else {
    wiring = 'ambiguous';
  }

  const ctx: WorksheetContext = {
    partPath: sheetMeta.partPath,
    sheetId: sheetMeta.sheetId,
    sheetName: sheetMeta.name,
    worksheetDoc,
    worksheetXmlOriginal,
    worksheetChanged: false,
    relsPartPath,
    relsDoc,
    relsXmlOriginal,
    relsChanged: false,
    wiring,
    commentsPartPath,
    commentsDoc,
    commentsXmlOriginal,
    commentsChanged: false,
    vmlPartPath,
    vmlDoc,
    vmlXmlOriginal,
    vmlChanged: false,
  };
  archive.worksheetContexts.set(sheetMeta.partPath, ctx);
  return { ok: true, ctx };
}

function nextRelId(relsDoc: Document): string {
  let max = 0;
  for (const el of elementsByTag(relsDoc, 'Relationship')) {
    const m = /^rId(\d+)$/.exec(el.getAttribute('Id') ?? '');
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return `rId${max + 1}`;
}

function addXlsxRelationship(relsDoc: Document, id: string, type: string, target: string): void {
  const el = relsDoc.createElement('Relationship');
  setOrderedAttributes(el, [
    ['Id', id],
    ['Type', type],
    ['Target', target],
  ]);
  relsDoc.documentElement.appendChild(el);
}

/** Picks the smallest positive integer not already used by an
 *  `xl/comments<N>.xml` OR `xl/drawings/vmlDrawing<N>.vml` part ANYWHERE in
 *  the archive — a fresh, collision-free number for a worksheet's FIRST
 *  note, used for BOTH new parts together (conventional pairing; nothing in
 *  OOXML actually requires the two numbers to match, but every real
 *  Excel/exceljs-written file pairs them this way, and there is no reason to
 *  needlessly deviate from that convention for a from-scratch pair). */
function mintPartNumber(archive: XlsxArchive): number {
  let max = 0;
  archive.zip.forEach((relPath) => {
    let m = /^xl\/comments(\d+)\.xml$/.exec(relPath);
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
    m = /^xl\/drawings\/vmlDrawing(\d+)\.vml$/.exec(relPath);
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
  });
  return max + 1;
}

/** Transitions a `wiring: 'none'` worksheet to `'existing'` by creating its
 *  comments/VML parts (from this module's own `EMPTY_*_XML` templates,
 *  matching the T18 spike's captured shape verbatim), wiring the worksheet's
 *  own rels (comments relationship THEN vmlDrawing relationship — the
 *  spike's own confirmed order) and `[Content_Types].xml` (a single
 *  archive-wide `Default Extension="vml"`, added once, plus a fresh
 *  `Override` for the new comments part), and inserting
 *  `<legacyDrawing r:id="...">` as the worksheet's OWN LAST child element —
 *  the spike's own "legacyDrawing is the last element in `<worksheet>`, even
 *  after `<extLst>` if one exists" finding, which `appendChild` satisfies
 *  unconditionally regardless of whether an `<extLst>` is already the
 *  current last child. Called ONLY immediately before the first comment is
 *  actually added to a worksheet — never speculatively. */
function ensureWiringForAdd(archive: XlsxArchive, ctx: WorksheetContext): void {
  const n = mintPartNumber(archive);
  ctx.commentsPartPath = `xl/comments${n}.xml`;
  ctx.vmlPartPath = `xl/drawings/vmlDrawing${n}.vml`;
  ctx.commentsXmlOriginal = EMPTY_COMMENTS_XML;
  ctx.vmlXmlOriginal = EMPTY_VML_XML;
  ctx.commentsDoc = parseXml(EMPTY_COMMENTS_XML);
  ctx.vmlDoc = parseXml(EMPTY_VML_XML);

  let vmlDefaultEl = elementsByTag(archive.contentTypesDoc, 'Default').find(
    (el) => (el.getAttribute('Extension') ?? '').toLowerCase() === 'vml'
  );
  if (!vmlDefaultEl) {
    vmlDefaultEl = archive.contentTypesDoc.createElement('Default');
    setOrderedAttributes(vmlDefaultEl, [
      ['Extension', 'vml'],
      ['ContentType', VML_CONTENT_TYPE],
    ]);
    archive.contentTypesDoc.documentElement.appendChild(vmlDefaultEl);
  }
  const override = archive.contentTypesDoc.createElement('Override');
  setOrderedAttributes(override, [
    ['PartName', `/${ctx.commentsPartPath}`],
    ['ContentType', COMMENTS_CONTENT_TYPE],
  ]);
  // Inserted right after the vml Default — matching the T18 spike's own
  // captured element order exactly (exceljs's own content-types-xform.js
  // emits sheet/style/etc. Overrides, THEN the vml Default, THEN each
  // comments Override, THEN docProps' Overrides last) — rather than
  // `appendChild`, which would land after any docProps Overrides already
  // present and silently drift from the reference T19 targets.
  vmlDefaultEl.parentNode?.insertBefore(override as unknown as Node, vmlDefaultEl.nextSibling);
  archive.contentTypesChanged = true;

  const worksheetDir = dirnameOfPart(ctx.partPath);
  const commentsRelId = nextRelId(ctx.relsDoc);
  addXlsxRelationship(ctx.relsDoc, commentsRelId, COMMENTS_REL_TYPE, relativizeTarget(worksheetDir, ctx.commentsPartPath));
  const vmlRelId = nextRelId(ctx.relsDoc);
  addXlsxRelationship(ctx.relsDoc, vmlRelId, VML_REL_TYPE, relativizeTarget(worksheetDir, ctx.vmlPartPath));
  ctx.relsChanged = true;

  const legacyDrawing = ctx.worksheetDoc.createElement('legacyDrawing');
  legacyDrawing.setAttribute('r:id', vmlRelId);
  ctx.worksheetDoc.documentElement.appendChild(legacyDrawing);
  ctx.worksheetChanged = true;

  ctx.wiring = 'existing';
}

/** §4.2's own rule, applied on the WRITE side: `sheet` is required only when
 *  the workbook has more than one (non-chartsheet) tab. Reused identically by
 *  add's `selector` and move's `newSelector`. */
async function resolveWorksheetForSelector(
  archive: XlsxArchive,
  sel: CellSelector
): Promise<{ ok: true; ctx: WorksheetContext } | { ok: false; error: 'sheet-not-found' | 'invalid-selector' | 'ambiguous-comment-wiring' }> {
  if (!isValidCellAddress(sel.cell)) return { ok: false, error: 'invalid-selector' };
  const realSheets = archive.sheets.filter((s) => !s.isChartsheet);
  let sheetMeta: SheetMeta;
  if (sel.sheet) {
    const match = realSheets.find((s) => s.name === sel.sheet);
    if (!match) return { ok: false, error: 'sheet-not-found' };
    sheetMeta = match;
  } else {
    if (realSheets.length !== 1) return { ok: false, error: 'invalid-selector' };
    sheetMeta = realSheets[0];
  }
  const ctxResult = await getWorksheetContext(archive, sheetMeta);
  if (!ctxResult.ok) return { ok: false, error: 'invalid-selector' };
  if (ctxResult.ctx.wiring === 'ambiguous') return { ok: false, error: 'ambiguous-comment-wiring' };
  return { ok: true, ctx: ctxResult.ctx };
}

/** `"x-3-B5"` -> `{worksheetId: 3, cell: "B5"}`; `null` for anything not
 *  shaped like a root comment id T12's reader mints (§4's own `id:
 *  \`x-${worksheet.id}-${cell.address}\``, where `worksheet.id` is the
 *  `sheetId` XML attribute — see the T18 spike's own "worksheet id... comes
 *  from `<sheet sheetId="N">`... never from position" finding, which this
 *  writer matches by indexing `archive.sheets` on `sheetId` too, never list
 *  position). A REPLY id (`x-3-B5-r1`) is never a valid target for
 *  reply/resolve/reopen/move — those four always act on a whole THREAD. */
function parseXlsxCommentId(id: string): { sheetId: number; cell: string } | null {
  const m = /^x-(-?\d+)-(.+)$/.exec(id);
  if (!m) return null;
  const sheetId = Number.parseInt(m[1], 10);
  if (Number.isNaN(sheetId) || !isValidCellAddress(m[2])) return null;
  return { sheetId, cell: m[2] };
}

async function findCommentTargetXlsx(
  archive: XlsxArchive,
  id: string
): Promise<
  | { ok: true; ctx: WorksheetContext; commentEl: Element; cellAddr: string }
  | { ok: false; error: 'comment-not-found' | 'ambiguous-comment-wiring' }
> {
  const parsed = parseXlsxCommentId(id);
  if (!parsed) return { ok: false, error: 'comment-not-found' };
  const sheetMeta = archive.sheets.find((s) => s.sheetId === parsed.sheetId);
  if (!sheetMeta) return { ok: false, error: 'comment-not-found' };
  const ctxResult = await getWorksheetContext(archive, sheetMeta);
  if (!ctxResult.ok) return { ok: false, error: 'comment-not-found' };
  const ctx = ctxResult.ctx;
  if (ctx.wiring === 'none') return { ok: false, error: 'comment-not-found' };
  if (ctx.wiring === 'ambiguous') return { ok: false, error: 'ambiguous-comment-wiring' };
  const commentEl = findXlsxComment(ctx.commentsDoc!, parsed.cell);
  if (!commentEl) return { ok: false, error: 'comment-not-found' };
  return { ok: true, ctx, commentEl, cellAddr: parsed.cell };
}

/** Removes `cellAddr`'s `<comment>` from `ctx.commentsDoc` and its matching
 *  `<v:shape>` from `ctx.vmlDoc` (matched by `<x:Row>`/`<x:Column>` — the
 *  same 0-based pair every legacy-note-writing tool, including this one,
 *  writes into `<x:ClientData>`, confirmed present in real LibreOffice
 *  output too). Used only by Move, to vacate the OLD `[sheet, cell]` pair
 *  without leaving an orphaned entry behind. */
function removeXlsxCommentAndShape(ctx: WorksheetContext, cellAddr: string): void {
  const commentEl = findXlsxComment(ctx.commentsDoc!, cellAddr);
  if (commentEl) {
    commentEl.parentNode?.removeChild(commentEl as unknown as Node);
    ctx.commentsChanged = true;
  }
  const { col, row } = parseCellRef(cellAddr);
  const zeroRow = String(row - 1);
  const zeroCol = String(col - 1);
  for (const shape of elementsByTag(ctx.vmlDoc!, 'v:shape')) {
    const clientData = elementsByTag(shape, 'x:ClientData')[0];
    if (!clientData) continue;
    const rowEl = elementsByTag(clientData, 'x:Row')[0];
    const colEl = elementsByTag(clientData, 'x:Column')[0];
    if (rowEl?.textContent === zeroRow && colEl?.textContent === zeroCol) {
      shape.parentNode?.removeChild(shape as unknown as Node);
      ctx.vmlChanged = true;
      break;
    }
  }
}

function serializeXlsxArchive(archive: XlsxArchive): Promise<Buffer> {
  if (archive.contentTypesChanged) {
    writeXlsxPart(archive.zip, '[Content_Types].xml', archive.contentTypesDoc, archive.contentTypesXmlOriginal);
  }
  for (const ctx of archive.worksheetContexts.values()) {
    if (ctx.worksheetChanged) writeXlsxPart(archive.zip, ctx.partPath, ctx.worksheetDoc, ctx.worksheetXmlOriginal);
    if (ctx.relsChanged) writeXlsxPart(archive.zip, ctx.relsPartPath, ctx.relsDoc, ctx.relsXmlOriginal);
    if (ctx.commentsChanged && ctx.commentsDoc && ctx.commentsPartPath) {
      writeXlsxPart(archive.zip, ctx.commentsPartPath, ctx.commentsDoc, ctx.commentsXmlOriginal);
    }
    if (ctx.vmlChanged && ctx.vmlDoc && ctx.vmlPartPath) {
      writeXlsxPart(archive.zip, ctx.vmlPartPath, ctx.vmlDoc, ctx.vmlXmlOriginal);
    }
  }
  // Every OTHER part in the archive — styles, shared strings, other
  // worksheets, docProps/*, xl/externalLinks/*, images, everything — was
  // never read into a Document at all and is never `zip.file()`d again here,
  // so JSZip's own generateAsync passthrough emits its ORIGINAL bytes
  // unchanged. This IS the fix: nothing this operation didn't touch is ever
  // re-encoded.
  return archive.zip.generateAsync({ type: 'nodebuffer' });
}

// -----------------------------------------------------------------------
// Pure, in-memory mutations — bytes in, bytes out. No disk I/O here at all;
// `writeFileMutation` (write-pipeline.ts) owns backup/atomic-write/verify/
// rollback so EVERY operation gets that behaviour identically, in one place.
// -----------------------------------------------------------------------

async function mutateAddXlsxComment(
  currentBytes: Buffer,
  args: { selector: CommentSelector; text: string; author: CommentAuthor }
): Promise<XlsxMutateResult<{ bytes: Buffer; id: string }>> {
  if (args.selector.kind !== 'cell') return { ok: false, error: 'invalid-selector' };
  const loaded = await loadXlsxArchiveForWrite(currentBytes);
  if (!loaded.ok) return loaded;
  const { archive } = loaded;

  const wsResult = await resolveWorksheetForSelector(archive, args.selector.selector);
  if (!wsResult.ok) return wsResult;
  const ctx = wsResult.ctx;
  const cellAddr = args.selector.selector.cell;

  if (ctx.wiring === 'existing' && findXlsxComment(ctx.commentsDoc!, cellAddr)) {
    return { ok: false, error: 'cell-already-has-comment' };
  }
  if (!cellExistsInSheetData(ctx.worksheetDoc, cellAddr)) return { ok: false, error: 'cell-has-no-value' };
  if (ctx.wiring === 'none') ensureWiringForAdd(archive, ctx);

  const authorIdx = resolveAuthorIndex(ctx.commentsDoc!);
  const body = `${commentAuthorToDisplayName(args.author)}: ${args.text}`;
  appendXlsxComment(ctx.commentsDoc!, cellAddr, authorIdx, body);
  ctx.commentsChanged = true;

  const { col, row } = parseCellRef(cellAddr);
  const shape = buildVmlShapeElement(ctx.vmlDoc!, nextVmlShapeId(ctx.vmlDoc!), col, row);
  ctx.vmlDoc!.documentElement.appendChild(shape);
  ctx.vmlChanged = true;

  const bytes = await serializeXlsxArchive(archive);
  return { ok: true, bytes, id: `x-${ctx.sheetId}-${cellAddr}` };
}

async function mutateReplyToXlsxComment(
  currentBytes: Buffer,
  args: { id: string; text: string; author: CommentAuthor }
): Promise<XlsxMutateResult<{ bytes: Buffer }>> {
  const loaded = await loadXlsxArchiveForWrite(currentBytes);
  if (!loaded.ok) return loaded;
  const { archive } = loaded;
  const found = await findCommentTargetXlsx(archive, args.id);
  if (!found.ok) return found;
  const { ctx, commentEl } = found;

  const rawBody = rawBodyOfXlsxComment(commentEl);
  const { resolved, body } = stripResolvedMarker(rawBody);
  const withReply = `${body}\n\n${commentAuthorToDisplayName(args.author)}: ${args.text}`;
  setXlsxCommentBody(ctx.commentsDoc!, commentEl, resolved ? `${withReply}\n${RESOLVED_MARKER}` : withReply);
  ctx.commentsChanged = true;

  const bytes = await serializeXlsxArchive(archive);
  return { ok: true, bytes };
}

async function mutateSetResolvedXlsx(
  currentBytes: Buffer,
  args: { id: string },
  done: boolean
): Promise<XlsxMutateResult<{ bytes: Buffer }>> {
  const loaded = await loadXlsxArchiveForWrite(currentBytes);
  if (!loaded.ok) return loaded;
  const { archive } = loaded;
  const found = await findCommentTargetXlsx(archive, args.id);
  if (!found.ok) return found;
  const { ctx, commentEl } = found;

  const rawBody = rawBodyOfXlsxComment(commentEl);
  const { body } = stripResolvedMarker(rawBody);
  // Resolving an already-(legacy-marker-)resolved note writes the CURRENT
  // marker — the old token is never written again by any writer (§4.1) —
  // and reopening strips whichever marker matched, leaving everything else
  // in the body untouched.
  setXlsxCommentBody(ctx.commentsDoc!, commentEl, done ? `${body}\n${RESOLVED_MARKER}` : body);
  ctx.commentsChanged = true;

  const bytes = await serializeXlsxArchive(archive);
  return { ok: true, bytes };
}

/** §4.3's Move algorithm, now cross-sheet-capable: read the OLD cell's
 *  CURRENT note body VERBATIM (including any already-applied resolve marker
 *  — a move changes nothing about what was said or its resolve state, only
 *  where it points), remove the old cell's `<comment>`/`<v:shape>`, and
 *  append the identical body as a NEW `<comment>`/`<v:shape>` at the NEW
 *  `[sheet, cell]` pair the caller's `newSelector` names — minting fresh
 *  comments/VML parts for the destination worksheet if it has no notes yet
 *  (`ensureWiringForAdd`, the exact same helper Add uses). Refuses rather
 *  than clobbering if the destination already carries a DIFFERENT comment. */
async function mutateMoveXlsxComment(
  currentBytes: Buffer,
  args: { id: string; newSelector: CommentSelector }
): Promise<XlsxMutateResult<{ bytes: Buffer; movedBody: string }>> {
  if (args.newSelector.kind !== 'cell') return { ok: false, error: 'invalid-selector' };
  const loaded = await loadXlsxArchiveForWrite(currentBytes);
  if (!loaded.ok) return loaded;
  const { archive } = loaded;

  const found = await findCommentTargetXlsx(archive, args.id);
  if (!found.ok) return found;
  const { ctx: oldCtx, commentEl: oldCommentEl, cellAddr: oldCellAddr } = found;
  // Read verbatim BEFORE touching anything — this exact string is what gets
  // written to the new location and compared byte-for-byte during verify.
  const originalBody = rawBodyOfXlsxComment(oldCommentEl);

  const wsResult = await resolveWorksheetForSelector(archive, args.newSelector.selector);
  if (!wsResult.ok) return wsResult;
  const newCtx = wsResult.ctx;
  const newCellAddr = args.newSelector.selector.cell;

  const isSameCell = newCtx.partPath === oldCtx.partPath && newCellAddr === oldCellAddr;
  if (!isSameCell && newCtx.wiring === 'existing' && findXlsxComment(newCtx.commentsDoc!, newCellAddr)) {
    return { ok: false, error: 'destination-cell-occupied' };
  }
  // Same constraint `mutateAddXlsxComment` refuses on (see 'cell-has-no-value'
  // above) — a DIFFERENT destination with zero sheetData presence would write
  // valid OOXML this app's own reader still can't see. Not checked for
  // `isSameCell` — that cell demonstrably already round-trips its note today
  // (it's the READ path's own source for `oldCtx`/`oldCellAddr` above).
  if (!isSameCell && !cellExistsInSheetData(newCtx.worksheetDoc, newCellAddr)) {
    return { ok: false, error: 'cell-has-no-value' };
  }

  removeXlsxCommentAndShape(oldCtx, oldCellAddr);
  if (newCtx.wiring === 'none') ensureWiringForAdd(archive, newCtx);

  const authorIdx = resolveAuthorIndex(newCtx.commentsDoc!);
  appendXlsxComment(newCtx.commentsDoc!, newCellAddr, authorIdx, originalBody);
  newCtx.commentsChanged = true;

  const { col, row } = parseCellRef(newCellAddr);
  const shape = buildVmlShapeElement(newCtx.vmlDoc!, nextVmlShapeId(newCtx.vmlDoc!), col, row);
  newCtx.vmlDoc!.documentElement.appendChild(shape);
  newCtx.vmlChanged = true;

  const bytes = await serializeXlsxArchive(archive);
  return { ok: true, bytes, movedBody: originalBody };
}

// -----------------------------------------------------------------------
// Public orchestration — one per operation, each wiring its own mutate +
// verify into `writeFileMutation`. `absolutePath` is the already-
// containment-verified real file path (doc-comments-dispatch.ts resolves it,
// the same way it already does for `listNativeComments`/docx's write path);
// `path` is the caller's project-relative (or fallback-absolute) path,
// stamped onto `PersistedComment.path` — needed here only to re-run T12's own
// reader during verification. UNCHANGED from the original T13 (the public
// signatures/verify strategy were never the problem this rewrite fixes).
// -----------------------------------------------------------------------

const XLSX_BACKUP_SUFFIX = '.xlsx.bak';

export async function addXlsxComment(args: {
  absolutePath: string;
  path: string;
  selector: CommentSelector;
  text: string;
  author: CommentAuthor;
}): Promise<XlsxWriteResult<{ id: string }>> {
  return writeFileMutation<{ id: string }, XlsxErrorResult>(
    args.absolutePath,
    XLSX_BACKUP_SUFFIX,
    (bytes) => mutateAddXlsxComment(bytes, args),
    async (newBytes, extra) => {
      const result = await readXlsxComments(newBytes, args.path);
      if (!result.ok) return false;
      const added = result.comments.find((c) => c.id === extra.id);
      return !!added && added.text === args.text && added.replies.length === 0;
    }
  );
}

export async function replyToXlsxComment(args: {
  absolutePath: string;
  path: string;
  id: string;
  text: string;
  author: CommentAuthor;
}): Promise<XlsxWriteResult> {
  return writeFileMutation<{}, XlsxErrorResult>(
    args.absolutePath,
    XLSX_BACKUP_SUFFIX,
    (bytes) => mutateReplyToXlsxComment(bytes, args),
    async (newBytes) => {
      const result = await readXlsxComments(newBytes, args.path);
      if (!result.ok) return false;
      const target = result.comments.find((c) => c.id === args.id);
      return !!target && target.replies.some((r) => r.text === args.text);
    }
  );
}

/** `by` (§1.6's generic `{path, id, by}` payload) is accepted for call-site
 *  symmetry with the sidecar store's own `resolveComment`/`reopenComment` and
 *  docx-comments.ts's own `resolveDocxComment`, but deliberately UNUSED here:
 *  a native Excel Note has no separate resolve/reopen audit trail to record
 *  it into — only the CURRENT marker bit exists in the note body itself. */
export async function resolveXlsxComment(args: {
  absolutePath: string;
  path: string;
  id: string;
}): Promise<XlsxWriteResult> {
  return writeFileMutation<{}, XlsxErrorResult>(
    args.absolutePath,
    XLSX_BACKUP_SUFFIX,
    (bytes) => mutateSetResolvedXlsx(bytes, args, true),
    async (newBytes) => {
      const result = await readXlsxComments(newBytes, args.path);
      if (!result.ok) return false;
      const target = result.comments.find((c) => c.id === args.id);
      return !!target && target.resolved === true;
    }
  );
}

export async function reopenXlsxComment(args: {
  absolutePath: string;
  path: string;
  id: string;
}): Promise<XlsxWriteResult> {
  return writeFileMutation<{}, XlsxErrorResult>(
    args.absolutePath,
    XLSX_BACKUP_SUFFIX,
    (bytes) => mutateSetResolvedXlsx(bytes, args, false),
    async (newBytes) => {
      const result = await readXlsxComments(newBytes, args.path);
      if (!result.ok) return false;
      const target = result.comments.find((c) => c.id === args.id);
      return !!target && target.resolved === false;
    }
  );
}

export async function moveXlsxComment(args: {
  absolutePath: string;
  path: string;
  id: string;
  newSelector: CommentSelector;
}): Promise<XlsxWriteResult> {
  // `movedBody` is `writeFileMutation`'s own internal `Extra` — needed by
  // `verify` below to compare the new location's body against the ORIGINAL,
  // but not part of this function's PUBLIC result shape. Stripped before
  // returning to the caller, never leaked as an incidental extra field.
  const result = await writeFileMutation<{ movedBody: string }, XlsxErrorResult>(
    args.absolutePath,
    XLSX_BACKUP_SUFFIX,
    (bytes) => mutateMoveXlsxComment(bytes, args),
    async (newBytes, extra) => {
      if (args.newSelector.kind !== 'cell') return false;
      const read = await readXlsxComments(newBytes, args.path);
      if (!read.ok) return false;
      // OLD id must be gone — a comment record is purely positional for
      // xlsx (its id is derived from the cell address), so "the old range is
      // gone" means no comment reads back at the OLD id any more.
      if (read.comments.some((c) => c.id === args.id)) return false;
      // NEW location's raw note body must match the ORIGINAL, verbatim.
      const rawAtNew = await readRawXlsxNoteText(newBytes, args.newSelector.selector.sheet, args.newSelector.selector.cell);
      return rawAtNew === extra.movedBody;
    }
  );
  return result.ok ? { ok: true } : result;
}

/** Verify-only helper: reads the raw note text at `[sheet, cell]` off
 *  ALREADY-WRITTEN bytes, straight through exceljs (the reader T12 already
 *  uses — no reason for a verify-only path to duplicate its own OOXML
 *  parsing) — used by Move's own verify step to confirm the NEW location's
 *  body matches the ORIGINAL byte-for-byte, which the parsed
 *  `PersistedComment` shape (turns split, marker stripped) can't itself
 *  assert directly. */
async function readRawXlsxNoteText(bytes: Buffer, sheet: string | undefined, cell: string): Promise<string | null> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Buffer.from(bytes) as any);
  } catch {
    return null;
  }
  const worksheet = sheet ? workbook.getWorksheet(sheet) : workbook.worksheets[0];
  if (!worksheet) return null;
  const targetCell = worksheet.getCell(cell);
  if (!targetCell.note) return null;
  return noteToPlainText(targetCell.note);
}
