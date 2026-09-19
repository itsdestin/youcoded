// importFile — bring a file the user picked in the native dialog INTO a project
// folder, as either a copy or a move. Replaces the old "+ Add file" behavior,
// which only wrote a manualIncludes pin and never touched the disk.
//
// Safety properties this module owns:
//   - destDir must resolve inside projectRoot (symlink-resolved) — reuses
//     authorizeArtifactWrite so the traversal + protected-path policy is the
//     SAME one the editor save path already enforces. Do not re-inline it.
//   - Never silently overwrites: the caller picks replace / keep-both / skip,
//     and 'replace' only ever applies to a collision the user was actually
//     SHOWN (see disclosedCollisions below).
//   - Importing a file onto ITSELF is a no-op, never a delete (see isSameFile).
//   - Move is copy-then-unlink and NEVER unlinks before the copy is verified.
//     A cross-filesystem move (external drive to home) cannot be a rename, and
//     a half-failed rename must not eat the user's only copy.
//   - The destination is written via a sibling temp file + rename, so a failed
//     copy can never leave a pre-existing file truncated.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { authorizeArtifactWrite } from './write-authorization';
import { invalidateDiscoveryCache } from './project-file-discovery';

export type ImportMode = 'move' | 'copy';
export type CollisionMode = 'replace' | 'keep-both' | 'skip';

export type ImportFileResult =
  // skipped: true covers two different no-ops. `reason: 'already-in-place'`
  // means the source IS the destination file — nothing was (or needed to be)
  // done. Without a reason it is the ordinary onCollision: 'skip' outcome.
  | { ok: true; skipped: true; reason?: 'already-in-place'; relPath?: string }
  | { ok: true; skipped: false; relPath: string }
  | { ok: false; error: string; detail?: string };

const exists = async (p: string): Promise<boolean> => {
  try { await fs.promises.access(p); return true; } catch { return false; }
};

// Do these two paths name the SAME file on disk? Compared by identity, not by
// string: the native picker can hand back a path that reaches the file through
// a symlinked folder, or (on Windows) with different casing, and both of those
// are still the file already sitting in the destination folder. realpath
// settles the symlink/casing case; dev+ino settles a hardlink. Returns false if
// either path is unreadable — a missing destination is simply not the source.
async function isSameFile(a: string, b: string): Promise<boolean> {
  try {
    const [ra, rb] = await Promise.all([fs.promises.realpath(a), fs.promises.realpath(b)]);
    if (ra === rb) return true;
    // WHY bigint: Windows file ids are 64-bit and routinely exceed 2^53, so the
    // default Number `ino` rounds and two DIFFERENT files can compare equal —
    // Windows CI saw an import onto .env report "already-in-place" (2026-09-19).
    const opts = { bigint: true } as const;
    const [sa, sb] = await Promise.all([fs.promises.stat(ra, opts), fs.promises.stat(rb, opts)]);
    // ino === 0 means the filesystem didn't report one — don't claim identity
    // from two zeroes, which would make every file look like every other file.
    return sa.ino !== 0n && sa.dev === sb.dev && sa.ino === sb.ino;
  } catch { return false; }
}

