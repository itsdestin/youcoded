// electron-headless.ts — what `require('electron')` returns inside the headless backend.
//
// WHY (2026-10-14, Android clean rebuild P1): the Android app runs the desktop's own backend in a
// plain Node process. About sixty backend files import Electron; most only for a path, the app
// version or a link opener, and the rest belong to features a phone does not have (windows, the
// buddy, the tray). Rather than fork those files, the headless entry points the module name
// `electron` here (install-electron-shim.ts). Each member does the phone's version of the job:
// paths come from the environment the app sets, links and keep-awake go to the app over the host
// bridge, secrets are sealed with a key the app keeps in the Android Keystore, and window/screen
// APIs report "no windows". A member a phone cannot honour fails loudly rather than pretending.
import crypto from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { hostCall, hostNotify, hasHost } from './host-bridge';

// dist/main/headless → the desktop folder that holds package.json (where the dev tree keeps scripts/).
const APP_ROOT = path.resolve(__dirname, '..', '..', '..');

function userDataDir(): string {
  return process.env.YOUCODED_USER_DATA || path.join(os.homedir(), '.youcoded-headless');
}

// Read once when the backend starts: the app passes its own version; a laptop run falls back to package.json.
const APP_VERSION: string = process.env.YOUCODED_APP_VERSION || (() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- one startup read of a JSON file
  try { return (require(path.join(APP_ROOT, 'package.json')) as { version: string }).version; } catch { return '0.0.0'; }
})();
function appVersion(): string { return APP_VERSION; }

const pathOverrides = new Map<string, string>();

class HeadlessApp extends EventEmitter {
  // Not "packaged" in Electron's sense: there is no app.asar, so every packaged-only branch
  // (asar.unpacked paths, resourcesPath) would point at nothing. Files sit beside dist/.
  isPackaged = false;
  commandLine = { appendSwitch: () => {}, hasSwitch: () => false, getSwitchValue: () => '' };
  runningUnderARM = false;
  dock = undefined;
  private name = 'YouCoded';
  getPath(name: string): string {
    const o = pathOverrides.get(name);
    if (o) return o;
    switch (name) {
      case 'userData': return userDataDir();
      case 'appData': return path.dirname(userDataDir());
      case 'home': return os.homedir();
      case 'temp': return os.tmpdir();
      case 'logs': return path.join(userDataDir(), 'logs');
      case 'downloads': return path.join(os.homedir(), 'Download');
      case 'documents': return path.join(os.homedir(), 'Documents');
      case 'desktop': return os.homedir();
      case 'exe': return process.execPath;
      case 'crashDumps': return path.join(userDataDir(), 'crashes');
      default: return userDataDir();
    }
  }
  setPath(name: string, value: string): void { pathOverrides.set(name, value); }
  getVersion(): string { return appVersion(); }
  getName(): string { return this.name; }
  setName(n: string): void { this.name = n; }
  getAppPath(): string { return APP_ROOT; }
  whenReady(): Promise<void> { return Promise.resolve(); }
  isReady(): boolean { return true; }
  getGPUInfo(): Promise<Record<string, never>> { return Promise.resolve({}); }
  quit(): void { this.emit('before-quit'); this.emit('will-quit', { preventDefault: () => {} }); process.exit(0); }
  exit(code = 0): void { process.exit(code); }
  // The host app restarts the backend when it exits; a relaunch is just an exit.
  relaunch(): void { /* the host restarts us */ }
  setAppUserModelId(): void {}
  requestSingleInstanceLock(): boolean { return true; }
}

export const app = new HeadlessApp();

/** No windows exist in the headless backend: every lookup finds none. */
export class BrowserWindow {
  constructor() { throw new Error('The headless backend has no windows.'); }
  static getAllWindows(): BrowserWindow[] { return []; }
  static fromWebContents(): BrowserWindow | null { return null; }
  static fromId(): BrowserWindow | null { return null; }
  static getFocusedWindow(): BrowserWindow | null { return null; }
}

