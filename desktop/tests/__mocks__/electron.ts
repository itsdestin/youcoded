/**
 * Minimal Electron stub for Vitest — prevents crashes when main-process
 * modules are imported in a Node.js test environment.
 */
import { vi } from 'vitest';

export const app = {
  getPath: vi.fn(() => '/tmp'),
  whenReady: vi.fn(() => Promise.resolve()),
  on: vi.fn(),
  quit: vi.fn(),
  isReady: vi.fn(() => true),
  getName: vi.fn(() => 'youcoded-test'),
};

export const protocol = {
  registerSchemesAsPrivileged: vi.fn(),
  handle: vi.fn(),
};

export const ipcMain = {
  handle: vi.fn(),
  // Handler modules clear prior registrations before re-registering (hot reload);
  // without this the mock throws before a single handler is captured.
  removeHandler: vi.fn(),
  on: vi.fn(),
};

export const BrowserWindow = vi.fn().mockImplementation(() => ({
  webContents: { send: vi.fn(), on: vi.fn() },
  isDestroyed: () => false,
  on: vi.fn(),
  loadURL: vi.fn(),
}));

export const dialog = {
  showOpenDialog: vi.fn(() => Promise.resolve({ canceled: true, filePaths: [] })),
  showSaveDialog: vi.fn(() => Promise.resolve({ canceled: true, filePath: undefined })),
};

export const clipboard = {
  readText: vi.fn(() => ''),
  writeText: vi.fn(),
  readImage: vi.fn(() => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) })),
};

export const nativeImage = {
  createFromPath: vi.fn(() => ({ isEmpty: () => true })),
  createFromBuffer: vi.fn(() => ({ isEmpty: () => true })),
};

export const shell = {
  openExternal: vi.fn(),
  openPath: vi.fn(),
  // git surface discard of untracked files (git-service.ts) — resolves like Electron 41
  trashItem: vi.fn(async (_path: string) => undefined),
};

export const powerSaveBlocker = {
  start: vi.fn(() => 0),
  stop: vi.fn(),
};

export const safeStorage = {
  isEncryptionAvailable: () => true,
  // Reversible fake "encryption" so tests can assert the plaintext never
  // appears on disk while decrypt still round-trips.
  encryptString: (s: string) =>
    Buffer.from('enc:' + Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
  decryptString: (b: Buffer) => {
    const raw = b.toString('utf8');
    if (!raw.startsWith('enc:')) throw new Error('not encrypted');
    return Buffer.from(raw.slice(4), 'base64').toString('utf8');
  },
};

// crash-diagnostics.ts starts this at import time; without a stub every test
// that pulls in main.ts throws before reaching its own assertions.
export const crashReporter = {
  start: vi.fn(),
};

export default {
  app,
  crashReporter,
  protocol,
  ipcMain,
  BrowserWindow,
  dialog,
  clipboard,
  nativeImage,
  shell,
  powerSaveBlocker,
  safeStorage,
};
