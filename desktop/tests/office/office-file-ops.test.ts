import { chmod, link, lstat, mkdtemp, readlink, stat, symlink, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyBeside, copyName, MAX_COPIES, nameProblem, NameTaken, renameNoClobber } from '../../src/main/office/office-file-ops';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'office-file-ops-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('nameProblem', () => {
  it('accepts a plain name with the same extension, in any case', () => {
    expect(nameProblem('Budget 2026.docx', 'memo.docx')).toBeNull();
    expect(nameProblem('Budget.DOCX', 'memo.docx')).toBeNull();
    expect(nameProblem('CONSOLE.docx', 'memo.docx')).toBeNull(); // only the exact device names are reserved
  });
  it('refuses reserved names even with a second extension or trailing spaces', () => {
    expect(nameProblem('con.tar.docx', 'a.docx')).toMatch(/keeps for itself/);
    expect(nameProblem('NUL .docx', 'a.docx')).toMatch(/keeps for itself/);
    expect(nameProblem('com1.docx', 'a.docx')).toMatch(/keeps for itself/);
  });
  it('refuses control characters and non-text input', () => {
    expect(nameProblem('a\u0001b.docx', 'a.docx')).toMatch(/control characters/);
    expect(nameProblem(42, 'a.docx')).toBe('Type a name for this file.');
  });
  it('counts bytes, not letters, for the 255 limit', () => {
    expect(nameProblem('é'.repeat(130) + '.docx', 'a.docx')).toBe('That name is too long.');
  });
});

describe('renameNoClobber', () => {
  it('moves the file and leaves nothing under the old name', async () => {
    await writeFile(path.join(dir, 'a.docx'), 'A');
    await renameNoClobber(path.join(dir, 'a.docx'), path.join(dir, 'b.docx'));
    expect(await readdir(dir)).toEqual(['b.docx']);
    expect(await readFile(path.join(dir, 'b.docx'), 'utf8')).toBe('A');
  });
  it('never replaces an existing file', async () => {
    await writeFile(path.join(dir, 'a.docx'), 'A');
    await writeFile(path.join(dir, 'b.docx'), 'B');
    await expect(renameNoClobber(path.join(dir, 'a.docx'), path.join(dir, 'b.docx'))).rejects.toBeInstanceOf(NameTaken);
    expect(await readFile(path.join(dir, 'b.docx'), 'utf8')).toBe('B');
    expect(await readFile(path.join(dir, 'a.docx'), 'utf8')).toBe('A');
  });
});

