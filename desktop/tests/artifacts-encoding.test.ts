// Text in an older encoding is shown, flagged, and never saved over.
//
// A Latin-1 / Windows-1252 file (an accented word is the common case) has no NUL
// bytes, so it passes the binary sniff and decodes with U+FFFD in place of every
// accent. Saving that draft back wrote the damage to disk permanently, even when
// the user changed an unrelated line, and nothing told them (2026-09-11).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { losesBytesAsUtf8 } from '../src/shared/artifacts/editable-path-policy';
import { canEditArtifact } from '../src/renderer/components/artifact-views/edit-permission';

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

function handlerFor(channel: string) {
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
  return mockIpcMain.handle.mock.calls.find((c: any) => c[0] === channel)[1];
}

// "café" in Windows-1252: the 0xE9 byte is not valid UTF-8 on its own.
const LATIN1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-encoding-')));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));

describe('losesBytesAsUtf8', () => {
  it('is true only when a byte cannot be read as UTF-8', () => {
    expect(losesBytesAsUtf8(LATIN1)).toBe(true);
    expect(losesBytesAsUtf8(Buffer.from('café\n', 'utf8'))).toBe(false);
    expect(losesBytesAsUtf8(Buffer.from('plain ascii'))).toBe(false);
    expect(losesBytesAsUtf8(Buffer.from(''))).toBe(false);
    // A file that genuinely contains U+FFFD is valid UTF-8 and stays editable.
    expect(losesBytesAsUtf8(Buffer.from('�', 'utf8'))).toBe(false);
  });
});

describe('artifacts:get / artifacts:save with an older text encoding', () => {
  it('flags the file so the pane can say so, and keeps showing it', async () => {
    fs.writeFileSync(path.join(root, 'notes.txt'), LATIN1);
    const res = await handlerFor('artifacts:get')({}, root, 'notes.txt');
    expect(res).toMatchObject({ ok: true, binary: false, notUtf8: true });
    expect(typeof res.content).toBe('string');
  });

  it('does not flag ordinary UTF-8 text', async () => {
    fs.writeFileSync(path.join(root, 'utf8.txt'), 'café\n', 'utf8');
    const res = await handlerFor('artifacts:get')({}, root, 'utf8.txt');
    expect(res).toMatchObject({ ok: true, notUtf8: false });
  });

  it('refuses to save over it, leaving the file byte-identical', async () => {
    fs.writeFileSync(path.join(root, 'notes.txt'), LATIN1);
    const res = await handlerFor('artifacts:save')({}, root, 'p1', 'Proj', 'notes.txt', 'caf�\n', 's1');
    expect(res).toMatchObject({ ok: false, error: 'not-utf8' });
    expect(fs.readFileSync(path.join(root, 'notes.txt')).equals(LATIN1)).toBe(true);
  });

  it('still saves an ordinary UTF-8 file', async () => {
    fs.writeFileSync(path.join(root, 'utf8.txt'), 'café\n', 'utf8');
    const res = await handlerFor('artifacts:save')({}, root, 'p1', 'Proj', 'utf8.txt', 'thé\n', 's1');
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, 'utf8.txt'), 'utf8')).toBe('thé\n');
  });
});

describe('the Edit affordance mirrors it', () => {
  it('is hidden for a flagged file and shown for the same file without the flag', () => {
    expect(canEditArtifact({ binary: false, sizeBytes: 5, notUtf8: true }, 'caf�', 'free')).toBe(false);
    expect(canEditArtifact({ binary: false, sizeBytes: 5 }, 'cafe', 'free')).toBe(true);
  });
});
