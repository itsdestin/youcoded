// Remote access batch 3, design test 8 — the file channels answer over remote
// from the SAME code the desktop uses (technical design 2026-09-10 §8, §9;
// contract rows R7, R8, R11, R12).
//
// One fixture, both transports driven end to end: the registered
// `ipcMain.handle` on one side and `RemoteServer.handleMessage` with a fake
// socket on the other. Every channel must answer the same, except the one
// divergence the design names — the phone's smaller preview ceiling
// (remote-file-limits.ts), which answers `too-large` with the real size instead
// of a prefix.
//
// Real files, a real symlink, a real chokidar watcher, under os.tmpdir(). The
// symlink case is the hole review round 2 closed (R2-1): `read-binary` used to
// authorize the UNRESOLVED path, so a link inside a project root pointing at a
// secret passed both the denylist and the root check.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
    // The watcher sink fans out to every window; none exist here.
    webContents: { getAllWebContents: vi.fn(() => []) },
  };
});

import { registerIpcHandlers } from '../src/main/ipc-handlers';
import { RemoteServer } from '../src/main/remote-server';
import { __resetProjectWatchersForTest, __setWatchGraceMsForTest, __watchersStartedForTest } from '../src/main/artifacts/project-watcher';
import { REMOTE_TEXT_PREVIEW_MAX_BYTES, REMOTE_BINARY_PREVIEW_MAX_BYTES } from '../src/shared/remote-file-limits';
import { SIDECAR_SCHEMA_VERSION } from '../src/shared/artifacts/types';

// Windows CI cannot always create symlinks (it needs a privilege); the cases
// that need one are skipped there, the way native-home.test.ts does it.
const canSymlink = (() => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-remote-files-symlink-probe-'));
  try {
    fs.writeFileSync(path.join(probeDir, 'target'), 'x');
    fs.symlinkSync('target', path.join(probeDir, 'link'), 'file');
    return true;
  } catch { return false; }
  finally { try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch { /* best effort */ } }
})();

// chokidar's awaitWriteFinish is stabilityThreshold 500 ms + pollInterval 100 ms
// (project-watcher.ts); a created file surfaces ~700 ms after the write.
// Measured 2026-09-10 on this machine: 640-780 ms. Under load it is later, so
// the budget is generous; a signal, not a sleep.
const WATCH_EVENT_MS = 8_000;

let root: string;
let outside: string;
let aliasTarget: string;   // a real folder…
let alias: string;         // …recorded in the saved folders through a symlink
let sessionRoot: string;   // known only as a live session's cwd
let capRoots: string[];    // five more session cwds, for the per-socket watch cap
const sessions: any[] = [];
let server: RemoteServer;
let handlers: Map<string, (...args: any[]) => Promise<any>>;
let cleanup: () => Promise<void>;

/** One fake WS client: an EventEmitter the host can hang 'close' on, plus the frames it received. */
function fakeClient(id: string) {
  const frames: any[] = [];
  const ws: any = Object.assign(new EventEmitter(), {
    readyState: 1,
    send: (raw: string) => frames.push(JSON.parse(raw)),
    close: vi.fn(),
    ping: vi.fn(),
  });
  return { frames, ws, client: { id, ws, deviceId: 'phone-1', ip: '127.0.0.1', connectedAt: Date.now() } };
}

/** Drive one channel over the remote transport and return ITS response payload
 *  (matched by a unique id — one client may ask the same channel many times). */
let nextRequest = 0;
async function overRemote(type: string, payload: any, who = fakeClient('sock-a')) {
  const id = `phone-1:1:${++nextRequest}`;
  await (server as any).handleMessage(who.client, JSON.stringify({ type, id, payload }));
  const reply = who.frames.find((f) => f.type === `${type}:response` && f.id === id);
  return reply?.payload;
}

/** Drive the same channel over the Electron IPC transport. */
function overIpc(channel: string, ...args: any[]) {
  const h = handlers.get(channel);
  if (!h) throw new Error(`no ipcMain.handle for ${channel}`);
  return h({ sender: { id: 1, once: vi.fn() } }, ...args);
}

