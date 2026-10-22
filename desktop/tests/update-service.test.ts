import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { LaunchInstallerDeps } from '../src/main/update-installer';
import type { UpdateLaunchResult } from '../src/shared/update-install-types';

const mocks = vi.hoisted(() => ({
  launch: vi.fn(), verify: vi.fn(), quit: vi.fn(), relaunch: vi.fn(), send: vi.fn(),
  deps: null as LaunchInstallerDeps | null, savedAutoInstall: true, packaged: true, readGate: null as Promise<void> | null, readValue: true,
}));
vi.mock('electron', () => ({
  app: { get isPackaged() { return mocks.packaged; }, getVersion: () => '1.0.0', getPath: () => '/unused', quit: mocks.quit, relaunch: mocks.relaunch },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }] },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../src/main/update-installer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/update-installer')>();
  return { ...actual, createUpdateInstaller: () => ({}), makeLaunchInstaller: (deps: LaunchInstallerDeps) => { mocks.deps = deps; return mocks.launch; } };
});
vi.mock('../src/main/update-manifest-verify', () => ({ verifyDownloadedUpdate: mocks.verify }));
vi.mock('../src/main/update-settings', () => ({ UpdateSettings: class {
  resolve() { return false; }
  async readAsync() {
    const gate = mocks.readGate;
    const value = mocks.savedAutoInstall;
    if (gate) await gate; // a test can hold the read open
    return { betaChannel: null, autoInstall: gate ? mocks.readValue : value };
  }
  async setAutoInstall(v: unknown) { if (typeof v !== 'boolean') throw new TypeError('bad'); mocks.savedAutoInstall = v; }
} }));
vi.mock('../src/main/native-home', () => ({ NativeHome: class {} }));
vi.mock('../src/main/linux-install-kind', () => ({ linuxInstallKind: () => 'deb', primeLinuxInstallKind: async () => {} }));
vi.mock('../src/main/update-release-status', () => ({
  readReleaseStatus: () => ({ manifest_url: 'https://github.com/manifest', signature_url: 'https://github.com/signature', tag: 'v2.0.0' }),
}));
vi.mock('https', () => ({ default: { get: (_url: string, _opts: unknown, callback: (response: unknown) => void) => {
  const request = new EventEmitter();
  const response = Object.assign(new EventEmitter(), { statusCode: 200 });
  queueMicrotask(() => { callback(response); response.emit('data', Buffer.from('{}')); response.emit('end'); });
  return request;
} } }));

describe('update service launch ownership', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); mocks.verify.mockResolvedValue(undefined); });
  afterEach(() => { vi.useRealTimers(); });

  async function service() {
    const service = (await import('../src/main/update-service')).getUpdateService();
    await service.fetchLatestRelease();
    return service;
  }
  const input = { jobId: 'one', filePath: '/unused/package.deb' };

  it('refuses another job during verification and through the quit grace period', async () => {
    let verified!: () => void;
    mocks.verify.mockImplementationOnce(() => new Promise<void>(resolve => { verified = resolve; }));
    mocks.launch.mockResolvedValue({ success: true, quitPending: true });
    const s = await service();
    const pending = s.launch(input);
    await vi.waitFor(() => expect(mocks.verify).toHaveBeenCalledTimes(1));
    expect(await s.launch({ ...input, jobId: 'two' })).toMatchObject({ success: false, error: 'busy' });
    expect(mocks.verify).toHaveBeenCalledTimes(1);
    verified();
    expect(await pending).toMatchObject({ success: true, quitPending: true });
    expect(await s.launch(input)).toMatchObject({ success: false, error: 'busy' });
    expect(mocks.launch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.quit).toHaveBeenCalledTimes(1);
  });

  it('broadcasts progress locally and handles late success after an unknown timeout', async () => {
    mocks.launch.mockResolvedValue({ success: false, error: 'install-timeout' });
    const s = await service();
    expect(await s.launch(input)).toMatchObject({ error: 'install-timeout' });
    expect(await s.launch({ ...input, jobId: 'two' })).toMatchObject({ error: 'busy' });
    const event = { jobId: 'one', phase: 'restarting' as const, output: 'Done' };
    mocks.deps!.onInstallProgress!(event);
    expect(mocks.send).toHaveBeenCalledWith('update:install-progress', event);
    mocks.deps!.onLateInstallResult!({ success: true, quitPending: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.quit).toHaveBeenCalledTimes(1);
  });

  it('releases ownership after a real failure, including late failure', async () => {
    const failure: UpdateLaunchResult = { success: false, error: 'install-failed', output: 'refused' };
    mocks.launch.mockResolvedValueOnce({ success: false, error: 'install-timeout' }).mockResolvedValue(failure);
    const s = await service();
    await s.launch(input);
    mocks.deps!.onLateInstallResult!(failure);
    expect(await s.launch({ ...input, jobId: 'two' })).toEqual(failure);
    expect(await s.launch(input)).toEqual(failure);
    expect(mocks.launch).toHaveBeenCalledTimes(3);
    expect(mocks.quit).not.toHaveBeenCalled();
  });
});

