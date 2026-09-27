// Excel (.xlsx) comment READING — T12 of the doc-comments build
// (docs/active/specs/2026-09-26-doc-comments-build-design.md §4.1-§4.3, §8
// T12). Reads exceljs legacy cell Notes (`cell.note`) into PersistedComment-
// shaped cell records, run in the Electron MAIN process for the same reason
// docx-comments.ts (T10) is: T8's native harness tools and T9's MCP
// pending-mutation queue must be able to read an Excel comment with no
// renderer window open on that file at all.
//
// exceljs is already a direct dependency (`XlsxView.tsx` already uses it
// read-only for cell VALUES) — no new dependency for this task, unlike T10's
// jszip promotion.
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import type { CellSelector, CommentAuthor, CommentReply, CommentSelector, PersistedComment } from '../../shared/doc-comments-types';
import { checkTotalWithinCeiling } from './zip-size-guard';
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
 * (this app's own precise write convention); anything else — no colon at
 * all, or a colon whose prefix isn't shaped like a name this app would have
 * written — keeps the WHOLE paragraph as the comment's TEXT, with a neutral,
 * nameless author (`toCommentAuthor('')` → `person:Unknown`; exceljs exposes
 * no per-note author field to fall back to instead — §4.1, review 1 F15,
 * confirmed against the installed version's `Comment` interface).
 */
function splitTurns(body: string): Array<{ author: string; text: string }> {
  const paragraphs = body.split(/\n{2,}/);
  return paragraphs
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => {
      const match = APP_AUTHOR_PREFIX_RE.exec(p);
      if (match) return { author: match[1], text: match[2] };
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
// Excel (.xlsx) comment WRITING — T13 of the doc-comments build
// (docs/active/specs/2026-09-26-doc-comments-build-design.md §4.3, §4.1, §8
// T13). add / reply / resolve / reopen / move, all in the SAME module as the
// reader above (§4.3: "mirroring §3.3" — docx's own "same module, mirrored
// write functions" shape) and run in the same Electron MAIN process for the
// identical reason T12 does: T8's native harness tools and T9's MCP
// pending-mutation queue must be able to mutate an Excel comment with no
// renderer window open on that file at all.
//
// Every mutation goes through `write-pipeline.ts`'s `writeFileMutation`:
// backup-before-write, atomic tmp-then-rename replace, and verify-after-write
// with AUTOMATIC ROLLBACK on failure — the file the user has open is always
// either the successfully-mutated version or byte-identical to what it was
// before, never a half-written third state. See that module's own header for
// why this is a NEW shared module rather than a copy of docx-comments.ts's
// own `writeDocxMutation` (docx-comments.ts is under a parallel, read-only
// review while this task is being built).
// =============================================================================

// -----------------------------------------------------------------------
// Feature-loss guard (write path only — never the read path above, which
// never touches the file on disk).
//
// WHY: exceljs's `workbook.xlsx.writeBuffer()` rebuilds every OOXML part from
// its OWN in-memory model — it never copies through a part it didn't parse.
// Confirmed by reading the installed exceljs@4.4.0's own source before
// writing this guard: there is no chart-xform, pivot-table-xform, slicer,
// timeline, VBA/macro or threaded-comments module ANYWHERE in
// `node_modules/exceljs/lib/` (`grep -ri 'pivot\|chart\|vba\|macro\|slicer\|
// timeline\|threadedComment' node_modules/exceljs/lib/xlsx/**/*.js` finds
// nothing but a code comment); `workbook-xform.js`'s own `reconcile()` says so
// explicitly for chartsheets — "As we don't have the infrastructure to
// support chartsheets, we will ignore them for now" — and its drawing xform
// (`xform/drawing/base-cell-anchor-xform.js` + siblings) only ever builds an
// `xdr:pic` (a picture) inside an anchor, never the `xdr:graphicFrame` shape
// an embedded worksheet chart uses, so an embedded chart is silently dropped
// exactly the same way a chartSHEET is. A `.xlsx` carrying any of these would
// come back from a note write with that content SILENTLY GONE — exactly what
// R6 ("nothing silently lost") and this task's own brief forbid. This is
// deliberately narrower than "anything exceljs might round-trip imperfectly"
// (conditional formatting, data validation, defined names and images all
// have real, dedicated exceljs modules and are NOT flagged here — refusing on
// those would make ordinary spreadsheets unwritable for no benefit); it
// targets only OOXML parts exceljs's installed module set has NO
// representation for at all, so refusing is never a false positive.
//
// HOW: a plain zip-entry-NAME scan on the SAME JSZip pre-scan already done
// for the decompression-bomb guard, before exceljs's loader ever sees the
// bytes — cheap (string prefix checks against entry names JSZip already
// parsed from the central directory) and format-agnostic.
// -----------------------------------------------------------------------

interface UnsupportedFeature {
  label: string;
  test: (entryName: string) => boolean;
}

const UNSUPPORTED_FEATURES: UnsupportedFeature[] = [
  // Chartsheets AND embedded worksheet charts both live under xl/charts/ —
  // see this section's own header for why exceljs preserves neither shape.
  { label: 'charts or chart sheets', test: (n) => n.startsWith('xl/charts/') || n.startsWith('xl/chartsheets/') },
  { label: 'pivot tables', test: (n) => n.startsWith('xl/pivotTables/') || n.startsWith('xl/pivotCache/') },
  { label: 'slicers', test: (n) => n.startsWith('xl/slicers/') || n.startsWith('xl/slicerCaches/') },
  { label: 'timelines', test: (n) => n.startsWith('xl/timelines/') },
  { label: 'VBA macros', test: (n) => n === 'xl/vbaProject.bin' },
  // Modern threaded comments (Excel 2019+) — distinct from the legacy Notes
  // this whole module reads/writes (§4.1); exceljs has no xl/threadedComments
  // or xl/persons.xml support at all.
  { label: 'modern threaded comments', test: (n) => n.startsWith('xl/threadedComments/') || n === 'xl/persons.xml' },
  { label: 'rich data types (stocks/geography)', test: (n) => n.startsWith('xl/richData/') },
  { label: 'embedded objects', test: (n) => n.startsWith('xl/embeddings/') },
  { label: 'form controls/ActiveX', test: (n) => n.startsWith('xl/ctrlProps/') || n.startsWith('xl/activeX/') },
];

type FeatureCheckResult = { ok: true } | { ok: false; error: 'unsupported-workbook-features'; features: string[] };

function checkNoUnsupportedFeatures(zip: JSZip): FeatureCheckResult {
  const found = new Set<string>();
  zip.forEach((relativePath) => {
    const name = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
    for (const feature of UNSUPPORTED_FEATURES) {
      if (feature.test(name)) found.add(feature.label);
    }
  });
  if (found.size === 0) return { ok: true };
  return { ok: false, error: 'unsupported-workbook-features', features: Array.from(found).sort() };
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
// 'sheet-not-found': a named `sheet` doesn't exist in the workbook.
// 'cell-already-has-comment': `add` targeted a cell that already carries a
//   note — this app's own comment thread lives in ONE note body per cell, so
//   a second `add` at the same address would have to either silently merge
//   into or clobber the existing thread; refused instead (R6).
// 'destination-cell-occupied': `move`'s `newSelector` names a DIFFERENT cell
//   that already has its OWN note — writing over it would silently destroy
//   that other comment (R6), so this refuses rather than clobbering.
// 'cell-has-no-value': add's target cell (or move's destination cell) has NO
//   value of its own — a confirmed exceljs@4.4.0 limitation (also documented
//   in `tests/fixtures/doc-comments/make-xlsx-fixture.mjs`'s own header,
//   which works around it for a checked-in READ fixture by patching already-
//   written XML directly): `workbook.xlsx.writeBuffer()` omits the `<c
//   r="...">` element ENTIRELY for a cell that has both no value and no prior
//   presence in the loaded XML, so a Note set on one is silently dropped —
//   never written, never found again. That XML-surgery workaround only works
//   for a one-off fixture generator; a live write path has no "already-
//   written bytes" to patch after the fact, and inventing a fake value in the
//   user's own cell as a side effect of commenting on it would corrupt their
//   data. Refusing honestly is the only choice that doesn't silently lose the
//   comment (R6) — confirmed empirically while building this task: setting a
//   note directly on a freshly-`getCell()`'d, value-less cell and round-
//   tripping through `writeBuffer()`/`load()` loses the note entirely (NOT
//   just misplaced — gone from both the old and any new location).
type XlsxWriteError =
  | XlsxReadError
  | 'comment-not-found'
  | 'invalid-selector'
  | 'sheet-not-found'
  | 'cell-already-has-comment'
  | 'destination-cell-occupied'
  | 'cell-has-no-value'
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
// still rejecting a malformed or empty string outright rather than letting
// exceljs's `getCell` auto-vivify something nonsensical.
const CELL_ADDRESS_RE = /^[A-Z]{1,3}[1-9][0-9]{0,6}$/;

function isValidCellAddress(addr: string): boolean {
  return CELL_ADDRESS_RE.test(addr);
}

/** True when `cell` carries no value of its own — the exact shape
 *  `'cell-has-no-value'` (above) refuses on, since exceljs silently drops a
 *  note set on a cell in this state when the workbook is next written.
 *  `cell.value` is `null` for both a genuinely-empty cell and one exceljs
 *  auto-vivified via `getCell()` with nothing ever assigned; `0`/`''`/`false`
 *  are real values and must NOT trip this check, hence the strict
 *  `== null` (matches `null` and `undefined` only). */
function cellHasNoValue(cell: ExcelJS.Cell): boolean {
  return cell.value === null || cell.value === undefined;
}

/** §4.2's own rule, applied on the WRITE side: `sheet` is required only when
 *  the workbook has more than one tab. Reused identically by add's `selector`
 *  and move's `newSelector` — both are `CellSelector`s naming a WRITE target. */
function resolveWorksheetForSelector(
  workbook: ExcelJS.Workbook,
  sel: CellSelector
): { ok: true; worksheet: ExcelJS.Worksheet } | { ok: false; error: 'sheet-not-found' | 'invalid-selector' } {
  if (!isValidCellAddress(sel.cell)) return { ok: false, error: 'invalid-selector' };
  if (sel.sheet) {
    const worksheet = workbook.getWorksheet(sel.sheet);
    if (!worksheet) return { ok: false, error: 'sheet-not-found' };
    return { ok: true, worksheet };
  }
  if (workbook.worksheets.length !== 1) return { ok: false, error: 'invalid-selector' };
  return { ok: true, worksheet: workbook.worksheets[0] };
}

/** `"x-3-B5"` -> `{worksheetId: 3, cell: "B5"}`; `null` for anything not
 *  shaped like a root comment id THIS reader mints (§4's own `id:
 *  \`x-${worksheet.id}-${cell.address}\``). A REPLY id (`x-3-B5-r1`) is never
 *  a valid target for reply/resolve/reopen/move — those four always act on a
 *  whole THREAD, the same rule docx-comments.ts's `stripWPrefix` documents
 *  for Word — so the trailing segment is validated as a plain cell address,
 *  which a reply id's own `-r<n>` suffix never is. */
function parseXlsxCommentId(id: string): { worksheetId: number; cell: string } | null {
  const m = /^x-(-?\d+)-(.+)$/.exec(id);
  if (!m) return null;
  const worksheetId = Number.parseInt(m[1], 10);
  if (Number.isNaN(worksheetId) || !isValidCellAddress(m[2])) return null;
  return { worksheetId, cell: m[2] };
}

interface XlsxCommentTarget {
  worksheet: ExcelJS.Worksheet;
  cellAddress: string;
  cell: ExcelJS.Cell;
}

function findCommentTarget(
  workbook: ExcelJS.Workbook,
  id: string
): { ok: true; target: XlsxCommentTarget } | { ok: false; error: 'comment-not-found' } {
  const parsed = parseXlsxCommentId(id);
  if (!parsed) return { ok: false, error: 'comment-not-found' };
  const worksheet = workbook.getWorksheet(parsed.worksheetId);
  if (!worksheet) return { ok: false, error: 'comment-not-found' };
  const cell = worksheet.getCell(parsed.cell);
  if (!cell.note) return { ok: false, error: 'comment-not-found' };
  return { ok: true, target: { worksheet, cellAddress: parsed.cell, cell } };
}

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

/** Clears a cell's note using exceljs's OWN internal convention for removing
 *  one — its public API (`cell.note = <value>`, `cell.js:228-230`) always
 *  CONSTRUCTS a new Note, never deletes one. exceljs's own row-copy code
 *  solves the identical problem by clearing the private-by-convention field
 *  directly (`cDst._comment = undefined`, confirmed real shipped code at
 *  `exceljs/lib/doc/row.js:100,125` — §4.3, review 3 F2). Used only by Move,
 *  which must remove the OLD cell's note without leaving an orphaned empty
 *  entry in comments<N>.xml/vmlDrawing<N>.vml for the vacated cell.
 *
 *  **A second field must also be cleared, beyond the design's own citation
 *  (found empirically while building this task, not in any exceljs issue or
 *  doc):** for a cell that was LOADED from an existing file with a note
 *  already on it (exactly this app's own Move case — never row.js's copy
 *  case, which is why row.js's precedent alone doesn't fully apply here),
 *  `cell.js`'s `get model()` getter (`cell.js:329-334`) only ever ADDS
 *  `model.comment = this._comment.model` when `_comment` is truthy — it never
 *  DELETES a residual `.comment` key already sitting on the cell's own
 *  cached `_value.model` object (populated once, at LOAD time, by `set
 *  model()`, and reused by reference on every later `.model` read, never
 *  rebuilt fresh). Confirmed empirically: clearing ONLY `_comment` still
 *  serialized the OLD note at the OLD cell on `workbook.xlsx.writeBuffer()`,
 *  because `cell.model.comment` — the thing `cell-xform.js`'s `render()`
 *  actually reads at write time — still held the stale value. Deleting BOTH
 *  fields is what actually removes the note from the written archive. */
function clearCellNote(cell: ExcelJS.Cell): void {
  const anyCell = cell as unknown as { _comment?: unknown; _value?: { model?: { comment?: unknown } } };
  anyCell._comment = undefined;
  if (anyCell._value?.model) delete anyCell._value.model.comment;
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

type LoadForWriteResult = { ok: true; workbook: ExcelJS.Workbook } | XlsxErrorResult;

/** Mirrors docx-comments.ts's own `loadArchiveForWrite`: pre-scan for a
 *  decompression-bomb-shaped archive (F2's own discipline — a write is at
 *  least as dangerous as a read, since it decompresses the SAME bytes before
 *  re-compressing the whole archive again) AND for an OOXML feature exceljs
 *  would silently drop, BEFORE ever handing the bytes to exceljs's loader. */
async function loadWorkbookForWrite(bytes: Buffer): Promise<LoadForWriteResult> {
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

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Buffer.from(bytes) as any);
  } catch {
    return { ok: false, error: 'invalid-xlsx' };
  }
  return { ok: true, workbook };
}

async function serializeWorkbook(workbook: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await workbook.xlsx.writeBuffer());
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
  const loaded = await loadWorkbookForWrite(currentBytes);
  if (!loaded.ok) return loaded;
  const { workbook } = loaded;

  const wsResult = resolveWorksheetForSelector(workbook, args.selector.selector);
  if (!wsResult.ok) return wsResult;
  const { worksheet } = wsResult;
  const cellAddress = args.selector.selector.cell;
  const cell = worksheet.getCell(cellAddress);
  if (cell.note) return { ok: false, error: 'cell-already-has-comment' };
  if (cellHasNoValue(cell)) return { ok: false, error: 'cell-has-no-value' };

  cell.note = `${commentAuthorToDisplayName(args.author)}: ${args.text}`;

  const bytes = await serializeWorkbook(workbook);
  return { ok: true, bytes, id: `x-${worksheet.id}-${cellAddress}` };
}

async function mutateReplyToXlsxComment(
  currentBytes: Buffer,
  args: { id: string; text: string; author: CommentAuthor }
): Promise<XlsxMutateResult<{ bytes: Buffer }>> {
  const loaded = await loadWorkbookForWrite(currentBytes);
  if (!loaded.ok) return loaded;
  const { workbook } = loaded;

  const found = findCommentTarget(workbook, args.id);
  if (!found.ok) return found;
  const { cell } = found.target;

  const rawBody = noteToPlainText(cell.note!);
  const { resolved, body } = stripResolvedMarker(rawBody);
  const withReply = `${body}\n\n${commentAuthorToDisplayName(args.author)}: ${args.text}`;
  cell.note = resolved ? `${withReply}\n${RESOLVED_MARKER}` : withReply;

  const bytes = await serializeWorkbook(workbook);
  return { ok: true, bytes };
}

async function mutateSetResolvedXlsx(
  currentBytes: Buffer,
  args: { id: string },
  done: boolean
): Promise<XlsxMutateResult<{ bytes: Buffer }>> {
  const loaded = await loadWorkbookForWrite(currentBytes);
  if (!loaded.ok) return loaded;
  const { workbook } = loaded;

  const found = findCommentTarget(workbook, args.id);
  if (!found.ok) return found;
  const { cell } = found.target;

  const rawBody = noteToPlainText(cell.note!);
  const { body } = stripResolvedMarker(rawBody);
  // Resolving an already-(legacy-marker-)resolved note writes the CURRENT
  // marker — the old token is never written again by any writer (§4.1) —
  // and reopening strips whichever marker matched, leaving everything else
  // in the body untouched (T13's own "strips the marker's exact trailing
  // line and nothing else" pinning test).
  cell.note = done ? `${body}\n${RESOLVED_MARKER}` : body;

  const bytes = await serializeWorkbook(workbook);
  return { ok: true, bytes };
}

/** §4.3's Move algorithm: read the OLD cell's CURRENT note body VERBATIM
 *  (including any already-applied resolve marker — a move changes nothing
 *  about what was said or its resolve state, only where it points), clear
 *  the old cell's note, and set the identical body on the NEW `[sheet, cell]`
 *  pair. Refuses rather than clobbering if the destination already carries a
 *  DIFFERENT comment (review 3, F2's own "nothing silently lost" reasoning,
 *  applied to the comment already sitting at the destination too). */
async function mutateMoveXlsxComment(
  currentBytes: Buffer,
  args: { id: string; newSelector: CommentSelector }
): Promise<XlsxMutateResult<{ bytes: Buffer; movedBody: string }>> {
  if (args.newSelector.kind !== 'cell') return { ok: false, error: 'invalid-selector' };
  const loaded = await loadWorkbookForWrite(currentBytes);
  if (!loaded.ok) return loaded;
  const { workbook } = loaded;

  const found = findCommentTarget(workbook, args.id);
  if (!found.ok) return found;
  const oldTarget = found.target;

  // Read verbatim BEFORE touching anything — this exact string is what gets
  // written to the new location and compared byte-for-byte during verify.
  const originalBody = noteToPlainText(oldTarget.cell.note!);

  const wsResult = resolveWorksheetForSelector(workbook, args.newSelector.selector);
  if (!wsResult.ok) return wsResult;
  const newWorksheet = wsResult.worksheet;
  const newCellAddress = args.newSelector.selector.cell;
  const newCell = newWorksheet.getCell(newCellAddress);

  const isSameCell = newWorksheet.id === oldTarget.worksheet.id && newCellAddress === oldTarget.cellAddress;
  if (!isSameCell && newCell.note) return { ok: false, error: 'destination-cell-occupied' };
  // Same exceljs limitation `mutateAddXlsxComment` refuses on (see
  // `cellHasNoValue`'s own doc comment) — a DIFFERENT value-less destination
  // would silently drop the note on write, exactly the "accidental delete"
  // shape §3.3's own move-refusal rule (mirrored here for Excel) exists to
  // prevent. Not checked for `isSameCell` — a "move" onto the comment's OWN
  // current cell is a no-op relocation, and that cell demonstrably already
  // round-trips its note today (it's the READ path's own source for
  // `oldTarget` above), so this check only needs to gate a genuinely
  // DIFFERENT destination.
  if (!isSameCell && cellHasNoValue(newCell)) return { ok: false, error: 'cell-has-no-value' };

  clearCellNote(oldTarget.cell);
  newCell.note = originalBody;

  const bytes = await serializeWorkbook(workbook);
  return { ok: true, bytes, movedBody: originalBody };
}

/** Verify-only helper: reads the raw note text at `[sheet, cell]` off
 *  ALREADY-WRITTEN bytes, straight through exceljs — used by Move's own
 *  verify step to confirm the NEW location's body matches the ORIGINAL
 *  byte-for-byte (§4.3: "confirming... the NEW cell's `.note` matches the
 *  original body byte-for-byte"), which the parsed `PersistedComment` shape
 *  (turns split, marker stripped) can't itself assert directly. */
async function readRawNoteText(bytes: Buffer, sheet: string | undefined, cell: string): Promise<string | null> {
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

// -----------------------------------------------------------------------
// Public orchestration — one per operation, each wiring its own mutate +
// verify into `writeFileMutation`. `absolutePath` is the already-
// containment-verified real file path (doc-comments-dispatch.ts resolves it,
// the same way it already does for `listNativeComments`/docx's write path);
// `path` is the caller's project-relative (or fallback-absolute) path,
// stamped onto `PersistedComment.path` — needed here only to re-run T12's own
// reader during verification.
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
  // but not part of this function's PUBLIC result shape (docx's own
  // `moveDocxComment` returns bare `{ok:true}` too — the id doesn't change
  // shape at this layer, so neither should the result). Stripped before
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
      // gone" (review 3, F2's own docx-side check) means no comment reads
      // back at the OLD id any more.
      if (read.comments.some((c) => c.id === args.id)) return false;
      // NEW location's raw note body must match the ORIGINAL, verbatim.
      const rawAtNew = await readRawNoteText(newBytes, args.newSelector.selector.sheet, args.newSelector.selector.cell);
      return rawAtNew === extra.movedBody;
    }
  );
  return result.ok ? { ok: true } : result;
}
