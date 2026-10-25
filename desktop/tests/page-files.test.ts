// A page's file door: who may ask for what, through which screen, and how much
// (main/pages/page-files.ts). The real-path rules underneath are page-file-guard.test.ts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PageFiles, FILE_LIMITS, type FileLine, type FilesAccess, type PageFilesDeps } from '../src/main/pages/page-files';
import { canonicalize } from '../src/shared/artifacts/canonicalize';
import type { PageFilesResult } from '../src/shared/pages-types';

let home: string;
let access: FilesAccess;
let opened: string[] | null;
let saveTo: string | null;
let trashed: string[];
let files: PageFiles;
const win = { ownerKey: 'window:1', remote: false };
const otherWin = { ownerKey: 'window:2', remote: false };
const phone = { ownerKey: 'client:p', remote: true };
const PAGE = 'personal:budget';

const line = (id: string, level: FileLine['level'], acc: FileLine['access']): FileLine => ({ id, level, access: acc });
const ok = (r: PageFilesResult) => { if (!r.ok) throw new Error(`${r.code}: ${r.message}`); return r; };

function make(extra: Partial<PageFilesDeps> = {}) {
  return new PageFiles({
    access: async (id) => (id === PAGE ? access : null),
    rememberFile: async (_k, lineId, name, p) => {
      const list = (access.remembered[lineId] ??= []);
      const had = list.find((f) => f.path === p);
      if (had) return had.id;
      const id = `${list.length}`.padStart(16, '0');
      list.push({ id, name, path: p });
      return id;
    },
    showOpen: async () => opened,
    showSave: async () => saveTo,
    trash: async (p) => { trashed.push(p); fs.rmSync(p, { recursive: true }); },
    protectedRoots: () => [`${home}/app-data`],
    gate: { acquire: async () => true, release: () => {} },
    home,
    ...extra,
  });
}

beforeEach(() => {
  home = canonicalize(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-files-'))), null);
  fs.mkdirSync(`${home}/Documents/Budgets`, { recursive: true });
  fs.writeFileSync(`${home}/Documents/Budgets/2026.csv`, 'a,b\n1,2\n');
  fs.writeFileSync(`${home}/Documents/notes.txt`, 'notes');
  fs.mkdirSync(`${home}/.ssh`);
  fs.writeFileSync(`${home}/.ssh/id_rsa`, 'key');
  fs.mkdirSync(`${home}/app-data`);
  access = { pageKey: PAGE, lines: [], folders: {}, remembered: {}, pageDir: null };
  opened = null; saveTo = null; trashed = [];
  files = make();
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 }));

describe('nothing without an approved line', () => {
  it('refuses every op when the page has no files line', async () => {
    for (const req of [{ op: 'pick' }, { op: 'list', path: '' }, { op: 'readPath', path: '~/x' }] as const) {
      expect(await files.call(win, PAGE, req)).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
    }
  });
});

