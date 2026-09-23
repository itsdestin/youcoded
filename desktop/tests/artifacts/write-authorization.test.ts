// Pins the enforcement half of the D5 boundary against a REAL filesystem —
// especially the symlink cases, which no string-level check can cover: a link
// inside the project root pointing at ~/.ssh/config (or .git/) must be caught
// by resolving FIRST and policy-checking the resolution.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { authorizeArtifactRead, authorizeArtifactWrite, judgeRelativeRecord } from '../../src/main/artifacts/write-authorization';

let root: string;    // the project root
let outside: string; // a directory OUTSIDE the root, holding sensitive targets

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-auth-root-'));
  outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-auth-out-'));
});
afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
  await fs.promises.rm(outside, { recursive: true, force: true });
});

async function mk(rel: string, content = 'x'): Promise<string> {
  const p = path.join(root, rel);
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  await fs.promises.writeFile(p, content);
  return p;
}

describe('authorizeArtifactWrite', () => {
  it('allows a plain in-root file', async () => {
    const p = await mk('src/app.ts');
    const res = await authorizeArtifactWrite({ projectRoot: root, fullPath: p, mustStayInRoot: true });
    expect(res.ok).toBe(true);
  });

  it('denies .git and .youcoded (D5 denied tier)', async () => {
    const hook = await mk('.git/hooks/pre-commit', '#!/bin/sh');
    const sidecar = await mk('.youcoded/artifacts.json', '{}');
    for (const p of [hook, sidecar]) {
      const res = await authorizeArtifactWrite({ projectRoot: root, fullPath: p, mustStayInRoot: true });
      expect(res).toMatchObject({ ok: false, error: 'protected-path' });
    }
  });

  it('requires the confirmed flag for confirm-tier paths and accepts it', async () => {
    const env = await mk('.env', 'API_KEY=1');
    const refused = await authorizeArtifactWrite({ projectRoot: root, fullPath: env, mustStayInRoot: true });
    expect(refused).toMatchObject({ ok: false, error: 'needs-confirm' });
    const allowed = await authorizeArtifactWrite({ projectRoot: root, fullPath: env, mustStayInRoot: true, confirmed: true });
    expect(allowed.ok).toBe(true);
  });

  it('a symlink inside the root cannot reach a protected target (the string checks all pass — only realpath catches it)', async () => {
    const secret = path.join(outside, '.ssh/config');
    await fs.promises.mkdir(path.dirname(secret), { recursive: true });
    await fs.promises.writeFile(secret, 'Host *');
    const link = path.join(root, 'notes.md');
    await fs.promises.symlink(secret, link);
    // mustStayInRoot=true (discovered file): fails in-root on the RESOLVED path
    const asDiscovered = await authorizeArtifactWrite({ projectRoot: root, fullPath: link, mustStayInRoot: true });
    expect(asDiscovered).toMatchObject({ ok: false, error: 'artifact-not-found' });
    // mustStayInRoot=false (tracked external): the deny-list catches the target
    const asExternal = await authorizeArtifactWrite({ projectRoot: root, fullPath: link, mustStayInRoot: false });
    expect(asExternal).toMatchObject({ ok: false, error: 'protected-path' });
  });

  it('rejects sidecar paths that escape the root (tracked-internal traversal)', async () => {
    const res = await authorizeArtifactWrite({
      projectRoot: root,
      fullPath: path.join(root, '../escape.txt'),
      mustStayInRoot: true,
    });
    expect(res).toMatchObject({ ok: false, error: 'artifact-not-found' });
  });

  it('concurrency token: stale mtime is a conflict, fresh mtime passes, deleted file passes', async () => {
    const p = await mk('doc.md', 'v1');
    const st = await fs.promises.stat(p);
    const fresh = await authorizeArtifactWrite({ projectRoot: root, fullPath: p, mustStayInRoot: true, baseMtimeMs: st.mtimeMs });
    expect(fresh.ok).toBe(true);
    // move the mtime: rewrite with a different timestamp
    await fs.promises.utimes(p, new Date(), new Date(Date.now() + 5000));
    const stale = await authorizeArtifactWrite({ projectRoot: root, fullPath: p, mustStayInRoot: true, baseMtimeMs: st.mtimeMs });
    expect(stale).toMatchObject({ ok: false, error: 'conflict' });
    // deleted since get: the save legitimately recreates the file
    await fs.promises.rm(p);
    const gone = await authorizeArtifactWrite({ projectRoot: root, fullPath: p, mustStayInRoot: true, baseMtimeMs: st.mtimeMs });
    expect(gone.ok).toBe(true);
  });

  it('resolves the parent for a not-yet-existing file (delete-then-save keeps the draft)', async () => {
    const res = await authorizeArtifactWrite({
      projectRoot: root,
      fullPath: path.join(root, 'brand-new.md'),
      mustStayInRoot: true,
    });
    expect(res.ok).toBe(true);
  });
});

