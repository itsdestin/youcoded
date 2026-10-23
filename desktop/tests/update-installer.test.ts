import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateDownloadUrl, deriveDownloadFilename, createUpdateInstaller, cleanupStaleDownloads, findCachedDownload, makeLaunchInstaller, isAllowedUpdateHost } from '../src/main/update-installer';
import type { UpdateLaunchResult } from '../src/shared/update-install-types';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';

describe('validateDownloadUrl', () => {
  it('accepts github.com release URLs', () => {
    expect(() => validateDownloadUrl('https://github.com/itsdestin/youcoded/releases/download/v1.2.3/YouCoded-Setup-1.2.3.exe')).not.toThrow();
  });

  it('accepts objects.githubusercontent.com URLs', () => {
    expect(() => validateDownloadUrl('https://objects.githubusercontent.com/github-production-release-asset-xyz/YouCoded-1.2.3.dmg')).not.toThrow();
  });

  it('accepts release-assets.githubusercontent.com URLs (GitHub\'s current download host)', () => {
    // The regression that broke the Update button for everyone: this host was
    // rejected, so every download failed url-rejected.
    expect(() => validateDownloadUrl('https://release-assets.githubusercontent.com/github-production-release-asset-xyz/YouCoded-Setup-1.3.0.exe')).not.toThrow();
  });

  it('rejects http:// URLs with url-rejected', () => {
    expect(() => validateDownloadUrl('http://github.com/itsdestin/youcoded/releases/download/v1/YouCoded.exe'))
      .toThrow(/url-rejected/);
  });

  it('rejects non-GitHub domains with url-rejected', () => {
    expect(() => validateDownloadUrl('https://evil.example.com/YouCoded.exe'))
      .toThrow(/url-rejected/);
  });

  it('rejects malformed URLs with url-rejected', () => {
    expect(() => validateDownloadUrl('not a url')).toThrow(/url-rejected/);
  });
});

describe('isAllowedUpdateHost (manifest/signature fetch trust boundary)', () => {
  it('accepts the three GitHub release hosts over https', () => {
    expect(isAllowedUpdateHost('https://github.com/a/b/releases/download/v1/youcoded-release.json')).toBe(true);
    expect(isAllowedUpdateHost('https://objects.githubusercontent.com/x/youcoded-release.json.sig')).toBe(true);
    expect(isAllowedUpdateHost('https://release-assets.githubusercontent.com/x/youcoded-release.json')).toBe(true);
  });
  it('rejects other hosts, http, and junk', () => {
    expect(isAllowedUpdateHost('https://evil.example.com/youcoded-release.json')).toBe(false);
    expect(isAllowedUpdateHost('http://github.com/x/youcoded-release.json')).toBe(false);
    expect(isAllowedUpdateHost('not a url')).toBe(false);
  });
});

describe('deriveDownloadFilename', () => {
  it('derives .exe for Windows URL', () => {
    const f = deriveDownloadFilename('https://github.com/itsdestin/youcoded/releases/download/v1.2.3/YouCoded-Setup-1.2.3.exe', 'win32');
    expect(f).toBe('YouCoded-Setup-1.2.3.exe');
  });

  it('derives .dmg for macOS URL', () => {
    const f = deriveDownloadFilename('https://github.com/itsdestin/youcoded/releases/download/v1.2.3/YouCoded-1.2.3-arm64.dmg', 'darwin');
    expect(f).toBe('YouCoded-1.2.3-arm64.dmg');
  });

  it('derives .AppImage for Linux AppImage URL', () => {
    const f = deriveDownloadFilename('https://github.com/itsdestin/youcoded/releases/download/v1.2.3/YouCoded-1.2.3.AppImage', 'linux');
    expect(f).toBe('YouCoded-1.2.3.AppImage');
  });

  it('derives .deb for Linux deb URL', () => {
    const f = deriveDownloadFilename('https://github.com/itsdestin/youcoded/releases/download/v1.2.3/youcoded_1.2.3_amd64.deb', 'linux');
    expect(f).toBe('youcoded_1.2.3_amd64.deb');
  });

  it('rejects path traversal with url-rejected', () => {
    expect(() => deriveDownloadFilename('https://github.com/foo/../../etc/passwd', 'linux'))
      .toThrow(/url-rejected/);
  });

  it('rejects unknown extensions with url-rejected', () => {
    expect(() => deriveDownloadFilename('https://github.com/itsdestin/youcoded/releases/download/v1/foo.zip', 'win32'))
      .toThrow(/url-rejected/);
  });

  it('strips querystrings before extension check', () => {
    const f = deriveDownloadFilename('https://objects.githubusercontent.com/YouCoded-1.2.3.exe?token=abc', 'win32');
    expect(f).toBe('YouCoded-1.2.3.exe');
  });
});

