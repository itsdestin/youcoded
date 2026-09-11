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
// via Node's fs.promises.rename).
//
// `shouldCommit`, when given, is checked AFTER the copy lands in tmp and
// BEFORE the rename — see materializeOut's WHY for why the decision can't be
// made any earlier. Returns whether the rename happened (false ⇒ the tmp was
// discarded instead).
async function copyInto(src: string, dest: string, shouldCommit?: () => boolean): Promise<boolean> {
  const dir = path.dirname(dest);
  await fsp.mkdir(dir, { recursive: true });
  await sweepStaleTmp(dir, path.basename(dest));
  const tmp = `${dest}.${process.pid}.${Date.now()}.${tmpSeq++}.tmp`;
  await fsp.copyFile(src, tmp);
  if (shouldCommit && !shouldCommit()) {
    try { await fsp.unlink(tmp); } catch { /* best-effort — the stale-tmp sweep would catch it anyway */ }
    return false;
  }
  await fsp.rename(tmp, dest);
  return true;
}

// WHY a per-destination chain (review round 1, 2026-09-10): mirrorIn/
// materializeOut each read the dest's size, decide whether to copy, then copy
// + rename — several separate awaits. Two callers targeting the SAME dest can
// now interleave between any of those steps (turn-complete's mirror and the
// reconciler's fire-and-forget mirror both target the same space transcript).
// Whichever rename lands LAST wins even if it read an OLDER, shorter file —
// briefly shrinking the durable copy, which the grow-only rule forbids. Keying
// by dest (mirrorIn and materializeOut never share one — they copy in
// opposite directions) and running the WHOLE size-check-and-copy decision
// inside the chain makes the decision and the rename atomic with respect to
// every other call on that dest.
const destChain = new Map<string, Promise<unknown>>();
function runSerialized<T>(dest: string, op: () => Promise<T>): Promise<T> {
  const prev = (destChain.get(dest) ?? Promise.resolve()) as Promise<unknown>;
  const settled = prev.then(op, op); // run after prev settles, regardless of prev's own outcome
  // The map only needs to know WHEN the previous op finished, never whether it
  // threw — swallow here so one failed copy can't permanently wedge the chain
  // for that dest. The caller still gets the real (possibly rejecting) result
  // via `settled`, returned below.
  const tailForChain = settled.catch(() => undefined);
  destChain.set(dest, tailForChain);
  void tailForChain.finally(() => { if (destChain.get(dest) === tailForChain) destChain.delete(dest); });
  return settled;
}

// Local → space. Copies only when the local file is STRICTLY LARGER than the
// space copy (append-only growth) or when no space copy exists yet.
export function mirrorIn(opts: { localJsonlPath: string; spaceTranscriptPath: string }): Promise<MirrorResult> {
  return runSerialized(opts.spaceTranscriptPath, async () => {
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
    const copied = await copyInto(opts.localJsonlPath, opts.spaceTranscriptPath);
    return { copied };
  });
}

// Space → local. Copies only when the space copy is STRICTLY LARGER than the
// local file (or local is missing). Never deletes; never clobbers newer/equal
// local work.
//
// WHY `shouldCommit` (review round 1, IMPORTANT finding): the synchronous
// version could never be interrupted between its "not a live session" check
// and its rename — now several threadpool steps (two stats, a mkdir, a
// readdir, a copy of up to tens of MB, then the rename) separate them, and a
// session can resume in that gap (SessionStart re-acquiring, or a takeover
// resuming right after materializeOne). A late rename then overwrites the
// transcript Claude Code is actively appending to and loses turns — exactly
// what the "skip live sessions" rule (conversations.md) forbids. `shouldCommit`
// re-checks liveness right before the rename, as late as possible, so a
// session that started mid-copy still aborts the commit.
export function materializeOut(opts: { spaceTranscriptPath: string; localJsonlPath: string; shouldCommit?: () => boolean }): Promise<MirrorResult> {
  return runSerialized(opts.localJsonlPath, async () => {
    const spaceSize = await sizeOf(opts.spaceTranscriptPath);
    // No space copy — nothing to materialize (and we never delete the local one).
    if (spaceSize === null) return { copied: false };
    const localSize = await sizeOf(opts.localJsonlPath);
    // Local is present and already as long as (or longer than) the space copy —
    // leave the newer/equal local work untouched.
    if (localSize !== null && localSize >= spaceSize) return { copied: false };
    const copied = await copyInto(opts.spaceTranscriptPath, opts.localJsonlPath, opts.shouldCommit);
    return { copied };
  });
}
