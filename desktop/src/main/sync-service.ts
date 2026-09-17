/**
 * sync-service.ts — Native sync engine for YouCoded.
 *
 * Ports the YouCoded toolkit's sync orchestration from bash (sync.sh,
 * session-start.sh, session-end-sync.sh, backup-common.sh) into a Node.js
 * service running in the Electron main process.
 *
 * The service now owns a NARROW slice of the sync lifecycle: dated daily
 * snapshot backups (Drive/iCloud) plus conversation-index read/write and the
 * sync health check. The legacy PULL path (auto-restore, recent-50, manual
 * "Download now"), the timed/session-end/index-debounce PUSH loops, the slug
 * symlink aggregation, and the GitHub backup target were demolished — those
 * responsibilities moved to the sync-spaces engine and the dated snapshot
 * writers. See docs/superpowers/plans (sync-legacy-demolition).
 *
 * Actual rclone/rsync commands still shell out via child_process.execFile.
 * The bash hooks detect .app-sync-active and skip when the app is running.
 *
 * Design ref: sync-engine-integration plan (Phase 2)
 */

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import {
  type BackendInstance,
  type SyncWarning,
  addOrReplaceWarning,
  clearWarningsByBackend,
  migrateConfigToV2,
  readWarnings,
  syncLegacyKeys,
  wasDismissedThisRun,
  writeWarnings,
} from './sync-state';
import { classifyPushError, extractStderr, truncateStderr } from './sync-error-classifier';
// Why: dated daily snapshots reuse the SAME once-per-UTC-day gate helpers as the
// spaces daily-backup (single source of truth) plus the pure tiered-retention core.
import { datedFolderName, isBackupDue } from './sync-spaces/daily-backup';
import { snapshotsToDelete, shouldStampDailyMarker } from './snapshot-retention';

const execFileAsync = promisify(execFile);

// --- Types ---

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface PushResult {
  success: boolean;
  errors: number;
  backends: string[];  // IDs of backends that were pushed to
}

// Once-per-UTC-day gate for the dated ~/.claude snapshot, computed ONCE per
// push() cycle and shared by pushDrive + pushiCloud so both write into the SAME
// dated folder on a given day and the daily stamp isn't double-consumed.
interface SnapshotGate {
  due: boolean;   // is a new snapshot due today? (marker != today)
  dated: string;  // YYYY-MM-DD folder name for today's snapshot
  now: Date;      // the instant push() computed the gate (used for age-based pruning)
}

// (Plan 2c) The conversation-index typed shapes — SessionFlagState,
// ConversationIndexEntry, ConversationIndex — were deleted along with the index
// read/write helpers. The frozen conversation-index.json is now copied as an
// opaque file into snapshots (see pushDrive/pushiCloud); nothing in SyncService
// parses its structure anymore. session-browser.ts owns the residual typed read.

// --- Constants ---

const PUSH_DEBOUNCE_MIN = 15;
// 10 min — generous because individual conversation slugs can grow to
// hundreds of MB (one user has a 25 MB single .jsonl in a 156 MB slug).
// The previous 60s value silently killed rclone mid-upload on big slugs,
// producing empty stderr that fell through to UNKNOWN classification.
const RCLONE_TIMEOUT = 10 * 60 * 1000;
// Daily-snapshot poll cadence. This is NOT the deleted 15-min aggressive
// flat-overwrite loop — it's an hourly heartbeat (mirrors DailyBackup's hourly
// runIfDue). Each tick calls push() NON-force, so the 15-min .sync-marker
// debounce throttles redundant runs and the once-per-UTC-day snapshot stamp
// gates the actual dated copy: net effect is at most ONE dated ~/.claude
// snapshot per day, produced automatically.
const SNAPSHOT_POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
// Health-check cadence. The health-check-owned warnings (OFFLINE,
// PERSONAL_NOT_CONFIGURED, PERSONAL_STALE) describe conditions that change
// while the app is open — the WiFi comes back, the user finishes sync setup —
// so re-evaluating only at launch pinned a red "No internet" banner over an
// "All synced · 1m ago" panel for the rest of the session. Re-running is cheap
// once the rclone probe is excluded (see runHealthCheck's probeBackends), and
// the warnings file is only rewritten when the set actually changes.
// WHY 5 minutes, gated (2026-09-16 audit W12): at one minute it was a DNS lookup
// of github.com plus a config re-read 1,440 times a day, with the window hidden
// and with sync switched off, and its only reader is the status push. The tick
// now runs only while a window is visible or a phone is connected (main.ts
// hands in the gate) and only when some sync is configured. Accepted cost: the
// "No internet" banner clears within 5 min instead of 1, and — with the
// two-strike rule kept — appears up to 10 min after the network goes away.
const HEALTH_POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Do two warning lists say the same thing? Used to skip the write when a
 * health re-check found nothing new.
 *
 * `createdEpoch` is deliberately excluded: it is stamped fresh on every run, so
 * including it would make every poll look like a change. Excluding it also
 * gives the field a better meaning — with the write skipped, an unchanged
 * warning keeps the epoch from when the condition was FIRST seen rather than
 * from the last poll that re-observed it.
 */
function sameWarnings(a: SyncWarning[], b: SyncWarning[]): boolean {
  if (a.length !== b.length) return false;
  const key = (w: SyncWarning) => JSON.stringify([
    w.code, w.level, w.backendId ?? null, w.title, w.body,
    w.fixAction ?? null, w.dismissible, w.stderr ?? null,
  ]);
  return a.every((w, i) => key(w) === key(b[i]));
}

// --- SyncService ---

export class SyncService extends EventEmitter {
  private claudeDir: string;
  private configPath: string;
  private localConfigPath: string;
  private syncMarkerPath: string;
  // Why: separate once-per-UTC-day stamp for the dated ~/.claude snapshot copy —
  // distinct from the 15-min .sync-marker debounce so the snapshot runs at most
  // once per day even though the daily-snapshot poll calls push() hourly.
  private snapshotMarkerPath: string;
  private lockDir: string;
  private backupLogPath: string;
  private appSyncMarkerPath: string;
  private syncSpacesStatePath: string;
  private conversationIndexPath: string;
  private pushing = false;
  // Hourly daily-snapshot poll (see SNAPSHOT_POLL_INTERVAL_MS). Cleared in stop().
  private snapshotTimer: NodeJS.Timeout | null = null;
  // Per-minute health re-check (see HEALTH_POLL_INTERVAL_MS). Cleared in stop().
  private healthTimer: NodeJS.Timeout | null = null;
  // Consecutive failed reachability probes — the OFFLINE warning needs two.
  // See the comment at its use site in runHealthCheck.
  private failedInternetProbes = 0;
  // "Is anyone looking?" — see HEALTH_POLL_INTERVAL_MS. Defaults to yes so a
  // service nobody wired (tests, a future caller) behaves as before.
  private healthCheckGate: () => boolean = () => true;