// We can't easily stand up a real HTTPS server in tests (needs certs).
// Instead, inject a fake `httpsGet` into the installer factory so tests
// can drive the request/response by hand. This is a deliberate seam.

// The installer only uses standard EventEmitter events on the request/response
// (`on('data')`, `on('end')`, `on('error')`), so a plain EventEmitter is a more
// reliable fake than Readable: avoids backpressure / flowing-mode quirks that
// hung on Windows when synchronously pushing many chunks.
function makeFakeHttpsGet(scripts: Map<string, Buffer | Error>) {
  return (url: string, cb: (res: any) => void) => {
    const reqEmitter = new EventEmitter() as any;
    reqEmitter.destroy = () => { reqEmitter.emit('abort'); };
    setImmediate(() => {
      const scripted = scripts.get(url);
      if (scripted instanceof Error) {
        reqEmitter.emit('error', scripted);
        return;
      }
      if (!scripted) {
        reqEmitter.emit('error', new Error(`no script for ${url}`));
        return;
      }
      const res = new EventEmitter() as any;
      res.statusCode = 200;
      res.headers = { 'content-length': String(scripted.length) };
      res.resume = () => {};
      cb(res); // installer attaches 'data'/'end' listeners inside cb
      // Emit data + end asynchronously (mimics real HTTP), in a distinct tick
      // so listeners are attached before events fire.
      setImmediate(() => {
        const CHUNK = 1024;
        for (let i = 0; i < scripted.length; i += CHUNK) {
          res.emit('data', scripted.subarray(i, Math.min(i + CHUNK, scripted.length)));
        }
        res.emit('end');
      });
    });
    return reqEmitter;
  };
}

describe('createUpdateInstaller download engine', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-installer-test-'));
  });
  afterEach(() => {
    // WHY retries: a failed download's write stream can still be closing when this runs and
    // drop one last file into the folder mid-delete (ENOTEMPTY under a loaded full run).
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('downloads a file to update-cache, renaming .partial on completion', async () => {
    const url = 'https://github.com/itsdestin/youcoded/releases/download/v1/YouCoded.exe';
    const payload = Buffer.from('fake installer content '.repeat(100));
    const installer = createUpdateInstaller({
      cacheDir: tmpDir,
      httpsGet: makeFakeHttpsGet(new Map([[url, payload]])),
      platform: 'win32',
      onProgress: () => {},
    });

    const result = await installer.startDownload(url);
    expect(result.bytesTotal).toBe(payload.length);
    expect(result.filePath).toBe(path.join(tmpDir, 'YouCoded.exe'));
    expect(fs.readFileSync(result.filePath)).toEqual(payload);
    // No leftover .partial
    expect(fs.existsSync(result.filePath + '.partial')).toBe(false);
  });

  it('emits progress events at 250ms/5% throttle boundaries', async () => {
    const url = 'https://github.com/itsdestin/youcoded/releases/download/v1/YouCoded.exe';
    const payload = Buffer.alloc(100 * 1024); // 100 KB
    const progressEvents: { bytesReceived: number; percent: number }[] = [];
    const installer = createUpdateInstaller({
      cacheDir: tmpDir,
      httpsGet: makeFakeHttpsGet(new Map([[url, payload]])),
      platform: 'win32',
      onProgress: (ev) => progressEvents.push({ bytesReceived: ev.bytesReceived, percent: ev.percent }),
    });

    await installer.startDownload(url);

    // At least 2 events (one mid-download, one at 100%). Never one-per-chunk.
    expect(progressEvents.length).toBeGreaterThanOrEqual(2);
    expect(progressEvents.length).toBeLessThan(100); // not per-chunk
    // Final event is 100%.
    expect(progressEvents[progressEvents.length - 1].percent).toBe(100);
  });

  it('returns the existing jobId when a second startDownload is issued while one is in flight', async () => {
    const url = 'https://github.com/itsdestin/youcoded/releases/download/v1/YouCoded.exe';
    const payload = Buffer.alloc(50 * 1024);
    const installer = createUpdateInstaller({
      cacheDir: tmpDir,
      httpsGet: makeFakeHttpsGet(new Map([[url, payload]])),
      platform: 'win32',
      onProgress: () => {},
    });

    const p1 = installer.startDownload(url);
    const p2 = installer.startDownload(url);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.jobId).toBe(r2.jobId);
    expect(r1.filePath).toBe(r2.filePath);
  });

  it('cancelDownload removes the .partial file and rejects the in-flight promise', async () => {
    const url = 'https://github.com/itsdestin/youcoded/releases/download/v1/YouCoded.exe';
    // Never resolves — emits one chunk of data then stalls; cancelled before 'end'.
    const fakeGet = ((_url: string, cb: (res: any) => void) => {
      const reqEmitter = new EventEmitter() as any;
      reqEmitter.destroy = () => { reqEmitter.emit('abort'); };
      setImmediate(() => {
        const res = new EventEmitter() as any;
        res.statusCode = 200;
        res.headers = { 'content-length': '1000000' };
        res.resume = () => {};
        cb(res);
        // Emit one 1 KB chunk and stop — no 'end' until cancel
        setImmediate(() => res.emit('data', Buffer.alloc(1024)));
      });
      return reqEmitter;
    });
    const installer = createUpdateInstaller({
      cacheDir: tmpDir,
      httpsGet: fakeGet as any,
      platform: 'win32',
      onProgress: () => {},
    });

    const downloadPromise = installer.startDownload(url);
    // WHY waited for, not slept (final review F55): the job exists once the first chunk is in.
    await vi.waitFor(() => expect(installer.getActiveJobId()).toBeTruthy());
    const jobId = installer.getActiveJobId();
    installer.cancelDownload(jobId!);

    await expect(downloadPromise).rejects.toThrow(/network-failed/);
    expect(fs.existsSync(path.join(tmpDir, 'YouCoded.exe.partial'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'YouCoded.exe'))).toBe(false);
  });

  it('surfaces network errors as network-failed', async () => {
    const url = 'https://github.com/itsdestin/youcoded/releases/download/v1/YouCoded.exe';
    const installer = createUpdateInstaller({
      cacheDir: tmpDir,
      httpsGet: makeFakeHttpsGet(new Map([[url, new Error('ENETUNREACH')]])),
      platform: 'win32',
      onProgress: () => {},
    });
    await expect(installer.startDownload(url)).rejects.toThrow(/network-failed/);
  });

  it('rejects url-rejected URLs before opening any file', async () => {
    const installer = createUpdateInstaller({
      cacheDir: tmpDir,
      httpsGet: makeFakeHttpsGet(new Map()),
      platform: 'win32',
      onProgress: () => {},
    });
    await expect(installer.startDownload('http://github.com/foo.exe')).rejects.toThrow(/url-rejected/);
    expect(fs.readdirSync(tmpDir).length).toBe(0);
  });
});