export const webContents = {
  fromId: (): undefined => undefined,
  getAllWebContents: (): never[] => [],
  getFocusedWebContents: (): null => null,
};

/** The window door's registration calls, kept in memory: nothing in the headless backend invokes
 *  them, but the wiring registers every channel through this object. */
class HeadlessIpcMain extends EventEmitter {
  private handlers = new Map<string, (...args: unknown[]) => unknown>();
  handle(channel: string, fn: (...args: unknown[]) => unknown): void { this.handlers.set(channel, fn); }
  handleOnce(channel: string, fn: (...args: unknown[]) => unknown): void { this.handlers.set(channel, fn); }
  removeHandler(channel: string): void { this.handlers.delete(channel); }
}
export const ipcMain = new HeadlessIpcMain();

export const shell = {
  async openExternal(url: string): Promise<void> {
    if (hasHost()) { await hostCall('openExternal', { url }); return; }
    console.log(`[headless] open in a browser: ${url}`);
  },
  async openPath(p: string): Promise<string> {
    if (!hasHost()) return 'No app to open files with.';
    try { await hostCall('openPath', { path: p }); return ''; } catch (e) { return e instanceof Error ? e.message : String(e); }
  },
  showItemInFolder(p: string): void { hostNotify('openPath', { path: path.dirname(p) }); },
  // WHY a trash folder, not a delete (independent review, 2026-10-15): git's "Discard" on an untracked file relies on
  // the trash being recoverable (git-service.ts). The phone has no system trash, so the file moves under userData.
  async trashItem(p: string): Promise<void> {
    const dir = path.join(userDataDir(), 'Trash');
    await fs.promises.mkdir(dir, { recursive: true });
    const dest = path.join(dir, `${Date.now()}-${path.basename(p)}`);
    try {
      await fs.promises.rename(p, dest);
    } catch (e) {
      // Another filesystem (rename cannot cross it): copy, then remove the original only once the copy exists.
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      await fs.promises.cp(p, dest, { recursive: true });
      await fs.promises.rm(p, { recursive: true, force: true });
    }
  },
  beep(): void {},
  readShortcutLink(): never { throw new Error('Shortcuts are a Windows feature.'); },
  writeShortcutLink(): boolean { return false; },
};

export const dialog = {
  // File pickers are the host's (Android's own picker); until a caller routes through the host, a
  // dialog answers "cancelled" — the same answer as a person closing it.
  async showOpenDialog(): Promise<{ canceled: boolean; filePaths: string[] }> { return { canceled: true, filePaths: [] }; },
  async showSaveDialog(): Promise<{ canceled: boolean; filePath?: string }> { return { canceled: true }; },
  async showMessageBox(): Promise<{ response: number; checkboxChecked: boolean }> { return { response: 0, checkboxChecked: false }; },
  showErrorBox(title: string, content: string): void { console.error(`[headless] ${title}: ${content}`); },
};

// Secrets: AES-256-GCM under a key the host app generates once and keeps in the Android Keystore,
// handed to this process in YOUCODED_SECRET_KEY (64 hex chars). Format: iv(12) | tag(16) | data.
// WHY held here and removed from the environment (independent review, 2026-10-15): the backend's environment is
// copied into every terminal it starts (pty-worker.js), so Claude Code — and any `env`, install script or tool it
// runs — could read the key that seals saved API keys. headless-main.ts hands it over once and deletes the variable.
let heldSecretKey: Buffer | null = null;
export function holdSecretKey(hex: string | undefined): void {
  heldSecretKey = hex && /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, 'hex') : null;
}
function secretKey(): Buffer | null {
  return heldSecretKey;
}
export const safeStorage = {
  isEncryptionAvailable: (): boolean => secretKey() !== null,
  encryptString(value: string): Buffer {
    const key = secretKey();
    if (!key) throw new Error('Secret storage is not available.');
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([c.update(value, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), data]);
  },
  decryptString(blob: Buffer): string {
    const key = secretKey();
    if (!key) throw new Error('Secret storage is not available.');
    const d = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
    d.setAuthTag(blob.subarray(12, 28));
    return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString('utf8');
  },
  getSelectedStorageBackend: (): string => 'android_keystore',
  setUsePlainTextEncryption: (): void => {},
};

