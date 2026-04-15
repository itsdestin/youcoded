/**
 * IcloudRestoreAdapter — rsync-backed restore adapter for iCloud.
 *
 * iCloud is HEAD-only (filesystem mirror, no history). We walk the local mount
 * for preview and use rsync --delete into staging for execute. Critical
 * detail: rsync is invoked per-category with explicit `src/` → `dst/` pairs.
 * Never rsync the parent with --delete — that would nuke unrelated categories.
 */

import fs from 'fs';
import path from 'path';
import { BackendInstance } from '../sync-state';
import type { RestoreAdapter } from '../restore-service';
import { walkFiles, run } from '../restore-service';
import type { RestoreCategory, RestorePoint, CategoryPreview } from '../../shared/types';

export class IcloudRestoreAdapter implements RestoreAdapter {
  private readonly icloudRoot: string;

  constructor(private instance: BackendInstance, private claudeDir: string) {
    // iCloud mount path comes from per-instance config (user-chosen during setup).
    this.icloudRoot = instance.config.ICLOUD_ROOT || instance.config.icloudPath || '';
  }

  private categorySubpath(category: RestoreCategory): string {
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

  private remoteDir(category: RestoreCategory): string {
    return path.join(this.icloudRoot, this.categorySubpath(category));
  }

  async listVersions(): Promise<RestorePoint[]> {
    return [{ ref: 'HEAD', timestamp: Date.now(), label: 'Current backup' }];
  }

  async remoteBrowseUrlFor(category: RestoreCategory, _versionRef: string): Promise<string> {
    // iCloud is a local mount — return a file:// URL so shell.openExternal
    // pops Finder/Explorer at that folder.
    return 'file://' + this.remoteDir(category).replace(/\\/g, '/');
  }

  async probe(): Promise<{ hasData: boolean; categories: RestoreCategory[] }> {
    if (!this.icloudRoot || !fs.existsSync(this.icloudRoot)) return { hasData: false, categories: [] };
    const categories: RestoreCategory[] = [];
    try {
      const entries = fs.readdirSync(this.icloudRoot, { withFileTypes: true });
      const names = new Set(entries.filter(e => e.isDirectory()).map(e => e.name));
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
    const remote = this.remoteDir(category);
    const local = path.join(this.claudeDir, this.categorySubpath(category));

    const remoteWalk = walkFiles(remote);
    const localWalk = walkFiles(local);
    const remoteSet = new Set(remoteWalk.files.map(f => f.replace(/\\/g, '/')));
    const localSet = new Set(localWalk.files.map(f => f.replace(/\\/g, '/')));

    let toAdd = 0, toOverwrite = 0;
    for (const p of remoteSet) {
      if (localSet.has(p)) toOverwrite++;
      else toAdd++;
    }
    let toDelete = 0;
    for (const p of localSet) if (!remoteSet.has(p)) toDelete++;

    return {
      category,
      remoteFiles: remoteWalk.files.length,
      localFiles: localWalk.files.length,
      toAdd,
      toOverwrite,
      toDelete,
      bytes: remoteWalk.bytes,
    };
  }

  async fetchInto(
    category: RestoreCategory,
    stagingDir: string,
    _versionRef: string,
    onFile?: (filename: string, done: number, total: number) => void,
  ): Promise<void> {
    const remote = this.remoteDir(category);
    if (!fs.existsSync(remote)) {
      // Nothing to fetch — leave staging empty; caller's atomic swap produces an empty live dir.
      return;
    }

    // Trailing slashes are critical — without them rsync copies the remote
    // directory *into* stagingDir instead of *replacing* its contents.
    const src = remote.endsWith(path.sep) ? remote : remote + path.sep;
    const dst = stagingDir.endsWith(path.sep) ? stagingDir : stagingDir + path.sep;
    await run('rsync', ['-a', '--delete', src, dst], { timeoutMs: 600_000 });

    if (onFile) {
      const walk = walkFiles(stagingDir);
      onFile('', walk.files.length, walk.files.length);
    }
  }
}