describe('cleanupStaleDownloads', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-installer-cleanup-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('treats a missing cache folder as nothing to sweep', async () => {
    const dir = path.join(tmpDir, 'does-not-exist');
    await expect(cleanupStaleDownloads(dir)).resolves.toBeUndefined();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('deletes .partial files unconditionally', async () => {
    fs.writeFileSync(path.join(tmpDir, 'YouCoded.exe.partial'), 'x');
    await cleanupStaleDownloads(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, 'YouCoded.exe.partial'))).toBe(false);
  });

  it('deletes non-.partial files older than 24h', async () => {
    const old = path.join(tmpDir, 'YouCoded.exe');
    fs.writeFileSync(old, 'x');
    const twentyFiveHoursAgo = Date.now() / 1000 - (25 * 3600);
    fs.utimesSync(old, twentyFiveHoursAgo, twentyFiveHoursAgo);
    await cleanupStaleDownloads(tmpDir);
    expect(fs.existsSync(old)).toBe(false);
  });

  it('never deletes a kept name or the update bookkeeping files, however old', async () => {
    const old = Date.now() / 1000 - (72 * 3600);
    for (const name of ['YouCoded-Installer-2.0.0.exe', 'pending.json', 'attempt.json', 'YouCoded-Installer-0.9.0.exe']) {
      fs.writeFileSync(path.join(tmpDir, name), 'x');
      fs.utimesSync(path.join(tmpDir, name), old, old);
    }
    await cleanupStaleDownloads(tmpDir, new Set(['YouCoded-Installer-2.0.0.exe']));
    expect(fs.existsSync(path.join(tmpDir, 'YouCoded-Installer-2.0.0.exe'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'pending.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'attempt.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'YouCoded-Installer-0.9.0.exe'))).toBe(false);
  });

  it('keeps non-.partial files newer than 24h', async () => {
    const fresh = path.join(tmpDir, 'YouCoded.exe');
    fs.writeFileSync(fresh, 'x');
    await cleanupStaleDownloads(tmpDir);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});

describe('findCachedDownload', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-installer-cache-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('returns null when no file matches the version', async () => {
    expect(await findCachedDownload(tmpDir, '1.2.3', 'win32')).toBeNull();
  });

  it('returns null when cacheDir does not exist', async () => {
    expect(await findCachedDownload(path.join(tmpDir, 'missing'), '1.2.3', 'win32')).toBeNull();
  });

  it('finds a matching .exe by version substring on Windows', async () => {
    const filePath = path.join(tmpDir, 'YouCoded-Setup-1.2.3.exe');
    fs.writeFileSync(filePath, 'x');
    const hit = await findCachedDownload(tmpDir, '1.2.3', 'win32');
    expect(hit).toEqual({ filePath, version: '1.2.3' });
  });

  // WHY: the two tests above use invented names. These use the names releases
  // actually publish, which is how the dotted-name miss below went unnoticed.
  it('finds the renamed Windows installer, beta version included', async () => {
    const filePath = path.join(tmpDir, 'YouCoded-Installer-1.3.0-beta.77.exe');
    fs.writeFileSync(filePath, 'x');
    const hit = await findCachedDownload(tmpDir, '1.3.0-beta.77', 'win32');
    expect(hit).toEqual({ filePath, version: '1.3.0-beta.77' });
  });

  it('finds the renamed macOS installer for both chips', async () => {
    const arm = path.join(tmpDir, 'YouCoded-Installer-1.2.3-arm64.dmg');
    fs.writeFileSync(arm, 'x');
    expect(await findCachedDownload(tmpDir, '1.2.3', 'darwin')).toEqual({ filePath: arm, version: '1.2.3' });
    fs.rmSync(arm);
    const intel = path.join(tmpDir, 'YouCoded-Installer-1.2.3-x64.dmg');
    fs.writeFileSync(intel, 'x');
    expect(await findCachedDownload(tmpDir, '1.2.3', 'darwin')).toEqual({ filePath: intel, version: '1.2.3' });
  });

  it('never matched the old dotted Windows name GitHub published (why the rename puts a dash there)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'YouCoded.Setup.1.2.3.exe'), 'x');
    expect(await findCachedDownload(tmpDir, '1.2.3', 'win32')).toBeNull();
  });

  it('finds a matching .dmg by version substring on macOS', async () => {
    const filePath = path.join(tmpDir, 'YouCoded-1.2.3-arm64.dmg');
    fs.writeFileSync(filePath, 'x');
    const hit = await findCachedDownload(tmpDir, '1.2.3', 'darwin');
    expect(hit).toEqual({ filePath, version: '1.2.3' });
  });

  it('ignores .partial files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'YouCoded-Setup-1.2.3.exe.partial'), 'x');
    expect(await findCachedDownload(tmpDir, '1.2.3', 'win32')).toBeNull();
  });

  it('ignores files for a different version', async () => {
    fs.writeFileSync(path.join(tmpDir, 'YouCoded-Setup-1.2.2.exe'), 'x');
    expect(await findCachedDownload(tmpDir, '1.2.3', 'win32')).toBeNull();
  });

  it('does NOT match "1.2.3" against YouCoded-Setup-1.2.30.exe (version substring false-positive guard)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'YouCoded-Setup-1.2.30.exe'), 'x');
    expect(await findCachedDownload(tmpDir, '1.2.3', 'win32')).toBeNull();
  });

  it('does NOT match "2.0" against YouCoded-Setup-1.2.0.exe (version embedded in another)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'YouCoded-Setup-1.2.0.exe'), 'x');
    expect(await findCachedDownload(tmpDir, '2.0', 'win32')).toBeNull();
  });

  it('finds underscore-delimited .deb by version', async () => {
    const filePath = path.join(tmpDir, 'youcoded_1.2.3_amd64.deb');
    fs.writeFileSync(filePath, 'x');
    const hit = await findCachedDownload(tmpDir, '1.2.3', 'linux');
    expect(hit).toEqual({ filePath, version: '1.2.3' });
  });
});

