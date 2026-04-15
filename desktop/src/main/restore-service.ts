/**
 * restore-service.ts — Directional, user-initiated restore from a cloud backup.
 *
 * This is NOT sync. Sync is bidirectional merge; restore is a one-time pull
 * where the remote is treated as authoritative. Different invariants, different
 * code path (see RESTORE-FROM-BACKUP-DESIGN.md in the workspace docs).
 *
 * Safety invariants (enforced here, not in docs):
 *   1. Snapshot-first by default — current local data is copied to
 *      ~/.claude/restore-snapshots/<ISO>/ before any overwrite.
 *   2. Push loop paused — SyncService.restoreInProgress is flipped true during
 *      execute so the 15-minute push doesn't upload half-restored state.
 *   3. Atomic per-category — each category is staged under
 *      ~/.claude/.restore-staging/<category>/, then the live dir is swapped
 *      in via rename. A crash leaves either the old or new dir, never a mix.
 *
 * Retention: snapshots older than 90 days are pruned on app start; cap 10.
 * Progress events are throttled to 250ms per category to avoid flooding the
 * Android WebSocket bridge.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { SyncService } from './sync-service';
import type { BackendInstance } from './sync-state';
import type {
  RestoreCategory,
  RestorePoint,
  RestoreOptions,
  RestorePreview,
  CategoryPreview,
  RestoreResult,
  Snapshot,
  RestoreProgressEvent,
} from '../shared/types';

const execFileP = promisify(execFile);

const SNAPSHOT_RETENTION_DAYS = 90;
const SNAPSHOT_CAP = 10;
const PROGRESS_THROTTLE_MS = 250;

export const RESTORE_CATEGORIES: RestoreCategory[] = [
  'memory',
  'conversations',
  'encyclopedia',
  'skills',
  'plans',
  'specs',
];

export interface RestoreAdapter {
  listVersions(): Promise<RestorePoint[]>;
  previewCategory(category: RestoreCategory, versionRef: string): Promise<CategoryPreview>;
  fetchInto(
    category: RestoreCategory,
    stagingDir: string,
    versionRef: string,
    onFile?: (filename: string, done: number, total: number) => void,
  ): Promise<void>;
  probe(): Promise<{ hasData: boolean; categories: RestoreCategory[] }>;
  /** Optional — when present, returns a URL that opens this category's remote
   *  browse view (e.g., Drive folder, GitHub tree). Used by the preview UI. */
  remoteBrowseUrlFor?(category: RestoreCategory, versionRef: string): Promise<string>;
}

export class RestoreService {
  private readonly claudeDir: string;
  private readonly snapshotsRoot: string;
  private readonly stagingRoot: string;

  constructor(
    private syncService: SyncService,
    private getBackendInstance: (id: string) => BackendInstance | null,
    userDataDir?: string,
  ) {
    // userDataDir is accepted for API symmetry with Electron's app.getPath('userData')
    // but all restore state lives in ~/.claude (portable across desktop/Android).
    void userDataDir;
    this.claudeDir = path.join(os.homedir(), '.claude');
    this.snapshotsRoot = path.join(this.claudeDir, 'restore-snapshots');
    this.stagingRoot = path.join(this.claudeDir, '.restore-staging');
  }

  // =========================================================================
  // Adapter dispatch
  // =========================================================================

  private adapterFor(backendId: string): RestoreAdapter {
    const instance = this.getBackendInstance(backendId);
    if (!instance) throw new Error(`No backend with id '${backendId}'`);
    switch (instance.type) {
      case 'drive':
        // Lazy require to keep this file loadable in environments where an adapter's
        // deps (e.g., rclone) aren't installed — only the requested backend's adapter runs.
        return new (require('./restore-adapters/drive').DriveRestoreAdapter)(instance, this.claudeDir);
      case 'github':
        return new (require('./restore-adapters/github').GithubRestoreAdapter)(instance, this.claudeDir);
      case 'icloud':
        return new (require('./restore-adapters/icloud').IcloudRestoreAdapter)(instance, this.claudeDir);
      default:
        throw new Error(`Unsupported backend type: ${(instance as any).type}`);
    }
  }

