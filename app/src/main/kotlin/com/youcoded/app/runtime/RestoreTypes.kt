package com.youcoded.app.runtime

import org.json.JSONArray
import org.json.JSONObject

/**
 * Kotlin data classes mirroring desktop/src/shared/types.ts restore section.
 * Field names match the TS types exactly so the WebSocket IPC payloads are
 * identical on desktop and Android (the React UI is shared — see
 * docs/shared-ui-architecture.md).
 */

/** The categories restore can operate on. Must match TS RestoreCategory union. */
enum class RestoreCategory(val wire: String) {
    MEMORY("memory"),
    CONVERSATIONS("conversations"),
    ENCYCLOPEDIA("encyclopedia"),
    SKILLS("skills"),
    PLANS("plans"),
    SPECS("specs");

    companion object {
        fun fromWire(s: String): RestoreCategory? = values().firstOrNull { it.wire == s }
        val ALL: List<RestoreCategory> = values().toList()
    }
}

/**
 * Restore mode — must match TS RestoreMode ('merge' | 'wipe').
 * - MERGE: union. Remote→local add/overwrite only, then local→remote upload
 *          for local-only files (reuses sync loop). Non-destructive both sides.
 * - WIPE:  mirror. Local tree replaced with the backup exactly. Snapshot-first
 *          is forced so undo works.
 * Wire values are lowercase strings — Kotlin enum name lowercased.
 */
enum class RestoreMode(val wire: String) {
    MERGE("merge"),
    WIPE("wipe");

    companion object {
        fun fromWire(s: String?): RestoreMode =
            values().firstOrNull { it.wire == s } ?: WIPE
    }
}

/**
 * A restorable point in time. 'HEAD' for Drive (overwrite-in-place, no history);
 * a git SHA for GitHub (full commit history surfaced as PIT options).
 */
data class RestorePoint(
    val ref: String,
    val timestamp: Long,
    val label: String,
    val summary: String? = null,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("ref", ref)
        put("timestamp", timestamp)
        put("label", label)
        if (summary != null) put("summary", summary)
    }
}

data class RestoreOptions(
    val backendId: String,
    val versionRef: String,
    val categories: List<RestoreCategory>,
    val snapshotFirst: Boolean,
    /** Mode: MERGE (non-destructive union) or WIPE (mirror, with snapshot-first). */
    val mode: RestoreMode,
) {
    companion object {
        fun fromJson(j: JSONObject): RestoreOptions {
            val catsArr = j.optJSONArray("categories") ?: JSONArray()
            val cats = mutableListOf<RestoreCategory>()
            for (i in 0 until catsArr.length()) {
                RestoreCategory.fromWire(catsArr.getString(i))?.let { cats.add(it) }
            }
            return RestoreOptions(
                backendId = j.optString("backendId", ""),
                versionRef = j.optString("versionRef", "HEAD"),
                categories = cats,
                snapshotFirst = j.optBoolean("snapshotFirst", true),
                // Mode defaults to WIPE if missing — matches the historical
                // behavior before the merge/wipe split existed.
                mode = RestoreMode.fromWire(if (j.has("mode")) j.optString("mode") else null),
            )
        }
    }
}

data class CategoryPreview(
    val category: RestoreCategory,
    val remoteFiles: Int,
    val localFiles: Int,
    val toAdd: Int,
    val toOverwrite: Int,
    /** Files on device NOT on the backup — wipe deletes these; merge leaves them. */
    val toDelete: Int,
    val bytes: Long,
    /** Merge-mode only: files present locally but NOT on backup (will be uploaded). */
    val toUpload: Int? = null,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("category", category.wire)
        put("remoteFiles", remoteFiles)
        put("localFiles", localFiles)
        put("toAdd", toAdd)
        put("toOverwrite", toOverwrite)
        put("toDelete", toDelete)
        put("bytes", bytes)
        if (toUpload != null) put("toUpload", toUpload)
    }
}