const emptyImage = {
  isEmpty: () => true,
  toPNG: () => Buffer.alloc(0),
  toJPEG: () => Buffer.alloc(0),
  toDataURL: () => '',
  getSize: () => ({ width: 0, height: 0 }),
  resize: () => emptyImage,
};
export const nativeImage = {
  createEmpty: () => emptyImage,
  createFromPath: () => emptyImage,
  createFromDataURL: () => emptyImage,
  createFromBitmap: () => emptyImage,
  createFromBuffer: () => emptyImage,
};
// WHY: mirrors Electron 44's async clipboard (read/readText/writeText return promises); the phone has
// no desktop clipboard, so reads are empty. The removed sync readImage is gone from the real module too.
export const clipboard = {
  read: async (): Promise<never[]> => [],
  readText: async (): Promise<string> => '',
  writeText: async (): Promise<void> => {},
};

let keepAwakeIds = 0;
const keepAwake = new Set<number>();
export const powerSaveBlocker = {
  start(): number {
    const id = ++keepAwakeIds;
    if (keepAwake.size === 0) hostNotify('keepAwake', { on: true });
    keepAwake.add(id);
    return id;
  },
  stop(id: number): void {
    if (!keepAwake.delete(id)) return;
    if (keepAwake.size === 0) hostNotify('keepAwake', { on: false });
  },
  isStarted: (id: number): boolean => keepAwake.has(id),
};

class HeadlessPowerMonitor extends EventEmitter {
  // The phone has no idle clock the backend can read; "just active" keeps presence online.
  getSystemIdleTime(): number { return 0; }
  getSystemIdleState(): string { return 'active'; }
}
export const powerMonitor = new HeadlessPowerMonitor();

const display = { id: 1, bounds: { x: 0, y: 0, width: 1080, height: 1920 }, workArea: { x: 0, y: 0, width: 1080, height: 1920 }, scaleFactor: 1 };
export const screen = Object.assign(new EventEmitter(), {
  getPrimaryDisplay: () => display,
  getAllDisplays: () => [display],
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  getDisplayMatching: () => display,
  getDisplayNearestPoint: () => display,
});

export const systemPreferences = {
  getMediaAccessStatus: (): string => 'granted',
  askForMediaAccess: async (): Promise<boolean> => true,
  getUserDefault: (): undefined => undefined,
};

export const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false, themeSource: 'system' });

export const net = { fetch: (input: string | URL | Request, init?: RequestInit) => fetch(input, init) };

export const Menu = {
  setApplicationMenu: (): void => {},
  buildFromTemplate: () => ({ popup: () => {}, items: [] }),
  getApplicationMenu: (): null => null,
};
export const protocol = { registerSchemesAsPrivileged: (): void => {}, handle: (): void => {}, registerFileProtocol: (): void => {} };
export const crashReporter = { start: (): void => {} };
export const desktopCapturer = { getSources: async (): Promise<never[]> => [] };

export class Notification extends EventEmitter {
  constructor(private opts: { title?: string; body?: string } = {}) { super(); }
  static isSupported(): boolean { return hasHost(); }
  show(): void { hostNotify('notify', { title: this.opts.title ?? '', body: this.opts.body ?? '' }); }
  close(): void {}
}

export class Tray {
  constructor() { throw new Error('The headless backend has no tray.'); }
}

export const utilityProcess = {
  fork(): never { throw new Error('Utility processes are a desktop feature.'); },
};
