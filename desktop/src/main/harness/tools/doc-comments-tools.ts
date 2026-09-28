// The assistant's six document-comment tools — T8 of the doc-comments build
// (docs/active/specs/2026-09-26-doc-comments-build-design.md §5). Native
// harness surface: in-process, importing the real doc-comments-store/
// doc-comments-dispatch modules directly, same as edit.ts imports fs
// directly (§5's own architecture note — a tool call is not scoped to an
// open renderer window, so it must reach the SAME main-process store/dispatch
// IPC handlers use, not a second copy of the logic).
//
// WHY one file for all six: they share the selector schema, the plain-text-
// vs-Word/Excel dispatch decision (nativeFormatFor), and the project-root
// gate — six separate files would either duplicate all three or import them
// from each other, which is worse than one cohesive module (mirrors how
// send-user-file.ts/send-user-link.ts stay separate only because they share
// NOTHING but a name pattern).
import { z } from 'zod';
import { defineTool } from './registry';
import type { ToolContext, ToolResultPayload } from './types';
import {
  listComments,
  addComment,
  replyToComment,
  resolveComment,
  reopenComment,
  moveComment,
} from '../../doc-comments/doc-comments-store';
import {
  nativeFormatFor,
  listNativeComments,
  addNativeDocxComment,
  replyToNativeDocxComment,
  resolveNativeDocxComment,
  reopenNativeDocxComment,
  moveNativeDocxComment,
  addNativeXlsxComment,
  replyToNativeXlsxComment,
  resolveNativeXlsxComment,
  reopenNativeXlsxComment,
  moveNativeXlsxComment,
} from '../../doc-comments/doc-comments-dispatch';
import { refuseUnknownProjectRoot } from '../../doc-comments/doc-comments-gate';
import type { CommentSelector, PersistedComment } from '../../../shared/doc-comments-types';

// ---------------------------------------------------------------------------
// Shared input schema for a comment's anchor (design §1.1's pre-written
// shape, copied field-for-field — AddComment/MoveComment are the only two
// tools that ever accept one from the model).
// ---------------------------------------------------------------------------
const TEXT_QUOTE_SELECTOR = z.object({
  type: z.literal('TextQuoteSelector'),
  exact: z.string().describe('The exact text being commented on.'),
  prefix: z.string().describe('~32 chars of context immediately before the quote (whitespace-collapsed).'),
  suffix: z.string().describe('~32 chars of context immediately after the quote (whitespace-collapsed).'),
  occurrence: z.number().int().nonnegative().describe('0-indexed: which match of "exact" in the document this is.'),
}).strict();

const CELL_SELECTOR = z.object({
  type: z.literal('CellSelector'),
  cell: z.string().describe('Spreadsheet cell reference, e.g. "C4".'),
  sheet: z.string().optional().describe('Sheet tab name; omit if the workbook has only one sheet.'),
}).strict();

const COMMENT_SELECTOR = z.union([
  z.object({ kind: z.literal('text'), selector: TEXT_QUOTE_SELECTOR }).strict(),
  z.object({ kind: z.literal('cell'), selector: CELL_SELECTOR }).strict(),
]).describe('Where the comment attaches: a text quote (with surrounding context) for prose files, or a cell for spreadsheets.');

const PATH_FIELD = z.string().describe('Absolute or workspace-relative path of the commented file.');
const COMMENT_ID_FIELD = z.string().describe('The comment id — from a prior ReadFileComments call, or a reference the user handed you.');

// ---------------------------------------------------------------------------
// §1.5/doc-comments-gate.ts: this tool imports the store/dispatch directly
// (no IPC round trip), so it — like ipc-handlers.ts and remote-server.ts —
// must run the SAME `refuseUnknownProjectRoot` gate before touching either
// one, rather than re-deriving its own allowlist (doc-comments-gate.ts's own
// header names T8 as the intended caller here). `ctx.cwd` is this session's
// own live working directory — always passed as BOTH the projectRoot and its
// own extraSessionRoots entry, mirroring how a session's file drawer hands
// the comments IPC surface its own (possibly unregistered) cwd today
// (design §1.4's useActiveProject.ts fallback) — the assistant must be able
// to comment on files in the project it is actually running in, registered
// or not, while the store's OWN path-containment check (§1.5, review 2 F1)
// still refuses anything that resolves outside that root.
async function gateProjectRoot(ctx: ToolContext): Promise<string | null> {
  const gated = await refuseUnknownProjectRoot(ctx.cwd, [ctx.cwd]);
  return gated ? gated.error : null;
}

