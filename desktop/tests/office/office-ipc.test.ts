import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// WHY mocked: office-commands imports the project watcher (chokidar and the artifact store);
// these tests only drive the IPC layer in front of it.
vi.mock('../../src/main/artifacts/project-watcher', () => ({ noteOwnWrite: vi.fn() }));
// WHY wrapped, not replaced: the real walk still runs; the tests count how often it starts.
vi.mock('../../src/main/office/office-home', async (orig) => {
  const real = await orig<typeof import('../../src/main/office/office-home')>();
  return { ...real, startWalk: vi.fn(real.startWalk) };
});

import type { OfficeFile } from '../../src/shared/office-types';
import { registerOfficeIpc } from '../../src/main/office/office-ipc';
import { startWalk } from '../../src/main/office/office-home';
import { idle as recentIdle } from '../../src/main/office/recent';
import { createSessions } from '../../src/main/office/office-sessions';
import { snapshot, versionsDir } from '../../src/main/office/versions';

const MEMO = fileURLToPath(new URL('./fixtures/memo.docx', import.meta.url));
const PICTURE = fileURLToPath(new URL('./fixtures/picture.docx', import.meta.url));
const ADDON = fileURLToPath(new URL('../../office-addon/', import.meta.url));
const HAS_ADDON = existsSync(path.join(ADDON, 'manifest.json'));
// The bundled translator's first run in a test process is slow (it loads its fonts and data).
const X2T_WARMUP_BUDGET_MS = 120_000;

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
  await recentIdle();
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

});