  // =========================================================================
  // Category path resolution
  // =========================================================================

  /**
   * Canonical live path for a category on disk. Memory and conversations use the
   * per-project tree at ~/.claude/projects/, the rest are flat subdirs.
   * The backup layout mirrors this exactly, so a dir-level swap is safe.
   */
  liveDirFor(category: RestoreCategory): string {
    switch (category) {
      case 'memory':
      case 'conversations':
        // Both categories live under ~/.claude/projects/<slug>/ — memory in
        // a memory/ subdir, conversations as .jsonl files. We swap the whole
        // projects tree so partial-category restore across many projects
        // stays atomic. The adapter's fetchInto selects only the relevant
        // files into staging.
        return path.join(this.claudeDir, 'projects');
      case 'encyclopedia':
        return path.join(this.claudeDir, 'encyclopedia');
      case 'skills':
        return path.join(this.claudeDir, 'skills');
      case 'plans':
        return path.join(this.claudeDir, 'plans');
      case 'specs':
        return path.join(this.claudeDir, 'specs');
    }
  }

  stagingDirFor(category: RestoreCategory): string {
    return path.join(this.stagingRoot, category);
  }

  // =========================================================================
  // Public API
  // =========================================================================

  async probe(backendId: string): Promise<{ hasData: boolean; categories: RestoreCategory[] }> {
    try {
      return await this.adapterFor(backendId).probe();
    } catch {
      return { hasData: false, categories: [] };
    }
  }

  async listVersions(backendId: string): Promise<RestorePoint[]> {
    return this.adapterFor(backendId).listVersions();
  }

  async previewRestore(opts: RestoreOptions): Promise<RestorePreview> {
    const adapter = this.adapterFor(opts.backendId);
    const warnings: string[] = [];

    // Run category previews in parallel — each adapter call is a separate
    // rclone/git invocation so they don't contend on local CPU. Sequential
    // was making 6 categories feel like a minute+ on Drive because each
    // rclone lsjson spends most of its time on network latency.
    const raw: CategoryPreview[] = await Promise.all(
      opts.categories.map(async (category) => {
        try {
          return await adapter.previewCategory(category, opts.versionRef);
        } catch (e: any) {
          warnings.push(`Preview failed for ${category}: ${e?.message || e}`);
          return {
            category,
            remoteFiles: 0,
            localFiles: 0,
            toAdd: 0,
            toOverwrite: 0,
            toDelete: 0,
            bytes: 0,
          };
        }
      }),
    );

    // For merge mode, reinterpret the same raw counts:
    //   - toDelete=0 (merge never deletes; those files will stay + be uploaded)
    //   - toUpload = original toDelete (they go up to the backup instead of away)
    // Wipe keeps the as-measured shape.
    const perCategory: CategoryPreview[] = raw.map((p) =>
      opts.mode === 'merge'
        ? { ...p, toUpload: p.toDelete, toDelete: 0 }
        : p,
    );

    const totalBytes = perCategory.reduce((sum, p) => sum + p.bytes, 0);

    if (opts.mode === 'wipe' && (opts.categories.includes('skills') || opts.categories.includes('memory'))) {
      warnings.push('Skills or memory restored — app restart recommended to pick up changes.');
    }
    if (opts.mode === 'wipe') {
      const anyDelete = perCategory.some((p) => p.toDelete > 0);
      if (anyDelete) {
        warnings.push('Wipe & restore will DELETE local files not present in the backup.');
      }
    }

    // Rough estimate: 10 MB/s effective throughput after overhead.
    const estimatedSeconds = Math.max(3, Math.ceil(totalBytes / (10 * 1024 * 1024)));

    return { perCategory, totalBytes, estimatedSeconds, warnings, mode: opts.mode };
  }

  /**
   * Resolve a browse URL for a single category on the remote backend.
   * Returns null if the adapter doesn't support browse links.
   */
  async browseCategoryUrl(backendId: string, category: RestoreCategory, versionRef: string): Promise<string | null> {
    const adapter = this.adapterFor(backendId);
    if (!adapter.remoteBrowseUrlFor) return null;
    try {
      return await adapter.remoteBrowseUrlFor(category, versionRef);
    } catch {
      return null;
    }
  }

