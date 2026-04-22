// update-installer.ts — In-app download-and-launch lifecycle for YouCoded updates.
// Spec: docs/superpowers/specs/2026-04-22-in-app-update-installer-design.md
// Shared types: desktop/src/shared/update-install-types.ts
//
// Responsibilities (added incrementally across tasks):
//   Task 2: URL validation + filename derivation (this file currently)
//   Task 3: startDownload / cancelDownload / progress throttling
//   Task 4: cleanupStaleDownloads
//   Task 5: launchInstaller (platform branches)
//   Task 6: getCachedDownload

import fs from 'fs';
import path from 'path';
import https from 'https';
import { randomUUID } from 'crypto';
import { spawn as nodeSpawn, type SpawnOptions } from 'child_process';
import type { UpdateInstallErrorCode, UpdateDownloadResult, UpdateProgressEvent, UpdateLaunchResult } from '../shared/update-install-types';

// Domains we'll accept release-asset downloads from. GitHub Releases sometimes
// redirects the download URL from github.com -> objects.githubusercontent.com;
// both need to be allowed. A malicious metadata response that tried to point
// us elsewhere (e.g. an attacker-controlled CDN) would be rejected here.
const ALLOWED_HOSTS = new Set(['github.com', 'objects.githubusercontent.com']);

// Whitelist of extensions we know how to launch. Prevents path-traversal payloads
// that smuggle arbitrary file types into userData/update-cache/.
const ALLOWED_EXTENSIONS_BY_PLATFORM: Record<string, readonly string[]> = {
  win32:  ['.exe'],
  darwin: ['.dmg'],
  linux:  ['.AppImage', '.deb'],
};

export class UpdateInstallError extends Error {
  constructor(public readonly code: UpdateInstallErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'UpdateInstallError';
  }
}

/**
 * Throws UpdateInstallError('url-rejected') if `url` is not HTTPS or its host
 * is outside the GitHub allowlist. Returns the parsed URL on success.
 */
