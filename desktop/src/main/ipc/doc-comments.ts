// doc-comments.ts — the docComments:* channels (list, add, reply, resolve, reopen, move, edit, edit-reply, delete,
// delete-reply, watch, unwatch), one body for both doors.
//
// WHY (2026-10-01 one-core R3-8): these were written twice — doc-comments/ipc-handlers.ts for the computer's windows
// and twelve `case`s in remote-server.ts for a phone — and the copies had drifted: the computer refused a missing
// `path` / `id` / `text` with a `missing-field` answer, the phone coerced them to "" and carried on. The computer's body
// is the one kept, so a phone now gets the same refusals.
//
// The rules every entry applies, in this order (unchanged from both old copies):
//   1. `path` must be present (else missing-field).
//   2. `projectRoot`, when given, must be a folder the app shows or a folder of an open session (the F1 fix) — the
//      ONE shared gate in doc-comments/doc-comments-gate.ts.
//   3. A mutation refuses a Word/Excel target while writes there are not supported (refuseNativeMutation).
//   4. The other required fields, then dispatch by the file's real format (docx / xlsx / the sidecar store).
// The watch relay is per subscriber: a window by its web-contents id, a phone by its own negative id, dropped when
// its renderer is destroyed or its socket closes.
import { DOC_COMMENTS_IPC } from '../doc-comments/ipc-channels';
import {
  listComments, addComment, replyToComment, resolveComment, reopenComment, moveComment, editComment, editReply,
  deleteComment, deleteReply, resolveWatchTarget,
} from '../doc-comments/doc-comments-store';
import { watchComments, unwatchComments, dropDocCommentsSubscriber } from '../doc-comments/doc-comments-watcher';
import {
  resolveNativeFormat, refuseNativeMutation, listNativeComments,
  addNativeDocxComment, replyToNativeDocxComment, resolveNativeDocxComment, reopenNativeDocxComment, moveNativeDocxComment,
  editNativeDocxComment, editNativeDocxReply, deleteNativeDocxComment, deleteNativeDocxReply,
  addNativeXlsxComment, replyToNativeXlsxComment, resolveNativeXlsxComment, reopenNativeXlsxComment, moveNativeXlsxComment,
  editNativeXlsxComment, editNativeXlsxReply, deleteNativeXlsxComment, deleteNativeXlsxReply,
} from '../doc-comments/doc-comments-dispatch';
import { refuseUnknownProjectRoot, isValidCommentSelectorShape, missingSelectorField } from '../doc-comments/doc-comments-gate';
import { defineChannel, type MainChannelCtx, type MainChannelDef } from './channel-def';

const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
/** A required field that is missing or not a non-empty string reads as `null` (F2 fix: never "undefined"). */
const reqStr = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const missingField = (field: string) => ({ ok: false as const, error: 'missing-field' as const, field });

/** The folders of every open session: a session's own folder counts as a known project root (design 1.4). */
const sessionRoots = (ctx: MainChannelCtx): readonly string[] => ctx.remote?.sessionRoots() ?? ctx.desktop?.sessionRoots() ?? [];

type Format = 'docx' | 'xlsx' | null;
/** Pick the docx reader/writer, the xlsx one, or the sidecar store's, by the file's real format. */
type Op = (a: any) => Promise<any>;
const byFormat = (format: Format, docx: Op, xlsx: Op, sidecar: Op): Op => (format === 'docx' ? docx : format === 'xlsx' ? xlsx : sidecar);

/** One mutation: the shared checks, then `call` with the already-validated string fields. */
async function mutate(
  p: any,
  ctx: MainChannelCtx,
  required: readonly string[],
  call: (format: Format, a: Record<string, any>) => Promise<any>,
  /** add only: the selector's shape, checked once the other required fields are present. */
  extraCheck?: (p: any) => object | null,
): Promise<any> {
  const filePath = reqStr(p?.path);
  if (filePath === null) return missingField('path');
  const projectRoot = optStr(p?.projectRoot);
  const gated = await refuseUnknownProjectRoot(projectRoot, sessionRoots(ctx));
  if (gated) return gated;
  const refused = refuseNativeMutation(filePath);
  if (refused) return refused;
  const fields: Record<string, string> = {};
  for (const key of required) {
    const v = reqStr(p?.[key]);
    if (v === null) return missingField(key);
    fields[key] = v;
  }
  const bad = extraCheck?.(p);
  if (bad) return bad;
  // Review finding #5: the format is decided on the RESOLVED real path (follows a symlink), never the raw string.
  const format = await resolveNativeFormat(filePath, projectRoot);
  return call(format, { path: filePath, projectRoot, ...fields });
}

/** The windows whose destroy hook is already armed (one hook per window, however many files it watches). */
const watchedSenders = new Set<number>();

