import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { LaunchInstallerDeps } from '../src/main/update-installer';
import type { UpdateLaunchResult } from '../src/shared/update-install-types';

const mocks = vi.hoisted(() => ({
  launch: vi.fn(), verify: vi.fn(), quit: vi.fn(), relaunch: vi.fn(), send: vi.fn(),
  deps: null as LaunchInstallerDeps | null, savedAutoInstall: true, packaged: true, readGate: null as Promise<void> | null, readValue: true,
  // Download tests (#183): a private userData folder, a scriptable download engine and release answer.
  userData: '/unused', installer: {} as Record<string, unknown>, httpStatus: 200, setBeta: vi.fn(),
  release: null as null | Record<string, unknown>,
}));
const DEFAULT_RELEASE = { manifest_url: 'https://github.com/manifest', signature_url: 'https://github.com/signature', tag: 'v2.0.0' };
vi.mock('electron', () => ({
  app: { get isPackaged() { return mocks.packaged; }, getVersion: () => '1.0.0', getPath: () => mocks.userData, getAppPath: () => '/unused', quit: mocks.quit, relaunch: mocks.relaunch },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }] },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../src/main/update-installer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/update-installer')>();
  return { ...actual, createUpdateInstaller: () => mocks.installer, makeLaunchInstaller: (deps: LaunchInstallerDeps) => { mocks.deps = deps; return mocks.launch; } };
});
vi.mock('../src/main/update-manifest-verify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/update-manifest-verify')>();
  return { ...actual, verifyDownloadedUpdate: mocks.verify };
});
vi.mock('../src/main/update-settings', () => ({ UpdateSettings: class {
  resolve() { return false; }
  async readAsync() {
    const gate = mocks.readGate;
    const value = mocks.savedAutoInstall;
    if (gate) await gate; // a test can hold the read open
    return { betaChannel: null, autoInstall: gate ? mocks.readValue : value };
  }
  read() { return { betaChannel: null, autoInstall: true }; }
  async setBetaChannel(v: unknown) { mocks.setBeta(v); }
  async setAutoInstall(v: unknown) { if (typeof v !== 'boolean') throw new TypeError('bad'); mocks.savedAutoInstall = v; }
} }));
vi.mock('../src/main/native-home', () => ({ NativeHome: class {} }));
vi.mock('../src/main/linux-install-kind', () => ({ linuxInstallKind: () => 'deb', primeLinuxInstallKind: async () => {} }));
vi.mock('../src/main/update-release-status', () => ({
  readReleaseStatus: () => mocks.release ?? DEFAULT_RELEASE,
}));
vi.mock('https', () => ({ default: { get: (_url: string, _opts: unknown, callback: (response: unknown) => void) => {
  const request = new EventEmitter();
  const response = Object.assign(new EventEmitter(), { statusCode: mocks.httpStatus, resume: () => {} });
  queueMicrotask(() => { callback(response); response.emit('data', Buffer.from('{}')); response.emit('end'); });
  return request;
} } }));

describe('update service launch ownership', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); mocks.verify.mockResolvedValue(undefined); mocks.release = null; mocks.httpStatus = 200; mocks.installer = {}; });
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