// "notes.md" colliding twice becomes "notes (2).md" then "notes (3).md".
// Extension is preserved so the file keeps opening in the right viewer.
async function freeName(destDir: string, base: string): Promise<string> {
  const ext = path.extname(base);
  const stem = path.basename(base, ext);
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!(await exists(path.join(destDir, candidate)))) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`;
}

export async function importFile(args: {
  projectRoot: string;
  sourcePath: string;
  destDir: string;
  mode: ImportMode;
  onCollision: CollisionMode;
  /** Basenames the CALLER told the user were already in destDir — i.e. the
   *  collision list that justified their Replace/Keep both/Skip choice.
   *  Supplying it makes 'replace' apply ONLY to those files (see below).
   *  Omit it entirely to keep the literal choice for every collision. */
  disclosedCollisions?: string[];
}): Promise<ImportFileResult> {
  const { projectRoot, sourcePath, destDir, mode, onCollision, disclosedCollisions } = args;

  // Source must exist before anything else — a missing source is the most
  // common failure and deserves its real code, not a generic message.
  try {
    const st = await fs.promises.stat(sourcePath);
    if (!st.isFile()) return { ok: false, error: 'ENOTFILE', detail: sourcePath };
  } catch (e: any) {
    return { ok: false, error: e.code ?? 'ENOENT', detail: sourcePath };
  }

  // Authorize CONTAINMENT of destDir BEFORE the collision probe below.
  // Ordering matters: exists(path.join(destDir, name)) is a filesystem probe,
  // and onCollision: 'skip' used to return { ok: true, skipped: true }
  // straight off that probe's result — reporting success for a destDir that
  // was never checked against projectRoot. That turned this function into an
  // existence-oracle for arbitrary paths (no write happened, but a caller
  // could learn whether some file outside the project exists by watching
  // whether the import gets reported "skipped"). Checking containment here,
  // before any probe, closes that oracle for every onCollision value — a
  // destDir outside projectRoot is refused before we ever look at what's in
  // it. We don't yet know the FINAL filename (keep-both can rename it to
  // avoid a collision), so this call only proves destDir itself resolves
  // inside projectRoot; the final resolved file path is re-authorized
  // (containment + D5 tier) right before the write, below — that second call
  // is what actually gates the write, this one only gates the probe.
  const dirAuth = await authorizeArtifactWrite({
    projectRoot, fullPath: destDir, mustStayInRoot: true,
  });
  if (!dirAuth.ok) return { ok: false, error: dirAuth.error, detail: (dirAuth as any).path };

  let name = path.basename(sourcePath);
  const naturalDest = path.join(destDir, name);
  const collided = await exists(naturalDest);
  if (collided) {
    // DATA LOSS GUARD: the source may BE the destination file (browse to docs/,
    // "+ Add file", pick docs/notes.md). fs.copyFile short-circuits when both
    // sides are the same inode, so the size check below then stats one file
    // twice and trivially passes — and mode 'move' went on to unlink it,
    // destroying the file while reporting success. 'keep-both' was no better:
    // it renamed the user's own file to "notes (2).md". A file that is already
    // where you are putting it needs no work at all, in any mode.
    if (await isSameFile(sourcePath, naturalDest)) {
      return {
        ok: true, skipped: true, reason: 'already-in-place',
        relPath: path.relative(projectRoot, naturalDest),
      };
    }

    // 'replace' is ONE choice applied to the whole batch, and the collision
    // list that justified it is not guaranteed complete: the caller builds it
    // from on-disk discovery, which skips noise files (package-lock.json,
    // *.map, *.min.js, .DS_Store) and truncates at its own caps. A file that
    // collides WITHOUT having been named in the dialog was never consented to,
    // so overwriting it would destroy data the user was never shown. 'keep-both'
    // loses nothing, so that's where an undisclosed collision lands. An absent
    // disclosedCollisions means the caller isn't using disclosure at all (a
    // direct main-side call) and keeps the literal choice.
    let effective = onCollision;
    if (effective === 'replace' && disclosedCollisions && !disclosedCollisions.includes(name)) {
      effective = 'keep-both';
    }
    if (effective === 'skip') return { ok: true, skipped: true };
    if (effective === 'keep-both') name = await freeName(destDir, name);
    // 'replace' falls through — the rename below lands on the existing name.
  }

  const destPath = path.join(destDir, name);

  // Traversal + protected-path policy on the RESOLVED destination. mustStayInRoot
  // is true: an import always lands inside the project by definition. This is
  // the authorization that actually gates the write (the dirAuth call above
  // only gated the collision probe, before the final name was known).
  //
  // confirmed is NOT passed. The flag means "the caller already showed the
  // protected-path confirm dialog", and the Move/Copy dialog is not that dialog
  // — it asks copy-vs-move, not "you are about to overwrite your .env". So an
  // import into .claude/ or onto a dotenv comes back as needs-confirm and the
  // renderer must surface it as a refusal. Passing confirmed: true here would
  // skip the one gate that makes writing an agent hook or a secrets file a
  // deliberate act.
  const auth = await authorizeArtifactWrite({
    projectRoot, fullPath: destPath, mustStayInRoot: true,
  });
  if (!auth.ok) return { ok: false, error: auth.error, detail: (auth as any).path };

  // Write to a sibling TEMP file, verify it, then rename it over the
  // destination. fs.copyFile truncates the destination BEFORE it writes and is
  // not atomic, so an ENOSPC/EIO partway through used to leave the user's
  // pre-existing file truncated on disk with nothing to roll back to — and the
  // function returned COPY_FAILED over that wreckage. rename(2) inside one
  // directory is atomic: the destination is either the old file or the whole
  // new one, never a half-written stub. The temp lives in destDir (not the OS
  // temp dir) so the rename can't cross a filesystem boundary and silently
  // degrade back into a copy. It needs no separate authorization — destDir's
  // containment was proven above and this name is a direct child we construct.
  const tmpPath = path.join(destDir, `.youcoded-import-${process.pid}-${Date.now()}-${name}.part`);
  const dropTmp = async () => { await fs.promises.unlink(tmpPath).catch(() => {}); };

  try {
    await fs.promises.copyFile(sourcePath, tmpPath);
  } catch (e: any) {
    await dropTmp();
    return { ok: false, error: e.code ?? 'COPY_FAILED', detail: e.message };
  }

  // Verify BEFORE the rename, and so before any unlink. A short write (full
  // disk) must cost neither the source nor the file already at destPath.
  try {
    const [s, d] = await Promise.all([
      fs.promises.stat(sourcePath), fs.promises.stat(tmpPath),
    ]);
    if (s.size !== d.size) {
      await dropTmp();
      return { ok: false, error: 'COPY_INCOMPLETE', detail: `${d.size} of ${s.size} bytes` };
    }
  } catch (e: any) {
    await dropTmp();
    return { ok: false, error: e.code ?? 'VERIFY_FAILED', detail: e.message };
  }

  try {
    await fs.promises.rename(tmpPath, destPath);
  } catch (e: any) {
    await dropTmp();
    return { ok: false, error: e.code ?? 'RENAME_FAILED', detail: e.message };
  }

  if (mode === 'move') {
    try {
      await fs.promises.unlink(sourcePath);
    } catch (e: any) {
      // The copy succeeded — the file IS in the project. Report the partial
      // outcome truthfully rather than claiming the move failed outright.
      invalidateDiscoveryCache(projectRoot);
      return { ok: false, error: 'MOVE_SOURCE_NOT_REMOVED', detail: e.message };
    }
  }

  // Drop the cached scan so the file appears without waiting for the TTL.
  invalidateDiscoveryCache(projectRoot);
  return { ok: true, skipped: false, relPath: path.relative(projectRoot, destPath) };
}