function describeError(result: { ok: false; error?: unknown }): string {
  return typeof result.error === 'string' ? result.error : 'unknown error';
}

/** §1.1/§3/§4: Word/Excel comments live inside the file itself; every other
 *  extension uses the one-sidecar-per-file JSON store. This is the SAME
 *  by-extension decision doc-comments-dispatch.ts's own header says both
 *  desktop IPC and the remote WS surface must never fork — a native tool is
 *  a third caller of that one decision, not a fourth reimplementation. */
function targetFormat(path: string) {
  return nativeFormatFor(path);
}

function formatComment(c: PersistedComment): string {
  const state = c.resolved ? 'resolved' : 'open';
  // status is set by the anchoring pass (§2.3, T14 — not yet wired as of this
  // task) and is `undefined` until then; rendered only when present so this
  // tool never claims to know something T14 hasn't computed yet.
  const status = c.status ? `, ${c.status}` : '';
  const replies = c.replies.length
    ? c.replies.map((r) => `    - ${r.author}: ${r.text}`).join('\n')
    : '    (no replies)';
  const history = c.history.length
    ? `\n  history:\n${c.history.map((h) => `    - ${h.action} by ${h.by}`).join('\n')}`
    : '';
  return `[${c.id}] ${c.author} — ${state}${status}\n  "${c.text}"\n  replies:\n${replies}${history}`;
}

// ---------------------------------------------------------------------------
// ReadFileComments — §5's table: "Every comment on a file, with status
// (anchored/detached), replies, and resolve history — what the assistant
// reads before acting on anything else in this list." Ungated (a read, same
// posture as Read/Grep/Glob — no permission subject at all, §5.2a only
// specifies a gate for the five MUTATION tools below).
// ---------------------------------------------------------------------------
export const ReadFileCommentsTool = defineTool({
  name: 'ReadFileComments',
  description:
    'Every comment on a file, with status (anchored/detached), replies, and resolve history. '
    + 'Read this before replying to, resolving, reopening, or moving any comment — the ids and '
    + 'current state it returns are what those tools need.',
  shortDescription: 'List every comment on a file, with status, replies, and resolve history.',
  inputSchema: z.object({ path: PATH_FIELD }).strict(),
  // Ungated: a read never mutates the source file or its comment store, the
  // same reasoning Read/Grep/Glob already get tool-name-only matching for.
  permissionSubject: () => undefined,
  // §1.1: no offset/limit exists for this call (a file's comments are read as
  // one unit, matching how the renderer's own comments pane loads them) — the
  // static fallback names no parameter this schema doesn't have, per the
  // registry manifest's own "no tool advises a parameter it lacks" guard.
  moreHint: 'There is no way to narrow this call — if a file has too many comments to show at once, '
    + 'ask the user which specific comment or thread matters and act on that one.',
  async execute(args, ctx): Promise<ToolResultPayload> {
    const gateErr = await gateProjectRoot(ctx);
    if (gateErr) return { text: `ReadFileComments failed: ${gateErr}`, isError: true };
    const format = targetFormat(args.path);
    const result = format
      ? await listNativeComments(format, { path: args.path, projectRoot: ctx.cwd })
      : await listComments({ path: args.path, projectRoot: ctx.cwd });
    if (!result.ok) return { text: `ReadFileComments failed: ${describeError(result)}`, isError: true };
    if (result.comments.length === 0) return { text: `No comments on ${args.path}.` };
    return { text: `${result.comments.length} comment(s) on ${args.path}:\n\n${result.comments.map(formatComment).join('\n\n')}` };
  },
});

