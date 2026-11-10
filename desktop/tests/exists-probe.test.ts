// exists-probe answers exactly what fs.access would, but asks about a missing folder once, not once per file
// inside it (2026-10-22 freeze hunt: thousands of failed accesses allocated an Error each).
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExistsProbe } from '../src/main/artifacts/exists-probe';

describe('createExistsProbe', () => {
  afterEach(() => vi.restoreAllMocks());

  it('answers the same as fs.access for files, missing files and missing folders', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
    fs.mkdirSync(path.join(dir, 'a'));
    fs.writeFileSync(path.join(dir, 'a', 'here.md'), 'x');
    const paths = [path.join(dir, 'a', 'here.md'), path.join(dir, 'a', 'gone.md'), path.join(dir, 'nodir', 'x', 'y.md'), dir];
    const probe = createExistsProbe();
    const direct = await Promise.all(paths.map((p) => fs.promises.access(p).then(() => true, () => false)));
    expect(await probe.existsAll(paths)).toEqual(direct);
    expect(direct).toEqual([true, false, false, true]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('asks the disk once for a deleted folder, however many files were tracked inside it', async () => {
    const access = vi.spyOn(fs.promises, 'access');
    const root = path.join(os.tmpdir(), 'probe-missing-' + process.pid);
    const files = Array.from({ length: 500 }, (_, i) => path.join(root, 'deep', 'er', `f${i}.md`));
    const out = await createExistsProbe().existsAll(files);
    expect(out.every((v) => v === false)).toBe(true);
    // Each folder on the way up is asked about at most once (never one check per file). The ceiling is
    // counted from the real path, not a fixed 5: the temp folder is 2 levels deep on Linux but ~6 on macOS
    // (/private/var/folders/xx/yyy/T) and ~7 on Windows (C:\\Users\\x\\AppData\\Local\\Temp).
    let folders = 0;
    for (let d = path.dirname(files[0]); ; d = path.dirname(d)) { folders++; if (path.dirname(d) === d) break; }
    expect(access.mock.calls.length).toBeLessThanOrEqual(folders);
    expect(access.mock.calls.length).toBeLessThan(files.length / 10);
  });
});
