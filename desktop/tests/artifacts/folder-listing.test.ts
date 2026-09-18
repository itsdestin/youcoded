// artifacts:list-folder — one folder of a project, read from disk, paged
// (Project Files at any size, Stage 1, spec 2026-09-18). Real folders under
// os.tmpdir(), because every promise here is about what the disk holds:
//   - no depth limit, and the folders whole-project search skips (dot-folders,
//     node_modules, nested git repos) are ordinary folders here;
//   - what is NOT listed, and only that: links, credential folders, import temps;
//   - paging is stable, files come first, 'recent' sorts newest first;
//   - a folder that cannot be read answers its real reason, never an empty list.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listFolderPage, clearFolderSnapshots } from '../../src/main/artifacts/folder-listing';

let root: string;
const write = (rel: string, body = 'x') => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
};
const names = (page: any) => [...page.files.map((f: any) => f.path), ...page.folders.map((d: any) => `${d.path}/`)];

const canSymlink = (() => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-folder-listing-probe-'));
  try { fs.writeFileSync(path.join(probe, 't'), 'x'); fs.symlinkSync('t', path.join(probe, 'l')); return true; }
  catch { return false; }
  finally { fs.rmSync(probe, { recursive: true, force: true }); }
})();
// Running as root ignores permission bits, so the permission case would pass
// for the wrong reason (or fail) there.
const canDenyRead = process.platform !== 'win32' && process.getuid?.() !== 0;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-folder-listing-')));
  write('b.md'); write('a.md');
  write('docs/spec.md'); write('docs/plan.md'); write('docs/inner/deeper.md');
  write('a/b/c/d/e/f/g/h/deep.md');
  write('.hidden/secret-plan.md');
  write('node_modules/pkg/index.js');
  write('nested-repo/.git/HEAD', 'ref: refs/heads/main');
  write('nested-repo/readme.md');
  write('.ssh/id_ed25519');
  write('.youcoded-import-1-2-x.md.part');
  write('package-lock.json', '{}');
  if (canSymlink) fs.symlinkSync(os.tmpdir(), path.join(root, 'link-out'));
});
afterAll(() => {
  if (canDenyRead) try { fs.chmodSync(path.join(root, 'locked'), 0o755); } catch { /* not made */ }
  fs.rmSync(root, { recursive: true, force: true });
});
beforeEach(() => clearFolderSnapshots());

describe('what a folder lists', () => {
  it('lists files first by name, then folders by name — including the ones search skips', async () => {
    const page: any = await listFolderPage(root, '');
    expect(page.ok).toBe(true);
    expect(names(page)).toEqual([
      'a.md', 'b.md', 'package-lock.json',
      '.hidden/', 'a/', 'docs/', 'nested-repo/', 'node_modules/',
    ]);
  });

  it('hides links, credential folders and import temp files — and nothing else', async () => {
    const all = names(await listFolderPage(root, ''));
    expect(all).not.toContain('link-out/');
    expect(all).not.toContain('link-out');
    expect(all).not.toContain('.ssh/');
    expect(all.some((n: string) => n.includes('.youcoded-import-'))).toBe(false);
  });

  it('opens a folder deeper than the old six-level limit, and inside a nested repo and node_modules', async () => {
    expect(names(await listFolderPage(root, 'a/b/c/d/e/f/g/h'))).toEqual(['a/b/c/d/e/f/g/h/deep.md']);
    expect(names(await listFolderPage(root, 'nested-repo'))).toEqual(['nested-repo/readme.md', 'nested-repo/.git/']);
    expect(names(await listFolderPage(root, 'node_modules/pkg'))).toEqual(['node_modules/pkg/index.js']);
  });

  it('gives each subfolder its direct item count and first files as a preview', async () => {
    const page: any = await listFolderPage(root, '');
    const docs = page.folders.find((d: any) => d.name === 'docs');
    expect(docs.itemCount).toBe(3); // plan.md, spec.md, inner/
    expect(docs.samples.map((s: any) => s.path)).toEqual(['docs/plan.md', 'docs/spec.md']);
  });

  it('builds the same file record discovery does (id == relative path, a real time)', async () => {
    const page: any = await listFolderPage(root, 'docs');
    const spec = page.files.find((f: any) => f.path === 'docs/spec.md');
    expect(spec).toMatchObject({ id: 'docs/spec.md', kind: 'internal', discovered: true, status: 'active' });
    expect(Date.parse(spec.lastModified)).not.toBeNaN();
  });
});

describe('paging and sort', () => {
  let big: string;
  beforeAll(() => {
    big = 'big';
    for (let i = 0; i < 25; i++) write(`big/f-${String(i).padStart(2, '0')}.txt`);
    write('big/sub/x.txt');
  });

  it('pages without repeating or skipping an entry, files before folders', async () => {
    const seen: string[] = [];
    let offset = 0;
    for (;;) {
      const page: any = await listFolderPage(root, big, { offset, limit: 10 });
      seen.push(...names(page));
      offset += page.files.length + page.folders.length;
      expect(page.total).toBe(26);
      if (!page.hasMore) break;
    }
    expect(seen).toHaveLength(26);
    expect(new Set(seen).size).toBe(26);
    expect(seen[25]).toBe('big/sub/');
  });

  it("sorts 'recent' newest first", async () => {
    write('big/f-00.txt', 'touched');
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(root, 'big/f-00.txt'), future, future);
    const page: any = await listFolderPage(root, big, { sort: 'recent', limit: 1 });
    expect(page.files[0].path).toBe('big/f-00.txt');
  });
});

describe('a folder that cannot be listed says why', () => {
  it('not-found for a folder that is not there', async () => {
    expect(await listFolderPage(root, 'gone')).toEqual({ ok: false, error: 'not-found' });
  });
  it('not-a-folder for a file', async () => {
    expect(await listFolderPage(root, 'a.md')).toMatchObject({ ok: false, error: 'not-a-folder' });
  });
  it('outside-project for a path that climbs out', async () => {
    expect(await listFolderPage(root, '../')).toEqual({ ok: false, error: 'outside-project' });
    expect(await listFolderPage(root, 'docs/../../x')).toEqual({ ok: false, error: 'outside-project' });
  });
  it.skipIf(!canSymlink)('outside-project for a link that leads out, even named directly', async () => {
    expect(await listFolderPage(root, 'link-out')).toEqual({ ok: false, error: 'outside-project' });
  });
  it('protected-path for a credential folder, even named directly', async () => {
    expect(await listFolderPage(root, '.ssh')).toEqual({ ok: false, error: 'protected-path' });
  });
  it.skipIf(!canDenyRead)('permission-denied when the system refuses', async () => {
    write('locked/inside.md');
    fs.chmodSync(path.join(root, 'locked'), 0o000);
    expect(await listFolderPage(root, 'locked')).toEqual({ ok: false, error: 'permission-denied' });
  });
  it('bad-request for a malformed call', async () => {
    expect(await listFolderPage(undefined, '')).toEqual({ ok: false, error: 'bad-request' });
    expect(await listFolderPage(root, 7 as any)).toEqual({ ok: false, error: 'bad-request' });
  });
});
