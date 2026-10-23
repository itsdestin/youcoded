import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { LaunchInstallerDeps } from '../src/main/update-installer';
import type { UpdateLaunchResult } from '../src/shared/update-install-types';

const mocks = vi.hoisted(() => ({
  launch: vi.fn(), verify: vi.fn(), quit: vi.fn(), relaunch: vi.fn(), send: vi.fn(),
  deps: null as LaunchInstallerDeps | null, savedAutoInstall: true, packaged: true, readGate: null as Promise<void> | null, readValue: true, readFails: false,
  // Download tests (#183): a private userData folder, a scriptable download engine and release answer.
  userData: '/unused', installer: {} as Record<string, unknown>, httpStatus: 200, setBeta: vi.fn(),
  release: null as null | Record<string, unknown>,
  kind: 'deb' as string, stageAppImage: vi.fn(), stageMacApp: vi.fn(), spawn: vi.fn(), httpHang: false,
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
    if (mocks.readFails) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    if (gate) await gate; // a test can hold the read open
    return { betaChannel: null, autoInstall: gate ? mocks.readValue : value };
  }
  read() { return { betaChannel: null, autoInstall: true }; }
  async setBetaChannel(v: unknown) { mocks.setBeta(v); }
  async setAutoInstall(v: unknown) { if (typeof v !== 'boolean') throw new TypeError('bad'); mocks.savedAutoInstall = v; }
} }));
vi.mock('../src/main/native-home', () => ({ NativeHome: class {} }));
vi.mock('../src/main/linux-install-kind', () => ({ linuxInstallKind: () => mocks.kind, primeLinuxInstallKind: async () => {} }));
vi.mock('../src/main/update-staging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/update-staging')>();
  return { ...actual, stageAppImage: mocks.stageAppImage, stageMacApp: mocks.stageMacApp };
});
vi.mock('../src/main/update-release-status', () => ({
  readReleaseStatus: () => mocks.release ?? DEFAULT_RELEASE,
}));
vi.mock('child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('child_process')>()), spawn: mocks.spawn }));
vi.mock('https', () => ({ default: { get: (_url: string, _opts: unknown, callback: (response: unknown) => void) => {
  const request = new EventEmitter();
  if (mocks.httpHang) return request; // never answers: a network that went away
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
    // The quit launch() schedules is marked internal, so it can never quit-install (design rev 4 F3).
    expect((await import('../src/main/internal-quit')).takeInternalQuit()).toBe(true);
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

  it('keeps a saved off when a later re-read fails (a locked or half-written config file)', async () => {
    const s = await load();
    await s.setAutoInstall(false);
    mocks.readFails = true;
    try { await s.refreshAutoInstall(); expect(s.autoInstallEnabled()).toBe(false); }
    finally { mocks.readFails = false; }
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
    mocks.kind = 'deb'; mocks.stageAppImage.mockResolvedValue('.YouCoded-update-2.0.0.AppImage');
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

  it('carries the HTTP status of the last hop on a failed signed-file fetch', async () => {
    mocks.httpStatus = 404;
    const s = await load();
    await expect(s.fetchUrlToBuffer('https://github.com/manifest', 1024)).rejects.toMatchObject({ code: 'network-failed', httpStatus: 404 });
  });

  // ---- failures, races and the guards behind them (T2 review) ----

  it('tells every window when a download dies, so the popup leaves "Downloading…"', async () => {
    started.mockRejectedValue(new Error('boom'));
    const s = await load();
    await armed(s);
    await check(s);
    expect(mocks.send).toHaveBeenCalledWith('update:progress', expect.objectContaining({ failed: true, error: 'network-failed' }));
  });

  it('cancel stops whichever job is running even when it is given a stale or empty id', async () => {
    const s = await load();
    s.cancel('some-older-job');
    s.cancel(null);
    expect(mocks.installer.cancelDownload).toHaveBeenNthCalledWith(1, 'job-1');
    expect(mocks.installer.cancelDownload).toHaveBeenNthCalledWith(2, 'job-1');
  });

  it('throws away a download that finished after the beta channel changed, files and all', async () => {
    let open!: () => void;
    gate = new Promise<void>((r) => { open = r; });
    const s = await load();
    await s.fetchLatestRelease();
    const job = s.download();
    job.catch(() => {});
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    mocks.release = { ...release('2.0.0'), update_available: false };
    await s.setBetaChannel(true);
    open();
    await expect(job).rejects.toMatchObject({ code: 'network-failed' });
    expect(fs.existsSync(path.join(cacheDir, asset('2.0.0')))).toBe(false);
    expect(s.getUpdateStatus().downloaded).toBe(false);
  });

  it('deletes the old pending file, not just the record, when the beta channel changes', async () => {
    const s = await load();
    await s.fetchLatestRelease();
    await s.download();
    mocks.release = { ...release('2.0.0'), update_available: false };
    await s.setBetaChannel(true);
    expect(fs.existsSync(path.join(cacheDir, asset('2.0.0')))).toBe(false);
  });

  it('starts the newer release after the running job and never hands back the older file', async () => {
    let open!: () => void;
    gate = new Promise<void>((r) => { open = r; });
    const s = await load();
    await s.fetchLatestRelease();
    const first = s.download();
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));
    mocks.release = release('2.1.0');
    await s.fetchLatestRelease();           // 2.1.0 is announced mid-download
    const second = s.download();
    open();
    expect((await second).filePath).toBe(path.join(cacheDir, asset('2.1.0')));
    expect((await first).filePath).toBe(path.join(cacheDir, asset('2.1.0'))); // the first caller is moved on too
    expect(started.mock.calls.map((c) => c[0])).toEqual([release('2.0.0').download_url, release('2.1.0').download_url]);
  });

  it('does not sweep while a download runs, then sweeps once it ends', async () => {
    let open!: () => void;
    let release1!: () => void;
    gate = new Promise<void>((r) => { open = r; });
    mocks.readGate = new Promise<void>((r) => { release1 = r; }); // holds the first check's follow-up work open
    fs.mkdirSync(cacheDir, { recursive: true });
    const stale = path.join(cacheDir, asset('0.5.0'));
    fs.writeFileSync(stale, 'x');
    fs.utimesSync(stale, Date.now() / 1000 - 72 * 3600, Date.now() / 1000 - 72 * 3600);
    const s = await load();
    await s.fetchLatestRelease();             // the check landed; its follow-up (and sweep) is still waiting
    const job = s.download();                 // the person pressed Update now meanwhile
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));
    release1();
    await s.afterCheckDone();                 // the follow-up has now run to its end
    expect(fs.existsSync(stale)).toBe(true);  // ...and left the folder alone while the job runs
    open();
    await job;
    await vi.waitFor(() => expect(fs.existsSync(stale)).toBe(false));
  });

  it('a Cancel blocks the next background run until the next check', async () => {
    const s = await load();
    await check(s);
    s.cancel(null);
    await armed(s);
    await s.afterCheckDone();
    expect(started).not.toHaveBeenCalled();
    await check(s);                           // the next check lifts it
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));
  });

  it('a Cancel does not stop the person turning the switch on', async () => {
    mocks.savedAutoInstall = false;
    const s = await load();
    await check(s);
    s.cancel(null);
    await s.setAutoInstall(true);
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));
  });

  it('does not retry a release whose signed file failed until the next check', async () => {
    const { UpdateInstallError } = await import('../src/main/update-installer');
    mocks.verify.mockRejectedValue(new UpdateInstallError('signature-invalid', 'forged'));
    const s = await load();
    await armed(s);
    await check(s);
    expect(started).toHaveBeenCalledTimes(1);
    await s.setAutoInstall(true);            // asks for a background run again, with no new check
    await s.afterCheckDone();
    await vi.waitFor(() => expect(mocks.savedAutoInstall).toBe(true));
    expect(started).toHaveBeenCalledTimes(1);
  });

  it('says downloaded only for the release it holds, not for a newer latest', async () => {
    const s = await load();
    await s.fetchLatestRelease();
    await s.download();
    expect(s.getUpdateStatus().downloaded).toBe(true);
    mocks.release = release('2.1.0');
    await s.fetchLatestRelease();
    expect(s.getUpdateStatus()).toMatchObject({ latest: '2.1.0', downloaded: false });
  });

  it('keeps the file when the same asset is adopted again', async () => {
    const first = await load();
    await first.fetchLatestRelease();
    await first.download();
    vi.resetModules();                        // the app restarts: pending.json is loaded back, unverified
    const s = await load();
    await s.fetchLatestRelease();
    expect(s.getUpdateStatus().downloaded).toBe(false);
    await s.download();                       // verifies the file already on disk and adopts it again
    expect(fs.existsSync(path.join(cacheDir, asset('2.0.0')))).toBe(true);
    expect(s.getUpdateStatus().downloaded).toBe(true);
  });

  it('adopts and stages nothing when a file already on disk fails its check', async () => {
    const { UpdateInstallError } = await import('../src/main/update-installer');
    mocks.kind = 'appimage';
    process.env.APPIMAGE = path.join(userData, 'YouCoded.AppImage');
    fs.writeFileSync(process.env.APPIMAGE, 'running');
    const name = 'YouCoded-2.0.0.AppImage';
    mocks.release = { ...release('2.0.0'), download_url: `https://github.com/itsdestin/youcoded/releases/download/v2.0.0/${name}` };
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, name), 'tampered');
    mocks.verify.mockRejectedValue(new UpdateInstallError('verify-failed', 'sha256 mismatch'));
    const s = await load();
    await s.fetchLatestRelease();
    try {
      await expect(s.download()).rejects.toMatchObject({ code: 'verify-failed' });
    } finally { delete process.env.APPIMAGE; }
    expect(mocks.stageAppImage).not.toHaveBeenCalled();
    expect(s.getUpdateStatus().downloaded).toBe(false);
    expect(fs.existsSync(path.join(cacheDir, 'pending.json'))).toBe(false);
  });

  it('only pushes a status change when the pending download really changed', async () => {
    const s = await load();
    await s.fetchLatestRelease();
    await s.download();
    const listener = vi.fn();
    s.onStatusChange(listener);
    mocks.release = { ...release('2.0.0'), update_available: false };
    await s.setBetaChannel(true);             // clears pending: one change
    await s.setBetaChannel(false);            // nothing left to clear: no change
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not call a loaded pending download "downloaded" until it is re-checked after the 60 seconds', async () => {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, asset('2.0.0')), 'x');
    writePendingJson();
    const s = await load();
    await check(s);                           // startup has finished and pending.json is loaded
    expect(s.getUpdateStatus().downloaded).toBe(false);
    await armed(s);
    await vi.waitFor(() => expect(s.getUpdateStatus().downloaded).toBe(true));
  });

  it('removes a loaded pending download that fails its re-check', async () => {
    const { UpdateInstallError } = await import('../src/main/update-installer');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, asset('2.0.0')), 'x');
    writePendingJson();
    mocks.verify.mockRejectedValue(new UpdateInstallError('verify-failed', 'sha256 mismatch'));
    mocks.savedAutoInstall = false;          // so only the re-check, not a fresh download, touches it
    const s = await load();
    await s.fetchLatestRelease();
    await armed(s);
    await vi.waitFor(() => expect(fs.existsSync(path.join(cacheDir, asset('2.0.0')))).toBe(false));
    expect(s.getUpdateStatus().downloaded).toBe(false);
  });
});