// "Install updates automatically" (#183): what the service answers, and that a check or quit never
// needs a file read.
describe('update service auto-install', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); mocks.savedAutoInstall = true; mocks.packaged = true; mocks.readGate = null; delete process.env.YOUCODED_HEADLESS_PORT; });
  afterEach(() => { mocks.packaged = true; delete process.env.YOUCODED_HEADLESS_PORT; delete process.env.YOUCODED_DEV_FAKE_UPDATE; });
  const load = async () => (await import('../src/main/update-service')).getUpdateService();

  it('answers on by default and remembers a change in memory', async () => {
    const s = await load();
    expect(s.autoInstallEnabled()).toBe(true); // before the async read lands: default on, no file read
    expect(await s.getAutoInstall()).toEqual({ supported: true, enabled: true });
    expect(await s.setAutoInstall(false)).toEqual({ supported: true, enabled: false });
    expect(s.autoInstallEnabled()).toBe(false);
    expect(await s.getAutoInstall()).toEqual({ supported: true, enabled: false });
  });

  it('starts from the saved value', async () => {
    mocks.savedAutoInstall = false;
    const s = await load();
    expect(await s.getAutoInstall()).toEqual({ supported: true, enabled: false });
  });

  it('refuses a non-boolean and keeps the old answer', async () => {
    const s = await load();
    await expect(s.setAutoInstall('yes' as unknown as boolean)).rejects.toThrow(TypeError);
    expect(await s.getAutoInstall()).toEqual({ supported: true, enabled: true });
  });

  it('is unsupported on the Android headless backend', async () => {
    process.env.YOUCODED_HEADLESS_PORT = '9000';
    const s = await load();
    expect(await s.getAutoInstall()).toEqual({ supported: false });
    expect(await s.setAutoInstall(false)).toEqual({ supported: false });
    expect(mocks.savedAutoInstall).toBe(true); // nothing was written
    expect(s.autoInstallEnabled()).toBe(false);
  });

  it('is unsupported in an unpackaged build unless the dev fake update is on', async () => {
    mocks.packaged = false;
    expect(await (await load()).getAutoInstall()).toEqual({ supported: false });
    vi.resetModules();
    process.env.YOUCODED_DEV_FAKE_UPDATE = '1';
    expect(await (await load()).getAutoInstall()).toEqual({ supported: true, enabled: true });
  });

  it('keeps a save made while the first read was still open', async () => {
    let release!: () => void;
    mocks.readGate = new Promise<void>((r) => { release = r; });
    mocks.readValue = true; // the stale file contents the held read will return
    const s = await load();
    const asked = s.getAutoInstall();               // starts the read, which is now held
    await s.setAutoInstall(false);                  // the save completes first
    release();                                      // the read resolves with the older "true"
    expect(await asked).toEqual({ supported: true, enabled: false });
    expect(s.autoInstallEnabled()).toBe(false);
  });

  it('applies two quick saves in the order they were made', async () => {
    const s = await load();
    const first = s.setAutoInstall(false);
    const second = s.setAutoInstall(true);
    await Promise.all([first, second]);
    expect(mocks.savedAutoInstall).toBe(true);
    expect(s.autoInstallEnabled()).toBe(true);
  });

  it('sees a change made by the other app only when asked to re-read', async () => {
    const s = await load();
    await s.getAutoInstall();
    mocks.savedAutoInstall = false; // the other instance edited config.json
    expect(s.autoInstallEnabled()).toBe(true);
    await s.refreshAutoInstall();
    expect(s.autoInstallEnabled()).toBe(false);
  });
});
