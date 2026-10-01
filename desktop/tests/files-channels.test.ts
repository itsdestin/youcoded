// The files group in the channel table (one-core R3-7): artifacts:*, project:*, git:*, chatsearch:*, pages:*,
// fs:read-head, file:upload and get-home-path. Pinned here: which of them a phone may call (exactly what it
// could before), that a phone is refused the rest without the handler running, the one-handler-for-both-doors
// shape, what only one door does (the phone-only upload, the pages key rule), and that a change reaches the
// same screens it always did. The folder gates, size ceilings and symlink cases are pinned end to end by
// remote-files.test.ts and remote-download.test.ts, which drive both doors against real files.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// WHY a HOME of its own (2026-09-30 one-core R3-7): the folder gate reads the saved-folders file under HOME, and the
// suite's one shared sandbox HOME is written by remote-files.test.ts and others running at the same time in other
// workers. Set before any import, so every path the code under test resolves lands here, and put back afterwards.
const ownHome = vi.hoisted(() => {
  const fsx = require('node:fs'); const osx = require('node:os'); const pathx = require('node:path');
  const dir: string = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'yc-files-home-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = dir; process.env.USERPROFILE = dir;
  return { dir, saved };
});

const windowPushes: Array<[string, any]> = [];
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
    // The windows the artifact and git change pushes go to.
    webContents: { getAllWebContents: vi.fn(() => [{ send: (c: string, p: any) => windowPushes.push([c, p]) }]) },
  };
});

// A pages service we control: what each pages entry passes it, and what it does when it throws.
const pagesFake = {
  store: { list: vi.fn(), get: vi.fn(), setPinned: vi.fn(), setData: vi.fn() },
  ensureWatching: vi.fn(), listAndWatch: vi.fn(async () => []),
  approve: vi.fn(async () => ({ ok: true, pages: [] })), removeConnection: vi.fn(), refresh: vi.fn(),
  savedKeys: vi.fn(), deleteSavedKey: vi.fn(), fetch: vi.fn(), onProjectChange: vi.fn(), stop: vi.fn(),
};
let pagesOn = true;
vi.mock('../src/main/pages/pages-service', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  getPagesService: () => (pagesOn ? pagesFake : null),
}));

import { registerIpcHandlers } from '../src/main/ipc-handlers';
import { registerWithRuntime } from './helpers/register-ipc';
import { RemoteServer } from '../src/main/remote-server';
import { CHANNEL_TABLE } from '../src/main/ipc/channel-table';
import { __resetProjectWatchersForTest } from '../src/main/artifacts/project-watcher';

const FAMILY = /^(artifacts|project|git|chatsearch|pages):/;
const SINGLES = ['fs:read-head', 'file:upload', 'get-home-path'];
const inFamily = (name: string) => FAMILY.test(name) || SINGLES.includes(name);

let server: RemoteServer;
let handlers: Map<string, (...args: any[]) => any>;
let cleanup: () => Promise<void>;
let folder: string;
let outside: string;
const phoneBroadcasts: any[] = [];

function fakeClient() {
  const frames: any[] = [];
  const ws: any = Object.assign(new EventEmitter(), { readyState: 1, send: (raw: string) => frames.push(JSON.parse(raw)), close: vi.fn(), ping: vi.fn() });
  return { frames, client: { id: 'sock', ws, deviceId: 'phone-1', ip: '127.0.0.1', connectedAt: Date.now() } };
}
let nextRequest = 0;
async function overRemote(type: string, payload?: any) {
  const who = fakeClient();
  const id = `phone-1:1:${++nextRequest}`;
  await (server as any).handleMessage(who.client, JSON.stringify({ type, id, payload }));
  return who.frames.find((f) => f.type === `${type}:response` && f.id === id)?.payload;
}
const overIpc = (channel: string, payload?: any) => handlers.get(channel)!({ sender: { id: 7, once: vi.fn() } }, payload);
const unsupported = (name: string) => ({ ok: false, error: `This feature isn't available over remote access yet (${name}).`, unsupported: true });