  async executeRestore(
    opts: RestoreOptions,
    onProgress: (e: RestoreProgressEvent) => void,
  ): Promise<RestoreResult> {
    // Merge mode reuses the sync loop's pull + push (remote → local add/overwrite
    // with no deletions, then local → remote upload for anything local-only).
    // This is NON-destructive on both sides, so no snapshot is needed and we
    // don't flip restoreInProgress — we actually want pushBackend to run.
    if (opts.mode === 'merge') {
      return this.executeMerge(opts, onProgress);
    }
    return this.executeWipe(opts, onProgress);
  }

  private async executeMerge(
    opts: RestoreOptions,
    onProgress: (e: RestoreProgressEvent) => void,
  ): Promise<RestoreResult> {
    const startedAt = Date.now();

    // Emit a single 'fetching' phase for each category up-front so the UI
    // renders per-category rows. Merge doesn't stage per-category, so we don't
    // get file-level progress — just the two top-level phases (fetching, done).
    for (const category of opts.categories) {
      onProgress({ category, filesDone: 0, filesTotal: 0, phase: 'fetching' });
    }

    // Phase 1: pull remote → local (add + overwrite-newer, no deletions).
    await this.syncService.pull({ backendId: opts.backendId });

    // Phase 2: push local → remote (uploads anything local-only). `force: true`
    // so the push isn't skipped for being recent — the user just asked for a sync.
    await this.syncService.push({ backendId: opts.backendId, force: true });

    for (const category of opts.categories) {
      onProgress({ category, filesDone: 1, filesTotal: 1, phase: 'done' });
    }

    return {
      categoriesRestored: opts.categories,
      filesWritten: 0, // merge doesn't track per-file writes; sync-service logs it
      durationMs: Date.now() - startedAt,
      requiresRestart: opts.categories.includes('skills') || opts.categories.includes('memory'),
    };
  }

