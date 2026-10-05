// The artifacts:get size gate, exercised against a REAL file on disk.
//
// over-cap-read.test.ts pins the decision; this pins the plumbing around it —
// the read loop (fs.read is not required to fill its buffer), the `full` opt-in,
// and the fact that `full` is an opt-in to a BIGGER read, not an unbounded one.
// None of that is reachable from the pure test.
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
  };
});

import { registerIpcHandlers } from '../src/main/ipc-handlers';
import { registerWithRuntime } from './helpers/register-ipc';
import { EDIT_MAX_BYTES, FULL_READ_MAX_BYTES } from '../src/shared/artifacts/editable-path-policy';

let root: string;

function getHandler() {
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
  registerWithRuntime(registerIpcHandlers, mockIpcMain, mockSessionManager, mockWindow, mockSkillProvider);
  return mockIpcMain.handle.mock.calls.find((c: any) => c[0] === 'artifacts:get')[1];
}

/** Write `bytes` of real content and return the relative id artifacts:get takes. */
function writeFile(name: string, buf: Buffer): string {
  fs.writeFileSync(path.join(root, name), buf);
  return name;
}

beforeEach(() => {
  // realpath: the handler compares against the RESOLVED root, and on some
  // platforms the temp dir is itself a symlink.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-overcap-')));
});

afterEach(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('artifacts:get above EDIT_MAX_BYTES', () => {
  it('serves a readable prefix instead of refusing, and reports the real size', async () => {
    const line = 'a'.repeat(99) + '\n';
    const size = EDIT_MAX_BYTES + line.length * 100;
    const id = writeFile('big.log', Buffer.from(line.repeat(Math.ceil(size / line.length))));
    const onDisk = fs.statSync(path.join(root, 'big.log')).size;

    const res = await getHandler()({}, { projectRoot: root, artifactId: id });
    expect(res.ok).toBe(true);
    expect(res.truncated).toBe(true);
    expect(res.binary).toBe(false);
    expect(res.sizeBytes).toBe(onDisk);
    // A prefix, not the file — and never a half-written last line.
    expect(res.content.length).toBeLessThanOrEqual(EDIT_MAX_BYTES);
    expect(res.content.length).toBeLessThan(onDisk);
    expect(res.content.endsWith('\n')).toBe(true);
  });

  // THE BUG THIS WORKSTREAM EXISTS TO FIX: an over-cap file that isn't text used
  // to come back with the TEXT editor's refusal. It must route to the binary
  // handoff instead, decided on the head — not on the extension.
  it('hands an over-cap binary file to the binary route, not the text refusal', async () => {
    const buf = Buffer.alloc(EDIT_MAX_BYTES + 4096, 0x41);
    buf[10] = 0; // a NUL in the head
    const id = writeFile('blob.dat', buf);

    const res = await getHandler()({}, { projectRoot: root, artifactId: id });
    expect(res.binary).toBe(true);
    expect(res.content).toBeNull();
    expect(res.truncated).toBe(false);
    expect(res.sizeBytes).toBe(buf.length);
  });

  it('serves the whole file when the user opts in with { full: true }', async () => {
    const line = 'b'.repeat(99) + '\n';
    const buf = Buffer.from(line.repeat(Math.ceil((EDIT_MAX_BYTES + 5000) / line.length)));
    const id = writeFile('big2.log', buf);

    const res = await getHandler()({}, { projectRoot: root, artifactId: id, full: true });
    expect(res.truncated).toBe(false);
    expect(res.content.length).toBe(buf.length);
    expect(res.sizeBytes).toBe(buf.length);
  });

  // `full` opts into a BIGGER read, not an unbounded one — otherwise the button
  // on the partial-view bar is a way to hang the renderer on any size of file.
  it('still refuses the full read above FULL_READ_MAX_BYTES', async () => {
    const line = 'c'.repeat(99) + '\n';
    const buf = Buffer.from(line.repeat(Math.ceil((FULL_READ_MAX_BYTES + 5000) / line.length)));
    const id = writeFile('huge.log', buf);

    const res = await getHandler()({}, { projectRoot: root, artifactId: id, full: true });
    expect(res.truncated).toBe(true);
    expect(res.content.length).toBeLessThanOrEqual(EDIT_MAX_BYTES);
  });

  it('leaves an under-cap file alone but still stamps size and truncated', async () => {
    const id = writeFile('small.txt', Buffer.from('hello\nworld\n'));
    const res = await getHandler()({}, { projectRoot: root, artifactId: id });
    expect(res.content).toBe('hello\nworld\n');
    expect(res.truncated).toBe(false);
    expect(res.sizeBytes).toBe(12);
  });
});
