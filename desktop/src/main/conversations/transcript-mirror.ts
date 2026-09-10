// CC transcript movement between the device and the personal space (design §2).
// BOTH directions are add/update-only and size-gated:
//  - mirror-in: the space copy is the DURABLE one. CC's cleanupPeriodDays
//    deleting a local transcript must never delete the synced copy, and a
//    local rewrite that SHRANK the file (e.g. /clear) must not clobber the
//    fuller durable history.
//  - materialize-out: local files are only ever created or grown, never
//    deleted, and never overwritten by a smaller/equal space copy.
// Size comparison (not content hash) is sufficient: CC transcripts are
// append-only JSONL between rewrites, and a same-size-different-content case
// resolves on the next turn's growth.
import fs from 'node:fs';
import path from 'node:path';

export interface MirrorResult { copied: boolean; shrunk?: boolean }

// A crashed copy can orphan a '<dest>.<pid>.<ts>.tmp' file in the SPACE dir.
// '.tmp' is NOT in the sync engine's DEFAULT_IGNORES (sync-spaces/guards.ts), so
// an orphan would sync forever as junk. copyInto sweeps orphans for the SAME
// dest older than this before writing a fresh one. An hour is comfortably longer
// than any real copy, so a live copy in flight is never swept.
const STALE_TMP_MS = 60 * 60 * 1000;

// WHY async (2026-09-10): mirrorIn runs on EVERY turn-complete of every session
// (conversations/service.ts) and copies a transcript that can be tens of MB.
// copyFileSync + renameSync held the main thread for the whole copy; a slow
// disk there stalls every window at once (the 2026-09-08 freeze class).
// fs.promises does the same copy on the threadpool. Atomicity is unchanged:
// still unique tmp + rename.
const fsp = fs.promises;

async function sizeOf(p: string): Promise<number | null> {
  // stat throws for a missing file; null is the "not present" signal every
  // caller below branches on. A missing LOCAL file must never mutate the space,
  // so this null is load-bearing, not just convenience.
  try { return (await fsp.stat(p)).size; } catch { return null; }
}

// Best-effort sweep of crash-orphaned tmp files for one dest. Isolated in its
// own try/catch so a cleanup hiccup (permissions, dir race) can never abort the
// copy it precedes — cleanup is opportunistic housekeeping, not correctness.
async function sweepStaleTmp(dir: string, destBase: string): Promise<void> {
  try {
    const prefix = `${destBase}.`;
    const now = Date.now();
    for (const name of await fsp.readdir(dir)) {
      // Match only OUR tmp shape for THIS dest: '<destBase>.<something>.tmp'.
      // A foreign dest's tmp (different basename) is left alone.
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
      const full = path.join(dir, name);
      try {
        if (now - (await fsp.stat(full)).mtimeMs > STALE_TMP_MS) await fsp.unlink(full);
      } catch { /* vanished or unreadable — nothing to sweep */ }
    }
  } catch { /* dir unreadable — skip the sweep entirely */ }
}

// WHY the counter: two async copies of the same dest can start in the same
// millisecond (turn-complete + the reconciler), and pid+Date.now() alone would
// then name the same tmp file. The pid stays in the name — the ast-grep rule
// atomic-tmp-name-per-process depends on it.
let tmpSeq = 0;

// Copy src OVER dest via a unique tmp + rename so a mid-copy crash never leaves
// a torn (half-written) file for the sync engine to push. rename replaces an
// existing dest atomically (POSIX rename(2); Windows MoveFileEx REPLACE_EXISTING
// via Node's fs.renameSync).
async function copyInto(src: string, dest: string): Promise<void> {
  const dir = path.dirname(dest);
  await fsp.mkdir(dir, { recursive: true });
  await sweepStaleTmp(dir, path.basename(dest));
  const tmp = `${dest}.${process.pid}.${Date.now()}.${tmpSeq++}.tmp`;
  await fsp.copyFile(src, tmp);
  await fsp.rename(tmp, dest);
}

// Local → space. Copies only when the local file is STRICTLY LARGER than the
// space copy (append-only growth) or when no space copy exists yet.
export async function mirrorIn(opts: { localJsonlPath: string; spaceTranscriptPath: string }): Promise<MirrorResult> {
  const localSize = await sizeOf(opts.localJsonlPath);
  // Local gone (CC cleanup) — NEVER propagate deletion into the durable copy.
  if (localSize === null) return { copied: false };
  const spaceSize = await sizeOf(opts.spaceTranscriptPath);
  // Local shrank below the durable copy (/clear rewrite or foreign truncation).
  // Preserve the fuller history; signal `shrunk` so the caller knows the record
  // still legitimately points at the longer space copy.
  if (spaceSize !== null && localSize < spaceSize) return { copied: false, shrunk: true };
  // Identical size ⇒ already mirrored (append-only means same size = same file
  // in the normal case); skip the write so mtime/sync stay quiet.
  if (spaceSize !== null && localSize === spaceSize) return { copied: false };
  await copyInto(opts.localJsonlPath, opts.spaceTranscriptPath);
  return { copied: true };
}

// Space → local. Copies only when the space copy is STRICTLY LARGER than the
// local file (or local is missing). Never deletes; never clobbers newer/equal
// local work.
export async function materializeOut(opts: { spaceTranscriptPath: string; localJsonlPath: string }): Promise<MirrorResult> {
  const spaceSize = await sizeOf(opts.spaceTranscriptPath);
  // No space copy — nothing to materialize (and we never delete the local one).
  if (spaceSize === null) return { copied: false };
  const localSize = await sizeOf(opts.localJsonlPath);
  // Local is present and already as long as (or longer than) the space copy —
  // leave the newer/equal local work untouched.
  if (localSize !== null && localSize >= spaceSize) return { copied: false };
  await copyInto(opts.spaceTranscriptPath, opts.localJsonlPath);
  return { copied: true };
}
