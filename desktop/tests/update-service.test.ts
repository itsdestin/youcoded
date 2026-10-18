import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { LaunchInstallerDeps } from '../src/main/update-installer';
import type { UpdateLaunchResult } from '../src/shared/update-install-types';

const mocks = vi.hoisted(() => ({
  launch: vi.fn(), verify: vi.fn(), quit: vi.fn(), relaunch: vi.fn(), send: vi.fn(),
  deps: null as LaunchInstallerDeps | null,
}));
vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '1.0.0', getPath: () => '/unused', quit: mocks.quit, relaunch: mocks.relaunch },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }] },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../src/main/update-installer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/update-installer')>();
  return { ...actual, createUpdateInstaller: () => ({}), makeLaunchInstaller: (deps: LaunchInstallerDeps) => { mocks.deps = deps; return mocks.launch; } };
});
vi.mock('../src/main/update-manifest-verify', () => ({ verifyDownloadedUpdate: mocks.verify }));
vi.mock('../src/main/update-settings', () => ({ UpdateSettings: class { resolve() { return false; } } }));
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