  /** Main hands in "a window is visible or a phone is connected"; the periodic
   *  health check is skipped while it answers false. The launch-time check
   *  is unaffected. */
  setHealthCheckGate(gate: () => boolean): void {
    this.healthCheckGate = gate;
  }

  /** No sync of any kind configured — the periodic check then has nothing to
   *  report that the launch run did not already write. The transition to
   *  configured is caught because this is re-read on every tick (a file read,
   *  no DNS), so a mid-session setup still clears "No sync configured". */
  private isSyncConfigured(): boolean {
    return this.isPrimarySyncEnabled() || this.getSyncEnabledBackends().length > 0;
  }

  // `home` is a TEST-ONLY override. Production passes nothing and keeps the
  // os.homedir() behavior; tests pass a tmp dir so they never touch the real
  // ~/.claude (which a running YouCoded owns — see sync-state.ts's
  // setClaudeDirForTests for the full story).
  constructor(home: string = os.homedir()) {
    super();
    this.claudeDir = path.join(home, '.claude');
    this.configPath = path.join(this.claudeDir, 'toolkit-state', 'config.json');
    this.localConfigPath = path.join(this.claudeDir, 'toolkit-state', 'config.local.json');
    this.syncMarkerPath = path.join(this.claudeDir, 'toolkit-state', '.sync-marker');
    this.snapshotMarkerPath = path.join(this.claudeDir, 'toolkit-state', '.snapshot-marker');
    this.lockDir = path.join(this.claudeDir, 'toolkit-state', '.sync-lock');
    this.backupLogPath = path.join(this.claudeDir, 'backup.log');
    this.appSyncMarkerPath = path.join(this.claudeDir, 'toolkit-state', '.app-sync-active');
    // Owned by SpaceManager (sync-spaces/space-manager.ts) — read-only here.
    // Pinned to SpaceManager's default path by sync-health-primary-system.test.ts.
    this.syncSpacesStatePath = path.join(this.claudeDir, 'toolkit-state', 'sync-spaces.json');
    this.conversationIndexPath = path.join(this.claudeDir, 'conversation-index.json');
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /** Start the sync service: write the .app-sync-active marker, run the
   *  launch-time health check, and start the hourly daily-snapshot poll. The
   *  legacy initial PULL (auto-restore) and the aggressive 15-min flat-overwrite
   *  push loop were removed (sync-legacy-demolition); the daily-snapshot poll
   *  below is a lightweight replacement that produces at most one dated
   *  ~/.claude snapshot per UTC day. There is no auto-restore. */
  async start(): Promise<void> {
    // Self-heal: if a stale marker exists from a previous crash, log and overwrite.
    // Without this, a crash leaves the marker indefinitely and hooks never sync.
    try {
      if (this.fileExists(this.appSyncMarkerPath)) {
        const stalePid = parseInt(fs.readFileSync(this.appSyncMarkerPath, 'utf8').trim(), 10);
        if (stalePid > 0 && stalePid !== process.pid && !this.isPidAlive(stalePid)) {
          // Fix: log at INFO (was WARN). Mirrors Android — see app/.../SyncService.kt.
          // The SyncPanel log viewer renders WARN entries prominently, making this
          // benign self-heal look like a persistent error after any system kill.
          this.logBackup('INFO', `Cleaned stale .app-sync-active marker (PID ${stalePid} is dead — previous crash?)`, 'sync.lifecycle');
        }
      }
    } catch {}

    this.cleanupStaleBackendErrorFiles();

    // Write .app-sync-active marker so bash hooks skip sync
    try {
      fs.mkdirSync(path.dirname(this.appSyncMarkerPath), { recursive: true });
      fs.writeFileSync(this.appSyncMarkerPath, String(process.pid));
    } catch {}

    this.logBackup('INFO', 'SyncService started', 'sync.lifecycle');

    // Re-home: runHealthCheck used to run at the end of the now-deleted pull()
    // orchestrator. It still generates the .sync-warnings the UI reads (OFFLINE /
    // no-backend / stale), so we run it once at launch instead. Best-effort —
    // never crash startup on a health-check failure. This is the ONE run that
    // probes for a legacy backend (the rclone shell-out, ~35s on the Z13); the
    // timer below re-checks everything else without it.
    try {
      await this.runHealthCheck();
    } catch (e) {
      this.logBackup('ERROR', `Startup health check failed: ${e}`, 'sync.health');
    }

    // Fix: these warnings used to be computed once and then outlive their own
    // cause for the whole app run — a launch that lost the DNS race with the
    // WiFi coming up left "No internet" pinned above a panel reading
    // "All synced · 1m ago". Re-check periodically so a fixed condition clears
    // itself. Cheap by construction: no backend probe, no write unless the
    // warning set changed — and skipped entirely while nobody can see the
    // result or nothing is configured (HEALTH_POLL_INTERVAL_MS).
    this.healthTimer = setInterval(() => {
      if (!this.healthCheckGate()) return;
      if (!this.isSyncConfigured()) return;
      this.runHealthCheck({ probeBackends: false }).catch(e => {
        this.logBackup('ERROR', `Periodic health check failed: ${e}`, 'sync.health');
      });
    }, HEALTH_POLL_INTERVAL_MS);

    // Daily-snapshot poll. Non-force push() on launch (in case today's snapshot
    // isn't done yet) plus an hourly tick. NON-force so the 15-min debounce +
    // once-per-day snapshot stamp collapse this to at most one dated ~/.claude
    // snapshot per UTC day — this restores the automatic personal backup the
    // deleted 15-min timer used to provide, without its per-cycle re-copy cost.
    this.push().catch(e => {
      this.logBackup('ERROR', `Launch snapshot push failed: ${e}`, 'sync.push');
    });
    this.snapshotTimer = setInterval(() => {
      this.push().catch(e => {
        this.logBackup('ERROR', `Daily-snapshot push failed: ${e}`, 'sync.push');
      });
    }, SNAPSHOT_POLL_INTERVAL_MS);
  }

  /** Stop the sync service: clear the daily-snapshot poll, release locks,
   *  remove marker. */
  stop(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }

    // Release lock if held
    this.releaseLock();

    // Remove .app-sync-active marker so hooks resume normal operation
    try { fs.unlinkSync(this.appSyncMarkerPath); } catch {}

    this.logBackup('INFO', 'SyncService stopped', 'sync.lifecycle');
  }

  // =========================================================================
  // Config Reading
  // =========================================================================

  /** Read a config key, checking local config first (machine-specific), then portable. */
  private configGet(key: string, defaultValue = ''): string {
    // Local config takes precedence (machine-specific, never synced)
    for (const cfgPath of [this.localConfigPath, this.configPath]) {
      try {
        const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        if (config[key] !== undefined && config[key] !== null) {
          return String(config[key]);
        }
      } catch {}
    }
    return defaultValue;
  }

  /**
   * Read all backend instances from config. Auto-migrates from flat keys
   * on first read if storage_backends array is missing.
   */
  private getBackendInstances(): BackendInstance[] {
    const config = this.readJson(this.configPath) || {};
    if (config.storage_backends && Array.isArray(config.storage_backends)) {
      return config.storage_backends;
    }
    // Auto-migrate from flat keys
    const migrated = migrateConfigToV2(config);
    config.storage_backends = migrated;
    syncLegacyKeys(config);
    this.atomicWrite(this.configPath, JSON.stringify(config, null, 2));
    return migrated;
  }