// ---------------------------------------------------------------------------
// ReplyToComment — §5's table: "Appends a reply as 'assistant'."
// ---------------------------------------------------------------------------
export const ReplyToCommentTool = defineTool({
  name: 'ReplyToComment',
  description:
    'Reply to a comment the user (or a previous turn) left on this file — for a plain-text/markdown/code '
    + 'comment thread, or a real Word/Excel comment. Use it to answer a question they left, or to say what '
    + 'you did about something they flagged.',
  shortDescription: 'Reply to a comment on a file.',
  inputSchema: z.object({ path: PATH_FIELD, commentId: COMMENT_ID_FIELD, text: z.string().describe('The reply text.') }).strict(),
  // §5.2a, DECIDED (Destin, "fine w A" — option 1): a Word/Excel target writes
  // DIRECTLY into that file's own XML/note bytes (§3.3/§4.3a) — functionally
  // an edit of real document content, so it gets the SAME subject shape
  // Edit/Write use (the file path), which is what lets a remembered "Always
  // allow" grant and the cwd-jail's external-directory ask apply to it the
  // same way they already apply to an Edit call on that file. A plain-text/
  // markdown/code target only ever touches the inert `.youcoded/comments/`
  // JSON sidecar (§1.1) — internal app metadata, never the source file's own
  // bytes — so it stays tool-name-only matched (`undefined`), exactly
  // `SendUserFile`'s one existing `permissionSubject: () => undefined`
  // precedent (types.ts's own doc comment on that field).
  permissionSubject: (a) => (targetFormat(a.path) ? a.path : undefined),
  async execute(args, ctx): Promise<ToolResultPayload> {
    const gateErr = await gateProjectRoot(ctx);
    if (gateErr) return { text: `ReplyToComment failed: ${gateErr}`, isError: true };
    const format = targetFormat(args.path);
    const result = format === 'docx'
      ? await replyToNativeDocxComment({ path: args.path, projectRoot: ctx.cwd, id: args.commentId, text: args.text, author: 'assistant' })
      : format === 'xlsx'
        ? await replyToNativeXlsxComment({ path: args.path, projectRoot: ctx.cwd, id: args.commentId, text: args.text, author: 'assistant' })
        : await replyToComment({ path: args.path, projectRoot: ctx.cwd, id: args.commentId, text: args.text, author: 'assistant' });
    if (!result.ok) return { text: `ReplyToComment failed: ${describeError(result)}`, isError: true };
    return { text: `Reply added to comment ${args.commentId} on ${args.path}.` };
  },
});

// ---------------------------------------------------------------------------
// ResolveComment — §5's table: "Marks resolved, resolvedBy: 'assistant'."
// ---------------------------------------------------------------------------
export const ResolveCommentTool = defineTool({
  name: 'ResolveComment',
  description:
    "Mark a comment resolved — recorded in its history as resolved by the assistant. Use this once you've "
    + 'addressed what a comment asked for; R6 (nothing silently lost) is why the resolve/reopen history stays visible.',
  shortDescription: 'Mark a comment on a file as resolved.',
  inputSchema: z.object({ path: PATH_FIELD, commentId: COMMENT_ID_FIELD }).strict(),
  // Same §5.2a split as ReplyToComment — see its own WHY above.
  permissionSubject: (a) => (targetFormat(a.path) ? a.path : undefined),
  async execute(args, ctx): Promise<ToolResultPayload> {
    const gateErr = await gateProjectRoot(ctx);
    if (gateErr) return { text: `ResolveComment failed: ${gateErr}`, isError: true };
    const format = targetFormat(args.path);
    const result = format === 'docx'
      ? await resolveNativeDocxComment({ path: args.path, projectRoot: ctx.cwd, id: args.commentId, by: 'assistant' })
      : format === 'xlsx'
        ? await resolveNativeXlsxComment({ path: args.path, projectRoot: ctx.cwd, id: args.commentId, by: 'assistant' })
        : await resolveComment({ path: args.path, projectRoot: ctx.cwd, id: args.commentId, by: 'assistant' });
    if (!result.ok) return { text: `ResolveComment failed: ${describeError(result)}`, isError: true };
    return { text: `Comment ${args.commentId} on ${args.path} marked resolved.` };
  },
});

// ---------------------------------------------------------------------------
// ReopenComment — §5's table: "Clears resolved."
// ---------------------------------------------------------------------------
export const ReopenCommentTool = defineTool({
  name: 'ReopenComment',
  description:
    "Reopen a comment that was marked resolved — clears its resolved state so it shows as open again. Use this "
    + "if a resolved comment's issue turns out not to be fully addressed.",
  shortDescription: 'Reopen a resolved comment on a file.',
  inputSchema: z.object({ path: PATH_FIELD, commentId: COMMENT_ID_FIELD }).strict(),
  // Same §5.2a split as ReplyToComment — see its own WHY above.
  permissionSubject: (a) => (targetFormat(a.path) ? a.path : undefined),
  async execute(args, ctx): Promise<ToolResultPayload> {
    const gateErr = await gateProjectRoot(ctx);
    if (gateErr) return { text: `ReopenComment failed: ${gateErr}`, isError: true };
    const format = targetFormat(args.path);
    const result = format === 'docx'
      ? await reopenNativeDocxComment({ path: args.path, projectRoot: ctx.cwd, id: args.commentId, by: 'assistant' })
      : format === 'xlsx'
        ? await reopenNativeXlsxComment({ path: args.path, projectRoot: ctx.cwd, id: args.commentId, by: 'assistant' })
        : await reopenComment({ path: args.path, projectRoot: ctx.cwd, id: args.commentId, by: 'assistant' });
    if (!result.ok) return { text: `ReopenComment failed: ${describeError(result)}`, isError: true };
    return { text: `Comment ${args.commentId} on ${args.path} reopened.` };
  },
});

