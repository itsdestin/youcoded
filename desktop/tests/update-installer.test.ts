import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateDownloadUrl, deriveDownloadFilename, createUpdateInstaller, cleanupStaleDownloads, findCachedDownload, makeLaunchInstaller } from '../src/main/update-installer';
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
    await new Promise(r => setTimeout(r, 50)); // let chunk arrive
    const jobId = installer.getActiveJobId();
    expect(jobId).toBeTruthy();
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the cacheDir if missing', () => {
    const dir = path.join(tmpDir, 'does-not-exist');
    cleanupStaleDownloads(dir);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('deletes .partial files unconditionally', () => {
    fs.writeFileSync(path.join(tmpDir, 'YouCoded.exe.partial'), 'x');
    cleanupStaleDownloads(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, 'YouCoded.exe.partial'))).toBe(false);
  });

  it('deletes non-.partial files older than 24h', () => {
    const old = path.join(tmpDir, 'YouCoded.exe');
    fs.writeFileSync(old, 'x');
    const twentyFiveHoursAgo = Date.now() / 1000 - (25 * 3600);
    fs.utimesSync(old, twentyFiveHoursAgo, twentyFiveHoursAgo);
    cleanupStaleDownloads(tmpDir);
    expect(fs.existsSync(old)).toBe(false);
  });

  it('keeps non-.partial files newer than 24h', () => {
    const fresh = path.join(tmpDir, 'YouCoded.exe');
    fs.writeFileSync(fresh, 'x');
    cleanupStaleDownloads(tmpDir);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});

describe('findCachedDownload', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-installer-cache-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no file matches the version', () => {
    expect(findCachedDownload(tmpDir, '1.2.3', 'win32')).toBeNull();
  });

  it('returns null when cacheDir does not exist', () => {
    expect(findCachedDownload(path.join(tmpDir, 'missing'), '1.2.3', 'win32')).toBeNull();
  });

  it('finds a matching .exe by version substring on Windows', () => {
    const filePath = path.join(tmpDir, 'YouCoded-Setup-1.2.3.exe');
    fs.writeFileSync(filePath, 'x');
    const hit = findCachedDownload(tmpDir, '1.2.3', 'win32');
    expect(hit).toEqual({ filePath, version: '1.2.3' });
  });

  it('finds a matching .dmg by version substring on macOS', () => {
    const filePath = path.join(tmpDir, 'YouCoded-1.2.3-arm64.dmg');
    fs.writeFileSync(filePath, 'x');
    const hit = findCachedDownload(tmpDir, '1.2.3', 'darwin');
    expect(hit).toEqual({ filePath, version: '1.2.3' });
  });

  it('ignores .partial files', () => {
    fs.writeFileSync(path.join(tmpDir, 'YouCoded-Setup-1.2.3.exe.partial'), 'x');
    expect(findCachedDownload(tmpDir, '1.2.3', 'win32')).toBeNull();
  });

  it('ignores files for a different version', () => {
    fs.writeFileSync(path.join(tmpDir, 'YouCoded-Setup-1.2.2.exe'), 'x');
    expect(findCachedDownload(tmpDir, '1.2.3', 'win32')).toBeNull();
  });

  it('does NOT match "1.2.3" against YouCoded-Setup-1.2.30.exe (version substring false-positive guard)', () => {
    fs.writeFileSync(path.join(tmpDir, 'YouCoded-Setup-1.2.30.exe'), 'x');
    expect(findCachedDownload(tmpDir, '1.2.3', 'win32')).toBeNull();
  });

  it('does NOT match "2.0" against YouCoded-Setup-1.2.0.exe (version embedded in another)', () => {
    fs.writeFileSync(path.join(tmpDir, 'YouCoded-Setup-1.2.0.exe'), 'x');
    expect(findCachedDownload(tmpDir, '2.0', 'win32')).toBeNull();
  });

  it('finds underscore-delimited .deb by version', () => {
    const filePath = path.join(tmpDir, 'youcoded_1.2.3_amd64.deb');
    fs.writeFileSync(filePath, 'x');
    const hit = findCachedDownload(tmpDir, '1.2.3', 'linux');
    expect(hit).toEqual({ filePath, version: '1.2.3' });
  });
});

describe('launchInstaller', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-launch-test-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function fakeChild(overrides: Partial<{ exitCode: number | null; exitDelay: number; errorOnSpawn: boolean }> = {}) {
    const emitter: any = new EventEmitter();
    emitter.unref = () => {};
    if (overrides.errorOnSpawn) {
      setImmediate(() => emitter.emit('error', new Error('ENOENT')));
    } else if (overrides.exitCode !== undefined) {
      setTimeout(() => emitter.emit('exit', overrides.exitCode), overrides.exitDelay ?? 10);
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
    let relaunched = false;
    const launch = makeLaunchInstaller({
      platform: 'linux',
      spawn: () => fakeChild({ exitCode: 0, exitDelay: 5000 }),
      shellOpenExternal: async () => {},
      appRelaunch: () => { relaunched = true; },
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

  it('Linux .deb: shells out to browser, app keeps running', async () => {
    const filePath = path.join(tmpDir, 'youcoded.deb');
    fs.writeFileSync(filePath, 'x');
    const opened: string[] = [];
    const launch = makeLaunchInstaller({
      platform: 'linux',
      spawn: () => fakeChild(),
      shellOpenExternal: async (url: string) => { opened.push(url); },
      appRelaunch: () => {},
      fallbackDownloadUrl: () => 'https://github.com/...deb',
      envAppImage: '/does/not/matter.AppImage',
    });
    const r = await launch({ jobId: 'j', filePath });
    expect(r).toEqual({ success: true, quitPending: false, fallback: 'browser' });
    expect(opened).toEqual(['https://github.com/...deb']);
  });
});