  /** Get only backends with syncEnabled=true (for the automatic push loop). */
  private getSyncEnabledBackends(): BackendInstance[] {
    return this.getBackendInstances().filter(b => b.syncEnabled);
  }

  /** Find a single backend by id (for manual push/pull). */
  // Kept public (used internally by push()'s per-backend "Upload now" path); the
  // former RestoreService caller was removed in sync-legacy-demolition.
  public getBackendById(id: string): BackendInstance | null {
    return this.getBackendInstances().find(b => b.id === id) || null;
  }

  /** Per-backend sync marker path for tracking individual push times. */
  private perBackendMarkerPath(backendId: string): string {
    return path.join(this.claudeDir, 'toolkit-state', `.sync-marker-${backendId}`);
  }

  /**
   * Record a push-cycle failure for a backend: classify stderr and write a
   * SyncWarning (one per backend per cycle — de-duped by addOrReplaceWarning).
   * Also logs the classified code to backup.log for future diagnosis.
   *
   * `op` distinguishes push vs pull failures in the log; both share the same
   * warning shape because the underlying problem (auth, network, missing
   * config) is symmetric — fixing it unblocks both directions.
   */
  private async recordBackendFailure(
    instance: BackendInstance,
    stderr: string,
    op: 'push' | 'pull' = 'push',
  ): Promise<void> {
    const warning = classifyPushError(stderr, instance.type, instance);
    await addOrReplaceWarning(warning);
    this.logBackup(
      warning.level === 'danger' ? 'WARN' : 'INFO',
      `${instance.id} classified as ${warning.code}`,
      `sync.${op}.classify`,
      { code: warning.code, stderr: truncateStderr(stderr) },
    );
  }

  /** Clear all push-failure warnings for a backend (call on successful push). */
  private async clearBackendFailures(backendId: string): Promise<void> {
    await clearWarningsByBackend(backendId);
  }

  /**
   * Delete leftover .sync-error-* files from the pre-warnings-refactor era.
   * The typed .sync-warnings.json replaces them; old files would confuse
   * anyone debugging and serve no purpose. Called from start() — extracted
   * to its own method so tests can exercise just this migration without
   * spinning up the whole sync service.
   */
  cleanupStaleBackendErrorFiles(): void {
    try {
      const toolkitStateDir = path.join(this.claudeDir, 'toolkit-state');
      const entries = fs.readdirSync(toolkitStateDir);
      for (const name of entries) {
        if (name.startsWith('.sync-error-')) {
          try { fs.unlinkSync(path.join(toolkitStateDir, name)); } catch {}
        }
      }
    } catch {}
  }

  // =========================================================================
  // Toolkit Ownership Detection
  // =========================================================================

