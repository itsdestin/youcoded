/**
 * DriveRestoreAdapter — rclone-backed restore adapter for Google Drive.
 *
 * Layout MUST match what SyncService.pushDrive writes:
 *   Backup/personal/
 *     memory/<projectKey>/*                          ← memory category
 *     conversations/<slugName>/*.jsonl               ← conversations category
 *     encyclopedia/*.md                              ← encyclopedia category
 *     skills/<skillName>/*                           ← skills category
 *     system-backup/plans/*                          ← plans category
 *     system-backup/specs/*                          ← specs category
 *
 * Local layout (what we swap into) differs from remote for memory + conversations:
 *   ~/.claude/projects/<projectKey>/memory/*         ← memory lives inside a nested memory/ dir
 *   ~/.claude/projects/<slugName>/*.jsonl            ← conversations sit directly under the slug
 *
 * So fetchInto restructures files from remote-shape into local-shape as it
 * writes staging. previewCategory walks the same local paths so the delta is
 * computed against the exact files a subsequent swap would replace.
 *
 * Drive is HEAD-only (overwrite-in-place backend, no history). listVersions
 * returns a single "Current backup" entry.
 */

import path from 'path';
import fs from 'fs';
import { BackendInstance } from '../sync-state';
import type { RestoreAdapter } from '../restore-service';
import { walkFiles, run } from '../restore-service';
import type { RestoreCategory, RestorePoint, CategoryPreview } from '../../shared/types';

export class DriveRestoreAdapter implements RestoreAdapter {
  private readonly rcloneRemote: string;
  private readonly driveRoot: string;
  private readonly remoteBase: string;

  constructor(private instance: BackendInstance, private claudeDir: string) {
    this.rcloneRemote = instance.config.rcloneRemote || 'gdrive';
    this.driveRoot = instance.config.DRIVE_ROOT || 'Claude';
    this.remoteBase = `${this.rcloneRemote}:${this.driveRoot}/Backup/personal`;
  }

  /** Remote subpath under `Backup/personal/` for a category. */
  private remoteCategoryPath(category: RestoreCategory): string {
    switch (category) {
      case 'memory': return `${this.remoteBase}/memory`;
      case 'conversations': return `${this.remoteBase}/conversations`;
      case 'encyclopedia': return `${this.remoteBase}/encyclopedia`;
      case 'skills': return `${this.remoteBase}/skills`;
      case 'plans': return `${this.remoteBase}/system-backup/plans`;
      case 'specs': return `${this.remoteBase}/system-backup/specs`;
    }
  }

  /** Deep-link / browse URL for a category on Google Drive. */
  async remoteBrowseUrlFor(category: RestoreCategory): Promise<string> {
    const segments = this.remoteCategoryPath(category)
      .replace(`${this.rcloneRemote}:`, '')
      .split('/')
      .filter(Boolean);
    const parentPath = `${this.rcloneRemote}:${segments.slice(0, -1).join('/')}`;
    const targetName = segments[segments.length - 1];
    const fallback = 'https://drive.google.com';
    try {
      const { stdout } = await run(
        'rclone',
        ['lsjson', parentPath, '--dirs-only'],
        { timeoutMs: 15_000 },
      );
      const entries = JSON.parse(stdout) as Array<{ Name: string; ID?: string }>;
      const match = entries.find((e) => e.Name === targetName && e.ID);
      return match?.ID ? `https://drive.google.com/drive/folders/${match.ID}` : fallback;
    } catch {
      return fallback;
    }
  }

  async listVersions(): Promise<RestorePoint[]> {
    return [{ ref: 'HEAD', timestamp: Date.now(), label: 'Current backup' }];
  }

  async probe(): Promise<{ hasData: boolean; categories: RestoreCategory[] }> {
    const categories: RestoreCategory[] = [];
    try {
      // Walk Backup/personal/ one level deep — matches the push layout.
      const { stdout } = await run(
        'rclone',
        ['lsjson', this.remoteBase, '--dirs-only'],
        { timeoutMs: 30_000 },
      );
      const personalDirs = new Set(
        (JSON.parse(stdout) as Array<{ Name: string; IsDir: boolean }>)
          .filter((e) => e.IsDir)
          .map((e) => e.Name),
      );
      if (personalDirs.has('memory')) categories.push('memory');
      if (personalDirs.has('conversations')) categories.push('conversations');
      if (personalDirs.has('encyclopedia')) categories.push('encyclopedia');
      if (personalDirs.has('skills')) categories.push('skills');

      // plans / specs live one level deeper under system-backup/.
      if (personalDirs.has('system-backup')) {
        try {
          const { stdout: sysOut } = await run(
            'rclone',
            ['lsjson', `${this.remoteBase}/system-backup`, '--dirs-only'],
            { timeoutMs: 15_000 },
          );
          const sysDirs = new Set(
            (JSON.parse(sysOut) as Array<{ Name: string }>).map((e) => e.Name),
          );
          if (sysDirs.has('plans')) categories.push('plans');
          if (sysDirs.has('specs')) categories.push('specs');
        } catch {}
      }
    } catch {
      return { hasData: false, categories: [] };
    }
    return { hasData: categories.length > 0, categories };
  }

