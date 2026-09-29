import { EventEmitter } from 'node:events';
import { copyFile, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// WHY mocked: office-commands imports the project watcher (chokidar and the artifact store);
// these tests only drive the IPC layer in front of it.
vi.mock('../../src/main/artifacts/project-watcher', () => ({ noteOwnWrite: vi.fn() }));

import { registerOfficeIpc } from '../../src/main/office/office-ipc';
import { createSessions } from '../../src/main/office/office-sessions';

const MEMO = fileURLToPath(new URL('./fixtures/memo.docx', import.meta.url));

type Handler = (event: unknown, ...args: unknown[]) => unknown;

/** Records what registerOfficeIpc hands ipcMain, so a test can call a channel directly. */
function fakeIpcMain() {
  const handlers = new Map<string, Handler>();
  const removed: string[] = [];
  return {
    handlers,
    removed,
    handle: (ch: string, fn: Handler) => {
      if (handlers.has(ch)) throw new Error(`Attempted to register a second handler for '${ch}'`);
      handlers.set(ch, fn);
    },
    removeHandler: (ch: string) => {
      removed.push(ch);
      handlers.delete(ch);
    },
  };
}

/** A window: an id and the destroyed event, as Electron's WebContents has them. */
function fakeSender(id: number) {
  return Object.assign(new EventEmitter(), { id });
}

let dir: string;
let sessions: ReturnType<typeof createSessions>;
let ipc: ReturnType<typeof fakeIpcMain>;
let registry: ReturnType<typeof createSessions> | null;
let available: boolean;
const win1 = fakeSender(1);
const win2 = fakeSender(2);

const call = (ch: string, sender: ReturnType<typeof fakeSender>, ...args: unknown[]) =>
  Promise.resolve(ipc.handlers.get(ch)!({ sender }, ...args));

beforeEach(async () => {
  // WHY realpath: on some systems the temp folder is itself behind a link (macOS /var), and
  // the session path is expected to be the real one.
  dir = await realpath(await mkdtemp(path.join(tmpdir(), 'office-ipc-test-')));
  sessions = createSessions(path.join(dir, 'base'));
  registry = sessions;
  available = true;
  ipc = fakeIpcMain();
  registerOfficeIpc(ipc, { getSessions: () => registry, available: async () => available, root: path.join(dir, 'addon'), userData: path.join(dir, 'userData') });
});
afterEach(async () => {
  win1.removeAllListeners();
  win2.removeAllListeners();
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

async function aDocx(name = 'memo.docx'): Promise<string> {
  const file = path.join(dir, name);
  await copyFile(MEMO, file);
  return file;
}

describe('office IPC channels', () => {
  it('registers all nine channels, clearing each one first so a reload can register again', () => {
    const all = ['office:status', 'office:create', 'office:pick', 'office:open', 'office:invoke', 'office:close', 'office:versions', 'office:restore', 'office:save-copy'];
    // office:lost-saves is desktop only (not in the four-surface list) but cleared the same way.
    expect([...ipc.handlers.keys()].sort()).toEqual([...all, 'office:lost-saves'].sort());
    expect([...ipc.removed].sort()).toEqual([...all, 'office:lost-saves'].sort());
    expect(() => registerOfficeIpc(ipc, { getSessions: () => registry, available: async () => true, root: dir, userData: dir })).not.toThrow();
  });

  it('says a file that no longer exists cannot be opened', async () => {
    await expect(call('office:open', win1, path.join(dir, 'gone.docx'))).resolves.toEqual({ ok: false, message: 'This file no longer exists.' });
  });

  it('refuses a kind of file Office cannot open yet', async () => {
    const odt = path.join(dir, 'notes.odt');
    await writeFile(odt, 'not really a document');
    await expect(call('office:open', win1, odt)).resolves.toEqual({ ok: false, message: "Office can't open this kind of file yet." });
  });

  it('opens a document on its own office origin, named by an unguessable token', async () => {
    const r = await call('office:open', win1, await aDocx());
    expect(r).toMatchObject({ ok: true });
    const { token, origin } = r as { token: string; origin: string };
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(origin).toBe(`office://${token}`);
    expect(sessions.get(token)?.senderId).toBe(1);
  });

  it('refuses an editor request from a window that did not open the document', async () => {
    const { token } = (await call('office:open', win1, await aDocx())) as { token: string };
    await expect(call('office:invoke', win2, token, 'get_current_path', {})).rejects.toThrow('refused');
    // ...while the window that opened it is answered, by the real command set.
    await expect(call('office:invoke', win1, token, 'get_current_path', {})).resolves.toBe('memo.docx');
  });

  it('refuses a command the editor bridge is not allowed to ask for', async () => {
    const { token } = (await call('office:open', win1, await aDocx())) as { token: string };
    await expect(call('office:invoke', win1, token, 'read_any_file', { path: '/etc/passwd' })).rejects.toThrow('refused');
  });

  it('refuses an editor request whose token or command is not text', async () => {
    const { token } = (await call('office:open', win1, await aDocx())) as { token: string };
    await expect(call('office:invoke', win1, { token }, 'get_current_path', {})).rejects.toThrow('refused');
    await expect(call('office:invoke', win1, token, ['get_current_path'], {})).rejects.toThrow('refused');
  });

  it('closing a document ends its session', async () => {
    const { token } = (await call('office:open', win1, await aDocx())) as { token: string };
    await call('office:close', win1, token);
    expect(sessions.get(token)).toBeUndefined();
    await expect(call('office:invoke', win1, token, 'get_current_path', {})).rejects.toThrow('refused');
  });

  it('keeps a document open until every place in the window that opened it has closed it', async () => {
    const file = await aDocx();
    const tab = (await call('office:open', win1, file)) as { token: string };
    const panel = (await call('office:open', win1, file)) as { token: string };
    expect(panel.token).toBe(tab.token);
    await call('office:close', win1, tab.token);
    expect(sessions.get(tab.token)).toBeDefined();
    await expect(call('office:invoke', win1, tab.token, 'get_current_path', {})).resolves.toBe('memo.docx');
    await call('office:close', win1, panel.token);
    expect(sessions.get(tab.token)).toBeUndefined();
  });

  it('closes a document opened twice when its window goes away, whatever the count', async () => {
    const file = await aDocx();
    const { token } = (await call('office:open', win1, file)) as { token: string };
    await call('office:open', win1, file);
    win1.emit('destroyed');
    await vi.waitFor(() => expect(sessions.get(token)).toBeUndefined());
    // A fresh open after that starts from a count of one again.
    const again = (await call('office:open', win1, file)) as { token: string };
    await call('office:close', win1, again.token);
    expect(sessions.get(again.token)).toBeUndefined();
  });

  it('does not leave a session behind for a window that closed while it was being opened', async () => {
    const file = await aDocx();
    const gone = Object.assign(fakeSender(3), { isDestroyed: () => true });
    await expect(call('office:open', gone, file)).resolves.toMatchObject({ ok: false });
    await vi.waitFor(() => expect(sessions.byPath(file)).toBeUndefined());
  });

  it("a stray extra close only affects that window's own document", async () => {
    const a = (await call('office:open', win1, await aDocx('a.docx'))) as { token: string };
    const b = (await call('office:open', win1, await aDocx('b.docx'))) as { token: string };
    const other = (await call('office:open', win2, await aDocx('c.docx'))) as { token: string };
    await call('office:close', win1, a.token);
    await call('office:close', win1, a.token); // stray: already closed
    const again = (await call('office:open', win1, path.join(dir, 'a.docx'))) as { token: string };
    await call('office:close', win1, a.token); // stray, with the file open again under a new token
    expect(sessions.get(again.token)).toBeDefined();
    expect(sessions.get(b.token)).toBeDefined();
    expect(sessions.get(other.token)).toBeDefined();
  });

  it('does not let another window close a document it did not open', async () => {
    const { token } = (await call('office:open', win1, await aDocx())) as { token: string };
    await call('office:close', win2, token);
    expect(sessions.get(token)).toBeDefined();
  });

  it('closes every document of a window when that window goes away', async () => {
    const a = (await call('office:open', win1, await aDocx('a.docx'))) as { token: string };
    const b = (await call('office:open', win1, await aDocx('b.docx'))) as { token: string };
    const other = (await call('office:open', win2, await aDocx('c.docx'))) as { token: string };
    win1.emit('destroyed');
    await vi.waitFor(() => {
      expect(sessions.get(a.token)).toBeUndefined();
      expect(sessions.get(b.token)).toBeUndefined();
    });
    expect(sessions.get(other.token)).toBeDefined();
  });

  it('keeps one editor per file: the same file, even through a link to it, gets the same token', async () => {
    const file = await aDocx();
    const link = path.join(dir, 'link-to-memo.docx');
    await symlink(file, link);
    const first = (await call('office:open', win1, file)) as { token: string };
    const again = (await call('office:open', win1, file)) as { token: string };
    const viaLink = (await call('office:open', win1, link)) as { token: string };
    expect(again.token).toBe(first.token);
    expect(viaLink.token).toBe(first.token);
    expect(sessions.get(first.token)?.path).toBe(file);
  });

  it('opens a file only once even when two opens race', async () => {
    const file = await aDocx();
    const [x, y] = (await Promise.all([call('office:open', win1, file), call('office:open', win1, file)])) as { token: string }[];
    expect(y.token).toBe(x.token);
  });

  it('says a file open in another window is already open there', async () => {
    const file = await aDocx();
    await call('office:open', win1, file);
    await expect(call('office:open', win2, file)).resolves.toEqual({ ok: false, message: 'This file is already open in another window.' });
  });

  it('says Office is not in this build when there is no session registry, or no add-on', async () => {
    const file = await aDocx();
    registry = null;
    await expect(call('office:open', win1, file)).resolves.toEqual({ ok: false, message: "Office isn't included in this build." });
    await expect(call('office:status', win1, null)).resolves.toMatchObject({ available: false });
    registry = sessions;
    available = false;
    await expect(call('office:open', win1, file)).resolves.toEqual({ ok: false, message: "Office isn't included in this build." });
    await expect(call('office:status', win1, null)).resolves.toMatchObject({ available: false });
  });

  it('answers the start-screen channels with their placeholders until the start screen lands', async () => {
    await expect(call('office:status', win1, null)).resolves.toEqual({ available: true, recent: [], project: null });
    await expect(call('office:create', win1, 'document', null)).resolves.toEqual({ ok: false, message: 'Not available yet.' });
    await expect(call('office:pick', win1)).resolves.toBeNull();
  });
});

describe('office:save-copy', () => {
  /** Re-registers with a fake save dialog that answers `target`. */
  function withDialog(target: string | null) {
    const pick = vi.fn(async () => target);
    ipc = fakeIpcMain();
    registerOfficeIpc(ipc, { getSessions: () => registry, available: async () => available, root: path.join(dir, 'addon'), userData: path.join(dir, 'userData'), pickCopyTarget: pick });
    return pick;
  }

  it('changes nothing when the save dialog is cancelled', async () => {
    const pick = withDialog(null);
    const file = await aDocx();
    const r = (await call('office:open', win1, file)) as { token: string };
    await expect(call('office:save-copy', win1, r.token, 'save')).resolves.toEqual({ ok: false, cancelled: true });
    expect(pick).toHaveBeenCalledWith(win1, file);
  });

  it("refuses another window's document without asking where", async () => {
    const pick = withDialog(path.join(dir, 'x.docx'));
    const r = (await call('office:open', win1, await aDocx())) as { token: string };
    await expect(call('office:save-copy', win2, r.token, 'save')).resolves.toEqual({ ok: false, message: 'refused' });
    expect(pick).not.toHaveBeenCalled();
  });

  it('says a copy is not possible before any edited copy exists', async () => {
    withDialog(null);
    const r = (await call('office:open', win1, await aDocx())) as { token: string };
    await expect(call('office:save-copy', win1, r.token, 'check')).resolves.toEqual({ ok: true, possible: false });
  });
});

// A reload lets go of a save still with main; if that save then fails, the new page is told.
describe('a save that fails after its page was reloaded', () => {
  async function opened(sender: ReturnType<typeof fakeSender>) {
    const file = await aDocx();
    const r = (await call('office:open', sender, file)) as { ok: true; token: string };
    return { file, token: r.token };
  }
  const reload = (sender: ReturnType<typeof fakeSender>) => sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });

  it('is kept for the new page, which takes it once, and nudges it', async () => {
    const w = Object.assign(fakeSender(5), { send: vi.fn() });
    const { file, token } = await opened(w);
    const saving = call('office:invoke', w, token, 'save_file', {});
    reload(w); // the page that asked goes before the save's answer
    await expect(saving).rejects.toThrow();
    expect(w.send).toHaveBeenCalledWith('office:saves-lost');
    await expect(call('office:lost-saves', w)).resolves.toEqual([file]);
    await expect(call('office:lost-saves', w)).resolves.toEqual([]);
    w.removeAllListeners();
  });

  it('is not kept when the page that asked is still there (it shows the failure itself)', async () => {
    const w = Object.assign(fakeSender(6), { send: vi.fn() });
    const { token } = await opened(w);
    w.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false }); // an embedded frame
    await expect(call('office:invoke', w, token, 'save_file', {})).rejects.toThrow();
    expect(w.send).not.toHaveBeenCalled();
    await expect(call('office:lost-saves', w)).resolves.toEqual([]);
    w.removeAllListeners();
  });
});