beforeAll(async () => {
  // realpath: the handler compares against the RESOLVED root, and on some
  // platforms the temp dir is itself a symlink.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-remote-files-')));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-remote-outside-')));

  fs.writeFileSync(path.join(root, 'notes.md'), '# notes\n\nhello from the desktop\n');
  // 1.5 MB of text: under the desktop's 3 MB edit cap (content comes back whole
  // on IPC), over the phone's 1 MB preview ceiling.
  const line = 'b'.repeat(99) + '\n';
  fs.writeFileSync(path.join(root, 'big.txt'), line.repeat(Math.ceil(1.5 * 1024 * 1024 / line.length)));
  // 24 MB "PDF": under the desktop's 50 MB binary cap, over the phone's 10 MB.
  // Sparse, so it costs nothing to create — the size is what the gate reads.
  const pdf = fs.openSync(path.join(root, 'report.pdf'), 'w');
  fs.writeSync(pdf, '%PDF-1.4\n');
  fs.ftruncateSync(pdf, 24 * 1024 * 1024);
  fs.closeSync(pdf);
  // A secret inside the root, and a symlink inside the root to a secret outside it.
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
  fs.mkdirSync(path.join(outside, '.ssh'));
  fs.writeFileSync(path.join(outside, '.ssh', 'id_rsa'), '-----BEGIN KEY-----\n');
  if (canSymlink) fs.symlinkSync(path.join(outside, '.ssh', 'id_rsa'), path.join(root, 'innocent-link.txt'));

  // A root recorded THROUGH A SYMLINK (macOS's /tmp → /private/tmp is the
  // everyday case): the reads compare a file's real path against the roots,
  // so the recorded form alone would never match its own files.
  aliasTarget = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-remote-alias-target-')));
  alias = path.join(os.tmpdir(), `yc-remote-alias-link-${process.pid}-${Date.now()}`);
  if (canSymlink) fs.symlinkSync(aliasTarget, alias);
  fs.writeFileSync(path.join(aliasTarget, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  // A folder the host knows ONLY as a live session's working folder.
  sessionRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-remote-session-')));
  fs.writeFileSync(path.join(sessionRoot, 'todo.md'), '- ship it\n');
  // One file the session recorded, one it never did.
  fs.writeFileSync(path.join(sessionRoot, 'untracked.txt'), 'not recorded by any session\n');
  fs.mkdirSync(path.join(sessionRoot, '.youcoded'));
  fs.writeFileSync(path.join(sessionRoot, '.youcoded', 'artifacts.json'), JSON.stringify({
    $schema: SIDECAR_SCHEMA_VERSION, projectId: 'session-only', name: 'session-only',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    artifacts: [{
      id: 'rec-todo', path: 'todo.md', kind: 'internal', absolutePath: null,
      lastModified: new Date().toISOString(), status: 'active',
      versions: [{ id: 'v1', kind: 'create', at: new Date().toISOString(), sessionId: 'sess-live' }],
      comments: [], tags: [],
    }],
    manualExcludes: [], manualIncludes: [],
  }));
  capRoots = Array.from({ length: 5 }, () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-remote-cap-'))));
  sessions.push({ id: 'sess-live', name: 'live', cwd: sessionRoot, status: 'active' });

  // The root is a saved folder — the roots list both transports authorize against.
  const home = process.env.HOME!;
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'youcoded-folders.json'),
    JSON.stringify([
      { path: root, nickname: 'fixture', addedAt: Date.now() },
      { path: alias, nickname: 'through a symlink', addedAt: Date.now() },
      ...capRoots.map((p) => ({ path: p, nickname: 'cap', addedAt: Date.now() })),
    ]));

  const sessionManager: any = Object.assign(new EventEmitter(), {
    createSession: vi.fn(), destroySession: vi.fn(), listSessions: vi.fn(() => sessions),
    sendInput: vi.fn(), resizeSession: vi.fn(),
  });
  const hookRelay: any = Object.assign(new EventEmitter(), { respond: vi.fn(() => true) });
  const config: any = { enabled: false, port: 9900, passwordHash: null, toSafeObject: () => ({}) };
  server = new RemoteServer(sessionManager, hookRelay, config);

  const mockIpcMain: any = { handle: vi.fn(), on: vi.fn() };
  const mockWindow: any = { webContents: { send: vi.fn() }, isDestroyed: () => false };
  const mockSkillProvider: any = {
    configStore: { getPackages: vi.fn(() => ({})) },
    install: vi.fn(), installMany: vi.fn(),
    ensureBundledPluginsInstalled: vi.fn(), ensureMigrated: vi.fn(),
  };
  const wiring = registerIpcHandlers(mockIpcMain, sessionManager, mockWindow, mockSkillProvider, undefined as any, hookRelay, config, server);
  cleanup = wiring.cleanup;
  handlers = new Map(mockIpcMain.handle.mock.calls.map((c: any) => [c[0], c[1]]));
});

afterAll(async () => {
  __resetProjectWatchersForTest();
  await cleanup?.();
  await fs.promises.unlink(alias).catch(() => {});
  for (const dir of [root, outside, aliasTarget, sessionRoot, ...capRoots]) {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

describe('the file lists answer the same on both transports', () => {
  it('artifacts:list-all-files — the project folder as it exists on disk', async () => {
    const ipc = await overIpc('artifacts:list-all-files', root);
    const remote = await overRemote('artifacts:list-all-files', { projectId: root });
    expect(remote?.ok).toBe(true);
    expect(remote.unsupported).toBeUndefined();
    const names = (r: any) => (r.files as any[]).map((f) => f.path).sort();
    expect(names(remote)).toEqual(names(ipc));
    expect(names(remote)).toContain('notes.md');
  });

  it('artifacts:list-session and list-project answer with the same (empty) tracked lists', async () => {
    const ipcS = await overIpc('artifacts:list-session', 'sess-1', root);
    const remS = await overRemote('artifacts:list-session', { sessionId: 'sess-1', projectRoot: root });
    expect(remS).toEqual(ipcS);
    const ipcP = await overIpc('artifacts:list-project', root, { withCount: true });
    const remP = await overRemote('artifacts:list-project', { projectId: root, opts: { withCount: true } });
    expect(remP).toEqual(ipcP);
  });

  it('artifacts:check-existence and search-content are bridged too', async () => {
    const ipcE = await overIpc('artifacts:check-existence', root, ['nope']);
    const remE = await overRemote('artifacts:check-existence', { projectRoot: root, artifactIds: ['nope'] });
    expect(remE).toEqual(ipcE);
    const remQ = await overRemote('artifacts:search-content', { projectRoot: root, query: 'hello from' });
    expect(remQ?.unsupported).toBeUndefined();
    expect(typeof remQ?.ok).toBe('boolean');
  });

  it('the four project:* reads answer over remote', async () => {
    for (const [type, payload] of [
      ['project:list-context', { projectPath: root }],
      ['project:list-conversations', { projectPath: root }],
      ['project:repo-info', { projectPath: root }],
      ['project:read-context-file', { projectPath: root, absolutePath: path.join(root, 'notes.md') }],
    ] as const) {
      const res = await overRemote(type, payload);
      expect(res?.unsupported, `${type} fell to the unsupported default`).toBeUndefined();
      expect(typeof res?.ok, `${type} has no ok field`).toBe('boolean');
    }
  });
});

describe('reading a file: same answer, except the phone ceiling', () => {
  it('a small text file comes back identical', async () => {
    const ipc = await overIpc('artifacts:get', root, 'notes.md');
    const remote = await overRemote('artifacts:get', { projectRoot: root, artifactId: 'notes.md' });
    expect(remote.ok).toBe(true);
    expect(remote.content).toBe(ipc.content);
    expect(remote.sizeBytes).toBe(ipc.sizeBytes);
  });

  it('a 1.5 MB text file: content on IPC, too-large with its size over remote (R8, R19)', async () => {
    const size = fs.statSync(path.join(root, 'big.txt')).size;
    expect(size).toBeGreaterThan(REMOTE_TEXT_PREVIEW_MAX_BYTES);
    const ipc = await overIpc('artifacts:get', root, 'big.txt');
    expect(ipc.ok).toBe(true);
    expect(ipc.content.length).toBe(size);
    const remote = await overRemote('artifacts:get', { projectRoot: root, artifactId: 'big.txt' });
    expect(remote).toMatchObject({ ok: false, error: 'too-large', sizeBytes: size, limitBytes: REMOTE_TEXT_PREVIEW_MAX_BYTES });
    // Never a prefix.
    expect(remote.content).toBeUndefined();
  });

  it('a 24 MB PDF: bytes on IPC, too-large with its size over remote', async () => {
    const abs = path.join(root, 'report.pdf');
    const size = fs.statSync(abs).size;
    expect(size).toBeGreaterThan(REMOTE_BINARY_PREVIEW_MAX_BYTES);
    const ipc = await overIpc('artifacts:read-binary', abs);
    expect(ipc.ok).toBe(true);
    expect(typeof ipc.base64).toBe('string');
    const remote = await overRemote('artifacts:read-binary', { absolutePath: abs });
    expect(remote).toMatchObject({ ok: false, error: 'too-large', sizeBytes: size, limitBytes: REMOTE_BINARY_PREVIEW_MAX_BYTES });
    expect(remote.base64).toBeUndefined();
  });

  it('a sensitive path is refused on both transports', async () => {
    const abs = path.join(root, '.env');
    expect(await overIpc('artifacts:read-binary', abs)).toMatchObject({ ok: false, error: 'not-allowed' });
    expect(await overRemote('artifacts:read-binary', { absolutePath: abs })).toMatchObject({ ok: false, error: 'not-allowed' });
  });

  // THE HOLE ROUND 2 CLOSED (R2-1). The link's own path is inside the root and
  // matches nothing in the denylist; only the RESOLVED path is a secret.
  it.skipIf(!canSymlink)('a symlink under the root to a secret is refused on both transports', async () => {
    const abs = path.join(root, 'innocent-link.txt');
    expect(await overIpc('artifacts:read-binary', abs)).toMatchObject({ ok: false, error: 'not-allowed' });
    expect(await overRemote('artifacts:read-binary', { absolutePath: abs })).toMatchObject({ ok: false, error: 'not-allowed' });
    // artifacts:get already resolved links; it must keep doing so.
    const viaGet = await overRemote('artifacts:get', { projectRoot: root, artifactId: 'innocent-link.txt' });
    expect(viaGet.ok).toBe(false);
  });
});

describe('the roots a phone may name are the ones the desktop shows (R7)', () => {
  it('a root the desktop never showed is refused over remote, on every read; the desktop transport keeps its behaviour', async () => {
    fs.writeFileSync(path.join(outside, 'plain.md'), 'not a secret, just not yours\n');
    // The desktop's own transport is unchanged: its renderer only asks about roots it was given.
    expect((await overIpc('artifacts:get', outside, 'plain.md')).ok).toBe(true);
    for (const [type, payload] of [
      ['artifacts:get', { projectRoot: outside, artifactId: 'plain.md' }],
      ['artifacts:list-session', { sessionId: 's', projectRoot: outside }],
      ['artifacts:list-project', { projectId: outside }],
      ['artifacts:list-all-files', { projectId: outside }],
      ['artifacts:search-content', { projectRoot: outside, query: 'secret' }],
      ['artifacts:check-existence', { projectRoot: outside, artifactIds: ['x'] }],
      ['project:list-context', { projectPath: outside }],
      ['project:read-context-file', { projectPath: outside, absolutePath: path.join(outside, 'plain.md') }],
      ['project:list-conversations', { projectPath: outside }],
      ['project:repo-info', { projectPath: outside }],
      ['artifacts:watch-project', { projectRoot: outside }],
    ] as const) {
      const res = await overRemote(type, payload);
      expect(res, type).toMatchObject({ ok: false, error: 'not-allowed' });
    }
  });

  // A phone can start a session in any folder — and "No folder" lands in the
  // home folder — so a folder known ONLY because a session runs there must not
  // hand out files by path. It opens that session's recorded files, through
  // their records, and nothing else (T7 re-review, finding 1).
  it("a live session's folder, known only because a session runs there, opens that session's recorded files and nothing else", async () => {
    const listed = await overRemote('artifacts:list-session', { sessionId: 'sess-live', projectRoot: sessionRoot });
    expect(listed.ok).toBe(true);
    expect((listed.artifacts as any[]).map((a) => a.id)).toEqual(['rec-todo']);
    const text = await overRemote('artifacts:get', { projectRoot: sessionRoot, artifactId: 'rec-todo' });
    expect(text.content).toBe('- ship it\n');
    expect((await overRemote('artifacts:check-existence', { projectRoot: sessionRoot, artifactIds: ['rec-todo'] })).ok).toBe(true);
    for (const [type, payload] of [
      ['artifacts:get', { projectRoot: sessionRoot, artifactId: 'untracked.txt' }],
      ['artifacts:list-all-files', { projectId: sessionRoot }],
      ['artifacts:search-content', { projectRoot: sessionRoot, query: 'ship' }],
      ['artifacts:read-binary', { absolutePath: path.join(sessionRoot, 'untracked.txt') }],
      ['artifacts:watch-project', { projectRoot: sessionRoot }],
      ['project:list-context', { projectPath: sessionRoot }],
    ] as const) {
      expect(await overRemote(type, payload), type).toMatchObject({ ok: false, error: 'not-allowed' });
    }
  });

  it.skipIf(!canSymlink)('a root recorded through a symlink still reaches its own files, on both transports', async () => {
    const viaLink = path.join(alias, 'pic.png');
    expect((await overIpc('artifacts:read-binary', viaLink)).ok).toBe(true);
    expect((await overRemote('artifacts:read-binary', { absolutePath: viaLink })).ok).toBe(true);
    // And the real path of the same file — recorded form and resolved form both count.
    expect((await overRemote('artifacts:read-binary', { absolutePath: path.join(aliasTarget, 'pic.png') })).ok).toBe(true);
  });

  it('a malformed payload answers bad-request, never a Node error\'s text', async () => {
    expect(await overRemote('artifacts:get', { projectRoot: root })).toMatchObject({ ok: false, error: 'bad-request' });
    expect(await overRemote('artifacts:list-all-files', {})).toMatchObject({ ok: false, error: 'bad-request' });
    expect(await overRemote('artifacts:watch-project', { projectRoot: 42 })).toMatchObject({ ok: false, error: 'bad-request' });
  });

  it('one socket may watch four roots; the fifth is refused as too-many', async () => {
    const who = fakeClient('sock-cap');
    (server as any).clients.add(who.client);
    try {
      for (const cwd of capRoots.slice(0, 4)) {
        expect((await overRemote('artifacts:watch-project', { projectRoot: cwd }, who)).ok).toBe(true);
      }
      expect(await overRemote('artifacts:watch-project', { projectRoot: capRoots[4] }, who)).toMatchObject({ ok: false, error: 'too-many' });
      // Re-watching one it already holds is not a fifth.
      expect((await overRemote('artifacts:watch-project', { projectRoot: capRoots[0] }, who)).ok).toBe(true);
      // Letting one go frees the slot.
      await overRemote('artifacts:unwatch-project', { projectRoot: capRoots[0] }, who);
      expect((await overRemote('artifacts:watch-project', { projectRoot: capRoots[4] }, who)).ok).toBe(true);
    } finally {
      who.ws.emit('close');
      (server as any).clients.delete(who.client);
    }
  });
});

describe('live refresh over remote (R12)', () => {
  it('a watcher event reaches the WS client that subscribed, and a socket that closed is dropped', async () => {
    const a = fakeClient('sock-watch-a');
    const b = fakeClient('sock-watch-b');
    (server as any).clients.add(a.client);
    (server as any).clients.add(b.client);
    // The shipped grace is 60 s; short enough here that a dropped socket's
    // watcher is CLOSED before the next subscriber arrives, so the proof below
    // is a watcher count, not a frame count (a closed socket is out of
    // `clients`, so "A received nothing" would be true whether or not its
    // subscription was dropped).
    __setWatchGraceMsForTest(50);
    const started = __watchersStartedForTest();

    const subA = await overRemote('artifacts:watch-project', { projectRoot: root }, a);
    expect(subA?.ok).toBe(true);
    expect(__watchersStartedForTest()).toBe(started + 1);
    // A drops (the phone lost its connection) — its subscription must go with it,
    // or a phone that never comes back pins the watcher forever.
    a.ws.emit('close');
    (server as any).clients.delete(a.client);
    // With A's ref gone the watcher parks and, after the grace, closes; B's
    // subscribe then starts a NEW one. Had dropSubscriber not run, A's ref
    // would keep it alive and B would reuse it — no second start.
    await new Promise((r) => setTimeout(r, 120));
    const subB = await overRemote('artifacts:watch-project', { projectRoot: root }, b);
    expect(subB?.ok).toBe(true);
    expect(__watchersStartedForTest()).toBe(started + 2);

    fs.writeFileSync(path.join(root, 'made-by-the-assistant.md'), '# new\n');
    await vi.waitFor(() => {
      expect(b.frames.some((f) => f.type === 'artifacts:changed' && f.payload?.kind === 'add')).toBe(true);
    }, { timeout: WATCH_EVENT_MS });
    const evt = b.frames.find((f) => f.type === 'artifacts:changed' && f.payload?.kind === 'add');
    expect(evt.payload).toMatchObject({ projectRoot: root, artifactId: 'made-by-the-assistant.md', by: 'external' });
    // And the old socket, being closed, was never sent anything after it went.
    expect(a.frames.filter((f) => f.type === 'artifacts:changed')).toEqual([]);

    (server as any).clients.delete(b.client);
    await overRemote('artifacts:unwatch-project', { projectRoot: root }, b);
  });
});