  /** Check if a file is owned by the toolkit (symlinked into TOOLKIT_ROOT). */
  private isToolkitOwned(filePath: string): boolean {
    const toolkitRoot = this.configGet('toolkit_root', '');
    if (!toolkitRoot) return false;

    let resolved: string;
    try {
      resolved = fs.realpathSync(toolkitRoot);
    } catch {
      return false;
    }

    // Walk up directory tree checking for symlinks
    let current = path.resolve(filePath);
    for (let i = 0; i < 10; i++) {
      try {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) {
          const target = fs.realpathSync(current);
          if (target.startsWith(resolved + path.sep) || target === resolved) {
            return true;
          }
        }
      } catch {
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) break; // Reached root
      current = parent;
    }
    return false;
  }

  // =========================================================================
  // Mutex (mkdir-based, portable)
  // =========================================================================

  /** Acquire sync lock. Returns true if acquired, false if another sync is running. */
  private acquireLock(): boolean {
    try {
      fs.mkdirSync(this.lockDir, { recursive: false });
    } catch (e: any) {
      if (e.code !== 'EEXIST') return false;

      // Lock exists — check if holder PID is alive
      const pidFile = path.join(this.lockDir, 'pid');
      let pid = 0;
      try { pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10); } catch {}

      if (pid > 0 && this.isPidAlive(pid)) {
        return false; // Another sync is genuinely running
      }

      // Stale lock — clean up and retry
      try {
        fs.rmSync(this.lockDir, { recursive: true, force: true });
        fs.mkdirSync(this.lockDir, { recursive: false });
      } catch {
        return false;
      }
    }

    // Write our PID
    try {
      fs.writeFileSync(path.join(this.lockDir, 'pid'), String(process.pid));
    } catch {}
    return true;
  }

  /** Release sync lock. */
  private releaseLock(): void {
    try {
      fs.rmSync(this.lockDir, { recursive: true, force: true });
    } catch {}
  }

  /** Check if a PID is alive (cross-platform). */
  private isPidAlive(pid: number): boolean {
    try {
      if (process.platform === 'win32') {
        // tasklist with PID filter — output contains process info if alive
        const result = execFileSync('tasklist', ['/FI', `PID eq ${pid}`], { encoding: 'utf8', timeout: 5000 });
        return !result.includes('No tasks');
      } else {
        process.kill(pid, 0); // Signal 0 = test if process exists
        return true;
      }
    } catch {
      return false;
    }
  }

  // =========================================================================
  // Debounce
  // =========================================================================

  /** Check if enough time has elapsed since last marker write. */
  private debounceCheck(markerFile: string, intervalMinutes: number): boolean {
    try {
      const raw = fs.readFileSync(markerFile, 'utf8').trim();
      const lastEpoch = parseInt(raw, 10);
      if (isNaN(lastEpoch)) return true;
      const nowEpoch = Math.floor(Date.now() / 1000);
      return (nowEpoch - lastEpoch) >= intervalMinutes * 60;
    } catch {
      return true; // No marker = first run, proceed
    }
  }

  /** Write current epoch to debounce marker. */
  private debounceTouch(markerFile: string): void {
    const epoch = String(Math.floor(Date.now() / 1000));
    this.atomicWrite(markerFile, epoch);
  }

  // =========================================================================
  // Shell-out Wrappers
  // =========================================================================

  /** Execute rclone with args. */
  private async rclone(args: string[]): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execFileAsync('rclone', args, { timeout: RCLONE_TIMEOUT });
      return { code: 0, stdout, stderr };
    } catch (e: any) {
      return { code: e.code || 1, stdout: e.stdout || '', stderr: extractStderr(e, RCLONE_TIMEOUT) };
    }
  }


  /** Copy with rsync (preferred) or fs.cpSync (fallback). */
  private async rsyncOrCp(src: string, dst: string, updateOnly = true): Promise<void> {
    // Try rsync first (not available on Windows typically)
    if (process.platform !== 'win32') {
      try {
        const args = ['-a'];
        if (updateOnly) args.push('--update');
        args.push(src.endsWith('/') ? src : src + '/', dst.endsWith('/') ? dst : dst + '/');
        await execFileAsync('rsync', args, { timeout: RCLONE_TIMEOUT });
        return;
      } catch {}
    }
    // Fallback to fs.cpSync
    fs.mkdirSync(dst, { recursive: true });
    fs.cpSync(src, dst, { recursive: true, force: !updateOnly });
  }

  // =========================================================================
  // Logging
  // =========================================================================

  /** Append a structured log entry to backup.log. */
  private logBackup(level: string, msg: string, op?: string, extra?: Record<string, any>): void {
    // Local time (matches sync.sh hook's `date '+%Y-%m-%d %H:%M:%S'` format)
    // so a single backup.log has consistent timestamps regardless of writer.
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const sessionId = (process.env.CLAUDE_SESSION_ID || '').slice(0, 8);

    if (op) {
      const entry: Record<string, any> = { ts, level, op, sid: sessionId, msg };
      if (extra) Object.assign(entry, extra);
      try {
        fs.appendFileSync(this.backupLogPath, JSON.stringify(entry) + '\n');
      } catch {}
    } else {
      try {
        fs.appendFileSync(this.backupLogPath, `[${ts}] [${level}] ${msg}\n`);
      } catch {}
    }
  }

  // =========================================================================
  // File Helpers
  // =========================================================================

  private readJson(filePath: string): any {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  /** Atomic write via same-directory temp file + rename.
   *  Retries on EPERM/EACCES (Windows file locking) before falling back
   *  to direct overwrite. Cleans up the temp file on all paths. */
  private atomicWrite(target: string, content: string): void {
    const tmp = `${target}.tmp.${process.pid}`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, content);

    // Retry rename up to 3 times — Windows file locks cause transient EPERM
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.renameSync(tmp, target);
        return; // Success
      } catch (e: any) {
        if (e.code !== 'EPERM' && e.code !== 'EACCES') {
          // Non-locking error — clean up and rethrow
          try { fs.unlinkSync(tmp); } catch {}
          throw e;
        }
        if (attempt < 2) {
          // Brief pause to let the other process release the handle
          const waitMs = 100 * (attempt + 1);
          const start = Date.now();
          while (Date.now() - start < waitMs) { /* busy-wait in sync context */ }
        }
      }
    }

    // All retries exhausted — fall back to direct overwrite (non-atomic but data-preserving)
    this.logBackup('WARN', `Atomic rename failed for ${path.basename(target)}, falling back to direct write`, 'sync.atomicWrite');
    try {
      fs.writeFileSync(target, content);
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  private dirExists(p: string): boolean {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  }

  private fileExists(p: string): boolean {
    try { fs.accessSync(p); return true; } catch { return false; }
  }

  // =========================================================================
  // Skill Route Check
  // =========================================================================

  /** Check if a skill should be synced (not routed to 'none'). */
  private shouldSyncSkill(skillName: string): boolean {
    const routesFile = path.join(this.claudeDir, 'toolkit-state', 'skill-routes.json');
    const routes = this.readJson(routesFile);
    if (!routes || !routes[skillName]) return true;
    return routes[skillName].route !== 'none';
  }

  // =========================================================================
  // Push: Drive Backend
  // =========================================================================

  // Accepts a BackendInstance so multiple Drive accounts can use different rclone remotes
  private async pushDrive(instance: BackendInstance, snapshot: SnapshotGate): Promise<number> {
    const rcloneRemote = instance.config.rcloneRemote || 'gdrive';
    const driveRoot = instance.config.DRIVE_ROOT || 'Claude';
    const backupRoot = `${rcloneRemote}:${driveRoot}/Backup`;
    // Why: dated-not-flat — the ~/.claude set is now snapshotted into a per-day
    // folder Backup/<YYYY-MM-DD>/... instead of overwriting one flat Backup/personal
    // tree, so history is retained and pruned by age (see snapshot-retention.ts).
    const remoteBase = `${backupRoot}/${snapshot.dated}/personal`;
    const sysRemote = `${remoteBase}/system-backup`;
    let errors = 0;
    let firstFailStderr = '';

    // Why: daily-stamp gating — the daily-snapshot poll calls push() hourly, but
    // the actual snapshot copy runs at most once per UTC day. After today's
    // snapshot is written we no-op (success) so we don't re-upload the whole set.
    if (!snapshot.due) {
      this.logBackup('INFO', 'Drive snapshot skipped — already done today', 'sync.push.drive');
      return 0;
    }

    // Memory files — per project key
    const projectsDir = path.join(this.claudeDir, 'projects');
    if (this.dirExists(projectsDir)) {
      for (const projectKey of fs.readdirSync(projectsDir)) {
        const memoryDir = path.join(projectsDir, projectKey, 'memory');
        if (!this.dirExists(memoryDir)) continue;
        const r = await this.rclone(['copy', memoryDir + '/', `${remoteBase}/memory/${projectKey}/`, '--update', '--skip-links']);
        if (r.code !== 0) {
          this.logBackup('WARN', `Drive push memory/${projectKey} failed`, 'sync.push.drive', { stderr: truncateStderr(r.stderr || '') });
          if (!firstFailStderr && r.stderr) firstFailStderr = r.stderr;
          errors++;
        }
      }
    }

    // CLAUDE.md
    const claudeMd = path.join(this.claudeDir, 'CLAUDE.md');
    if (this.fileExists(claudeMd)) {
      const r = await this.rclone(['copyto', claudeMd, `${remoteBase}/CLAUDE.md`, '--update']);
      if (r.code !== 0) {
        this.logBackup('WARN', 'Drive push CLAUDE.md failed', 'sync.push.drive', { stderr: truncateStderr(r.stderr || '') });
        if (!firstFailStderr && r.stderr) firstFailStderr = r.stderr;
        errors++;
      }
    }

    // Encyclopedia
    const encDir = path.join(this.claudeDir, 'encyclopedia');
    if (this.dirExists(encDir)) {
      await this.rclone(['copy', encDir + '/', `${remoteBase}/encyclopedia/`, '--update', '--max-depth', '1', '--include', '*.md']);
      // Also push to legacy encyclopedia path from config
      const encRemotePath = this.configGet('encyclopedia_remote_path', 'Encyclopedia/System');
      await this.rclone(['copy', encDir + '/', `${rcloneRemote}:${driveRoot}/${encRemotePath}/`, '--update', '--max-depth', '1', '--include', '*.md']);
    }

    // User-created skills
    const skillsDir = path.join(this.claudeDir, 'skills');
    if (this.dirExists(skillsDir)) {
      for (const skillName of fs.readdirSync(skillsDir)) {
        const skillDir = path.join(skillsDir, skillName);
        if (!this.dirExists(skillDir)) continue;
        // Skip toolkit-owned skills (symlinked from toolkit)
        if (this.isToolkitOwned(skillDir)) continue;
        if (!this.shouldSyncSkill(skillName)) continue;
        await this.rclone(['copy', skillDir + '/', `${remoteBase}/skills/${skillName}/`, '--update', '--exclude', '.DS_Store']);
      }
    }

    // Why: conversations-excluded-because-spaces-cover-them — the Conversation
    // Store + mirrored CC transcripts now ride the Personal SYNC SPACE, which the
    // spaces daily-backup (sync-spaces/daily-backup.ts) snapshots to Backup/spaces/
    // <date>/. Copying conversations here too would duplicate that data, so the
    // former per-slug conversation copy block was removed from the dated snapshot.

    // System config
    const sysFiles: [string, string][] = [
      [this.configPath, `${sysRemote}/config.json`],
      [path.join(this.claudeDir, 'settings.json'), `${sysRemote}/settings.json`],
      [path.join(this.claudeDir, 'keybindings.json'), `${sysRemote}/keybindings.json`],
      [path.join(this.claudeDir, 'mcp.json'), `${sysRemote}/mcp.json`],
      [path.join(this.claudeDir, 'history.jsonl'), `${sysRemote}/history.jsonl`],
    ];
    for (const [local, remote] of sysFiles) {
      if (this.fileExists(local)) {
        const r = await this.rclone(['copyto', local, remote, '--update']);
        if (r.code !== 0) {
          this.logBackup('WARN', `Drive push ${path.basename(local)} failed`, 'sync.push.drive', { stderr: truncateStderr(r.stderr || '') });
          if (!firstFailStderr && r.stderr) firstFailStderr = r.stderr;
          errors++;
        }
      }
    }
    // Plans and specs directories
    for (const dir of ['plans', 'specs']) {
      const localDir = path.join(this.claudeDir, dir);
      if (this.dirExists(localDir)) {
        await this.rclone(['copy', localDir + '/', `${sysRemote}/${dir}/`, '--update']);
      }
    }

    // Conversation index
    if (this.fileExists(this.conversationIndexPath)) {
      await this.rclone(['copyto', this.conversationIndexPath, `${sysRemote}/conversation-index.json`, '--checksum']);
    }

    // Why: tiered pruning of old dated snapshots. List the dated dirs under
    // Backup/, decide which to delete via the pure retention core, then purge
    // each by its EXACT dated path — NEVER a wildcard — so a bad name can't wipe
    // sibling data (unparseable names are never returned for deletion anyway).
    try {
      const lsf = await this.rclone(['lsf', '--dirs-only', `${backupRoot}/`]);
      if (lsf.code === 0) {
        const names = lsf.stdout.split('\n').map(s => s.replace(/\/$/, '').trim()).filter(Boolean);
        for (const name of snapshotsToDelete(names, snapshot.now)) {
          const r = await this.rclone(['purge', `${backupRoot}/${name}`]);
          if (r.code === 0) this.logBackup('INFO', `Drive snapshot pruned ${name}`, 'sync.push.drive');
        }
      }
    } catch { /* pruning is best-effort — never fail a snapshot over cleanup */ }

    if (errors > 0) {
      await this.recordBackendFailure(instance, firstFailStderr);
    } else {
      await this.clearBackendFailures(instance.id);
    }
    this.logBackup(errors > 0 ? 'WARN' : 'INFO', `Drive sync completed (${errors} error(s))`, 'sync.push.drive');
    return errors;
  }


  // =========================================================================
  // Push: iCloud Backend
  // =========================================================================

  // Accepts a BackendInstance for per-instance iCloud path support
  private async pushiCloud(instance: BackendInstance, snapshot: SnapshotGate): Promise<number> {
    const icloudPath = this.resolveICloudPath(instance);
    if (!icloudPath) {
      this.logBackup('ERROR', 'iCloud Drive folder not found', 'sync.push.icloud');
      return 1;
    }

    // Why: daily-stamp gating — same as Drive. The hourly daily-snapshot poll
    // calls us, but the snapshot copy runs at most once per UTC day; after
    // today's is written we no-op (success) rather than re-copying the whole set.
    if (!snapshot.due) {
      this.logBackup('INFO', 'iCloud snapshot skipped — already done today', 'sync.push.icloud');
      return 0;
    }

    // Why: dated-not-flat — snapshot into <YouCoded>/Backup/<YYYY-MM-DD>/... instead
    // of overwriting the files directly under the iCloud folder, so history is
    // retained and pruned by age below (mirrors the Drive layout).
    const datedRoot = path.join(icloudPath, 'Backup', snapshot.dated);
    fs.mkdirSync(datedRoot, { recursive: true });
    let errors = 0;
    let firstFailStderr = '';

    // Memory files
    const projectsDir = path.join(this.claudeDir, 'projects');
    if (this.dirExists(projectsDir)) {
      for (const projectKey of fs.readdirSync(projectsDir)) {
        const memoryDir = path.join(projectsDir, projectKey, 'memory');
        if (!this.dirExists(memoryDir)) continue;
        const dest = path.join(datedRoot, 'memory', projectKey);
        fs.mkdirSync(dest, { recursive: true });
        try {
          await this.rsyncOrCp(memoryDir, dest);
        } catch (e) {
          this.logBackup('WARN', `iCloud push memory/${projectKey} failed`, 'sync.push.icloud', { stderr: truncateStderr(String(e)) });
          if (!firstFailStderr) firstFailStderr = String(e);
          errors++;
        }
      }
    }

    // CLAUDE.md
    const claudeMd = path.join(this.claudeDir, 'CLAUDE.md');
    if (this.fileExists(claudeMd)) {
      try {
        fs.copyFileSync(claudeMd, path.join(datedRoot, 'CLAUDE.md'));
      } catch (e) {
        this.logBackup('WARN', 'iCloud push CLAUDE.md failed', 'sync.push.icloud', { stderr: truncateStderr(String(e)) });
        if (!firstFailStderr) firstFailStderr = String(e);
        errors++;
      }
    }

    // Encyclopedia
    const encDir = path.join(this.claudeDir, 'encyclopedia');
    if (this.dirExists(encDir)) {
      const dest = path.join(datedRoot, 'encyclopedia');
      fs.mkdirSync(dest, { recursive: true });
      try {
        await this.rsyncOrCp(encDir, dest);
      } catch (e) {
        this.logBackup('WARN', 'iCloud push encyclopedia failed', 'sync.push.icloud', { stderr: truncateStderr(String(e)) });
        if (!firstFailStderr) firstFailStderr = String(e);
        errors++;
      }
    }

    // Skills — aggregate errors across individual skills so one bad skill
    // doesn't spam per-skill WARN entries. The classifier only needs one
    // representative stderr to pick a code.
    const skillsDir = path.join(this.claudeDir, 'skills');
    if (this.dirExists(skillsDir)) {
      let skillsStderr = '';
      let skillsErrors = 0;
      for (const skillName of fs.readdirSync(skillsDir)) {
        const skillDir = path.join(skillsDir, skillName);
        if (!this.dirExists(skillDir) || this.isToolkitOwned(skillDir)) continue;
        if (!this.shouldSyncSkill(skillName)) continue;
        const dest = path.join(datedRoot, 'skills', skillName);
        fs.mkdirSync(dest, { recursive: true });
        try {
          await this.rsyncOrCp(skillDir, dest);
        } catch (e) {
          if (!skillsStderr) skillsStderr = String(e);
          skillsErrors++;
        }
      }
      if (skillsErrors > 0) {
        this.logBackup('WARN', `iCloud push skills failed (${skillsErrors} skill(s))`, 'sync.push.icloud', { stderr: truncateStderr(skillsStderr) });
        if (!firstFailStderr) firstFailStderr = skillsStderr;
        errors++;
      }
    }

    // Why: conversations-excluded-because-spaces-cover-them — the Conversation
    // Store + mirrored CC transcripts ride the Personal SYNC SPACE, which the
    // spaces daily-backup snapshots separately (Backup/spaces/<date>/). Copying
    // them here too would duplicate that data, so the former per-slug conversation
    // copy block was removed from the dated snapshot.

    // System config — aggregate sys-file and plans/specs/index errors into
    // one "system-config" warning since they share a fix path (disk/permission).
    const sysPath = path.join(datedRoot, 'system-backup');
    fs.mkdirSync(sysPath, { recursive: true });
    let sysStderr = '';
    let sysErrors = 0;
    for (const [src, name] of [
      [this.configPath, 'config.json'],
      [path.join(this.claudeDir, 'settings.json'), 'settings.json'],
      [path.join(this.claudeDir, 'keybindings.json'), 'keybindings.json'],
      [path.join(this.claudeDir, 'mcp.json'), 'mcp.json'],
      [path.join(this.claudeDir, 'history.jsonl'), 'history.jsonl'],
    ] as const) {
      if (this.fileExists(src)) {
        try {
          fs.copyFileSync(src, path.join(sysPath, name));
        } catch (e) {
          if (!sysStderr) sysStderr = String(e);
          sysErrors++;
        }
      }
    }
    for (const dir of ['plans', 'specs']) {
      const srcDir = path.join(this.claudeDir, dir);
      if (this.dirExists(srcDir)) {
        const dest = path.join(sysPath, dir);
        fs.mkdirSync(dest, { recursive: true });
        try {
          await this.rsyncOrCp(srcDir, dest);
        } catch (e) {
          if (!sysStderr) sysStderr = String(e);
          sysErrors++;
        }
      }
    }
    if (this.fileExists(this.conversationIndexPath)) {
      try {
        fs.copyFileSync(this.conversationIndexPath, path.join(sysPath, 'conversation-index.json'));
      } catch (e) {
        if (!sysStderr) sysStderr = String(e);
        sysErrors++;
      }
    }
    if (sysErrors > 0) {
      this.logBackup('WARN', `iCloud push system-config failed (${sysErrors} item(s))`, 'sync.push.icloud', { stderr: truncateStderr(sysStderr) });
      if (!firstFailStderr) firstFailStderr = sysStderr;
      errors++;
    }

    // Why: tiered pruning of old dated snapshots. Read the dated dirs under
    // <YouCoded>/Backup/, decide which to delete via the pure retention core,
    // then fs.rm each by its EXACT dated path — NEVER a glob/wildcard — so a bad
    // name can't remove sibling data (unparseable names are never returned).
    try {
      const backupDir = path.join(icloudPath, 'Backup');
      const names = await fs.promises.readdir(backupDir);
      for (const name of snapshotsToDelete(names, snapshot.now)) {
        // Why: per-delete try/catch (matches Drive's continue-past-failure loop) so
        // one failed rm doesn't abort the remaining deletions.
        try {
          await fs.promises.rm(path.join(backupDir, name), { recursive: true, force: true });
          this.logBackup('INFO', `iCloud snapshot pruned ${name}`, 'sync.push.icloud');
        } catch { /* skip this one, keep pruning the rest */ }
      }
    } catch { /* pruning is best-effort — never fail a snapshot over cleanup */ }

    if (errors > 0) {
      await this.recordBackendFailure(instance, firstFailStderr);
    } else {
      await this.clearBackendFailures(instance.id);
    }
    this.logBackup(errors > 0 ? 'WARN' : 'INFO', 'iCloud sync complete', 'sync.push.icloud');
    return errors;
  }

  /** Resolve iCloud Drive path from instance config or auto-detect. */
  private resolveICloudPath(instance?: BackendInstance): string | null {
    const configured = instance?.config.ICLOUD_PATH || this.configGet('ICLOUD_PATH', '');
    if (configured && this.dirExists(configured)) return configured;

    // Auto-detect by platform
    const candidates = [
      path.join(os.homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/YouCoded'),
      path.join(os.homedir(), 'iCloudDrive/YouCoded'),
      path.join(os.homedir(), 'Apple/CloudDocs/YouCoded'),
    ];
    for (const c of candidates) {
      // Check parent dir exists (YouCoded subdir may not yet)
      if (this.dirExists(path.dirname(c))) return c;
    }
    return null;
  }

  // =========================================================================
  // Push: Orchestrator
  // =========================================================================

  /**
   * Push personal data to backends.
   * - Default: pushes to all sync-enabled backends (the hourly daily-snapshot poll)
   * - With backendId: pushes to that specific backend only (manual upsync)
   * - With force: bypasses the 15-minute debounce (manual "Back up now")
   */
  async push(opts?: { force?: boolean; backendId?: string }): Promise<PushResult> {
    if (this.pushing) return { success: false, errors: 0, backends: [] };
    this.pushing = true;

    try {
      // Plan 2c: the legacy conversation-index is FROZEN — no longer maintained
      // on push. The Conversation Store (~/YouCoded/Personal/Conversations/) is
      // authoritative for titles + flags now; the index file stays readable for
      // residual legacy-only rows (session-browser's readIndexMeta / readTopic
      // fallback). Full index retirement (delete the read path + file) is
      // deferred to a future task. (was: this.updateConversationIndex())

      // Acquire lock
      if (!this.acquireLock()) {
        this.logBackup('INFO', 'Push skipped — another sync is running', 'sync.push');
        return { success: false, errors: 0, backends: [] };
      }

      try {
        // Debounce check (skip if force or targeting a specific backend)
        if (!opts?.force && !opts?.backendId && !this.debounceCheck(this.syncMarkerPath, PUSH_DEBOUNCE_MIN)) {
          this.logBackup('INFO', 'Push skipped — debounce', 'sync.push');
          return { success: true, errors: 0, backends: [] };
        }

        // If a specific backend was requested (manual push), use just that one.
        // Otherwise, push to all sync-enabled backends (the daily-snapshot poll).
        const instances = opts?.backendId
          ? [this.getBackendById(opts.backendId)].filter(Boolean) as BackendInstance[]
          : this.getSyncEnabledBackends();

        if (instances.length === 0) return { success: true, errors: 0, backends: [] };

        // Why: compute the daily snapshot gate ONCE per push() cycle (not per
        // backend) so Drive AND iCloud write into the SAME dated folder today and
        // the once-per-day stamp isn't double-consumed. github ignores it.
        let snapshotMarker: string | null = null;
        try { snapshotMarker = fs.readFileSync(this.snapshotMarkerPath, 'utf8').trim(); } catch { /* first run */ }
        const snapshotNow = new Date();
        const snapshot: SnapshotGate = {
          // Why: a manual force (opts.force) bypasses the once-per-UTC-day due gate
          // so "Back up now" / "Upload now" ALWAYS copy today's ~/.claude personal
          // data (encyclopedia/memory/CLAUDE.md/settings). Re-copying into the same
          // dated Backup/<date>/ folder is idempotent (rclone --update/--checksum skip
          // unchanged files). The AUTOMATIC hourly poll (non-force) still respects the
          // daily stamp, so it produces at most one snapshot per UTC day as before.
          due: !!opts?.force || isBackupDue(snapshotMarker, snapshotNow),
          dated: datedFolderName(snapshotNow),
          now: snapshotNow,
        };
        // Why: track whether at least one snapshot backend (Drive/iCloud) actually
        // SUCCEEDED this cycle (0 errors). We only stamp the daily marker on success
        // (see below) so a total-failure cycle — or a github-only cycle — leaves the
        // marker unwritten and a later hourly-poll push retries the same day.
        let anySnapshotSucceeded = false;

        let totalErrors = 0;
        const pushedIds: string[] = [];

        for (const instance of instances) {
          try {
            let backendErrors = 0;
            switch (instance.type) {
              case 'drive': backendErrors = await this.pushDrive(instance, snapshot); break;
              // Why: the legacy GitHub personal-sync backup target was removed
              // (sync-legacy-demolition). A github-type backend no longer backs up
              // via this path — the GitHub *space sync* is a separate subsystem.
              case 'icloud': backendErrors = await this.pushiCloud(instance, snapshot); break;
            }
            if ((instance.type === 'drive' || instance.type === 'icloud') && backendErrors === 0) {
              anySnapshotSucceeded = true;
            }
            totalErrors += backendErrors;
            pushedIds.push(instance.id);

            // Write per-backend marker for individual status tracking
            this.debounceTouch(this.perBackendMarkerPath(instance.id));
            // pushDrive/pushiCloud handle their own warning clear on success
          } catch (e) {
            this.logBackup('ERROR', `${instance.id} push failed: ${e}`, 'sync.push', { stderr: String(e).slice(0, 500) });
            // Synthesize an UNKNOWN warning from the exception string so the UI
            // sees something even when the push throws before reaching rclone.
            // String(e) includes 'ENOENT' for spawn failures, letting the classifier
            // catch RCLONE_MISSING via its stderr substring match.
            await this.recordBackendFailure(instance, String(e));
            totalErrors++;
          }
        }

        // Why: write the daily snapshot stamp ONCE, after both Drive+iCloud have
        // had their turn this cycle, so subsequent hourly-poll push() calls no-op
        // the snapshot copy until the next UTC day. Retry semantics: we stamp ONLY
        // when a snapshot backend SUCCEEDED (0 errors) today — a fully-failed cycle
        // (rclone missing / network down) leaves the marker unwritten so the next
        // hourly-poll push retries the same day rather than silently burning it. rclone
        // copy/copyto skip unchanged files, so a retry after partial success is cheap.
        // Best-effort write like daily-backup's marker — a read-only ~/.claude must
        // not fail the whole push.
        if (shouldStampDailyMarker(snapshot.due, anySnapshotSucceeded)) {
          try { fs.writeFileSync(this.snapshotMarkerPath, snapshot.dated); }
          catch (e) { this.logBackup('WARN', `Could not write snapshot marker: ${String(e)}`, 'sync.push'); }
        }

        // Write backup-meta.json on success
        if (totalErrors === 0) this.writeBackupMeta();

        // Update global debounce marker AFTER sync (critical ordering)
        this.debounceTouch(this.syncMarkerPath);

        this.emit('push-complete', { errors: totalErrors });
        return { success: totalErrors === 0, errors: totalErrors, backends: pushedIds };
      } finally {
        this.releaseLock();
      }
    } finally {
      this.pushing = false;
    }
  }

  // Conversation Index Management: FULLY RETIRED from SyncService (Plan 2c).
  // The legacy conversation-index.json is frozen and now owned entirely by the
  // Conversation Store for titles + flags. SyncService no longer writes OR reads
  // it — the only residual reader is session-browser.ts (readIndexMeta /
  // readTopic fallback), for legacy-only rows that predate the store. All
  // SyncService index helpers (updateConversationIndex, mergeConversationIndex,
  // setSessionFlag, getAllSessionFlags, migrateEntry) were deleted here.

  // =========================================================================
  // Sync Health Check & Warning Generation
  // =========================================================================

  /**
   * Reachability probe behind the OFFLINE warning. Its own method so the
   * periodic re-check has one thing to stub in tests (matching how
   * autoDetectBackend is stubbed) — an inline `await import('dns')` is
   * awkward to control from a suite.
   */
  private async probeInternet(): Promise<boolean> {
    try {
      const dns = await import('dns');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 5000);
        dns.lookup('github.com', (err) => {
          clearTimeout(timer);
          if (err) reject(err); else resolve();
        });
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run sync health checks and write .sync-warnings file.
   * Generates warnings for: OFFLINE, PERSONAL:NOT_CONFIGURED, PERSONAL:STALE.
   * (The PROJECTS_UNSYNCED discovery warning was removed in sync-legacy-demolition.)
   *
   * Runs at app startup AND every HEALTH_POLL_INTERVAL_MS after it, so a
   * condition that resolves mid-session (network back, sync set up) clears its
   * own warning instead of sitting there until the next launch.
   *
   * `probeBackends` is true only for the startup run: the legacy-backend probe
   * shells out to rclone and has been measured at 35s, which must not run at
   * poll cadence. Skipping it can't strand a warning — a user who sets up sync
   * mid-session turns on the PRIMARY system, which is a cheap file read.
   */
  async runHealthCheck(opts: { probeBackends?: boolean } = {}): Promise<SyncWarning[]> {
    const { probeBackends = true } = opts;
    const warnings: SyncWarning[] = [];
    const now = Math.floor(Date.now() / 1000);

    // 0. Internet connectivity.
    //
    // Two strikes before we say "No internet". One DNS lookup is a noisy
    // oracle — it fails during the few seconds between Electron starting and
    // the WiFi associating, and on any resolver hiccup — and that single
    // sample is what put a red "No internet" card under an "All synced · 1m
    // ago" header in the 2026-08-11 report. Now the check has to fail twice a
    // minute apart, which no launch race survives. Cost: a genuinely offline
    // machine sees the banner one poll late, which is fine for a notice whose
    // whole message is "syncing will resume automatically".
    if (await this.probeInternet()) {
      this.failedInternetProbes = 0;
    } else {
      this.failedInternetProbes++;
    }
    if (this.failedInternetProbes >= 2) {
      warnings.push({
        code: 'OFFLINE',
        level: 'danger',
        title: 'No internet',
        body: "Can't reach the network. Syncing will resume automatically when you're back online.",
        dismissible: true,
        createdEpoch: now,
      });
    }

    // 1. Personal data sync backend status
    //
    // Fix (2026-07-24): this section knew about the LEGACY additional-backup
    // backends only — `getSyncEnabledBackends()` reads `storage_backends` in
    // toolkit-state/config.json (Drive/iCloud/rclone). The app's PRIMARY sync,
    // GitHub sync spaces, keeps its own state file and is invisible to it, so a
    // machine syncing happily to GitHub with no Drive/iCloud backend got a
    // danger-level, NON-dismissible "No sync configured — your backups aren't
    // set up", which the StatusBar renders as a red "Sync Failing" chip. Seen on
    // a fresh macOS install running 1.3.0-beta.9. Long-lived installs hid the bug
    // via autoDetectBackend(): it probes `rclone lsd gdrive:…`/the iCloud folder
    // and, on a machine that used the legacy backups years ago, silently succeeds
    // and skips the warning — without enabling any backend (verified on the Z13:
    // storage_backends is [], rclone exits 0). A clean machine has no rclone, so
    // the probe fails and the warning fires — i.e. the bug lands precisely on new
    // installs, and the release population is all new installs.
    // The warning now describes the whole picture: it fires only when NOTHING is
    // syncing, and the stale warning names the additional backups it's about.
    const primarySyncOn = this.isPrimarySyncEnabled();
    const syncBackends = this.getSyncEnabledBackends();
    if (syncBackends.length === 0) {
      const detected = probeBackends ? await this.autoDetectBackend() : null;
      if (detected) {
        try {
          const config = this.readJson(this.configPath) || {};
          config.PERSONAL_SYNC_BACKEND = detected;
          this.atomicWrite(this.configPath, JSON.stringify(config, null, 2));
          this.logBackup('INFO', `Auto-detected sync backend: ${detected}`, 'sync.health');
        } catch {}
      } else if (!primarySyncOn) {
        warnings.push({
          code: 'PERSONAL_NOT_CONFIGURED',
          level: 'danger',
          title: 'No sync configured',
          body: "Nothing is backing up your data yet. Set up sync so your conversations and settings are protected.",
          fixAction: { label: 'Set up sync', kind: 'open-sync-setup' },
          dismissible: false,
          createdEpoch: now,
        });
      }
    } else {
      try {
        const markerText = fs.readFileSync(this.syncMarkerPath, 'utf8').trim();
        const lastEpoch = parseInt(markerText, 10);
        if (!isNaN(lastEpoch)) {
          const age = Math.floor(Date.now() / 1000) - lastEpoch;
          if (age >= 86400) {
            warnings.push({
              code: 'PERSONAL_STALE',
              level: 'warn',
              // Named for what the marker actually tracks: the legacy
              // Drive/iCloud snapshot pushes. GitHub sync spaces has its own
              // status in the panel and never stamps this marker.
              title: 'Extra backups are stale',
              body: "Your additional cloud backups (Drive or iCloud) haven't succeeded in over 24 hours. Check Backup & Sync for details.",
              dismissible: true,
              createdEpoch: now,
            });
          }
        }
      } catch {}
    }

    // (The unsynced-projects discovery warning was removed in
    // sync-legacy-demolition — discoverProjects() went with it.)

    // Merge with existing push-failure warnings (preserve them; only replace
    // the health-check-owned codes).
    const existing = await readWarnings();
    // Only the still-actionable health codes are owned here. 'SKILLS_UNROUTED'
    // and 'PROJECTS_UNSYNCED' are retained in the clear-set so any stale entries
    // from old .sync-warnings.json files (from before this demolition) get swept
    // out. Safe to drop from this set once all users have upgraded.
    const healthCodes = new Set(['OFFLINE', 'PERSONAL_NOT_CONFIGURED', 'PERSONAL_STALE', 'SKILLS_UNROUTED', 'PROJECTS_UNSYNCED']);
    const preserved = existing.filter((w) => !healthCodes.has(w.code));
    // A code the user dismissed stays dismissed for the rest of the app run —
    // otherwise the re-check that makes resolved warnings disappear would also
    // make dismissed ones reappear a minute later. Non-dismissible codes are
    // unaffected (dismissWarning refuses them, so they never enter the set).
    const kept = warnings.filter((w) => !wasDismissedThisRun(w.code));
    const next = [...preserved, ...kept];

    // Only touch the file when the set actually changed. At poll cadence the
    // steady state is "nothing changed", and a rewrite there would churn the
    // disk and re-broadcast identical data every minute.
    if (!sameWarnings(existing, next)) {
      await writeWarnings(next);
    }

    return kept;
  }

  /**
   * True when the app's PRIMARY sync — GitHub sync spaces — is turned on.
   *
   * Reads SpaceManager's state file directly instead of importing
   * `sync-spaces/service.ts`: that module pulls in the sync engine, chokidar and
   * electron's BrowserWindow, none of which belong in a startup health check
   * (and SyncService's tests run under plain node against a tmp home). The path
   * agreement is pinned by `sync-health-primary-system.test.ts`, which drives a
   * real SpaceManager and asserts this reader sees what it wrote.
   */
  private isPrimarySyncEnabled(): boolean {
    return !!this.readJson(this.syncSpacesStatePath)?.enabled;
  }

  /** Try to auto-detect a sync backend (Drive via rclone, iCloud via folder). */
  private async autoDetectBackend(): Promise<string | null> {
    // Check Google Drive (rclone + gdrive remote)
    const driveRoot = this.configGet('DRIVE_ROOT', 'Claude');
    const rcloneResult = await this.rclone(['lsd', `gdrive:${driveRoot}/Backup/`]);
    if (rcloneResult.code === 0) return 'drive';

    // Check iCloud Drive (macOS/Windows folder exists with Claude backup)
    const icloudCandidates = [
      path.join(os.homedir(), 'Library/Mobile Documents/com~apple~CloudDocs'),
      path.join(os.homedir(), 'iCloudDrive'),
    ];
    for (const candidate of icloudCandidates) {
      if (this.dirExists(candidate)) {
        const claudeDir = path.join(candidate, 'Claude');
        const youcodedCore = path.join(candidate, 'YouCoded');
        if (this.dirExists(path.join(claudeDir, 'Backup')) || this.dirExists(youcodedCore)) {
          return 'icloud';
        }
      }
    }

    return null;
  }

  // =========================================================================
  // Backup Metadata
  // =========================================================================

  /** Write backup-meta.json after successful sync. */
  private writeBackupMeta(): void {
    const toolkitRoot = this.configGet('toolkit_root', '');
    let toolkitVersion = 'unknown';
    if (toolkitRoot) {
      try { toolkitVersion = fs.readFileSync(path.join(toolkitRoot, 'VERSION'), 'utf8').trim(); } catch {}
    }

    const meta = {
      schema_version: 1,
      toolkit_version: toolkitVersion,
      last_backup: new Date().toISOString(),
      platform: process.platform,
    };

    this.atomicWrite(path.join(this.claudeDir, 'backup-meta.json'), JSON.stringify(meta, null, 2));
  }

}