describe('pick, read and save through the Open and Save windows', () => {
  beforeEach(() => { access.lines = [line('f', 'pick', 'readwrite')]; });

  it('hands back a handle, never a path, and reads through it', async () => {
    opened = [`${home}/Documents/Budgets/2026.csv`];
    const r = ok(await files.call(win, PAGE, { op: 'pick', types: ['.csv'] }));
    expect(r.files).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain(home);
    const read = ok(await files.call(win, PAGE, { op: 'read', handle: r.files![0].handle }));
    expect(read.data).toBe('a,b\n1,2\n');
    ok(await files.call(win, PAGE, { op: 'save', handle: r.files![0].handle, data: 'x,y\n' }));
    expect(fs.readFileSync(`${home}/Documents/Budgets/2026.csv`, 'utf8')).toBe('x,y\n');
  });

  it('does not let another window use the handle', async () => {
    opened = [`${home}/Documents/notes.txt`];
    const { files: [h] } = ok(await files.call(win, PAGE, { op: 'pick' })) as { files: Array<{ handle: string }> };
    expect(await files.call(otherWin, PAGE, { op: 'read', handle: h.handle })).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
  });

  it('lets the handle go when the window closes, the page closes, or its yes changes', async () => {
    opened = [`${home}/Documents/notes.txt`];
    const pick = async () => (ok(await files.call(win, PAGE, { op: 'pick' })).files![0].handle);
    let h = await pick();
    files.closeOwner(win.ownerKey);
    expect(await files.call(win, PAGE, { op: 'read', handle: h })).toMatchObject({ code: 'NOT_ALLOWED' });
    h = await pick();
    await files.call(win, PAGE, { op: 'close' });
    expect(await files.call(win, PAGE, { op: 'read', handle: h })).toMatchObject({ code: 'NOT_ALLOWED' });
    h = await pick();
    files.closePage(PAGE);
    expect(await files.call(win, PAGE, { op: 'read', handle: h })).toMatchObject({ code: 'NOT_ALLOWED' });
    h = await pick();
    access.lines = [];
    expect(await files.call(win, PAGE, { op: 'read', handle: h })).toMatchObject({ code: 'NOT_ALLOWED' });
  });

  it('keeps reading and changing apart', async () => {
    access.lines = [line('f', 'pick', 'read')];
    opened = [`${home}/Documents/notes.txt`];
    const h = ok(await files.call(win, PAGE, { op: 'pick' })).files![0].handle;
    expect(await files.call(win, PAGE, { op: 'save', handle: h, data: 'no' })).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
    expect(fs.readFileSync(`${home}/Documents/notes.txt`, 'utf8')).toBe('notes');
    expect(await files.call(win, PAGE, { op: 'saveAs', suggestedName: 'x.txt', data: 'x' })).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
  });

  it('never opens a key file, even one the person picked', async () => {
    opened = [`${home}/.ssh/id_rsa`];
    expect(await files.call(win, PAGE, { op: 'pick' })).toMatchObject({ ok: false, code: 'REFUSED' });
  });

  it('says so when nothing was chosen', async () => {
    expect(await files.call(win, PAGE, { op: 'pick' })).toMatchObject({ ok: false, code: 'CANCELLED' });
  });

  it('saves a new file through the Save window and can save it again', async () => {
    saveTo = `${home}/Documents/new.txt`;
    const r = ok(await files.call(win, PAGE, { op: 'saveAs', suggestedName: 'new.txt', data: 'aGk=', encoding: 'base64' }));
    expect(fs.readFileSync(saveTo, 'utf8')).toBe('hi');
    ok(await files.call(win, PAGE, { op: 'save', handle: r.files![0].handle, data: 'again' }));
    expect(fs.readFileSync(saveTo, 'utf8')).toBe('again');
  });

  it('refuses a file larger than a page may open', async () => {
    fs.writeFileSync(`${home}/Documents/big.txt`, Buffer.alloc(FILE_LIMITS.textBytes + 1, 97));
    opened = [`${home}/Documents/big.txt`];
    const h = ok(await files.call(win, PAGE, { op: 'pick' })).files![0].handle;
    expect(await files.call(win, PAGE, { op: 'read', handle: h })).toMatchObject({ ok: false, code: 'TOO_BIG' });
  });
});

describe('remember', () => {
  it('keeps a picked file for next time, and forgets it when told', async () => {
    access.lines = [line('r', 'remember', 'read')];
    opened = [`${home}/Documents/notes.txt`];
    ok(await files.call(win, PAGE, { op: 'pick' }));
    files.closeOwner(win.ownerKey); // the app restarted, as far as handles go
    const recent = ok(await files.call(win, PAGE, { op: 'recent' }));
    expect(recent.files?.map((f) => f.name)).toEqual(['notes.txt']);
    expect(ok(await files.call(win, PAGE, { op: 'read', handle: recent.files![0].handle })).data).toBe('notes');
    access.remembered.r = [];
    expect(await files.call(win, PAGE, { op: 'read', handle: recent.files![0].handle })).toMatchObject({ code: 'NOT_ALLOWED' });
  });
});