export const docCommentsChannels: MainChannelDef[] = [
  defineChannel({
    name: DOC_COMMENTS_IPC.LIST, kind: 'handle',
    handler: async (p, ctx) => {
      const filePath = reqStr(p?.path);
      if (filePath === null) return missingField('path');
      const projectRoot = optStr(p?.projectRoot);
      const gated = await refuseUnknownProjectRoot(projectRoot, sessionRoots(ctx));
      if (gated) return gated;
      // Word/Excel comments live INSIDE the file (design 1.1): those extensions read through their own readers.
      const format = await resolveNativeFormat(filePath, projectRoot);
      return format ? listNativeComments(format, { path: filePath, projectRoot }) : listComments({ path: filePath, projectRoot });
    },
  }),

  defineChannel({
    name: DOC_COMMENTS_IPC.ADD, kind: 'handle',
    handler: (p, ctx) => mutate(p, ctx, ['text'],
      (f, a) => byFormat(f, addNativeDocxComment, addNativeXlsxComment, (x: any) => addComment({ ...x, id: optStr(p?.id) }))
        ({ ...a, selector: p?.selector, author: p?.author }),
      // Android parity (code review 2026-09-27, F1): a missing or malformed selector is refused, never stored.
      (q) => (isValidCommentSelectorShape(q?.selector) ? null : missingSelectorField())),
  }),
  defineChannel({ name: DOC_COMMENTS_IPC.REPLY, kind: 'handle', handler: (p, ctx) => mutate(p, ctx, ['id', 'text'], (f, a) => byFormat(f, replyToNativeDocxComment, replyToNativeXlsxComment, replyToComment)({ ...a, author: p?.author })) }),
  defineChannel({ name: DOC_COMMENTS_IPC.RESOLVE, kind: 'handle', handler: (p, ctx) => mutate(p, ctx, ['id'], (f, a) => byFormat(f, resolveNativeDocxComment, resolveNativeXlsxComment, resolveComment)({ ...a, by: p?.by })) }),
  defineChannel({ name: DOC_COMMENTS_IPC.REOPEN, kind: 'handle', handler: (p, ctx) => mutate(p, ctx, ['id'], (f, a) => byFormat(f, reopenNativeDocxComment, reopenNativeXlsxComment, reopenComment)({ ...a, by: p?.by })) }),
  defineChannel({ name: DOC_COMMENTS_IPC.MOVE, kind: 'handle', handler: (p, ctx) => mutate(p, ctx, ['id'], (f, a) => byFormat(f, moveNativeDocxComment, moveNativeXlsxComment, moveComment)({ ...a, newSelector: p?.newSelector })) }),
  defineChannel({ name: DOC_COMMENTS_IPC.EDIT, kind: 'handle', handler: (p, ctx) => mutate(p, ctx, ['id', 'text'], (f, a) => byFormat(f, editNativeDocxComment, editNativeXlsxComment, editComment)(a)) }),
  defineChannel({ name: DOC_COMMENTS_IPC.EDIT_REPLY, kind: 'handle', handler: (p, ctx) => mutate(p, ctx, ['id', 'replyId', 'text'], (f, a) => byFormat(f, editNativeDocxReply, editNativeXlsxReply, editReply)(a)) }),
  defineChannel({ name: DOC_COMMENTS_IPC.DELETE, kind: 'handle', handler: (p, ctx) => mutate(p, ctx, ['id'], (f, a) => byFormat(f, deleteNativeDocxComment, deleteNativeXlsxComment, deleteComment)(a)) }),
  defineChannel({ name: DOC_COMMENTS_IPC.DELETE_REPLY, kind: 'handle', handler: (p, ctx) => mutate(p, ctx, ['id', 'replyId'], (f, a) => byFormat(f, deleteNativeDocxReply, deleteNativeXlsxReply, deleteReply)(a)) }),

  // ── Watch / unwatch: a chokidar relay, refcounted per subscriber ──
  // A crashed or closed renderer never sends unwatch, so its refs are dropped when it is destroyed (a phone: when its
  // socket closes) — the same precedent as artifacts:watch-project and git:watch.
  defineChannel({
    name: DOC_COMMENTS_IPC.WATCH, kind: 'handle',
    handler: async (p, ctx) => {
      const filePath = reqStr(p?.path);
      if (filePath === null) return missingField('path');
      const projectRoot = optStr(p?.projectRoot);
      const gated = await refuseUnknownProjectRoot(projectRoot, sessionRoots(ctx));
      if (gated) return gated;
      const target = await resolveWatchTarget({ path: filePath, projectRoot });
      if (!target.ok) return target;
      if (ctx.remote) return watchComments(target.target, ctx.remote.docCommentsSubscriberId());
      const sender = ctx.sender;
      if (!sender) return { ok: false as const, error: 'no-window' };
      if (!watchedSenders.has(sender.id)) {
        watchedSenders.add(sender.id);
        sender.once?.('destroyed', () => {
          watchedSenders.delete(sender.id);
          dropDocCommentsSubscriber(sender.id);
        });
      }
      return watchComments(target.target, sender.id);
    },
  }),
  defineChannel({
    name: DOC_COMMENTS_IPC.UNWATCH, kind: 'handle',
    handler: async (p, ctx) => {
      const filePath = reqStr(p?.path);
      if (filePath === null) return missingField('path');
      const projectRoot = optStr(p?.projectRoot);
      const gated = await refuseUnknownProjectRoot(projectRoot, sessionRoots(ctx));
      if (gated) return gated;
      const target = await resolveWatchTarget({ path: filePath, projectRoot });
      if (target.ok) {
        // A phone that never watched has no id to drop; a window is always known.
        const id = ctx.remote ? ctx.remote.currentDocCommentsId() : ctx.sender?.id;
        if (id !== undefined) unwatchComments(target.target, id);
      }
      return { ok: true as const };
    },
  }),
];
