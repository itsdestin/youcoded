// Kotlin port of desktop/src/main/artifacts/cas-write.ts (post-fix a75492ea).
//
// Atomic write-then-rename with Compare-And-Swap check, protected by a
// mkdir-based lock. Mirrors the TS implementation exactly:
//   - fs.mkdir(lock) → Files.createDirectory(lockPath) — atomic on POSIX + NTFS
//   - Stale-lock heuristic: if lock dir mtime > 30 s ago, break and retry
//   - finally block always removes the lock
//   - Write to .tmp, FileChannel.force(true) fsync, then atomic rename
//
// On Windows, Files.move with ATOMIC_MOVE can throw AtomicMoveNotSupportedException
// when the target already exists. We fall back to REPLACE_EXISTING (same as TS's
// fs.rename which also does a non-atomic overwrite on some paths).
package com.youcoded.app.artifacts

import java.io.File
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.BasicFileAttributes

private const val LOCK_RETRY_MS  = 10L
private const val LOCK_MAX_WAIT_MS = 3_000L
private const val LOCK_STALE_MS   = 30_000L

data class CasResult(
    val committed:       Boolean,
    val actualUpdatedAt: String?,
)

/**
 * Acquire the mkdir lock at [lockPath], blocking (real `Thread.sleep` retries —
 * this whole module is the synchronous, non-suspend style `casWrite`
 * established) until acquired or [LOCK_MAX_WAIT_MS] elapses. Shared by
 * `casWrite` and `mutateFileUnderLock` below so both use IDENTICAL lock
 * semantics — same mkdir-is-atomic primitive, same 30s stale-lock break —
 * which matters once a SECOND caller (`mutateFileUnderLock`, added for F1,
 * T4 doc-comments implementation review) needs to exclude not just other
 * callers of `casWrite` but a wholly separate process racing the same file.
 */
private fun acquireLock(lockPath: Path): Boolean {
    val start = System.currentTimeMillis()
    while (true) {
        try {
            Files.createDirectory(lockPath)
            return true // Lock acquired
        } catch (e: java.nio.file.FileAlreadyExistsException) {
            // Stale-lock heuristic: if the lock dir is older than LOCK_STALE_MS,
            // the holding process likely crashed — break the lock and retry.
            try {
                val attrs = Files.readAttributes(lockPath, BasicFileAttributes::class.java)
                val mtime = attrs.lastModifiedTime().toMillis()
                if (System.currentTimeMillis() - mtime > LOCK_STALE_MS) {
                    lockPath.toFile().deleteRecursively()
                    continue
                }
            } catch (_: Exception) {
                // Ignore stat errors — lock may have just been released
            }
            if (System.currentTimeMillis() - start > LOCK_MAX_WAIT_MS) {
                return false
            }
            Thread.sleep(LOCK_RETRY_MS)
        }
    }
}

/**
 * Read-modify-write [target] entirely INSIDE the mkdir lock — Kotlin port of
 * desktop's `cas-write.ts` `mutateFileUnderLock` (F1, T4 doc-comments
 * implementation review, blocker). This is the primitive for a file with no
 * CAS version field of its own: a caller that reads outside the lock and
 * writes back after loses an update from whoever wrote in between. Reuses
 * [acquireLock] — the SAME lock path naming (`<target>.lock`) and 30s
 * stale-lock timeout `casWrite` above already uses — so this app's own
 * writers, desktop's `cas-write.ts` (a dev instance and the built app sharing
 * `~/.claude`), and the Claude Code MCP script's own dependency-free
 * reimplementation of this exact algorithm (design §9.1 point 2, §9.2) all
 * exclude each other over the same file, not just callers inside one JVM.
 *
 * @param mutate receives the current on-disk content (null when the file
 *               doesn't exist) and returns the new content, or null to skip
 *               the write entirely — a failed lookup must never write
 *               anything, not even an unchanged copy.
 * @return false when the lock couldn't be acquired within the timeout.
 */
fun mutateFileUnderLock(target: Path, mutate: (String?) -> String?): Boolean {
    Files.createDirectories(target.parent)
    val lockPath = target.parent.resolve(target.fileName.toString() + ".lock")
    if (!acquireLock(lockPath)) return false
    try {
        val onDisk: String? = try {
            target.toFile().readText(Charsets.UTF_8)
        } catch (e: java.io.FileNotFoundException) {
            null
        } catch (e: java.io.IOException) {
            if (!target.toFile().exists()) null else throw e
        }
        val next = mutate(onDisk)
        if (next != null) {
            // Same atomic write shape as casWrite below: tmp → fsync → rename.
            val tmp = target.parent.resolve(target.fileName.toString() + ".tmp")
            tmp.toFile().writeText(next, Charsets.UTF_8)
            FileChannel.open(tmp, StandardOpenOption.READ, StandardOpenOption.WRITE).use { ch -> ch.force(true) }
            try {
                Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } catch (_: java.nio.file.AtomicMoveNotSupportedException) {
                Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING)
            }
        }
        return true
    } finally {
        lockPath.toFile().deleteRecursively()
    }
}