describe('renameNoClobber races and case', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it('refuses, and keeps the other file, when that name appears just after the existence check', async () => {
    await writeFile(path.join(dir, 'a.docx'), 'A');
    await writeFile(path.join(dir, 'b.docx'), 'B');
    // The check says "free" (a stale answer); only the atomic link can still tell the truth.
    vi.spyOn(fsp, 'lstat').mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'ENOENT' }));
    await expect(renameNoClobber(path.join(dir, 'a.docx'), path.join(dir, 'b.docx'))).rejects.toBeInstanceOf(NameTaken);
    expect(await readFile(path.join(dir, 'b.docx'), 'utf8')).toBe('B');
  });
  it('falls back to check-then-rename where the disk has no hard links', async () => {
    await writeFile(path.join(dir, 'a.docx'), 'A');
    vi.spyOn(fsp, 'link').mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'EPERM' }));
    await renameNoClobber(path.join(dir, 'a.docx'), path.join(dir, 'b.docx'));
    expect(await readdir(dir)).toEqual(['b.docx']);
  });
  it('allows a case-only rename: the "taken" name is the very same file', async () => {
    // WHY a hard link stands in: this disk tells names apart by case, a Windows/Mac disk does not;
    // either way the target is the same file (same device and inode), which is what is checked.
    await writeFile(path.join(dir, 'a.docx'), 'A');
    await link(path.join(dir, 'a.docx'), path.join(dir, 'A.docx'));
    await expect(renameNoClobber(path.join(dir, 'a.docx'), path.join(dir, 'A.docx'))).resolves.toBeUndefined();
    // rename(2) between two names of one file does nothing, so the old name must be removed too.
    expect(await readdir(dir)).toEqual(['A.docx']);
  });
  it('says "taken" (not a crash) when the name is a dangling symlink', async () => {
    await writeFile(path.join(dir, 'a.docx'), 'A');
    await symlink(path.join(dir, 'nowhere.docx'), path.join(dir, 'b.docx'));
    await expect(renameNoClobber(path.join(dir, 'a.docx'), path.join(dir, 'b.docx'))).rejects.toBeInstanceOf(NameTaken);
    expect(await readFile(path.join(dir, 'a.docx'), 'utf8')).toBe('A');
  });
  it('treats a vanished source as "taken" rather than crashing in the same-file check', async () => {
    await writeFile(path.join(dir, 'b.docx'), 'B');
    await expect(renameNoClobber(path.join(dir, 'gone.docx'), path.join(dir, 'b.docx'))).rejects.toBeInstanceOf(NameTaken);
  });
  it('moves a symlink itself, leaving its target alone, and never over another link to the same target', async () => {
    await writeFile(path.join(dir, 'target.docx'), 'T');
    await symlink(path.join(dir, 'target.docx'), path.join(dir, 'one.docx'));
    await symlink(path.join(dir, 'target.docx'), path.join(dir, 'two.docx'));
    await expect(renameNoClobber(path.join(dir, 'one.docx'), path.join(dir, 'two.docx'))).rejects.toBeInstanceOf(NameTaken);
    await renameNoClobber(path.join(dir, 'one.docx'), path.join(dir, 'three.docx'));
    expect((await lstat(path.join(dir, 'three.docx'))).isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(dir, 'three.docx'))).toBe(path.join(dir, 'target.docx'));
    expect(await readFile(path.join(dir, 'target.docx'), 'utf8')).toBe('T');
    expect((await readdir(dir)).sort()).toEqual(['target.docx', 'three.docx', 'two.docx']);
  });
});

describe('copyBeside', () => {
  const allow = async (p: string) => p;
  it('names copies (copy), (copy 2) and never overwrites', async () => {
    expect(copyName('a b.docx', 1)).toBe('a b (copy).docx');
    expect(copyName('a b.docx', 2)).toBe('a b (copy 2).docx');
    await writeFile(path.join(dir, 'a.docx'), 'A');
    await writeFile(path.join(dir, 'a (copy).docx'), 'keep');
    const made = await copyBeside(path.join(dir, 'a.docx'), allow);
    expect(path.basename(made)).toBe('a (copy 2).docx');
    expect(await readFile(path.join(dir, 'a (copy).docx'), 'utf8')).toBe('keep');
  });
  it('gives up after a sane number of copies', async () => {
    await writeFile(path.join(dir, 'a.docx'), 'A');
    for (let n = 1; n <= MAX_COPIES; n++) await writeFile(path.join(dir, copyName('a.docx', n)), 'x');
    await expect(copyBeside(path.join(dir, 'a.docx'), allow)).rejects.toBeInstanceOf(NameTaken);
  });
  it('makes the copy of a read-only file writable by its owner', async () => {
    await writeFile(path.join(dir, 'a.docx'), 'A');
    await chmod(path.join(dir, 'a.docx'), 0o444);
    const made = await copyBeside(path.join(dir, 'a.docx'), allow);
    expect((await stat(made)).mode & 0o200).toBe(0o200);
  });
  it('copies a symlink\'s bytes into a regular file named after the link', async () => {
    await writeFile(path.join(dir, 'target.docx'), 'T');
    await symlink(path.join(dir, 'target.docx'), path.join(dir, 'report.docx'));
    const made = await copyBeside(path.join(dir, 'report.docx'), allow);
    expect(path.basename(made)).toBe('report (copy).docx');
    expect((await lstat(made)).isSymbolicLink()).toBe(false);
    expect(await readFile(made, 'utf8')).toBe('T');
  });
  it('writes nothing when the folder check refuses', async () => {
    await writeFile(path.join(dir, 'a.docx'), 'A');
    await expect(copyBeside(path.join(dir, 'a.docx'), async () => { throw new Error('no'); })).rejects.toThrow('no');
    expect(await readdir(dir)).toEqual(['a.docx']);
  });
});
