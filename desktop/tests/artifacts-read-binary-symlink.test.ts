// artifacts:read-binary decides about the file it is actually going to READ.
//
// The roots + sensitive-path verdict was made on the path as TYPED, then
// fs.readFile followed symlinks: a link inside a project folder pointing at
// ~/.ssh/id_rsa was judged as the link and read as the key (2026-09-11). The
// handler now resolves first — and resolves the roots too, so a saved folder
// that is itself a symlink still matches its own files.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    webContents: { getAllWebContents: vi.fn(() => []) },
  };
});

import { registerIpcHandlers } from '../src/main/ipc-handlers';

let root: string;
let secretHome: string;
// The handler reads the saved-folder list from the HOME the suite redirects
// (vitest.config.ts), so the allowed root has to be seeded there. Whatever was
// in that file is put back afterwards — nothing else in the suite owns it.
let foldersFile: string;
let previousFolders: string | null = null;

function handler() {
  const mockIpcMain: any = { handle: vi.fn(), on: vi.fn() };
  const mockSessionManager: any = {
    createSession: vi.fn(), destroySession: vi.fn(), listSessions: vi.fn(() => []),
    sendInput: vi.fn(), resizeSession: vi.fn(), on: vi.fn(),
  };
  const mockWindow: any = { webContents: { send: vi.fn() }, isDestroyed: () => false };
  const mockSkillProvider: any = {
    configStore: { getPackages: vi.fn(() => ({})) },
    install: vi.fn(), installMany: vi.fn(),
    ensureBundledPluginsInstalled: vi.fn(), ensureMigrated: vi.fn(),
  };
  const mockCommandProvider: any = { list: vi.fn(async () => []), invalidate: vi.fn() };
  registerIpcHandlers(mockIpcMain, mockSessionManager, mockWindow, mockSkillProvider, mockCommandProvider);
  return mockIpcMain.handle.mock.calls.find((c: any) => c[0] === 'artifacts:read-binary')[1];
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-rb-root-')));
  secretHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-rb-secret-')));
  fs.mkdirSync(path.join(secretHome, '.ssh'));
  fs.writeFileSync(path.join(secretHome, '.ssh', 'id_rsa'), 'PRIVATE KEY');
  fs.writeFileSync(path.join(root, 'chart.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  foldersFile = path.join(os.homedir(), '.claude', 'youcoded-folders.json');
  fs.mkdirSync(path.dirname(foldersFile), { recursive: true });
  previousFolders = fs.existsSync(foldersFile) ? fs.readFileSync(foldersFile, 'utf8') : null;
  fs.writeFileSync(foldersFile, JSON.stringify([{ path: root, nickname: 'Proj', addedAt: 1 }]));
});

afterEach(() => {
  if (previousFolders === null) fs.rmSync(foldersFile, { force: true });
  else fs.writeFileSync(foldersFile, previousFolders);
  for (const dir of [root, secretHome]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('artifacts:read-binary follows the link before it decides', () => {
  it('reads an ordinary file inside a project folder', async () => {
    const res = await handler()({}, path.join(root, 'chart.png'));
    expect(res.ok).toBe(true);
    expect(Buffer.from(res.base64, 'base64').equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
  });

  it('refuses a link inside the project that points at a credential file', async () => {
    const link = path.join(root, 'looks-innocent.png');
    fs.symlinkSync(path.join(secretHome, '.ssh', 'id_rsa'), link);
    const res = await handler()({}, link);
    expect(res).toMatchObject({ ok: false, error: 'not-allowed' });
    expect(res.base64).toBeUndefined();
  });

  it('refuses a link inside the project that points outside every project folder', async () => {
    const outside = path.join(secretHome, 'notes.png');
    fs.writeFileSync(outside, 'x');
    const link = path.join(root, 'elsewhere.png');
    fs.symlinkSync(outside, link);
    expect(await handler()({}, link)).toMatchObject({ ok: false, error: 'not-allowed' });
  });

  it('answers a link whose target is gone as not-found, not as an error string', async () => {
    const link = path.join(root, 'dangling.png');
    fs.symlinkSync(path.join(root, 'never-existed.png'), link);
    expect(await handler()({}, link)).toMatchObject({ ok: false, error: 'orphan' });
  });

  it('still reads files under a saved folder that is itself a link', async () => {
    const linkedRoot = path.join(os.tmpdir(), `yc-rb-link-${process.pid}-${Date.now()}`);
    fs.symlinkSync(root, linkedRoot);
    try {
      fs.writeFileSync(foldersFile, JSON.stringify([{ path: linkedRoot, nickname: 'Proj', addedAt: 1 }]));
      const res = await handler()({}, path.join(linkedRoot, 'chart.png'));
      expect(res.ok).toBe(true);
    } finally {
      fs.rmSync(linkedRoot, { force: true });
    }
  });
});
