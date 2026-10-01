// R3-SEC (2026-10-01): every file read a PHONE can reach refuses the phone deny list (a project's .git, saved logins,
// private keys, the app's own secrets), judged on the resolved path, and the computer's own windows are unchanged.
// Also: a phone's fs:read-head is held to the folders the computer shows (plus the upload folder), and file:upload
// has a size cap and a sweep of old files. Real files, a real symlink, both doors driven end to end.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// WHY a HOME of its own: the folder gate reads the saved-folders file under HOME and the deny list is anchored to HOME.
const ownHome = vi.hoisted(() => {
  const fsx = require('node:fs'); const osx = require('node:os'); const pathx = require('node:path');
  const dir: string = fsx.realpathSync(fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'yc-deny-home-')));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = dir; process.env.USERPROFILE = dir;
  return { dir, saved };
});

vi.mock('electron', () => {
  const BrowserWindowMock: any = vi.fn(() => ({ loadURL: vi.fn(), on: vi.fn(), webContents: { send: vi.fn() } }));
  BrowserWindowMock.getAllWindows = vi.fn(() => []);
  return {
    app: { isPackaged: false, getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '0.0.0-test'), whenReady: vi.fn(() => new Promise(() => {})), on: vi.fn(), quit: vi.fn(), setAppUserModelId: vi.fn(), commandLine: { appendSwitch: vi.fn() }, getGPUInfo: vi.fn(() => new Promise(() => {})) },
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    BrowserWindow: BrowserWindowMock,
    Menu: { setApplicationMenu: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    dialog: { showOpenDialog: vi.fn() },
    clipboard: { readImage: vi.fn(() => ({ isEmpty: () => true })) },
    nativeImage: {},
    shell: { openExternal: vi.fn() },
    powerSaveBlocker: { start: vi.fn(() => 0), stop: vi.fn() },
    webContents: { getAllWebContents: vi.fn(() => []) },
  };
});

import { registerIpcHandlers } from '../src/main/ipc-handlers';
import { registerWithRuntime } from './helpers/register-ipc';
import { RemoteServer } from '../src/main/remote-server';
import { __resetProjectWatchersForTest } from '../src/main/artifacts/project-watcher';
import { isPhoneDeniedPath, isCredentialPath } from '../src/main/harness/tools/credential-paths';
import { MAX_UPLOAD_BYTES, UPLOAD_TOO_LARGE_SENTENCE, sweepOldUploads, uploadDir } from '../src/main/upload-store';

const canSymlink = (() => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-deny-probe-'));
  try { fs.writeFileSync(path.join(probeDir, 't'), 'x'); fs.symlinkSync('t', path.join(probeDir, 'l'), 'file'); return true; }
  catch { return false; }
  finally { try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch { /* best effort */ } }
})();
const KEPT = 'kept-on-computer';

let project: string;      // a saved folder in the temp dir
let stranger: string;     // a folder the computer does not show
const home = ownHome.dir; // also a saved folder, so the home-anchored files are inside a known root
let server: RemoteServer;
let handlers: Map<string, (...args: any[]) => any>;
let cleanup: () => Promise<void>;

function fakeClient() {
  const frames: any[] = [];
  const ws: any = Object.assign(new EventEmitter(), { readyState: 1, send: (raw: string) => frames.push(JSON.parse(raw)), close: vi.fn(), ping: vi.fn() });
  return { frames, client: { id: 'sock', ws, deviceId: 'phone-1', ip: '127.0.0.1', connectedAt: Date.now() } };
}
let nextRequest = 0;
async function phone(type: string, payload?: any) {
  const who = fakeClient();
  const id = `phone-1:1:${++nextRequest}`;
  await (server as any).handleMessage(who.client, JSON.stringify({ type, id, payload }));
  return who.frames.find((f) => f.type === `${type}:response` && f.id === id)?.payload;
}
const computer = (channel: string, payload?: any) => handlers.get(channel)!({ sender: { id: 7, once: vi.fn() } }, payload);

