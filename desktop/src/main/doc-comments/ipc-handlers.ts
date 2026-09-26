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
import { nativeFormatFor, refuseNativeMutation, listNativeComments } from './doc-comments-dispatch';
import type { CommentAuthor, CommentSelector } from '../../shared/doc-comments-types';

export interface DocCommentsHandlerDeps {
  /** Fan `docComments:changed` out to every window (pages:changed's own
   *  pattern — §1.5 "Broadcast scope": un-filtered, a window not showing
   *  that path ignores it cheaply). */
  getAllWebContents: () => Array<{ isDestroyed(): boolean; send(channel: string, ...args: unknown[]): void }>;
  /** A WS-connected remote browser gets the same push (review 2, F6) — absent
   *  in tests/a build with no remote server running. */
  remoteBroadcast?: (msg: { type: string; payload: unknown }) => void;
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** `String(undefined)` is the literal text "undefined", which the store then
 *  resolves and refuses/mismatches the SAME honest way any other string
 *  would (`path-outside-project` if it lands outside the root,
 *  `comment-not-found` if the id it's paired with doesn't exist there) —
 *  there is no separate "field missing" code path to keep honest, and a
 *  caller that omits a required field gets a typed refusal, never a thrown
 *  TypeError. */
function reqStr(v: unknown): string {
  return typeof v === 'string' ? v : String(v);
}

export function registerDocCommentsHandlers(ipcMain: Pick<IpcMain, 'handle'>, deps: DocCommentsHandlerDeps): void {
  initDocCommentsWatcher((sourcePath) => {
    const payload = { path: sourcePath };
    for (const wc of deps.getAllWebContents()) {
      if (!wc.isDestroyed()) wc.send(DOC_COMMENTS_IPC.CHANGED, payload);
    }
    deps.remoteBroadcast?.({ type: DOC_COMMENTS_IPC.CHANGED, payload });
  });

  // Word/Excel comments live INSIDE the file (§1.1) — no sidecar exists for
  // these two extensions, so list() dispatches to T10/T12's own readers
  // instead of the sidecar store. Every OTHER extension is unaffected.
  ipcMain.handle(DOC_COMMENTS_IPC.LIST, async (_e: IpcMainInvokeEvent, payload: any) => {
    const filePath = reqStr(payload?.path);
    const projectRoot = optStr(payload?.projectRoot);
    const format = nativeFormatFor(filePath);
    if (format) return listNativeComments(format, { path: filePath, projectRoot });
    return listComments({ path: filePath, projectRoot });
  });

  ipcMain.handle(DOC_COMMENTS_IPC.ADD, async (_e: IpcMainInvokeEvent, payload: any) => {
    const filePath = reqStr(payload?.path);
    // Writing INTO a .docx/.xlsx (T11/T13) has not landed yet — refuse
    // honestly rather than silently writing a sidecar nobody reads back for
    // this file, or a no-op that looks like success.
    const refused = refuseNativeMutation(filePath);
    if (refused) return refused;
    return addComment({
      path: filePath,
      projectRoot: optStr(payload?.projectRoot),
      selector: payload?.selector as CommentSelector,
      text: reqStr(payload?.text),
      author: payload?.author as CommentAuthor,
    });
  });

  // reply/resolve/reopen/move ALL require `path`, containment-checked the
  // SAME way list/add's already is (review 3, F1) — the sidecar holding a
  // given comment id can only be found by knowing the file, and until this
  // fix none of these four carried one at all. Each also refuses first for a
  // .docx/.xlsx target, same reasoning as add above.
  ipcMain.handle(DOC_COMMENTS_IPC.REPLY, async (_e: IpcMainInvokeEvent, payload: any) => {
    const filePath = reqStr(payload?.path);
    const refused = refuseNativeMutation(filePath);
    if (refused) return refused;
    return replyToComment({
      path: filePath,
      projectRoot: optStr(payload?.projectRoot),
      id: reqStr(payload?.id),
      text: reqStr(payload?.text),
      author: payload?.author as CommentAuthor,
    });
  });

  ipcMain.handle(DOC_COMMENTS_IPC.RESOLVE, async (_e: IpcMainInvokeEvent, payload: any) => {
    const filePath = reqStr(payload?.path);
    const refused = refuseNativeMutation(filePath);
    if (refused) return refused;
    return resolveComment({
      path: filePath,
      projectRoot: optStr(payload?.projectRoot),
      id: reqStr(payload?.id),
      by: payload?.by as CommentAuthor,
    });
  });

  ipcMain.handle(DOC_COMMENTS_IPC.REOPEN, async (_e: IpcMainInvokeEvent, payload: any) => {
    const filePath = reqStr(payload?.path);
    const refused = refuseNativeMutation(filePath);
    if (refused) return refused;
    return reopenComment({
      path: filePath,
      projectRoot: optStr(payload?.projectRoot),
      id: reqStr(payload?.id),
      by: payload?.by as CommentAuthor,
    });
  });

  ipcMain.handle(DOC_COMMENTS_IPC.MOVE, async (_e: IpcMainInvokeEvent, payload: any) => {
    const filePath = reqStr(payload?.path);
    const refused = refuseNativeMutation(filePath);
    if (refused) return refused;
    return moveComment({
      path: filePath,
      projectRoot: optStr(payload?.projectRoot),
      id: reqStr(payload?.id),
      newSelector: payload?.newSelector as CommentSelector,
    });
  });

  // ── Watch/unwatch: chokidar relay, refcounted per webContents id ──
  // A crashed/closed renderer never sends unwatch — drop its refs on
  // destroy, same precedent as artifacts:watch-project/git:watch
  // (project-watcher.ts / git-watcher.ts).
  const watchedSenders = new Set<number>();
  ipcMain.handle(DOC_COMMENTS_IPC.WATCH, async (e: IpcMainInvokeEvent, payload: any) => {
    const target = await resolveWatchTarget({ path: reqStr(payload?.path), projectRoot: optStr(payload?.projectRoot) });
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
    const target = await resolveWatchTarget({ path: reqStr(payload?.path), projectRoot: optStr(payload?.projectRoot) });
    if (target.ok) unwatchComments(target.target, e.sender.id);
    return { ok: true };
  });
}