describe('launchInstaller', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-launch-test-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

  function fakeChild(overrides: Partial<{ exitCode: number | null; exitDelay: number; errorOnSpawn: boolean }> = {}) {
    const emitter: any = new EventEmitter();
    emitter.unref = () => {};
    if (overrides.errorOnSpawn) {
      setImmediate(() => emitter.emit('error', new Error('ENOENT')));
    } else if (overrides.exitCode !== undefined) {
      setTimeout(() => { emitter.emit('exit', overrides.exitCode); emitter.emit('close', overrides.exitCode); }, overrides.exitDelay ?? 10);
    }
    return emitter;
  }

  it('Windows: spawns the .exe detached and returns quitPending=true', async () => {
    const filePath = path.join(tmpDir, 'YouCoded.exe');
    fs.writeFileSync(filePath, 'x');
    const spawnCalls: any[] = [];
    const launch = makeLaunchInstaller({
      platform: 'win32',
      spawn: (cmd: string, args: string[], opts: any) => {
        spawnCalls.push({ cmd, args, opts });
        return fakeChild({ exitCode: 0, exitDelay: 5000 }); // NSIS won't exit quickly
      },
      shellOpenExternal: async () => {},
      appRelaunch: () => {},
      fallbackDownloadUrl: () => 'https://github.com/...', // not used on happy path
    });
    const r = await launch({ jobId: 'j', filePath });
    expect(r).toEqual({ success: true, quitPending: true });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].cmd).toBe(filePath);
    expect(spawnCalls[0].opts.detached).toBe(true);
    expect(spawnCalls[0].opts.stdio).toBe('ignore');
  });

  it('macOS: spawns `open -W <dmg>` and waits up to 2s for a quick failure', async () => {
    const filePath = path.join(tmpDir, 'YouCoded.dmg');
    fs.writeFileSync(filePath, 'x');
    const spawnCalls: any[] = [];
    const launch = makeLaunchInstaller({
      platform: 'darwin',
      spawn: (cmd: string, args: string[], opts: any) => {
        spawnCalls.push({ cmd, args, opts });
        return fakeChild({ exitCode: 0, exitDelay: 10_000 }); // healthy — stays mounted
      },
      shellOpenExternal: async () => {},
      appRelaunch: () => {},
      fallbackDownloadUrl: () => 'https://github.com/...',
    });
    const r = await launch({ jobId: 'j', filePath });
    expect(r).toEqual({ success: true, quitPending: true });
    expect(spawnCalls[0].cmd).toBe('open');
    expect(spawnCalls[0].args).toEqual(['-W', filePath]);
  }, 10_000);

  it('macOS: if `open -W` exits non-zero within 2s, returns dmg-corrupt error', async () => {
    const filePath = path.join(tmpDir, 'YouCoded.dmg');
    fs.writeFileSync(filePath, 'x');
    const launch = makeLaunchInstaller({
      platform: 'darwin',
      spawn: () => fakeChild({ exitCode: 1, exitDelay: 10 }),
      shellOpenExternal: async () => {},
      appRelaunch: () => {},
      fallbackDownloadUrl: () => '',
    });
    const r = await launch({ jobId: 'j', filePath });
    expect(r).toEqual({ success: false, error: 'dmg-corrupt' });
  });

  it('returns file-missing if the downloaded file is gone', async () => {
    const launch = makeLaunchInstaller({
      platform: 'win32',
      spawn: () => fakeChild(),
      shellOpenExternal: async () => {},
      appRelaunch: () => {},
      fallbackDownloadUrl: () => '',
    });
    const r = await launch({ jobId: 'j', filePath: path.join(tmpDir, 'missing.exe') });
    expect(r).toEqual({ success: false, error: 'file-missing' });
  });

  it('returns spawn-failed on spawn error', async () => {
    const filePath = path.join(tmpDir, 'YouCoded.exe');
    fs.writeFileSync(filePath, 'x');
    const launch = makeLaunchInstaller({
      platform: 'win32',
      spawn: () => fakeChild({ errorOnSpawn: true }),
      shellOpenExternal: async () => {},
      appRelaunch: () => {},
      fallbackDownloadUrl: () => '',
    });
    const r = await launch({ jobId: 'j', filePath });
    expect(r).toEqual({ success: false, error: 'spawn-failed' });
  });

  it('Linux AppImage: replaces APPIMAGE and calls app.relaunch, returns quitPending=true', async () => {
    const running = path.join(tmpDir, 'YouCoded-1.2.2.AppImage');
    const downloaded = path.join(tmpDir, 'YouCoded-1.2.3.AppImage');
    fs.writeFileSync(running, 'old');
    fs.writeFileSync(downloaded, 'new');
    const progress = vi.fn();
    let relaunched = false;
    const launch = makeLaunchInstaller({
      platform: 'linux',
      spawn: () => fakeChild({ exitCode: 0, exitDelay: 5000 }),
      shellOpenExternal: async () => {},
      onInstallProgress: progress,
      appRelaunch: () => {
        expect(progress).toHaveBeenLastCalledWith({ jobId: 'j', phase: 'restarting', output: '' });
        relaunched = true;
      },
      fallbackDownloadUrl: () => '',
      envAppImage: running,
    });
    const r = await launch({ jobId: 'j', filePath: downloaded });
    expect(r).toEqual({ success: true, quitPending: true });
    expect(fs.readFileSync(running, 'utf8')).toBe('new');
    expect(fs.existsSync(downloaded)).toBe(false);
    expect(relaunched).toBe(true);
  });

  it('Linux AppImage without APPIMAGE env: falls back to browser, app keeps running', async () => {
    const filePath = path.join(tmpDir, 'YouCoded.AppImage');
    fs.writeFileSync(filePath, 'x');
    const opened: string[] = [];
    const launch = makeLaunchInstaller({
      platform: 'linux',
      spawn: () => fakeChild(),
      shellOpenExternal: async (url: string) => { opened.push(url); },
      appRelaunch: () => {},
      fallbackDownloadUrl: () => 'https://github.com/itsdestin/youcoded/releases/download/v1/YouCoded.AppImage',
      envAppImage: undefined,
    });
    const r = await launch({ jobId: 'j', filePath });
    expect(r).toEqual({ success: true, quitPending: false, fallback: 'browser' });
    expect(opened).toEqual(['https://github.com/itsdestin/youcoded/releases/download/v1/YouCoded.AppImage']);
  });

  // A system package (pacman/deb/rpm) is installed over the running app through
  // pkexec — the desktop's own password dialog. Before 2026-09-20 a .deb only
  // opened a web page, and .pacman/.rpm were never even downloaded.
  describe('Linux system packages', () => {
    const PACKAGES: Array<{ file: string; argv: string[]; manual: RegExp }> = [
      { file: 'youcoded-1.3.0.pacman', argv: ['pacman', '-U', '--noconfirm'], manual: /^sudo pacman -U / },
      { file: 'youcoded_1.3.0_amd64.deb', argv: ['apt-get', 'install', '-y'], manual: /^sudo apt-get install -y / },
      { file: 'youcoded-1.3.0.x86_64.rpm', argv: ['rpm', '-U', '--replacepkgs'], manual: /^sudo rpm -U / },
    ];

    function linuxLaunch(over: any = {}) {
      return makeLaunchInstaller({
        platform: 'linux',
        spawn: () => fakeChild({ exitCode: 0 }),
        shellOpenExternal: async () => {},
        appRelaunch: () => {},
        fallbackDownloadUrl: () => 'https://github.com/releases',
        exists: () => true, // pkexec present
        ...over,
      });
    }

    for (const pkg of PACKAGES) {
      it(`installs ${path.extname(pkg.file)} through pkexec, then relaunches`, async () => {
        const filePath = path.join(tmpDir, pkg.file);
        fs.writeFileSync(filePath, 'x');
        const calls: any[] = [];
        let relaunched = 0;
        const launch = linuxLaunch({
          spawn: (cmd: string, args: string[]) => { calls.push({ cmd, args }); return fakeChild({ exitCode: 0 }); },
          appRelaunch: () => { relaunched += 1; },
        });
        const r = await launch({ jobId: 'j', filePath });
        expect(r).toEqual({ success: true, quitPending: true });
        expect(calls).toHaveLength(1);
        expect(calls[0].cmd).toBe('/usr/bin/pkexec');
        expect(calls[0].args).toEqual([...pkg.argv, filePath]);
        expect(relaunched).toBe(1);
      });
    }

    it('never downloads to the AppImage self-replace path', async () => {
      // The 2026-09-20 report: a pacman install took the AppImage branch, found
      // no running AppImage, and opened a web page after a 180 MB download.
      const filePath = path.join(tmpDir, 'youcoded-1.3.0.pacman');
      fs.writeFileSync(filePath, 'x');
      const opened: string[] = [];
      const launch = linuxLaunch({ shellOpenExternal: async (u: string) => { opened.push(u); } });
      const r = await launch({ jobId: 'j', filePath });
      expect(r).toMatchObject({ success: true, quitPending: true });
      expect(opened).toEqual([]);
    });

    it('with no pkexec, hands back the one command to run, and keeps the download', async () => {
      const realPath = path.join(tmpDir, 'youcoded-1.3.0.pacman');
      fs.writeFileSync(realPath, 'x');
      // WHY forward slashes: this block simulates Linux (platform: 'linux' below), where a
      // path can never contain a backslash. On the Windows CI runner, `tmpDir` is a REAL
      // Windows path (e.g. "C:\Users\...") because it comes from the actual os.tmpdir(),
      // and shellQuote() in update-installer.ts correctly single-quotes any path holding a
      // backslash (it's a POSIX shell escape character) — so this test's unquoted
      // expectation was only ever true on Linux/macOS runners. Normalizing to forward
      // slashes makes the fixture match what a real Linux path looks like on every OS the
      // suite runs on; Windows' fs APIs accept forward slashes too, so `filePath` below
      // still resolves to the real file written above. Root-caused 2026-09-23: 6/6 Windows
      // CI failures on this exact assertion.
      const filePath = realPath.split(path.sep).join('/');
      const spawned: string[] = [];
      const launch = linuxLaunch({
        exists: () => false,
        spawn: (cmd: string) => { spawned.push(cmd); return fakeChild({ exitCode: 0 }); },
      });
      const r = await launch({ jobId: 'j', filePath });
      expect(r).toEqual({
        success: true, quitPending: false, fallback: 'manual',
        command: `sudo pacman -U ${filePath}`, filePath,
      });
      expect(spawned).toEqual([]); // nothing was attempted without a way to authorise it
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('a dismissed password dialog is cancelled, not failed — and offers the same command', async () => {
      const filePath = path.join(tmpDir, 'youcoded-1.3.0.pacman');
      fs.writeFileSync(filePath, 'x');
      let relaunched = 0;
      const launch = linuxLaunch({
        spawn: () => fakeChild({ exitCode: 126 }), // pkexec: dismissed / not authorised
        appRelaunch: () => { relaunched += 1; },
      });
      const r = await launch({ jobId: 'j', filePath });
      expect(r).toMatchObject({ success: false, error: 'install-cancelled' });
      expect((r as any).command).toMatch(/^sudo pacman -U /);
      expect(relaunched).toBe(0);
    });

    it('a package manager that refuses reports install-failed, never a relaunch', async () => {
      const filePath = path.join(tmpDir, 'youcoded_1.3.0_amd64.deb');
      fs.writeFileSync(filePath, 'x');
      let relaunched = 0;
      const launch = linuxLaunch({
        spawn: () => fakeChild({ exitCode: 1 }),
        appRelaunch: () => { relaunched += 1; },
      });
      const r = await launch({ jobId: 'j', filePath });
      expect(r).toMatchObject({ success: false, error: 'install-failed' });
      expect((r as any).command).toMatch(/^sudo apt-get install -y /);
      expect(relaunched).toBe(0);
    });

    describe('live package progress', () => {
      beforeEach(() => { vi.useFakeTimers(); });
      afterEach(() => { vi.useRealTimers(); });

      function controlledLaunch() {
        const filePath = path.join(tmpDir, 'youcoded.deb');
        fs.writeFileSync(filePath, 'x');
        const child = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(), stderr: new EventEmitter(),
        });
        const progress = vi.fn();
        const relaunch = vi.fn();
        const late = vi.fn();
        const spawn = vi.fn((_cmd: string, _args: string[], _opts: unknown) => child);
        const launch = linuxLaunch({ spawn, onInstallProgress: progress, appRelaunch: relaunch, onLateInstallResult: late });
        return { child, progress, relaunch, late, spawn, launch, input: { jobId: 'job', filePath } };
      }

      it('announces authorizing before spawn, then only real output advances to installing', async () => {
        const c = controlledLaunch();
        const pending = c.launch(c.input);
        expect(c.progress.mock.calls[0]?.[0]).toEqual({ jobId: 'job', phase: 'authorizing', output: '' });
        expect(c.progress.mock.invocationCallOrder[0]).toBeLessThan(c.spawn.mock.invocationCallOrder[0]);
        expect(c.spawn.mock.calls[0]?.[2]).toEqual({ stdio: ['ignore', 'pipe', 'pipe'] });
        await vi.advanceTimersByTimeAsync(1000);
        expect(c.progress).toHaveBeenCalledTimes(1);
        c.child.stdout.emit('data', Buffer.from('\u001b[32mUnpacking\u001b[0m\n'));
        c.child.stderr.emit('data', Buffer.from('warning\u0000\n'));
        await vi.advanceTimersByTimeAsync(250);
        expect(c.progress).toHaveBeenLastCalledWith({ jobId: 'job', phase: 'installing', output: 'Unpacking\nwarning\n' });
        c.child.emit('exit', 0);
        c.child.emit('close', 0);
        expect(await pending).toEqual({ success: true, quitPending: true });
        expect(c.progress).toHaveBeenLastCalledWith({ jobId: 'job', phase: 'restarting', output: 'Unpacking\nwarning\n' });
        expect(c.relaunch).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      });

      it('coalesces bursts into a bounded sanitized tail and flushes final diagnostics', async () => {
        const c = controlledLaunch();
        const pending = c.launch(c.input);
        c.child.stdout.emit('data', Buffer.from('\u001b['));
        c.child.stdout.emit('data', Buffer.from('31m' + 'x'.repeat(20000)));
        for (let i = 0; i < 1000; i++) c.child.stderr.emit('data', Buffer.from('é'));
        expect(c.progress).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBeLessThanOrEqual(2);
        await vi.advanceTimersByTimeAsync(250);
        expect(c.progress).toHaveBeenCalledTimes(2);
        c.child.stderr.emit('data', Buffer.from('\u001b]title\u0007\u0000\u001b(B\u009b31mfinal error\u009b0m\n'));
        c.child.emit('exit', 1);
        c.child.emit('close', 1);
        const result = await pending;
        expect(result).toMatchObject({ success: false, error: 'install-failed', output: expect.stringContaining('final error\n') });
        const output = (result as any).output;
        expect(Buffer.byteLength(output)).toBeLessThanOrEqual(8192);
        expect(output).not.toMatch(/[\u001b\u0000\ufffd]/);
        expect(c.progress.mock.lastCall?.[0].output).toBe(output);
        expect(vi.getTimerCount()).toBe(0);
      });

      it('refuses simultaneous jobs and keeps timeout outcome unknown until late success', async () => {
        const c = controlledLaunch();
        const pending = c.launch(c.input);
        expect(await c.launch({ ...c.input, jobId: 'different' })).toMatchObject({ success: false, error: 'busy' });
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(await pending).toMatchObject({ success: false, error: 'install-timeout' });
        expect(await c.launch(c.input)).toMatchObject({ success: false, error: 'busy' });
        expect(c.spawn).toHaveBeenCalledTimes(1);
        c.child.emit('exit', 0);
        c.child.emit('close', 0);
        await Promise.resolve();
        expect(c.relaunch).toHaveBeenCalledTimes(1);
        expect(c.late).toHaveBeenCalledWith({ success: true, quitPending: true });
        expect(c.progress.mock.lastCall?.[0].phase).toBe('restarting');
        expect(await c.launch(c.input)).toMatchObject({ success: false, error: 'busy' });
        expect(vi.getTimerCount()).toBe(0);
      });

      it('drains output after exit and keeps ownership until close', async () => {
        const c = controlledLaunch();
        const pending = c.launch(c.input);
        c.child.emit('exit', 1);
        expect(await c.launch(c.input)).toMatchObject({ error: 'busy' });
        c.child.stderr.emit('data', Buffer.from('last diagnostic'));
        c.child.emit('close', 1);
        expect(await pending).toMatchObject({ error: 'install-failed', output: 'last diagnostic' });
        expect(vi.getTimerCount()).toBe(0);
      });

      it('preserves spawn diagnostics without claiming installation started', async () => {
        const c = controlledLaunch();
        const pending = c.launch(c.input);
        c.child.emit('error', new Error('\u001b[31mCannot execute\u001b[0m'));
        expect(await pending).toMatchObject({ error: 'install-failed', output: 'Cannot execute' });
        expect(c.progress).toHaveBeenCalledTimes(1);
        expect(c.relaunch).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      });

      it.each([{ status: 1, error: 'install-failed' }, { status: 126, error: 'install-cancelled' }])('publishes definitive late $error only after close and releases the guard', async ({ status, error }) => {
        const c = controlledLaunch();
        const pending = c.launch(c.input);
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(await pending).toMatchObject({ error: 'install-timeout' });
        c.child.stderr.emit('data', Buffer.from('package refused'));
        c.child.emit('exit', status);
        expect(c.progress.mock.calls.some(([event]) => event.phase === 'failed')).toBe(false);
        expect(await c.launch(c.input)).toMatchObject({ error: 'busy' });
        c.child.emit('close', status);
        expect(c.progress).toHaveBeenLastCalledWith({ jobId: 'job', phase: 'failed', error, output: 'package refused', command: expect.stringContaining('sudo apt-get') });
        expect(c.late).toHaveBeenCalledWith(expect.objectContaining({ error, output: 'package refused' }));
        expect(c.relaunch).not.toHaveBeenCalled();
        const retry = c.launch({ ...c.input, jobId: 'retry' });
        expect(c.spawn).toHaveBeenCalledTimes(2);
        c.child.emit('close', 126);
        expect(await retry).toMatchObject({ error: 'install-cancelled' });
        expect(vi.getTimerCount()).toBe(0);
      });

      it('reports pkexec inability as failure, not a dismissed dialog', async () => {
        const c = controlledLaunch();
        const pending = c.launch(c.input);
        c.child.stderr.emit('data', Buffer.from('Authorization failed'));
        c.child.emit('exit', 127);
        c.child.emit('close', 127);
        expect(await pending).toMatchObject({ success: false, error: 'install-failed', output: 'Authorization failed', command: expect.stringContaining('sudo apt-get') });
      });
    });

    it('quotes a path with a space in the command it shows', async () => {
      const dir = path.join(tmpDir, 'my downloads');
      fs.mkdirSync(dir);
      const filePath = path.join(dir, 'youcoded-1.3.0.pacman');
      fs.writeFileSync(filePath, 'x');
      const launch = linuxLaunch({ exists: () => false });
      const r = await launch({ jobId: 'j', filePath });
      expect((r as any).command).toBe(`sudo pacman -U '${filePath}'`);
    });
  });
});
