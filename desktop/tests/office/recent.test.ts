import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfficeFile } from '../../src/shared/office-types';

// WHY wrapped, not replaced: the real casWrite still writes, and the test can see that Recent's
// file went through it (the app's one guarded writer for shared JSON files).
vi.mock('../../src/main/artifacts/cas-write', async (orig) => {
  const real = await orig<typeof import('../../src/main/artifacts/cas-write')>();
  return { ...real, casWrite: vi.fn(real.casWrite) };
});

import { casWrite } from '../../src/main/artifacts/cas-write';
import * as recent from '../../src/main/office/recent';

let dir: string;
let userData: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'office-recent-test-'));
  userData = path.join(dir, 'userData');
  vi.mocked(casWrite).mockClear();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** A real file on disk (Recent drops entries whose file is gone), described as Office lists it. */
async function aFile(name: string, at = '2026-09-28T10:00:00.000Z'): Promise<OfficeFile> {
  const p = path.join(dir, name);
  await writeFile(p, 'x');
  return { path: p, name, kind: 'document', folder: path.basename(dir), at };
}

describe('Recent (files opened in Office)', () => {
  it('lists nothing before any file was opened', async () => {
    await expect(recent.list(userData)).resolves.toEqual([]);
  });

  it('lists the most recently opened file first', async () => {
    const a = await aFile('a.docx', '2026-09-28T10:00:00.000Z');
    const b = await aFile('b.docx', '2026-09-28T11:00:00.000Z');
    await recent.add(userData, a);
    await recent.add(userData, b);
    expect((await recent.list(userData)).map((f) => f.name)).toEqual(['b.docx', 'a.docx']);
  });

  it('keeps one entry per file: opening it again moves it to the top with the new time', async () => {
    const a = await aFile('a.docx');
    const b = await aFile('b.docx');
    await recent.add(userData, a);
    await recent.add(userData, b);
    await recent.add(userData, { ...a, at: '2026-09-28T12:00:00.000Z' });
    const list = await recent.list(userData);
    expect(list.map((f) => f.name)).toEqual(['a.docx', 'b.docx']);
    expect(list[0].at).toBe('2026-09-28T12:00:00.000Z');
  });

  it('keeps only the 12 most recent files', async () => {
    for (let i = 1; i <= 14; i++) await recent.add(userData, await aFile(`f${i}.docx`));
    const list = await recent.list(userData);
    expect(list).toHaveLength(12);
    expect(list[0].name).toBe('f14.docx');
    expect(list[11].name).toBe('f3.docx');
  });

  it('leaves out a file that has since been deleted', async () => {
    const a = await aFile('a.docx');
    const b = await aFile('b.docx');
    await recent.add(userData, a);
    await recent.add(userData, b);
    await unlink(a.path);
    expect((await recent.list(userData)).map((f) => f.name)).toEqual(['b.docx']);
  });

  it('writes its file through the guarded compare-and-swap writer, with an updatedAt token', async () => {
    await recent.add(userData, await aFile('a.docx'));
    await recent.add(userData, await aFile('b.docx'));
    expect(casWrite).toHaveBeenCalledTimes(2);
    const target = path.join(userData, 'office-recent.json');
    // The first write creates the file (expects nothing there); the second expects the first's token.
    expect(vi.mocked(casWrite).mock.calls[0][0]).toBe(target);
    expect(vi.mocked(casWrite).mock.calls[0][1]).toBeNull();
    const first = JSON.parse(vi.mocked(casWrite).mock.calls[0][2]);
    expect(vi.mocked(casWrite).mock.calls[1][1]).toBe(first.updatedAt);
    const saved = JSON.parse(await readFile(target, 'utf8'));
    expect(typeof saved.updatedAt).toBe('string');
    expect(saved.files.map((f: OfficeFile) => f.name)).toEqual(['b.docx', 'a.docx']);
  });

  it('keeps every file when several are opened at once', async () => {
    const files = await Promise.all(['a', 'b', 'c', 'd'].map((n) => aFile(`${n}.docx`)));
    await Promise.all(files.map((f) => recent.add(userData, f)));
    expect((await recent.list(userData)).map((f) => f.name).sort()).toEqual(['a.docx', 'b.docx', 'c.docx', 'd.docx']);
  });

  it('starts over from an unreadable Recent file instead of failing', async () => {
    await rm(userData, { recursive: true, force: true });
    await import('node:fs/promises').then((fs) => fs.mkdir(userData, { recursive: true }));
    await writeFile(path.join(userData, 'office-recent.json'), '{not json');
    await expect(recent.list(userData)).resolves.toEqual([]);
    await recent.add(userData, await aFile('a.docx'));
    expect((await recent.list(userData)).map((f) => f.name)).toEqual(['a.docx']);
  });

  it('ignores entries in the file that are not well-formed', async () => {
    const good = await aFile('a.docx');
    await import('node:fs/promises').then((fs) => fs.mkdir(userData, { recursive: true }));
    await writeFile(path.join(userData, 'office-recent.json'), JSON.stringify({
      updatedAt: 't', files: [good, { path: 'relative.docx', name: 'x', kind: 'document', folder: 'x', at: 't' }, { path: good.path.replace('a.docx', 'b.docx'), kind: 'nope' }, 42],
    }));
    expect((await recent.list(userData)).map((f) => f.name)).toEqual(['a.docx']);
  });
});