// Kept versions, through the channels: taken on open and every 10 minutes of saving, listed, and
// restored — also under an open editor, whose later saves must never land on the restored file.
describe('office versions and restore', () => {
  // WHY a copying translator: the real x2t is not in the test tree. Opening copies the file to
  // Editor.bin and saving copies Editor.bin back, so every byte is traceable.
  const copying = vi.fn(async (_root: string, input: string, output: string) => { await copyFile(input, output); });
  const doc = (text: string) => Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.from(text)]);
  const userData = () => path.join(dir, 'userData');
  beforeEach(() => {
    ipc = fakeIpcMain();
    registerOfficeIpc(ipc, { getSessions: () => registry, available: async () => available, root: path.join(dir, 'addon'), userData: userData(), convert: copying as never });
  });
  afterEach(() => { vi.useRealTimers(); });

  async function openedIn(sender: ReturnType<typeof fakeSender>) {
    const file = await aDocx();
    const r = (await call('office:open', sender, file)) as { ok: true; token: string };
    await call('office:invoke', sender, r.token, 'open_file', {});
    return { file, token: r.token };
  }
  const saveAs = async (sender: ReturnType<typeof fakeSender>, token: string, bytes: Buffer) => {
    await call('office:invoke', sender, token, 'write_editor_bin', { data: bytes.toString('base64') });
    return call('office:invoke', sender, token, 'save_file', {});
  };

  it('keeps the file as it was opened, and lists it', async () => {
    const { file } = await openedIn(win1);
    const list = (await call('office:versions', win1, file)) as { reason: string; bytes: number }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ reason: 'opened', bytes: (await readFile(MEMO)).length });
  });

  it('keeps one more version per 10 minutes of saving — the file as it was before that save', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date(2026, 8, 28, 9, 0).getTime();
    vi.setSystemTime(t0);
    const { file, token } = await openedIn(win1);
    await saveAs(win1, token, doc('first'));   // the file before it is the opened one: nothing new
    vi.setSystemTime(t0 + 60_000);
    await saveAs(win1, token, doc('second'));  // within 10 minutes: nothing kept
    vi.setSystemTime(t0 + 11 * 60_000);
    await saveAs(win1, token, doc('third'));   // keeps 'second', the file as this save found it
    const list = (await call('office:versions', win1, file)) as { reason: string; bytes: number }[];
    expect(list.map((v) => v.reason)).toEqual(['autosave', 'opened']);
    expect(list[0].bytes).toBe(doc('second').length);
  });

  it('shows the same versions for a file named through a link', async () => {
    const { file } = await openedIn(win1);
    const link = path.join(dir, 'link.docx');
    await symlink(file, link);
    await expect(call('office:versions', win1, link)).resolves.toHaveLength(1);
  });

  it('restores under an open editor, tells its window, and refuses the old editor\'s saves until it reloads', async () => {
    const w = Object.assign(fakeSender(7), { send: vi.fn() });
    const { file, token } = await openedIn(w);
    const [opened] = (await call('office:versions', w, file)) as { id: string }[];
    await saveAs(w, token, doc('edited'));
    await expect(call('office:restore', w, file, opened.id)).resolves.toEqual({ ok: true });
    expect((await readFile(file)).equals(await readFile(MEMO))).toBe(true);
    expect(w.send).toHaveBeenCalledWith('office:changed', { path: file, token });
    // The editor still holds 'edited': its save must not put it back over the restored file.
    await expect(saveAs(w, token, doc('stale'))).rejects.toThrow('This file was restored from a kept version, so Office is reloading it.');
    expect((await readFile(file)).equals(await readFile(MEMO))).toBe(true);
    // The edited file was kept first, so the restore itself can be taken back.
    const list = (await call('office:versions', w, file)) as { reason: string }[];
    expect(list[0].reason).toBe('before-restore');
    // Once the editor has reloaded the file, it saves again.
    await call('office:invoke', w, token, 'open_file', {});
    await saveAs(w, token, doc('after reload'));
    expect((await readFile(file)).equals(doc('after reload'))).toBe(true);
    w.removeAllListeners();
  });

  it('refuses to restore a file another window is editing, and changes nothing', async () => {
    const { file } = await openedIn(win1);
    const [opened] = (await call('office:versions', win1, file)) as { id: string }[];
    await writeFile(file, doc('newer'));
    await expect(call('office:restore', win2, file, opened.id)).resolves.toEqual({ ok: false, message: 'This file is already open in another window.' });
    expect((await readFile(file)).equals(doc('newer'))).toBe(true);
  });

  it('restores a file no editor has open', async () => {
    const { file, token } = await openedIn(win1);
    const [opened] = (await call('office:versions', win1, file)) as { id: string }[];
    await call('office:close', win1, token);
    await writeFile(file, doc('changed elsewhere'));
    await expect(call('office:restore', win1, file, opened.id)).resolves.toEqual({ ok: true });
    expect((await readFile(file)).equals(await readFile(MEMO))).toBe(true);
  });

  it('says so when the version is no longer kept', async () => {
    const { file } = await openedIn(win1);
    await expect(call('office:restore', win1, file, '2020-01-01T000000.000Z-abcd')).resolves.toEqual({ ok: false, message: 'That version is no longer kept.' });
  });
});
