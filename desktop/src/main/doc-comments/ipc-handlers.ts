// docComments:* IPC registration — T3 of the doc-comments build (design
// docs/active/specs/2026-09-26-doc-comments-build-design.md §1.5, §1.6).
//
// WHY this is its own registration function, unlike most of ipc-handlers.ts's
// giant inline body: it makes the containment/plumbing behaviour this design
// leans on (review 3, F1 — reply/resolve/reopen/move all require the SAME
// containment-checked `path` field list/add already had) directly testable
// without standing up registerIpcHandlers' full dependency graph (a session
// manager, a skill provider, a command provider, …) — see
// tests/doc-comments-ipc-handlers.test.ts. `deps` below is deliberately a
// couple of plain functions, not the `webContents` module or a RemoteServer
// instance, for the same reason.
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import {
  listComments,
  addComment,
  replyToComment,
  resolveComment,
  reopenComment,
  moveComment,
  resolveWatchTarget,
} from './doc-comments-store';
import {
  initDocCommentsWatcher,
  watchComments,
  unwatchComments,
  dropDocCommentsSubscriber,
} from './doc-comments-watcher';
import { DOC_COMMENTS_IPC } from './ipc-channels';
import {
  resolveNativeFormat,
  refuseNativeMutation,
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
} from './doc-comments-dispatch';
import { refuseUnknownProjectRoot } from './doc-comments-gate';
import type { CommentAuthor, CommentSelector } from '../../shared/doc-comments-types';

