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
