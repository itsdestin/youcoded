// update-service.ts — the app's own update: release check, beta channel, download, verified launch.
//
// WHY (2026-09-30 one-core R3-2): all of this lived as locals inside registerIpcHandlers, so the
// only way to reach it was an ipcMain.handle written in that function. The channel table's entries
// (main/ipc/update.ts) need to call it from outside, and the status poller in ipc-handlers.ts still
// reads getUpdateStatus(). One lazily-built service (it needs Electron's app paths, so it cannot be
// built at import time) serves both. The code below is moved unchanged except where marked.
import fs from 'fs';
import path from 'path';
import https from 'https';
import { app, BrowserWindow, shell } from 'electron';
import { createUpdateInstaller, findCachedDownload, makeLaunchInstaller, UpdateInstallError, isAllowedUpdateHost } from './update-installer';
import type { UpdateProgressEvent, UpdateInstallErrorCode, UpdateBetaChannelState } from '../shared/update-install-types';
import { verifyDownloadedUpdate } from './update-manifest-verify';
import { readReleaseStatus, selectRelease, type UpdateStatus } from './update-release-status';
import { linuxInstallKind, primeLinuxInstallKind } from './linux-install-kind';
import { UpdateSettings } from './update-settings';
import { UPDATE_SIGNING_PUBLIC_KEY_PEM } from './update-signing-key';
import { NativeHome } from './native-home';

