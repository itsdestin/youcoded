// desktop/src/main/conversations/resolve-local-project.ts
//
// Resolve a synced conversation record's project to a live on-disk folder ON
// THIS device. Extracted so the materialize sweep (conversations/service.ts)
// and the Resume Browser (session-browser.ts) resolve a record to the EXACT
// SAME local folder — if they disagreed, a session's transcript could
// materialize under one project slug while `claude --resume` launched from a
// different cwd (a different slug) and found nothing.
//
// Cross-OS by construction: the recording device's `originalPath` is the path
// on the machine that created the session (e.g. a Linux `/home/destin/foo`).
// On a different device — especially a different OS (Windows `C:\Users\...`) —
// that absolute path does not exist, so `fs.existsSync` is false and we fall
// through to matching THIS device's copy of the folder by managed-project name
// or saved-folder basename. That's the bug this fixes: before, resume used the
// foreign `originalPath` as the cwd, `claude --resume` launched into a
// nonexistent directory (silently downgraded to $HOME, wrong slug), and the
// session spawned blank and exited.

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param rec        record with `projectName` (folder basename) + `originalPath`
 *                   (absolute path on the creating device).
 * @param managed    map of managed-project name → this device's absolute path.
 * @param saved      this device's saved folders (only `.path` is read).
 * @returns this device's absolute folder path, or null when the project isn't
 *          present locally (record synced, folder not on this device).
 */
export async function resolveLocalProject(
  rec: { projectName: string; originalPath: string },
  managed: Map<string, string>,
  saved: Array<{ path: string }>,
  // WHY an optional cache (2026-10-22 freeze hunt): the materialize sweep resolves ~2,600 records
  // but they share a handful of project folders, so the same few paths were checked thousands of
  // times with a blocking existsSync. A per-sweep/per-browse cache asks the disk once per path.
  // Callers keep it only as long as one sweep/browse, so a folder created later is seen next time.
  existsCache?: Map<string, Promise<boolean>>,
): Promise<string | null> {
  // Same machine (or two devices sharing an identical path): originalPath wins.
  if (rec.originalPath && await pathExists(rec.originalPath, existsCache)) return rec.originalPath;
  // Cross-device / cross-OS: find this device's copy of the folder by name.
  const managedHit = managed.get(rec.projectName);
  if (managedHit) return managedHit;
  const hit = saved.find((f) => path.basename(f.path) === rec.projectName);
  if (hit && await pathExists(hit.path, existsCache)) return hit.path;
  return null;
}

/** fs.existsSync, off the main thread. Same answer: any failure to see the path means "no". */
export function pathExists(p: string, cache?: Map<string, Promise<boolean>>): Promise<boolean> {
  const hit = cache?.get(p);
  if (hit) return hit;
  const probe = fs.promises.access(p).then(() => true, () => false);
  cache?.set(p, probe);
  return probe;
}