describe('the start screen: Recent, the project list, New and Open', () => {
  let templates: string;
  let documents: string;
  let picked: OfficeFile | null;
  let pickedBy: unknown[];
  beforeEach(async () => {
    // Generated stand-in templates (a real .docx for the document, so opening one works).
    templates = path.join(dir, 'addon', 'templates');
    await mkdir(templates, { recursive: true });
    await copyFile(MEMO, path.join(templates, 'blank.docx'));
    await writeFile(path.join(templates, 'blank.xlsx'), 'xlsx template');
    await writeFile(path.join(templates, 'blank.pptx'), 'pptx template');
    documents = path.join(dir, 'Documents');
    await mkdir(documents);
    picked = null;
    pickedBy = [];
    ipc = fakeIpcMain();
    registerOfficeIpc(ipc, {
      getSessions: () => registry, available: async () => available, root: path.join(dir, 'addon'), userData: path.join(dir, 'userData'), documents,
      pickFile: async (sender) => { pickedBy.push(sender); return picked; },
    });
  });

  it('lists nothing in Recent before any file was opened', async () => {
    await expect(call('office:status', win1, null)).resolves.toEqual({ available: true, recent: [], project: null });
  });

  it('adds a file to Recent when it opens in Office, and not when the open is refused', async () => {
    const file = await aDocx();
    await writeFile(path.join(dir, 'notes.txt'), 'x');
    await call('office:open', win1, path.join(dir, 'notes.txt'));
    await call('office:open', win1, path.join(dir, 'gone.docx'));
    expect((await call('office:status', win1, null) as { recent: unknown[] }).recent).toEqual([]);
    expect(await call('office:open', win1, file)).toMatchObject({ ok: true });
    // Added without holding up the open, so it lands just after.
    const recent = await vi.waitFor(async () => {
      const r = (await call('office:status', win1, null) as { recent: Array<Record<string, string>> }).recent;
      expect(r).toHaveLength(1);
      return r;
    });
    expect(recent[0]).toMatchObject({ path: file, name: 'memo.docx', kind: 'document', folder: path.basename(dir) });
  });

  it("lists the focused conversation's project files, named after its folder", async () => {
    const project = path.join(dir, 'garden');
    await mkdir(path.join(project, 'plans'), { recursive: true });
    await copyFile(MEMO, path.join(project, 'plans', 'Plan.docx'));
    await writeFile(path.join(project, 'readme.txt'), 'x');
    const s = await call('office:status', win1, project) as { project: { name: string; files: Array<{ name: string }> } };
    expect(s.project.name).toBe('garden');
    expect(s.project.files.map((f) => f.name)).toEqual(['Plan.docx']);
  });

  it('shares one project walk between requests for the same folder that overlap, and walks nothing for Recent alone', async () => {
    const project = path.join(dir, 'garden');
    await mkdir(project);
    await copyFile(MEMO, path.join(project, 'Plan.docx'));
    vi.mocked(startWalk).mockClear();
    await call('office:status', win1, null);
    expect(startWalk).not.toHaveBeenCalled();
    const [a, b] = await Promise.all([call('office:status', win1, project), call('office:status', win2, project)]) as Array<{ project: { files: unknown[] } }>;
    expect(startWalk).toHaveBeenCalledTimes(1);
    expect(a.project.files).toHaveLength(1);
    expect(b.project.files).toHaveLength(1);
    // Once it has answered, the next showing walks again (files may have changed).
    await call('office:status', win1, project);
    expect(startWalk).toHaveBeenCalledTimes(2);
  });

  it('lists a file created while a walk of its folder was still running', async () => {
    const project = path.join(dir, 'garden');
    await mkdir(project);
    await copyFile(MEMO, path.join(project, 'Plan.docx'));
    // The first walk's first folder read is held until the test lets it go.
    let hold = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const walkFs = {
      opendir: async (d: string) => { if (hold) { hold = false; await gate; } return fsp.opendir(d); },
      stat: (p: string) => fsp.stat(p),
    };
    ipc = fakeIpcMain();
    registerOfficeIpc(ipc, { getSessions: () => registry, available: async () => true, root: path.join(dir, 'addon'), userData: path.join(dir, 'userData'), documents, walkFs });
    const first = call('office:status', win1, project);
    await vi.waitFor(() => expect(hold).toBe(false));
    const made = await call('office:create', win1, 'document', project) as { ok: true; file: { name: string } };
    expect(made.ok).toBe(true);
    const after = await call('office:status', win1, project) as { project: { files: Array<{ name: string }> } };
    expect(after.project.files.map((f) => f.name).sort()).toEqual(['Plan.docx', 'Untitled document.docx']);
    release();
    await first;
  });

  it('starts only one walk of a folder that never answers, and at most two walks at once', async () => {
    const hung = { opendir: () => new Promise<never>(() => {}), stat: (p: string) => fsp.stat(p) };
    ipc = fakeIpcMain();
    registerOfficeIpc(ipc, { getSessions: () => registry, available: async () => true, root: path.join(dir, 'addon'), userData: path.join(dir, 'userData'), walkFs: hung, walkDeadlineMs: 20 });
    const [a, b, c] = ['a', 'b', 'c'].map((n) => path.join(dir, n));
    for (const f of [a, b, c]) await mkdir(f);
    vi.mocked(startWalk).mockClear();
    for (let i = 0; i < 3; i++) {
      const s = await call('office:status', win1, a) as { project: { files: unknown[] } };
      expect(s.project.files).toEqual([]); // answered at the deadline with nothing found
    }
    expect(startWalk).toHaveBeenCalledTimes(1);
    await call('office:status', win1, b);
    expect(startWalk).toHaveBeenCalledTimes(2);
    // Two walks are stuck: a third folder gets an empty list, and no third walk starts.
    const third = await call('office:status', win1, c) as { project: { name: string; files: unknown[] } };
    expect(third.project).toEqual({ name: 'c', files: [] });
    expect(startWalk).toHaveBeenCalledTimes(2);
  });

  it('has no project list for no conversation, a folder that is gone, or a path that is not absolute', async () => {
    for (const root of [null, path.join(dir, 'gone'), 'relative/folder', 42]) {
      expect((await call('office:status', win1, root) as { project: unknown }).project).toBeNull();
    }
  });

  it('says Office is unavailable without reading Recent or the project', async () => {
    available = false;
    await expect(call('office:status', win1, dir)).resolves.toEqual({ available: false, recent: [], project: null });
  });

  it('creates a new document in the focused project, which then opens', async () => {
    const project = path.join(dir, 'garden');
    await mkdir(project);
    const r = await call('office:create', win1, 'document', project) as { ok: true; file: { path: string; name: string } };
    expect(r).toMatchObject({ ok: true, file: { name: 'Untitled document.docx', kind: 'document', folder: 'garden' } });
    expect(r.file.path).toBe(path.join(project, 'Untitled document.docx'));
    expect(await call('office:open', win1, r.file.path)).toMatchObject({ ok: true });
    const again = await call('office:create', win1, 'document', project) as { file: { name: string } };
    expect(again.file.name).toBe('Untitled document 2.docx');
  });

  it('creates in Documents when no conversation is focused', async () => {
    const r = await call('office:create', win1, 'spreadsheet', null) as { ok: true; file: { path: string } };
    expect(r.file.path).toBe(path.join(documents, 'Untitled spreadsheet.xlsx'));
    expect(await readFile(r.file.path, 'utf8')).toBe('xlsx template');
  });

  it('makes the Documents folder when it is missing, then creates the new file in it', async () => {
    await rm(documents, { recursive: true });
    const r = await call('office:create', win1, 'document', null) as { ok: true; file: { path: string } };
    expect(r.file.path).toBe(path.join(documents, 'Untitled document.docx'));
    expect(await readdir(documents)).toEqual(['Untitled document.docx']);
  });

  it('refuses an unknown kind, and a project folder that is gone, creating nothing', async () => {
    await expect(call('office:create', win1, 'drawing', null)).resolves.toMatchObject({ ok: false });
    await expect(call('office:create', win1, 'document', path.join(dir, 'gone'))).resolves.toEqual({ ok: false, message: 'This folder no longer exists.' });
    expect(await readdir(documents)).toEqual([]);
  });

  it('refuses to create a file in a protected folder', async () => {
    // Any folder named .ssh is protected (editable-path-policy) — a temp one, never the real one.
    const ssh = path.join(dir, '.ssh');
    await mkdir(ssh);
    await expect(call('office:create', win1, 'document', ssh)).resolves.toEqual({ ok: false, message: "Office can't create files in this protected folder." });
    expect(await readdir(ssh)).toEqual([]);
  });

  it('says Office is unavailable instead of creating a file', async () => {
    available = false;
    await expect(call('office:create', win1, 'document', null)).resolves.toEqual({ ok: false, message: "Office isn't included in this build." });
    expect(await readdir(documents)).toEqual([]);
  });

  it("opens the system picker for the asking window, and answers null when it's cancelled", async () => {
    await expect(call('office:pick', win1)).resolves.toBeNull();
    expect(pickedBy).toEqual([win1]);
  });

  it('does not show the picker when Office is unavailable', async () => {
    available = false;
    await expect(call('office:pick', win1)).resolves.toBeNull();
    expect(pickedBy).toEqual([]);
  });

  it('answers the picked file', async () => {
    const f: OfficeFile = { path: await aDocx(), name: 'memo.docx', kind: 'document', folder: path.basename(dir), at: 'now' };
    picked = f;
    await expect(call('office:pick', win1)).resolves.toEqual(f);
  });
});