describe('a folder', () => {
  beforeEach(() => {
    access.lines = [line('d', 'folder', 'readwrite')];
    access.folders = { d: `${home}/Documents` };
  });

  it('lists, reads and writes inside the folder only', async () => {
    const list = ok(await files.call(win, PAGE, { op: 'list', path: '' }));
    expect(list.entries?.map((e) => e.name).sort()).toEqual(['Budgets', 'notes.txt']);
    expect(ok(await files.call(win, PAGE, { op: 'readPath', path: 'Budgets/2026.csv' })).data).toContain('a,b');
    ok(await files.call(win, PAGE, { op: 'writePath', path: 'Budgets/2027.csv', data: 'new' }));
    expect(fs.readFileSync(`${home}/Documents/Budgets/2027.csv`, 'utf8')).toBe('new');
    expect(await files.call(win, PAGE, { op: 'writePath', path: 'Budgets/2027.csv', data: 'over' })).toMatchObject({ ok: false, code: 'REFUSED' });
    ok(await files.call(win, PAGE, { op: 'writePath', path: 'Budgets/2027.csv', data: 'over', replace: true }));
    expect(fs.readFileSync(`${home}/Documents/Budgets/2027.csv`, 'utf8')).toBe('over');
    for (const p of ['../.ssh/id_rsa', '~/.ssh/id_rsa', '/etc/passwd']) {
      expect((await files.call(win, PAGE, { op: 'readPath', path: p })).ok, p).toBe(false);
    }
  });

  it('makes folders and moves files to the bin, never deleting the folder itself', async () => {
    ok(await files.call(win, PAGE, { op: 'makeFolder', path: 'Receipts' }));
    expect(fs.statSync(`${home}/Documents/Receipts`).isDirectory()).toBe(true);
    ok(await files.call(win, PAGE, { op: 'remove', path: 'notes.txt' }));
    expect(trashed).toEqual([`${home}/Documents/notes.txt`]);
    expect(await files.call(win, PAGE, { op: 'remove', path: '' })).toMatchObject({ ok: false, code: 'REFUSED' });
  });

  it('refuses remove where there is no bin, rather than deleting for good', async () => {
    const noBin = make({ trash: undefined });
    expect(await noBin.call(win, PAGE, { op: 'remove', path: 'notes.txt' })).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
    expect(fs.existsSync(`${home}/Documents/notes.txt`)).toBe(true);
  });

  it('asks for the folder first when none was recorded', async () => {
    access.folders = {};
    expect(await files.call(win, PAGE, { op: 'list', path: '' })).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
  });
});

describe('all files', () => {
  beforeEach(() => { access.lines = [line('a', 'all', 'readwrite')]; });

  it('reaches anywhere under home except secrets and settings folders', async () => {
    expect(ok(await files.call(win, PAGE, { op: 'readPath', path: '~/Documents/notes.txt' })).data).toBe('notes');
    expect(await files.call(win, PAGE, { op: 'readPath', path: '~/.ssh/id_rsa' })).toMatchObject({ ok: false });
    expect(await files.call(win, PAGE, { op: 'readPath', path: '/etc/hostname' })).toMatchObject({ ok: false });
    expect(await files.call(win, PAGE, { op: 'writePath', path: '~/.bashrc', data: 'evil' })).toMatchObject({ ok: false });
    expect(await files.call(win, PAGE, { op: 'writePath', path: '~/app-data/x', data: 'x' })).toMatchObject({ ok: false });
  });

  it('cannot change files from a phone', async () => {
    expect(await files.call(phone, PAGE, { op: 'writePath', path: '~/Documents/x.txt', data: 'x' })).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
  });
});