  /**
   * Map a remote relative path (as returned by rclone lsjson) to the
   * corresponding LOCAL relative path under the category's liveDir.
   *
   * For memory the remote shape is `<projectKey>/<rest>` but locally we
   * expect `<projectKey>/memory/<rest>` — so we inject 'memory/' after the
   * first path segment. Same idea inverted for conversations (already flat).
   */
  private toLocalRel(category: RestoreCategory, remoteRel: string): string {
    const norm = remoteRel.replace(/\\/g, '/');
    if (category === 'memory') {
      const idx = norm.indexOf('/');
      if (idx < 0) return norm; // shouldn't happen, defensive
      return `${norm.slice(0, idx)}/memory/${norm.slice(idx + 1)}`;
    }
    // All other categories are shape-identical between remote and local.
    return norm;
  }

  /**
   * Walk the local files a category owns, returning them as relative paths
   * that match toLocalRel(remoteRel) above. Used for preview delta math.
   */
  private walkLocalCategory(category: RestoreCategory): { files: string[]; bytes: number } {
    const projectsDir = path.join(this.claudeDir, 'projects');
    const out: { files: string[]; bytes: number } = { files: [], bytes: 0 };

    if (category === 'memory') {
      // Walk ~/.claude/projects/<key>/memory/ for every project key.
      if (!fs.existsSync(projectsDir)) return out;
      for (const key of fs.readdirSync(projectsDir)) {
        const memDir = path.join(projectsDir, key, 'memory');
        if (!fs.existsSync(memDir)) continue;
        const walked = walkFiles(memDir);
        for (const f of walked.files) out.files.push(`${key}/memory/${f.replace(/\\/g, '/')}`);
        out.bytes += walked.bytes;
      }
      return out;
    }
    if (category === 'conversations') {
      if (!fs.existsSync(projectsDir)) return out;
      for (const slug of fs.readdirSync(projectsDir)) {
        const slugDir = path.join(projectsDir, slug);
        if (!fs.statSync(slugDir).isDirectory()) continue;
        // Only top-level .jsonl files — subdirs (like memory/) belong to other categories.
        for (const entry of fs.readdirSync(slugDir)) {
          if (!entry.endsWith('.jsonl')) continue;
          const full = path.join(slugDir, entry);
          try {
            if (fs.lstatSync(full).isFile()) {
              out.files.push(`${slug}/${entry}`);
              out.bytes += fs.statSync(full).size;
            }
          } catch {}
        }
      }
      return out;
    }
    // Flat categories: walk the category's live dir directly.
    const liveDir = path.join(this.claudeDir,
      category === 'plans' ? 'plans' :
      category === 'specs' ? 'specs' :
      category === 'encyclopedia' ? 'encyclopedia' :
      'skills',
    );
    return walkFiles(liveDir);
  }

  async previewCategory(category: RestoreCategory, _versionRef: string): Promise<CategoryPreview> {
    const remote = this.remoteCategoryPath(category);

    // Remote file map: local-relative-path → size. Transform rclone's remote-shape
    // paths into local-shape so deltas compare apples to apples.
    const remoteFiles = new Map<string, number>();
    try {
      const { stdout } = await run(
        'rclone',
        ['lsjson', remote, '--recursive', '--files-only'],
        { timeoutMs: 60_000 },
      );
      const entries = JSON.parse(stdout) as Array<{ Path: string; Size: number }>;
      for (const e of entries) {
        remoteFiles.set(this.toLocalRel(category, e.Path), e.Size);
      }
    } catch {
      // Remote missing/empty — treat as zero-file backup.
    }

    const localWalk = this.walkLocalCategory(category);
    const localSet = new Set(localWalk.files.map((f) => f.replace(/\\/g, '/')));
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
    // memory + conversations — restructure while copying so staging holds
    // the local-shape tree the atomic swap expects.
    if (category === 'memory') {
      // rclone copy with --drive-flatten not sensible; just pull the tree, then
      // restructure with fs moves. Small number of files per project key.
      const tmp = path.join(stagingDir, '__raw_memory');
      fs.mkdirSync(tmp, { recursive: true });
      await run(
        'rclone',
        ['copy', this.remoteCategoryPath('memory') + '/', tmp + '/', '--create-empty-src-dirs'],
        { timeoutMs: 300_000 },
      );
      // tmp/<projectKey>/<rest> → stagingDir/<projectKey>/memory/<rest>
      for (const key of fs.readdirSync(tmp)) {
        const src = path.join(tmp, key);
        if (!fs.statSync(src).isDirectory()) continue;
        const dest = path.join(stagingDir, key, 'memory');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.cpSync(src, dest, { recursive: true });
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    } else if (category === 'conversations') {
      // Remote shape <slug>/*.jsonl lines up 1:1 with local shape — straight copy.
      await run(
        'rclone',
        ['copy', this.remoteCategoryPath('conversations') + '/', stagingDir + '/', '--create-empty-src-dirs'],
        { timeoutMs: 300_000 },
      );
    } else {
      // Flat categories — shape unchanged, single rclone copy.
      await run(
        'rclone',
        ['copy', this.remoteCategoryPath(category) + '/', stagingDir + '/', '--create-empty-src-dirs'],
        { timeoutMs: 300_000 },
      );
    }

    if (onFile) {
      const walk = walkFiles(stagingDir);
      onFile('', walk.files.length, walk.files.length);
    }
  }
}