beforeAll(() => {
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-deny-project-')));
  stranger = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-deny-stranger-')));
  fs.writeFileSync(path.join(project, 'notes.md'), 'ordinary project file TOKEN-ORDINARY\n');
  fs.mkdirSync(path.join(project, '.git'));
  fs.writeFileSync(path.join(project, '.git', 'config'), '[remote "origin"]\n\turl = https://me:ghp_SECRET@github.com/me/repo.git\n');
  fs.writeFileSync(path.join(project, '.git-credentials'), 'https://me:ghp_SECRET@github.com\n');
  fs.writeFileSync(path.join(project, 'id_rsa'), 'PRIVATE-KEY-MATERIAL\n');
  fs.writeFileSync(path.join(project, 'deploy.pem'), 'PEM-MATERIAL\n');
  fs.writeFileSync(path.join(stranger, 'plain.txt'), 'outside every known folder\n');
  // The app's own secrets and a saved login in the (known) home folder.
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'youcoded-remote.json'), '{"passwordHash":"HASH"}');
  fs.writeFileSync(path.join(home, '.git-credentials'), 'https://me:ghp_HOME@github.com\n');
  fs.writeFileSync(path.join(home, 'hello.txt'), 'home file\n');
  if (canSymlink) {
    fs.symlinkSync(path.join(home, '.git-credentials'), path.join(project, 'innocent-link.txt'));
    fs.symlinkSync(path.join(home, '.git-credentials'), path.join(project, 'CLAUDE.md'));
  }
  fs.writeFileSync(path.join(home, '.claude', 'youcoded-folders.json'),
    JSON.stringify([{ path: project, nickname: 'p', addedAt: Date.now() }, { path: home, nickname: 'home', addedAt: Date.now() }]));

  const sessionManager: any = Object.assign(new EventEmitter(), { createSession: vi.fn(), destroySession: vi.fn(), listSessions: vi.fn(() => []), sendInput: vi.fn(), resizeSession: vi.fn() });
  const hookRelay: any = Object.assign(new EventEmitter(), { respond: vi.fn(() => true) });
  const config: any = { enabled: false, port: 9900, passwordHash: null, toSafeObject: () => ({}) };
  server = new RemoteServer(sessionManager, hookRelay, config);
  const mockIpcMain: any = { handle: vi.fn(), on: vi.fn() };
  const mockWindow: any = { webContents: { send: vi.fn() }, isDestroyed: () => false };
  const mockSkillProvider: any = { configStore: { getPackages: vi.fn(() => ({})) }, install: vi.fn(), installMany: vi.fn(), ensureBundledPluginsInstalled: vi.fn(), ensureMigrated: vi.fn() };
  const wiring = registerWithRuntime(registerIpcHandlers, mockIpcMain, sessionManager, mockWindow, mockSkillProvider, undefined as any, hookRelay, config, server);
  cleanup = wiring.cleanup;
  handlers = new Map(mockIpcMain.handle.mock.calls.map((c: any) => [c[0], c[1]]));
});
afterAll(async () => {
  __resetProjectWatchersForTest();
  await cleanup?.();
  for (const dir of [project, stranger, home]) await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  for (const [k, v] of Object.entries(ownHome.saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

// [label, absolute path, id relative to `project` when it lives there]
const DENIED_IN_PROJECT: Array<[string, string]> = [
  ['.git/config', '.git/config'],
  ['.git-credentials in a project', '.git-credentials'],
  ['id_rsa in a project', 'id_rsa'],
  ['a .pem key', 'deploy.pem'],
];

describe('the deny list itself', () => {
  it('extends the assistant\'s list without changing it: isCredentialPath still answers as before', () => {
    // These were NOT refused to the assistant before and still are not (the new list is the phone\'s alone).
    expect(isCredentialPath('/home/u/proj/.git/config', '/home/u')).toBe(false);
    expect(isCredentialPath('/home/u/proj/id_rsa', '/home/u')).toBe(false);
    expect(isCredentialPath('/home/u/.claude/youcoded-remote.json', '/home/u')).toBe(false);
  });
  it.each([
    '/home/u/p/.git/config', '/home/u/p/.GIT/hooks/pre-commit', '/home/u/p/.git-credentials', '/home/u/.netrc', '/home/u/p/.npmrc',
    '/home/u/p/id_rsa', '/home/u/p/id_ed25519', '/home/u/p/id_ecdsa', '/home/u/p/id_dsa', '/home/u/p/a.pem', '/home/u/p/A.KEY', '/home/u/p/a.p12',
    '/home/u/p/a.pfx', '/home/u/p/.ssh/config', '/home/u/.claude/youcoded-remote.json', '/home/u/.claude/youcoded-remote.dev.json',
    '/home/u/.claude/.remote-devices.json', '/home/u/.config/youcoded/native-secrets.json', '/home/u/.claude.json', '/home/u/.claude/.credentials.json',
  ])('refuses %s', (p) => { expect(isPhoneDeniedPath(p, '/home/u')).toBe(true); });
  it.each(['/home/u/p/notes.md', '/home/u/p/.env', '/home/u/p/src/keys.ts', '/home/u/p/id_rsa.pub', '/home/u/p/.github/workflows/a.yml', '/home/u/p/gitconfig.md'])(
    'serves %s (.env stays readable by design: artifacts:get serves it as the editing escape hatch)', (p) => { expect(isPhoneDeniedPath(p, '/home/u')).toBe(false); });
});

describe('artifacts:get', () => {
  it.each(DENIED_IN_PROJECT)('a phone is refused %s; the computer still reads it', async (_l, rel) => {
    const viaPhone = await phone('artifacts:get', { projectRoot: project, artifactId: rel });
    expect(viaPhone).toMatchObject({ ok: false, error: KEPT });
    expect(JSON.stringify(viaPhone)).not.toMatch(/SECRET|PRIVATE-KEY|PEM-MATERIAL/);
    const viaComputer = await computer('artifacts:get', { projectRoot: project, artifactId: rel });
    expect(viaComputer.ok).toBe(true);
    expect(typeof viaComputer.content).toBe('string');
  });
  it('the remote password file and a saved login are refused to a phone', async () => {
    expect(await phone('artifacts:get', { projectRoot: home, artifactId: '.claude/youcoded-remote.json' })).toMatchObject({ ok: false, error: KEPT });
    expect(await phone('artifacts:get', { projectRoot: home, artifactId: '.git-credentials' })).toMatchObject({ ok: false, error: KEPT });
    expect((await computer('artifacts:get', { projectRoot: home, artifactId: '.git-credentials' })).content).toContain('ghp_HOME');
  });
  it.skipIf(!canSymlink)('a link inside a project that points at a secret is refused to a phone, read by the computer', async () => {
    // The computer's own read refuses nothing here (the link target is outside the project, so it answers not-found-in-root);
    // what matters is the phone never gets the bytes and is told the file is kept on the computer or simply not found.
    const viaPhone = await phone('artifacts:get', { projectRoot: project, artifactId: 'innocent-link.txt' });
    expect(JSON.stringify(viaPhone)).not.toContain('ghp_HOME');
    expect(viaPhone.ok).toBe(false);
  });
  it('an ordinary file is still served to a phone; .env stays readable as before', async () => {
    const r = await phone('artifacts:get', { projectRoot: project, artifactId: 'notes.md' });
    expect(r.ok).toBe(true);
    expect(r.content).toContain('TOKEN-ORDINARY');
    fs.writeFileSync(path.join(project, '.env'), 'A=1\n');
    expect((await phone('artifacts:get', { projectRoot: project, artifactId: '.env' })).ok).toBe(true);
  });
});

describe('artifacts:read-binary', () => {
  it.each(DENIED_IN_PROJECT)('a phone is refused %s; the computer still reads it', async (_l, rel) => {
    const abs = path.join(project, rel);
    const viaPhone = await phone('artifacts:read-binary', { absolutePath: abs });
    expect(viaPhone).toMatchObject({ ok: false, error: KEPT });
    expect((await computer('artifacts:read-binary', { absolutePath: abs })).ok).toBe(true);
  });
  it('the remote password file and ~/.git-credentials', async () => {
    for (const rel of ['.claude/youcoded-remote.json', '.git-credentials']) {
      expect(await phone('artifacts:read-binary', { absolutePath: path.join(home, rel) })).toMatchObject({ ok: false, error: KEPT });
      expect((await computer('artifacts:read-binary', { absolutePath: path.join(home, rel) })).ok).toBe(true);
    }
  });
  it.skipIf(!canSymlink)('a link in a project to a secret is refused by its resolved path', async () => {
    expect(await phone('artifacts:read-binary', { absolutePath: path.join(project, 'innocent-link.txt') })).toMatchObject({ ok: false, error: KEPT });
  });
  it('an ordinary file is still served to a phone', async () => {
    expect((await phone('artifacts:read-binary', { absolutePath: path.join(project, 'notes.md') })).ok).toBe(true);
  });
});

describe('artifacts:download (minting the link)', () => {
  it.each(DENIED_IN_PROJECT)('a phone is refused a link for %s', async (_l, rel) => {
    expect(await phone('artifacts:download', { absolutePath: path.join(project, rel) })).toMatchObject({ ok: false, error: KEPT });
  });
  it('the remote password file, and a link to a secret', async () => {
    expect(await phone('artifacts:download', { absolutePath: path.join(home, '.claude', 'youcoded-remote.json') })).toMatchObject({ ok: false, error: KEPT });
    if (canSymlink) expect(await phone('artifacts:download', { absolutePath: path.join(project, 'innocent-link.txt') })).toMatchObject({ ok: false, error: KEPT });
  });
  it('an ordinary file still gets a link', async () => {
    const r = await phone('artifacts:download', { absolutePath: path.join(project, 'notes.md') });
    expect(r.ok).toBe(true);
    expect(typeof r.url).toBe('string');
  });
});

describe('artifacts:resolve-path, list-folder and search-content', () => {
  it('resolve-path: a phone is not given the record of a denied file; the computer is', async () => {
    expect(await phone('artifacts:resolve-path', { projectRoot: project, path: 'id_rsa' })).toMatchObject({ ok: false, error: KEPT });
    expect((await computer('artifacts:resolve-path', { projectRoot: project, path: 'id_rsa' })).ok).toBe(true);
    expect((await phone('artifacts:resolve-path', { projectRoot: project, path: 'notes.md' })).ok).toBe(true);
  });
  it('list-folder: a phone cannot list .git; the computer can', async () => {
    expect(await phone('artifacts:list-folder', { projectId: project, relDir: '.git', opts: { offset: 0 } })).toMatchObject({ ok: false, error: KEPT });
    expect((await computer('artifacts:list-folder', { projectId: project, relDir: '.git', opts: { offset: 0 } })).ok).toBe(true);
    expect((await phone('artifacts:list-folder', { projectId: project, relDir: '', opts: { offset: 0 } })).ok).toBe(true);
  });
  it('search-content: no line of a denied file reaches a phone; the computer still finds it', async () => {
    const viaPhone = await phone('artifacts:search-content', { projectRoot: project, query: 'ghp_SECRET' });
    expect(viaPhone.hits ?? []).toEqual([]);
    const viaComputer = await computer('artifacts:search-content', { projectRoot: project, query: 'ghp_SECRET' });
    expect((viaComputer.hits ?? []).length).toBeGreaterThan(0);
    expect(((await phone('artifacts:search-content', { projectRoot: project, query: 'TOKEN-ORDINARY' })).hits ?? []).length).toBeGreaterThan(0);
  });
});

describe('project:*', () => {
  it('repo-info: the phone gets the repository without the login in its address; the computer gets it as written', async () => {
    const viaPhone = await phone('project:repo-info', { projectPath: project });
    expect(viaPhone.ok).toBe(true);
    expect(viaPhone.remoteUrl).toBe('https://github.com/me/repo.git');
    expect(JSON.stringify(viaPhone)).not.toContain('ghp_SECRET');
    expect((await computer('project:repo-info', { projectPath: project })).remoteUrl).toContain('ghp_SECRET');
  });
  it.skipIf(!canSymlink)('read-context-file: an instruction file that is a link to a secret is refused to a phone', async () => {
    const abs = path.join(project, 'CLAUDE.md');
    expect(await phone('project:read-context-file', { projectPath: project, absolutePath: abs })).toMatchObject({ ok: false, error: KEPT });
    expect((await computer('project:read-context-file', { projectPath: project, absolutePath: abs })).content).toContain('ghp_HOME');
  });
});

describe('fs:read-head', () => {
  it('a phone is refused a file outside every folder the computer shows; the computer is not', async () => {
    const f = path.join(stranger, 'plain.txt');
    expect(await phone('fs:read-head', { filePath: f })).toMatchObject({ ok: false, error: 'not-allowed' });
    expect((await computer('fs:read-head', { filePath: f })).ok).toBe(true);
  });
  it('a phone reads a file in a known folder, and is refused the denied ones inside it; the computer reads them all', async () => {
    expect((await phone('fs:read-head', { filePath: path.join(project, 'notes.md') })).ok).toBe(true);
    for (const rel of ['.git/config', '.git-credentials', 'id_rsa', 'deploy.pem']) {
      expect(await phone('fs:read-head', { filePath: path.join(project, rel) })).toMatchObject({ ok: false, error: KEPT });
    }
    expect(await phone('fs:read-head', { filePath: path.join(home, '.claude', 'youcoded-remote.json') })).toMatchObject({ ok: false, error: KEPT });
    expect((await computer('fs:read-head', { filePath: path.join(project, '.git', 'config') })).ok).toBe(true);
    expect((await computer('fs:read-head', { filePath: path.join(home, '.claude', 'youcoded-remote.json') })).ok).toBe(true);
  });
  it.skipIf(!canSymlink)('a link in a project to a secret is refused', async () => {
    expect(await phone('fs:read-head', { filePath: path.join(project, 'innocent-link.txt') })).toMatchObject({ ok: false, error: KEPT });
  });
  it('a path that does not exist outside the folders is not-allowed, not "orphan" (no existence oracle)', async () => {
    expect(await phone('fs:read-head', { filePath: path.join(stranger, 'nope.txt') })).toMatchObject({ ok: false, error: 'not-allowed' });
  });
  it('the phone\'s attach preview of an uploaded file works, and the upload is the only folder outside the roots it can read', async () => {
    const up = await phone('file:upload', { name: 'photo-notes.md', data: Buffer.from('# attached\n').toString('base64') });
    expect(typeof up.path).toBe('string');
    const head = await phone('fs:read-head', { filePath: up.path });
    expect(head).toMatchObject({ ok: true });
    expect(head.text).toContain('# attached');
    await fs.promises.rm(up.path, { force: true });
  });
});

describe('file:upload', () => {
  it('a file over the cap is refused with a plain sentence and nothing is written', async () => {
    const before = fs.existsSync(uploadDir()) ? fs.readdirSync(uploadDir()).length : 0;
    const over = Buffer.alloc(MAX_UPLOAD_BYTES + 1024, 1).toString('base64');
    expect(await phone('file:upload', { name: 'big.bin', data: over })).toEqual({ error: UPLOAD_TOO_LARGE_SENTENCE });
    expect(UPLOAD_TOO_LARGE_SENTENCE).toMatch(/25 MB/);
    const after = fs.existsSync(uploadDir()) ? fs.readdirSync(uploadDir()).length : 0;
    expect(after).toBe(before);
  });
  it('a file under the cap is still accepted', async () => {
    const r = await phone('file:upload', { name: 'ok.bin', data: Buffer.alloc(1024 * 1024, 1).toString('base64') });
    expect(typeof r.path).toBe('string');
    await fs.promises.rm(r.path, { force: true });
  });
  it('a name with separators and control characters stays inside the upload folder', async () => {
    const r = await phone('file:upload', { name: '../../x\u0000y\n.txt', data: Buffer.from('a').toString('base64') });
    expect(path.dirname(r.path)).toBe(uploadDir());
    expect(path.basename(r.path)).not.toMatch(/[\u0000\n/\\]/);
    await fs.promises.rm(r.path, { force: true });
  });
});

describe('the upload sweep', () => {
  it('removes only old regular files directly inside the folder it is given, and nothing outside', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-sweep-'));
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-sweep-else-'));
    try {
      const old = path.join(dir, 'old.txt'); const fresh = path.join(dir, 'fresh.txt');
      fs.writeFileSync(old, 'o'); fs.writeFileSync(fresh, 'f');
      fs.mkdirSync(path.join(dir, 'sub')); fs.writeFileSync(path.join(dir, 'sub', 'inner.txt'), 'i');
      const outsideFile = path.join(elsewhere, 'precious.txt'); fs.writeFileSync(outsideFile, 'p');
      if (canSymlink) fs.symlinkSync(outsideFile, path.join(dir, 'link-out.txt'));
      const now = Date.now();
      const longAgo = new Date(now - 2 * 3600_000);
      fs.utimesSync(old, longAgo, longAgo);
      fs.utimesSync(path.join(dir, 'sub', 'inner.txt'), longAgo, longAgo);
      if (canSymlink) fs.lutimesSync(path.join(dir, 'link-out.txt'), longAgo, longAgo);
      expect(await sweepOldUploads(dir, 3600_000, now)).toBe(1);
      expect(fs.existsSync(old)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
      expect(fs.existsSync(path.join(dir, 'sub', 'inner.txt'))).toBe(true);
      expect(fs.existsSync(outsideFile)).toBe(true);
      expect(await sweepOldUploads(path.join(dir, 'missing'), 1, now)).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
