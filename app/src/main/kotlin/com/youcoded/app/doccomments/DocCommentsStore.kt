// Android's half of T1's main-process store — T4 of the doc-comments build
// (docs/active/specs/2026-09-26-doc-comments-build-design.md §1.5, §9.1
// point 3). Kotlin port of desktop/src/main/doc-comments/doc-comments-store.ts:
// resolving a (path, projectRoot) pair to its one-sidecar-per-file location
// (§1.3/§1.4), refusing anything that resolves outside the project (§1.5's
// realpath-the-FULL-joined-path containment check, corrected in review 2,
// F1 — mirrored here field-for-field, not the weaker root-only shape),
// and every read/mutation against that sidecar.
//
// WHY a plain in-process Mutex, not a port of cas-write.ts's cross-process
// mkdir lock (§1.5 "Kotlin's own file-locking", §9.1 point 3): Android has
// no second concurrent YouCoded process sharing this file the way desktop's
// dev-instance-plus-built-app does (PITFALLS.md's cross-process hazard is
// desktop-only) — a coroutine Mutex keyed by the sidecar's own canonical
// path, plus a write-tmp-then-atomic-rename, is simpler and sufficient. The
// map key is ALREADY the canonicalized `sidecarPath` `locateInProject`/
// `locateFallback` compute (built from `realProjectRoot`, never the caller's
// unresolved argument), so two differently-spelled aliases of the same
// project (a symlink, a `..`-laden path) collapse onto the SAME Mutex without
// needing §1.5's separate desktop lock-path-canonicalization fix — that fix
// exists only because cas-write.ts derives its lock path from the RAW target
// string; this module never does.
package com.youcoded.app.doccomments

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

/** Mirrors desktop's `Refusal` union (doc-comments-store.ts) plus the extra
 *  errors T4's dispatch layer adds on top (see DocCommentsDispatch.kt). */
enum class DocCommentsError(val wire: String) {
    PATH_OUTSIDE_PROJECT("path-outside-project"),
    COMMENT_NOT_FOUND("comment-not-found"),
    SIDECAR_CORRUPT("sidecar-corrupt"),
    PATH_NOT_ABSOLUTE("path-not-absolute"),
}

sealed class StoreResult<out T> {
    data class Ok<T>(val value: T) : StoreResult<T>()
    data class Err(val error: DocCommentsError) : StoreResult<Nothing>()
}

private const val MAX_WALKUP_DEPTH = 200

/**
 * Follows symlinks the whole way down `targetAbs`, walking up to the nearest
 * EXISTING ancestor when the leaf (or an intermediate segment) doesn't exist
 * yet, re-joining the not-yet-real suffix onto that ancestor's realpath.
 * Mirrors doc-comments-store.ts's `realpathWithNonexistentTail` — fails
 * closed (returns null) rather than falling through to the raw path on
 * ENOENT, exactly the trap review 2 (F1) fixed on the TS side.
 */
private fun realpathWithNonexistentTail(targetAbs: File): File? {
    try {
        return targetAbs.toPath().toRealPath().toFile()
    } catch (_: java.nio.file.NoSuchFileException) {
    } catch (_: java.nio.file.NotDirectoryException) {
    } catch (_: java.io.IOException) {
        return null
    }
    val segments = mutableListOf<String>()
    var dir = targetAbs
    for (depth in 0 until MAX_WALKUP_DEPTH) {
        val parent = dir.parentFile ?: return null
        if (parent.path == dir.path) return null // hit the filesystem root
        segments.add(0, dir.name)
        try {
            val realParent = parent.toPath().toRealPath().toFile()
            var result = realParent
            for (s in segments) result = File(result, s)
            return result
        } catch (_: java.nio.file.NoSuchFileException) {
            dir = parent
        } catch (_: java.nio.file.NotDirectoryException) {
            dir = parent
        }
    }
    return null // exceeded the cap — refuse rather than keep walking
}

/** Realpaths the FULL joined path (via the walk-up above) and tests it
 *  against the realpathed root — write-authorization.ts's `judgeRelativeRecord()`
 *  shape, not git-service.ts's shallower root-only one (review 2, F1). Returns
 *  the resolved, verified-contained path on success. */
