// Pins T3's IPC-surface plumbing (docs/active/specs/2026-09-26-doc-comments-
// build-design.md §1.6, review 3 F1): registerDocCommentsHandlers wires
// docComments:list/add/reply/resolve/reopen/move so EVERY ONE of them —
// not just list/add — reaches the store's own containment check with the
// payload's `path` field, refusing a `../../etc/passwd`-shaped path and a
// symlink-outside-the-project path exactly the same way at the IPC surface
// as doc-comments-store.test.ts already pins at the store's own API. Also
// pins the docComments:changed broadcast (un-filtered — design §1.5
// "Broadcast scope") and the watch/unwatch wiring.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerDocCommentsHandlers } from '../src/main/doc-comments/ipc-handlers';
import { DOC_COMMENTS_IPC } from '../src/main/doc-comments/ipc-channels';
import { addComment } from '../src/main/doc-comments/doc-comments-store';
import { __resetDocCommentsWatcherForTest } from '../src/main/doc-comments/doc-comments-watcher';
import type { CellSelector, CommentSelector } from '../src/shared/doc-comments-types';

const CELL_SELECTOR: CommentSelector = { kind: 'cell', selector: { type: 'CellSelector', cell: 'A1' } as CellSelector };
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'doc-comments');

/** A minimal ipcMain fake that captures each handler by channel name, the
 *  same shape ipc-handlers.test.ts's own mockIpcMain uses. */
function fakeIpcMain() {
  const handlers = new Map<string, (e: any, payload: any) => Promise<any>>();
  return {
    handle: (channel: string, fn: any) => { handlers.set(channel, fn); },
    call: (channel: string, payload: any, e: any = fakeEvent()) => handlers.get(channel)!(e, payload),
  };
}

function fakeEvent(senderId = 1) {
  const listeners = new Map<string, () => void>();
  return {
    sender: {
      id: senderId,
      once: (evt: string, cb: () => void) => listeners.set(evt, cb),
    },
    __fireDestroyed: () => listeners.get('destroyed')?.(),
  };
}

