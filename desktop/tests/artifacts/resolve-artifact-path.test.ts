// resolveArtifactPath — the ONE host lookup behind tapping a file path in chat
// (artifacts:resolve-path, 2026-09-11). It replaced downloading the whole
// project list (3,090 records, ~1 MB to a phone) to find one file, and it has
// to answer a phone honestly for a file discovery never lists (inside a nested
// git repo) without becoming a way to ask "does this path exist?" about
// anything on the computer.
//
// Real folders, real files, a real symlink, under os.tmpdir(); HOME is the
// per-run test sandbox (vitest.config.ts), so the `~` case writes there.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveArtifactPath } from '../../src/main/artifacts/read-service';
import { discoverProjectFiles, discoveredFileRecord } from '../../src/main/artifacts/project-file-discovery';
import { SIDECAR_SCHEMA_VERSION } from '../../src/shared/artifacts/types';

const canSymlink = (() => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-resolve-symlink-probe-'));
  try {
    fs.writeFileSync(path.join(probeDir, 'target'), 'x');
    fs.symlinkSync('target', path.join(probeDir, 'link'), 'file');
    return true;
  } catch { return false; }
  finally { try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch { /* best effort */ } }
})();

let root: string;
let outside: string;
let homeRoot: string;

function record(partial: Record<string, unknown>) {
  const at = new Date().toISOString();
  return {
    kind: 'internal', absolutePath: null, lastModified: at, status: 'active',
    versions: [{ id: 'v1', kind: 'create', at, sessionId: 'sess-1' }],
    comments: [], tags: [],
    ...partial,
  };
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-resolve-')));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-resolve-outside-')));

  fs.writeFileSync(path.join(root, 'notes.md'), '# tracked\n');
  fs.writeFileSync(path.join(root, 'plain.txt'), 'untracked, discovery lists it\n');
  // A nested git repo: discovery stops here, so its files are never listed —
  // the exact case (wecoded-themes/CLAUDE.md inside youcoded-dev) that fell
  // through to a write a phone cannot make.
  fs.mkdirSync(path.join(root, 'nested-repo', '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'nested-repo', 'CLAUDE.md'), '# the nested one\n');
  fs.mkdirSync(path.join(root, 'folder'));
  fs.mkdirSync(path.join(root, '.ssh'));
  fs.writeFileSync(path.join(root, '.ssh', 'id_rsa'), '-----BEGIN KEY-----\n');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside the project\n');
  fs.writeFileSync(path.join(outside, 'tracked-ext.xlsx'), 'xlsx');
  if (canSymlink) fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link-out.txt'));

  fs.mkdirSync(path.join(root, '.youcoded'));
  fs.writeFileSync(path.join(root, '.youcoded', 'artifacts.json'), JSON.stringify({
    $schema: SIDECAR_SCHEMA_VERSION, projectId: 'resolve', name: 'resolve',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    artifacts: [
      record({ id: 'rec-notes', path: 'notes.md' }),
      record({ id: 'rec-gone', path: 'gone.md' }),
      record({ id: 'rec-ext', kind: 'external', path: 'tracked-ext.xlsx', absolutePath: path.join(outside, 'tracked-ext.xlsx') }),
    ],
    manualExcludes: [], manualIncludes: [],
  }));

  homeRoot = path.join(os.homedir(), `yc-resolve-home-${process.pid}`);
  fs.mkdirSync(homeRoot, { recursive: true });
  fs.writeFileSync(path.join(homeRoot, 'a.md'), 'in the home folder\n');
});

