package com.youcoded.app.runtime

import com.youcoded.app.runtime.restore.DriveRestoreAdapter
import com.youcoded.app.runtime.restore.GithubRestoreAdapter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * RestoreService.kt — Kotlin port of desktop/src/main/restore-service.ts.
 *
 * Directional, user-initiated restore from a cloud backup. This is NOT sync —
 * sync is bidirectional merge; restore is a one-time pull where the remote is
 * treated as authoritative. Different invariants, different code paths.
 *
 * Safety invariants (enforced here, matching desktop parity):
 *   1. Snapshot-first by default — current local data is directory-copied to
 *      ~/.claude/restore-snapshots/<ISO>/<category>/ before any overwrite.
 *      (Directory snapshots — NOT tar.gz — for parity with desktop + simpler undo.)
 *   2. Push loop paused — SyncService.restoreInProgress is flipped true during
 *      execute/undo so the 15-minute push doesn't upload half-restored state.
 *   3. Atomic per-category — each category is staged under
 *      ~/.claude/.restore-staging/<category>/, then the live dir is swapped
 *      in via a rename pair with a .old.<ts> intermediate. Crash leaves either
 *      the old or new dir, never a mix. (The .old intermediate is load-bearing
 *      on Windows; on Linux the rename-over-empty-dir semantics work, but we
 *      keep the pattern for parity + rollback safety.)
 *
 * Retention: snapshots older than 90 days are pruned on app start; cap 10.
 * Progress events are throttled to 250ms per category to avoid WS flooding.
 */