private fun checkContainment(realProjectRoot: String, abs: File): File? {
    val realAbs = realpathWithNonexistentTail(abs) ?: return null
    val withSep = if (realProjectRoot.endsWith(File.separator)) realProjectRoot else realProjectRoot + File.separator
    return if (realAbs.path == realProjectRoot || realAbs.path.startsWith(withSep)) realAbs else null
}

/** Mirrors `path.resolve(root, filePath)`: an absolute `filePath` ignores
 *  `root` entirely (Java's `File(parent, child)` does the same when `child`
 *  is itself absolute — confirmed against `java.io.File`'s own javadoc). */
private fun resolveAgainst(root: String, filePath: String): File {
    val f = File(filePath)
    return if (f.isAbsolute) f else File(root, filePath)
}

data class Located(val sidecarPath: String, val realProjectRoot: String, val sourceAbsolutePath: String)

private val SIDECAR_DIR = listOf(".youcoded", "comments")
private val FALLBACK_DIR = listOf(".youcoded", "loose-file-comments")

private fun sidecarDirFor(realProjectRoot: String): File {
    var dir = File(realProjectRoot)
    for (seg in SIDECAR_DIR) dir = File(dir, seg)
    return dir
}

/**
 * §1.3's sidecar location for a file inside a known project — refused when
 * `filePath` resolves outside `projectRoot`, including via an absolute-path-
 * shaped argument or a symlink. `sidecarPath` is built from the RESOLVED,
 * containment-verified target (never the caller's unresolved `filePath`) so a
 * path that escapes the project and comes back in through an outside-rooted
 * symlink can never leave stray `..` segments in the relative suffix — same
 * reasoning as doc-comments-store.ts's own `locateInProject` doc comment.
 */
private fun locateInProject(projectRoot: String, filePath: String): StoreResult<Located> {
    val realProjectRoot = try {
        File(projectRoot).toPath().toRealPath().toFile().path
    } catch (_: Exception) {
        return StoreResult.Err(DocCommentsError.PATH_OUTSIDE_PROJECT)
    }
    val abs = resolveAgainst(realProjectRoot, filePath)
    val realAbsFile = checkContainment(realProjectRoot, abs) ?: return StoreResult.Err(DocCommentsError.PATH_OUTSIDE_PROJECT)
    val realAbs = realAbsFile.path
    val rel = File(realProjectRoot).toPath().relativize(File(realAbs).toPath()).toString()
    val sidecarPath = File(sidecarDirFor(realProjectRoot), "$rel.json").path
    return StoreResult.Ok(Located(sidecarPath, realProjectRoot, realAbs))
}

/**
 * §1.4's fallback for a file with no known project root: a global, per-
 * machine store keyed by a hash of the file's own resolved absolute path.
 * Mirrors desktop's `locateFallback` — no containment check applies (there is
 * no root to escape), but a non-absolute `path` is refused rather than
 * silently resolved against this process's own cwd (F4 on the TS side).
 */
private fun locateFallback(absoluteFilePath: String, homeDir: File): StoreResult<String> {
    if (!File(absoluteFilePath).isAbsolute) return StoreResult.Err(DocCommentsError.PATH_NOT_ABSOLUTE)
    val abs = File(absoluteFilePath).absoluteFile
    val resolved = realpathWithNonexistentTail(abs) ?: abs
    val hash = sha256Hex(resolved.path)
    var dir = homeDir
    for (seg in FALLBACK_DIR) dir = File(dir, seg)
    return StoreResult.Ok(File(dir, "$hash.json").path)
}

private fun sha256Hex(s: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8))
    return digest.joinToString("") { "%02x".format(it) }
}

private fun resolveSidecarPath(path: String, projectRoot: String?, homeDir: File): StoreResult<String> {
    if (projectRoot != null) {
        return when (val located = locateInProject(projectRoot, path)) {
            is StoreResult.Ok -> StoreResult.Ok(located.value.sidecarPath)
            is StoreResult.Err -> located
        }
    }
    return locateFallback(path, homeDir)
}

/** §3.2/§4.1 dispatch's own resolution target: the SOURCE file's containment-
 *  verified absolute path (never a sidecar — a `.docx`/`.xlsx` has none, per
 *  §1.1). Mirrors desktop's `resolveSourceFilePath`. */
