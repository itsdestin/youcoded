// docComments:changed — the PUSH half of the document-comments surface (T3, design
// docs/active/specs/2026-09-26-doc-comments-build-design.md §1.5, §1.6).
//
// WHY (2026-10-01 one-core R3-8): the twelve request channels (list, add, reply, resolve, ...) are channel-table
// entries now (main/ipc/doc-comments.ts), served to the computer's windows and to a phone by one body each. What
// stays here is the one thing that is not a request: the watcher's change report, fanned out to every window and
// every phone. `deps` is deliberately a couple of plain functions (not the `webContents` module or a RemoteServer),
// so tests/doc-comments-ipc-handlers.test.ts can drive it without standing up registerIpcHandlers.
import { initDocCommentsWatcher } from './doc-comments-watcher';
import { DOC_COMMENTS_IPC } from './ipc-channels';

export interface DocCommentsPushDeps {
  /** Fan `docComments:changed` out to every window (pages:changed's own pattern — §1.5 "Broadcast scope": un-filtered,
   *  a window not showing that path ignores it cheaply). */
  getAllWebContents: () => Array<{ isDestroyed(): boolean; send(channel: string, ...args: unknown[]): void }>;
  /** A WS-connected remote browser gets the same push (review 2, F6) — absent in tests/a build with no remote server. */
  remoteBroadcast?: (msg: { type: string; payload: unknown }) => void;
}

export function wireDocCommentsPush(deps: DocCommentsPushDeps): void {
  initDocCommentsWatcher((sourcePath, projectRoot) => {
    // F3 fix (T5 review): `projectRoot` rides along so a renderer watching two projects that share a relative path (both
    // have a `README.md`) re-lists the RIGHT one — see doc-comments-store.ts's (renderer) `keyFor`.
    const payload = { path: sourcePath, projectRoot };
    for (const wc of deps.getAllWebContents()) {
      if (!wc.isDestroyed()) wc.send(DOC_COMMENTS_IPC.CHANGED, payload);
    }
    deps.remoteBroadcast?.({ type: DOC_COMMENTS_IPC.CHANGED, payload });
  });
}