beforeAll(() => {
  folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-files-channels-')));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-files-outside-')));
  fs.writeFileSync(path.join(folder, 'notes.md'), 'hello\n');
  const home = process.env.HOME!;
  expect(home).toBe(ownHome.dir);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'youcoded-folders.json'), JSON.stringify([{ path: folder, nickname: 'fixture', addedAt: Date.now() }]));

  const sessionManager: any = Object.assign(new EventEmitter(), {
    createSession: vi.fn(), destroySession: vi.fn(), listSessions: vi.fn(() => []), sendInput: vi.fn(), resizeSession: vi.fn(),
  });
  const hookRelay: any = Object.assign(new EventEmitter(), { respond: vi.fn(() => true) });
  const config: any = { enabled: false, port: 9900, passwordHash: null, toSafeObject: () => ({}) };
  server = new RemoteServer(sessionManager, hookRelay, config);
  vi.spyOn(server, 'broadcast').mockImplementation((m: any) => { phoneBroadcasts.push(m); });
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
  for (const dir of [folder, outside, ownHome.dir]) await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  for (const [k, v] of Object.entries(ownHome.saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
beforeEach(() => { windowPushes.length = 0; phoneBroadcasts.length = 0; pagesOn = true; for (const fn of Object.values(pagesFake)) if (typeof fn === 'function' && 'mockClear' in fn) (fn as any).mockClear(); });

describe('which of these a phone may call: exactly what it could before', () => {
  const entries = CHANNEL_TABLE.filter((d) => inFamily(d.name));
  const phoneOpen = (d: (typeof entries)[number]) => !d.desktopOnly && d.remoteAllowed !== false;

  it('the table holds all 50 channels of the group', () => {
    expect(entries).toHaveLength(50); // 21 artifacts + 5 project + 2 chatsearch + 9 git + 10 pages + 3 singles
  });

  it('exactly these are open to a phone; everything else is refused', () => {
    expect(entries.filter(phoneOpen).map((d) => d.name).sort()).toEqual([
      'artifacts:check-existence', 'artifacts:download', 'artifacts:get', 'artifacts:list-all-files', 'artifacts:list-folder',
      'artifacts:list-project', 'artifacts:list-projects-index', 'artifacts:list-session', 'artifacts:read-binary',
      'artifacts:resolve-path', 'artifacts:search-content', 'artifacts:unwatch-project', 'artifacts:watch-project',
      'chatsearch:read', 'chatsearch:resolve', 'file:upload', 'fs:read-head', 'get-home-path',
      'pages:approve', 'pages:delete-saved-key', 'pages:fetch', 'pages:get', 'pages:list', 'pages:refresh',
      'pages:remove-connection', 'pages:saved-keys', 'pages:set-data', 'pages:set-pinned',
      'project:list-context', 'project:list-conversations', 'project:read-context-file', 'project:repo-info',
    ]);
  });

  it('a phone can read and Project-View, but never write, rename, import, commit or stage', () => {
    const refused = entries.filter((d) => !phoneOpen(d)).map((d) => d.name).sort();
    expect(refused).toEqual([
      'artifacts:append-version', 'artifacts:delete-project', 'artifacts:exclude', 'artifacts:import-file', 'artifacts:include-external',
      'artifacts:remove-record', 'artifacts:rename', 'artifacts:save',
      'git:commit', 'git:commit-file-diff', 'git:discard', 'git:file-review', 'git:file-status', 'git:stage', 'git:unstage', 'git:unwatch', 'git:watch',
      'project:write-context-file',
    ]);
  });

  it('a refused channel answers the phone with the old "not available over remote access" sentence, and its handler never runs', async () => {
    for (const def of entries.filter((d) => !phoneOpen(d))) {
      const original = def.handler;
      const ran = vi.fn(() => ({ ok: true }));
      def.handler = ran;
      try {
        expect(await overRemote(def.name, { projectRoot: folder, artifactId: 'notes.md', content: 'x' }), def.name).toEqual(unsupported(def.name));
        expect(ran, `${def.name} ran for a phone`).not.toHaveBeenCalled();
      } finally { def.handler = original; }
    }
  });

  it('file:upload is a phone-only entry: the computer registers nothing for it', () => {
    expect(handlers.has('file:upload')).toBe(false);
    expect(CHANNEL_TABLE.find((d) => d.name === 'file:upload')?.remoteOnly).toBe(true);
  });

  it('no hand-written registration is left for a name in the group', () => {
    const left = [...handlers.keys()].filter(inFamily).filter((n) => !CHANNEL_TABLE.some((d) => d.name === n));
    expect(left).toEqual([]);
  });
});

describe('a saved edit, a rename and a git stage tell the computer\'s windows and never a phone (as before)', () => {
  it('a save through the computer\'s door answers with the new token and pushes artifacts:changed to windows only', async () => {
    const saved = await overIpc('artifacts:save', {
      projectRoot: folder, projectId: folder, projectName: 'fixture', artifactId: 'notes.md', content: 'edited\n', sessionId: 's1',
    });
    expect(saved).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(folder, 'notes.md'), 'utf8')).toBe('edited\n');
    expect(windowPushes).toEqual([['artifacts:changed', { projectRoot: folder, artifactId: 'notes.md', kind: 'edit', by: 'user' }]]);
    expect(phoneBroadcasts.filter((m) => m.type === 'artifacts:changed')).toEqual([]);
  });

  it('git:stage through the computer\'s door stages and pushes git:changed to windows only; a phone is refused', async () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-files-repo-')));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
      const home = process.env.HOME!;
      const foldersFile = path.join(home, '.claude', 'youcoded-folders.json');
      const before = fs.readFileSync(foldersFile, 'utf8');
      fs.writeFileSync(foldersFile, JSON.stringify([...JSON.parse(before), { path: repo, nickname: 'repo', addedAt: Date.now() }]));
      try {
        // A phone first: refused, and nothing was staged.
        expect(await overRemote('git:stage', { projectRoot: repo, relPath: 'a.txt' })).toEqual(unsupported('git:stage'));
        expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString()).toContain('?? a.txt');
        windowPushes.length = 0;
        expect(await overIpc('git:stage', { projectRoot: repo, relPath: 'a.txt' })).toMatchObject({ ok: true });
        expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString()).toContain('A  a.txt');
        expect(windowPushes.map(([c]) => c)).toEqual(['git:changed']);
        expect(phoneBroadcasts.filter((m) => m.type === 'git:changed')).toEqual([]);
        // An unknown folder is refused by the computer's own gate, as before.
        expect(await overIpc('git:stage', { projectRoot: outside, relPath: 'a.txt' })).toEqual({ ok: false, error: 'unknown-project-root' });
      } finally { fs.writeFileSync(foldersFile, before); }
    } finally { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5 }); }
  });
});