describe("a phone uses YouCoded's own chooser", () => {
  beforeEach(() => { access.lines = [line('f', 'pick', 'readwrite')]; });

  it('gets an ask, lists only while it waits, and answers with a choice', async () => {
    const r = ok(await files.call(phone, PAGE, { op: 'pick', types: ['.csv'] }));
    expect(r.ask).toMatchObject({ kind: 'open', types: ['.csv'] });
    const askId = r.ask!.id;
    // Another screen, or another page, cannot browse through this ask.
    expect(await files.listForAsk(win, PAGE, askId, '')).toMatchObject({ ok: false });
    expect(await files.listForAsk(phone, 'personal:other', askId, '')).toMatchObject({ ok: false });
    const listing = await files.listForAsk(phone, PAGE, askId, 'Documents');
    expect(listing.ok && listing.entries.map((e) => e.name).sort()).toEqual(['Budgets', 'notes.txt']);
    expect(await files.listForAsk(phone, PAGE, askId, '.ssh')).toMatchObject({ ok: false });
    const chosen = ok(await files.call(phone, PAGE, { op: 'choose', ask: askId, folder: 'Documents/Budgets', file: '2026.csv' }));
    expect(ok(await files.call(phone, PAGE, { op: 'read', handle: chosen.files![0].handle })).data).toContain('1,2');
    // The ask is spent: no more browsing.
    expect(await files.listForAsk(phone, PAGE, askId, '')).toMatchObject({ ok: false });
  });

  it('never saves over an existing file from the chooser', async () => {
    const r = ok(await files.call(phone, PAGE, { op: 'saveAs', suggestedName: 'notes.txt' }));
    expect(await files.call(phone, PAGE, { op: 'choose', ask: r.ask!.id, folder: 'Documents', file: 'notes.txt', data: 'x' })).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(fs.readFileSync(`${home}/Documents/notes.txt`, 'utf8')).toBe('notes');
    const r2 = ok(await files.call(phone, PAGE, { op: 'saveAs', suggestedName: 'fresh.txt' }));
    ok(await files.call(phone, PAGE, { op: 'choose', ask: r2.ask!.id, folder: 'Documents', file: 'fresh.txt', data: 'made' }));
    expect(fs.readFileSync(`${home}/Documents/fresh.txt`, 'utf8')).toBe('made');
  });

  it('refuses a choice outside home or of a key file', async () => {
    const ask = async () => ok(await files.call(phone, PAGE, { op: 'pick' })).ask!.id;
    expect((await files.call(phone, PAGE, { op: 'choose', ask: await ask(), folder: '..', file: 'x' })).ok).toBe(false);
    expect((await files.call(phone, PAGE, { op: 'choose', ask: await ask(), folder: '.ssh', file: 'id_rsa' })).ok).toBe(false);
  });
});

describe('a folder chosen on the card', () => {
  it('is kept behind a one-time token for the window that chose it', async () => {
    const f = make({ showFolder: async () => `${home}/Documents` });
    const r = await f.chooseFolder(win);
    expect(r).toMatchObject({ ok: true, display: expect.stringMatching(/Documents$/) });
    const token = (r as { token: string }).token;
    expect(f.takeFolderToken(token, otherWin.ownerKey)).toBeNull();
    const r2 = await f.chooseFolder(win) as { token: string };
    expect(f.takeFolderToken(r2.token, win.ownerKey)).toBe(`${home}/Documents`);
    expect(f.takeFolderToken(r2.token, win.ownerKey)).toBeNull();
  });

  it('refuses home itself, a hidden folder and YouCoded’s own', async () => {
    for (const p of [home, `${home}/.ssh`, `${home}/app-data`]) {
      expect(await make({ showFolder: async () => p }).chooseFolder(win)).toMatchObject({ ok: false, message: expect.any(String) });
    }
  });

  it('is not offered to a phone', async () => {
    expect(await make({ showFolder: async () => `${home}/Documents` }).chooseFolder(phone)).toMatchObject({ ok: false });
  });
});

describe("the phone's chooser stays out of hidden folders", () => {
  it('refuses to list or choose inside one', async () => {
    access.lines = [line('f', 'pick', 'read')];
    fs.mkdirSync(`${home}/.config/app`, { recursive: true });
    fs.writeFileSync(`${home}/.config/app/settings.json`, '{}');
    const askId = ok(await files.call(phone, PAGE, { op: 'pick' })).ask!.id;
    expect(await files.listForAsk(phone, PAGE, askId, '.config/app')).toMatchObject({ ok: false });
    expect(await files.call(phone, PAGE, { op: 'choose', ask: askId, folder: '.config/app', file: 'settings.json' })).toMatchObject({ ok: false });
  });
});