// Background download and the one download owner (#183): what is fetched, when, and what is kept.
describe('update service downloads', () => {
  let userData: string;
  let cacheDir: string;
  let started: ReturnType<typeof vi.fn>;
  let gate: Promise<void> | null;
  const asset = (v: string) => `YouCoded-${v}.deb`;
  const release = (v: string) => ({ manifest_url: 'https://github.com/manifest', signature_url: 'https://github.com/signature', tag: `v${v}`, latest: v, update_available: true, download_url: `https://github.com/itsdestin/youcoded/releases/download/v${v}/${asset(v)}` });

  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'update-service-dl-'));
    cacheDir = path.join(userData, 'update-cache');
    mocks.userData = userData; mocks.packaged = true; mocks.savedAutoInstall = true; mocks.readGate = null; mocks.httpStatus = 200;
    mocks.release = release('2.0.0');
    mocks.verify.mockResolvedValue({ assets: [] });
    gate = null;
    // A download engine that writes the file it is asked for, optionally held open by `gate`.
    started = vi.fn(async (url: string) => {
      if (gate) await gate;
      const name = url.split('/').pop()!;
      fs.mkdirSync(cacheDir, { recursive: true });
      const filePath = path.join(cacheDir, name);
      fs.writeFileSync(filePath, 'installer');
      return { jobId: `job-${started.mock.calls.length}`, filePath, bytesTotal: 9 };
    });
    mocks.installer = { startDownload: started, cancelDownload: vi.fn(), getActiveProgress: () => ({ jobId: 'job-1', percent: 42 }) };
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.YOUCODED_DEV_FAKE_UPDATE;
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const load = async () => (await import('../src/main/update-service')).getUpdateService();
  /** 60 s after the first window: the background clock has started. */
  const armed = async (s: Awaited<ReturnType<typeof load>>) => { s.onFirstWindowReady(); await vi.advanceTimersByTimeAsync(60_000); };
  const check = async (s: Awaited<ReturnType<typeof load>>) => { await s.fetchLatestRelease(); await s.afterCheckDone(); };
  const writePendingJson = (extra: Record<string, unknown> = {}) => {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'pending.json'), JSON.stringify({
      version: '2.0.0', tag: 'v2.0.0', manifestUrl: 'https://github.com/manifest', signatureUrl: 'https://github.com/signature', assetName: asset('2.0.0'), ...extra,
    }));
  };

  it('downloads in the background after a check once the first window has been up 60 seconds', async () => {
    const s = await load();
    await check(s);
    expect(started).not.toHaveBeenCalled(); // first window not ready: the deferral holds
    s.onFirstWindowReady();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(started).not.toHaveBeenCalled(); // still inside the 60 seconds
    await vi.advanceTimersByTimeAsync(1_000);
    await s.afterCheckDone();
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(s.getUpdateStatus().downloaded).toBe(true));
    expect(fs.existsSync(path.join(cacheDir, asset('2.0.0')))).toBe(true);
  });

  it('downloads nothing while the switch is off', async () => {
    mocks.savedAutoInstall = false;
    const s = await load();
    await armed(s);
    await check(s);
    expect(started).not.toHaveBeenCalled();
    expect(s.getUpdateStatus().downloaded).toBe(false);
  });

  it('gives the popup and the background run one job, not two', async () => {
    let open!: () => void;
    gate = new Promise<void>((r) => { open = r; });
    const s = await load();
    await armed(s);
    const checking = check(s);
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));
    const fromPopup = s.download();           // "Update now" while the background job runs
    open();
    const [popup] = await Promise.all([fromPopup, checking]);
    expect(started).toHaveBeenCalledTimes(1); // never a second job, never 'busy'
    expect(popup.filePath).toBe(path.join(cacheDir, asset('2.0.0')));
  });

  it('reports a running job to a reopened popup', async () => {
    let open!: () => void;
    gate = new Promise<void>((r) => { open = r; });
    const s = await load();
    await s.fetchLatestRelease();
    const job = s.download();
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    expect(await s.getCachedDownload('2.0.0')).toEqual({ downloading: { percent: 42, jobId: 'job-1' } });
    open();
    await job;
    expect(await s.getCachedDownload('2.0.0')).toEqual({ filePath: path.join(cacheDir, asset('2.0.0')), version: '2.0.0' });
  });

  it('turning the switch on starts a download without waiting for the next check or the 60 seconds', async () => {
    mocks.savedAutoInstall = false;
    const s = await load();
    await check(s);
    expect(started).not.toHaveBeenCalled();
    await s.setAutoInstall(true);
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));
  });

  it('deletes a download whose check against the signed file fails, and keeps no pending record', async () => {
    const { UpdateInstallError } = await import('../src/main/update-installer');
    mocks.verify.mockRejectedValue(new UpdateInstallError('verify-failed', 'sha256 mismatch'));
    const s = await load();
    await s.fetchLatestRelease();
    await expect(s.download()).rejects.toMatchObject({ code: 'verify-failed' });
    expect(fs.existsSync(path.join(cacheDir, asset('2.0.0')))).toBe(false);
    expect(fs.existsSync(path.join(cacheDir, 'pending.json'))).toBe(false);
    expect(s.getUpdateStatus().downloaded).toBe(false);
  });

  it('keeps the file when the signed release file could not be fetched at all', async () => {
    mocks.httpStatus = 500;
    const s = await load();
    await s.fetchLatestRelease();
    await expect(s.download()).rejects.toMatchObject({ code: 'verify-failed' });
    expect(fs.existsSync(path.join(cacheDir, asset('2.0.0')))).toBe(true); // the download itself may be fine
  });

  it('keeps the older download until the newer release has verified, then removes it', async () => {
    const s = await load();
    await s.fetchLatestRelease();
    await s.download();
    const older = path.join(cacheDir, asset('2.0.0'));
    mocks.release = release('2.1.0');
    mocks.httpStatus = 200;
    // The newer one fails its check: the older stays, still pending.
    const { UpdateInstallError } = await import('../src/main/update-installer');
    mocks.verify.mockRejectedValueOnce(new UpdateInstallError('verify-failed', 'bad'));
    await s.fetchLatestRelease();
    await s.afterCheckDone();
    await expect(s.download()).rejects.toMatchObject({ code: 'verify-failed' });
    expect(fs.existsSync(older)).toBe(true);
    // It passes on the retry: now the older one goes.
    await s.download();
    expect(fs.existsSync(path.join(cacheDir, asset('2.1.0')))).toBe(true);
    expect(fs.existsSync(older)).toBe(false);
    expect(s.getUpdateStatus()).toMatchObject({ latest: '2.1.0', downloaded: true });
  });

  it('never downloads in an unpackaged build', async () => {
    mocks.packaged = false;
    const s = await load();
    await armed(s);
    await check(s);
    await expect(s.download()).rejects.toMatchObject({ code: 'unsupported-platform' });
    expect(started).not.toHaveBeenCalled();
  });

  it('never sweeps the pending download, however old, but sweeps other stale files', async () => {
    writePendingJson();
    mocks.release = release('2.1.0'); // a NEWER release is out, so the pending file is not "the latest's file" and only the pending record protects it
    fs.mkdirSync(cacheDir, { recursive: true });
    const old = Date.now() / 1000 - 72 * 3600;
    for (const name of [asset('2.0.0'), asset('0.5.0')]) {
      fs.writeFileSync(path.join(cacheDir, name), 'x');
      fs.utimesSync(path.join(cacheDir, name), old, old);
    }
    const s = await load();
    expect(started).not.toHaveBeenCalled();
    await check(s); // the first successful check runs the sweep
    expect(fs.existsSync(path.join(cacheDir, asset('2.0.0')))).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, 'pending.json'))).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, asset('0.5.0')))).toBe(false);
  });

  it('does not sweep at startup, only after a check', async () => {
    fs.mkdirSync(cacheDir, { recursive: true });
    const stale = path.join(cacheDir, asset('0.5.0'));
    fs.writeFileSync(stale, 'x');
    fs.utimesSync(stale, Date.now() / 1000 - 72 * 3600, Date.now() / 1000 - 72 * 3600);
    await load();
    await armed(await load());
    expect(fs.existsSync(stale)).toBe(true);
  });

  it('says downloaded for the latest release and needs_password for a Linux package install', async () => {
    const s = await load();
    await s.fetchLatestRelease();
    expect(s.getUpdateStatus()).toMatchObject({ downloaded: false });
    await s.download();
    expect(s.getUpdateStatus()).toMatchObject({ downloaded: true, needs_password: true, install_refused: false });
  });

  it('tells every window the moment the pending download changes', async () => {
    const s = await load();
    await s.fetchLatestRelease();
    await s.download(); // lets startup settle
    const listener = vi.fn();
    s.onStatusChange(listener);
    mocks.release = release('2.1.0');
    await s.fetchLatestRelease();
    await s.afterCheckDone();
    await s.download();
    expect(listener).toHaveBeenCalled();
  });

  it('rebuilds the file path from the asset name and ignores any path in pending.json', async () => {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, asset('2.0.0')), 'x');
    writePendingJson({ filePath: '/etc/passwd', path: '/etc/shadow' });
    const s = await load();
    await s.fetchLatestRelease();
    expect(await s.getCachedDownload('2.0.0')).toEqual({ filePath: path.join(cacheDir, asset('2.0.0')), version: '2.0.0' });
  });

  it('drops a pending.json whose asset name tries to leave the cache folder', async () => {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(userData, 'outside.deb'), 'x');
    writePendingJson({ assetName: '../outside.deb' });
    const s = await load();
    await s.fetchLatestRelease();
    expect(s.getUpdateStatus().downloaded).toBe(false);
    expect(await s.getCachedDownload('2.0.0')).toBeNull();
  });

  it('clears the pending download when the beta channel changes', async () => {
    const s = await load();
    await s.fetchLatestRelease();
    await s.download();
    expect(s.getUpdateStatus().downloaded).toBe(true);
    mocks.release = { ...release('2.0.0'), update_available: false };
    await s.setBetaChannel(true);
    expect(s.getUpdateStatus().downloaded).toBe(false);
    expect(fs.existsSync(path.join(cacheDir, 'pending.json'))).toBe(false);
  });

  it('stops background downloads after Cancel until the next check', async () => {
    const s = await load();
    await check(s);                 // a check passed; the first window is not up yet
    s.cancel('job-1');              // the person pressed Cancel
    await armed(s);                 // the 60 seconds elapse: nothing starts behind their back
    await s.afterCheckDone();
    expect(started).not.toHaveBeenCalled();
    await check(s);                 // the next check lifts it
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));
  });

  it('carries the HTTP status of the last hop on a failed signed-file fetch', async () => {
    mocks.httpStatus = 404;
    const s = await load();
    await expect(s.fetchUrlToBuffer('https://github.com/manifest', 1024)).rejects.toMatchObject({ code: 'network-failed', httpStatus: 404 });
  });
});
