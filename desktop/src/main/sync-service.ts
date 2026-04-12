/**
 * sync-service.ts — Native sync engine for DestinCode.
 *
 * Ports the DestinClaude toolkit's sync orchestration from bash (sync.sh,
 * session-start.sh, session-end-sync.sh, backup-common.sh) into a Node.js
 * service running in the Electron main process.
 *
 * The service owns the full sync lifecycle:
 *   - Pull on app launch (replaces session-start.sh personal data pull)
 *   - Background push every 15 minutes (replaces PostToolUse sync.sh debounce)
 *   - Session-end push (replaces session-end-sync.sh)
 *   - Conversation index management, cross-device slug rewriting, aggregation
 *
 * Actual rclone/git/rsync commands still shell out via child_process.execFile.
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
import { type BackendInstance, migrateConfigToV2, syncLegacyKeys } from './sync-state';

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

interface ConversationIndexEntry {
  topic: string;
  lastActive: string; // ISO-8601
  slug: string;
  device: string;
  // User-set "complete" flag. Hidden from the resume menu by default.
  complete?: boolean;
  // ISO-8601 timestamp of the last complete-flag change; used by merge
  // (latest wins) so marking/unmarking doesn't fake new session activity.
  completeUpdatedAt?: string;
}

interface ConversationIndex {
  version: number;
  sessions: Record<string, ConversationIndexEntry>;
}

// --- Constants ---

const PUSH_INTERVAL_MS = 15 * 60 * 1000;   // 15 minutes
const PUSH_DEBOUNCE_MIN = 15;
const PULL_DEBOUNCE_MIN = 10;
const INDEX_PRUNE_DAYS = 30;
const RCLONE_TIMEOUT = 60_000;
const GIT_TIMEOUT = 60_000;
const SESSION_PUSH_TIMEOUT = 15_000;

// --- SyncService ---

export class SyncService extends EventEmitter {
  private claudeDir: string;
  private configPath: string;
  private localConfigPath: string;
  private syncMarkerPath: string;
  private pullMarkerPath: string;
  private lockDir: string;
  private backupLogPath: string;
  private appSyncMarkerPath: string;
  private conversationIndexPath: string;
  private indexStagingDir: string;

  private pushTimer: NodeJS.Timeout | null = null;
  private pulling = false;
  private pushing = false;

  constructor() {
    super();
    this.claudeDir = path.join(os.homedir(), '.claude');
    this.configPath = path.join(this.claudeDir, 'toolkit-state', 'config.json');
    this.localConfigPath = path.join(this.claudeDir, 'toolkit-state', 'config.local.json');
    this.syncMarkerPath = path.join(this.claudeDir, 'toolkit-state', '.sync-marker');
    this.pullMarkerPath = path.join(this.claudeDir, 'toolkit-state', '.session-sync-marker');
    this.lockDir = path.join(this.claudeDir, 'toolkit-state', '.sync-lock');
    this.backupLogPath = path.join(this.claudeDir, 'backup.log');
    this.appSyncMarkerPath = path.join(this.claudeDir, 'toolkit-state', '.app-sync-active');
    this.conversationIndexPath = path.join(this.claudeDir, 'conversation-index.json');
    this.indexStagingDir = path.join(this.claudeDir, 'toolkit-state', '.index-staging');
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /** Start the sync service: write marker, initial pull, start push timer. */
  async start(): Promise<void> {
    // Self-heal: if a stale marker exists from a previous crash, log and overwrite.
    // Without this, a crash leaves the marker indefinitely and hooks never sync.
    try {
      if (this.fileExists(this.appSyncMarkerPath)) {
        const stalePid = parseInt(fs.readFileSync(this.appSyncMarkerPath, 'utf8').trim(), 10);
        if (stalePid > 0 && stalePid !== process.pid && !this.isPidAlive(stalePid)) {
          this.logBackup('WARN', `Cleaned stale .app-sync-active marker (PID ${stalePid} is dead — previous crash?)`, 'sync.lifecycle');
        }
      }
    } catch {}

    // Write .app-sync-active marker so bash hooks skip sync
    try {
      fs.mkdirSync(path.dirname(this.appSyncMarkerPath), { recursive: true });
      fs.writeFileSync(this.appSyncMarkerPath, String(process.pid));
    } catch {}

    this.logBackup('INFO', 'SyncService started', 'sync.lifecycle');

    // Initial pull — don't crash if it fails
    try {
      await this.pull();
    } catch (e) {
      this.logBackup('ERROR', `Initial pull failed: ${e}`, 'sync.pull');
    }

    // Start background push timer
    this.pushTimer = setInterval(() => {
      this.push().catch(e => {
        this.logBackup('ERROR', `Background push failed: ${e}`, 'sync.push');
      });
    }, PUSH_INTERVAL_MS);
  }

  /** Stop the sync service: clear timer, release locks, remove marker. */
  stop(): void {
    if (this.pushTimer) {
      clearInterval(this.pushTimer);
      this.pushTimer = null;
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
  private getBackendById(id: string): BackendInstance | null {
    return this.getBackendInstances().find(b => b.id === id) || null;
  }

  /** Per-backend sync marker path for tracking individual push times. */
  private perBackendMarkerPath(backendId: string): string {
    return path.join(this.claudeDir, 'toolkit-state', `.sync-marker-${backendId}`);
  }

  /** Write per-backend error message (or clear it on success). */
  private writeBackendError(backendId: string, error: string | null): void {
    const errorPath = path.join(this.claudeDir, 'toolkit-state', `.sync-error-${backendId}`);
    if (error) {
      this.atomicWrite(errorPath, error);
    } else {
      try { fs.unlinkSync(errorPath); } catch {}
    }
  }

  // Legacy helpers kept for health check auto-detect (reads flat keys)
  /** Get active backend type names from legacy flat keys. */
  private getLegacyBackendTypes(): string[] {
    const raw = this.configGet('PERSONAL_SYNC_BACKEND', 'none');
    return raw.split(',').map(b => b.trim().toLowerCase()).filter(b => b && b !== 'none');
  }

  // =========================================================================
  // Slug Generation (CRITICAL — must match Claude Code's algorithm)
  // =========================================================================

  /**
   * Generate the current device's project slug.
   * On Windows, os.homedir() returns native path (C:\Users\desti).
   * On Unix, uses fs.realpathSync to resolve symlinks.
   * Replace /, \, : with - to match Claude Code's slug algorithm.
   */
  getCurrentSlug(): string {
    let homePath: string;
    if (process.platform === 'win32') {
      // os.homedir() already returns native Windows path (C:\Users\desti)
      // No cygpath needed — bash uses cygpath because $HOME is /c/Users/desti
      homePath = os.homedir();
    } else {
      try {
        homePath = fs.realpathSync(os.homedir());
      } catch {
        homePath = os.homedir();
      }
    }
    // Replace path separators and drive letter colon with dashes
    return homePath.replace(/[/\\:]/g, '-');
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
      return { code: e.code || 1, stdout: e.stdout || '', stderr: e.stderr || e.message };
    }
  }

  /** Execute git with args in a working directory. */
  private async gitExec(args: string[], cwd: string): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT });
      return { code: 0, stdout, stderr };
    } catch (e: any) {
      return { code: e.code || 1, stdout: e.stdout || '', stderr: e.stderr || e.message };
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

  private readText(filePath: string): string {
    try {
      return fs.readFileSync(filePath, 'utf8').trim();
    } catch {
      return '';
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
  private async pushDrive(instance: BackendInstance): Promise<number> {
    const rcloneRemote = instance.config.rcloneRemote || 'gdrive';
    const driveRoot = instance.config.DRIVE_ROOT || 'Claude';
    const remoteBase = `${rcloneRemote}:${driveRoot}/Backup/personal`;
    const sysRemote = `${remoteBase}/system-backup`;
    let errors = 0;

    // Memory files — per project key
    const projectsDir = path.join(this.claudeDir, 'projects');
    if (this.dirExists(projectsDir)) {
      for (const projectKey of fs.readdirSync(projectsDir)) {
        const memoryDir = path.join(projectsDir, projectKey, 'memory');
        if (!this.dirExists(memoryDir)) continue;
        const r = await this.rclone(['copy', memoryDir + '/', `${remoteBase}/memory/${projectKey}/`, '--update', '--skip-links']);
        if (r.code !== 0) { this.logBackup('WARN', `Drive push memory/${projectKey} failed`, 'sync.push.drive'); errors++; }
      }
    }

    // CLAUDE.md
    const claudeMd = path.join(this.claudeDir, 'CLAUDE.md');
    if (this.fileExists(claudeMd)) {
      const r = await this.rclone(['copyto', claudeMd, `${remoteBase}/CLAUDE.md`, '--update']);
      if (r.code !== 0) { this.logBackup('WARN', 'Drive push CLAUDE.md failed', 'sync.push.drive'); errors++; }
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

    // Conversations — snapshot to temp dir first to avoid races with subagents
    if (this.dirExists(projectsDir)) {
      const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-conv-'));
      try {
        for (const slugName of fs.readdirSync(projectsDir)) {
          const slugDir = path.join(projectsDir, slugName);
          if (!this.dirExists(slugDir)) continue;
          // Skip symlinked slug dirs (foreign device slugs)
          try { if (fs.lstatSync(slugDir).isSymbolicLink()) continue; } catch { continue; }

          // Find real .jsonl files (not symlinks)
          const jsonlFiles = fs.readdirSync(slugDir).filter(f => f.endsWith('.jsonl') && !fs.lstatSync(path.join(slugDir, f)).isSymbolicLink());
          if (jsonlFiles.length === 0) continue;

          const snapSlugDir = path.join(snapDir, slugName);
          fs.mkdirSync(snapSlugDir, { recursive: true });
          for (const f of jsonlFiles) {
            fs.copyFileSync(path.join(slugDir, f), path.join(snapSlugDir, f));
          }

          const r = await this.rclone(['copy', snapSlugDir + '/', `${remoteBase}/conversations/${slugName}/`, '--checksum', '--include', '*.jsonl']);
          if (r.code !== 0) { this.logBackup('WARN', `Drive push conversations/${slugName} failed`, 'sync.push.drive'); errors++; }
        }
      } finally {
        fs.rmSync(snapDir, { recursive: true, force: true });
      }
    }

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
        if (r.code !== 0) { this.logBackup('WARN', `Drive push ${path.basename(local)} failed`, 'sync.push.drive'); errors++; }
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

    this.logBackup(errors > 0 ? 'WARN' : 'INFO', `Drive sync completed (${errors} error(s))`, 'sync.push.drive');
    return errors;
  }

  // =========================================================================
  // Push: GitHub Backend
  // =========================================================================

  // Accepts a BackendInstance — each instance gets its own clone dir for multi-repo support
  private async pushGithub(instance: BackendInstance): Promise<number> {
    const syncRepo = instance.config.PERSONAL_SYNC_REPO || '';
    // Per-instance clone directory so multiple GitHub backends don't collide
    const repoDir = path.join(this.claudeDir, 'toolkit-state', `personal-sync-repo-${instance.id}`);
    let errors = 0;

    // Init repo if missing
    if (!this.dirExists(path.join(repoDir, '.git'))) {
      if (!syncRepo) {
        this.logBackup('ERROR', 'PERSONAL_SYNC_REPO not configured', 'sync.push.github');
        return 1;
      }
      fs.mkdirSync(repoDir, { recursive: true });
      const cloneResult = await this.gitExec(['clone', syncRepo, repoDir], this.claudeDir);
      if (cloneResult.code !== 0) {
        // Init fresh repo
        await this.gitExec(['init'], repoDir);
        await this.gitExec(['remote', 'add', 'personal-sync', syncRepo], repoDir);
        fs.writeFileSync(path.join(repoDir, 'README.md'), '# Personal Claude Data Backup\n');
        fs.writeFileSync(path.join(repoDir, '.gitignore'), '.DS_Store\nThumbs.db\n*.tmp\n');
        await this.gitExec(['add', '-A'], repoDir);
        await this.gitExec(['commit', '-m', 'Initial commit', '--no-gpg-sign'], repoDir);
        await this.gitExec(['branch', '-M', 'main'], repoDir);
        await this.gitExec(['push', '-u', 'personal-sync', 'main'], repoDir);
      }
    }

    // Ensure remote URL is current
    await this.gitExec(['remote', 'set-url', 'personal-sync', syncRepo], repoDir);

    // Copy all data categories into repo structure
    const projectsDir = path.join(this.claudeDir, 'projects');

    // Memory files
    if (this.dirExists(projectsDir)) {
      for (const projectKey of fs.readdirSync(projectsDir)) {
        const memoryDir = path.join(projectsDir, projectKey, 'memory');
        if (!this.dirExists(memoryDir)) continue;
        const dest = path.join(repoDir, 'memory', projectKey);
        fs.mkdirSync(dest, { recursive: true });
        fs.cpSync(memoryDir, dest, { recursive: true, force: true });
      }
    }

    // CLAUDE.md
    const claudeMd = path.join(this.claudeDir, 'CLAUDE.md');
    if (this.fileExists(claudeMd)) fs.copyFileSync(claudeMd, path.join(repoDir, 'CLAUDE.md'));

    // Encyclopedia
    const encDir = path.join(this.claudeDir, 'encyclopedia');
    if (this.dirExists(encDir)) {
      const dest = path.join(repoDir, 'encyclopedia');
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(encDir, dest, { recursive: true, force: true });
    }

    // User-created skills
    const skillsDir = path.join(this.claudeDir, 'skills');
    if (this.dirExists(skillsDir)) {
      for (const skillName of fs.readdirSync(skillsDir)) {
        const skillDir = path.join(skillsDir, skillName);
        if (!this.dirExists(skillDir) || this.isToolkitOwned(skillDir)) continue;
        if (!this.shouldSyncSkill(skillName)) continue;
        const dest = path.join(repoDir, 'skills', skillName);
        fs.mkdirSync(dest, { recursive: true });
        fs.cpSync(skillDir, dest, { recursive: true, force: true });
      }
    }

    // Conversations (real .jsonl files only, skip symlinks)
    if (this.dirExists(projectsDir)) {
      for (const slugName of fs.readdirSync(projectsDir)) {
        const slugDir = path.join(projectsDir, slugName);
        if (!this.dirExists(slugDir)) continue;
        try { if (fs.lstatSync(slugDir).isSymbolicLink()) continue; } catch { continue; }
        const jsonlFiles = fs.readdirSync(slugDir).filter(f => {
          if (!f.endsWith('.jsonl')) return false;
          try { return !fs.lstatSync(path.join(slugDir, f)).isSymbolicLink(); } catch { return false; }
        });
        if (jsonlFiles.length === 0) continue;
        const dest = path.join(repoDir, 'conversations', slugName);
        fs.mkdirSync(dest, { recursive: true });
        for (const f of jsonlFiles) {
          fs.copyFileSync(path.join(slugDir, f), path.join(dest, f));
        }
      }
    }

    // System config
    const sysDir = path.join(repoDir, 'system-backup');
    fs.mkdirSync(sysDir, { recursive: true });
    for (const [src, name] of [
      [this.configPath, 'config.json'],
      [path.join(this.claudeDir, 'settings.json'), 'settings.json'],
      [path.join(this.claudeDir, 'keybindings.json'), 'keybindings.json'],
      [path.join(this.claudeDir, 'mcp.json'), 'mcp.json'],
      [path.join(this.claudeDir, 'history.jsonl'), 'history.jsonl'],
    ] as const) {
      if (this.fileExists(src)) fs.copyFileSync(src, path.join(sysDir, name));
    }
    for (const dir of ['plans', 'specs']) {
      const srcDir = path.join(this.claudeDir, dir);
      if (this.dirExists(srcDir)) {
        const dest = path.join(sysDir, dir);
        fs.mkdirSync(dest, { recursive: true });
        fs.cpSync(srcDir, dest, { recursive: true, force: true });
      }
    }
    // Conversation index
    if (this.fileExists(this.conversationIndexPath)) {
      fs.copyFileSync(this.conversationIndexPath, path.join(sysDir, 'conversation-index.json'));
    }

    // Git add, commit, push
    await this.gitExec(['add', '-A'], repoDir);
    const diffResult = await this.gitExec(['diff', '--cached', '--quiet'], repoDir);
    if (diffResult.code !== 0) {
      // There are staged changes
      await this.gitExec(['commit', '-m', 'auto: sync', '--no-gpg-sign'], repoDir);
      const pushResult = await this.gitExec(['push', 'personal-sync', 'main'], repoDir);
      if (pushResult.code !== 0) {
        this.logBackup('WARN', 'Push to personal-sync repo failed', 'sync.push.github');
        errors++;
      }
    }

    this.logBackup(errors > 0 ? 'WARN' : 'INFO', 'GitHub sync completed', 'sync.push.github');
    return errors;
  }

  // =========================================================================
  // Push: iCloud Backend
  // =========================================================================

  // Accepts a BackendInstance for per-instance iCloud path support
  private async pushiCloud(instance: BackendInstance): Promise<number> {
    const icloudPath = this.resolveICloudPath(instance);
    if (!icloudPath) {
      this.logBackup('ERROR', 'iCloud Drive folder not found', 'sync.push.icloud');
      return 1;
    }

    fs.mkdirSync(icloudPath, { recursive: true });
    let errors = 0;

    // Memory files
    const projectsDir = path.join(this.claudeDir, 'projects');
    if (this.dirExists(projectsDir)) {
      for (const projectKey of fs.readdirSync(projectsDir)) {
        const memoryDir = path.join(projectsDir, projectKey, 'memory');
        if (!this.dirExists(memoryDir)) continue;
        const dest = path.join(icloudPath, 'memory', projectKey);
        fs.mkdirSync(dest, { recursive: true });
        try { await this.rsyncOrCp(memoryDir, dest); } catch { errors++; }
      }
    }

    // CLAUDE.md
    const claudeMd = path.join(this.claudeDir, 'CLAUDE.md');
    if (this.fileExists(claudeMd)) {
      try { fs.copyFileSync(claudeMd, path.join(icloudPath, 'CLAUDE.md')); } catch {}
    }

    // Encyclopedia
    const encDir = path.join(this.claudeDir, 'encyclopedia');
    if (this.dirExists(encDir)) {
      const dest = path.join(icloudPath, 'encyclopedia');
      fs.mkdirSync(dest, { recursive: true });
      try { await this.rsyncOrCp(encDir, dest); } catch {}
    }

    // Skills
    const skillsDir = path.join(this.claudeDir, 'skills');
    if (this.dirExists(skillsDir)) {
      for (const skillName of fs.readdirSync(skillsDir)) {
        const skillDir = path.join(skillsDir, skillName);
        if (!this.dirExists(skillDir) || this.isToolkitOwned(skillDir)) continue;
        if (!this.shouldSyncSkill(skillName)) continue;
        const dest = path.join(icloudPath, 'skills', skillName);
        fs.mkdirSync(dest, { recursive: true });
        try { await this.rsyncOrCp(skillDir, dest); } catch {}
      }
    }

    // Conversations
    if (this.dirExists(projectsDir)) {
      for (const slugName of fs.readdirSync(projectsDir)) {
        const slugDir = path.join(projectsDir, slugName);
        if (!this.dirExists(slugDir)) continue;
        try { if (fs.lstatSync(slugDir).isSymbolicLink()) continue; } catch { continue; }
        const jsonlFiles = fs.readdirSync(slugDir).filter(f => {
          if (!f.endsWith('.jsonl')) return false;
          try { return !fs.lstatSync(path.join(slugDir, f)).isSymbolicLink(); } catch { return false; }
        });
        for (const f of jsonlFiles) {
          const dest = path.join(icloudPath, 'conversations', slugName);
          fs.mkdirSync(dest, { recursive: true });
          try { fs.copyFileSync(path.join(slugDir, f), path.join(dest, f)); } catch {}
        }
      }
    }

    // System config
    const sysPath = path.join(icloudPath, 'system-backup');
    fs.mkdirSync(sysPath, { recursive: true });
    for (const [src, name] of [
      [this.configPath, 'config.json'],
      [path.join(this.claudeDir, 'settings.json'), 'settings.json'],
      [path.join(this.claudeDir, 'keybindings.json'), 'keybindings.json'],
      [path.join(this.claudeDir, 'mcp.json'), 'mcp.json'],
      [path.join(this.claudeDir, 'history.jsonl'), 'history.jsonl'],
    ] as const) {
      if (this.fileExists(src)) { try { fs.copyFileSync(src, path.join(sysPath, name)); } catch {} }
    }
    for (const dir of ['plans', 'specs']) {
      const srcDir = path.join(this.claudeDir, dir);
      if (this.dirExists(srcDir)) {
        const dest = path.join(sysPath, dir);
        fs.mkdirSync(dest, { recursive: true });
        try { await this.rsyncOrCp(srcDir, dest); } catch {}
      }
    }
    if (this.fileExists(this.conversationIndexPath)) {
      try { fs.copyFileSync(this.conversationIndexPath, path.join(sysPath, 'conversation-index.json')); } catch {}
    }

    this.logBackup('INFO', 'iCloud sync complete', 'sync.push.icloud');
    return errors;
  }

  /** Resolve iCloud Drive path from instance config or auto-detect. */
  private resolveICloudPath(instance?: BackendInstance): string | null {
    const configured = instance?.config.ICLOUD_PATH || this.configGet('ICLOUD_PATH', '');
    if (configured && this.dirExists(configured)) return configured;

    // Auto-detect by platform
    const candidates = [
      path.join(os.homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/DestinClaude'),
      path.join(os.homedir(), 'iCloudDrive/DestinClaude'),
      path.join(os.homedir(), 'Apple/CloudDocs/DestinClaude'),
    ];
    for (const c of candidates) {
      // Check parent dir exists (DestinClaude subdir may not yet)
      if (this.dirExists(path.dirname(c))) return c;
    }
    return null;
  }

  // =========================================================================
  // Push: Orchestrator
  // =========================================================================

  /**
   * Push personal data to backends.
   * - Default: pushes to all sync-enabled backends (automatic loop)
   * - With backendId: pushes to that specific backend only (manual upsync)
   * - With force: bypasses the 15-minute debounce
   */
  async push(opts?: { force?: boolean; backendId?: string }): Promise<PushResult> {
    if (this.pushing) return { success: false, errors: 0, backends: [] };
    this.pushing = true;

    try {
      // Update conversation index before push
      this.updateConversationIndex();

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
        // Otherwise, push to all sync-enabled backends (automatic loop).
        const instances = opts?.backendId
          ? [this.getBackendById(opts.backendId)].filter(Boolean) as BackendInstance[]
          : this.getSyncEnabledBackends();

        if (instances.length === 0) return { success: true, errors: 0, backends: [] };

        let totalErrors = 0;
        const pushedIds: string[] = [];

        for (const instance of instances) {
          try {
            let backendErrors = 0;
            switch (instance.type) {
              case 'drive': backendErrors = await this.pushDrive(instance); break;
              case 'github': backendErrors = await this.pushGithub(instance); break;
              case 'icloud': backendErrors = await this.pushiCloud(instance); break;
            }
            totalErrors += backendErrors;
            pushedIds.push(instance.id);

            // Write per-backend marker for individual status tracking
            this.debounceTouch(this.perBackendMarkerPath(instance.id));
            // Clear per-backend error on success
            if (backendErrors === 0) this.writeBackendError(instance.id, null);
          } catch (e) {
            this.logBackup('ERROR', `${instance.id} push failed: ${e}`, 'sync.push');
            this.writeBackendError(instance.id, String(e));
            totalErrors++;
          }
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

  // =========================================================================
  // Pull: Drive Backend
  // =========================================================================

  private async pullDrive(instance: BackendInstance): Promise<void> {
    const rcloneRemote = instance.config.rcloneRemote || 'gdrive';
    const driveRoot = instance.config.DRIVE_ROOT || 'Claude';
    const remoteBase = `${rcloneRemote}:${driveRoot}/Backup/personal`;
    const sysRemote = `${rcloneRemote}:${driveRoot}/Backup/system-backup`;

    // Memory files — list remote keys, then pull each
    const memResult = await this.rclone(['lsf', `${remoteBase}/memory/`, '--dirs-only']);
    if (memResult.code === 0) {
      const memKeys = memResult.stdout.split('\n').map(k => k.replace(/\/$/, '').trim()).filter(Boolean);
      for (const key of memKeys) {
        const dest = path.join(this.claudeDir, 'projects', key, 'memory');
        fs.mkdirSync(dest, { recursive: true });
        await this.rclone(['copy', `${remoteBase}/memory/${key}/`, dest + '/', '--update', '--skip-links', '--exclude', '.DS_Store']);
      }
    }

    // Safety: only pull config.json on first-run (when local doesn't exist).
    // Once local config exists, it is authoritative — users configure backends
    // deliberately per-device, and silently overwriting their config could
    // disable sync, change backends, or break machine-specific setups.
    const configPullPromise = this.fileExists(this.configPath)
      ? Promise.resolve({ code: 0, stdout: '', stderr: 'skipped — local config exists' })
      : this.rclone(['copyto', `${sysRemote}/config.json`, this.configPath, '--update']);

    // Parallel pulls for non-dependent resources.
    // Each wrapped in its own catch so a single rclone failure (network timeout,
    // DNS error) doesn't abort the entire pull via unhandled rejection.
    const pullResults = await Promise.allSettled([
      // CLAUDE.md
      this.rclone(['copyto', `${remoteBase}/CLAUDE.md`, path.join(this.claudeDir, 'CLAUDE.md'), '--update']),
      // System config — first-run only (see above)
      configPullPromise,
      // Encyclopedia
      (async () => {
        const encDir = path.join(this.claudeDir, 'encyclopedia');
        fs.mkdirSync(encDir, { recursive: true });
        await this.rclone(['copy', `${remoteBase}/encyclopedia/`, encDir + '/', '--update', '--max-depth', '1', '--include', '*.md']);
      })(),
      // Conversations — checksum + ignore-existing (don't overwrite local)
      (async () => {
        await this.rclone(['copy', `${remoteBase}/conversations/`, path.join(this.claudeDir, 'projects') + '/', '--checksum', '--include', '*.jsonl', '--ignore-existing']);
      })(),
      // Conversation index to staging dir for post-pull merge
      (async () => {
        fs.mkdirSync(this.indexStagingDir, { recursive: true });
        await this.rclone(['copy', `${sysRemote}/conversation-index.json`, this.indexStagingDir + '/', '--checksum']);
      })(),
    ]);
    // Log any individual failures (rclone() already wraps errors, but the async
    // IIFEs above can throw on fs.mkdirSync or other Node operations)
    const pullLabels = ['CLAUDE.md', 'config.json', 'encyclopedia', 'conversations', 'conversation-index'];
    pullResults.forEach((r, i) => {
      if (r.status === 'rejected') {
        this.logBackup('WARN', `Pull ${pullLabels[i]} failed: ${r.reason}`, 'sync.pull.drive');
      }
    });
  }

  // =========================================================================
  // Pull: GitHub Backend
  // =========================================================================

  private async pullGithub(instance: BackendInstance): Promise<void> {
    const syncRepo = instance.config.PERSONAL_SYNC_REPO || '';
    const repoDir = path.join(this.claudeDir, 'toolkit-state', `personal-sync-repo-${instance.id}`);

    if (!syncRepo || !this.dirExists(path.join(repoDir, '.git'))) return;

    const pullResult = await this.gitExec(['pull', 'personal-sync', 'main'], repoDir);
    if (pullResult.code !== 0) {
      this.logBackup('WARN', 'GitHub personal-sync pull failed', 'sync.pull.github');
      return;
    }

    // Copy restored files to live locations (don't overwrite existing)
    const repoMemory = path.join(repoDir, 'memory');
    if (this.dirExists(repoMemory)) {
      for (const key of fs.readdirSync(repoMemory)) {
        const dest = path.join(this.claudeDir, 'projects', key, 'memory');
        fs.mkdirSync(dest, { recursive: true });
        fs.cpSync(path.join(repoMemory, key), dest, { recursive: true, force: false });
      }
    }

    const repoClaudeMd = path.join(repoDir, 'CLAUDE.md');
    if (this.fileExists(repoClaudeMd) && !this.fileExists(path.join(this.claudeDir, 'CLAUDE.md'))) {
      fs.copyFileSync(repoClaudeMd, path.join(this.claudeDir, 'CLAUDE.md'));
    }

    const repoEnc = path.join(repoDir, 'encyclopedia');
    if (this.dirExists(repoEnc)) {
      const dest = path.join(this.claudeDir, 'encyclopedia');
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(repoEnc, dest, { recursive: true, force: false });
    }

    // Conversations
    const repoConv = path.join(repoDir, 'conversations');
    if (this.dirExists(repoConv)) {
      for (const slugName of fs.readdirSync(repoConv)) {
        const src = path.join(repoConv, slugName);
        const dest = path.join(this.claudeDir, 'projects', slugName);
        fs.mkdirSync(dest, { recursive: true });
        fs.cpSync(src, dest, { recursive: true, force: false });
      }
    }

    // System config — first-run only. Once local config exists, it is
    // authoritative; users configure backends deliberately per-device.
    const repoSys = path.join(repoDir, 'system-backup');
    if (this.fileExists(path.join(repoSys, 'config.json')) && !this.fileExists(this.configPath)) {
      fs.copyFileSync(path.join(repoSys, 'config.json'), this.configPath);
    }

    // Conversation index to staging
    const repoIndex = path.join(repoSys, 'conversation-index.json');
    if (this.fileExists(repoIndex)) {
      fs.mkdirSync(this.indexStagingDir, { recursive: true });
      fs.copyFileSync(repoIndex, path.join(this.indexStagingDir, 'conversation-index.json'));
    }
  }

  // =========================================================================
  // Pull: iCloud Backend
  // =========================================================================

  private async pulliCloud(instance: BackendInstance): Promise<void> {
    const icloudPath = this.resolveICloudPath(instance);
    if (!icloudPath || !this.dirExists(icloudPath)) return;

    // Memory
    const icMemory = path.join(icloudPath, 'memory');
    if (this.dirExists(icMemory)) {
      for (const key of fs.readdirSync(icMemory)) {
        const dest = path.join(this.claudeDir, 'projects', key, 'memory');
        fs.mkdirSync(dest, { recursive: true });
        try { await this.rsyncOrCp(path.join(icMemory, key), dest); } catch {}
      }
    }

    // CLAUDE.md
    const icClaudeMd = path.join(icloudPath, 'CLAUDE.md');
    if (this.fileExists(icClaudeMd) && !this.fileExists(path.join(this.claudeDir, 'CLAUDE.md'))) {
      fs.copyFileSync(icClaudeMd, path.join(this.claudeDir, 'CLAUDE.md'));
    }

    // Encyclopedia
    const icEnc = path.join(icloudPath, 'encyclopedia');
    if (this.dirExists(icEnc)) {
      const dest = path.join(this.claudeDir, 'encyclopedia');
      fs.mkdirSync(dest, { recursive: true });
      try { await this.rsyncOrCp(icEnc, dest); } catch {}
    }

    // Conversations
    const icConv = path.join(icloudPath, 'conversations');
    if (this.dirExists(icConv)) {
      for (const slugName of fs.readdirSync(icConv)) {
        const dest = path.join(this.claudeDir, 'projects', slugName);
        fs.mkdirSync(dest, { recursive: true });
        fs.cpSync(path.join(icConv, slugName), dest, { recursive: true, force: false });
      }
    }

    // System config — first-run only. Once local config exists, it is
    // authoritative; users configure backends deliberately per-device.
    const icSys = path.join(icloudPath, 'system-backup');
    if (this.fileExists(path.join(icSys, 'config.json')) && !this.fileExists(this.configPath)) {
      fs.copyFileSync(path.join(icSys, 'config.json'), this.configPath);
    }

    // Conversation index to staging
    const icIndex = path.join(icSys, 'conversation-index.json');
    if (this.fileExists(icIndex)) {
      fs.mkdirSync(this.indexStagingDir, { recursive: true });
      fs.copyFileSync(icIndex, path.join(this.indexStagingDir, 'conversation-index.json'));
    }
  }

  // =========================================================================
  // Pull: Orchestrator
  // =========================================================================

  /**
   * Pull personal data from a backend + run post-pull operations.
   * - Default: pulls from the first sync-enabled backend
   * - With backendId: pulls from that specific backend (manual downsync)
   */
  async pull(opts?: { backendId?: string }): Promise<void> {
    if (this.pulling) return;
    this.pulling = true;

    try {
      let instance: BackendInstance | null;
      if (opts?.backendId) {
        instance = this.getBackendById(opts.backendId);
      } else {
        const syncEnabled = this.getSyncEnabledBackends();
        instance = syncEnabled.length > 0 ? syncEnabled[0] : null;
      }

      if (!instance) {
        this.logBackup('INFO', 'No backend for pull', 'sync.pull');
        return;
      }

      this.logBackup('INFO', `Pulling from ${instance.id} (${instance.type})`, 'sync.pull');

      switch (instance.type) {
        case 'drive': await this.pullDrive(instance); break;
        case 'github': await this.pullGithub(instance); break;
        case 'icloud': await this.pulliCloud(instance); break;
      }

      // Sequential post-pull operations (order matters)
      this.rewriteProjectSlugs();
      this.aggregateConversations();

      // Merge staged conversation index (from pull) with local
      const stagedIndex = path.join(this.indexStagingDir, 'conversation-index.json');
      if (this.fileExists(stagedIndex)) {
        this.mergeConversationIndex(stagedIndex);
      }

      this.regenerateTopicCache();

      // Run health check to generate .sync-warnings for the UI
      await this.runHealthCheck();

      this.emit('pull-complete');
      this.logBackup('INFO', 'Pull complete', 'sync.pull');
    } catch (e) {
      this.logBackup('ERROR', `Pull failed: ${e}`, 'sync.pull');
      throw e;
    } finally {
      this.pulling = false;
    }
  }

  // =========================================================================
  // Conversation Index Management
  // =========================================================================

  /** Scan topic files and upsert into conversation-index.json. */
  updateConversationIndex(): void {
    const topicsDir = path.join(this.claudeDir, 'topics');
    if (!this.dirExists(topicsDir)) return;

    // Read existing index
    let index: ConversationIndex = this.readJson(this.conversationIndexPath) || { version: 1, sessions: {} };
    if (!index.sessions) index.sessions = {};

    const slug = this.getCurrentSlug();
    const device = os.hostname();
    const now = Date.now();
    const pruneThreshold = now - INDEX_PRUNE_DAYS * 24 * 60 * 60 * 1000;

    // Scan topic files
    let files: string[];
    try { files = fs.readdirSync(topicsDir); } catch { return; }

    for (const file of files) {
      if (!file.startsWith('topic-')) continue;
      const sessionId = file.replace(/^topic-/, '');
      const filePath = path.join(topicsDir, file);

      try {
        const topic = fs.readFileSync(filePath, 'utf8').trim();
        if (!topic || topic === 'New Session') continue;

        const stat = fs.statSync(filePath);
        const lastActive = stat.mtime.toISOString();

        // Only upsert if newer than existing entry
        const existing = index.sessions[sessionId];
        if (existing && new Date(existing.lastActive).getTime() >= stat.mtimeMs) continue;

        // Preserve user-set complete flag across topic-file-driven upserts
        // so a topic rename doesn't clobber the complete metadata.
        index.sessions[sessionId] = {
          topic,
          lastActive,
          slug,
          device,
          ...(existing?.complete !== undefined ? { complete: existing.complete } : {}),
          ...(existing?.completeUpdatedAt ? { completeUpdatedAt: existing.completeUpdatedAt } : {}),
        };
      } catch {}
    }

    // Prune old entries
    for (const [sid, entry] of Object.entries(index.sessions)) {
      if (new Date(entry.lastActive).getTime() < pruneThreshold) {
        delete index.sessions[sid];
      }
    }

    this.atomicWrite(this.conversationIndexPath, JSON.stringify(index, null, 2));
  }

  /** Merge a remote conversation index with the local one (union, latest wins). */
  mergeConversationIndex(remotePath: string): void {
    const remote: ConversationIndex = this.readJson(remotePath) || { version: 1, sessions: {} };
    const local: ConversationIndex = this.readJson(this.conversationIndexPath) || { version: 1, sessions: {} };

    const merged: ConversationIndex = { version: 1, sessions: { ...local.sessions } };

    for (const [sid, remoteEntry] of Object.entries(remote.sessions || {})) {
      const localEntry = merged.sessions[sid];

      // Base entry: latest lastActive wins for topic/slug/device (existing behavior).
      let baseEntry: ConversationIndexEntry;
      if (!localEntry || new Date(remoteEntry.lastActive).getTime() > new Date(localEntry.lastActive).getTime()) {
        baseEntry = { ...remoteEntry };
      } else {
        baseEntry = { ...localEntry };
      }

      // Complete flag merges independently by completeUpdatedAt so marking
      // complete on device B doesn't require more-recent activity than A.
      const localTs = localEntry?.completeUpdatedAt ? new Date(localEntry.completeUpdatedAt).getTime() : 0;
      const remoteTs = remoteEntry.completeUpdatedAt ? new Date(remoteEntry.completeUpdatedAt).getTime() : 0;
      if (remoteTs > localTs) {
        baseEntry.complete = remoteEntry.complete;
        baseEntry.completeUpdatedAt = remoteEntry.completeUpdatedAt;
      } else if (localEntry) {
        baseEntry.complete = localEntry.complete;
        baseEntry.completeUpdatedAt = localEntry.completeUpdatedAt;
      }
      if (baseEntry.complete === undefined) delete baseEntry.complete;
      if (!baseEntry.completeUpdatedAt) delete baseEntry.completeUpdatedAt;

      merged.sessions[sid] = baseEntry;
    }

    this.atomicWrite(this.conversationIndexPath, JSON.stringify(merged, null, 2));
  }

  /**
   * Read the current complete flag for a session from the local index.
   * Returns false if the session or flag is absent.
   */
  getSessionComplete(sessionId: string): boolean {
    const index: ConversationIndex = this.readJson(this.conversationIndexPath) || { version: 1, sessions: {} };
    return !!index.sessions?.[sessionId]?.complete;
  }

  /**
   * Read the full complete-flag map for all sessions in the index.
   * Callers join this onto PastSession[] in the resume menu.
   */
  getAllSessionCompleteFlags(): Record<string, boolean> {
    const index: ConversationIndex = this.readJson(this.conversationIndexPath) || { version: 1, sessions: {} };
    const out: Record<string, boolean> = {};
    for (const [sid, entry] of Object.entries(index.sessions || {})) {
      if (entry.complete) out[sid] = true;
    }
    return out;
  }

  /**
   * Mark or unmark a session as complete. Writes to conversation-index.json
   * with a fresh completeUpdatedAt timestamp so sync merge honors latest-writer-wins.
   * The entry is created (topic: 'Untitled') if the session isn't already indexed.
   */
  setSessionComplete(sessionId: string, complete: boolean): void {
    const index: ConversationIndex = this.readJson(this.conversationIndexPath) || { version: 1, sessions: {} };
    if (!index.sessions) index.sessions = {};

    const now = new Date().toISOString();
    const existing = index.sessions[sessionId];
    if (existing) {
      existing.complete = complete;
      existing.completeUpdatedAt = now;
    } else {
      // First time seeing this session in the index — seed a minimal entry.
      // Topic will be filled in next updateConversationIndex() scan.
      index.sessions[sessionId] = {
        topic: 'Untitled',
        lastActive: now,
        slug: '',
        device: os.hostname(),
        complete,
        completeUpdatedAt: now,
      };
    }

    this.atomicWrite(this.conversationIndexPath, JSON.stringify(index, null, 2));
  }

  /** Create topic cache files from index for cross-device sessions. */
  regenerateTopicCache(): void {
    const index: ConversationIndex = this.readJson(this.conversationIndexPath) || { version: 1, sessions: {} };
    const topicsDir = path.join(this.claudeDir, 'topics');
    fs.mkdirSync(topicsDir, { recursive: true });

    for (const [sid, entry] of Object.entries(index.sessions || {})) {
      const topicFile = path.join(topicsDir, `topic-${sid}`);
      // Only create if local file doesn't exist (local-first)
      if (!this.fileExists(topicFile)) {
        try { fs.writeFileSync(topicFile, entry.topic); } catch {}
      }
    }
  }

  // =========================================================================
  // Cross-Device Operations
  // =========================================================================

  /** Create symlinks from foreign device project slugs into current device's slug. */
  rewriteProjectSlugs(): void {
    const projectsDir = path.join(this.claudeDir, 'projects');
    if (!this.dirExists(projectsDir)) return;

    const currentSlug = this.getCurrentSlug();

    for (const slugName of fs.readdirSync(projectsDir)) {
      if (slugName === currentSlug) continue;
      const slugDir = path.join(projectsDir, slugName);

      // Skip if it's already a symlink (previous rewrite)
      try { if (fs.lstatSync(slugDir).isSymbolicLink()) continue; } catch { continue; }
      if (!fs.statSync(slugDir).isDirectory()) continue;

      // For each subdirectory in the foreign slug, create a symlink in current slug
      const currentSlugDir = path.join(projectsDir, currentSlug);
      fs.mkdirSync(currentSlugDir, { recursive: true });

      for (const subName of fs.readdirSync(slugDir)) {
        const target = path.join(currentSlugDir, subName);
        if (this.fileExists(target) || this.dirExists(target)) continue; // Don't overwrite local

        const relativeSrc = path.join('..', slugName, subName);
        try {
          // Use 'junction' on Windows to avoid Developer Mode requirement
          const symlinkType = process.platform === 'win32' && fs.statSync(path.join(slugDir, subName)).isDirectory() ? 'junction' : undefined;
          fs.symlinkSync(relativeSrc, target, symlinkType);
        } catch {
          // Fallback: copy if symlink fails
          try {
            fs.cpSync(path.join(slugDir, subName), target, { recursive: true });
          } catch {}
        }
      }
    }
  }

  /** Symlink all .jsonl files from non-home slugs into home slug for /resume from ~. */
  aggregateConversations(): void {
    const projectsDir = path.join(this.claudeDir, 'projects');
    if (!this.dirExists(projectsDir)) return;

    const currentSlug = this.getCurrentSlug();
    const homeDir = path.join(projectsDir, currentSlug);
    if (!this.dirExists(homeDir)) return;

    for (const slugName of fs.readdirSync(projectsDir)) {
      if (slugName === currentSlug) continue;
      const slugDir = path.join(projectsDir, slugName);

      // Skip symlinked slug dirs
      try { if (fs.lstatSync(slugDir).isSymbolicLink()) continue; } catch { continue; }
      if (!fs.statSync(slugDir).isDirectory()) continue;

      // Symlink each .jsonl into home slug
      for (const file of fs.readdirSync(slugDir)) {
        if (!file.endsWith('.jsonl')) continue;
        const target = path.join(homeDir, file);
        if (this.fileExists(target)) continue; // Don't overwrite

        const relativeSrc = path.join('..', slugName, file);
        try {
          fs.symlinkSync(relativeSrc, target);
        } catch {}
      }
    }

    // Clean up dangling symlinks in home dir
    for (const file of fs.readdirSync(homeDir)) {
      const filePath = path.join(homeDir, file);
      try {
        const lstat = fs.lstatSync(filePath);
        if (lstat.isSymbolicLink()) {
          // Check if target exists
          try { fs.statSync(filePath); } catch {
            // Target doesn't exist — dangling symlink
            fs.unlinkSync(filePath);
          }
        }
      } catch {}
    }
  }

  // =========================================================================
  // Sync Health Check & Warning Generation
  // =========================================================================

  /**
   * Run sync health checks and write .sync-warnings file.
   * Ports session-start.sh _bg_sync_health() — generates warnings for:
   *   OFFLINE, PERSONAL:NOT_CONFIGURED, PERSONAL:STALE,
   *   SKILLS:unrouted:name1,name2, PROJECTS:N
   * Called after pull completes and on app startup.
   */
  async runHealthCheck(): Promise<string[]> {
    const warningsFile = path.join(this.claudeDir, '.sync-warnings');
    const warnings: string[] = [];

    // 0. Internet connectivity check (DNS lookup)
    try {
      const dns = await import('dns');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 5000);
        dns.lookup('github.com', (err) => {
          clearTimeout(timer);
          if (err) reject(err); else resolve();
        });
      });
    } catch {
      warnings.push('OFFLINE');
    }

    // 1. Personal data sync backend status
    const syncBackends = this.getSyncEnabledBackends();
    if (syncBackends.length === 0) {
      // Auto-detect: check if a known sync provider works
      const detected = await this.autoDetectBackend();
      if (detected) {
        // Self-heal: write detected backend to config
        try {
          const config = this.readJson(this.configPath) || {};
          config.PERSONAL_SYNC_BACKEND = detected;
          this.atomicWrite(this.configPath, JSON.stringify(config, null, 2));
          this.logBackup('INFO', `Auto-detected sync backend: ${detected}`, 'sync.health');
        } catch {}
      } else {
        warnings.push('PERSONAL:NOT_CONFIGURED');
      }
    } else {
      // Check if last sync is stale (>24 hours)
      try {
        const markerText = fs.readFileSync(this.syncMarkerPath, 'utf8').trim();
        const lastEpoch = parseInt(markerText, 10);
        if (!isNaN(lastEpoch)) {
          const age = Math.floor(Date.now() / 1000) - lastEpoch;
          if (age >= 86400) {
            warnings.push('PERSONAL:STALE');
          }
        }
      } catch {
        // No marker file — first run, not stale
      }
    }

    // 2. Unrouted user skills (not toolkit symlinks, not in skill-routes.json)
    const unroutedSkills = this.findUnroutedSkills();
    if (unroutedSkills.length > 0) {
      warnings.push(`SKILLS:unrouted:${unroutedSkills.join(',')}`);
    }

    // 3. Unsynced projects — discover git repos not tracked
    const discoveredProjects = this.discoverProjects();
    if (discoveredProjects.length > 0) {
      // Write discovered paths for /sync skill to consume
      const unsyncedFile = path.join(this.claudeDir, '.unsynced-projects');
      this.atomicWrite(unsyncedFile, discoveredProjects.join('\n'));
      warnings.push(`PROJECTS:${discoveredProjects.length}`);
    } else {
      // Clean up stale file
      try { fs.unlinkSync(path.join(this.claudeDir, '.unsynced-projects')); } catch {}
    }

    // Write warnings file (or remove if empty)
    if (warnings.length > 0) {
      fs.writeFileSync(warningsFile, warnings.join('\n') + '\n');
    } else {
      try { fs.unlinkSync(warningsFile); } catch {}
    }

    return warnings;
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
        const destinclaude = path.join(candidate, 'DestinClaude');
        if (this.dirExists(path.join(claudeDir, 'Backup')) || this.dirExists(destinclaude)) {
          return 'icloud';
        }
      }
    }

    return null;
  }

  /**
   * Find user-created skills that are not routed in skill-routes.json.
   * Skips toolkit-owned skills (symlinks into TOOLKIT_ROOT) and toolkit
   * copies (matching skill name exists in toolkit layers).
   */
  private findUnroutedSkills(): string[] {
    const skillsDir = path.join(this.claudeDir, 'skills');
    if (!this.dirExists(skillsDir)) return [];

    const routesFile = path.join(this.claudeDir, 'toolkit-state', 'skill-routes.json');
    const routes = this.readJson(routesFile) || {};
    const toolkitRoot = this.configGet('toolkit_root', '');
    const toolkitLayers = ['core/skills', 'productivity/skills', 'life/skills'];

    const unrouted: string[] = [];

    for (const skillName of fs.readdirSync(skillsDir)) {
      const skillDir = path.join(skillsDir, skillName);
      if (!this.dirExists(skillDir)) continue;

      // Skip symlinks (toolkit-managed)
      try { if (fs.lstatSync(skillDir).isSymbolicLink()) continue; } catch { continue; }

      // Skip if it's a copy of a toolkit skill
      if (toolkitRoot) {
        let isToolkitCopy = false;
        for (const layer of toolkitLayers) {
          if (this.dirExists(path.join(toolkitRoot, layer, skillName))) {
            isToolkitCopy = true;
            break;
          }
        }
        if (isToolkitCopy) continue;
      }

      // Skip if already routed (any route means it's accounted for)
      if (routes[skillName]?.route) continue;

      unrouted.push(skillName);
    }

    return unrouted;
  }

  /**
   * Discover git repos in common directories that aren't tracked.
   * Ports backup-common.sh discover_projects().
   */
  private discoverProjects(): string[] {
    const trackedFile = path.join(this.claudeDir, 'tracked-projects.json');
    const tracked = this.readJson(trackedFile) || {};

    // Build skip set from tracked + ignored projects
    const skipPaths = new Set<string>();
    skipPaths.add(path.resolve(this.claudeDir));
    for (const p of (tracked.projects || [])) {
      if (p.path) skipPaths.add(path.resolve(p.path));
    }
    for (const p of (tracked.ignored || [])) {
      skipPaths.add(path.resolve(p));
    }

    // Scan common directories (depth 1)
    const scanDirs = ['projects', 'repos', 'code', 'dev', 'src', 'Documents', 'Desktop']
      .map(d => path.join(os.homedir(), d))
      .filter(d => this.dirExists(d));

    const discovered: string[] = [];

    for (const scanDir of scanDirs) {
      try {
        for (const entry of fs.readdirSync(scanDir)) {
          const candidate = path.join(scanDir, entry);
          if (!this.dirExists(candidate)) continue;
          if (!this.dirExists(path.join(candidate, '.git'))) continue;

          const resolved = path.resolve(candidate);
          if (skipPaths.has(resolved)) continue;

          discovered.push(resolved);
        }
      } catch {}
    }

    return discovered;
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

  // =========================================================================
  // Session-End Push
  // =========================================================================

  /** Push a single session's JSONL to all sync-enabled backends (called on session close). */
  async pushSession(sessionId: string): Promise<void> {
    const slug = this.getCurrentSlug();
    const jsonlFile = path.join(this.claudeDir, 'projects', slug, `${sessionId}.jsonl`);
    if (!this.fileExists(jsonlFile)) return;

    // Update conversation index first
    this.updateConversationIndex();

    // Only push to sync-enabled backends (storage-only backends skip session-end sync)
    const instances = this.getSyncEnabledBackends();

    for (const instance of instances) {
      try {
        switch (instance.type) {
          case 'drive': {
            const rcloneRemote = instance.config.rcloneRemote || 'gdrive';
            const driveRoot = instance.config.DRIVE_ROOT || 'Claude';
            await this.rclone(['copy', jsonlFile, `${rcloneRemote}:${driveRoot}/Backup/personal/conversations/${slug}/`, '--checksum']);
            // Also push conversation index
            if (this.fileExists(this.conversationIndexPath)) {
              await this.rclone(['copyto', this.conversationIndexPath, `${rcloneRemote}:${driveRoot}/Backup/system-backup/conversation-index.json`, '--checksum']);
            }
            break;
          }
          case 'github': {
            // Per-instance repo directory
            const repoDir = path.join(this.claudeDir, 'toolkit-state', `personal-sync-repo-${instance.id}`);
            if (!this.dirExists(path.join(repoDir, '.git'))) break;
            const convDir = path.join(repoDir, 'conversations', slug);
            fs.mkdirSync(convDir, { recursive: true });
            fs.copyFileSync(jsonlFile, path.join(convDir, `${sessionId}.jsonl`));
            if (this.fileExists(this.conversationIndexPath)) {
              fs.mkdirSync(path.join(repoDir, 'system-backup'), { recursive: true });
              fs.copyFileSync(this.conversationIndexPath, path.join(repoDir, 'system-backup', 'conversation-index.json'));
            }
            await this.gitExec(['add', '-A'], repoDir);
            const diff = await this.gitExec(['diff', '--cached', '--quiet'], repoDir);
            if (diff.code !== 0) {
              await this.gitExec(['commit', '-m', 'auto: session-end sync', '--no-gpg-sign'], repoDir);
              await this.gitExec(['push', 'personal-sync', 'main'], repoDir);
            }
            break;
          }
          case 'icloud': {
            const icloudPath = this.resolveICloudPath(instance);
            if (!icloudPath) break;
            const convDir = path.join(icloudPath, 'conversations', slug);
            fs.mkdirSync(convDir, { recursive: true });
            fs.copyFileSync(jsonlFile, path.join(convDir, `${sessionId}.jsonl`));
            if (this.fileExists(this.conversationIndexPath)) {
              fs.mkdirSync(path.join(icloudPath, 'system-backup'), { recursive: true });
              fs.copyFileSync(this.conversationIndexPath, path.join(icloudPath, 'system-backup', 'conversation-index.json'));
            }
            break;
          }
        }
      } catch (e) {
        this.logBackup('WARN', `Session-end ${instance.id} sync failed: ${e}`, 'sync.sessionend');
      }
    }

    this.logBackup('INFO', `Session-end sync for ${sessionId.slice(0, 8)}`, 'sync.sessionend');
  }
}