describe('registerDocCommentsHandlers', () => {
  let root: string;
  let deps: { getAllWebContents: () => any[]; sent: any[]; sessionRoots: () => string[] };

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-doc-comments-ipc-'));
    const sent: any[] = [];
    deps = {
      sent,
      getAllWebContents: () => [{ isDestroyed: () => false, send: (channel: string, payload: any) => sent.push({ channel, payload }) }],
      // F1 fix (post-T3 build review, blocker): every handler now refuses an
      // unrecognized projectRoot before touching the store — `root` here is a
      // bare mkdtemp() dir, never a saved folder or indexed project, so every
      // EXISTING test in this file needs it to count as a "known" root via the
      // live-session-cwd carve-out (design §1.4's useActiveProject.ts
      // precedent), exactly the way a real desktop window would supply it.
      sessionRoots: () => [root],
    };
  });
  afterEach(async () => {
    __resetDocCommentsWatcherForTest();
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  it('list/add succeed for an ordinary in-project path', async () => {
    const ipcMain = fakeIpcMain();
    registerDocCommentsHandlers(ipcMain as any, deps);
    const added = await ipcMain.call(DOC_COMMENTS_IPC.ADD, {
      path: 'docs/plan.md', projectRoot: root, selector: CELL_SELECTOR, text: 'hello', author: 'user',
    });
    expect(added).toEqual({ ok: true, id: expect.any(String) });
    const listed = await ipcMain.call(DOC_COMMENTS_IPC.LIST, { path: 'docs/plan.md', projectRoot: root });
    expect(listed.ok).toBe(true);
    expect(listed.comments).toHaveLength(1);
  });

  // T13: a .xlsx target's mutations are REAL now — same wiring T11 already
  // proved for .docx, exercised here through the IPC surface. q3.xlsx has two
  // sheets (Q3, By rep), so a write-side selector must name `sheet` (§4.2).
  it('list on a .xlsx target reads the file’s own comments; add/reply/resolve/reopen/move all write for real', async () => {
    await fs.promises.mkdir(path.join(root, 'reports'), { recursive: true });
    await fs.promises.copyFile(path.join(FIXTURES_DIR, 'q3-sales-by-rep.xlsx'), path.join(root, 'reports', 'q3.xlsx'));
    const ipcMain = fakeIpcMain();
    registerDocCommentsHandlers(ipcMain as any, deps);
    const listed = await ipcMain.call(DOC_COMMENTS_IPC.LIST, { path: 'reports/q3.xlsx', projectRoot: root });
    expect(listed.ok).toBe(true);
    expect(listed.comments.length).toBeGreaterThan(0);

    const cellSelector: CommentSelector = { kind: 'cell', selector: { type: 'CellSelector', cell: 'A1', sheet: 'Q3' } as CellSelector };
    const added = await ipcMain.call(DOC_COMMENTS_IPC.ADD, {
      path: 'reports/q3.xlsx', projectRoot: root, selector: cellSelector, text: 'x', author: 'user',
    });
    expect(added).toEqual({ ok: true, id: expect.stringMatching(/^x-/) });

    const q3Note = listed.comments.find((c: any) => c.selector.kind === 'cell' && c.selector.selector.cell === 'B2');
    const id = q3Note.id;

    const replied = await ipcMain.call(DOC_COMMENTS_IPC.REPLY, {
      path: 'reports/q3.xlsx', projectRoot: root, id, text: 'thanks', author: 'user',
    });
    expect(replied).toEqual({ ok: true });

    const resolved = await ipcMain.call(DOC_COMMENTS_IPC.RESOLVE, {
      path: 'reports/q3.xlsx', projectRoot: root, id, by: 'user',
    });
    expect(resolved).toEqual({ ok: true });

    const reopened = await ipcMain.call(DOC_COMMENTS_IPC.REOPEN, {
      path: 'reports/q3.xlsx', projectRoot: root, id, by: 'user',
    });
    expect(reopened).toEqual({ ok: true });

    const moved = await ipcMain.call(DOC_COMMENTS_IPC.MOVE, {
      path: 'reports/q3.xlsx', projectRoot: root, id,
      newSelector: { kind: 'cell', selector: { type: 'CellSelector', cell: 'C2', sheet: 'Q3' } },
    });
    expect(moved).toEqual({ ok: true });

    // An id this file doesn't have refuses honestly rather than guessing.
    const missing = await ipcMain.call(DOC_COMMENTS_IPC.REPLY, {
      path: 'reports/q3.xlsx', projectRoot: root, id: 'x-999-Z99', text: 'x', author: 'user',
    });
    expect(missing).toEqual({ ok: false, error: 'comment-not-found' });
  });

  it('list on a .docx target reads the file’s own comments; add/reply/resolve/reopen/move all write for real', async () => {
    await fs.promises.mkdir(path.join(root, 'docs'), { recursive: true });
    await fs.promises.copyFile(path.join(FIXTURES_DIR, 'launch-brief.docx'), path.join(root, 'docs', 'launch-brief.docx'));
    const ipcMain = fakeIpcMain();
    registerDocCommentsHandlers(ipcMain as any, deps);
    const listed = await ipcMain.call(DOC_COMMENTS_IPC.LIST, { path: 'docs/launch-brief.docx', projectRoot: root });
    expect(listed.ok).toBe(true);
    expect(listed.comments.length).toBeGreaterThan(0);

    const textSelector: CommentSelector = {
      kind: 'text',
      selector: { type: 'TextQuoteSelector', exact: 'Marketing emails go out', prefix: '', suffix: '', occurrence: 0 },
    };
    const added = await ipcMain.call(DOC_COMMENTS_IPC.ADD, {
      path: 'docs/launch-brief.docx', projectRoot: root, selector: textSelector, text: 'x', author: 'user',
    });
    expect(added).toEqual({ ok: true, id: expect.stringMatching(/^w-/) });

    const replied = await ipcMain.call(DOC_COMMENTS_IPC.REPLY, {
      path: 'docs/launch-brief.docx', projectRoot: root, id: 'w-1', text: 'thanks', author: 'user',
    });
    expect(replied).toEqual({ ok: true });

    const resolved = await ipcMain.call(DOC_COMMENTS_IPC.RESOLVE, {
      path: 'docs/launch-brief.docx', projectRoot: root, id: 'w-1', by: 'user',
    });
    expect(resolved).toEqual({ ok: true });

    const reopened = await ipcMain.call(DOC_COMMENTS_IPC.REOPEN, {
      path: 'docs/launch-brief.docx', projectRoot: root, id: 'w-1', by: 'user',
    });
    expect(reopened).toEqual({ ok: true });

    const moved = await ipcMain.call(DOC_COMMENTS_IPC.MOVE, {
      path: 'docs/launch-brief.docx', projectRoot: root, id: 'w-1', newSelector: textSelector,
    });
    expect(moved).toEqual({ ok: true });

    // A cell selector reaching a Word target is a caller bug, not a
    // format-not-yet-built refusal — refused honestly, not silently coerced.
    const badAdd = await ipcMain.call(DOC_COMMENTS_IPC.ADD, {
      path: 'docs/launch-brief.docx', projectRoot: root, selector: CELL_SELECTOR, text: 'x', author: 'user',
    });
    expect(badAdd).toEqual({ ok: false, error: 'invalid-selector' });

    // An id this file doesn't have refuses honestly rather than guessing.
    const missing = await ipcMain.call(DOC_COMMENTS_IPC.REPLY, {
      path: 'docs/launch-brief.docx', projectRoot: root, id: 'w-999', text: 'x', author: 'user',
    });
    expect(missing).toEqual({ ok: false, error: 'comment-not-found' });
  });

  it('refuses a ../../etc/passwd-shaped path on EVERY one of the six channels', async () => {
    const ipcMain = fakeIpcMain();
    registerDocCommentsHandlers(ipcMain as any, deps);
    const evil = '../../../../../../etc/passwd';
    const calls: Array<[string, any]> = [
      [DOC_COMMENTS_IPC.LIST, { path: evil, projectRoot: root }],
      [DOC_COMMENTS_IPC.ADD, { path: evil, projectRoot: root, selector: CELL_SELECTOR, text: 'x', author: 'user' }],
      [DOC_COMMENTS_IPC.REPLY, { path: evil, projectRoot: root, id: 'c-x', text: 'x', author: 'user' }],
      [DOC_COMMENTS_IPC.RESOLVE, { path: evil, projectRoot: root, id: 'c-x', by: 'user' }],
      [DOC_COMMENTS_IPC.REOPEN, { path: evil, projectRoot: root, id: 'c-x', by: 'user' }],
      [DOC_COMMENTS_IPC.MOVE, { path: evil, projectRoot: root, id: 'c-x', newSelector: CELL_SELECTOR }],
    ];
    for (const [channel, payload] of calls) {
      const result = await ipcMain.call(channel, payload);
      expect(result, `${channel} did not refuse ${evil}`).toEqual({ ok: false, error: 'path-outside-project' });
    }
  });

  it('refuses a symlink-outside-the-project path on all four id-based mutations (review 3, F1)', async () => {
    const secret = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-doc-comments-secret-'));
    const secretFile = path.join(secret, 'x.md');
    await fs.promises.writeFile(secretFile, 'do not comment on me');
    const link = path.join(root, 'escape.md');
    try {
      await fs.promises.symlink(secretFile, link);
    } catch {
      return; // no symlink rights on this platform — skip, same precedent as doc-comments-store.test.ts
    }
    try {
      const ipcMain = fakeIpcMain();
      registerDocCommentsHandlers(ipcMain as any, deps);
      const calls: Array<[string, any]> = [
        [DOC_COMMENTS_IPC.REPLY, { path: 'escape.md', projectRoot: root, id: 'c-x', text: 'x', author: 'user' }],
        [DOC_COMMENTS_IPC.RESOLVE, { path: 'escape.md', projectRoot: root, id: 'c-x', by: 'user' }],
        [DOC_COMMENTS_IPC.REOPEN, { path: 'escape.md', projectRoot: root, id: 'c-x', by: 'user' }],
        [DOC_COMMENTS_IPC.MOVE, { path: 'escape.md', projectRoot: root, id: 'c-x', newSelector: CELL_SELECTOR }],
      ];
      for (const [channel, payload] of calls) {
        const result = await ipcMain.call(channel, payload);
        expect(result, `${channel} did not refuse the symlink escape`).toEqual({ ok: false, error: 'path-outside-project' });
      }
    } finally {
      await fs.promises.rm(secret, { recursive: true, force: true });
    }
  });

  it('reply/resolve/reopen/move succeed against a comment never list()-ed in THIS process (review 3, F1)', async () => {
    // A fresh call to the real store (not through this test's ipcMain) —
    // mirrors doc-comments-store.test.ts's own "no warm list() cache" case,
    // exercised here at the IPC surface instead of the store's bare API.
    const added = await addComment({ path: 'docs/cold.md', projectRoot: root, selector: CELL_SELECTOR, text: 'seed', author: 'user' });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const ipcMain = fakeIpcMain();
    registerDocCommentsHandlers(ipcMain as any, deps);
    const args = { path: 'docs/cold.md', projectRoot: root, id: added.id };
    await expect(ipcMain.call(DOC_COMMENTS_IPC.REPLY, { ...args, text: 'hi', author: 'assistant' })).resolves.toEqual({ ok: true });
    await expect(ipcMain.call(DOC_COMMENTS_IPC.RESOLVE, { ...args, by: 'assistant' })).resolves.toEqual({ ok: true });
    await expect(ipcMain.call(DOC_COMMENTS_IPC.REOPEN, { ...args, by: 'user' })).resolves.toEqual({ ok: true });
    await expect(ipcMain.call(DOC_COMMENTS_IPC.MOVE, { ...args, newSelector: CELL_SELECTOR })).resolves.toEqual({ ok: true });
  });

  it('a caller that omits path gets a distinct missing-field refusal, never a throw or a coerced "undefined" string (F2)', async () => {
    // F2 fix (optional, post-T3 build review): `reqStr` used to coerce a
    // missing field via `String(undefined)` — the literal text "undefined" —
    // which the store then resolved as if it were a real (if nonsensical)
    // path. It now refuses honestly before ever reaching the store.
    const ipcMain = fakeIpcMain();
    registerDocCommentsHandlers(ipcMain as any, deps);
    await expect(ipcMain.call(DOC_COMMENTS_IPC.REPLY, { projectRoot: root, id: 'c-x', text: 'x', author: 'user' }))
      .resolves.toEqual({ ok: false, error: 'missing-field', field: 'path' });
  });

  it('a caller that supplies path but omits id gets a missing-field refusal for id (F2)', async () => {
    const ipcMain = fakeIpcMain();
    registerDocCommentsHandlers(ipcMain as any, deps);
    await expect(ipcMain.call(DOC_COMMENTS_IPC.RESOLVE, { path: 'docs/plan.md', projectRoot: root, by: 'user' }))
      .resolves.toEqual({ ok: false, error: 'missing-field', field: 'id' });
  });

  describe('projectRoot gate (post-T3 build review, F1 — blocker)', () => {
    // RED-BEFORE-GREEN: against the pre-fix commit (58ee463df) every case in
    // this block resolves ok:true (or a store-level error unrelated to the
    // root) instead of refusing — the store's own containment check only
    // proves `path` resolves inside WHATEVER root it is given, so it never
    // caught a forged root at all.
    it('refuses "/" as projectRoot on every one of the six mutation/list channels', async () => {
      const ipcMain = fakeIpcMain();
      registerDocCommentsHandlers(ipcMain as any, deps);
      const calls: Array<[string, any]> = [
        [DOC_COMMENTS_IPC.LIST, { path: 'docs/plan.md', projectRoot: '/' }],
        [DOC_COMMENTS_IPC.ADD, { path: 'docs/plan.md', projectRoot: '/', selector: CELL_SELECTOR, text: 'x', author: 'user' }],
        [DOC_COMMENTS_IPC.REPLY, { path: 'docs/plan.md', projectRoot: '/', id: 'c-x', text: 'x', author: 'user' }],
        [DOC_COMMENTS_IPC.RESOLVE, { path: 'docs/plan.md', projectRoot: '/', id: 'c-x', by: 'user' }],
        [DOC_COMMENTS_IPC.REOPEN, { path: 'docs/plan.md', projectRoot: '/', id: 'c-x', by: 'user' }],
        [DOC_COMMENTS_IPC.MOVE, { path: 'docs/plan.md', projectRoot: '/', id: 'c-x', newSelector: CELL_SELECTOR }],
      ];
      for (const [channel, payload] of calls) {
        const result = await ipcMain.call(channel, payload);
        expect(result, `${channel} did not refuse projectRoot: '/'`).toEqual({ ok: false, error: 'unknown-project-root' });
      }
    });

    it('refuses a temp directory that was never registered as a project (not "/", still unknown)', async () => {
      const forged = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-doc-comments-ipc-forged-'));
      try {
        const ipcMain = fakeIpcMain();
        registerDocCommentsHandlers(ipcMain as any, deps);
        const result = await ipcMain.call(DOC_COMMENTS_IPC.ADD, {
          path: 'docs/plan.md', projectRoot: forged, selector: CELL_SELECTOR, text: 'x', author: 'user',
        });
        expect(result).toEqual({ ok: false, error: 'unknown-project-root' });
      } finally {
        await fs.promises.rm(forged, { recursive: true, force: true });
      }
    });

    it('refuses watch/unwatch for an unknown projectRoot too', async () => {
      const ipcMain = fakeIpcMain();
      registerDocCommentsHandlers(ipcMain as any, deps);
      await expect(ipcMain.call(DOC_COMMENTS_IPC.WATCH, { path: 'docs/plan.md', projectRoot: '/' }))
        .resolves.toEqual({ ok: false, error: 'unknown-project-root' });
      await expect(ipcMain.call(DOC_COMMENTS_IPC.UNWATCH, { path: 'docs/plan.md', projectRoot: '/' }))
        .resolves.toEqual({ ok: false, error: 'unknown-project-root' });
    });

    it('a legitimate projectRoot (this suite’s own live-session-cwd temp dir) keeps working — the gate only refuses UNKNOWN roots', async () => {
      const ipcMain = fakeIpcMain();
      registerDocCommentsHandlers(ipcMain as any, deps);
      const added = await ipcMain.call(DOC_COMMENTS_IPC.ADD, {
        path: 'docs/plan.md', projectRoot: root, selector: CELL_SELECTOR, text: 'legit', author: 'user',
      });
      expect(added).toEqual({ ok: true, id: expect.any(String) });
    });
  });

  it('broadcasts docComments:changed to every webContents, un-filtered', async () => {
    const ipcMain = fakeIpcMain();
    registerDocCommentsHandlers(ipcMain as any, deps);
    // Deliberately NO pre-created .youcoded/comments/ directory: this is the
    // very-first-comment-on-a-fresh-project case doc-comments-watcher.ts's
    // watchComments() pre-creates the directory for BEFORE starting chokidar
    // specifically so it is caught (see its own WHY comment).
    const watched = await ipcMain.call(DOC_COMMENTS_IPC.WATCH, { path: 'docs/live.md', projectRoot: root });
    expect(watched.ok).toBe(true);
    // Retried, not a single write: the FIRST write also creates
    // .youcoded/comments/ itself, which chokidar may still be arming a watch
    // for (project-watcher.test.ts's own documented macOS/first-write gap) —
    // a retry loop is the same discipline that file's untilLive() uses.
    const deadline = Date.now() + 12_500;
    let sawChange = false;
    for (let attempt = 0; Date.now() < deadline && !sawChange; attempt++) {
      await addComment({ path: 'docs/live.md', projectRoot: root, selector: CELL_SELECTOR, text: `x${attempt}`, author: 'user' });
      const attemptDeadline = Date.now() + 2500;
      while (Date.now() < attemptDeadline) {
        if (deps.sent.some((s) => s.channel === DOC_COMMENTS_IPC.CHANGED)) { sawChange = true; break; }
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    expect(sawChange).toBe(true);
    const evt = deps.sent.find((s) => s.channel === DOC_COMMENTS_IPC.CHANGED);
    expect(evt.payload).toEqual({ path: 'docs/live.md' });
  });

  it('unwatch stops the push and drops the ref on renderer destroy', async () => {
    const ipcMain = fakeIpcMain();
    registerDocCommentsHandlers(ipcMain as any, deps);
    const e = fakeEvent(7);
    await ipcMain.call(DOC_COMMENTS_IPC.WATCH, { path: 'docs/gone.md', projectRoot: root }, e);
    e.__fireDestroyed(); // a crashed renderer never sends unwatch
    deps.sent.length = 0;
    await addComment({ path: 'docs/gone.md', projectRoot: root, selector: CELL_SELECTOR, text: 'x', author: 'user' });
    await new Promise((r) => setTimeout(r, 1200));
    expect(deps.sent.some((s) => s.channel === DOC_COMMENTS_IPC.CHANGED)).toBe(false);
  });
});
