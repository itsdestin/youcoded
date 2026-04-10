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
  getName: vi.fn(() => 'destincode-test'),
};

export const protocol = {
  registerSchemesAsPrivileged: vi.fn(),
  handle: vi.fn(),
};

export const ipcMain = {
  handle: vi.fn(),
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
};

export const powerSaveBlocker = {
  start: vi.fn(() => 0),
  stop: vi.fn(),
};

export default {
  app,
  protocol,
  ipcMain,
  BrowserWindow,
  dialog,
  clipboard,
  nativeImage,
  shell,
  powerSaveBlocker,
};