describe('the editor asks for a file dialog (Insert → Picture)', () => {
  /** Re-registers with a fake open dialog that answers `paths`. */
  function withPicker(paths: string[] | null) {
    const pick = vi.fn(async () => paths);
    ipc = fakeIpcMain();
    registerOfficeIpc(ipc, { getSessions: () => registry, available: async () => available, root: path.join(dir, 'addon'), userData: path.join(dir, 'userData'), pickEditorFiles: pick });
    return pick;
  }

  it('shows the dialog for the asking window and answers handles, never the folders', async () => {
    const pick = withPicker([path.join(dir, 'pics', 'cat.png'), path.join(dir, 'pics', 'dog.jpg')]);
    const { token } = (await call('office:open', win1, await aDocx())) as { token: string };
    const filters = [{ name: 'Images', extensions: ['png'] }];
    const many = (await call('office:invoke', win1, token, 'open_dialog', { multiple: true, filters })) as string[];
    expect(pick).toHaveBeenCalledWith(win1, { multiple: true, filters });
    expect(many).toHaveLength(2);
    expect(many[0]).toMatch(/^yc-picked\/[0-9a-f]{32}\/cat\.png$/);
    expect(many[1].endsWith('/dog.jpg')).toBe(true);
    expect(JSON.stringify(many)).not.toContain(dir);
    // one file, as Tauri's dialog answers when multiple is off
    const one = await call('office:invoke', win1, token, 'open_dialog', { multiple: false });
    expect(typeof one).toBe('string');
  });

  it('answers null when the dialog is cancelled', async () => {
    withPicker(null);
    const { token } = (await call('office:open', win1, await aDocx())) as { token: string };
    await expect(call('office:invoke', win1, token, 'open_dialog', {})).resolves.toBeNull();
  });

  it("never shows a dialog for another window's document", async () => {
    const pick = withPicker(['/p/a.png']);
    const { token } = (await call('office:open', win1, await aDocx())) as { token: string };
    await expect(call('office:invoke', win2, token, 'open_dialog', {})).rejects.toThrow('refused');
    expect(pick).not.toHaveBeenCalled();
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

// Final review, finding 4: quit stops a save still running after 5 s. The next launch's first
// page is told about each such file once, through the same lost-saves list a reload uses.
describe('saves the last quit had to stop', () => {
  it('are handed to the first page that asks after a launch, once', async () => {
    const earlier = path.join(dir, 'budget.xlsx');
    await mkdir(path.join(dir, 'userData'), { recursive: true });
    await writeFile(path.join(dir, 'userData', 'office-abandoned-saves.json'), JSON.stringify([earlier]));
    // A fresh registration is a fresh launch; the one beforeEach made has not been asked yet.
    await expect(call('office:lost-saves', win1)).resolves.toEqual([earlier]);
    await expect(call('office:lost-saves', win1)).resolves.toEqual([]);
    await expect(call('office:lost-saves', win2)).resolves.toEqual([]);
    expect(existsSync(path.join(dir, 'userData', 'office-abandoned-saves.json'))).toBe(false);
  });

  it("include a save that failed after its window had closed, told on the next launch", async () => {
    await mkdir(path.join(dir, 'userData'), { recursive: true });
    let closed = false;
    const w = Object.assign(fakeSender(7), { send: vi.fn(), isDestroyed: () => closed });
    const file = await aDocx();
    const { token } = (await call('office:open', w, file)) as { token: string };
    const saving = call('office:invoke', w, token, 'save_file', {});
    closed = true; // the window closes while main is still finishing the save
    await expect(saving).rejects.toThrow();
    await vi.waitFor(() => expect(existsSync(path.join(dir, 'userData', 'office-abandoned-saves.json'))).toBe(true));
    await expect(call('office:lost-saves', win1)).resolves.toEqual([file]);
    w.removeAllListeners();
  });

  it('do not include a failed save whose window is still open (it shows the failure itself)', async () => {
    const file = await aDocx();
    const { token } = (await call('office:open', win1, file)) as { token: string };
    await expect(call('office:invoke', win1, token, 'save_file', {})).rejects.toThrow();
    await expect(call('office:lost-saves', win1)).resolves.toEqual([]);
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

  it('after a version cannot be kept, waits 10 minutes before trying again instead of on every save', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date(2026, 8, 28, 9, 0).getTime();
    vi.setSystemTime(t0);
    // The versions folder cannot be made: every snapshot fails.
    await writeFile(path.join(dir, 'userData-blocker'), '');
    ipc = fakeIpcMain();
    const blocked = path.join(dir, 'userData-blocker');
    registerOfficeIpc(ipc, { getSessions: () => registry, available: async () => available, root: path.join(dir, 'addon'), userData: blocked, convert: copying as never });
    const { file, token } = await openedIn(win1);
    const read = vi.spyOn(fsp, 'readFile');
    const readsOfFile = () => read.mock.calls.filter((c) => c[0] === file).length;
    await saveAs(win1, token, doc('first'));        // due: reads the file, the snapshot fails
    expect(readsOfFile()).toBe(1);
    vi.setSystemTime(t0 + 60_000);
    await saveAs(win1, token, doc('second'));       // not due after the failure: the file is not even read
    expect(readsOfFile()).toBe(1);
    vi.setSystemTime(t0 + 11 * 60_000);
    await saveAs(win1, token, doc('third'));        // due again
    expect(readsOfFile()).toBe(2);
    read.mockRestore();
  });

  it('says the versions could not be loaded when their index cannot be read, rather than listing none', async () => {
    const { file } = await openedIn(win1);
    const vdir = versionsDir(userData(), file);
    await rm(path.join(vdir, 'index.json'));
    await mkdir(path.join(vdir, 'index.json'));
    await expect(call('office:versions', win1, file)).rejects.toThrow("Office couldn't load the versions of this file.");
  });

  it("copies an editor's own handed-in bytes without touching the file or the document's working copy", async () => {
    const pickTarget = path.join(dir, 'kept typing.docx');
    ipc = fakeIpcMain();
    registerOfficeIpc(ipc, { getSessions: () => registry, available: async () => available, root: path.join(dir, 'addon'), userData: userData(), convert: copying as never, pickCopyTarget: async () => pickTarget });
    const { file, token } = await openedIn(win1);
    const s = sessions.get(token)!;
    const binBefore = await readFile(path.join(s.temp, 'Editor.bin'));
    const fileBefore = await readFile(file);
    const kept = doc('kept typing');
    await expect(call('office:save-copy', win1, token, 'save', kept.toString('base64'))).resolves.toMatchObject({ ok: true, path: pickTarget });
    expect((await readFile(pickTarget)).equals(kept)).toBe(true);
    expect((await readFile(file)).equals(fileBefore)).toBe(true);
    expect((await readFile(path.join(s.temp, 'Editor.bin'))).equals(binBefore)).toBe(true);
  });

  it('puts the pictures aside at a restore under an open editor, and drops them when that editor is let go', async () => {
    const { file, token } = await openedIn(win1);
    const s = sessions.get(token)!;
    const [opened] = (await call('office:versions', win1, file)) as { id: string }[];
    await call('office:restore', win1, file, opened.id);
    const kept = () => readdir(s.temp).then((n) => n.filter((x) => x.startsWith('media-kept-')));
    expect(await kept()).toHaveLength(1);
    await expect(call('office:save-copy', win1, token, 'release')).resolves.toEqual({ ok: true, released: true });
    expect(await kept()).toEqual([]);
  });

  it("refuses the old editor's bytes as the document's working copy after a restore, until it reloads", async () => {
    const { file, token } = await openedIn(win1);
    const [opened] = (await call('office:versions', win1, file)) as { id: string }[];
    await expect(call('office:restore', win1, file, opened.id)).resolves.toEqual({ ok: true });
    await expect(call('office:invoke', win1, token, 'write_editor_bin', { data: doc('stale').toString('base64') }))
      .rejects.toThrow('This file was restored from a kept version, so Office is reloading it.');
  });
});

// A copy made from a kept editor's bytes after a restore (the editor kept its typing): with the
// REAL translator, so the pictures the old document's bytes refer to must still be found.
describe.skipIf(!HAS_ADDON)('a copy from kept typing after a restore, with the bundled x2t', () => {
  it('keeps the old document\'s picture even after the file was restored to one without it and reopened', async () => {
    const target = path.join(dir, 'kept copy.docx');
    ipc = fakeIpcMain();
    registerOfficeIpc(ipc, { getSessions: () => registry, available: async () => true, root: ADDON, userData: path.join(dir, 'userData'), pickCopyTarget: async () => target });
    const file = path.join(dir, 'pictures.docx');
    await copyFile(PICTURE, file);
    const w = Object.assign(fakeSender(9), { send: vi.fn() });
    const { token } = (await call('office:open', w, file)) as { token: string };
    const kept = (await call('office:invoke', w, token, 'open_file', {})) as string; // the editor's bytes
    // A kept version without the picture, restored while the editor still holds the old document.
    const plain = await snapshot(path.join(dir, 'userData'), file, 'autosave', await readFile(MEMO));
    await expect(call('office:restore', w, file, plain!.id)).resolves.toEqual({ ok: true });
    // Another editor of the same document reloads the restored file (its pictures: none).
    await call('office:invoke', w, token, 'open_file', {});
    await expect(call('office:save-copy', w, token, 'save', kept)).resolves.toMatchObject({ ok: true, path: target });
    const copy = await readFile(target);
    expect(copy.includes('word/media/')).toBe(true);
    // The restored file itself is the plain version.
    expect((await readFile(file)).equals(await readFile(MEMO))).toBe(true);
    w.removeAllListeners();
  }, X2T_WARMUP_BUDGET_MS);

  it('refuses a handed-in editor copy that is not text, never falling back to the working copy', async () => {
    const w = Object.assign(fakeSender(10), { send: vi.fn() });
    const file = path.join(dir, 'p2.docx');
    await copyFile(PICTURE, file);
    const { token } = (await call('office:open', w, file)) as { token: string };
    await expect(call('office:save-copy', w, token, 'save', 42)).resolves.toEqual({ ok: false, message: 'refused' });
    w.removeAllListeners();
  });
});