  private async executeWipe(
    opts: RestoreOptions,
    onProgress: (e: RestoreProgressEvent) => void,
  ): Promise<RestoreResult> {
    const startedAt = Date.now();
    const adapter = this.adapterFor(opts.backendId);

    this.syncService.restoreInProgress = true;
    let snapshotId: string | undefined;
    let filesWritten = 0;

    // Per-category throttle state for progress events.
    const lastEmitAt = new Map<RestoreCategory, number>();
    const emit = (evt: RestoreProgressEvent) => {
      const now = Date.now();
      const last = lastEmitAt.get(evt.category) ?? 0;
      // Always emit phase transitions; throttle file-level progress only.
      const isPhaseEvent = evt.phase !== 'fetching' && evt.phase !== 'staging';
      if (isPhaseEvent || now - last >= PROGRESS_THROTTLE_MS) {
        lastEmitAt.set(evt.category, now);
        onProgress(evt);
      }
    };

    try {
      fs.mkdirSync(this.stagingRoot, { recursive: true });
      fs.mkdirSync(this.snapshotsRoot, { recursive: true });

      // --- 1. Snapshot current local state ---
      if (opts.snapshotFirst) {
        snapshotId = this.isoStamp();
        const snapshotDir = path.join(this.snapshotsRoot, snapshotId);
        fs.mkdirSync(snapshotDir, { recursive: true });
        for (const category of opts.categories) {
          emit({ category, filesDone: 0, filesTotal: 0, phase: 'snapshotting' });
          const liveDir = this.liveDirFor(category);
          if (fs.existsSync(liveDir)) {
            const dest = path.join(snapshotDir, category);
            // cpSync recursive is the cheapest cross-platform deep copy; yields a
            // directory-structured snapshot (not a zip). Simpler, still undoable.
            fs.cpSync(liveDir, dest, { recursive: true, force: true });
          }
        }
        // Sidecar manifest for SnapshotsPanel.
        const manifest: Snapshot = {
          id: snapshotId,
          timestamp: Date.now(),
          categories: opts.categories,
          backendId: opts.backendId,
          sizeBytes: this.dirSize(snapshotDir),
          triggeredBy: 'restore',
        };
        fs.writeFileSync(path.join(snapshotDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      }

      // --- 2. Fetch each category into staging, then swap ---
      for (const category of opts.categories) {
        emit({ category, filesDone: 0, filesTotal: 0, phase: 'fetching' });
        const staging = this.stagingDirFor(category);
        // Clean any staging remnant from a prior crashed run.
        try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
        fs.mkdirSync(staging, { recursive: true });

        await adapter.fetchInto(category, staging, opts.versionRef, (filename, done, total) => {
          filesWritten++;
          emit({ category, filesDone: done, filesTotal: total, currentFile: filename, phase: 'staging' });
        });

        emit({ category, filesDone: 1, filesTotal: 1, phase: 'swapping' });
        this.atomicSwap(staging, this.liveDirFor(category));
        emit({ category, filesDone: 1, filesTotal: 1, phase: 'done' });
      }

      return {
        snapshotId,
        categoriesRestored: opts.categories,
        filesWritten,
        durationMs: Date.now() - startedAt,
        requiresRestart: opts.categories.includes('skills') || opts.categories.includes('memory'),
      };
    } finally {
      this.syncService.restoreInProgress = false;
      // Best-effort staging cleanup. Orphaned dirs are also swept on app start.
      try { fs.rmSync(this.stagingRoot, { recursive: true, force: true }); } catch {}
    }
  }

  async listSnapshots(): Promise<Snapshot[]> {
    if (!fs.existsSync(this.snapshotsRoot)) return [];
    const entries = fs.readdirSync(this.snapshotsRoot, { withFileTypes: true });
    const snapshots: Snapshot[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const manifestPath = path.join(this.snapshotsRoot, e.name, 'manifest.json');
      try {
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Snapshot;
        snapshots.push(m);
      } catch {
        // Missing manifest (older/partial snapshot) — synthesize minimal metadata.
        snapshots.push({
          id: e.name,
          timestamp: this.parseIsoStamp(e.name),
          categories: [],
          backendId: '',
          sizeBytes: 0,
          triggeredBy: 'manual',
        });
      }
    }
    return snapshots.sort((a, b) => b.timestamp - a.timestamp);
  }

  async undoRestore(snapshotId: string): Promise<void> {
    const snapshotDir = path.join(this.snapshotsRoot, snapshotId);
    if (!fs.existsSync(snapshotDir)) throw new Error(`Snapshot ${snapshotId} not found`);
    const manifestPath = path.join(snapshotDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Snapshot;

    this.syncService.restoreInProgress = true;
    try {
      for (const category of manifest.categories) {
        const source = path.join(snapshotDir, category);
        if (!fs.existsSync(source)) continue;
        const staging = this.stagingDirFor(category);
        try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
        fs.mkdirSync(path.dirname(staging), { recursive: true });
        fs.cpSync(source, staging, { recursive: true, force: true });
        this.atomicSwap(staging, this.liveDirFor(category));
      }
    } finally {
      this.syncService.restoreInProgress = false;
      try { fs.rmSync(this.stagingRoot, { recursive: true, force: true }); } catch {}
    }
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    const snapshotDir = path.join(this.snapshotsRoot, snapshotId);
    if (fs.existsSync(snapshotDir)) {
      fs.rmSync(snapshotDir, { recursive: true, force: true });
    }
  }

  // =========================================================================
  // Lifecycle hooks called from main.ts on startup
  // =========================================================================

  /**
   * Delete orphaned staging directories left behind by a crashed restore.
   * Safe to call on every launch — no-op if stagingRoot is missing.
   */
  cleanupOrphanedStaging(): void {
    try {
      if (fs.existsSync(this.stagingRoot)) {
        fs.rmSync(this.stagingRoot, { recursive: true, force: true });
      }
    } catch {}
  }

  /**
   * Enforce retention: delete snapshots older than SNAPSHOT_RETENTION_DAYS,
   * then cap total count at SNAPSHOT_CAP (oldest pruned first).
   */
  enforceRetention(): void {
    try {
      if (!fs.existsSync(this.snapshotsRoot)) return;
      const cutoff = Date.now() - SNAPSHOT_RETENTION_DAYS * 86400_000;
      const entries = fs.readdirSync(this.snapshotsRoot, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => ({ name: e.name, ts: this.parseIsoStamp(e.name) }))
        .sort((a, b) => a.ts - b.ts);

      for (const e of entries) {
        if (e.ts < cutoff) {
          try { fs.rmSync(path.join(this.snapshotsRoot, e.name), { recursive: true, force: true }); } catch {}
        }
      }
      // Recompute after age cull, then enforce cap.
      const remaining = fs.readdirSync(this.snapshotsRoot, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => ({ name: e.name, ts: this.parseIsoStamp(e.name) }))
        .sort((a, b) => a.ts - b.ts);
      const overflow = remaining.length - SNAPSHOT_CAP;
      for (let i = 0; i < overflow; i++) {
        try { fs.rmSync(path.join(this.snapshotsRoot, remaining[i].name), { recursive: true, force: true }); } catch {}
      }
    } catch {}
  }

  // =========================================================================
  // Internals
  // =========================================================================

  /**
   * Atomic swap of staging into live via .old intermediate.
   * On Windows, `fs.rename` across directories fails if the target exists, so
   * we rename live → live.old, staging → live, then delete live.old. On any
   * error, we roll back. This is the key safety primitive for restore.
   */
  private atomicSwap(stagingDir: string, liveDir: string): void {
    const oldDir = `${liveDir}.old.${Date.now()}`;
    const liveExists = fs.existsSync(liveDir);
    fs.mkdirSync(path.dirname(liveDir), { recursive: true });

    try {
      if (liveExists) fs.renameSync(liveDir, oldDir);
      fs.renameSync(stagingDir, liveDir);
    } catch (e) {
      // Rollback: if the second rename failed, put live back.
      if (liveExists && fs.existsSync(oldDir) && !fs.existsSync(liveDir)) {
        try { fs.renameSync(oldDir, liveDir); } catch {}
      }
      throw e;
    }

    if (liveExists) {
      try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch {
        // Leave .old for manual cleanup rather than fail the restore.
      }
    }
  }

  /** Filesystem-safe ISO-8601 timestamp (no colons). */
  private isoStamp(): string {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  private parseIsoStamp(s: string): number {
    const normal = s.replace(/-/g, (m, i) => (i > 10 ? ':' : '-')).replace(/-(\d{3})Z$/, '.$1Z');
    const t = Date.parse(normal);
    return isNaN(t) ? 0 : t;
  }

  private dirSize(dir: string): number {
    let total = 0;
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop()!;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        try {
          if (e.isDirectory()) stack.push(p);
          else if (e.isFile()) total += fs.statSync(p).size;
        } catch {}
      }
    }
    return total;
  }
}

// Module-level singleton — constructed once SyncService is ready (see main.ts).
// IPC handlers call getRestoreService() lazily because they're registered before
// SyncService.start() and the restore service needs a live sync service to pause
// the push loop during execute/undo.
let _restoreInstance: RestoreService | null = null;

export function initRestoreService(syncService: SyncService, userDataDir?: string): RestoreService {
  _restoreInstance = new RestoreService(
    syncService,
    (id) => syncService.getBackendById(id),
    userDataDir,
  );
  // Startup housekeeping — orphan cleanup from a prior crashed restore, and
  // age/count retention. Both are best-effort; failures don't block the app.
  _restoreInstance.cleanupOrphanedStaging();
  _restoreInstance.enforceRetention();
  return _restoreInstance;
}

export function getRestoreService(): RestoreService | null {
  return _restoreInstance;
}

// Shared helper for adapters: count files, bytes under a directory tree.
export function walkFiles(dir: string): { files: string[]; bytes: number } {
  const files: string[] = [];
  let bytes = 0;
  if (!fs.existsSync(dir)) return { files, bytes };
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile()) {
          files.push(path.relative(dir, p));
          bytes += fs.statSync(p).size;
        }
      } catch {}
    }
  }
  return { files, bytes };
}

// Exec helper re-exported for adapters to avoid pulling execFile each time.
export async function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileP(cmd, args, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs ?? 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout, stderr };
}
