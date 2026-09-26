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
import ExcelJS from 'exceljs';
import type { CellSelector, CommentAuthor, CommentReply, CommentSelector, PersistedComment } from '../../shared/doc-comments-types';

// Not exported (same convention as docx-comments.ts's DocxReadError, and
// doc-comments-store.ts's DocCommentsError): nothing outside this module
// needs the error union by name — knip flags an exported type nothing ever
// imports as dead code. Callers only need `XlsxReadResult`, which IS exported.
type XlsxReadError = 'invalid-xlsx';
export type XlsxReadResult = { ok: true; comments: PersistedComment[] } | { ok: false; error: XlsxReadError };

// §4.1's fixed, non-natural-language resolve marker: a leading zero-width
// space plus a bracketed token, appended as the note body's own trailing
// line. Inert in ordinary prose (matching `compose-ref.ts`'s own `⦃…⦄`
// delimiters' reasoning) so a legitimate reply that happens to end with the
// word "resolved" is never misread as this app's own resolve marker.
const RESOLVED_MARKER = '​[[yc:resolved]]';

/** Turn an exceljs `cell.note` (a plain string OR a rich-text object with
 *  `texts`) into plain text — the same normalization §4.1 assumes when it
 *  describes the note body as a formatted transcript. */
function noteToPlainText(note: ExcelJS.Comment | string): string {
  if (typeof note === 'string') return note;
  const texts = note.texts;
  if (!Array.isArray(texts)) return '';
  return texts.map((t) => t.text ?? '').join('');
}

/**
 * Splits a note body into "turns" — §4.1's transcript format is one turn per
 * blank-line-separated paragraph, each shaped `"Author: text"` (the ONLY
 * place §4.1 says the author's name goes is "as the first line of the note
 * body" — for a single, no-reply comment that first line IS the whole body,
 * `"Name: text"`). A turn with no recognizable `"Name: "` prefix (a foreign
 * note this app didn't write, or a real Excel/Google Sheets comment with no
 * such convention) is kept whole, with the WHOLE line as its author name —
 * never invented, never silently dropped (§1.1's "nothing silently lost").
 */
function splitTurns(body: string): Array<{ author: string; text: string }> {
  const paragraphs = body.split(/\n{2,}/);
  return paragraphs
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => {
      // A short, single-line "Name: " prefix — long enough for a real name,
      // short enough that a colon deep inside a sentence (a URL, a time of
      // day) doesn't get mistaken for the author separator.
      const match = /^([^\n:]{1,60}):\s([\s\S]*)$/.exec(p);
      if (match) return { author: match[1], text: match[2] };
      return { author: p, text: '' };
    });
}

function toCommentAuthor(name: string): CommentAuthor {
  return `person:${name || 'Unknown'}`;
}

/**
 * Reads every legacy cell Note in a workbook's raw bytes into
 * PersistedComment-shaped records. `path` is stamped onto each record the
 * same way docx-comments.ts's `readDocxComments` does (§1.1: these are never
 * stored in a JSON sidecar, but the field still identifies the source file).
 *
 * WHY every commented cell in this app's own fixtures also carries a plain
 * value: exceljs@4.4.0's own write path silently drops a note on a
 * value-less cell on round-trip (confirmed empirically while building this
 * task's fixture — `tests/fixtures/doc-comments/make-xlsx-fixture.mjs`'s
 * header has the full account) — this reader still WALKS every cell
 * `eachRow`/`eachCell` gives it (§4.2: "every worksheet's cells for a
 * non-empty `.note`"), so a file written by real Excel (which does not share
 * that limitation) reads correctly too; only THIS app's own round-trip via
 * this exact exceljs version is affected, a write-side (T13) concern.
 */
export async function readXlsxComments(bytes: Uint8Array | Buffer, path: string): Promise<XlsxReadResult> {
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
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const note = cell.note;
        if (!note) return;
        const rawBody = noteToPlainText(note);
        const resolved = rawBody.endsWith(RESOLVED_MARKER);
        // Strip the marker (plus the newline that precedes it, if any) before
        // splitting into turns — the marker is a machine signal, never part
        // of a turn's displayed text.
        const body = resolved
          ? rawBody.slice(0, rawBody.length - RESOLVED_MARKER.length).replace(/\n$/, '')
          : rawBody;
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