class RestoreService(
    private val syncService: SyncService,
    private val claudeDir: File,
) {
    private val snapshotsRoot = File(claudeDir, "restore-snapshots")
    private val stagingRoot = File(claudeDir, ".restore-staging")

    companion object {
        private const val SNAPSHOT_RETENTION_DAYS = 90
        private const val SNAPSHOT_CAP = 10
        private const val PROGRESS_THROTTLE_MS = 250L
    }

    // =========================================================================
    // Adapter dispatch
    // =========================================================================

    /** Resolve a backend instance id → its full JSON record from config.json. */
    private fun getBackendInstance(backendId: String): JSONObject? {
        val configFile = File(claudeDir, "toolkit-state/config.json")
        if (!configFile.exists()) return null
        return try {
            val config = JSONObject(configFile.readText())
            val backends = config.optJSONArray("storage_backends") ?: return null
            for (i in 0 until backends.length()) {
                val b = backends.getJSONObject(i)
                if (b.optString("id") == backendId) return b
            }
            null
        } catch (_: Exception) { null }
    }

    private fun adapterFor(backendId: String): RestoreAdapter {
        val instance = getBackendInstance(backendId)
            ?: throw IllegalArgumentException("No backend with id '$backendId'")
        return when (instance.optString("type")) {
            "drive" -> DriveRestoreAdapter(instance, claudeDir, syncService)
            "github" -> GithubRestoreAdapter(instance, claudeDir, syncService)
            // iCloud is intentionally unsupported on Android — desktop-only backend.
            else -> throw IllegalArgumentException("Unsupported backend type: ${instance.optString("type")}")
        }
    }

    // =========================================================================
    // Category path resolution
    // =========================================================================

    /**
     * Canonical live path for a category. Memory + conversations share the
     * ~/.claude/projects/ tree (memory in a per-project memory/ subdir,
     * conversations as .jsonl files). We swap the whole projects tree so
     * cross-project partial restore stays atomic; the adapter selects only
     * the relevant files into staging.
     */
    fun liveDirFor(category: RestoreCategory): File = when (category) {
        RestoreCategory.MEMORY, RestoreCategory.CONVERSATIONS -> File(claudeDir, "projects")
        RestoreCategory.ENCYCLOPEDIA -> File(claudeDir, "encyclopedia")
        RestoreCategory.SKILLS -> File(claudeDir, "skills")
        RestoreCategory.PLANS -> File(claudeDir, "plans")
        RestoreCategory.SPECS -> File(claudeDir, "specs")
    }

    fun stagingDirFor(category: RestoreCategory): File =
        File(stagingRoot, category.wire)

    // =========================================================================
    // Public API
    // =========================================================================

    suspend fun probe(backendId: String): Pair<Boolean, List<RestoreCategory>> = withContext(Dispatchers.IO) {
        try {
            adapterFor(backendId).probe()
        } catch (_: Exception) {
            Pair(false, emptyList())
        }
    }

    suspend fun listVersions(backendId: String): List<RestorePoint> = withContext(Dispatchers.IO) {
        adapterFor(backendId).listVersions()
    }

    suspend fun previewRestore(opts: RestoreOptions): RestorePreview = withContext(Dispatchers.IO) {
        val adapter = adapterFor(opts.backendId)
        val raw = mutableListOf<CategoryPreview>()
        val warnings = mutableListOf<String>()

        for (category in opts.categories) {
            try {
                raw.add(adapter.previewCategory(category, opts.versionRef))
            } catch (e: Exception) {
                warnings.add("Preview failed for ${category.wire}: ${e.message ?: e}")
                raw.add(CategoryPreview(category, 0, 0, 0, 0, 0, 0))
            }
        }

        // For merge mode, reinterpret the same raw counts:
        //   - toDelete=0 (merge never deletes locally; those files stay + get uploaded)
        //   - toUpload = original toDelete (they go up to the backup instead of away)
        // Wipe keeps the as-measured shape.
        val perCategory: List<CategoryPreview> = raw.map { p ->
            if (opts.mode == RestoreMode.MERGE) {
                p.copy(toUpload = p.toDelete, toDelete = 0)
            } else p
        }

        val totalBytes = perCategory.sumOf { it.bytes }

        // Skip the restart hint in merge mode — merge doesn't swap live dirs.
        if (opts.mode == RestoreMode.WIPE &&
            (opts.categories.contains(RestoreCategory.SKILLS) ||
             opts.categories.contains(RestoreCategory.MEMORY))) {
            warnings.add("Skills or memory restored — app restart recommended to pick up changes.")
        }
        if (opts.mode == RestoreMode.WIPE && perCategory.any { it.toDelete > 0 }) {
            warnings.add("Wipe & restore will DELETE local files not present in the backup.")
        }

        // Rough estimate: 10 MB/s effective throughput after overhead. Cellular
        // on Android will be slower — this is a UX hint, not a contract.
        val estimatedSeconds = maxOf(3L, (totalBytes + 10L * 1024 * 1024 - 1) / (10L * 1024 * 1024))

        RestorePreview(perCategory, totalBytes, estimatedSeconds, warnings, opts.mode)
    }

    /**
     * Resolve a browse URL for a single category on the remote backend.
     * Returns null if the adapter doesn't support browse links or lookup fails.
     */
    suspend fun browseCategoryUrl(
        backendId: String,
        category: RestoreCategory,
        versionRef: String,
    ): String? = withContext(Dispatchers.IO) {
        try {
            adapterFor(backendId).remoteBrowseUrlFor(category, versionRef)
        } catch (_: Exception) {
            null
        }
    }

    suspend fun executeRestore(
        opts: RestoreOptions,
        onProgress: (RestoreProgressEvent) -> Unit,
    ): RestoreResult {
        // Merge mode reuses the sync loop's pull + push (remote → local
        // add/overwrite with no deletions, then local → remote upload for
        // anything local-only). This is NON-destructive on both sides, so no
        // snapshot is needed and we explicitly do NOT flip restoreInProgress
        // — we actually want the push to run.
        return if (opts.mode == RestoreMode.MERGE) {
            executeMerge(opts, onProgress)
        } else {
            executeWipe(opts, onProgress)
        }
    }

    private suspend fun executeMerge(
        opts: RestoreOptions,
        onProgress: (RestoreProgressEvent) -> Unit,
    ): RestoreResult = withContext(Dispatchers.IO) {
        val startedAt = System.currentTimeMillis()

        // Emit a single 'fetching' phase for each category up-front so the UI
        // renders per-category rows. Merge doesn't stage per-category, so we
        // don't get file-level progress — just the two top-level phases.
        for (category in opts.categories) {
            onProgress(RestoreProgressEvent(category, 0, 0, null, "fetching"))
        }

        // Phase 1: pull remote → local (add + overwrite-newer, no deletions).
        syncService.pull(backendId = opts.backendId)

        // Phase 2: push local → remote (uploads anything local-only). force=true
        // so the push isn't skipped for being recent — the user just asked for it.
        syncService.push(force = true, backendId = opts.backendId)

        for (category in opts.categories) {
            onProgress(RestoreProgressEvent(category, 1, 1, null, "done"))
        }

        RestoreResult(
            snapshotId = null,
            categoriesRestored = opts.categories,
            filesWritten = 0, // merge doesn't track per-file writes; sync logs it
            durationMs = System.currentTimeMillis() - startedAt,
            requiresRestart = opts.categories.contains(RestoreCategory.SKILLS) ||
                              opts.categories.contains(RestoreCategory.MEMORY),
        )
    }

    private suspend fun executeWipe(
        opts: RestoreOptions,
        onProgress: (RestoreProgressEvent) -> Unit,
    ): RestoreResult = withContext(Dispatchers.IO) {
        val startedAt = System.currentTimeMillis()
        val adapter = adapterFor(opts.backendId)

        // Pause SyncService push loop so a tick can't run mid-restore and
        // upload a half-swapped staging dir to the backup.
        syncService.restoreInProgress = true
        var snapshotId: String? = null
        var filesWritten = 0

        // Per-category throttle — phase transitions emit immediately, only
        // file-level staging/fetching events are throttled.
        val lastEmitAt = HashMap<RestoreCategory, Long>()
        val emit: (RestoreProgressEvent) -> Unit = { evt ->
            val now = System.currentTimeMillis()
            val last = lastEmitAt[evt.category] ?: 0L
            val isPhaseEvent = evt.phase != "fetching" && evt.phase != "staging"
            if (isPhaseEvent || now - last >= PROGRESS_THROTTLE_MS) {
                lastEmitAt[evt.category] = now
                onProgress(evt)
            }
        }

        try {
            stagingRoot.mkdirs()
            snapshotsRoot.mkdirs()

            // --- 1. Snapshot current local state ---
            if (opts.snapshotFirst) {
                snapshotId = isoStamp()
                val snapshotDir = File(snapshotsRoot, snapshotId)
                snapshotDir.mkdirs()
                for (category in opts.categories) {
                    emit(RestoreProgressEvent(category, 0, 0, null, "snapshotting"))
                    val liveDir = liveDirFor(category)
                    if (liveDir.exists()) {
                        val dest = File(snapshotDir, category.wire)
                        // Directory snapshot (not tar.gz) — parity with desktop's
                        // fs.cpSync; cheaper and simpler undo. File.copyRecursively
                        // is Kotlin's cross-platform deep copy.
                        liveDir.copyRecursively(dest, overwrite = true)
                    }
                }
                // Sidecar manifest for SnapshotsPanel.
                val manifest = Snapshot(
                    id = snapshotId,
                    timestamp = System.currentTimeMillis(),
                    categories = opts.categories,
                    backendId = opts.backendId,
                    sizeBytes = dirSize(snapshotDir),
                    triggeredBy = "restore",
                )
                File(snapshotDir, "manifest.json").writeText(manifest.toJson().toString(2))
            }

            // --- 2. Fetch each category into staging, then atomic swap ---
            for (category in opts.categories) {
                emit(RestoreProgressEvent(category, 0, 0, null, "fetching"))
                val staging = stagingDirFor(category)
                // Clean any staging remnant from a prior crashed run.
                runCatching { staging.deleteRecursively() }
                staging.mkdirs()

                adapter.fetchInto(category, staging, opts.versionRef) { filename, done, total ->
                    filesWritten++
                    emit(RestoreProgressEvent(category, done, total, filename, "staging"))
                }

                emit(RestoreProgressEvent(category, 1, 1, null, "swapping"))
                atomicSwap(staging, liveDirFor(category))
                emit(RestoreProgressEvent(category, 1, 1, null, "done"))
            }

            RestoreResult(
                snapshotId = snapshotId,
                categoriesRestored = opts.categories,
                filesWritten = filesWritten,
                durationMs = System.currentTimeMillis() - startedAt,
                requiresRestart = opts.categories.contains(RestoreCategory.SKILLS) ||
                                  opts.categories.contains(RestoreCategory.MEMORY),
            )
        } finally {
            syncService.restoreInProgress = false
            // Best-effort staging cleanup. Orphaned dirs are also swept on app start.
            runCatching { stagingRoot.deleteRecursively() }
        }
    }

    fun listSnapshots(): List<Snapshot> {
        if (!snapshotsRoot.exists()) return emptyList()
        val out = mutableListOf<Snapshot>()
        snapshotsRoot.listFiles()?.forEach { dir ->
            if (!dir.isDirectory) return@forEach
            val manifestFile = File(dir, "manifest.json")
            try {
                out.add(Snapshot.fromJson(JSONObject(manifestFile.readText())))
            } catch (_: Exception) {
                // Missing/corrupt manifest — synthesize minimal metadata from dirname.
                out.add(Snapshot(
                    id = dir.name,
                    timestamp = parseIsoStamp(dir.name),
                    categories = emptyList(),
                    backendId = "",
                    sizeBytes = 0L,
                    triggeredBy = "manual",
                ))
            }
        }
        return out.sortedByDescending { it.timestamp }
    }

    suspend fun undoRestore(snapshotId: String): Unit = withContext(Dispatchers.IO) {
        val snapshotDir = File(snapshotsRoot, snapshotId)
        if (!snapshotDir.exists()) throw IllegalArgumentException("Snapshot $snapshotId not found")
        val manifestFile = File(snapshotDir, "manifest.json")
        val manifest = Snapshot.fromJson(JSONObject(manifestFile.readText()))

        syncService.restoreInProgress = true
        try {
            for (category in manifest.categories) {
                val source = File(snapshotDir, category.wire)
                if (!source.exists()) continue
                val staging = stagingDirFor(category)
                runCatching { staging.deleteRecursively() }
                staging.parentFile?.mkdirs()
                source.copyRecursively(staging, overwrite = true)
                atomicSwap(staging, liveDirFor(category))
            }
        } finally {
            syncService.restoreInProgress = false
            runCatching { stagingRoot.deleteRecursively() }
        }
    }

    fun deleteSnapshot(snapshotId: String) {
        val dir = File(snapshotsRoot, snapshotId)
        if (dir.exists()) dir.deleteRecursively()
    }

    // =========================================================================
    // Lifecycle hooks — called from SessionService.initBootstrap after SyncService starts
    // =========================================================================

    /** Delete orphaned staging dirs left behind by a crashed restore. Safe to call always. */
    fun cleanupOrphanedStaging() {
        runCatching { if (stagingRoot.exists()) stagingRoot.deleteRecursively() }
    }

    /** Delete snapshots older than RETENTION_DAYS, then cap count. Best-effort. */
    fun enforceRetention() {
        try {
            if (!snapshotsRoot.exists()) return
            val cutoff = System.currentTimeMillis() - SNAPSHOT_RETENTION_DAYS * 86_400_000L
            val entries = snapshotsRoot.listFiles()
                ?.filter { it.isDirectory }
                ?.map { Pair(it, parseIsoStamp(it.name)) }
                ?.sortedBy { it.second }
                ?: return
            for ((file, ts) in entries) {
                if (ts < cutoff) runCatching { file.deleteRecursively() }
            }
            // Recompute and enforce cap.
            val remaining = snapshotsRoot.listFiles()
                ?.filter { it.isDirectory }
                ?.map { Pair(it, parseIsoStamp(it.name)) }
                ?.sortedBy { it.second }
                ?: return
            val overflow = remaining.size - SNAPSHOT_CAP
            for (i in 0 until overflow) {
                runCatching { remaining[i].first.deleteRecursively() }
            }
        } catch (_: Exception) {}
    }

    // =========================================================================
    // Internals
    // =========================================================================

    /**
     * Atomic directory swap: staging → live, via .old.<ts> intermediate.
     * Pattern: rename live → live.old, rename staging → live, delete live.old.
     * On any failure, rolls back (live.old → live). Keeps parity with desktop's
     * Windows-safe rename dance even though Linux/Android rename semantics are
     * more permissive — rollback safety on partial failure is the load-bearing part.
     */
    private fun atomicSwap(stagingDir: File, liveDir: File) {
        val oldDir = File("${liveDir.absolutePath}.old.${System.currentTimeMillis()}")
        val liveExists = liveDir.exists()
        liveDir.parentFile?.mkdirs()

        try {
            if (liveExists) {
                if (!liveDir.renameTo(oldDir)) {
                    throw java.io.IOException("rename live→old failed for ${liveDir.absolutePath}")
                }
            }
            if (!stagingDir.renameTo(liveDir)) {
                // Rollback — put live back so the user isn't left with no data.
                if (liveExists && oldDir.exists() && !liveDir.exists()) {
                    runCatching { oldDir.renameTo(liveDir) }
                }
                throw java.io.IOException("rename staging→live failed for ${liveDir.absolutePath}")
            }
        } catch (e: Exception) {
            if (liveExists && oldDir.exists() && !liveDir.exists()) {
                runCatching { oldDir.renameTo(liveDir) }
            }
            throw e
        }

        if (liveExists) {
            // Best-effort delete of old — failure leaves .old.<ts> for manual cleanup
            // rather than failing the restore.
            runCatching { oldDir.deleteRecursively() }
        }
    }

    /** Filesystem-safe ISO-8601 timestamp (no colons). Matches desktop's isoStamp(). */
    private fun isoStamp(): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH-mm-ss-SSS'Z'", Locale.US)
        fmt.timeZone = TimeZone.getTimeZone("UTC")
        return fmt.format(Date())
    }

    /** Parse the filesystem-safe stamp back to epoch ms (best-effort, 0 on failure). */
    private fun parseIsoStamp(s: String): Long {
        return try {
            val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH-mm-ss-SSS'Z'", Locale.US)
            fmt.timeZone = TimeZone.getTimeZone("UTC")
            fmt.parse(s)?.time ?: 0L
        } catch (_: Exception) {
            0L
        }
    }

    private fun dirSize(dir: File): Long {
        var total = 0L
        val stack = ArrayDeque<File>()
        stack.addLast(dir)
        while (stack.isNotEmpty()) {
            val d = stack.removeLast()
            val entries = d.listFiles() ?: continue
            for (e in entries) {
                when {
                    e.isDirectory -> stack.addLast(e)
                    e.isFile -> total += e.length()
                }
            }
        }
        return total
    }
}

// ---------------------------------------------------------------------------
// Shared helpers used by adapters
// ---------------------------------------------------------------------------

/** Walk a directory and return (relativePaths, totalBytes). Matches desktop's walkFiles. */
internal fun walkRestoreFiles(dir: File): Pair<List<String>, Long> {
    val files = mutableListOf<String>()
    var bytes = 0L
    if (!dir.exists()) return Pair(files, bytes)
    val stack = ArrayDeque<File>()
    stack.addLast(dir)
    while (stack.isNotEmpty()) {
        val d = stack.removeLast()
        val entries = d.listFiles() ?: continue
        for (e in entries) {
            when {
                e.isDirectory -> stack.addLast(e)
                e.isFile -> {
                    files.add(e.relativeTo(dir).path.replace(File.separatorChar, '/'))
                    bytes += e.length()
                }
            }
        }
    }
    return Pair(files, bytes)
}
