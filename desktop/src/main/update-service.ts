// update-service.ts — the app's own update: release check, beta channel, download, verified launch.
//
// WHY (2026-09-30 one-core R3-2): all of this lived as locals inside registerIpcHandlers, so the
// only way to reach it was an ipcMain.handle written in that function. The channel table's entries
// (main/ipc/update.ts) need to call it from outside, and the status poller in ipc-handlers.ts still
// reads getUpdateStatus(). One lazily-built service (it needs Electron's app paths, so it cannot be
// built at import time) serves both. The code below is moved unchanged except where marked.
import fs from 'fs';
import os from 'os';
import path from 'path';
import https from 'https';
import { app, BrowserWindow, shell } from 'electron';
import { createUpdateInstaller, findCachedDownload, makeLaunchInstaller, UpdateInstallError, isAllowedUpdateHost, deriveDownloadFilename, cleanupStaleDownloads, RESERVED_CACHE_FILES } from './update-installer';
import type { UpdateProgressEvent, UpdateInstallErrorCode, UpdateBetaChannelState, UpdateAutoInstallState, UpdateDownloadResult, UpdateCachedDownloadResult } from '../shared/update-install-types';
import { verifyDownloadedUpdate, compareVersions, hashFileSha256 } from './update-manifest-verify';
import { computeInstallFacts, macBundleOf, type InstallFacts } from './update-install-facts';
import { isValidStagedName, stagedPathFor, stageAppImage, stageMacApp, removeStagedByName, sweepStaging, runCommand, type StagedPathContext } from './update-staging';
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
  // The work that follows the latest successful check (cleanup, background download). Exposed as
  // afterCheckDone() so a caller — and a test — can wait on the thing itself instead of sleeping.
  let afterCheck: Promise<void> = Promise.resolve();
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
            rRes.on('end', () => { void primeLinuxInstallKind().finally(() => { if (parseReleaseResponse(body, listing)) afterCheck = onCheckSucceeded().catch(() => {}); resolve(); }); });
          }).on('error', () => { resolve(); });
          return;
        }
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        // WHY prime first: parseReleaseResponse reads linuxInstallKind(); priming
        // answers it off the main thread instead of blocking spawnSync calls.
        res.on('end', () => { void primeLinuxInstallKind().finally(() => { if (parseReleaseResponse(body, listing)) afterCheck = onCheckSucceeded().catch(() => {}); resolve(); }); });
      });
      req.on('error', () => { resolve(); });
      req.on('timeout', () => { req.destroy(); resolve(); });
    });
  }

  function currentOnlyStatus(): UpdateStatus {
    return { current: app.getVersion(), latest: app.getVersion(), update_available: false, download_url: null, manifest_url: null, signature_url: null, tag: null };
  }

  /** Returns true when the body was a real release (a successful check), false for a rate-limit reply or garbage. */
  function parseReleaseResponse(body: string, listing: boolean): boolean {
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
      // (the stamp below runs for both; the return value says which it was)
      // Stamped even for a reply that is not a release (GitHub's rate-limit body),
      // as before, so a rate limit is not re-asked on every status poll.
      lastReleaseCheck = Date.now();
      return !!next;
    } catch {
      // Parse failed — keep previous cache or set current version only
      if (!cachedUpdateStatus) cachedUpdateStatus = currentOnlyStatus();
      return false;
    }
  }

  function getUpdateStatus() {
    // Return cached value, kick off background refresh if stale
    if (Date.now() - lastReleaseCheck > RELEASE_CHECK_INTERVAL) {
      fetchLatestRelease().catch(() => {});
    }
    // WHY currentOnlyStatus, not a shorter literal: before the first check finishes the answer must have the SAME
    // shape as after a failed one, or the status push sees a "change" when the check gives up and re-sends the
    // status bar for nothing (seen as a flaky ipc-handlers status-dedup test under load, 2026-10-15).
    const status = cachedUpdateStatus || currentOnlyStatus();

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
      return withInstallFields({
        current: currentVersion,
        latest: `${maj}.${min}.${patch + 1}`,
        update_available: true,
        download_url: 'https://github.com/itsdestin/youcoded/releases/latest',
      } as UpdateStatus);
    }

    return withInstallFields(status);
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

  let launchActive = false;
  let quitScheduled = false;
  function scheduleQuit() {
    if (quitScheduled) return;
    quitScheduled = true;
    // Keep launch ownership during the grace period too: a new launch cannot race quit.
    setTimeout(() => app.quit(), 500);
  }

  const launchInstaller = makeLaunchInstaller({
    onInstallProgress: (event) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('update:install-progress', event);
      }
    },
    onLateInstallResult: (result) => {
      // WHY timeout is not termination: keep the guard until the real close event,
      // and still restart a successful update even after the invoke returned unknown.
      if (result.success && result.quitPending) scheduleQuit();
      else launchActive = false;
    },
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
          // WHY the status rides on the error (#183 T2): the install-time brake treats a 404 on the FINAL hop
          // (the signed file was deleted) differently from a 403/500 (rate limit, outage).
          if (code !== 200) { res.resume(); reject(new UpdateInstallError('network-failed', `status ${code}`, code)); return; }
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

  // Verify a downloaded installer against a release's signed manifest (2026-09-10 security review
  // #7). `target` is THAT release's own tag and signed-file URLs: a background download may finish
  // after a newer release was announced, so it must never be checked against whatever is newest now
  // (#183 T2). Returns an error code to refuse, or null to proceed; `sha256` is the signed hash for
  // the file (staging re-hashes its copy against it). A release with no signed manifest is REFUSED
  // ('signature-invalid') rather than run unverified. `transient` marks a failure to FETCH the signed
  // file: the download itself may be fine, so callers keep it instead of deleting 150 MB.
  interface VerifyTarget { tag: string | null | undefined; manifestUrl: string | null | undefined; signatureUrl: string | null | undefined }
  async function verifyAgainstRelease(filePath: string, target: VerifyTarget): Promise<{ code: UpdateInstallErrorCode | null; transient?: boolean; sha256?: string }> {
    const { manifestUrl, signatureUrl, tag } = target;
    if (!manifestUrl || !signatureUrl || !tag) {
      console.error('[update] refusing: this release has no signed manifest to verify against');
      return { code: 'signature-invalid' };
    }
    let manifestBytes: Buffer, signatureBytes: Buffer;
    try {
      [manifestBytes, signatureBytes] = await Promise.all([
        fetchUrlToBuffer(manifestUrl, 1024 * 1024),
        fetchUrlToBuffer(signatureUrl, 8 * 1024),
      ]);
    } catch (err) {
      console.error('[update] could not fetch the signed release file:', err);
      return { code: 'verify-failed', transient: true }; // a transient fetch failure is retriable
    }
    try {
      const manifest = await verifyDownloadedUpdate({
        filePath,
        fileName: path.basename(filePath),
        manifestBytes,
        signatureBytes,
        tag,
        currentVersion: app.getVersion(),
        publicKeyPem: UPDATE_SIGNING_PUBLIC_KEY_PEM,
      });
      const entry = manifest?.assets?.find((a: { name: string }) => a.name === path.basename(filePath));
      return { code: null, sha256: entry?.sha256 };
    } catch (err) {
      if (err instanceof UpdateInstallError) return { code: err.code };
      console.error('[update] verification error:', err);
      return { code: 'verify-failed' };
    }
  }
  async function verifyBeforeLaunch(filePath: string): Promise<UpdateInstallErrorCode | null> {
    const status = cachedUpdateStatus;
    return (await verifyAgainstRelease(filePath, { tag: status?.tag, manifestUrl: status?.manifest_url, signatureUrl: status?.signature_url })).code;
  }

  // --- "Install updates automatically" (#183, design §1) ---
  // WHY supported is decided here: the same rule the dev fake-update path uses. Android's headless
  // backend reports isPackaged=false and has no installer, and an unpackaged desktop build has
  // nothing to install, so both answer {supported:false} and the row hides. The explicit headless
  // env check is belt-and-braces for a dev run that sets YOUCODED_DEV_FAKE_UPDATE.
  const autoInstallSupported = !process.env.YOUCODED_HEADLESS_PORT
    && (app.isPackaged || process.env.YOUCODED_DEV_FAKE_UPDATE === '1');
  // WHY an in-memory cache: the check and quit paths must never read config.json synchronously
  // (D18). Default true until the one async read lands, matching "absent ⇒ on". A set writes
  // through, so a read racing the load can never overwrite a newer choice (see loadAutoInstall).
  let autoInstallCache = true;
  // WHY a counter, not a flag: a read that STARTED before a save finished must not overwrite the
  // save with the older file contents, and a later re-read (refreshAutoInstall) must still be
  // allowed to apply once no save is racing it.
  let autoInstallWrites = 0;
  let autoInstallLoad: Promise<void> | null = null;
  /** Read the file once, off the main thread, and apply it unless a save landed meanwhile. */
  async function readAutoInstallInto(): Promise<void> {
    const startedAt = autoInstallWrites;
    const saved = await updateSettings.readAsync(); // readAsync maps failures to defaults
    if (startedAt === autoInstallWrites) autoInstallCache = saved.autoInstall;
  }
  /** Read the saved value once. T2 calls this at startup; get calls it lazily. */
  function loadAutoInstall(): Promise<void> {
    if (!autoInstallLoad) autoInstallLoad = readAutoInstallInto().catch(() => {});
    return autoInstallLoad;
  }
  /** Re-read config.json into the cache. WHY: the dev instance and the installed app share the
   *  file, so a change made by the other app is otherwise invisible until restart. T2 calls this
   *  on each background release check. Async only; never call it on the quit path (D18). */
  function refreshAutoInstall(): Promise<void> {
    return autoInstallSupported ? readAutoInstallInto().catch(() => {}) : Promise.resolve();
  }
  /** Sync, memory-only: what background downloads and the quit path consult. */
  function autoInstallEnabled(): boolean { return autoInstallSupported && autoInstallCache; }
  /** Turning the switch ON starts the background download now: the person just asked for it, so the
   *  startup deferral and an earlier Cancel do not apply (design §2). */
  function onAutoInstallEnabled(): void { void runBackground('switch-on'); }
  async function getAutoInstall(): Promise<UpdateAutoInstallState> {
    if (!autoInstallSupported) return { supported: false };
    await loadAutoInstall();
    return { supported: true, enabled: autoInstallCache };
  }
  // WHY a promise chain: two quick flips would otherwise run two locked writes whose finish order
  // is not their start order, leaving file and memory disagreeing about which flip was last.
  let autoInstallQueue: Promise<unknown> = Promise.resolve();
  function setAutoInstall(enabled: boolean): Promise<UpdateAutoInstallState> {
    if (!autoInstallSupported) return Promise.resolve({ supported: false });
    const run = autoInstallQueue.then(async (): Promise<UpdateAutoInstallState> => {
      // WHY validate/write before touching the cache: a rejected save must not leave memory saying
      // on while the file says off.
      await updateSettings.setAutoInstall(enabled);
      autoInstallWrites++;
      autoInstallCache = enabled;
      if (enabled) onAutoInstallEnabled();
      return { supported: true, enabled };
    });
    autoInstallQueue = run.catch(() => {}); // a failed save must not wedge later ones
    return run;
  }

  async function setBetaChannel(enabled: boolean): Promise<UpdateBetaChannelState> {
    await updateSettings.setBetaChannel(enabled);
    // WHY clear pending (design E3): what is waiting was picked for the OTHER channel. Leaving it
    // could install a beta after someone turned betas off, or hide a stable release behind it.
    await setPending(null);
    // WHY re-check immediately: the status cache holds one answer for 30 minutes,
    // and it was computed against the OTHER channel. Without this, turning the
    // channel on leaves "you're up to date" on screen for up to half an hour —
    // which reads as the toggle having done nothing.
    lastReleaseCheck = 0;
    await fetchLatestRelease();
    return betaChannelState();
  }

  /** The popup's "Update now". Awaits the SAME promise a background run uses: no second job, no `busy`. */
  function download(): Promise<UpdateDownloadResult> {
    return ensureDownloaded('popup');
  }

  function cancel(jobId: string) {
    // WHY suppress (design §2): a person who cancelled does not want the next check to start it again
    // behind their back. The next successful release check lifts it.
    suppressed = true;
    installer.cancelDownload(jobId);
    return { success: true };
  }

  async function launch(payload: { jobId: string; filePath: string }) {
    // WHY acquire before the first await: verification itself can overlap across windows.
    if (launchActive) return { success: false as const, error: 'busy' as const };
    launchActive = true;
    try {
      const result = await launchVerified(payload);
      if (!(result.success ? result.quitPending : result.error === 'install-timeout')) launchActive = false;
      return result;
    } catch (error) {
      launchActive = false;
      throw error;
    }
  }

  async function launchVerified(payload: { jobId: string; filePath: string }) {
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
      scheduleQuit();
    }
    return result;
  }

  // ===========================================================================
  // #183 T2 — one download owner, staging, status (design §2, §3, rev 4)
  // ===========================================================================

  /** What waits for a restart. Only these five fields (+ the staged NAME) are ever stored or read
   *  back; the file's path is always rebuilt from cacheDir + assetName (design E10). */
  interface Pending {
    version: string; tag: string; manifestUrl: string; signatureUrl: string; assetName: string;
    /** Name (never a path) of the staged copy: a hidden AppImage beside the running one, or a Mac app. */
    stagedName?: string;
  }
  const pendingJsonPath = path.join(updateCacheDir, 'pending.json');
  const FIRST_BACKGROUND_DELAY_MS = 60_000; // design D19: never compete with startup and session restore
  let pending: Pending | null = null;
  /** The pending file existed the last time we looked (set async; the status getter never touches disk). */
  let pendingFileOk = false;
  let facts: InstallFacts | null = null;
  let inFlight: Promise<UpdateDownloadResult> | null = null;
  let suppressed = false;          // Cancel: no background downloads until the next successful check
  let backgroundArmed = false;     // false until 60 s after the first window is ready
  let armTimer: ReturnType<typeof setTimeout> | null = null;
  let sweptOnce = false;
  let brakedTag: string | null = null; // an unsigned/forged release is not retried until the next check
  const statusListeners = new Set<() => void>();

  /** ipc-handlers subscribes so the status bar learns the moment `pending` changes (design E13), not on the next 10 s tick. */
  function onStatusChange(listener: () => void): () => void {
    statusListeners.add(listener);
    return () => { statusListeners.delete(listener); };
  }
  function notifyStatusChanged() {
    for (const l of statusListeners) { try { l(); } catch { /* a listener must not break the update path */ } }
  }

  function withInstallFields(status: UpdateStatus): UpdateStatus {
    return {
      ...status,
      // WHY existence is a cached boolean: the getter runs on every status poll and must never touch disk.
      downloaded: !!pending && pendingFileOk && pending.version === status.latest,
      needs_password: !!facts?.needsPassword,
      install_refused: !!facts?.installRefused,
    };
  }

  function pendingFilePath(p: Pending): string { return path.join(updateCacheDir, p.assetName); }

  /** Where this machine's staged copies live; also the context the path builder needs. */
  function stagingContext(): StagedPathContext {
    return {
      platform: process.platform,
      runningAppImage: process.env.APPIMAGE,
      runningBundle: process.platform === 'darwin' ? macBundleOf(process.execPath) : undefined,
      tmpDir: os.tmpdir(),
    };
  }
  function stagedPathOf(p: Pending): string | null {
    return p.stagedName ? stagedPathFor(p.stagedName, stagingContext()) : null;
  }

  function validAssetName(name: unknown): name is string {
    if (typeof name !== 'string' || name.includes('..') || !/^[A-Za-z0-9._+-]+$/.test(name)) return false;
    try { return deriveDownloadFilename(`https://github.com/itsdestin/youcoded/releases/download/x/${name}`, process.platform) === name; }
    catch { return false; }
  }
  /** Rebuild a Pending from untrusted JSON, keeping ONLY the known fields (a `filePath` in the file is dropped). */
  function readPendingJson(raw: unknown): Pending | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);
    const version = str(r.version), tag = str(r.tag), manifestUrl = str(r.manifestUrl), signatureUrl = str(r.signatureUrl);
    if (!version || !/^[0-9A-Za-z.+-]+$/.test(version) || !tag) return null;
    if (!manifestUrl || !signatureUrl || !isAllowedUpdateHost(manifestUrl) || !isAllowedUpdateHost(signatureUrl)) return null;
    if (!validAssetName(r.assetName)) return null;
    const out: Pending = { version, tag, manifestUrl, signatureUrl, assetName: r.assetName };
    if (r.stagedName !== undefined) {
      if (!isValidStagedName(r.stagedName)) return null;
      out.stagedName = r.stagedName;
    }
    return out;
  }

  async function fileExists(p: string): Promise<boolean> {
    // file (installer, AppImage) or folder (a staged Mac app is a bundle directory)
    try { const st = await fs.promises.stat(p); return st.isFile() || st.isDirectory(); } catch { return false; }
  }

  /** Record (or clear) what is waiting: memory, pending.json, and a status push. */
  async function setPending(next: Pending | null): Promise<void> {
    const prev = pending;
    pending = next;
    pendingFileOk = !!next;
    try {
      if (next) {
        await fs.promises.mkdir(updateCacheDir, { recursive: true });
        // tmp + rename so a crash mid-write never leaves a half file that parses as a different update
        // (per-process temp name: the dev instance and the installed app share this folder's parent)
        const tmp = `${pendingJsonPath}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify(next));
        await fs.promises.rename(tmp, pendingJsonPath);
      } else {
        await fs.promises.rm(pendingJsonPath, { force: true });
      }
    } catch (e) {
      console.warn('[update] could not save pending.json:', e);
    }
    if (JSON.stringify(prev) !== JSON.stringify(next)) notifyStatusChanged();
  }

  /** Startup: read pending.json back, trusting nothing in it beyond the validated names. */
  async function loadPending(): Promise<void> {
    let raw: unknown;
    try { raw = JSON.parse(await fs.promises.readFile(pendingJsonPath, 'utf8')); } catch { return; }
    const p = readPendingJson(raw);
    if (!p || compareVersions(p.version, app.getVersion()) <= 0) return; // already installed, or garbage
    if (!(await fileExists(pendingFilePath(p)))) return;
    if (p.stagedName) {
      const staged = stagedPathOf(p);
      if (!staged || !(await fileExists(staged))) return; // staging lost: the next run re-verifies and re-stages the file
    }
    pending = p;
    pendingFileOk = true;
    notifyStatusChanged();
  }

  /** After a check: is what we hold still there, and still ahead of the running version? */
  async function revalidatePending(): Promise<void> {
    if (!pending) return;
    const stillNewer = compareVersions(pending.version, app.getVersion()) > 0;
    const ok = stillNewer && await fileExists(pendingFilePath(pending));
    if (!ok) { await setPending(null); return; }
    if (!pendingFileOk) { pendingFileOk = true; notifyStatusChanged(); }
  }

  let initDone: Promise<void> = Promise.resolve();
  function startInit(): void {
    initDone = (async () => {
      try { await primeLinuxInstallKind(); } catch { /* falls back to 'unknown' */ }
      try {
        facts = await computeInstallFacts({
          platform: process.platform, isPackaged: app.isPackaged, execPath: process.execPath, env: process.env,
          linuxKind: linuxInstallKind(),
          canWrite: (p) => fs.promises.access(p, fs.constants.W_OK).then(() => true, () => false),
          // A real create-and-remove beside the AppImage (design E9): permission bits lie on some mounts.
          probeFolderWritable: async (dir) => {
            const probe = path.join(dir, `.youcoded-write-probe-${process.pid}`);
            try { await fs.promises.writeFile(probe, ''); await fs.promises.rm(probe, { force: true }); return true; } catch { return false; }
          },
        });
      } catch (e) { console.warn('[update] could not work out install facts:', e); }
      await loadPending().catch(() => {});
      notifyStatusChanged(); // `needs_password` / `install_refused` just became known
    })();
  }

  // ---- Download: the one owner ----

  function latestTarget() {
    const status = cachedUpdateStatus;
    if (!status || !status.update_available || !status.download_url) {
      throw new UpdateInstallError('url-rejected', 'no download URL available');
    }
    return { version: status.latest, tag: status.tag, manifestUrl: status.manifest_url, signatureUrl: status.signature_url, url: status.download_url };
  }

  /** Dev-only: the bundled dummy installer, standing in for a real download (never verified or staged). */
  async function fakeDownload(): Promise<UpdateDownloadResult> {
    // Copy the bundled dummy installer into the cache dir so the launch path
    // exercises the same file-move logic it would hit in prod. Emits one
    // progress event so the renderer sees the full arc.
    const ext = process.platform === 'win32' ? '.exe'
             : process.platform === 'darwin' ? '.dmg'
             : '.AppImage';
    // app.getAppPath() resolves to the desktop/ root (where package.json lives),
    // which is where dev-assets/ sits. More robust than __dirname across dev
    // build variations (tsc watch vs esbuild output).
    const srcPath = path.join(app.getAppPath(), 'dev-assets', `fake-installer${ext}`);
    await fs.promises.mkdir(updateCacheDir, { recursive: true });
    const assetName = `YouCoded-fake-dev${ext}`;
    const dstPath = path.join(updateCacheDir, assetName);
    await fs.promises.copyFile(srcPath, dstPath);
    const bytesTotal = (await fs.promises.stat(dstPath)).size;
    const jobId = `dev-${Date.now()}`;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('update:progress', { jobId, bytesReceived: bytesTotal, bytesTotal, percent: 100 });
    }
    // In memory only: it has no signed file, so it must never be written where a real start would read it back.
    pending = { version: getUpdateStatus().latest, tag: `v${getUpdateStatus().latest}`, manifestUrl: '', signatureUrl: '', assetName };
    pendingFileOk = true;
    notifyStatusChanged();
    return { jobId, filePath: dstPath, bytesTotal };
  }

  /** Stage a freshly verified file for the exit step. Never throws: a copy that cannot be staged is
   *  still a verified download, and Restart falls back to the interactive installer (design §4). */
  async function stageVerified(filePath: string, version: string, sha256: string | undefined): Promise<string | undefined> {
    try {
      if (facts?.installRefused) return undefined;
      if (process.platform === 'linux' && process.env.APPIMAGE && filePath.endsWith('.AppImage') && sha256) {
        return await stageAppImage({ filePath, runningAppImage: process.env.APPIMAGE, version, expectedSha256: sha256, hashFile: hashFileSha256 });
      }
      if (process.platform === 'darwin' && filePath.endsWith('.dmg')) {
        return await stageMacApp({ dmgPath: filePath, version, runningBundle: macBundleOf(process.execPath), needsPassword: !!facts?.needsPassword, run: runCommand });
      }
    } catch (e) {
      console.warn('[update] could not stage the verified update:', e);
    }
    return undefined;
  }

  /** Make the new release the pending one. The OLDER file goes only now — after the newer verified (design D13). */
  async function adopt(next: Pending): Promise<void> {
    const old = pending;
    await setPending(next);
    if (old && old.assetName !== next.assetName) await fs.promises.rm(pendingFilePath(old), { force: true }).catch(() => {});
    if (old?.stagedName && old.stagedName !== next.stagedName) await removeStagedByName(old.stagedName, stagingContext()).catch(() => {});
  }

  async function downloadAndVerify(): Promise<UpdateDownloadResult> {
    await initDone;
    if (devFakeUpdate) return fakeDownload();
    // WHY (design D26): an unpackaged build has nothing it could install, and a developer's checkout
    // must not pull 150 MB because it is older than the latest release.
    if (!app.isPackaged) throw new UpdateInstallError('unsupported-platform', 'updates are not downloaded by an unpackaged build');
    const target = latestTarget();
    if (!target.tag || !target.manifestUrl || !target.signatureUrl) {
      brakedTag = target.tag ?? target.version;
      throw new UpdateInstallError('signature-invalid', 'this release has no signed file'); // the brake: not retried until the next check
    }
    const base = { version: target.version, tag: target.tag, manifestUrl: target.manifestUrl, signatureUrl: target.signatureUrl };

    // (1) Already have it, verified and staged.
    if (pending && pendingFileOk && pending.version === target.version && pending.tag === target.tag) {
      const filePath = pendingFilePath(pending);
      if (await fileExists(filePath)) {
        return { jobId: 'cached', filePath, bytesTotal: (await fs.promises.stat(filePath)).size };
      }
    }

    // (2) A file for this version is already on disk — verify it rather than download it again.
    let filePath: string | null = null;
    const cached = await findCachedDownload(updateCacheDir, target.version, process.platform);
    let jobId = 'cached';
    let verified: Awaited<ReturnType<typeof verifyAgainstRelease>> | null = null;
    if (cached) {
      const res = await verifyAgainstRelease(cached.filePath, target);
      if (res.code === null) { filePath = cached.filePath; verified = res; }
      else if (res.transient) throw new UpdateInstallError('verify-failed', 'could not fetch the signed release file'); // keep the file; retry at the next check
      else await fs.promises.rm(cached.filePath, { force: true }).catch(() => {});
    }

    // (3) Download it, then (4) verify against THIS release's own signed file.
    if (!filePath) {
      const dl = await installer.startDownload(target.url);
      jobId = dl.jobId;
      const res = await verifyAgainstRelease(dl.filePath, target);
      if (res.code !== null) {
        // WHY delete (design §2): a file that fails its check is never kept for a later install.
        // A failure to FETCH the signed file says nothing about the download, so that one is kept.
        if (!res.transient) await fs.promises.rm(dl.filePath, { force: true }).catch(() => {});
        if (res.code === 'signature-invalid') brakedTag = target.tag;
        throw new UpdateInstallError(res.code);
      }
      filePath = dl.filePath;
      verified = res;
    }

    // (5) Stage right after verify, record, tell the windows.
    const assetName = path.basename(filePath);
    const stagedName = await stageVerified(filePath, target.version, verified?.sha256);
    await adopt({ ...base, assetName, ...(stagedName ? { stagedName } : {}) });
    return { jobId, filePath, bytesTotal: (await fs.promises.stat(filePath)).size };
  }

  /** The service's one download function. A second caller (popup, switch-on, next check) gets the
   *  SAME promise: one job, never `busy`. */
  function ensureDownloaded(_reason: 'popup' | 'background' | 'switch-on'): Promise<UpdateDownloadResult> {
    if (inFlight) return inFlight;
    const run = downloadAndVerify();
    inFlight = run;
    const clear = () => { if (inFlight === run) inFlight = null; };
    run.then(clear, clear);
    return run;
  }

  /** The background trigger: after each successful check, on switch-on. Resolves quietly when the rules say no. */
  async function runBackground(reason: 'check' | 'switch-on'): Promise<void> {
    try {
      await initDone;
      if (!autoInstallEnabled()) return;                       // switch off => nothing downloads
      if (!devFakeUpdate && !app.isPackaged) return;           // design D26
      if (reason !== 'switch-on' && (!backgroundArmed || suppressed)) return;
      if (facts?.noBackgroundDownload) return;                 // read-only AppImage folder: nowhere to stage
      const status = devFakeUpdate ? getUpdateStatus() : cachedUpdateStatus;
      if (!status?.update_available) return;
      if (pending && pendingFileOk && pending.version === status.latest) return;
      if (!devFakeUpdate && brakedTag && brakedTag === status.tag) return;
      if (reason === 'switch-on') suppressed = false;
      await ensureDownloaded('background');
    } catch (e) {
      console.warn('[update] background download did not finish:', e instanceof Error ? e.message : e);
    }
  }

  /** The first window is up: start the 60 s clock for the first background run. */
  function onFirstWindowReady(): void {
    if (armTimer || backgroundArmed) return;
    armTimer = setTimeout(() => { backgroundArmed = true; armTimer = null; void runBackground('check'); }, FIRST_BACKGROUND_DELAY_MS);
    armTimer.unref?.();
  }

  /** Everything that follows a SUCCESSFUL release check. */
  async function onCheckSucceeded(): Promise<void> {
    suppressed = false;       // a Cancel lasts until the next check
    brakedTag = null;         // so does "this release has no signed file"
    await refreshAutoInstall(); // the dev instance and the installed app share config.json
    await initDone;
    await revalidatePending();
    if (!sweptOnce) {
      sweptOnce = true;
      // WHY after the first check and not at startup (design D15): only now do we know which file is
      // "the latest", and the pending one is loaded. Neither is ever swept.
      const keep = new Set<string>(RESERVED_CACHE_FILES);
      if (pending) { keep.add(pending.assetName); }
      try { if (cachedUpdateStatus?.download_url) keep.add(deriveDownloadFilename(cachedUpdateStatus.download_url, process.platform)); } catch { /* not an installer url */ }
      await cleanupStaleDownloads(updateCacheDir, keep).catch(() => {});
      await sweepStaging(stagingContext(), new Set(pending?.stagedName ? [pending.stagedName] : [])).catch(() => {});
    }
    await runBackground('check');
  }

  /** Popup open: a finished file, a job still running, or nothing. */
  async function getCachedDownload(version: string): Promise<UpdateCachedDownloadResult | null> {
    if (inFlight) {
      const progress = installer.getActiveProgress?.();
      return { downloading: { percent: progress?.percent ?? -1, jobId: progress?.jobId ?? null } };
    }
    await initDone;
    if (pending && pendingFileOk && pending.version === version) {
      const filePath = pendingFilePath(pending);
      if (await fileExists(filePath)) return { filePath, version };
    }
    return findCachedDownload(updateCacheDir, version, process.platform);
  }

  startInit();

  return { getUpdateStatus, fetchLatestRelease, betaChannelState, setBetaChannel, getAutoInstall, setAutoInstall, loadAutoInstall, refreshAutoInstall, autoInstallEnabled, download, ensureDownloaded, cancel, launch, getCachedDownload, onFirstWindowReady, onStatusChange, fetchUrlToBuffer, afterCheckDone: () => afterCheck };
}

export type UpdateService = ReturnType<typeof createUpdateService>;
let service: UpdateService | null = null;
/** The one update service, built on first use. */
export function getUpdateService(): UpdateService {
  if (!service) service = createUpdateService();
  return service;
}