data class RestorePreview(
    val perCategory: List<CategoryPreview>,
    val totalBytes: Long,
    val estimatedSeconds: Long,
    val warnings: List<String>,
    /** Echoes the mode the preview was computed for — UI keys column labels off this. */
    val mode: RestoreMode,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        val arr = JSONArray()
        perCategory.forEach { arr.put(it.toJson()) }
        put("perCategory", arr)
        put("totalBytes", totalBytes)
        put("estimatedSeconds", estimatedSeconds)
        put("warnings", JSONArray(warnings))
        put("mode", mode.wire)
    }
}

data class RestoreResult(
    val snapshotId: String?,
    val categoriesRestored: List<RestoreCategory>,
    val filesWritten: Int,
    val durationMs: Long,
    /** true if skills/memory restored — app restart recommended. */
    val requiresRestart: Boolean,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        if (snapshotId != null) put("snapshotId", snapshotId)
        put("categoriesRestored", JSONArray(categoriesRestored.map { it.wire }))
        put("filesWritten", filesWritten)
        put("durationMs", durationMs)
        put("requiresRestart", requiresRestart)
    }
}

data class Snapshot(
    val id: String,
    val timestamp: Long,
    val categories: List<RestoreCategory>,
    val backendId: String,
    val sizeBytes: Long,
    val triggeredBy: String, // 'restore' | 'manual'
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("timestamp", timestamp)
        put("categories", JSONArray(categories.map { it.wire }))
        put("backendId", backendId)
        put("sizeBytes", sizeBytes)
        put("triggeredBy", triggeredBy)
    }

    companion object {
        fun fromJson(j: JSONObject): Snapshot {
            val catsArr = j.optJSONArray("categories") ?: JSONArray()
            val cats = mutableListOf<RestoreCategory>()
            for (i in 0 until catsArr.length()) {
                RestoreCategory.fromWire(catsArr.getString(i))?.let { cats.add(it) }
            }
            return Snapshot(
                id = j.getString("id"),
                timestamp = j.optLong("timestamp", 0L),
                categories = cats,
                backendId = j.optString("backendId", ""),
                sizeBytes = j.optLong("sizeBytes", 0L),
                triggeredBy = j.optString("triggeredBy", "manual"),
            )
        }
    }
}

/** Progress event broadcast over the bridge as 'sync:restore:progress'. */
data class RestoreProgressEvent(
    val category: RestoreCategory,
    val filesDone: Int,
    val filesTotal: Int,
    val currentFile: String? = null,
    /** 'snapshotting' | 'fetching' | 'staging' | 'swapping' | 'done' | 'error' */
    val phase: String,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("category", category.wire)
        put("filesDone", filesDone)
        put("filesTotal", filesTotal)
        if (currentFile != null) put("currentFile", currentFile)
        put("phase", phase)
    }
}

/**
 * Adapter contract — one implementation per backend (drive, github).
 * Mirrors desktop's RestoreAdapter interface in restore-service.ts.
 */
interface RestoreAdapter {
    suspend fun listVersions(): List<RestorePoint>
    suspend fun previewCategory(category: RestoreCategory, versionRef: String): CategoryPreview
    /**
     * Fetch the backup contents for [category] into [stagingDir]. onFile is
     * optional progress signal (filename, done, total).
     */
    suspend fun fetchInto(
        category: RestoreCategory,
        stagingDir: java.io.File,
        versionRef: String,
        onFile: ((String, Int, Int) -> Unit)? = null,
    )
    suspend fun probe(): Pair<Boolean, List<RestoreCategory>>
    /**
     * Optional — return a URL that opens this category's browse view on the
     * remote backend (Drive folder, GitHub tree). Null means the adapter
     * doesn't support browse links. Used by the preview UI.
     */
    suspend fun remoteBrowseUrlFor(category: RestoreCategory, versionRef: String): String? = null
}