// #183 T3 — installing at exit: who may, the brake, the re-hash, the attempt record and the per-platform step.
describe('update service installing', () => {
  let userData: string; let cacheDir: string; let appsDir: string;
  let gate: Promise<void> | null;
  const realPlatform = process.platform; const realExec = process.execPath;
  const setPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: p, configurable: true });
  const ext = { win32: 'exe', linux: 'AppImage', darwin: 'dmg' } as const;
  let asset: string;
  const release = (v: string) => ({ manifest_url: 'https://github.com/manifest', signature_url: 'https://github.com/signature', tag: `v${v}`, latest: v, update_available: true, download_url: `https://github.com/itsdestin/youcoded/releases/download/v${v}/YouCoded-${v}.${ext[process.platform as keyof typeof ext] ?? 'exe'}` });

  function setup(platform: 'win32' | 'linux' | 'darwin') {
    setPlatform(platform);
    asset = `YouCoded-2.0.0.${ext[platform]}`;
    mocks.release = release('2.0.0');
    if (platform === 'linux') { process.env.APPIMAGE = path.join(appsDir, 'YouCoded.AppImage'); fs.writeFileSync(process.env.APPIMAGE, 'old'); mocks.kind = 'appimage'; }
    if (platform === 'darwin') {
      const bundle = path.join(appsDir, 'YouCoded.app'); fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
      Object.defineProperty(process, 'execPath', { value: path.join(bundle, 'Contents', 'MacOS', 'YouCoded'), configurable: true });
    }
  }

  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'update-service-inst-'));
    cacheDir = path.join(userData, 'update-cache'); appsDir = path.join(userData, 'apps'); fs.mkdirSync(appsDir);
    mocks.userData = userData; mocks.packaged = true; mocks.savedAutoInstall = true; mocks.readGate = null; mocks.httpStatus = 200; mocks.httpHang = false;
    mocks.verify.mockResolvedValue({ assets: [] });
    mocks.spawn.mockImplementation(() => ({ on: vi.fn(), unref: vi.fn() }));
    gate = null;
    const started = vi.fn(async (url: string) => {
      if (gate) await gate;
      fs.mkdirSync(cacheDir, { recursive: true });
      const filePath = path.join(cacheDir, url.split('/').pop()!);
      fs.writeFileSync(filePath, 'installer');
      return { jobId: 'job', filePath, bytesTotal: 9 };
    });
    mocks.installer = { startDownload: started, cancelDownload: vi.fn(), getActiveProgress: () => null };
    mocks.stageAppImage.mockImplementation(async () => { fs.writeFileSync(path.join(appsDir, '.YouCoded-update-2.0.0.AppImage'), 'new'); return '.YouCoded-update-2.0.0.AppImage'; });
    mocks.stageMacApp.mockImplementation(async () => { fs.mkdirSync(path.join(appsDir, '.YouCoded-update-2.0.0.app')); return '.YouCoded-update-2.0.0.app'; });
  });
  afterEach(() => {
    vi.useRealTimers(); setPlatform(realPlatform);
    Object.defineProperty(process, 'execPath', { value: realExec, configurable: true });
    delete process.env.APPIMAGE; delete process.env.ProgramFiles; mocks.kind = 'deb';
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const load = async () => (await import('../src/main/update-service')).getUpdateService();
  /** Downloaded and ready: a check, the 60 s clock, the background download. */
  async function ready(s: Awaited<ReturnType<typeof load>>) {
    s.onFirstWindowReady(); await vi.advanceTimersByTimeAsync(60_000);
    await s.fetchLatestRelease(); await s.afterCheckDone();
    await vi.waitFor(() => expect(s.getUpdateStatus().downloaded).toBe(true));
  }
  const installerPath = () => path.join(cacheDir, asset);

  describe('who may install on a quit', () => {
    it('a downloaded, signed, latest release with the switch on', async () => {
      setup('win32'); const s = await load(); await ready(s);
      expect(s.quitInstallEligible()).toBe(true);
    });
    it('not with the switch off', async () => {
      setup('win32'); const s = await load(); await ready(s);
      await s.setAutoInstall(false);
      expect(s.quitInstallEligible()).toBe(false);
    });
    it('not when installing needs a password (Windows per-machine)', async () => {
      setup('win32'); process.env.ProgramFiles = path.dirname(process.execPath);
      const s = await load(); await ready(s);
      expect(s.getUpdateStatus().needs_password).toBe(true);
      expect(s.quitInstallEligible()).toBe(false);
    });
    it('not when what is downloaded is no longer the latest release', async () => {
      setup('win32'); const s = await load(); await ready(s);
      let open!: () => void; gate = new Promise<void>((r) => { open = r; }); // hold the newer download
      mocks.release = release('2.1.0');
      await s.fetchLatestRelease();
      expect(s.quitInstallEligible()).toBe(false);
      open();
    });
    it('not after two failed attempts for this version; Restart is not blocked by them', async () => {
      setup('win32');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, 'attempt.json'), JSON.stringify({ version: '2.0.0', at: 1, failures: 1 }));
      const s = await load(); await ready(s);
      // the launch after a failed attempt counted it: 1 recorded + this one = 2
      expect(s.quitInstallEligible()).toBe(false);
      expect(await s.planRestart()).toEqual({ kind: 'exit-install', macPassword: false });
    });
    it('not in an unpackaged build', async () => {
      setup('win32'); mocks.packaged = false;
      const s = await load(); await s.fetchLatestRelease();
      expect(s.quitInstallEligible()).toBe(false);
    });
  });

  describe('the attempt record on the next launch', () => {
    it('a version at or past the attempted one means it worked: the record and the leftover file go', async () => {
      setup('win32'); fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, 'attempt.json'), JSON.stringify({ version: '1.0.0', at: 1, failures: 0 }));
      fs.writeFileSync(path.join(cacheDir, 'YouCoded-1.0.0.exe'), 'x');
      const s = await load(); await s.fetchLatestRelease();
      await vi.waitFor(() => expect(fs.existsSync(path.join(cacheDir, 'attempt.json'))).toBe(false));
      expect(fs.existsSync(path.join(cacheDir, 'YouCoded-1.0.0.exe'))).toBe(false);
    });
    it('still older: counts one failure, keeps the download, and does not count it again on the launch after', async () => {
      setup('win32'); fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, 'attempt.json'), JSON.stringify({ version: '2.0.0', at: 1, failures: 0 }));
      const s = await load(); await ready(s);
      expect(JSON.parse(fs.readFileSync(path.join(cacheDir, 'attempt.json'), 'utf8'))).toMatchObject({ version: '2.0.0', failures: 1, seen: true });
      expect(s.getUpdateStatus().downloaded).toBe(true); // the popup is simply Ready again
      expect(s.quitInstallEligible()).toBe(true);        // one failure: quits still try
      vi.resetModules();
      const again = await load(); await ready(again);
      expect(JSON.parse(fs.readFileSync(path.join(cacheDir, 'attempt.json'), 'utf8')).failures).toBe(1);
    });
  });

  describe('the brake before an install', () => {
    const prepared = async (status: number, hang = false) => {
      setup('win32'); const s = await load(); await ready(s);
      mocks.httpStatus = status; mocks.httpHang = hang;
      const done = s.prepareExit('install');
      if (hang) await vi.advanceTimersByTimeAsync(3_000);
      await done;
      return s;
    };
    const installs = (s: Awaited<ReturnType<typeof load>>) => { s.runExitInstall(false, vi.fn()); return mocks.spawn.mock.calls.length; };

    it('a 404 on the signed file means the release was pulled: file and record are deleted, nothing installs', async () => {
      const s = await prepared(404);
      expect(installs(s)).toBe(0);
      expect(fs.existsSync(installerPath())).toBe(false);
      expect(s.getUpdateStatus().downloaded).toBe(false);
    });
    it.each([403, 500])('a %i is not proof of anything: no install this time, the file is kept', async (status) => {
      const s = await prepared(status);
      expect(installs(s)).toBe(0);
      expect(fs.existsSync(installerPath())).toBe(true);
      expect(s.getUpdateStatus().downloaded).toBe(true);
    });
    it('a network that never answers holds the quit for 3 s at most, then no install, file kept', async () => {
      const s = await prepared(200, true);
      expect(installs(s)).toBe(0);
      expect(fs.existsSync(installerPath())).toBe(true);
    });
    it('an answer fetched within the last 10 minutes is reused (no second fetch at the quit)', async () => {
      setup('win32'); const s = await load(); await ready(s);
      await s.prepareExit('install'); // fetches and caches
      mocks.httpStatus = 500;         // the network is gone now
      await s.prepareExit('install');
      expect(installs(s)).toBe(1);
    });
    it('a Restart on a pulled release installs nothing and the file is deleted', async () => {
      setup('win32'); const s = await load(); await ready(s);
      mocks.httpStatus = 404;
      expect(await s.planRestart()).toEqual({ kind: 'none' });
      expect(fs.existsSync(installerPath())).toBe(false);
    });
    it('a Restart that cannot confirm the release fails visibly instead of quitting', async () => {
      setup('win32'); const s = await load(); await ready(s);
      mocks.httpStatus = 500;
      await expect(s.planRestart()).rejects.toMatchObject({ code: 'network-failed' });
    });
  });

  describe('Restart when the staged copy has gone missing (code review F1)', () => {
    it('re-stages it before any password is asked for', async () => {
      setup('darwin'); const s = await load(); await ready(s);
      fs.rmSync(path.join(appsDir, '.YouCoded-update-2.0.0.app'), { recursive: true });
      mocks.stageMacApp.mockClear();
      expect(await s.planRestart()).toEqual({ kind: 'exit-install', macPassword: false });
      expect(mocks.stageMacApp).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(path.join(appsDir, '.YouCoded-update-2.0.0.app'))).toBe(true);
    });
    it('falls back to the disk image (the interactive path) when it cannot be re-staged, instead of asking for a password', async () => {
      setup('darwin'); const s = await load(); await ready(s);
      fs.rmSync(path.join(appsDir, '.YouCoded-update-2.0.0.app'), { recursive: true });
      mocks.stageMacApp.mockRejectedValue(new Error('disk full'));
      expect(await s.planRestart()).toEqual({ kind: 'interactive' });
    });
    it('a stale go file left by a dead helper is removed at startup, before any helper can read it', async () => {
      setup('darwin');
      fs.writeFileSync(path.join(appsDir, '.YouCoded-update-2.0.0.app.go'), 'install\n');
      await load(); // no release check yet: the later sweep (which also removes it) has not run
      await vi.waitFor(() => expect(fs.existsSync(path.join(appsDir, '.YouCoded-update-2.0.0.app.go'))).toBe(false));
    });
  });

  describe('guards inside prepare', () => {
    it('a brake that cannot be answered in time blocks the install even though an older answer is still cached', async () => {
      setup('win32'); const s = await load(); await ready(s);
      await s.prepareExit('install'); s.runExitInstall(false, vi.fn()); // fetches and caches an ok answer; spent
      mocks.spawn.mockClear();
      const realNow = Date.now(); const spy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 11 * 60_000); // the cache is now stale
      try {
        mocks.httpHang = true;
        const done = s.prepareExit('install');
        await vi.advanceTimersByTimeAsync(3_000);
        await done;
        s.runExitInstall(false, vi.fn());
        expect(mocks.spawn).not.toHaveBeenCalled();
      } finally { spy.mockRestore(); }
    });

    it('a re-hash without the brake\'s signed file never passes (it does not quietly fetch its own)', async () => {
      setup('win32'); const s = await load(); await ready(s);
      expect(await s.forTests.rehash(installerPath())).toBe(false); // no brake answer yet
      await s.prepareExit('install');
      expect(await s.forTests.rehash(installerPath())).toBe(true);  // same file, once the brake has fetched
    });

    it('a system shutdown vetoes the install, whether it starts before prepare or during teardown, and also Restart', async () => {
      setup('win32'); const s = await load(); await ready(s);
      await s.prepareExit('install', () => true);
      s.runExitInstall(false, vi.fn());
      expect(mocks.spawn).not.toHaveBeenCalled();
      let down = false;
      await s.prepareExit('install-relaunch', () => down);   // prepared fine...
      down = true;                                            // ...then the OS starts shutting down
      const relaunch = vi.fn();
      s.runExitInstall(true, relaunch, true);
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(relaunch).not.toHaveBeenCalled();
      let late = false;                                       // shutdown begins while prepare is still working
      mocks.verify.mockImplementationOnce(async () => { late = true; return { assets: [] }; });
      await s.prepareExit('install', () => late);
      s.runExitInstall(false, vi.fn());
      expect(mocks.spawn).not.toHaveBeenCalled();
    });
  });

  describe('the step at exit, per platform', () => {
    it('Windows: re-hashes the exact installer, then spawns it detached with /S --updated (--force-run for Restart) and writes the attempt', async () => {
      setup('win32'); const s = await load(); await ready(s);
      mocks.verify.mockClear();
      await s.prepareExit('install-relaunch');
      expect(mocks.verify).toHaveBeenCalledWith(expect.objectContaining({ filePath: installerPath(), fileName: asset }));
      s.runExitInstall(true, vi.fn());
      expect(mocks.spawn).toHaveBeenCalledWith(installerPath(), ['/S', '--updated', '--force-run'], expect.objectContaining({ detached: true }));
      expect(JSON.parse(fs.readFileSync(path.join(cacheDir, 'attempt.json'), 'utf8'))).toMatchObject({ version: '2.0.0', failures: 0 });
    });
    it('a file that fails the re-hash is not run, and is deleted', async () => {
      setup('win32'); const s = await load(); await ready(s);
      const { UpdateInstallError } = await import('../src/main/update-installer');
      mocks.verify.mockRejectedValue(new UpdateInstallError('verify-failed', 'sha256 mismatch'));
      await s.prepareExit('install');
      s.runExitInstall(false, vi.fn());
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(fs.existsSync(installerPath())).toBe(false);
    });
    it('Linux AppImage: re-hashes the staged copy (not the download), then renames it over the running image', async () => {
      setup('linux'); mocks.verify.mockResolvedValue({ assets: [{ name: asset, sha256: 'abc' }] }); // staging needs the signed hash
      const s = await load(); await ready(s);
      const staged = path.join(appsDir, '.YouCoded-update-2.0.0.AppImage');
      mocks.verify.mockClear();
      await s.prepareExit('install');
      expect(mocks.verify).toHaveBeenCalledWith(expect.objectContaining({ filePath: staged, fileName: asset }));
      const relaunch = vi.fn();
      s.runExitInstall(false, relaunch);
      expect(fs.readFileSync(process.env.APPIMAGE!, 'utf8')).toBe('new');
      expect(relaunch).not.toHaveBeenCalled();
    });
    it('Mac, bundle writable: the helper is started at prepare time with positional arguments, and the exit writes the go file', async () => {
      setup('darwin'); const s = await load(); await ready(s);
      await s.prepareExit('install');
      const staged = path.join(appsDir, '.YouCoded-update-2.0.0.app');
      expect(mocks.spawn).toHaveBeenCalledTimes(1);
      const [cmd, argv, opts] = mocks.spawn.mock.calls[0];
      expect(cmd).toBe('/bin/sh');
      expect(argv.slice(0, 3)).toEqual(['-c', expect.stringContaining('kill -0'), 'sh']);
      expect(argv.slice(3)).toEqual([String(process.pid), path.join(appsDir, 'YouCoded.app'), staged, staged + '.go', staged, 'user', 'none', String(process.getuid?.() ?? 0)]);
      expect(opts).toMatchObject({ detached: true, stdio: 'ignore' });
      expect(fs.existsSync(staged + '.go')).toBe(false); // nothing swaps until the exit hook says go
      s.runExitInstall(true, vi.fn());
      expect(fs.readFileSync(staged + '.go', 'utf8')).toBe('relaunch\n');
    });
    it('Mac, password needed: a quit never installs (only Restart asks for the password)', async () => {
      setup('darwin'); fs.chmodSync(appsDir, 0o555);
      try {
        const s = await load(); await ready(s);
        expect(s.getUpdateStatus().needs_password).toBe(true);
        expect(s.quitInstallEligible()).toBe(false);
        await s.prepareExit('install');
        s.runExitInstall(false, vi.fn());
        expect(mocks.spawn).not.toHaveBeenCalled();
      } finally { fs.chmodSync(appsDir, 0o755); }
    });
    it('nothing prepared means nothing is run, and a Restart with no plan still reopens the app', async () => {
      setup('win32'); const s = await load(); await ready(s);
      const relaunch = vi.fn();
      s.runExitInstall(true, relaunch); // prepare never ran
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(relaunch).toHaveBeenCalledTimes(1);
    });
  });
});