describe('authorizeArtifactRead', () => {
  it('serves .env (confirm-tier editable → must stay readable) but refuses .ssh', async () => {
    const env = await mk('.env', 'KEY=1');
    const envRes = await authorizeArtifactRead(root, env, true);
    expect(envRes.ok).toBe(true);
    const ssh = await mk('.ssh/config', 'Host *');
    const sshRes = await authorizeArtifactRead(root, ssh, true);
    expect(sshRes).toMatchObject({ ok: false, error: 'protected-path' });
  });

  it('missing file reports orphan, out-of-root reports artifact-not-found', async () => {
    const missing = await authorizeArtifactRead(root, path.join(root, 'gone.md'), true);
    expect(missing).toMatchObject({ ok: false, orphan: true });
    const out = path.join(outside, 'other.md');
    await fs.promises.writeFile(out, 'x');
    const escape = await authorizeArtifactRead(root, out, true);
    expect(escape).toMatchObject({ ok: false, error: 'artifact-not-found' });
  });

  it('a read symlink to a sensitive target is refused via its resolution', async () => {
    const secret = path.join(outside, '.aws/credentials');
    await fs.promises.mkdir(path.dirname(secret), { recursive: true });
    await fs.promises.writeFile(secret, '[default]');
    const link = path.join(root, 'readme.md');
    await fs.promises.symlink(secret, link);
    const res = await authorizeArtifactRead(root, link, false); // external: no in-root rule
    expect(res).toMatchObject({ ok: false, error: 'protected-path' });
  });

  // A relative absolutePath is a corrupt sidecar record (pre-2026-08-12
  // resolveTrackedPath wrote them). realpath()/fs.access()/File() resolve it
  // against the PROCESS cwd, not the project root, so it can silently address a
  // file outside the project. Refuse before resolution rather than guessing.

  // NOTE the deliberate choice of 'package.json': it EXISTS relative to the
  // vitest cwd (youcoded/desktop). Before the guard, realpath resolves it and
  // the call returns ok:true pointing at a file outside the notional project —
  // exactly the wrong-file read this guard closes. A non-existent relative path
  // would return orphan both before and after, so the test could never fail
  // first and would prove nothing.
  it('read: refuses a relative path instead of resolving it against process cwd', async () => {
    const res = await authorizeArtifactRead('/some/project', 'package.json', false);
    expect(res).toEqual({ ok: false, orphan: true });
  });

  // Behavior PIN, not a fix: a Windows-drive record already orphans on POSIX
  // (realpath ENOENT) and is already accepted on Windows (path.isAbsolute is
  // true there). Same expectation on both platforms, before and after. It exists
  // so a future "simplification" of isAbsoluteRecorded to a hand-rolled
  // startsWith('/') cannot silently break cross-device records on Windows.
  it('read: a Windows-drive path orphans on POSIX and is accepted on Windows', async () => {
    const res = await authorizeArtifactRead('/some/project', 'C:/Users/desti/notes.md', false);
    expect(res).toEqual({ ok: false, orphan: true });
  });

  it('write: refuses a relative path instead of creating a file under process cwd', async () => {
    const res = await authorizeArtifactWrite({
      projectRoot: '/some/project', fullPath: 'ROADMAP.md', mustStayInRoot: false,
    });
    expect(res).toEqual({ ok: false, error: 'artifact-not-found' });
  });
});

