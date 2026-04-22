import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateDownloadUrl, deriveDownloadFilename, createUpdateInstaller } from '../src/main/update-installer';
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
