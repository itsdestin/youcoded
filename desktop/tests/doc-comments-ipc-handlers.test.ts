// IPC surface of the doc-comments feature: every docComments:* channel reaches the store's containment check with the
// payload's `path` (refusing ../ and symlink escapes exactly as doc-comments-store.test.ts pins at the store API),
// refuses unknown project roots, dispatches by file format (docx/xlsx native writers vs the sidecar), broadcasts
// docComments:changed un-filtered, and wires watch/unwatch.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { wireDocCommentsPush } from '../src/main/doc-comments/ipc-handlers';
import { registerDesktopChannels } from '../src/main/ipc/channel-table';
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

/** WHY (2026-10-01 one-core R3-8): the docComments:* request channels are channel-table entries now, so this registers the table's entries (the
 *  document-comment ones are what the fake records) behind the SAME deps the old registration took: the change push, and the
 *  live-session folders the project-root gate counts as known. */
function registerDocCommentsHandlers(ipcMain: ReturnType<typeof fakeIpcMain>, deps: { getAllWebContents: () => any[]; sessionRoots: () => string[] }): void {
  wireDocCommentsPush(deps);
  const docOnly = { handle: (channel: string, fn: any) => { if (channel.startsWith('docComments:')) ipcMain.handle(channel, fn); }, on: () => {} };
  registerDesktopChannels(docOnly, () => null, () => {}, () => ({ sessionManager: {} as any, sendToWindows: () => {}, sendToPhones: () => {}, sessionRoots: deps.sessionRoots }));
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
  let ipcMain: ReturnType<typeof fakeIpcMain>;

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-doc-comments-ipc-'));
    const sent: any[] = [];
    deps = {
      sent,
      getAllWebContents: () => [{ isDestroyed: () => false, send: (channel: string, payload: any) => sent.push({ channel, payload }) }],
      // Every handler refuses an unrecognized projectRoot; `root` is a bare mkdtemp dir, so it counts as known via the
      // live-session-cwd carve-out, the way a real desktop window supplies it.
      sessionRoots: () => [root],
    };
    ipcMain = fakeIpcMain();
    registerDocCommentsHandlers(ipcMain, deps);
  });
  afterEach(async () => {
    __resetDocCommentsWatcherForTest();
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  const call = (channel: string, payload: any, e?: any) => ipcMain.call(channel, payload, e);
  const WORD_SELECTOR: CommentSelector = {
    kind: 'text',
    selector: { type: 'TextQuoteSelector', exact: 'Marketing emails go out', prefix: '', suffix: '', occurrence: 0 },
  };
  const SHEET_SELECTOR: CommentSelector = { kind: 'cell', selector: { type: 'CellSelector', cell: 'A1', sheet: 'Q3' } as CellSelector };
  async function copyFixture(fixture: string, rel: string) {
    await fs.promises.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.promises.copyFile(path.join(FIXTURES_DIR, fixture), path.join(root, rel));
  }
  /** A payload for each of the ten list/mutation channels against one path and root. */
  const tenCalls = (p: string, projectRoot: string): Array<[string, any]> => [
    [DOC_COMMENTS_IPC.LIST, { path: p, projectRoot }],
    [DOC_COMMENTS_IPC.ADD, { path: p, projectRoot, selector: CELL_SELECTOR, text: 'x', author: 'user' }],
    [DOC_COMMENTS_IPC.REPLY, { path: p, projectRoot, id: 'c-x', text: 'x', author: 'user' }],
    [DOC_COMMENTS_IPC.RESOLVE, { path: p, projectRoot, id: 'c-x', by: 'user' }],
    [DOC_COMMENTS_IPC.REOPEN, { path: p, projectRoot, id: 'c-x', by: 'user' }],
    [DOC_COMMENTS_IPC.MOVE, { path: p, projectRoot, id: 'c-x', newSelector: CELL_SELECTOR }],
    [DOC_COMMENTS_IPC.EDIT, { path: p, projectRoot, id: 'c-x', text: 'x' }],
    [DOC_COMMENTS_IPC.EDIT_REPLY, { path: p, projectRoot, id: 'c-x', replyId: 'c-x-r1', text: 'x' }],
    [DOC_COMMENTS_IPC.DELETE, { path: p, projectRoot, id: 'c-x' }],
    [DOC_COMMENTS_IPC.DELETE_REPLY, { path: p, projectRoot, id: 'c-x', replyId: 'c-x-r1' }],
  ];

  it('list/add succeed for an ordinary in-project path', async () => {
    const added = await call(DOC_COMMENTS_IPC.ADD, {
      path: 'docs/plan.md', projectRoot: root, selector: CELL_SELECTOR, text: 'hello', author: 'user',
    });
    expect(added).toEqual({ ok: true, id: expect.any(String) });
    const listed = await call(DOC_COMMENTS_IPC.LIST, { path: 'docs/plan.md', projectRoot: root });
    expect(listed.ok).toBe(true);
    expect(listed.comments).toHaveLength(1);
  });

  // Parity with Android's DocCommentsBridge.kt: a missing/malformed selector is refused before addComment (desktop once
  // cast it straight through and persisted a selector-less comment).
  it.each([
    ['entirely absent', undefined],
    ['without a recognized `kind`', { kind: 'bogus', selector: {} }],
    ['without its inner selector object', { kind: 'cell' }],
  ])('refuses a selector that is %s', async (_label, selector) => {
    const result = await call(DOC_COMMENTS_IPC.ADD, { path: 'docs/plan.md', projectRoot: root, selector, text: 'hello', author: 'user' });
    expect(result).toEqual({ ok: false, error: 'missing-field', field: 'selector' });
    const listed = await call(DOC_COMMENTS_IPC.LIST, { path: 'docs/plan.md', projectRoot: root });
    expect(listed.comments ?? []).toHaveLength(0);
  });

  it('still accepts a selector missing only INNER fields — Android defaults those, so desktop must not be stricter', async () => {
    const result = await call(DOC_COMMENTS_IPC.ADD, {
      path: 'docs/plan.md', projectRoot: root, selector: { kind: 'text', selector: {} }, text: 'hello', author: 'user',
    });
    expect(result.ok).toBe(true);
  });

  // The renderer mints the comment id and sends it on `add`; the handler must forward it, not mint its own.
  it('forwards a caller-supplied id straight through to the store', async () => {
    const callerId = 'c-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const added = await call(DOC_COMMENTS_IPC.ADD, {
      path: 'docs/plan.md', projectRoot: root, selector: CELL_SELECTOR, text: 'hello', author: 'user', id: callerId,
    });
    expect(added).toEqual({ ok: true, id: callerId });
    const listed = await call(DOC_COMMENTS_IPC.LIST, { path: 'docs/plan.md', projectRoot: root });
    expect(listed.comments[0].id).toBe(callerId);
  });

  // A .xlsx target's mutations are real writes. q3.xlsx has two sheets, so a write selector must name `sheet`; its legacy
  // Notes are never surfaced, so a real THREAD is added first to have something to reply/resolve/move.
  it('list on a .xlsx target reads the file’s own comments; add/reply/resolve/reopen/move all write for real', async () => {
    await copyFixture('q3-sales-by-rep.xlsx', 'reports/q3.xlsx');
    const listedBefore = await call(DOC_COMMENTS_IPC.LIST, { path: 'reports/q3.xlsx', projectRoot: root });
    expect(listedBefore.ok).toBe(true);
    expect(listedBefore.comments).toEqual([]);

    const added = await call(DOC_COMMENTS_IPC.ADD, {
      path: 'reports/q3.xlsx', projectRoot: root, selector: SHEET_SELECTOR, text: 'x', author: 'user',
    });
    expect(added).toEqual({ ok: true, id: expect.stringMatching(/^xt-/), text: 'x' });

    const listed = await call(DOC_COMMENTS_IPC.LIST, { path: 'reports/q3.xlsx', projectRoot: root });
    expect(listed.comments.length).toBeGreaterThan(0);
    const id = added.id;

    // reply returns the persisted CommentReply, like docx.
    const replied = await call(DOC_COMMENTS_IPC.REPLY, {
      path: 'reports/q3.xlsx', projectRoot: root, id, text: 'thanks', author: 'user',
    });
    expect(replied).toEqual({ ok: true, reply: { id: expect.stringMatching(/^xt-.*-r1$/), author: 'user', text: 'thanks', createdAt: expect.any(Number) } });

    expect(await call(DOC_COMMENTS_IPC.RESOLVE, { path: 'reports/q3.xlsx', projectRoot: root, id, by: 'user' })).toEqual({ ok: true });
    expect(await call(DOC_COMMENTS_IPC.REOPEN, { path: 'reports/q3.xlsx', projectRoot: root, id, by: 'user' })).toEqual({ ok: true });

    // move returns the FRESH, hint-accurate id (embedding the new cell), not a bare {ok:true}.
    const moved = await call(DOC_COMMENTS_IPC.MOVE, {
      path: 'reports/q3.xlsx', projectRoot: root, id,
      newSelector: { kind: 'cell', selector: { type: 'CellSelector', cell: 'C2', sheet: 'Q3' } },
    });
    expect(moved).toEqual({ ok: true, id: expect.stringMatching(/^xt-\d+-C2-/) });

    // An id this file doesn't have refuses honestly rather than guessing.
    const missing = await call(DOC_COMMENTS_IPC.REPLY, {
      path: 'reports/q3.xlsx', projectRoot: root, id: 'x-999-Z99', text: 'x', author: 'user',
    });
    expect(missing).toEqual({ ok: false, error: 'comment-not-found' });
  });

  it('list on a .docx target reads the file’s own comments; add/reply/resolve/reopen/move all write for real', async () => {
    await copyFixture('launch-brief.docx', 'docs/launch-brief.docx');
    const docx = 'docs/launch-brief.docx';
    const listed = await call(DOC_COMMENTS_IPC.LIST, { path: docx, projectRoot: root });
    expect(listed.ok).toBe(true);
    expect(listed.comments.length).toBeGreaterThan(0);

    const added = await call(DOC_COMMENTS_IPC.ADD, { path: docx, projectRoot: root, selector: WORD_SELECTOR, text: 'x', author: 'user' });
    expect(added).toEqual({ ok: true, id: expect.stringMatching(/^w-/), text: 'x' });

    // A docx reply's id depends on the file's state at write time, so assert its shape and ordinal, not a literal.
    const replied = await call(DOC_COMMENTS_IPC.REPLY, { path: docx, projectRoot: root, id: 'w-1', text: 'thanks', author: 'user' });
    expect(replied).toEqual({ ok: true, reply: expect.objectContaining({ text: 'thanks', author: 'user' }) });
    expect((replied as any).reply.id).toMatch(/^w-1-r\d+$/);

    expect(await call(DOC_COMMENTS_IPC.RESOLVE, { path: docx, projectRoot: root, id: 'w-1', by: 'user' })).toEqual({ ok: true });
    expect(await call(DOC_COMMENTS_IPC.REOPEN, { path: docx, projectRoot: root, id: 'w-1', by: 'user' })).toEqual({ ok: true });
    expect(await call(DOC_COMMENTS_IPC.MOVE, { path: docx, projectRoot: root, id: 'w-1', newSelector: WORD_SELECTOR })).toEqual({ ok: true });

    // A cell selector reaching a Word target is a caller bug: refused, not silently coerced.
    const badAdd = await call(DOC_COMMENTS_IPC.ADD, { path: docx, projectRoot: root, selector: CELL_SELECTOR, text: 'x', author: 'user' });
    expect(badAdd).toEqual({ ok: false, error: 'invalid-selector' });

    const missing = await call(DOC_COMMENTS_IPC.REPLY, { path: docx, projectRoot: root, id: 'w-999', text: 'x', author: 'user' });
    expect(missing).toEqual({ ok: false, error: 'comment-not-found' });
  });

  // WHY: the format decision once ran on the caller's own path string, so a `.txt` symlink to a real `.docx` was
  // treated as plain text and its comment landed in the inert JSON sidecar. It must use the resolved realpath.
  it('a .txt symlink pointing at a real .docx is dispatched as the Word document it actually is, not the sidecar', async () => {
    await copyFixture('launch-brief.docx', 'docs/launch-brief.docx');
    try {
      await fs.promises.symlink(path.join(root, 'docs', 'launch-brief.docx'), path.join(root, 'docs', 'notes.txt'));
    } catch {
      return; // no symlink rights on this platform — skip, same precedent as doc-comments-store.test.ts
    }
    const added = await call(DOC_COMMENTS_IPC.ADD, {
      path: 'docs/notes.txt', projectRoot: root, selector: WORD_SELECTOR, text: 'via disguised symlink', author: 'user',
    });
    // A docx-shaped id (w-N) proves the NATIVE writer ran (the sidecar would mint c-<uuid>).
    expect(added).toEqual({ ok: true, id: expect.stringMatching(/^w-/), text: 'via disguised symlink' });
    const listedViaRealName = await call(DOC_COMMENTS_IPC.LIST, { path: 'docs/launch-brief.docx', projectRoot: root });
    expect(listedViaRealName.comments.some((c: any) => c.text === 'via disguised symlink')).toBe(true);
    await expect(fs.promises.access(path.join(root, '.youcoded', 'comments', 'docs', 'notes.txt.json'))).rejects.toThrow();
  });

  it('refuses a ../../etc/passwd-shaped path on EVERY one of the ten channels', async () => {
    for (const [channel, payload] of tenCalls('../../../../../../etc/passwd', root)) {
      expect(await call(channel, payload), `${channel} did not refuse the traversal`).toEqual({ ok: false, error: 'path-outside-project' });
    }
  });

  it('refuses a symlink-outside-the-project path on all eight id-based mutations', async () => {
    const secret = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-doc-comments-secret-'));
    const secretFile = path.join(secret, 'x.md');
    await fs.promises.writeFile(secretFile, 'do not comment on me');
    try {
      await fs.promises.symlink(secretFile, path.join(root, 'escape.md'));
    } catch {
      return; // no symlink rights on this platform — skip, same precedent as doc-comments-store.test.ts
    }
    try {
      for (const [channel, payload] of tenCalls('escape.md', root).slice(2)) {  // LIST and ADD excluded
        expect(await call(channel, payload), `${channel} did not refuse the symlink escape`).toEqual({ ok: false, error: 'path-outside-project' });
      }
    } finally {
      await fs.promises.rm(secret, { recursive: true, force: true });
    }
  });

  it('reply/resolve/reopen/move succeed against a comment never list()-ed in THIS process (review 3, F1)', async () => {
    // Seeded straight into the real store (no warm list() cache), then driven through the IPC surface.
    const added = await addComment({ path: 'docs/cold.md', projectRoot: root, selector: CELL_SELECTOR, text: 'seed', author: 'user' });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const args = { path: 'docs/cold.md', projectRoot: root, id: added.id };
    await expect(call(DOC_COMMENTS_IPC.REPLY, { ...args, text: 'hi', author: 'assistant' })).resolves.toEqual({
      ok: true, reply: expect.objectContaining({ text: 'hi', author: 'assistant' }),
    });
    await expect(call(DOC_COMMENTS_IPC.RESOLVE, { ...args, by: 'assistant' })).resolves.toEqual({ ok: true });
    await expect(call(DOC_COMMENTS_IPC.REOPEN, { ...args, by: 'user' })).resolves.toEqual({ ok: true });
    await expect(call(DOC_COMMENTS_IPC.MOVE, { ...args, newSelector: CELL_SELECTOR })).resolves.toEqual({ ok: true });
    await expect(call(DOC_COMMENTS_IPC.EDIT, { ...args, text: 'edited cold' })).resolves.toEqual({ ok: true });
    const relisted = await call(DOC_COMMENTS_IPC.LIST, { path: 'docs/cold.md', projectRoot: root });
    const replyId = relisted.comments[0].replies[0].id;
    await expect(call(DOC_COMMENTS_IPC.EDIT_REPLY, { path: 'docs/cold.md', projectRoot: root, id: added.id, replyId, text: 'edited reply cold' }))
      .resolves.toEqual({ ok: true, reply: expect.objectContaining({ text: 'edited reply cold' }) });
    await expect(call(DOC_COMMENTS_IPC.DELETE_REPLY, { path: 'docs/cold.md', projectRoot: root, id: added.id, replyId })).resolves.toEqual({ ok: true });
    await expect(call(DOC_COMMENTS_IPC.DELETE, { path: 'docs/cold.md', projectRoot: root, id: added.id })).resolves.toEqual({ ok: true });
  });

  // The same format dispatch (native docx/xlsx vs the plain sidecar), for the four edit/delete channels on all three target shapes.
  describe('docComments:edit / :edit-reply / :delete / :delete-reply — format dispatch', () => {
    it('a plain markdown target round-trips edit/edit-reply/delete-reply/delete through the sidecar', async () => {
      const added = await call(DOC_COMMENTS_IPC.ADD, {
        path: 'docs/plan.md', projectRoot: root, selector: CELL_SELECTOR, text: 'original', author: 'user',
      });
      expect(added.ok).toBe(true);
      const replied = await call(DOC_COMMENTS_IPC.REPLY, { path: 'docs/plan.md', projectRoot: root, id: added.id, text: 'a reply', author: 'user' });
      const replyId = replied.reply.id;

      await expect(call(DOC_COMMENTS_IPC.EDIT, { path: 'docs/plan.md', projectRoot: root, id: added.id, text: 'rewritten' }))
        .resolves.toEqual({ ok: true });
      await expect(call(DOC_COMMENTS_IPC.EDIT_REPLY, { path: 'docs/plan.md', projectRoot: root, id: added.id, replyId, text: 'reply rewritten' }))
        .resolves.toEqual({ ok: true, reply: expect.objectContaining({ text: 'reply rewritten' }) });
      const afterEdit = await call(DOC_COMMENTS_IPC.LIST, { path: 'docs/plan.md', projectRoot: root });
      expect(afterEdit.comments[0]).toMatchObject({ text: 'rewritten' });
      expect(afterEdit.comments[0].replies[0]).toMatchObject({ text: 'reply rewritten' });

      await expect(call(DOC_COMMENTS_IPC.DELETE_REPLY, { path: 'docs/plan.md', projectRoot: root, id: added.id, replyId })).resolves.toEqual({ ok: true });
      await expect(call(DOC_COMMENTS_IPC.DELETE, { path: 'docs/plan.md', projectRoot: root, id: added.id })).resolves.toEqual({ ok: true });
      const afterDelete = await call(DOC_COMMENTS_IPC.LIST, { path: 'docs/plan.md', projectRoot: root });
      expect(afterDelete.comments).toEqual([]);
    });

    it('a .docx target dispatches edit/delete to the real Word writer, not the sidecar', async () => {
      await copyFixture('launch-brief.docx', 'docs/launch-brief.docx');

      const edited = await call(DOC_COMMENTS_IPC.EDIT, { path: 'docs/launch-brief.docx', projectRoot: root, id: 'w-1', text: 'edited via IPC' });
      expect(edited).toEqual({ ok: true, text: 'edited via IPC' });
      const listed = await call(DOC_COMMENTS_IPC.LIST, { path: 'docs/launch-brief.docx', projectRoot: root });
      expect(listed.comments.find((c: any) => c.id === 'w-1')?.text).toBe('edited via IPC');
      const replyId = listed.comments.find((c: any) => c.id === 'w-1')?.replies[0]?.id;

      await expect(call(DOC_COMMENTS_IPC.EDIT_REPLY, { path: 'docs/launch-brief.docx', projectRoot: root, id: 'w-1', replyId, text: 'reply via IPC' }))
        .resolves.toEqual({ ok: true, reply: expect.objectContaining({ text: 'reply via IPC' }) });
      await expect(call(DOC_COMMENTS_IPC.DELETE, { path: 'docs/launch-brief.docx', projectRoot: root, id: 'w-1' })).resolves.toEqual({ ok: true });
      const afterDelete = await call(DOC_COMMENTS_IPC.LIST, { path: 'docs/launch-brief.docx', projectRoot: root });
      expect(afterDelete.comments.some((c: any) => c.id === 'w-1')).toBe(false);

      // No inert JSON sidecar was ever created for this native-format target.
      const sidecarPath = path.join(root, '.youcoded', 'comments', 'docs', 'launch-brief.docx.json');
      await expect(fs.promises.access(sidecarPath)).rejects.toThrow();
    });

    it('a .xlsx target dispatches edit/delete to the real Excel writer, not the sidecar', async () => {
      await copyFixture('q3-sales-by-rep.xlsx', 'reports/q3.xlsx');
      const added = await call(DOC_COMMENTS_IPC.ADD, { path: 'reports/q3.xlsx', projectRoot: root, selector: SHEET_SELECTOR, text: 'x', author: 'user' });
      expect(added.ok).toBe(true);
      const id = added.id;

      const edited = await call(DOC_COMMENTS_IPC.EDIT, { path: 'reports/q3.xlsx', projectRoot: root, id, text: 'edited via IPC' });
      expect(edited).toEqual({ ok: true, text: 'edited via IPC' });

      await expect(call(DOC_COMMENTS_IPC.DELETE, { path: 'reports/q3.xlsx', projectRoot: root, id })).resolves.toEqual({ ok: true });
      const afterDelete = await call(DOC_COMMENTS_IPC.LIST, { path: 'reports/q3.xlsx', projectRoot: root });
      expect(afterDelete.comments.some((c: any) => c.id === id)).toBe(false);

      const sidecarPath = path.join(root, '.youcoded', 'comments', 'reports', 'q3.xlsx.json');
      await expect(fs.promises.access(sidecarPath)).rejects.toThrow();
    });

    it('an id this file does not have refuses honestly, on both channels and every format', async () => {
      await copyFixture('launch-brief.docx', 'docs/launch-brief.docx');
      await expect(call(DOC_COMMENTS_IPC.EDIT, { path: 'docs/launch-brief.docx', projectRoot: root, id: 'w-999', text: 'x' }))
        .resolves.toEqual({ ok: false, error: 'comment-not-found' });
      await expect(call(DOC_COMMENTS_IPC.DELETE, { path: 'docs/launch-brief.docx', projectRoot: root, id: 'w-999' }))
        .resolves.toEqual({ ok: false, error: 'comment-not-found' });
    });
  });

  it('a caller that omits path gets a distinct missing-field refusal, never a throw or a coerced "undefined" string (F2)', async () => {
    // WHY: reqStr once coerced a missing field via String(undefined), so the store resolved the literal path "undefined".
    await expect(call(DOC_COMMENTS_IPC.REPLY, { projectRoot: root, id: 'c-x', text: 'x', author: 'user' }))
      .resolves.toEqual({ ok: false, error: 'missing-field', field: 'path' });
  });

  it('a caller that supplies path but omits id gets a missing-field refusal for id (F2)', async () => {
    await expect(call(DOC_COMMENTS_IPC.RESOLVE, { path: 'docs/plan.md', projectRoot: root, by: 'user' }))
      .resolves.toEqual({ ok: false, error: 'missing-field', field: 'id' });
  });

  describe('projectRoot gate', () => {
    // WHY: the store's containment check only proves `path` is inside WHATEVER root it is given, so a forged root went unnoticed.
    it('refuses "/" as projectRoot on every one of the ten mutation/list channels', async () => {
      for (const [channel, payload] of tenCalls('docs/plan.md', '/')) {
        expect(await call(channel, payload), `${channel} did not refuse projectRoot: '/'`).toEqual({ ok: false, error: 'unknown-project-root' });
      }
    });

    it('refuses a temp directory that was never registered as a project (not "/", still unknown)', async () => {
      const forged = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-doc-comments-ipc-forged-'));
      try {
        const result = await call(DOC_COMMENTS_IPC.ADD, {
          path: 'docs/plan.md', projectRoot: forged, selector: CELL_SELECTOR, text: 'x', author: 'user',
        });
        expect(result).toEqual({ ok: false, error: 'unknown-project-root' });
      } finally {
        await fs.promises.rm(forged, { recursive: true, force: true });
      }
    });

    it('refuses watch/unwatch for an unknown projectRoot too', async () => {
      await expect(call(DOC_COMMENTS_IPC.WATCH, { path: 'docs/plan.md', projectRoot: '/' }))
        .resolves.toEqual({ ok: false, error: 'unknown-project-root' });
      await expect(call(DOC_COMMENTS_IPC.UNWATCH, { path: 'docs/plan.md', projectRoot: '/' }))
        .resolves.toEqual({ ok: false, error: 'unknown-project-root' });
    });
  });

  // WHY: docComments:watch once skipped the authorizeBytesRead gate every other no-projectRoot entry point runs, so a
  // caller could start a live watch on an arbitrary absolute .docx/.xlsx path.
  describe('fallback (no projectRoot) source-file gate', () => {
    it('refuses to watch an untracked absolute .docx path with no projectRoot', async () => {
      const untrackedDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-doc-comments-ipc-untracked-'));
      try {
        const loose = path.join(untrackedDir, 'untracked.docx');
        await fs.promises.copyFile(path.join(FIXTURES_DIR, 'launch-brief.docx'), loose);
        // No projectRoot, so the unknown-root gate never runs; the source-file gate must refuse.
        await expect(call(DOC_COMMENTS_IPC.WATCH, { path: loose })).resolves.toEqual({ ok: false, error: 'path-not-tracked' });
      } finally {
        await fs.promises.rm(untrackedDir, { recursive: true, force: true });
      }
    });

    it('the identical untracked path with a real projectRoot is unaffected by the source-file gate (judged by ordinary containment instead)', async () => {
      await copyFixture('launch-brief.docx', 'docs/launch-brief.docx');
      await expect(call(DOC_COMMENTS_IPC.WATCH, { path: 'docs/launch-brief.docx', projectRoot: root }))
        .resolves.toEqual({ ok: true });
    });
  });

  it('broadcasts docComments:changed to every webContents, un-filtered', async () => {
    // Deliberately NO pre-created .youcoded/comments/: the very-first-comment case watchComments() pre-creates it for.
    const watched = await call(DOC_COMMENTS_IPC.WATCH, { path: 'docs/live.md', projectRoot: root });
    expect(watched.ok).toBe(true);
    // Retried: the first write also creates .youcoded/comments/, which chokidar may still be arming (macOS first-write gap).
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
    // The push carries projectRoot so a renderer watching two projects with a shared relative path can tell them apart.
    expect(evt.payload).toEqual({ path: 'docs/live.md', projectRoot: root });
  });

  it('unwatch stops the push and drops the ref on renderer destroy', async () => {
    const e = fakeEvent(7);
    await call(DOC_COMMENTS_IPC.WATCH, { path: 'docs/gone.md', projectRoot: root }, e);
    e.__fireDestroyed(); // a crashed renderer never sends unwatch
    deps.sent.length = 0;
    await addComment({ path: 'docs/gone.md', projectRoot: root, selector: CELL_SELECTOR, text: 'x', author: 'user' });
    // settle (negative assertion): no change push may reach the destroyed renderer.
    await new Promise((r) => setTimeout(r, 1200));
    expect(deps.sent.some((s) => s.channel === DOC_COMMENTS_IPC.CHANGED)).toBe(false);
  });
});