/** Convenience overload accepting a String path (matches most call sites). */
fun mutateFileUnderLock(target: String, mutate: (String?) -> String?): Boolean =
    mutateFileUnderLock(File(target).toPath(), mutate)

/**
 * Atomic write-then-rename with optional CAS check, protected by a
 * mkdir-based lock.
 *
 * @param target           Absolute target file path.
 * @param expectedUpdatedAt The updatedAt value the caller read at the start
 *                         of its mutation. Pass null for "file does not exist
 *                         yet" (creation).
 * @param content          New file contents (UTF-8).
 * @param extractUpdatedAt Optional — pull updatedAt out of the on-disk JSON.
 *                         When null, the CAS check is skipped (use for
 *                         non-CAS atomic writes like the central index).
 */
fun casWrite(
    target:           Path,
    expectedUpdatedAt: String?,
    content:          String,
    extractUpdatedAt: ((String) -> String)? = null,
    // ROADMAP L696 (mirror of the TS CAS_REPLACE_ANY sentinel). `null` used to
    // carry TWO meanings — "nothing is there, I am creating" and "something is
    // there but I mean to replace it" — and the only behaviour available to
    // both was "write regardless", so two first-ever writes each wrote a fresh
    // file and the second silently overwrote the first. `null` now REQUIRES
    // the file to be absent; a writer that means to overwrite says so here.
    // Default false so a caller that forgets gets the SAFE refusal, not the
    // clobber.
    replaceAny:       Boolean = false,
): CasResult {
    // Ensure parent directory exists (mirror of fs.mkdir(dirname(target), {recursive:true}))
    Files.createDirectories(target.parent)

    val lockPath = target.parent.resolve(target.fileName.toString() + ".lock")

    if (!acquireLock(lockPath)) {
        return CasResult(committed = false, actualUpdatedAt = null)
    }

    try {
        // ROADMAP L696: the EXISTENCE half, and it needs no extractor — a
        // creating writer has nothing to compare against, only "is anything
        // there". Inside the lock, so a file appearing between this check and
        // the rename below is not possible.
        if (expectedUpdatedAt == null && !replaceAny) {
            if (Files.exists(target)) {
                // Someone else created it while we were building ours. Refuse;
                // the caller re-reads and merges on its retry.
                return CasResult(committed = false, actualUpdatedAt = null)
            }
        } else if (extractUpdatedAt != null && !replaceAny) {
            try {
                val onDisk = target.toFile().readText(Charsets.UTF_8)
                val actual = extractUpdatedAt(onDisk)
                if (actual != expectedUpdatedAt) {
                    return CasResult(committed = false, actualUpdatedAt = actual)
                }
            } catch (e: java.io.FileNotFoundException) {
                // Reaching here means a SPECIFIC token was expected (the null
                // case is handled by the branch above) and the file is gone —
                // whatever this writer was amending no longer exists. Refuse.
                return CasResult(committed = false, actualUpdatedAt = null)
            } catch (e: java.io.IOException) {
                if (e.message?.contains("No such file") == true || !target.toFile().exists()) {
                    return CasResult(committed = false, actualUpdatedAt = null)
                } else throw e
            }
        }

        // Atomic write: write to .tmp → fsync → rename
        val tmp = target.parent.resolve(target.fileName.toString() + ".tmp")
        tmp.toFile().writeText(content, Charsets.UTF_8)

        // fsync — mirrors TS fh.sync()
        FileChannel.open(tmp, StandardOpenOption.READ, StandardOpenOption.WRITE).use { ch ->
            ch.force(true)
        }

        // Atomic rename — mirrors TS fs.rename(tmp, target)
        try {
            Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (_: java.nio.file.AtomicMoveNotSupportedException) {
            // Windows NTFS edge case: fall back to non-atomic replace
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING)
        }

        return CasResult(committed = true, actualUpdatedAt = null)
    } finally {
        // Always release the lock, even on error — mirrors TS finally block
        lockPath.toFile().deleteRecursively()
    }
}

/** Convenience overload accepting a String path (matches most call sites). */
fun casWrite(
    target:           String,
    expectedUpdatedAt: String?,
    content:          String,
    extractUpdatedAt: ((String) -> String)? = null,
    replaceAny:       Boolean = false,
): CasResult = casWrite(
    target           = File(target).toPath(),
    expectedUpdatedAt = expectedUpdatedAt,
    content          = content,
    extractUpdatedAt = extractUpdatedAt,
    replaceAny       = replaceAny,
)