// Records the agent wrote through `../` hold a RELATIVE absolutePath. They are
// trusted only inside a project folder strictly below home and outside the
// deny lists — the sidecar lives in the project, so a copied folder can carry a
// planted record.
describe('judgeRelativeRecord', () => {
  let home: string;      // a stand-in home folder
  let proj: string;      // a project below it
  let notes: string;     // another saved project below it
  beforeEach(async () => {
    home = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-home-')));
    proj = path.join(home, 'proj');
    notes = path.join(home, 'notes');
    await fs.promises.mkdir(proj, { recursive: true });
    await fs.promises.mkdir(notes, { recursive: true });
  });
  afterEach(async () => { await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 3 }); });

  async function put(abs: string, content = 'x'): Promise<string> {
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content);
    return abs;
  }
  const rel = (abs: string) => path.relative(proj, abs);

  it('trusts a ../ file inside another saved project folder below home', async () => {
    const target = await put(path.join(notes, 'plan.md'));
    expect(await judgeRelativeRecord(proj, rel(target), [notes], home)).toEqual({ ok: true, realPath: target });
  });

  it('refuses a ../ file outside every project folder — and never says where it is', async () => {
    const target = await put(path.join(home, 'elsewhere', 'plan.md'));
    expect(await judgeRelativeRecord(proj, rel(target), [notes], home)).toEqual({ ok: false, reason: 'outside-projects' });
  });

  // THE reviewer's scenario (2026-09-23, F1): the home folder itself is a saved
  // folder, as it is on Destin's machine. It must vouch for nothing — and every
  // credential below stays refused even so.
  it('a saved home folder, an ancestor of home, or a filesystem root vouches for nothing', async () => {
    const plain = await put(path.join(home, 'Documents', 'todo.md'));
    for (const saved of [home, path.dirname(home), path.parse(home).root]) {
      expect(await judgeRelativeRecord(proj, rel(plain), [saved], home), saved).toEqual({ ok: false, reason: 'outside-projects' });
    }
    // and the project itself vouches for nothing when the project IS home
    expect(await judgeRelativeRecord(home, 'Documents/../Documents/todo.md', [], home)).toEqual({ ok: false, reason: 'outside-projects' });
  });

  it('keeps every PLANTED credential record refused with home saved as a folder', async () => {
    const secrets = [
      '.git-credentials', '.claude.json', '.npmrc', '.pypirc', '.docker/config.json', '.pgpass',
      '.bash_history', '.zsh_history', '.local/share/fish/fish_history',
      '.config/gcloud/application_default_credentials.json', '.local/share/keyrings/login.keyring',
      '.ssh/id_rsa', '.aws/credentials', '.netrc', '.config/gh/hosts.yml',
    ];
    for (const s of secrets) {
      const abs = await put(path.join(home, s), 'PRIVATE');
      expect(await judgeRelativeRecord(proj, rel(abs), [home, notes], home), s).toEqual({ ok: false, reason: 'protected-path' });
    }
    // …and inside a legitimate project folder too.
    for (const s of ['.npmrc', '.env', '.git-credentials', '.ssh/id_rsa']) {
      const abs = await put(path.join(notes, s), 'PRIVATE');
      expect(await judgeRelativeRecord(proj, rel(abs), [notes], home), `notes/${s}`).toEqual({ ok: false, reason: 'protected-path' });
    }
  });

  it('judges the RESOLVED target of a symlink, not the link', async () => {
    const key = await put(path.join(home, '.aws', 'credentials'), 'PRIVATE');
    const link = path.join(notes, 'innocent.md');
    try { await fs.promises.symlink(key, link); } catch { return; } // no symlink rights (Windows)
    expect(await judgeRelativeRecord(proj, rel(link), [notes], home)).toEqual({ ok: false, reason: 'protected-path' });
  });

  it('says missing only when nothing is on disk there', async () => {
    expect(await judgeRelativeRecord(proj, '../notes/never-was.md', [notes], home)).toEqual({ ok: false, reason: 'missing' });
  });

  it('reports a failed check with the filesystem code instead of throwing or saying missing', async () => {
    // A symlink loop: realpath answers ELOOP.
    const a = path.join(notes, 'a'); const b = path.join(notes, 'b');
    try { await fs.promises.symlink(b, a); await fs.promises.symlink(a, b); } catch { return; }
    expect(await judgeRelativeRecord(proj, '../notes/a', [notes], home)).toEqual({ ok: false, reason: 'unreadable', code: 'ELOOP' });
  });
});
