/**
 * DriveRestoreAdapter — rclone-backed restore adapter for Google Drive.
 *
 * Drive is HEAD-only (overwrite-in-place backend, no history). listVersions()
 * returns a single "Current backup" entry. fetchInto() shells out to
 * `rclone sync` which gives us directional semantics (remote → local) — exactly
 * what restore needs, unlike `rclone copy --update` used by the sync push loop.
 */

import path from 'path';
import { BackendInstance } from '../sync-state';
import type { RestoreAdapter } from '../restore-service';
import { walkFiles, run } from '../restore-service';
import type { RestoreCategory, RestorePoint, CategoryPreview } from '../../shared/types';

export class DriveRestoreAdapter implements RestoreAdapter {
  private readonly rcloneRemote: string;
  private readonly driveRoot: string;

  constructor(private instance: BackendInstance, private claudeDir: string) {
    this.rcloneRemote = instance.config.rcloneRemote || 'gdrive';
    this.driveRoot = instance.config.DRIVE_ROOT || 'Claude';
  }

  private remotePath(category: RestoreCategory): string {
    return `${this.rcloneRemote}:${this.driveRoot}/${this.categoryRemoteSubpath(category)}`;
  }

  /** Mirror the layout SyncService.pushDrive uses. */
  private categoryRemoteSubpath(category: RestoreCategory): string {
    switch (category) {
      case 'memory':
      case 'conversations':
        return 'projects';
      case 'encyclopedia': return 'encyclopedia';
      case 'skills': return 'skills';
      case 'plans': return 'plans';
      case 'specs': return 'specs';
    }
  }

  async listVersions(): Promise<RestorePoint[]> {
    return [{ ref: 'HEAD', timestamp: Date.now(), label: 'Current backup' }];
  }

  async probe(): Promise<{ hasData: boolean; categories: RestoreCategory[] }> {
    const categories: RestoreCategory[] = [];
    try {
      const { stdout } = await run('rclone', ['lsjson', `${this.rcloneRemote}:${this.driveRoot}`, '--max-depth', '1'], { timeoutMs: 30_000 });
      const entries: Array<{ Name: string; IsDir: boolean }> = JSON.parse(stdout);
      const names = new Set(entries.filter(e => e.IsDir).map(e => e.Name));
      if (names.has('projects')) { categories.push('memory'); categories.push('conversations'); }
      if (names.has('encyclopedia')) categories.push('encyclopedia');
      if (names.has('skills')) categories.push('skills');
      if (names.has('plans')) categories.push('plans');
      if (names.has('specs')) categories.push('specs');
    } catch {
      return { hasData: false, categories: [] };
    }
    return { hasData: categories.length > 0, categories };
  }

  async previewCategory(category: RestoreCategory, _versionRef: string): Promise<CategoryPreview> {
    const remote = this.remotePath(category);
    const local = path.join(this.claudeDir, this.categoryRemoteSubpath(category));

    let remoteFiles = new Map<string, number>(); // path → size
    try {
      const { stdout } = await run('rclone', ['lsjson', remote, '--recursive', '--files-only'], { timeoutMs: 60_000 });
      const entries: Array<{ Path: string; Size: number }> = JSON.parse(stdout);
      for (const e of entries) remoteFiles.set(e.Path, e.Size);
    } catch {
      // Remote missing/empty — treat as zero-file backup so the user sees a clear delta.
    }

    const localWalk = walkFiles(local);
    const localSet = new Set(localWalk.files.map(f => f.replace(/\\/g, '/')));
    const remoteSet = new Set(remoteFiles.keys());

    let toAdd = 0, toOverwrite = 0, bytes = 0;
    for (const [p, sz] of remoteFiles) {
      if (localSet.has(p)) toOverwrite++;
      else toAdd++;
      bytes += sz;
    }
    let toDelete = 0;
    for (const p of localSet) if (!remoteSet.has(p)) toDelete++;

    return {
      category,
      remoteFiles: remoteFiles.size,
      localFiles: localWalk.files.length,
      toAdd,
      toOverwrite,
      toDelete,
      bytes,
    };
  }

  async fetchInto(
    category: RestoreCategory,
    stagingDir: string,
    _versionRef: string,
    onFile?: (filename: string, done: number, total: number) => void,
  ): Promise<void> {
    const remote = this.remotePath(category);
    // rclone sync: destructive mirror from remote → staging. --create-empty-src-dirs
    // preserves empty category layout (memory subdirs often empty on fresh projects).
    await run('rclone', ['sync', remote, stagingDir, '--create-empty-src-dirs', '--stats-one-line'], { timeoutMs: 300_000 });

    // Emit one terminal progress event so the UI flips from staging → swapping.
    if (onFile) {
      const walk = walkFiles(stagingDir);
      onFile('', walk.files.length, walk.files.length);
    }
  }
}