export interface DocCommentsHandlerDeps {
  /** Fan `docComments:changed` out to every window (pages:changed's own
   *  pattern — §1.5 "Broadcast scope": un-filtered, a window not showing
   *  that path ignores it cheaply). */
  getAllWebContents: () => Array<{ isDestroyed(): boolean; send(channel: string, ...args: unknown[]): void }>;
  /** A WS-connected remote browser gets the same push (review 2, F6) — absent
   *  in tests/a build with no remote server running. */
  remoteBroadcast?: (msg: { type: string; payload: unknown }) => void;
  /** Every currently-live session's cwd (mirrors remote-server.ts's own
   *  `sessionRoots()` / "records" mode) — a session's file drawer can hand
   *  this feature a raw session cwd that was never added as a saved folder or
   *  indexed project (`useActiveProject.ts`'s synthetic-project fallback,
   *  design §1.4), so the projectRoot gate below (F1 fix) must accept those
   *  too, not just saved/indexed roots, or every unregistered open session's
   *  comments would start refusing. Optional/defaulted to `[]` so existing
   *  callers (and tests) that don't wire a session manager keep working —
   *  same "a couple of plain functions" testability goal as the rest of
   *  `deps`. */
  sessionRoots?: () => readonly string[];
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** F2 fix (post-T3 build review): a required field that's missing or the
 *  wrong type now refuses with a distinct, honest `missing-field` error —
 *  the OLD `reqStr` coerced via `String(v)`, so a missing `path`/`id`/`text`
 *  silently became the literal string "undefined", which the store then
 *  quietly resolved/mismatched as if it were a real (if nonsensical) value.
 *  Returns `null` for "missing"; every call site below turns that into
 *  `missingField(name)` before doing anything else. */
function reqStr(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

type MissingFieldRefusal = { ok: false; error: 'missing-field'; field: string };

function missingField(field: string): MissingFieldRefusal {
  return { ok: false, error: 'missing-field', field };
}

export function registerDocCommentsHandlers(ipcMain: Pick<IpcMain, 'handle'>, deps: DocCommentsHandlerDeps): void {
  initDocCommentsWatcher((sourcePath, projectRoot) => {
    // F3 fix (T5 review): `projectRoot` rides along so a renderer watching two
    // projects that share a relative path (both have a `README.md`) re-lists
    // the RIGHT one — see doc-comments-store.ts's (renderer) `keyFor`.
    const payload = { path: sourcePath, projectRoot };
    for (const wc of deps.getAllWebContents()) {
      if (!wc.isDestroyed()) wc.send(DOC_COMMENTS_IPC.CHANGED, payload);
    }
    deps.remoteBroadcast?.({ type: DOC_COMMENTS_IPC.CHANGED, payload });
  });

  // F1 fix (post-T3 build review, blocker): every channel below refuses an
  // unrecognized `projectRoot` BEFORE calling into the store at all — the
  // store's own containment check only proves `path` resolves inside
  // WHATEVER root it's given, so an unvetted `projectRoot` (e.g. '/' or
  // $HOME) made that check a no-op. `refuseUnknownProjectRoot` is the one
  // shared gate (`doc-comments-gate.ts`) remote-server.ts's docComments cases
  // reuse too, so desktop and remote can never disagree about which roots are
  // "known".
  const gateProjectRoot = (projectRoot: string | undefined) =>
    refuseUnknownProjectRoot(projectRoot, deps.sessionRoots?.() ?? []);

  // Word/Excel comments live INSIDE the file (§1.1) — no sidecar exists for
  // these two extensions, so list() dispatches to T10/T12's own readers
  // instead of the sidecar store. Every OTHER extension is unaffected.
  ipcMain.handle(DOC_COMMENTS_IPC.LIST, async (_e: IpcMainInvokeEvent, payload: any) => {
    const filePath = reqStr(payload?.path);
    if (filePath === null) return missingField('path');
    const projectRoot = optStr(payload?.projectRoot);
    const gated = await gateProjectRoot(projectRoot);
    if (gated) return gated;
    // Review finding #5: decided on the RESOLVED real path (follows a
    // symlink), never the caller's raw string — see `resolveNativeFormat`'s
    // own doc comment.
    const format = await resolveNativeFormat(filePath, projectRoot);
    if (format) return listNativeComments(format, { path: filePath, projectRoot });
    return listComments({ path: filePath, projectRoot });
  });

  ipcMain.handle(DOC_COMMENTS_IPC.ADD, async (_e: IpcMainInvokeEvent, payload: any) => {
    const filePath = reqStr(payload?.path);
    if (filePath === null) return missingField('path');
    const projectRoot = optStr(payload?.projectRoot);
    const gated = await gateProjectRoot(projectRoot);
    if (gated) return gated;
    const refused = refuseNativeMutation(filePath);
    if (refused) return refused;
    const text = reqStr(payload?.text);
    if (text === null) return missingField('text');
    // Review finding #5: resolved real path, not the raw string — see
    // `resolveNativeFormat`'s own doc comment.
    const format = await resolveNativeFormat(filePath, projectRoot);
    if (format === 'docx') {
      return addNativeDocxComment({
        path: filePath,
        projectRoot,
        selector: payload?.selector as CommentSelector,
        text,
        author: payload?.author as CommentAuthor,
      });
    }
    if (format === 'xlsx') {
      return addNativeXlsxComment({
        path: filePath,
        projectRoot,
        selector: payload?.selector as CommentSelector,
        text,
        author: payload?.author as CommentAuthor,
      });
    }
    return addComment({
      path: filePath,
      projectRoot,
      selector: payload?.selector as CommentSelector,
      text,
      author: payload?.author as CommentAuthor,
      // F4 fix (T5 review): the renderer mints and sends this now — see
      // doc-comments-store.ts's own `addComment` WHY. `optStr` already treats
      // an empty/non-string value as absent, matching every other optional
      // field on this payload.
      id: optStr(payload?.id),
    });
  });

  // reply/resolve/reopen/move ALL require `path`, containment-checked the
  // SAME way list/add's already is (review 3, F1) — the sidecar holding a
  // given comment id can only be found by knowing the file, and until this
  // fix none of these four carried one at all. Each also refuses first for a
  // .docx/.xlsx target, same reasoning as add above.
  ipcMain.handle(DOC_COMMENTS_IPC.REPLY, async (_e: IpcMainInvokeEvent, payload: any) => {
    const filePath = reqStr(payload?.path);
    if (filePath === null) return missingField('path');
    const projectRoot = optStr(payload?.projectRoot);
    const gated = await gateProjectRoot(projectRoot);
    if (gated) return gated;
    const refused = refuseNativeMutation(filePath);
    if (refused) return refused;
    const id = reqStr(payload?.id);
    if (id === null) return missingField('id');
    const text = reqStr(payload?.text);
    if (text === null) return missingField('text');
    // Review finding #5: resolved real path, not the raw string.
    const format = await resolveNativeFormat(filePath, projectRoot);
    if (format === 'docx') {
      return replyToNativeDocxComment({ path: filePath, projectRoot, id, text, author: payload?.author as CommentAuthor });
    }
    if (format === 'xlsx') {
      return replyToNativeXlsxComment({ path: filePath, projectRoot, id, text, author: payload?.author as CommentAuthor });
    }
    return replyToComment({
      path: filePath,
      projectRoot,
      id,
      text,
      author: payload?.author as CommentAuthor,
    });
  });

  ipcMain.handle(DOC_COMMENTS_IPC.RESOLVE, async (_e: IpcMainInvokeEvent, payload: any) => {
    const filePath = reqStr(payload?.path);
    if (filePath === null) return missingField('path');
    const projectRoot = optStr(payload?.projectRoot);
    const gated = await gateProjectRoot(projectRoot);
    if (gated) return gated;
    const refused = refuseNativeMutation(filePath);
    if (refused) return refused;
    const id = reqStr(payload?.id);
    if (id === null) return missingField('id');
    // Review finding #5: resolved real path, not the raw string.
    const format = await resolveNativeFormat(filePath, projectRoot);
    if (format === 'docx') {
      return resolveNativeDocxComment({ path: filePath, projectRoot, id, by: payload?.by as CommentAuthor });
    }
    if (format === 'xlsx') {
      return resolveNativeXlsxComment({ path: filePath, projectRoot, id, by: payload?.by as CommentAuthor });
    }
    return resolveComment({
      path: filePath,
      projectRoot,
      id,
      by: payload?.by as CommentAuthor,
    });
  });

  ipcMain.handle(DOC_COMMENTS_IPC.REOPEN, async (_e: IpcMainInvokeEvent, payload: any) => {
    const filePath = reqStr(payload?.path);
    if (filePath === null) return missingField('path');
    const projectRoot = optStr(payload?.projectRoot);
    const gated = await gateProjectRoot(projectRoot);
    if (gated) return gated;
    const refused = refuseNativeMutation(filePath);
    if (refused) return refused;
    const id = reqStr(payload?.id);
    if (id === null) return missingField('id');
    // Review finding #5: resolved real path, not the raw string.
    const format = await resolveNativeFormat(filePath, projectRoot);
    if (format === 'docx') {
      return reopenNativeDocxComment({ path: filePath, projectRoot, id, by: payload?.by as CommentAuthor });
    }
    if (format === 'xlsx') {
      return reopenNativeXlsxComment({ path: filePath, projectRoot, id, by: payload?.by as CommentAuthor });
    }
    return reopenComment({
      path: filePath,
      projectRoot,
      id,
      by: payload?.by as CommentAuthor,
    });
  });

  ipcMain.handle(DOC_COMMENTS_IPC.MOVE, async (_e: IpcMainInvokeEvent, payload: any) => {
    const filePath = reqStr(payload?.path);
    if (filePath === null) return missingField('path');
    const projectRoot = optStr(payload?.projectRoot);
    const gated = await gateProjectRoot(projectRoot);
    if (gated) return gated;
    const refused = refuseNativeMutation(filePath);
    if (refused) return refused;
    const id = reqStr(payload?.id);
    if (id === null) return missingField('id');
    // Review finding #5: resolved real path, not the raw string.
    const format = await resolveNativeFormat(filePath, projectRoot);
    if (format === 'docx') {
      return moveNativeDocxComment({ path: filePath, projectRoot, id, newSelector: payload?.newSelector as CommentSelector });
    }
    if (format === 'xlsx') {
      return moveNativeXlsxComment({ path: filePath, projectRoot, id, newSelector: payload?.newSelector as CommentSelector });
    }
    return moveComment({
      path: filePath,
      projectRoot,
      id,
      newSelector: payload?.newSelector as CommentSelector,
    });
  });

  // ── Watch/unwatch: chokidar relay, refcounted per webContents id ──
  // A crashed/closed renderer never sends unwatch — drop its refs on
  // destroy, same precedent as artifacts:watch-project/git:watch
  // (project-watcher.ts / git-watcher.ts).
  const watchedSenders = new Set<number>();
  ipcMain.handle(DOC_COMMENTS_IPC.WATCH, async (e: IpcMainInvokeEvent, payload: any) => {
    const filePath = reqStr(payload?.path);
    if (filePath === null) return missingField('path');
    const projectRoot = optStr(payload?.projectRoot);
    const gated = await gateProjectRoot(projectRoot);
    if (gated) return gated;
    const target = await resolveWatchTarget({ path: filePath, projectRoot });
    if (!target.ok) return target;
    const senderId = e.sender.id;
    if (!watchedSenders.has(senderId)) {
      watchedSenders.add(senderId);
      e.sender.once('destroyed', () => {
        watchedSenders.delete(senderId);
        dropDocCommentsSubscriber(senderId);
      });
    }
    return watchComments(target.target, senderId);
  });

  ipcMain.handle(DOC_COMMENTS_IPC.UNWATCH, async (e: IpcMainInvokeEvent, payload: any) => {
    const filePath = reqStr(payload?.path);
    if (filePath === null) return missingField('path');
    const projectRoot = optStr(payload?.projectRoot);
    const gated = await gateProjectRoot(projectRoot);
    if (gated) return gated;
    const target = await resolveWatchTarget({ path: filePath, projectRoot });
    if (target.ok) unwatchComments(target.target, e.sender.id);
    return { ok: true };
  });
}
