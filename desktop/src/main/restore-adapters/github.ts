/**
 * GithubRestoreAdapter — git-backed restore adapter with point-in-time support.
 *
 * This is the novel adapter. Drive/iCloud are overwrite-in-place and only
 * expose HEAD. GitHub backends maintain full commit history in the local
 * repo clone at ~/.claude/toolkit-state/personal-sync-repo-<backend-id>/,
 * so we surface it via `git log` and let the user restore to any past SHA.
 *
 * fetchInto uses `git --work-tree=<staging> checkout <sha> -- <cat>/` to
 * redirect file writes into staging without touching the repo's index. We
 * then `git reset HEAD -- <cat>/` to clean any index pollution that checkout
 * leaves behind.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { BackendInstance } from '../sync-state';
import type { RestoreAdapter } from '../restore-service';
import { walkFiles, run } from '../restore-service';
import type { RestoreCategory, RestorePoint, CategoryPreview } from '../../shared/types';

export class GithubRestoreAdapter implements RestoreAdapter {
  private readonly repoDir: string;

  constructor(private instance: BackendInstance, private claudeDir: string) {
    this.repoDir = path.join(claudeDir, 'toolkit-state', `personal-sync-repo-${instance.id}`);
  }

  private categoryRepoSubpath(category: RestoreCategory): string {
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

  async remoteBrowseUrlFor(category: RestoreCategory, versionRef: string): Promise<string> {
    // Resolve the sha or branch ref into a GitHub tree URL. Falls back to the
    // repo homepage if the configured URL isn't an https github URL.
    const base = (this.instance.config.PERSONAL_SYNC_REPO || '').replace(/\.git$/, '').replace(/\/$/, '');
    const sub = this.categoryRepoSubpath(category);
    const ref = versionRef === 'HEAD' ? 'main' : versionRef;
    if (/^https:\/\/github\.com\//i.test(base)) {
      return `${base}/tree/${ref}/${sub}`;
    }
    return base || 'https://github.com';
  }

  async listVersions(): Promise<RestorePoint[]> {
    if (!fs.existsSync(this.repoDir)) return [];
    const { stdout } = await run('git', ['-C', this.repoDir, 'log', '--format=%H%x09%ct%x09%s', '-n', '100'], { timeoutMs: 30_000 });
    const points: RestorePoint[] = [];
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      const [sha, ctStr, ...rest] = line.split('\t');
      const ts = parseInt(ctStr, 10) * 1000;
      const subject = rest.join('\t');
      points.push({
        ref: sha,
        timestamp: ts,
        label: this.relativeLabel(ts),
        summary: subject,
      });
    }
    return points;
  }

  async probe(): Promise<{ hasData: boolean; categories: RestoreCategory[] }> {
    if (!fs.existsSync(this.repoDir)) return { hasData: false, categories: [] };
    try {
      const { stdout } = await run('git', ['-C', this.repoDir, 'ls-tree', '--name-only', 'HEAD'], { timeoutMs: 15_000 });
      const dirs = new Set(stdout.split('\n').map(s => s.trim()).filter(Boolean));
      const categories: RestoreCategory[] = [];
      if (dirs.has('projects')) { categories.push('memory'); categories.push('conversations'); }
      if (dirs.has('encyclopedia')) categories.push('encyclopedia');
      if (dirs.has('skills')) categories.push('skills');
      if (dirs.has('plans')) categories.push('plans');
      if (dirs.has('specs')) categories.push('specs');
      return { hasData: categories.length > 0, categories };
    } catch {
      return { hasData: false, categories: [] };
    }
  }

  async previewCategory(category: RestoreCategory, versionRef: string): Promise<CategoryPreview> {
    const sub = this.categoryRepoSubpath(category);
    const liveDir = path.join(this.claudeDir, sub);
    const ref = versionRef === 'HEAD' ? 'HEAD' : versionRef;

    // Files in remote commit.
    let remoteFiles: string[] = [];
    let remoteBytes = 0;
    try {
      const { stdout } = await run('git', ['-C', this.repoDir, 'ls-tree', '-r', '--long', ref, '--', sub + '/'], { timeoutMs: 30_000 });
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        // Format: <mode> <type> <hash> <size>\t<path>
        const m = line.match(/^\S+\s+\S+\s+\S+\s+(\S+)\t(.+)$/);
        if (!m) continue;
        const size = parseInt(m[1], 10) || 0;
        const rel = m[2].substring(sub.length + 1);
        remoteFiles.push(rel);
        remoteBytes += size;
      }
    } catch {
      // ref/path not present — treat as empty remote.
    }

    const localWalk = walkFiles(liveDir);
    const remoteSet = new Set(remoteFiles.map(f => f.replace(/\\/g, '/')));
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
      remoteFiles: remoteFiles.length,
      localFiles: localWalk.files.length,
      toAdd,
      toOverwrite,
      toDelete,
      bytes: remoteBytes,
    };
  }

  async fetchInto(
    category: RestoreCategory,
    stagingDir: string,
    versionRef: string,
    onFile?: (filename: string, done: number, total: number) => void,
  ): Promise<void> {
    if (!fs.existsSync(this.repoDir)) throw new Error('GitHub sync repo missing — run a sync first');
    const sub = this.categoryRepoSubpath(category);
    const ref = versionRef === 'HEAD' ? 'HEAD' : versionRef;

    // Redirect git's file writes into staging via --work-tree. Staging dir
    // already exists (restore-service creates it). We need the relative subpath
    // to exist too because checkout writes into <work-tree>/<path>.
    const stagedCategoryDir = path.join(stagingDir, sub);
    fs.mkdirSync(stagedCategoryDir, { recursive: true });

    // --work-tree redirects writes; -- limits to the category subpath.
    await run('git', [
      '-C', this.repoDir,
      `--work-tree=${stagingDir}`,
      'checkout', ref, '--', sub + '/',
    ], { timeoutMs: 300_000 });

    // Clean index pollution from the diverted checkout. Without this, a
    // subsequent normal sync push would include stale staged entries.
    try {
      await run('git', ['-C', this.repoDir, 'reset', 'HEAD', '--', sub + '/'], { timeoutMs: 30_000 });
    } catch {}

    // staging/<sub>/* is the real data; lift it one level so the swap dirs match.
    // (liveDirFor returns ~/.claude/<sub>, staging should too.)
    const lifted = path.join(stagingDir, '__lift');
    fs.mkdirSync(lifted, { recursive: true });
    for (const entry of fs.readdirSync(stagedCategoryDir)) {
      fs.renameSync(path.join(stagedCategoryDir, entry), path.join(lifted, entry));
    }
    fs.rmSync(stagedCategoryDir, { recursive: true, force: true });
    for (const entry of fs.readdirSync(lifted)) {
      fs.renameSync(path.join(lifted, entry), path.join(stagingDir, entry));
    }
    fs.rmSync(lifted, { recursive: true, force: true });

    if (onFile) {
      const walk = walkFiles(stagingDir);
      onFile('', walk.files.length, walk.files.length);
    }
    void os; // reserved for future platform branching
  }

  // --- helpers ---

  private relativeLabel(ts: number): string {
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60_000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
    const d = Math.floor(hr / 24);
    if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
    return new Date(ts).toLocaleDateString();
  }
}