fun resolveSourceFilePath(path: String, projectRoot: String?, homeDir: File): StoreResult<String> {
    if (projectRoot != null) {
        return when (val located = locateInProject(projectRoot, path)) {
            is StoreResult.Ok -> StoreResult.Ok(located.value.sourceAbsolutePath)
            is StoreResult.Err -> located
        }
    }
    if (!File(path).isAbsolute) return StoreResult.Err(DocCommentsError.PATH_NOT_ABSOLUTE)
    val abs = File(path).absoluteFile
    val resolved = realpathWithNonexistentTail(abs) ?: abs
    return StoreResult.Ok(resolved.path)
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** A missing sidecar is the overwhelmingly common case (a file with zero
 *  comments) — returns an empty list, never an error, same as desktop. */
fun listComments(path: String, projectRoot: String?, homeDir: File): StoreResult<List<PersistedComment>> {
    val resolved = resolveSidecarPath(path, projectRoot, homeDir)
    if (resolved is StoreResult.Err) return resolved
    val sidecarPath = (resolved as StoreResult.Ok).value
    val file = File(sidecarPath)
    // A missing sidecar (ENOENT-equivalent) is the common "zero comments"
    // case; an EXISTING-but-unreadable one is refused instead of silently
    // reported as empty, mirroring desktop's own listComments (which
    // re-throws for anything other than ENOENT rather than swallowing it).
    if (!file.exists()) return StoreResult.Ok(emptyList())
    val onDisk = try { file.readText(Charsets.UTF_8) } catch (_: java.io.IOException) {
        return StoreResult.Err(DocCommentsError.SIDECAR_CORRUPT)
    }
    val parsed = CommentsSidecarFile.parse(onDisk) ?: return StoreResult.Err(DocCommentsError.SIDECAR_CORRUPT)
    return StoreResult.Ok(parsed.comments)
}

// ---------------------------------------------------------------------------
// Mutations — every one goes through mutateSidecar (read-modify-write inside
// a per-sidecar-path Mutex, atomic tmp-then-rename write), never a bare
// read-then-write.
// ---------------------------------------------------------------------------

private val locks = ConcurrentHashMap<String, Mutex>()
private fun lockFor(sidecarPath: String): Mutex = locks.computeIfAbsent(sidecarPath) { Mutex() }

private sealed class Apply<out T> {
    data class Applied<T>(val file: CommentsSidecarFile, val extra: T) : Apply<T>()
    object NotFound : Apply<Nothing>()
}

private fun writeSidecarAtomic(target: File, content: String) {
    target.parentFile?.mkdirs()
    val tmp = File(target.parentFile, target.name + ".tmp")
    tmp.writeText(content, Charsets.UTF_8)
    try {
        Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    } catch (_: java.nio.file.AtomicMoveNotSupportedException) {
        Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
    }
}

private suspend fun <T> mutateSidecar(sidecarPath: String, apply: (CommentsSidecarFile) -> Apply<T>): StoreResult<T> {
    return lockFor(sidecarPath).withLock {
        val file = File(sidecarPath)
        // WHY a read failure on an EXISTING file refuses rather than falling
        // back to an empty sidecar: silently treating "exists but unreadable"
        // the same as "doesn't exist yet" would let this mutation WRITE a
        // fresh, empty-plus-one-comment file over whatever couldn't be read —
        // discarding history a corrupt-but-present file might still hold.
        // Only a genuinely absent file gets the empty-sidecar default,
        // mirroring desktop's own `mutateSidecar` (doc-comments-store.ts).
        val current = if (!file.exists()) {
            CommentsSidecarFile.empty()
        } else {
            val onDisk = try {
                file.readText(Charsets.UTF_8)
            } catch (_: java.io.IOException) {
                return@withLock StoreResult.Err(DocCommentsError.SIDECAR_CORRUPT)
            }
            CommentsSidecarFile.parse(onDisk) ?: return@withLock StoreResult.Err(DocCommentsError.SIDECAR_CORRUPT)
        }
        when (val applied = apply(current)) {
            is Apply.NotFound -> StoreResult.Err(DocCommentsError.COMMENT_NOT_FOUND)
            is Apply.Applied -> {
                writeSidecarAtomic(file, applied.file.toJson().toString())
                StoreResult.Ok(applied.extra)
            }
        }
    }
}

private fun findComment(file: CommentsSidecarFile, id: String): PersistedComment? = file.comments.find { it.id == id }

private fun replaceComment(file: CommentsSidecarFile, id: String, next: PersistedComment): CommentsSidecarFile =
    CommentsSidecarFile(file.version, file.comments.map { if (it.id == id) next else it })

/** Account-ready id (§1.2): a UUID, never a counter. */
suspend fun addComment(
    path: String,
    projectRoot: String?,
    selector: CommentSelector,
    text: String,
    author: CommentAuthor,
    homeDir: File,
): StoreResult<String> {
    val resolved = resolveSidecarPath(path, projectRoot, homeDir)
    if (resolved is StoreResult.Err) return resolved
    val sidecarPath = (resolved as StoreResult.Ok).value
    val id = "c-" + java.util.UUID.randomUUID().toString()
    val comment = PersistedComment(
        id = id, path = path, selector = selector, text = text, author = author,
        createdAt = System.currentTimeMillis(), replies = emptyList(), resolved = false, history = emptyList(),
    )
    return mutateSidecar(sidecarPath) { file ->
        Apply.Applied(CommentsSidecarFile(file.version, file.comments + comment), id)
    }
}

suspend fun replyToComment(
    path: String,
    projectRoot: String?,
    id: String,
    text: String,
    author: CommentAuthor,
    homeDir: File,
): StoreResult<Unit> {
    val resolved = resolveSidecarPath(path, projectRoot, homeDir)
    if (resolved is StoreResult.Err) return resolved
    val sidecarPath = (resolved as StoreResult.Ok).value
    return mutateSidecar(sidecarPath) { file ->
        val comment = findComment(file, id) ?: return@mutateSidecar Apply.NotFound
        val replyId = "${comment.id}-r${comment.replies.size + 1}"
        val next = comment.copy(replies = comment.replies + CommentReply(replyId, author, text, System.currentTimeMillis()))
        Apply.Applied(replaceComment(file, id, next), Unit)
    }
}

suspend fun resolveComment(path: String, projectRoot: String?, id: String, by: CommentAuthor, homeDir: File): StoreResult<Unit> {
    val resolved = resolveSidecarPath(path, projectRoot, homeDir)
    if (resolved is StoreResult.Err) return resolved
    val sidecarPath = (resolved as StoreResult.Ok).value
    return mutateSidecar(sidecarPath) { file ->
        val comment = findComment(file, id) ?: return@mutateSidecar Apply.NotFound
        val next = comment.copy(
            resolved = true,
            // Full audit trail (§1.1) — not just the latest state.
            history = comment.history + ResolveEvent(by, System.currentTimeMillis(), "resolved"),
        )
        Apply.Applied(replaceComment(file, id, next), Unit)
    }
}

suspend fun reopenComment(path: String, projectRoot: String?, id: String, by: CommentAuthor, homeDir: File): StoreResult<Unit> {
    val resolved = resolveSidecarPath(path, projectRoot, homeDir)
    if (resolved is StoreResult.Err) return resolved
    val sidecarPath = (resolved as StoreResult.Ok).value
    return mutateSidecar(sidecarPath) { file ->
        val comment = findComment(file, id) ?: return@mutateSidecar Apply.NotFound
        val next = comment.copy(
            resolved = false,
            history = comment.history + ResolveEvent(by, System.currentTimeMillis(), "reopened"),
        )
        Apply.Applied(replaceComment(file, id, next), Unit)
    }
}

/** §2/§5's re-anchor tool target: replace a comment's selector wholesale.
 *  This store trusts whatever selector it's given — deciding whether/where a
 *  selector resolves is the anchoring pass's job (§2), which runs in the
 *  WebView over the shared doc-comments-anchor.ts, not this Kotlin module. */
suspend fun moveComment(path: String, projectRoot: String?, id: String, newSelector: CommentSelector, homeDir: File): StoreResult<Unit> {
    val resolved = resolveSidecarPath(path, projectRoot, homeDir)
    if (resolved is StoreResult.Err) return resolved
    val sidecarPath = (resolved as StoreResult.Ok).value
    return mutateSidecar(sidecarPath) { file ->
        val comment = findComment(file, id) ?: return@mutateSidecar Apply.NotFound
        Apply.Applied(replaceComment(file, id, comment.copy(selector = newSelector)), Unit)
    }
}
