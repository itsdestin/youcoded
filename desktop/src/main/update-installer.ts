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
import type { UpdateInstallErrorCode, UpdateDownloadResult, UpdateProgressEvent } from '../shared/update-install-types';

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
 * always contains the version string; we require both a platform-valid
 * extension AND the version substring to match.
 */
export function findCachedDownload(
  cacheDir: string,
  expectedVersion: string,
  platform: NodeJS.Platform,
): import('../shared/update-install-types').UpdateCachedDownload | null {
  if (!fs.existsSync(cacheDir)) return null;
  const allowed = ALLOWED_EXTENSIONS_BY_PLATFORM[platform] ?? [];
  for (const entry of fs.readdirSync(cacheDir)) {
    if (entry.endsWith('.partial')) continue;
    if (!allowed.some(ext => entry.endsWith(ext))) continue;
    if (!entry.includes(expectedVersion)) continue;
    const filePath = path.join(cacheDir, entry);
    try {
      if (fs.statSync(filePath).isFile()) return { filePath, version: expectedVersion };
    } catch { /* ignore */ }
  }
  return null;
}
