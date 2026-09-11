// artifacts:save answers a failed write, instead of throwing it at the renderer.
// Before 2026-09-11 the handler rethrew, which rejected the invoke; the editor
// had no catch there, so a file it could not write (no permission, read-only
// disk, disk full) produced a Save button that did nothing visible at all.
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
let locked: string;

function saveHandler() {
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
  registerIpcHandlers(mockIpcMain, mockSessionManager, mockWindow, mockSkillProvider);
  return mockIpcMain.handle.mock.calls.find((c: any) => c[0] === 'artifacts:save')[1];
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-savefail-')));
  locked = path.join(root, 'locked');
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, 'notes.md'), 'hello');
});

afterEach(() => {
  try { fs.chmodSync(locked, 0o700); } catch { /* already gone */ }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('artifacts:save when the file cannot be written', () => {
  it('answers { ok: false, error: "write-failed" } with the code, and leaves no temp file behind', async () => {
    fs.chmodSync(locked, 0o500);   // readable and listable, not writable
    const res = await saveHandler()({}, root, 'p1', 'Proj', 'locked/notes.md', 'new text', 's1');
    expect(res).toMatchObject({ ok: false, error: 'write-failed' });
    expect(['EACCES', 'EPERM']).toContain(res.code);
    fs.chmodSync(locked, 0o700);
    expect(fs.readFileSync(path.join(locked, 'notes.md'), 'utf8')).toBe('hello');
    expect(fs.readdirSync(locked).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('still saves normally when the folder is writable', async () => {
    const res = await saveHandler()({}, root, 'p1', 'Proj', 'locked/notes.md', 'new text', 's1');
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(locked, 'notes.md'), 'utf8')).toBe('new text');
  });
});