function createUpdateService() {
  // --- YouCoded app update checker via GitHub Releases API ---
  // Caches the latest release info and refreshes every 30 minutes.
  // manifest_url/signature_url/tag are captured for the 2026-09-10 signed-update
  // verification (#7): the app fetches the signed manifest + signature at launch
  // time and refuses any installer that doesn't match. tag is the FULL tag
  // (e.g. `v1.3.0`) the manifest's version must equal.
  let cachedUpdateStatus: UpdateStatus | null = null;
  let lastReleaseCheck = 0;
  const RELEASE_CHECK_INTERVAL = 30 * 60 * 1000; // 30 minutes

  // WHY its own NativeHome and not the shared `nativeHome` below: that const is
  // declared ~600 lines further down, and the first update check fires before it
  // is initialised — reading it here would hit the temporal dead zone. A second
  // instance is safe because NativeHome.mutateJson serialises through a FILE
  // lock, not in-process state, so the two never race on config.json.
  const updateSettings = new UpdateSettings(new NativeHome());

  /** The listing to ask for, and how to read it, for this install's channel. */
  function releaseEndpoint(): { url: string; listing: boolean } {
    // WHY two endpoints (2026-09-13): GitHub defines /releases/latest as the
    // newest STABLE release and omits pre-releases entirely. A stable install
    // must keep seeing exactly that — it is what stops ordinary users being
    // pulled onto beta software. Only the beta channel pays for the listing.
    return updateSettings.resolve(app.getVersion())
      ? { url: 'https://api.github.com/repos/itsdestin/youcoded/releases?per_page=20', listing: true }
      : { url: 'https://api.github.com/repos/itsdestin/youcoded/releases/latest', listing: false };
  }

  function fetchLatestRelease(): Promise<void> {
    const { url, listing } = releaseEndpoint();
    return new Promise((resolve) => {
      const req = https.get(url, {
        headers: { 'User-Agent': 'YouCoded', 'Accept': 'application/vnd.github.v3+json' },
        timeout: 10000,
      }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          // Follow redirect (GitHub sometimes redirects)
          https.get(res.headers.location!, { headers: { 'User-Agent': 'YouCoded', 'Accept': 'application/vnd.github.v3+json' }, timeout: 10000 }, (rRes) => {
            let body = '';
            rRes.on('data', (chunk: Buffer) => { body += chunk.toString(); });
            rRes.on('end', () => { void primeLinuxInstallKind().finally(() => { parseReleaseResponse(body, listing); resolve(); }); });
          }).on('error', () => { resolve(); });
          return;
        }
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        // WHY prime first: parseReleaseResponse reads linuxInstallKind(); priming
        // answers it off the main thread instead of blocking spawnSync calls.
        res.on('end', () => { void primeLinuxInstallKind().finally(() => { parseReleaseResponse(body, listing); resolve(); }); });
      });
      req.on('error', () => { resolve(); });
      req.on('timeout', () => { req.destroy(); resolve(); });
    });
  }

  function currentOnlyStatus(): UpdateStatus {
    return { current: app.getVersion(), latest: app.getVersion(), update_available: false, download_url: null, manifest_url: null, signature_url: null, tag: null };
  }

  function parseReleaseResponse(body: string, listing: boolean) {
    try {
      // WHY the decision moved out (2026-09-11): the private compare that lived
      // here read `1.3.0-beta.76` as HIGHER than `1.3.0`, so a beta was never told
      // the full release existed. update-release-status.ts decides newer / which
      // file / signed, with tests that walk a beta through to the full release.
      const parsed: unknown = JSON.parse(body);
      // On the beta channel the body is an ARRAY of releases, newest-published
      // first; selectRelease picks the highest VERSION carrying this computer's
      // installer, so the full 1.3.0 ends a beta run without a special case.
      const release = listing
        ? selectRelease(parsed, { includePrereleases: true, platform: process.platform, arch: process.arch, linuxKind: linuxInstallKind(), translated: app.runningUnderARM64Translation })
        : (parsed as Parameters<typeof readReleaseStatus>[0]);
      // The install kind rides along because a pacman/deb/rpm install can only apply
      // its OWN package — offering it the AppImage was 180 MB wasted (2026-09-20).
      const next = readReleaseStatus(release, app.getVersion(), process.platform, process.arch, linuxInstallKind(), app.runningUnderARM64Translation);
      if (next) cachedUpdateStatus = next;
      else if (!cachedUpdateStatus) cachedUpdateStatus = currentOnlyStatus();
      // Stamped even for a reply that is not a release (GitHub's rate-limit body),
      // as before, so a rate limit is not re-asked on every status poll.
      lastReleaseCheck = Date.now();
    } catch {
      // Parse failed — keep previous cache or set current version only
      if (!cachedUpdateStatus) cachedUpdateStatus = currentOnlyStatus();
    }
  }

  function getUpdateStatus() {
    // Return cached value, kick off background refresh if stale
    if (Date.now() - lastReleaseCheck > RELEASE_CHECK_INTERVAL) {
      fetchLatestRelease().catch(() => {});
    }
    const status = cachedUpdateStatus || { current: app.getVersion(), latest: app.getVersion(), update_available: false, download_url: null };

    // Dev-only: force update_available=true for manual UpdatePanel verification without waiting for a real release.
    // Set YOUCODED_DEV_FAKE_UPDATE=1 to simulate a new release one patch ahead of the current version.
    // Note: the download_url points at the real GitHub releases page, so clicking Update Now opens the browser
    // to the actual latest release — not the fake +1 version. That's fine for UI verification; no real installer
    // exists for the fake version. No-op unless the env var is exactly '1'.
    // `!app.isPackaged` gate: belt-and-suspenders so a stray env var in a user's
    // shell can't flip the update pill on in a packaged build. Dev-only by design.
    if (!app.isPackaged && process.env.YOUCODED_DEV_FAKE_UPDATE === '1') {
      const currentVersion = app.getVersion();
      const parts = currentVersion.split('.').map(n => parseInt(n, 10));
      const maj = parts[0] || 0;
      const min = parts[1] || 0;
      const patch = parts[2] || 0;
      return {
        current: currentVersion,
        latest: `${maj}.${min}.${patch + 1}`,
        update_available: true,
        download_url: 'https://github.com/itsdestin/youcoded/releases/latest',
      };
    }

    return status;
  }

  function betaChannelState(): UpdateBetaChannelState {
    const saved = updateSettings.read().betaChannel;
    return { betaChannel: saved, effective: updateSettings.resolve(app.getVersion()) };
  }

  // -------------------------------------------------------------------------
  // In-app update installer — download + launch the platform installer.
  // Spec: docs/superpowers/specs/2026-04-22-in-app-update-installer-design.md
  // -------------------------------------------------------------------------
  const updateCacheDir = path.join(app.getPath('userData'), 'update-cache');

  const installer = createUpdateInstaller({
    cacheDir: updateCacheDir,
    onProgress: (ev: UpdateProgressEvent) => {
      // Broadcast to every live renderer. Renderers filter by jobId (single-job
      // invariant in the engine means only one is in flight, but filtering keeps
      // UI state correct if a prior job's final tick arrives after the popup closed).
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('update:progress', ev);
      }
    },
  });

  const launchInstaller = makeLaunchInstaller({
    shellOpenExternal: (url: string) => shell.openExternal(url),
    appRelaunch: () => app.relaunch(),
    fallbackDownloadUrl: () => cachedUpdateStatus?.download_url ?? '',
    // production reads process.env.APPIMAGE (Linux only); tests pass an override.
  });

  // Dev-only fake-update flag: when set AND running from source (unpackaged),
  // short-circuit the download/launch to use a bundled 1 MB dummy installer.
  // Lets us exercise the popup flow end-to-end without a real release. Gated on
  // !app.isPackaged so production builds can never enter this path even if the
  // env var is somehow set.
  const devFakeUpdate = !app.isPackaged && process.env.YOUCODED_DEV_FAKE_UPDATE === '1';

  // Fetch a small HTTPS body (the release manifest ~1 KB, its signature ~64 B)
  // into a Buffer, following redirects and re-checking the host on each hop.
  // Byte-capped so a hostile response can't balloon memory. 2026-09-10 security
  // review #7.
  function fetchUrlToBuffer(url: string, maxBytes: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const step = (current: string, depth: number) => {
        if (!isAllowedUpdateHost(current)) { reject(new UpdateInstallError('url-rejected', `host not allowed: ${current}`)); return; }
        if (depth > 5) { reject(new UpdateInstallError('network-failed', 'too many redirects')); return; }
        const req = https.get(current, { headers: { 'User-Agent': 'YouCoded' }, timeout: 10000 }, (res) => {
          const code = res.statusCode ?? 0;
          if ((code === 301 || code === 302 || code === 307 || code === 308) && res.headers.location) {
            res.resume();
            step(new URL(res.headers.location, current).toString(), depth + 1);
            return;
          }
          if (code !== 200) { res.resume(); reject(new UpdateInstallError('network-failed', `status ${code}`)); return; }
          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (c: Buffer) => {
            total += c.length;
            if (total > maxBytes) { req.destroy(); reject(new UpdateInstallError('verify-failed', 'metadata too large')); return; }
            chunks.push(c);
          });
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', (e: Error) => reject(new UpdateInstallError('network-failed', e.message)));
        });
        req.on('error', (e: Error) => reject(new UpdateInstallError('network-failed', e.message)));
        req.on('timeout', () => { req.destroy(); reject(new UpdateInstallError('network-failed', 'timeout')); });
      };
      step(url, 0);
    });
  }

  // Verify a downloaded installer against the release's signed manifest before we
  // run it (2026-09-10 security review #7). Returns an error code to refuse, or
  // null to proceed. A release with no signed manifest is REFUSED
  // ('signature-invalid') rather than run unverified — that is the whole point of
  // the fix. Reads cachedUpdateStatus directly (the dev-fake override never
  // reaches here; dev short-circuits before this).
  async function verifyBeforeLaunch(filePath: string): Promise<UpdateInstallErrorCode | null> {
    const status = cachedUpdateStatus;
    const manifestUrl = status?.manifest_url;
    const signatureUrl = status?.signature_url;
    const tag = status?.tag;
    if (!manifestUrl || !signatureUrl || !tag) {
      console.error('[update] refusing launch: this release has no signed manifest to verify against');
      return 'signature-invalid';
    }
    try {
      const [manifestBytes, signatureBytes] = await Promise.all([
        fetchUrlToBuffer(manifestUrl, 1024 * 1024),
        fetchUrlToBuffer(signatureUrl, 8 * 1024),
      ]);
      await verifyDownloadedUpdate({
        filePath,
        fileName: path.basename(filePath),
        manifestBytes,
        signatureBytes,
        tag,
        currentVersion: app.getVersion(),
        publicKeyPem: UPDATE_SIGNING_PUBLIC_KEY_PEM,
      });
      return null;
    } catch (err) {
      if (err instanceof UpdateInstallError) return err.code;
      console.error('[update] verification error:', err);
      return 'verify-failed'; // a transient fetch failure is retriable
    }
  }

  async function setBetaChannel(enabled: boolean): Promise<UpdateBetaChannelState> {
    await updateSettings.setBetaChannel(enabled);
    // WHY re-check immediately: the status cache holds one answer for 30 minutes,
    // and it was computed against the OTHER channel. Without this, turning the
    // channel on leaves "you're up to date" on screen for up to half an hour —
    // which reads as the toggle having done nothing.
    lastReleaseCheck = 0;
    await fetchLatestRelease();
    return betaChannelState();
  }

  async function download() {
    if (devFakeUpdate) {
      // Copy the bundled dummy installer into the cache dir so the launch path
      // exercises the same file-move logic it would hit in prod. Emits one
      // synchronous 100% progress event so the renderer sees the full arc.
      const ext = process.platform === 'win32' ? '.exe'
               : process.platform === 'darwin' ? '.dmg'
               : '.AppImage';
      // app.getAppPath() resolves to the desktop/ root (where package.json lives),
      // which is where dev-assets/ sits. More robust than __dirname across dev
      // build variations (tsc watch vs esbuild output).
      const srcPath = path.join(app.getAppPath(), 'dev-assets', `fake-installer${ext}`);
      await fs.promises.mkdir(updateCacheDir, { recursive: true }); // WHY async (R3-2): the moved handler no longer blocks the main thread
      const dstPath = path.join(updateCacheDir, `YouCoded-fake-dev${ext}`);
      await fs.promises.copyFile(srcPath, dstPath);
      const bytesTotal = (await fs.promises.stat(dstPath)).size;
      const jobId = `dev-${Date.now()}`;
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('update:progress', { jobId, bytesReceived: bytesTotal, bytesTotal, percent: 100 });
      }
      return { jobId, filePath: dstPath, bytesTotal };
    }
    // Renderer never passes a URL — we resolve main-side from the trusted cache
    // populated by the GitHub Releases check. Prevents renderer from spoofing
    // the download target.
    const status = getUpdateStatus();
    const url = status?.download_url;
    if (!url) throw new UpdateInstallError('url-rejected', 'no download URL available');
    return await installer.startDownload(url);
  }

  function cancel(jobId: string) {
    installer.cancelDownload(jobId);
    return { success: true };
  }

  async function launch(payload: { jobId: string; filePath: string }) {
    if (devFakeUpdate) {
      // Never actually launch anything in dev — just surface the cached file in
      // the OS file manager so Destin can confirm it exists.
      shell.showItemInFolder(payload.filePath);
      // Return the fallback: 'browser' shape so the renderer flips out of launching
      // state and calls onClose() — do NOT schedule app.quit() (that would kill the dev session).
      return { success: true as const, quitPending: false as const, fallback: 'browser' as const };
    }
    // Gate: never run an installer we can't prove is genuine (2026-09-10 security
    // review #7). On verify-failed, delete the cached file so a Retry re-downloads
    // a clean copy rather than re-verifying the same corrupt bytes.
    const verifyError = await verifyBeforeLaunch(payload.filePath);
    if (verifyError) {
      if (verifyError === 'verify-failed') { try { await fs.promises.unlink(payload.filePath); } catch { /* ignore */ } }
      return { success: false as const, error: verifyError };
    }
    const result = await launchInstaller({ jobId: payload.jobId, filePath: payload.filePath });
    if (result.success && result.quitPending) {
      // 500ms grace so the child installer process has detached cleanly before we exit.
      setTimeout(() => app.quit(), 500);
    }
    return result;
  }

  async function getCachedDownload(version: string) {
    return findCachedDownload(updateCacheDir, version, process.platform);
  }

  return { getUpdateStatus, fetchLatestRelease, betaChannelState, setBetaChannel, download, cancel, launch, getCachedDownload };
}

export type UpdateService = ReturnType<typeof createUpdateService>;
let service: UpdateService | null = null;
/** The one update service, built on first use. */
export function getUpdateService(): UpdateService {
  if (!service) service = createUpdateService();
  return service;
}