// ---------------------------------------------------------------------------
// AddComment — §5.1 (R4): the ONE tool whose description text is a signed,
// pre-written constraint, not a paraphrase-able summary. Copied verbatim —
// drifting even one word ("sparingly", "never to narrate") is how R4 quietly
// regresses later (T8's own task-table warning).
// ---------------------------------------------------------------------------
export const AddCommentTool = defineTool({
  name: 'AddComment',
  description:
    "Leave a comment on this file — sparingly. Use this only for something that clearly needs the user's "
    + 'attention or a decision from them, never to narrate what you just did or are about to do. If you\'re '
    + "explaining your own edit, say so in your reply to them instead; if nothing needs their decision, don't "
    + 'add a comment at all.',
  shortDescription: "Leave a comment on this file — sparingly, only for something needing the user's decision.",
  inputSchema: z.object({ path: PATH_FIELD, selector: COMMENT_SELECTOR, text: z.string().describe('The comment text.') }).strict(),
  // Same §5.2a split as ReplyToComment — see its own WHY above.
  permissionSubject: (a) => (targetFormat(a.path) ? a.path : undefined),
  async execute(args, ctx): Promise<ToolResultPayload> {
    const gateErr = await gateProjectRoot(ctx);
    if (gateErr) return { text: `AddComment failed: ${gateErr}`, isError: true };
    const format = targetFormat(args.path);
    const selector = args.selector as CommentSelector;
    const result = format === 'docx'
      ? await addNativeDocxComment({ path: args.path, projectRoot: ctx.cwd, selector, text: args.text, author: 'assistant' })
      : format === 'xlsx'
        ? await addNativeXlsxComment({ path: args.path, projectRoot: ctx.cwd, selector, text: args.text, author: 'assistant' })
        : await addComment({ path: args.path, projectRoot: ctx.cwd, selector, text: args.text, author: 'assistant' });
    if (!result.ok) return { text: `AddComment failed: ${describeError(result)}`, isError: true };
    return { text: `Comment added to ${args.path} (id: ${result.id}).` };
  },
});

// ---------------------------------------------------------------------------
// MoveComment — §5's table: "Repoints a comment's selector — the re-anchor
// half of R6."
// ---------------------------------------------------------------------------
export const MoveCommentTool = defineTool({
  name: 'MoveComment',
  description:
    "Repoint a comment to a new location in the file, after the text or cell it was attached to moved or "
    + 'changed. This is the re-anchor half of R6 (nothing silently lost): after you fix what a comment asked '
    + 'for, use this — together with ReplyToComment/ResolveComment as appropriate — so the comment keeps '
    + 'pointing at something real instead of going quietly detached.',
  shortDescription: "Repoint a comment's anchor after the text or cell it referenced changed.",
  inputSchema: z.object({ path: PATH_FIELD, commentId: COMMENT_ID_FIELD, newSelector: COMMENT_SELECTOR }).strict(),
  // Same §5.2a split as ReplyToComment — see its own WHY above.
  permissionSubject: (a) => (targetFormat(a.path) ? a.path : undefined),
  async execute(args, ctx): Promise<ToolResultPayload> {
    const gateErr = await gateProjectRoot(ctx);
    if (gateErr) return { text: `MoveComment failed: ${gateErr}`, isError: true };
    const format = targetFormat(args.path);
    const newSelector = args.newSelector as CommentSelector;
    const result = format === 'docx'
      ? await moveNativeDocxComment({ path: args.path, projectRoot: ctx.cwd, id: args.commentId, newSelector })
      : format === 'xlsx'
        ? await moveNativeXlsxComment({ path: args.path, projectRoot: ctx.cwd, id: args.commentId, newSelector })
        : await moveComment({ path: args.path, projectRoot: ctx.cwd, id: args.commentId, newSelector });
    if (!result.ok) return { text: `MoveComment failed: ${describeError(result)}`, isError: true };
    return { text: `Comment ${args.commentId} on ${args.path} repointed.` };
  },
});

