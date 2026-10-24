// exists-probe.ts — "does this path exist?" for thousands of tracked files, without thousands of failures.
//
// WHY (2026-10-22 freeze hunt): Project View counts and artifacts:check-existence called fs.access once
// per tracked file. In the owner's data 8,902 of 10,360 tracked files sit in deleted worktrees, so almost
// every call FAILED, and every failed call allocates an Error with a stack trace — that was ~160 MB and
// ~570 ms of CPU for one 10k-id check. A path cannot exist under a directory that does not, so this asks
// about each DIRECTORY once (remembering the answer, and checking the parent first) and only touches a
// file when its directory is there. The answer for every path is the same as a direct fs.access.
import fs from 'fs';
import path from 'path';
import { mapLimit } from '../map-limit';

/** One probe = one short-lived directory cache. Make a new one per request so a folder created or
 *  deleted later is seen on the next request. */
export function createExistsProbe(concurrency = 32): {
  exists: (p: string) => Promise<boolean>;
  existsAll: (paths: string[]) => Promise<boolean[]>;
} {
  const dirs = new Map<string, Promise<boolean>>();
  const dirExists = (dir: string): Promise<boolean> => {
    const hit = dirs.get(dir);
    if (hit) return hit;
    const parent = path.dirname(dir);
    const probe = (async () => {
      // A missing parent means this directory is missing too: no need to ask the disk (and fail).
      if (parent !== dir && !(await dirExists(parent))) return false;
      return fs.promises.access(dir).then(() => true, () => false);
    })();
    dirs.set(dir, probe);
    return probe;
  };
  const exists = async (p: string): Promise<boolean> => {
    const dir = path.dirname(p);
    if (dir !== p && !(await dirExists(dir))) return false;
    return fs.promises.access(p).then(() => true, () => false);
  };
  return { exists, existsAll: (paths) => mapLimit(paths, concurrency, exists) };
}