export function validateDownloadUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UpdateInstallError('url-rejected', `malformed url: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new UpdateInstallError('url-rejected', `non-https: ${parsed.protocol}`);
  }
  if (!ALLOWED_HOSTS.has(parsed.host)) {
    throw new UpdateInstallError('url-rejected', `host not allowed: ${parsed.host}`);
  }
  return parsed;
}

/**
 * Extracts a safe basename from the URL path (strips query/hash), rejects any
 * path-traversal payload, and enforces a per-platform extension whitelist.
 */
export function deriveDownloadFilename(url: string, platform: NodeJS.Platform): string {
  const parsed = validateDownloadUrl(url);
  // URL pathname is always absolute (leading '/'); last segment after '/' is the filename.
  const rawName = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
  if (!rawName || rawName.includes('..') || rawName.includes('\\')) {
    throw new UpdateInstallError('url-rejected', `unsafe filename: ${rawName}`);
  }
  const allowed = ALLOWED_EXTENSIONS_BY_PLATFORM[platform] ?? [];
  const match = allowed.find(ext => rawName.endsWith(ext));
  if (!match) {
    throw new UpdateInstallError('url-rejected', `extension not allowed for ${platform}: ${rawName}`);
  }
  return rawName;
}

// ─── Task 3: Download engine ─────────────────────────────────────────────────

// Throttle limits: emit a progress event only when at least one of these
// boundaries is crossed. Keeps IPC traffic reasonable for a ~150 MB download
// (roughly 20 events) without losing the final 100% tick.
const PROGRESS_THROTTLE_MS = 250;
const PROGRESS_PERCENT_STEP = 5;
const MAX_REDIRECTS = 5;

type HttpsGet = (url: string, cb: (res: any) => void) => any;

export interface UpdateInstallerOptions {
  cacheDir: string;
  // Indirection so tests can inject a scripted response without a real HTTPS server.
  httpsGet?: HttpsGet;
  platform?: NodeJS.Platform;
  // Fired as bytes arrive; already throttled — consumers do not need to debounce.
  onProgress: (ev: UpdateProgressEvent) => void;
}

interface ActiveJob {
  jobId: string;
  url: string;
  filePath: string;
  partialPath: string;
  bytesReceived: number;
  bytesTotal: number;
  lastEmitTime: number;
  lastEmitPercent: number;
  req: any; // the underlying request handle (destroyed on cancel)
  writeStream: fs.WriteStream;
  deferred: { resolve: (r: UpdateDownloadResult) => void; reject: (e: Error) => void };
}

/**
 * Factory that creates an isolated download engine instance.
 * Enforces a single-job invariant: a second startDownload with the same URL
 * while one is in flight returns a promise that resolves/rejects together
 * with the original (same jobId, same filePath).
 */
export function createUpdateInstaller(options: UpdateInstallerOptions) {
  const { cacheDir, platform = process.platform, onProgress } = options;
  // Allow injecting a fake httpsGet for tests; production uses the real one.
  const httpsGet: HttpsGet = options.httpsGet ?? (https.get.bind(https) as HttpsGet);
  let active: ActiveJob | null = null;

  // Emit a progress event only when a time or percent threshold has been crossed.
  // Pass force=true for the final 100% tick so it always fires.
  function emitProgress(job: ActiveJob, force = false) {
    const now = Date.now();
    const percent = job.bytesTotal > 0
      ? Math.floor((job.bytesReceived / job.bytesTotal) * 100)
      : -1;
    const timeOk = now - job.lastEmitTime >= PROGRESS_THROTTLE_MS;
    const percentOk = percent !== -1 && percent - job.lastEmitPercent >= PROGRESS_PERCENT_STEP;
    if (!force && !timeOk && !percentOk) return;
    job.lastEmitTime = now;
    if (percent !== -1) job.lastEmitPercent = percent;
    onProgress({
      jobId: job.jobId,
      bytesReceived: job.bytesReceived,
      bytesTotal: job.bytesTotal,
      percent,
    });
  }

  // Tear down a job: close the write stream, optionally delete the .partial,
  // and clear the active slot.
  function cleanupActive(job: ActiveJob, unlinkPartial: boolean) {
    try { job.writeStream.destroy(); } catch { /* ignore */ }
    if (unlinkPartial) {
      try { fs.unlinkSync(job.partialPath); } catch { /* ignore */ }
    }
    if (active?.jobId === job.jobId) active = null;
  }

  // Follows up to MAX_REDIRECTS hops, re-validating each URL.
  // captureReq is called synchronously with each new request so the active job
  // always holds the current req handle for cancellation.
  function followRequest(
    url: string,
    redirectCount: number,
    onResponse: (err: Error | null, res: any) => void,
    captureReq: (req: any) => void,
  ) {
    if (redirectCount > MAX_REDIRECTS) {
      onResponse(new Error('too many redirects'), null);
      return;
    }
    let parsed: URL;
    try {
      parsed = validateDownloadUrl(url); // each hop is independently re-validated
    } catch (e) {
      onResponse(e as Error, null);
      return;
    }
    const req = httpsGet(parsed.toString(), (res: any) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers?.location) {
        res.resume?.(); // drain the redirect body so the socket can be reused
        followRequest(new URL(res.headers.location, parsed).toString(), redirectCount + 1, onResponse, captureReq);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        onResponse(new Error(`http ${res.statusCode}`), null);
        return;
      }
      onResponse(null, res);
    });
    req.on?.('error', (err: Error) => onResponse(err, null));
    captureReq(req);
  }

  function startDownload(rawUrl: string): Promise<UpdateDownloadResult> {
    // Single-job invariant: coalesce to the existing promise if the URL matches.
    if (active && active.url === rawUrl) {
      return new Promise<UpdateDownloadResult>((resolve, reject) => {
        const prior = active!.deferred;
        // Chain both callers onto the same outcome without losing either.
        active!.deferred = {
          resolve: (r) => { prior.resolve(r); resolve(r); },
          reject: (e) => { prior.reject(e); reject(e); },
        };
      });
    }
    if (active) {
      // Different URL while another download is running — reject fast with 'busy'.
      // (Not 'url-rejected': this is an internal concurrency issue, not a URL-validation
      // failure. The IPC layer should cancel before issuing a new startDownload.)
      return Promise.reject(new UpdateInstallError('busy', 'another download is already active'));
    }

    // Validate URL and derive filename BEFORE opening any file or socket.
    // This keeps the tmp directory clean on rejection.
    let filename: string;
    try {
      validateDownloadUrl(rawUrl);
      filename = deriveDownloadFilename(rawUrl, platform);
    } catch (e) {
      return Promise.reject(e);
    }

    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    const filePath = path.join(cacheDir, filename);
    const partialPath = filePath + '.partial';
    // Remove any .partial left from a previous crashed attempt so we start fresh.
    try { fs.unlinkSync(partialPath); } catch { /* ignore */ }

    return new Promise<UpdateDownloadResult>((resolve, reject) => {
      const writeStream = fs.createWriteStream(partialPath);
      const job: ActiveJob = {
        jobId: randomUUID(),
        url: rawUrl,
        filePath,
        partialPath,
        bytesReceived: 0,
        bytesTotal: 0,
        lastEmitTime: 0,
        // Start lastEmitPercent below zero so the very first tick qualifies.
        lastEmitPercent: -PROGRESS_PERCENT_STEP,
        req: null,
        writeStream,
        deferred: { resolve, reject },
      };
      active = job;

      writeStream.on('error', (err) => {
        // ENOSPC → disk-full; anything else → network-failed (conservative).
        const code = (err as NodeJS.ErrnoException).code === 'ENOSPC' ? 'disk-full' : 'network-failed';
        cleanupActive(job, true);
        job.deferred.reject(new UpdateInstallError(code, err.message));
      });

      followRequest(rawUrl, 0, (err, res) => {
        if (err || !res) {
          cleanupActive(job, true);
          // Preserve UpdateInstallError codes (e.g. url-rejected from a redirect
          // hop) rather than flattening everything to network-failed.
          const wrapped = err instanceof UpdateInstallError
            ? err
            : new UpdateInstallError('network-failed', err?.message ?? 'no response');
          job.deferred.reject(wrapped);
          return;
        }
        const contentLength = Number(res.headers?.['content-length'] ?? 0);
        job.bytesTotal = Number.isFinite(contentLength) ? contentLength : 0;

        res.on('data', (chunk: Buffer) => {
          job.bytesReceived += chunk.length;
          writeStream.write(chunk);
          emitProgress(job);
        });

        res.on('end', () => {
          writeStream.end(() => {
            // Guard: if cancelDownload fired while we were flushing, the .partial
            // has already been deleted and the deferred already rejected.
            // Don't double-reject or attempt rename of a missing file.
            if (active?.jobId !== job.jobId) return;
            try {
              fs.renameSync(partialPath, filePath);
            } catch (renameErr) {
              cleanupActive(job, true);
              job.deferred.reject(new UpdateInstallError('network-failed', `rename failed: ${(renameErr as Error).message}`));
              return;
            }
            // Always fire a final 100% progress tick regardless of throttle state.
            emitProgress(job, true);
            const result: UpdateDownloadResult = {
              jobId: job.jobId,
              filePath,
              bytesTotal: job.bytesTotal || job.bytesReceived,
            };
            if (active?.jobId === job.jobId) active = null;
            job.deferred.resolve(result);
          });
        });

        res.on('error', (streamErr: Error) => {
          cleanupActive(job, true);
          job.deferred.reject(new UpdateInstallError('network-failed', streamErr.message));
        });
      }, (req) => { job.req = req; });
    });
  }

  function cancelDownload(jobId: string): void {
    if (!active || active.jobId !== jobId) return;
    const job = active;
    try { job.req?.destroy(); } catch { /* ignore */ }
    cleanupActive(job, true);
    job.deferred.reject(new UpdateInstallError('network-failed', 'cancelled'));
  }

  function getActiveJobId(): string | null {
    return active?.jobId ?? null;
  }

  return { startDownload, cancelDownload, getActiveJobId };
}

// ─── Task 4: Stale-download cleanup + cache lookup ──────────────────────────

const STALE_DOWNLOAD_AGE_MS = 24 * 3600 * 1000;

/**
 * Swept at app startup. Removes abandoned .partial files unconditionally and
 * any non-partial download older than 24h (likely already installed).
 * Safe to call when the directory doesn't exist — creates it.
 */
export function cleanupStaleDownloads(cacheDir: string): void {
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
    return;
  }
  const now = Date.now();
  for (const entry of fs.readdirSync(cacheDir)) {
    const entryPath = path.join(cacheDir, entry);
    try {
      if (entry.endsWith('.partial')) {
        fs.unlinkSync(entryPath);
        continue;
      }
      const stat = fs.statSync(entryPath);
      if (!stat.isFile()) continue;
      if (now - stat.mtimeMs > STALE_DOWNLOAD_AGE_MS) fs.unlinkSync(entryPath);
    } catch {
      // Best-effort cleanup; don't block app startup on a stuck file.
    }
  }
}

/**
 * Looks for an already-downloaded installer matching `expectedVersion` for the
 * current platform. Used when the user reopens the update popup and a prior
 * download completed — skips the re-download.
 *
 * Heuristic: the downloaded filename (set by electron-builder release naming)
 * always contains the version string, flanked by `-` or `_` separators.
 * We require the version to appear as a BOUNDED token (not a raw substring),
 * so `1.2.3` does not accidentally match `YouCoded-Setup-1.2.30.exe`, and `2.0`
 * does not match `1.2.0.exe`.
 *
 * Covers electron-builder patterns:
 *   Windows: YouCoded-Setup-{version}.exe
 *   macOS:   YouCoded-{version}[-arm64].dmg
 *   Linux:   YouCoded-{version}.AppImage | youcoded_{version}_amd64.deb
 */
function buildVersionRegex(expectedVersion: string): RegExp {
  const escaped = expectedVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Must be preceded by `-` or `_` (or string start) and followed by `.`, `-`,
  // `_`, or end-of-string. Prevents `1.2.3` matching `1.2.30` or `2.0` matching
  // `1.2.0`.
  return new RegExp(`(?:^|[_-])${escaped}(?=[_.\\-]|$)`);
}

export function findCachedDownload(
  cacheDir: string,
  expectedVersion: string,
  platform: NodeJS.Platform,
): import('../shared/update-install-types').UpdateCachedDownload | null {
  if (!fs.existsSync(cacheDir)) return null;
  const allowed = ALLOWED_EXTENSIONS_BY_PLATFORM[platform] ?? [];
  const versionRe = buildVersionRegex(expectedVersion);
  for (const entry of fs.readdirSync(cacheDir)) {
    if (entry.endsWith('.partial')) continue;
    if (!allowed.some(ext => entry.endsWith(ext))) continue;
    if (!versionRe.test(entry)) continue;
    const filePath = path.join(cacheDir, entry);
    try {
      if (fs.statSync(filePath).isFile()) return { filePath, version: expectedVersion };
    } catch { /* ignore */ }
  }
  return null;
}

// ─── Task 5: Platform-specific launcher ─────────────────────────────────────

// Quick-exit window: on macOS we spawn `open -W`, which stays alive until the
// mounted DMG is ejected — for a healthy DMG that could be an hour. We only
// listen for a FAST failure: if the child exits non-zero within this window
// we treat it as a bad DMG; beyond it, we assume success and return quitPending.
const QUICK_EXIT_WINDOW_MS = 2000;

export interface LaunchInstallerDeps {
  platform?: NodeJS.Platform;
  // Injected for testability. Production wires in node child_process spawn + Electron shell/app.
  spawn?: (cmd: string, args: string[], opts: SpawnOptions) => any;
  shellOpenExternal: (url: string) => Promise<void>;
  appRelaunch: () => void;
  // Lazily read so the module doesn't care where the URL lives (main caches it).
  fallbackDownloadUrl: () => string;
  // Override for Linux AppImage detection — prod reads process.env.APPIMAGE.
  envAppImage?: string;
}

export interface LaunchInstallerInput {
  jobId: string;
  filePath: string;
}

/**
 * Factory that returns a `launch(input)` function bound to the injected deps.
 * The returned function spawns the right installer binary per platform and returns
 * an UpdateLaunchResult. It does NOT call app.quit() directly — callers schedule
 * that after a short delay when quitPending is true.
 */
export function makeLaunchInstaller(deps: LaunchInstallerDeps) {
  const platform = deps.platform ?? process.platform;
  const spawnFn = deps.spawn ?? (nodeSpawn as any);

  async function launch(input: LaunchInstallerInput): Promise<UpdateLaunchResult> {
    // Guard: make sure the file wasn't cleaned up between download and launch.
    if (!fs.existsSync(input.filePath)) {
      return { success: false, error: 'file-missing' };
    }

    if (platform === 'win32') {
      // Windows NSIS installer: detach immediately and let NSIS own its lifetime.
      return spawnDetached(input.filePath, [], false);
    }

    if (platform === 'darwin') {
      // macOS DMG: `open -W` mounts the DMG and opens the install window.
      // It stays running until the user ejects — we only watch for fast failure.
      return spawnDetached('open', ['-W', input.filePath], true, 'dmg-corrupt');
    }

    if (platform === 'linux') {
      if (input.filePath.endsWith('.deb')) {
        // .deb requires root / package manager — we can't launch it directly.
        // Open the release page in the browser so the user can install manually.
        await deps.shellOpenExternal(deps.fallbackDownloadUrl());
        return { success: true, quitPending: false, fallback: 'browser' };
      }

      if (input.filePath.endsWith('.AppImage')) {
        // AppImage self-replace: overwrite the currently-running AppImage, then relaunch.
        // If APPIMAGE is not set (e.g. running from source), fall back to browser.
        const running = deps.envAppImage ?? process.env.APPIMAGE;
        if (!running || !fs.existsSync(running)) {
          await deps.shellOpenExternal(deps.fallbackDownloadUrl());
          return { success: true, quitPending: false, fallback: 'browser' };
        }
        try {
          // Ensure the new AppImage is executable before replacing.
          fs.chmodSync(input.filePath, 0o755);
          try {
            // Atomic rename — fastest path, works when src/dst are on the same filesystem.
            fs.renameSync(input.filePath, running);
          } catch (e: any) {
            if (e.code === 'EXDEV') {
              // Cross-device rename (tmpfs download dir → ext4 app dir). Copy then unlink.
              // Guard the copy for ENOSPC so the renderer shows the correct disk-full copy
              // instead of a generic spawn-failed.
              try {
                fs.copyFileSync(input.filePath, running);
                fs.unlinkSync(input.filePath);
              } catch (copyErr: any) {
                if (copyErr.code === 'ENOSPC') return { success: false, error: 'disk-full' };
                if (copyErr.code === 'EACCES' || copyErr.code === 'EPERM' || copyErr.code === 'EROFS') {
                  return { success: false, error: 'appimage-not-writable' };
                }
                return { success: false, error: 'spawn-failed' };
              }
            } else if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS') {
              // AppImage path is root-owned (EACCES/EPERM) or on a read-only FS (EROFS) —
              // user needs sudo or a different location.
              return { success: false, error: 'appimage-not-writable' };
            } else if (e.code === 'ENOSPC') {
              return { success: false, error: 'disk-full' };
            } else {
              return { success: false, error: 'spawn-failed' };
            }
          }
        } catch {
          return { success: false, error: 'spawn-failed' };
        }
        // Trigger Electron's built-in relaunch so the new AppImage starts after quit.
        deps.appRelaunch();
        return { success: true, quitPending: true };
      }
    }

    return { success: false, error: 'unsupported-platform' };
  }

  /**
   * Spawns `cmd` with `args` detached. When `requireQuickExitOk` is true (macOS
   * `open -W`), a 2-second window listens for an early non-zero exit that signals
   * a broken DMG. On Windows the child is unref'd immediately after spawn.
   *
   * A `settled` flag prevents double-resolve from overlapping error/exit/timer events.
   */
  function spawnDetached(
    cmd: string,
    args: string[],
    requireQuickExitOk: boolean,
    quickExitErrorCode: 'dmg-corrupt' | 'spawn-failed' = 'spawn-failed',
  ): Promise<UpdateLaunchResult> {
    return new Promise(resolve => {
      let settled = false;
      let child: any;
      // Hoisted so the `error` handler can clear the 2s quick-exit timer too —
      // otherwise the timer survives and keeps Node's event loop alive until it fires.
      let timer: NodeJS.Timeout | null = null;

      try {
        child = spawnFn(cmd, args, {
          detached: true,
          stdio: 'ignore',
          // Show NSIS's own window on Windows (windowsHide:true would suppress it).
          ...(platform === 'win32' ? { windowsHide: false } : {}),
        });
      } catch {
        // spawn() itself threw synchronously (e.g. ENOENT before the child started).
        resolve({ success: false, error: 'spawn-failed' });
        return;
      }

      // Async spawn error (e.g. ENOENT surfaced via the error event on Windows/Linux).
      child.on?.('error', () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ success: false, error: 'spawn-failed' });
      });

      if (requireQuickExitOk) {
        // macOS: wait up to QUICK_EXIT_WINDOW_MS for an early non-zero exit.
        // If the timer fires first the DMG mounted fine; resolve success.
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { child.unref?.(); } catch { /* ignore */ }
          resolve({ success: true, quitPending: true });
        }, QUICK_EXIT_WINDOW_MS);

        child.on?.('exit', (code: number | null) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (code !== null && code !== 0) {
            resolve({ success: false, error: quickExitErrorCode });
          } else {
            // Exited 0 within the window (unusual but valid — DMG was already mounted).
            resolve({ success: true, quitPending: true });
          }
        });
      } else {
        // Windows / detach-immediately path: unref the child in the next tick so
        // Node doesn't wait for it to exit, then resolve success.
        setImmediate(() => {
          if (settled) return;
          settled = true;
          try { child.unref?.(); } catch { /* ignore */ }
          resolve({ success: true, quitPending: true });
        });
      }
    });
  }

  return launch;
}