afterAll(async () => {
  for (const dir of [root, outside, homeRoot]) {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

afterEach(() => { vi.restoreAllMocks(); });

/** Every path any fs.promises call was handed while `fn` ran. */
async function fsPathsTouchedBy(fn: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  const spies: Array<{ mockRestore: () => void }> = [];
  for (const name of ['realpath', 'stat', 'lstat', 'access', 'open', 'readFile', 'readdir'] as const) {
    const original = (fs.promises as any)[name].bind(fs.promises);
    spies.push(vi.spyOn(fs.promises as any, name).mockImplementation((...args: any[]) => {
      if (typeof args[0] === 'string') seen.push(args[0]);
      return original(...args);
    }));
  }
  // Restored here, not only in afterEach: one test calls this several times,
  // and a spy wrapped around the previous spy recursed until the stack blew.
  try { await fn(); } finally { for (const s of spies) s.mockRestore(); }
  return seen;
}

describe('a tracked file resolves to its record', () => {
  it('an internal record, by absolute or relative path', async () => {
    expect(await resolveArtifactPath(root, path.join(root, 'notes.md'))).toMatchObject({ ok: true, artifact: { id: 'rec-notes' } });
    expect(await resolveArtifactPath(root, 'notes.md')).toMatchObject({ ok: true, artifact: { id: 'rec-notes' } });
  });

  it('a tracked record whose file is gone still resolves (the viewer shows it as no longer on disk)', async () => {
    expect(await resolveArtifactPath(root, path.join(root, 'gone.md'))).toMatchObject({ ok: true, artifact: { id: 'rec-gone' } });
  });

  it('an external record, by its absolute path outside the folder', async () => {
    expect(await resolveArtifactPath(root, path.join(outside, 'tracked-ext.xlsx'))).toMatchObject({ ok: true, artifact: { id: 'rec-ext' } });
  });
});

describe('an untracked file inside the folder resolves to a discovered record', () => {
  it('a file inside a nested git repo, which discovery never lists', async () => {
    const abs = path.join(root, 'nested-repo', 'CLAUDE.md');
    const res = await resolveArtifactPath(root, abs);
    expect(res).toEqual({
      ok: true,
      artifact: discoveredFileRecord('nested-repo/CLAUDE.md', fs.statSync(abs).mtime.toISOString()),
    });
  });

  it("the record is exactly the one discovery builds for the same file, so the drawer can't tell them apart", async () => {
    const discovered = (await discoverProjectFiles(root)).files.find((f) => f.path === 'plain.txt');
    expect(discovered).toBeDefined();
    const res = await resolveArtifactPath(root, path.join(root, 'plain.txt'));
    expect(res).toEqual({ ok: true, artifact: discovered });
  });

  it('`~` expands to the home folder', async () => {
    const res = await resolveArtifactPath(homeRoot, `~/${path.basename(homeRoot)}/a.md`);
    expect(res).toMatchObject({ ok: true, artifact: { id: 'a.md', path: 'a.md', discovered: true } });
  });
});

describe('every refusal names what is actually true', () => {
  it('a missing file inside the folder → not-found', async () => {
    expect(await resolveArtifactPath(root, path.join(root, 'nope.md'))).toEqual({ ok: false, error: 'not-found' });
  });

  it('a folder → not-a-file', async () => {
    expect(await resolveArtifactPath(root, path.join(root, 'folder'))).toEqual({ ok: false, error: 'not-a-file' });
  });

  it('a credential location inside the folder → protected-path', async () => {
    expect(await resolveArtifactPath(root, path.join(root, '.ssh', 'id_rsa'))).toEqual({ ok: false, error: 'protected-path' });
  });

  it.skipIf(!canSymlink)('a link inside the folder pointing outside it → outside-project', async () => {
    expect(await resolveArtifactPath(root, path.join(root, 'link-out.txt'))).toEqual({ ok: false, error: 'outside-project' });
  });

  it('a path that climbs out with .. → outside-project', async () => {
    expect(await resolveArtifactPath(root, `${root}/../${path.basename(outside)}/secret.txt`)).toEqual({ ok: false, error: 'outside-project' });
  });

  it('a malformed call → bad-request', async () => {
    expect(await resolveArtifactPath(root, 42 as unknown as string)).toEqual({ ok: false, error: 'bad-request' });
    expect(await resolveArtifactPath('', 'notes.md')).toEqual({ ok: false, error: 'bad-request' });
  });
});

describe('no existence oracle', () => {
  it('outside the folder, the file itself is never looked at', async () => {
    const target = path.join(outside, 'secret.txt');
    let res: unknown;
    const touched = await fsPathsTouchedBy(async () => { res = await resolveArtifactPath(root, target); });
    expect(res).toEqual({ ok: false, error: 'outside-project' });
    expect(touched.filter((p) => p.startsWith(outside))).toEqual([]);
  });

  it('the spy does see the target when the lookup legitimately checks it (so the check above is not vacuous)', async () => {
    const target = path.join(root, 'nope.md');
    const touched = await fsPathsTouchedBy(() => resolveArtifactPath(root, target));
    expect(touched).toContain(target);
  });

  it('trackedOnly: a tracked file still resolves; anything else is not-allowed without looking at it', async () => {
    expect(await resolveArtifactPath(root, path.join(root, 'notes.md'), { trackedOnly: true }))
      .toMatchObject({ ok: true, artifact: { id: 'rec-notes' } });
    for (const target of [path.join(root, 'plain.txt'), path.join(root, 'nope.md'), path.join(root, '.ssh', 'id_rsa'), path.join(outside, 'secret.txt')]) {
      let res: unknown;
      const touched = await fsPathsTouchedBy(async () => { res = await resolveArtifactPath(root, target, { trackedOnly: true }); });
      expect(res, target).toEqual({ ok: false, error: 'not-allowed' });
      expect(touched, target).not.toContain(target);
    }
  });
});
