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

  // Code review 2026-09-27, Android F1 (cross-platform parity gap):
  // Android's DocCommentsBridge.kt already refuses a missing/malformed
  // `selector` on docComments:add with `{ok:false, error:"missing-field",
  // field:"selector"}` before ever calling addComment — desktop's IPC
  // handler used to cast `payload?.selector as CommentSelector` straight
  // through with no check at all, silently persisting a comment with no
  // selector. This pins that desktop now refuses the SAME shapes, the same
  // way, on the same channel.
  describe('a missing or malformed selector is refused (Android parity)', () => {
    it('refuses when selector is entirely absent', async () => {
      const ipcMain = fakeIpcMain();
      registerDocCommentsHandlers(ipcMain as any, deps);
      const result = await ipcMain.call(DOC_COMMENTS_IPC.ADD, {
        path: 'docs/plan.md', projectRoot: root, text: 'hello', author: 'user',
      });
      expect(result).toEqual({ ok: false, error: 'missing-field', field: 'selector' });
      const listed = await ipcMain.call(DOC_COMMENTS_IPC.LIST, { path: 'docs/plan.md', projectRoot: root });
      expect(listed.comments ?? []).toHaveLength(0);
    });

    it('refuses when selector has no recognized `kind`', async () => {
      const ipcMain = fakeIpcMain();
      registerDocCommentsHandlers(ipcMain as any, deps);
      const result = await ipcMain.call(DOC_COMMENTS_IPC.ADD, {
        path: 'docs/plan.md', projectRoot: root, selector: { kind: 'bogus', selector: {} }, text: 'hello', author: 'user',
      });
      expect(result).toEqual({ ok: false, error: 'missing-field', field: 'selector' });
    });

    it('refuses when selector.selector (the inner object) is missing', async () => {
      const ipcMain = fakeIpcMain();
      registerDocCommentsHandlers(ipcMain as any, deps);
      const result = await ipcMain.call(DOC_COMMENTS_IPC.ADD, {
        path: 'docs/plan.md', projectRoot: root, selector: { kind: 'cell' }, text: 'hello', author: 'user',
      });
      expect(result).toEqual({ ok: false, error: 'missing-field', field: 'selector' });
    });

    it('still accepts a selector missing only INNER fields — Android defaults those, never refuses', async () => {
      const ipcMain = fakeIpcMain();
      registerDocCommentsHandlers(ipcMain as any, deps);
      // No `exact`/`prefix`/`suffix`/`occurrence` — Android's
      // TextQuoteSelector.fromJson defaults every one of these rather than
      // refusing, so desktop must not be STRICTER than Android here.
      const result = await ipcMain.call(DOC_COMMENTS_IPC.ADD, {
        path: 'docs/plan.md', projectRoot: root, selector: { kind: 'text', selector: {} }, text: 'hello', author: 'user',
      });
      expect(result.ok).toBe(true);
    });
  });

  // F4 (T5 implementation review): the renderer mints the comment id and
  // sends it on the `add` payload — this IPC handler forwards it through to
  // the store rather than always minting its own.
  it('forwards a caller-supplied id straight through to the store (F4, T5 review)', async () => {
    const ipcMain = fakeIpcMain();
    registerDocCommentsHandlers(ipcMain as any, deps);
    const callerId = 'c-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const added = await ipcMain.call(DOC_COMMENTS_IPC.ADD, {
      path: 'docs/plan.md', projectRoot: root, selector: CELL_SELECTOR, text: 'hello', author: 'user', id: callerId,
    });
    expect(added).toEqual({ ok: true, id: callerId });
    const listed = await ipcMain.call(DOC_COMMENTS_IPC.LIST, { path: 'docs/plan.md', projectRoot: root });
    expect(listed.comments[0].id).toBe(callerId);
  });

  // T13 (redesigned 2026-09-27, threaded-comments-only, §4): a .xlsx target's
  // mutations are REAL now — same wiring T11 already proved for .docx,
  // exercised here through the IPC surface. q3.xlsx has two sheets (Q3, By
  // rep), so a write-side selector must name `sheet` (§4.2). The fixture's
  // own genuine legacy Notes are never surfaced any more (§4.1) — a real
  // THREAD is added first so there is something real to reply/resolve/move.
  it('list on a .xlsx target reads the file’s own comments; add/reply/resolve/reopen/move all write for real', async () => {
    await fs.promises.mkdir(path.join(root, 'reports'), { recursive: true });
    await fs.promises.copyFile(path.join(FIXTURES_DIR, 'q3-sales-by-rep.xlsx'), path.join(root, 'reports', 'q3.xlsx'));
    const ipcMain = fakeIpcMain();
    registerDocCommentsHandlers(ipcMain as any, deps);
    const listedBefore = await ipcMain.call(DOC_COMMENTS_IPC.LIST, { path: 'reports/q3.xlsx', projectRoot: root });
    expect(listedBefore.ok).toBe(true);
    expect(listedBefore.comments).toEqual([]);

    const cellSelector: CommentSelector = { kind: 'cell', selector: { type: 'CellSelector', cell: 'A1', sheet: 'Q3' } as CellSelector };
    const added = await ipcMain.call(DOC_COMMENTS_IPC.ADD, {
      path: 'reports/q3.xlsx', projectRoot: root, selector: cellSelector, text: 'x', author: 'user',
    });
    expect(added).toEqual({ ok: true, id: expect.stringMatching(/^xt-/), text: 'x' });

    const listed = await ipcMain.call(DOC_COMMENTS_IPC.LIST, { path: 'reports/q3.xlsx', projectRoot: root });
    expect(listed.comments.length).toBeGreaterThan(0);
    const id = added.id;

    // Review leftover (a): reply is now enriched with the persisted
    // CommentReply, mirroring docx's own already-enriched reply response.
    const replied = await ipcMain.call(DOC_COMMENTS_IPC.REPLY, {
      path: 'reports/q3.xlsx', projectRoot: root, id, text: 'thanks', author: 'user',
    });
    expect(replied).toEqual({ ok: true, reply: { id: expect.stringMatching(/^xt-.*-r1$/), author: 'user', text: 'thanks', createdAt: expect.any(Number) } });

    const resolved = await ipcMain.call(DOC_COMMENTS_IPC.RESOLVE, {
      path: 'reports/q3.xlsx', projectRoot: root, id, by: 'user',
    });
    expect(resolved).toEqual({ ok: true });

    const reopened = await ipcMain.call(DOC_COMMENTS_IPC.REOPEN, {
      path: 'reports/q3.xlsx', projectRoot: root, id, by: 'user',
    });
    expect(reopened).toEqual({ ok: true });

    // Review F3 (Medium) partial fix: move now returns the FRESH,
    // hint-accurate id (embedding the new cell) rather than a bare {ok:true}.
    const moved = await ipcMain.call(DOC_COMMENTS_IPC.MOVE, {
      path: 'reports/q3.xlsx', projectRoot: root, id,
      newSelector: { kind: 'cell', selector: { type: 'CellSelector', cell: 'C2', sheet: 'Q3' } },
    });
    expect(moved).toEqual({ ok: true, id: expect.stringMatching(/^xt-\d+-C2-/) });

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
    expect(added).toEqual({ ok: true, id: expect.stringMatching(/^w-/), text: 'x' });

    const replied = await ipcMain.call(DOC_COMMENTS_IPC.REPLY, {
      path: 'docs/launch-brief.docx', projectRoot: root, id: 'w-1', text: 'thanks', author: 'user',
    });
    // T5 review (design §1.6, F2): `reply`'s response is enriched to carry the
    // real persisted `CommentReply` — a docx reply's id depends on the file's
    // own current state at write time (§1.6's own reasoning), so it can't be
    // asserted as a literal here; just prove the shape and the ordinal.
    expect(replied).toEqual({ ok: true, reply: expect.objectContaining({ text: 'thanks', author: 'user' }) });
    expect((replied as any).reply.id).toMatch(/^w-1-r\d+$/);

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

  // Review finding #5 (docs/active/reviews/2026-09-27-doc-comments-t9ab-
  // review.md): the format decision used to run on the caller's OWN path
  // string (nativeFormatFor(filePath)) before it was ever resolved, so a
  // `.txt`-named symlink pointing at a real `.docx` extension-matched as
  // plain text and its comment silently landed in the inert JSON sidecar
  // instead of the real document. Fixed by deciding format from
  // `resolveNativeFormat` (the SAME realpath `resolveSourceFilePath` already
  // computes for containment) — this pins that a project-RELATIVE symlinked
  // path (the common shape for an assistant/renderer call, since `projectRoot`
  // is known here) now dispatches to the real document.
  it('a .txt symlink pointing at a real .docx is dispatched as the Word document it actually is, not the sidecar', async () => {
    await fs.promises.mkdir(path.join(root, 'docs'), { recursive: true });
    const realDocx = path.join(root, 'docs', 'launch-brief.docx');
    await fs.promises.copyFile(path.join(FIXTURES_DIR, 'launch-brief.docx'), realDocx);
    const link = path.join(root, 'docs', 'notes.txt');
    try {
      await fs.promises.symlink(realDocx, link);
    } catch {
      return; // no symlink rights on this platform — skip, same precedent as doc-comments-store.test.ts
    }
    const ipcMain = fakeIpcMain();
    registerDocCommentsHandlers(ipcMain as any, deps);
    const textSelector: CommentSelector = {
      kind: 'text',
      selector: { type: 'TextQuoteSelector', exact: 'Marketing emails go out', prefix: '', suffix: '', occurrence: 0 },
    };
    const added = await ipcMain.call(DOC_COMMENTS_IPC.ADD, {
      path: 'docs/notes.txt', projectRoot: root, selector: textSelector, text: 'via disguised symlink', author: 'user',
    });
    // A docx-shaped id (w-N) proves this dispatched to the NATIVE writer, not
    // the sidecar store (which would have minted a c-<uuid> instead).
    expect(added).toEqual({ ok: true, id: expect.stringMatching(/^w-/), text: 'via disguised symlink' });

    // The comment actually landed in the REAL document...
    const listedViaRealName = await ipcMain.call(DOC_COMMENTS_IPC.LIST, { path: 'docs/launch-brief.docx', projectRoot: root });
    expect(listedViaRealName.ok).toBe(true);
    expect(listedViaRealName.comments.some((c: any) => c.text === 'via disguised symlink')).toBe(true);

    // ...and no inert JSON sidecar was ever created for the disguised name —
    // the exact silent mis-routing this finding warned about.
    const sidecarPath = path.join(root, '.youcoded', 'comments', 'docs', 'notes.txt.json');
    await expect(fs.promises.access(sidecarPath)).rejects.toThrow();
  });

  it('refuses a ../../etc/passwd-shaped path on EVERY one of the ten channels', async () => {
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
      // Edit/delete build (2026-09-28, design doc §"Edit and delete") — the
      // same containment check every other id-carrying mutation already has.
      [DOC_COMMENTS_IPC.EDIT, { path: evil, projectRoot: root, id: 'c-x', text: 'x' }],
      [DOC_COMMENTS_IPC.EDIT_REPLY, { path: evil, projectRoot: root, id: 'c-x', replyId: 'c-x-r1', text: 'x' }],
      [DOC_COMMENTS_IPC.DELETE, { path: evil, projectRoot: root, id: 'c-x' }],
      [DOC_COMMENTS_IPC.DELETE_REPLY, { path: evil, projectRoot: root, id: 'c-x', replyId: 'c-x-r1' }],
    ];
    for (const [channel, payload] of calls) {
      const result = await ipcMain.call(channel, payload);
      expect(result, `${channel} did not refuse ${evil}`).toEqual({ ok: false, error: 'path-outside-project' });
    }
  });

  it('refuses a symlink-outside-the-project path on all eight id-based mutations (review 3, F1)', async () => {
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
        [DOC_COMMENTS_IPC.EDIT, { path: 'escape.md', projectRoot: root, id: 'c-x', text: 'x' }],
        [DOC_COMMENTS_IPC.EDIT_REPLY, { path: 'escape.md', projectRoot: root, id: 'c-x', replyId: 'c-x-r1', text: 'x' }],
        [DOC_COMMENTS_IPC.DELETE, { path: 'escape.md', projectRoot: root, id: 'c-x' }],
        [DOC_COMMENTS_IPC.DELETE_REPLY, { path: 'escape.md', projectRoot: root, id: 'c-x', replyId: 'c-x-r1' }],
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
    // T5 review (design §1.6, F2): the plain-sidecar `reply` path is enriched
    // too, uniformly with docx/xlsx (§1.6's table entry is general).
    await expect(ipcMain.call(DOC_COMMENTS_IPC.REPLY, { ...args, text: 'hi', author: 'assistant' })).resolves.toEqual({
      ok: true, reply: expect.objectContaining({ text: 'hi', author: 'assistant' }),
    });
    await expect(ipcMain.call(DOC_COMMENTS_IPC.RESOLVE, { ...args, by: 'assistant' })).resolves.toEqual({ ok: true });
    await expect(ipcMain.call(DOC_COMMENTS_IPC.REOPEN, { ...args, by: 'user' })).resolves.toEqual({ ok: true });
    await expect(ipcMain.call(DOC_COMMENTS_IPC.MOVE, { ...args, newSelector: CELL_SELECTOR })).resolves.toEqual({ ok: true });
    // Edit/delete build (2026-09-28): same cold-process guarantee.
    await expect(ipcMain.call(DOC_COMMENTS_IPC.EDIT, { ...args, text: 'edited cold' })).resolves.toEqual({ ok: true });
    const relisted = await ipcMain.call(DOC_COMMENTS_IPC.LIST, { path: 'docs/cold.md', projectRoot: root });
    const replyId = relisted.comments[0].replies[0].id;
    await expect(ipcMain.call(DOC_COMMENTS_IPC.EDIT_REPLY, { path: 'docs/cold.md', projectRoot: root, id: added.id, replyId, text: 'edited reply cold' }))
      .resolves.toEqual({ ok: true, reply: expect.objectContaining({ text: 'edited reply cold' }) });
    await expect(ipcMain.call(DOC_COMMENTS_IPC.DELETE_REPLY, { path: 'docs/cold.md', projectRoot: root, id: added.id, replyId })).resolves.toEqual({ ok: true });
    await expect(ipcMain.call(DOC_COMMENTS_IPC.DELETE, { path: 'docs/cold.md', projectRoot: root, id: added.id })).resolves.toEqual({ ok: true });
  });

  // Edit/delete build (2026-09-28, design doc §"Edit and delete"): the SAME
  // format dispatch (resolveNativeFormat -> native docx/xlsx vs. the plain
  // sidecar) every other mutation above already proved, exercised here for
  // the four new channels on all three target shapes.
  describe('docComments:edit / :edit-reply / :delete / :delete-reply — format dispatch', () => {
    it('a plain markdown target round-trips edit/edit-reply/delete-reply/delete through the sidecar', async () => {
      const ipcMain = fakeIpcMain();
      registerDocCommentsHandlers(ipcMain as any, deps);
      const added = await ipcMain.call(DOC_COMMENTS_IPC.ADD, {
        path: 'docs/plan.md', projectRoot: root, selector: CELL_SELECTOR, text: 'original', author: 'user',
      });
      expect(added.ok).toBe(true);
      const replied = await ipcMain.call(DOC_COMMENTS_IPC.REPLY, { path: 'docs/plan.md', projectRoot: root, id: added.id, text: 'a reply', author: 'user' });
      const replyId = replied.reply.id;

      await expect(ipcMain.call(DOC_COMMENTS_IPC.EDIT, { path: 'docs/plan.md', projectRoot: root, id: added.id, text: 'rewritten' }))
        .resolves.toEqual({ ok: true });
      await expect(ipcMain.call(DOC_COMMENTS_IPC.EDIT_REPLY, { path: 'docs/plan.md', projectRoot: root, id: added.id, replyId, text: 'reply rewritten' }))
        .resolves.toEqual({ ok: true, reply: expect.objectContaining({ text: 'reply rewritten' }) });
      const afterEdit = await ipcMain.call(DOC_COMMENTS_IPC.LIST, { path: 'docs/plan.md', projectRoot: root });
      expect(afterEdit.comments[0]).toMatchObject({ text: 'rewritten' });
      expect(afterEdit.comments[0].replies[0]).toMatchObject({ text: 'reply rewritten' });

      await expect(ipcMain.call(DOC_COMMENTS_IPC.DELETE_REPLY, { path: 'docs/plan.md', projectRoot: root, id: added.id, replyId })).resolves.toEqual({ ok: true });
      await expect(ipcMain.call(DOC_COMMENTS_IPC.DELETE, { path: 'docs/plan.md', projectRoot: root, id: added.id })).resolves.toEqual({ ok: true });
      const afterDelete = await ipcMain.call(DOC_COMMENTS_IPC.LIST, { path: 'docs/plan.md', projectRoot: root });
      expect(afterDelete.comments).toEqual([]);
    });

    it('a .docx target dispatches edit/delete to the real Word writer, not the sidecar', async () => {
      await fs.promises.mkdir(path.join(root, 'docs'), { recursive: true });
      await fs.promises.copyFile(path.join(FIXTURES_DIR, 'launch-brief.docx'), path.join(root, 'docs', 'launch-brief.docx'));
      const ipcMain = fakeIpcMain();
      registerDocCommentsHandlers(ipcMain as any, deps);

      const edited = await ipcMain.call(DOC_COMMENTS_IPC.EDIT, { path: 'docs/launch-brief.docx', projectRoot: root, id: 'w-1', text: 'edited via IPC' });
      expect(edited).toEqual({ ok: true, text: 'edited via IPC' });
      const listed = await ipcMain.call(DOC_COMMENTS_IPC.LIST, { path: 'docs/launch-brief.docx', projectRoot: root });
      expect(listed.comments.find((c: any) => c.id === 'w-1')?.text).toBe('edited via IPC');
      const replyId = listed.comments.find((c: any) => c.id === 'w-1')?.replies[0]?.id;

      await expect(ipcMain.call(DOC_COMMENTS_IPC.EDIT_REPLY, { path: 'docs/launch-brief.docx', projectRoot: root, id: 'w-1', replyId, text: 'reply via IPC' }))
        .resolves.toEqual({ ok: true, reply: expect.objectContaining({ text: 'reply via IPC' }) });
      await expect(ipcMain.call(DOC_COMMENTS_IPC.DELETE, { path: 'docs/launch-brief.docx', projectRoot: root, id: 'w-1' })).resolves.toEqual({ ok: true });
      const afterDelete = await ipcMain.call(DOC_COMMENTS_IPC.LIST, { path: 'docs/launch-brief.docx', projectRoot: root });
      expect(afterDelete.comments.some((c: any) => c.id === 'w-1')).toBe(false);

      // No inert JSON sidecar was ever created for this native-format target.
      const sidecarPath = path.join(root, '.youcoded', 'comments', 'docs', 'launch-brief.docx.json');
      await expect(fs.promises.access(sidecarPath)).rejects.toThrow();
    });

    it('a .xlsx target dispatches edit/delete to the real Excel writer, not the sidecar', async () => {
      await fs.promises.mkdir(path.join(root, 'reports'), { recursive: true });
      await fs.promises.copyFile(path.join(FIXTURES_DIR, 'q3-sales-by-rep.xlsx'), path.join(root, 'reports', 'q3.xlsx'));
      const ipcMain = fakeIpcMain();
      registerDocCommentsHandlers(ipcMain as any, deps);
      const cellSelector: CommentSelector = { kind: 'cell', selector: { type: 'CellSelector', cell: 'A1', sheet: 'Q3' } as CellSelector };
      const added = await ipcMain.call(DOC_COMMENTS_IPC.ADD, { path: 'reports/q3.xlsx', projectRoot: root, selector: cellSelector, text: 'x', author: 'user' });
      expect(added.ok).toBe(true);
      const id = added.id;

      const edited = await ipcMain.call(DOC_COMMENTS_IPC.EDIT, { path: 'reports/q3.xlsx', projectRoot: root, id, text: 'edited via IPC' });
      expect(edited).toEqual({ ok: true, text: 'edited via IPC' });

      await expect(ipcMain.call(DOC_COMMENTS_IPC.DELETE, { path: 'reports/q3.xlsx', projectRoot: root, id })).resolves.toEqual({ ok: true });
      const afterDelete = await ipcMain.call(DOC_COMMENTS_IPC.LIST, { path: 'reports/q3.xlsx', projectRoot: root });
      expect(afterDelete.comments.some((c: any) => c.id === id)).toBe(false);

      const sidecarPath = path.join(root, '.youcoded', 'comments', 'reports', 'q3.xlsx.json');
      await expect(fs.promises.access(sidecarPath)).rejects.toThrow();
    });

    it('an id this file does not have refuses honestly, on both channels and every format', async () => {
      await fs.promises.mkdir(path.join(root, 'docs'), { recursive: true });
      await fs.promises.copyFile(path.join(FIXTURES_DIR, 'launch-brief.docx'), path.join(root, 'docs', 'launch-brief.docx'));
      const ipcMain = fakeIpcMain();
      registerDocCommentsHandlers(ipcMain as any, deps);
      await expect(ipcMain.call(DOC_COMMENTS_IPC.EDIT, { path: 'docs/launch-brief.docx', projectRoot: root, id: 'w-999', text: 'x' }))
        .resolves.toEqual({ ok: false, error: 'comment-not-found' });
      await expect(ipcMain.call(DOC_COMMENTS_IPC.DELETE, { path: 'docs/launch-brief.docx', projectRoot: root, id: 'w-999' }))
        .resolves.toEqual({ ok: false, error: 'comment-not-found' });
    });
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
    it('refuses "/" as projectRoot on every one of the ten mutation/list channels', async () => {
      const ipcMain = fakeIpcMain();
      registerDocCommentsHandlers(ipcMain as any, deps);
      const calls: Array<[string, any]> = [
        [DOC_COMMENTS_IPC.LIST, { path: 'docs/plan.md', projectRoot: '/' }],
        [DOC_COMMENTS_IPC.ADD, { path: 'docs/plan.md', projectRoot: '/', selector: CELL_SELECTOR, text: 'x', author: 'user' }],
        [DOC_COMMENTS_IPC.REPLY, { path: 'docs/plan.md', projectRoot: '/', id: 'c-x', text: 'x', author: 'user' }],
        [DOC_COMMENTS_IPC.RESOLVE, { path: 'docs/plan.md', projectRoot: '/', id: 'c-x', by: 'user' }],
        [DOC_COMMENTS_IPC.REOPEN, { path: 'docs/plan.md', projectRoot: '/', id: 'c-x', by: 'user' }],
        [DOC_COMMENTS_IPC.MOVE, { path: 'docs/plan.md', projectRoot: '/', id: 'c-x', newSelector: CELL_SELECTOR }],
        [DOC_COMMENTS_IPC.EDIT, { path: 'docs/plan.md', projectRoot: '/', id: 'c-x', text: 'x' }],
        [DOC_COMMENTS_IPC.EDIT_REPLY, { path: 'docs/plan.md', projectRoot: '/', id: 'c-x', replyId: 'c-x-r1', text: 'x' }],
        [DOC_COMMENTS_IPC.DELETE, { path: 'docs/plan.md', projectRoot: '/', id: 'c-x' }],
        [DOC_COMMENTS_IPC.DELETE_REPLY, { path: 'docs/plan.md', projectRoot: '/', id: 'c-x', replyId: 'c-x-r1' }],
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

  // Live-refresh review (2026-09-27, finding 1 — high): every OTHER
  // native-format entry point with no `projectRoot` (list/add/reply/resolve/
  // reopen/move) already ran the resolved absolute path through
  // `authorizeBytesRead`, refusing `path-not-tracked` for anything that isn't
  // a saved folder, an indexed project, or a tracked external artifact
  // (doc-comments-dispatch.test.ts's own "fallback (no projectRoot)
  // source-file gate" tests) — `docComments:watch` skipped this gate
  // entirely, letting a caller start a live filesystem watch on an arbitrary
  // absolute `.docx`/`.xlsx` path. Mirrors doc-comments-remote-relay.test.ts's
  // identically-named block for the WS surface.
  describe('fallback (no projectRoot) source-file gate (F1 blocker, Gate 2)', () => {
    it('refuses to watch an untracked absolute .docx path with no projectRoot', async () => {
      const untrackedDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-doc-comments-ipc-untracked-'));
      try {
        const loose = path.join(untrackedDir, 'untracked.docx');
        await fs.promises.copyFile(path.join(FIXTURES_DIR, 'launch-brief.docx'), loose);
        const ipcMain = fakeIpcMain();
        registerDocCommentsHandlers(ipcMain as any, deps);
        // No projectRoot in the payload at all — the fallback path — so
        // Gate 1 (refuseUnknownProjectRoot) never even runs; Gate 2
        // (authorizeBytesRead) is what must refuse this.
        await expect(ipcMain.call(DOC_COMMENTS_IPC.WATCH, { path: loose }))
          .resolves.toEqual({ ok: false, error: 'path-not-tracked' });
      } finally {
        await fs.promises.rm(untrackedDir, { recursive: true, force: true });
      }
    });

    it('the identical untracked path with a real projectRoot is unaffected by Gate 2 (judged by ordinary containment instead)', async () => {
      await fs.promises.mkdir(path.join(root, 'docs'), { recursive: true });
      await fs.promises.copyFile(path.join(FIXTURES_DIR, 'launch-brief.docx'), path.join(root, 'docs', 'launch-brief.docx'));
      const ipcMain = fakeIpcMain();
      registerDocCommentsHandlers(ipcMain as any, deps);
      await expect(ipcMain.call(DOC_COMMENTS_IPC.WATCH, { path: 'docs/launch-brief.docx', projectRoot: root }))
        .resolves.toEqual({ ok: true });
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
    // F3 (T5 review): the push now carries `projectRoot` too, so a renderer
    // watching two projects that share a relative path can tell them apart.
    expect(evt.payload).toEqual({ path: 'docs/live.md', projectRoot: root });
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