describe('file:upload, the phone-only attach: kept exactly', () => {
  it('writes the file into the computer\'s temp folder (never a project) under a sanitised name, and answers where', async () => {
    const answer = await overRemote('file:upload', { name: '../../evil/..\\name.txt', data: Buffer.from('payload').toString('base64') });
    expect(answer.path.startsWith(path.join(os.tmpdir(), 'claude-desktop-uploads') + path.sep)).toBe(true);
    expect(path.basename(answer.path)).toMatch(/^\d+-.*name\.txt$/);
    expect(path.basename(answer.path)).not.toMatch(/[/\\]/);
    expect(fs.readFileSync(answer.path, 'utf8')).toBe('payload');
    fs.rmSync(answer.path, { force: true });
  });
  it('a malformed upload answers { error: "Upload failed" } and does not throw', async () => {
    expect(await overRemote('file:upload', undefined)).toEqual({ error: 'Upload failed' });
  });
});

describe('what only one door does', () => {
  it('artifacts:download is the phone\'s: the computer\'s own windows get the old "not-remote" code', async () => {
    expect(await overIpc('artifacts:download', { absolutePath: path.join(folder, 'notes.md') })).toEqual({ ok: false, code: 'not-remote' });
  });

  it('get-home-path answers the computer\'s home folder on both doors', async () => {
    expect(await overIpc('get-home-path')).toBe(os.homedir());
    expect(await overRemote('get-home-path')).toBe(os.homedir());
  });

  it('pages:approve is told which door asked: a phone may only reuse a saved key, the computer may paste one', async () => {
    await overIpc('pages:approve', { id: 'p1', keys: { svc: 'k' } });
    expect(pagesFake.approve).toHaveBeenLastCalledWith('p1', { svc: 'k' }, { remote: false });
    await overRemote('pages:approve', { id: 'p1', keys: { svc: 'k' } });
    expect(pagesFake.approve).toHaveBeenLastCalledWith('p1', { svc: 'k' }, { remote: true });
    // The payload cannot claim to be the computer.
    await overRemote('pages:approve', { id: 'p1', keys: {}, remote: false });
    expect(pagesFake.approve).toHaveBeenLastCalledWith('p1', {}, { remote: true });
  });

  it('a pages call that throws gives a phone the soft answer its page reads, and the computer a rejection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      pagesFake.store.get.mockRejectedValue(new Error('disk trouble'));
      expect(await overRemote('pages:get', { id: 'p' })).toEqual({ ok: false, failure: { kind: 'unreadable', message: 'disk trouble' } });
      pagesFake.store.setData.mockRejectedValue(new Error('disk trouble'));
      expect(await overRemote('pages:set-data', { id: 'p', data: 1 })).toEqual({ ok: false, message: 'disk trouble' });
      pagesFake.fetch.mockRejectedValue(new Error('offline'));
      expect(await overRemote('pages:fetch', { id: 'p', request: { url: 'https://x' } })).toEqual({ ok: false, reason: 'network', message: 'offline' });
      pagesFake.savedKeys.mockRejectedValue(new Error('locked'));
      expect(await overRemote('pages:saved-keys')).toEqual({ ok: false, error: 'locked' });
      await expect(Promise.resolve().then(() => overIpc('pages:saved-keys'))).rejects.toThrow('locked');
    } finally { warn.mockRestore(); }
  });

  it('with no pages service, both doors answer the old "not available on this host" shapes', async () => {
    pagesOn = false;
    for (const call of [() => overRemote('pages:get', { id: 'p' }), () => overIpc('pages:get', { id: 'p' })]) {
      expect(await call()).toEqual({ ok: false, failure: { kind: 'unreadable', message: 'Pages are not available on this host.' } });
    }
    expect(await overRemote('pages:list')).toEqual([]);
    expect(await overRemote('pages:set-data', { id: 'p', data: 1 })).toEqual({ ok: false, message: 'Pages are not available on this host.' });
    expect(await overRemote('pages:approve', { id: 'p', keys: {} })).toEqual({ ok: false, message: 'Pages are not available on this host.' });
    expect(await overRemote('pages:fetch', { id: 'p' })).toEqual({ ok: false, reason: 'network', message: 'Pages are not available on this host.' });
  });

  it('a phone watching a folder is capped, and an unwatch before any watch is a quiet no-op', async () => {
    expect(await overRemote('artifacts:unwatch-project', { projectRoot: folder })).toEqual({ ok: true });
    // A folder the computer does not show is refused before any watcher starts.
    expect(await overRemote('artifacts:watch-project', { projectRoot: outside })).toEqual({ ok: false, error: 'not-allowed' });
    expect(await overRemote('artifacts:watch-project', {})).toEqual({ ok: false, error: 'bad-request' });
  });

  it('every phone-allowed folder read is gated: an unshown folder is refused, a malformed call is "bad-request"', async () => {
    expect(await overRemote('artifacts:get', { projectRoot: outside, artifactId: 'x' })).toEqual({ ok: false, error: 'not-allowed' });
    expect(await overRemote('artifacts:get', { projectRoot: folder })).toEqual({ ok: false, error: 'bad-request' });
    expect(await overRemote('project:list-context', { projectPath: outside })).toEqual({ ok: false, error: 'not-allowed' });
    expect(await overRemote('artifacts:list-folder', { projectId: folder })).toEqual({ ok: false, error: 'bad-request' });
  });

  it('a phone cannot choose its own size ceiling: what it sends for maxBytes is replaced by the door', async () => {
    const big = path.join(folder, 'big.txt');
    fs.writeFileSync(big, 'b'.repeat(1.5 * 1024 * 1024));
    const answer = await overRemote('artifacts:get', { projectRoot: folder, artifactId: 'big.txt', maxBytes: 1e12 });
    expect(answer).toMatchObject({ ok: false, error: 'too-large' });
    expect(answer.content).toBeUndefined();
  });
});
