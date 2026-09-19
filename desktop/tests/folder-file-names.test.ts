// The "+ Add file" duplicate-name check reads the destination folder itself
// (artifacts:list-folder), names only, and stops once it reaches the folders.
// Code review 2026-09-18, F4/F5 — the check had no guard.
import { describe, it, expect, vi } from 'vitest';
import { folderFileNames } from '../src/renderer/components/project-view/folder-file-names';
import { folderPageFromRecords } from '../src/shared/artifacts/folder-page';

const rec = (path: string) => ({ id: path, path, kind: 'internal' } as any);

describe('folderFileNames', () => {
  it('collects every file name directly in the folder, across pages, never a folder or a deeper file', async () => {
    const records = [
      ...Array.from({ length: 2500 }, (_, i) => rec(`dest/f-${String(i).padStart(4, '0')}.md`)),
      rec('dest/package-lock.json'),
      rec('dest/sub/inner.md'),
    ];
    const listFolder = vi.fn(async (_id: string, dir: string, opts: any) => folderPageFromRecords(records, dir, opts));
    const names = await folderFileNames(listFolder, 'p1', 'dest');
    expect(names!.size).toBe(2501);
    expect(names!.has('f-2499.md')).toBe(true);
    // Noise files count now: the old whole-project list skipped them.
    expect(names!.has('package-lock.json')).toBe(true);
    expect(names!.has('sub')).toBe(false);
    expect(names!.has('inner.md')).toBe(false);
    // Names only, from the destination folder.
    expect(listFolder).toHaveBeenCalledWith('p1', 'dest', expect.objectContaining({ namesOnly: true, offset: 0 }));
  });

  it('stops at the first page that reaches the folders', async () => {
    const records = [rec('a.md'), ...Array.from({ length: 3000 }, (_, i) => rec(`d${i}/x.md`))];
    const listFolder = vi.fn(async (_id: string, dir: string, opts: any) => folderPageFromRecords(records, dir, opts));
    await folderFileNames(listFolder, 'p1', '');
    expect(listFolder).toHaveBeenCalledTimes(1);
  });

  it('answers null when the folder cannot be read', async () => {
    expect(await folderFileNames(async () => ({ ok: false, error: 'permission-denied' }), 'p1', 'x')).toBeNull();
  });
});
