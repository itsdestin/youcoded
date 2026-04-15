import fs from 'fs';
import path from 'path';
import os from 'os';
import { listInstalledPluginDirs } from './claude-code-registry';

/**
 * Symlink Cleanup (decomposition v3 follow-on)
 *
 * Pre-decomposition, the toolkit's post-update.sh created symlinks under
 * ~/.claude/{hooks,commands,skills}/ pointing into $TOOLKIT_ROOT/core/,
 * $TOOLKIT_ROOT/life/, and $TOOLKIT_ROOT/productivity/. The phase-3 flatten
 * deleted those subtrees, so existing installs have broken symlinks that
 * nothing currently cleans up. Claude Code v2.1+ doesn't read commands /
 * skills from these dirs (it uses plugin.json discovery inside each
 * enabledPlugin's root), but the orphans are visible to `ls`, to the
 * toolkit's /health check, and cause confusion.
 *
 * Rule: unlink a symlink if it lives in ~/.claude/{hooks,commands,skills}/,
 * its target is inside any installed plugin dir, and its target no longer
 * exists. Non-symlinks and symlinks with valid targets are left alone.
 */

// homedir is resolved per-call (not captured at module load) so tests that
// stub os.homedir work correctly.
function candidateDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.claude', 'hooks'),
    path.join(home, '.claude', 'commands'),
    path.join(home, '.claude', 'skills'),
  ];
}

export interface CleanupResult {
  scanned: number;
  removed: number;
  removedPaths: string[];
}

function isInsidePluginRoot(target: string, pluginRoots: string[]): boolean {
  const normalized = path.normalize(target);
  return pluginRoots.some((root) => {
    const r = path.normalize(root);
    return normalized === r || normalized.startsWith(r + path.sep);
  });
}

/**
 * Walk one candidate dir (one level deep is enough — the old post-update
 * only placed symlinks at this level, not nested). For each symlink,
 * resolve its target; if it points into a plugin dir and the target is
 * missing, unlink.
 */
function sweepDir(dir: string, pluginRoots: string[], result: CleanupResult): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    // fs.Dirent.isSymbolicLink works on the link itself (not the target)
    if (!entry.isSymbolicLink()) continue;
    result.scanned++;
    let target: string;
    try {
      target = fs.readlinkSync(full);
    } catch {
      continue;
    }
    const absTarget = path.isAbsolute(target) ? target : path.resolve(dir, target);
    if (!isInsidePluginRoot(absTarget, pluginRoots)) continue;
    if (fs.existsSync(absTarget)) continue;
    try {
      fs.unlinkSync(full);
      result.removed++;
      result.removedPaths.push(full);
    } catch {
      // Best-effort — leave it if unlink fails
    }
  }
}

export function cleanupOrphanSymlinks(): CleanupResult {
  const result: CleanupResult = { scanned: 0, removed: 0, removedPaths: [] };
  const pluginRoots = listInstalledPluginDirs();
  if (pluginRoots.length === 0) return result;
  for (const dir of candidateDirs()) {
    sweepDir(dir, pluginRoots, result);
  }
  return result;
}
