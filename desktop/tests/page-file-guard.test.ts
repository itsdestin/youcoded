// The rules that keep a page inside the files it was given (pages-finish step 2, files design
// review 1 findings 1–4, 18–20). Every case here is an escape attempt that must FAIL.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  badSegment, cleanRelative, cleanUnderHome, folderChoiceProblem, isReadDenied, isWriteDenied,
  listInside, openForRead, openForWrite, type GuardContext,
} from '../src/main/pages/page-file-guard';
import { canonicalize } from '../src/shared/artifacts/canonicalize';

const posix = process.platform !== 'win32';
let home: string;
let folder: string;
let ctx: GuardContext;

beforeAll(() => {
  home = canonicalize(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-guard-'))), null);
  folder = `${home}/Photos`;
  fs.mkdirSync(`${folder}/2026`, { recursive: true });
  fs.writeFileSync(`${folder}/a.txt`, 'hello');
  fs.writeFileSync(`${folder}/2026/b.txt`, 'inner');
  fs.writeFileSync(`${folder}/.env`, 'SECRET=1');
  fs.writeFileSync(`${home}/outside.txt`, 'not yours');
  fs.mkdirSync(`${home}/.ssh`);
  fs.writeFileSync(`${home}/.ssh/id_ed25519`, 'key');
  fs.mkdirSync(`${home}/app-data`);
  if (posix) {
    fs.symlinkSync(`${home}/outside.txt`, `${folder}/link-out.txt`);
    fs.symlinkSync(home, `${folder}/home-link`);
    fs.linkSync(`${home}/outside.txt`, `${folder}/hard.txt`);
    execFileSync('mkfifo', [`${folder}/pipe`]);
  }
  ctx = { home, protectedRoots: [`${home}/app-data`] };
});
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

describe('names', () => {
  it.each(['..', '.', '', 'a:b', 'file.txt:stream', 'con', 'NUL.txt', 'lpt1', 'end.', 'end ', 'a\0b', 'a\\b', 'x'.repeat(256)])(
    'refuses %j', (s) => expect(badSegment(s)).toBe(true));
  it('allows ordinary names', () => expect(badSegment('Holiday 2026.jpg')).toBe(false));
  it('cleans relative paths', () => {
    expect(cleanRelative('2026/b.txt')).toEqual(['2026', 'b.txt']);
    expect(cleanRelative('')).toEqual([]);
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', '~/x', 'c:/x', 'a//b', 'a/']) expect(cleanRelative(bad)).toBeNull();
  });
  it('confines `all` paths to home', () => {
    expect(cleanUnderHome('~/Photos/a.txt', home)).toEqual(['Photos', 'a.txt']);
    expect(cleanUnderHome(`${home}/Photos`, home)).toEqual(['Photos']);
    expect(cleanUnderHome(home, home)).toEqual([]);
    expect(cleanUnderHome('/etc/passwd', home)).toBeNull();
    expect(cleanUnderHome(`${home}/../x`, home)).toBeNull();
    expect(cleanUnderHome(`${home}-other/x`, home)).toBeNull();
  });
});

describe('deny lists', () => {
  it('never reads secrets', () => {
    for (const p of ['.ssh/id_ed25519', 'proj/.env', 'proj/.env.local', 'proj/secrets.json', 'w/wallet.dat', '.bashrc', 'a/b.keystore', 'x/.git/config', '.var/app/x', 'y.pem']) {
      expect(isReadDenied(`${home}/${p}`, ctx), p).toBe(true);
    }
    expect(isReadDenied(`${home}/Photos/a.txt`, ctx)).toBe(false);
  });
  it('never writes places that run later', () => {
    for (const p of ['.bashrc', '.zshrc', '.config/autostart/x.desktop', '.config/systemd/user/x.service', '.local/bin/x', '.claude/settings.json', '.gitconfig']) {
      expect(isWriteDenied(`${home}/${p}`, ctx, 'all'), p).toBe(true);
    }
    expect(isWriteDenied(`${home}/app-data/x`, ctx, 'folder')).toBe(true);
    expect(isWriteDenied('/etc/x', ctx, 'all')).toBe(true);
    expect(isWriteDenied(`${home}/.somethingrc`, ctx, 'all')).toBe(true);
    expect(isWriteDenied(`${home}/Photos/new.txt`, ctx, 'folder')).toBe(false);
  });
  it('refuses home, outside, secret and app folders as a page folder', () => {
    expect(folderChoiceProblem(home, ctx)).not.toBeNull();
    expect(folderChoiceProblem('/etc', ctx)).not.toBeNull();
    expect(folderChoiceProblem(`${home}/.ssh`, ctx)).not.toBeNull();
    expect(folderChoiceProblem(`${home}/.config`, ctx)).not.toBeNull();
    expect(folderChoiceProblem(`${home}/app-data`, ctx)).not.toBeNull();
    expect(folderChoiceProblem(folder, ctx)).toBeNull();
  });
});

describe('opening, confined', () => {
  const read = async (rel: string, folderLevel = true) => {
    const r = await openForRead(folder, cleanRelative(rel) ?? ['..'], ctx, folderLevel);
    if ('refused' in r) return r;
    const text = (await r.fh.readFile()).toString();
    await r.fh.close();
    return { text };
  };

  it('reads a file inside', async () => {
    expect(await read('a.txt')).toEqual({ text: 'hello' });
    expect(await read('2026/b.txt')).toEqual({ text: 'inner' });
  });
  it('refuses a denied file inside the folder', async () => expect(await read('.env')).toHaveProperty('refused'));
  it.runIf(posix)('refuses a link that leads out', async () => {
    expect(await read('link-out.txt')).toHaveProperty('refused');
    expect(await read('home-link/outside.txt')).toHaveProperty('refused');
  });
  it.runIf(posix)('refuses a hard link at folder level', async () => expect(await read('hard.txt')).toHaveProperty('refused'));
  it.runIf(posix)('refuses a pipe without hanging', async () => expect(await read('pipe')).toHaveProperty('refused'));

  it('creates only new files, never over an existing one', async () => {
    const r = await openForWrite(folder, ['new.txt'], ctx, 'folder', 'new');
    expect(r).not.toHaveProperty('refused');
    if (!('refused' in r)) { await r.fh.writeFile('made'); await r.fh.close(); }
    expect(fs.readFileSync(`${folder}/new.txt`, 'utf8')).toBe('made');
    expect(await openForWrite(folder, ['new.txt'], ctx, 'folder', 'new')).toHaveProperty('refused');
  });
  it.runIf(posix)('does not write through a planted link', async () => {
    expect(await openForWrite(folder, ['link-out.txt'], ctx, 'folder', 'replace')).toHaveProperty('refused');
    expect(await openForWrite(folder, ['home-link', 'fresh.txt'], ctx, 'folder', 'new')).toHaveProperty('refused');
    expect(fs.readFileSync(`${home}/outside.txt`, 'utf8')).toBe('not yours');
    expect(fs.existsSync(`${home}/fresh.txt`)).toBe(false);
  });
  it('refuses a folder swapped away', async () => {
    expect(await openForRead(`${home}/Gone`, ['a.txt'], ctx, true)).toHaveProperty('refused');
  });

  it('lists only ordinary visible entries', async () => {
    const r = await listInside(folder, [], ctx, 100);
    if ('refused' in r) throw new Error(r.refused);
    const names = r.entries.map((e) => e.name).sort();
    expect(names).toContain('a.txt');
    expect(names).toContain('2026');
    expect(names).not.toContain('.env');
    expect(names).not.toContain('pipe');
    expect(r.entries.find((e) => e.name === 'a.txt')?.size).toBe(5);
  });
  it('caps a big listing and says so', async () => {
    const r = await listInside(folder, [], ctx, 1);
    if ('refused' in r) throw new Error(r.refused);
    expect(r.entries).toHaveLength(1);
    expect(r.more).toBe(true);
  });
});
