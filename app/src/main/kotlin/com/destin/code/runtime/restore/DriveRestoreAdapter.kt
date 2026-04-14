package com.destin.code.runtime.restore

import com.destin.code.runtime.CategoryPreview
import com.destin.code.runtime.RestoreAdapter
import com.destin.code.runtime.RestoreCategory
import com.destin.code.runtime.RestorePoint
import com.destin.code.runtime.SyncService
import com.destin.code.runtime.walkRestoreFiles
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * DriveRestoreAdapter — rclone-backed restore adapter for Google Drive (Android port).
 *
 * Drive is HEAD-only (overwrite-in-place, no history). listVersions() returns
 * a single "Current backup" entry. fetchInto() shells out to `rclone sync`
 * which gives directional semantics (remote → local) — exactly what restore
 * needs, unlike `rclone copy --update` used by the normal sync push loop.
 *
 * All shell-outs route through SyncService.execCommand() which in turn uses
 * Bootstrap.buildRuntimeEnv() — so rclone runs with LD_LIBRARY_PATH and
 * LD_PRELOAD set correctly for SELinux-safe binary execution through linker64.
 */
class DriveRestoreAdapter(
    private val instance: JSONObject,
    private val claudeDir: File,
    private val syncService: SyncService,
) : RestoreAdapter {

    private val rcloneRemote: String
    private val driveRoot: String

    init {
        val cfg = instance.optJSONObject("config") ?: JSONObject()
        rcloneRemote = cfg.optString("rcloneRemote", "gdrive").ifEmpty { "gdrive" }
        driveRoot = cfg.optString("DRIVE_ROOT", "Claude").ifEmpty { "Claude" }
    }

    /** Mirror the layout SyncService.pushDrive uses. */
    private fun categoryRemoteSubpath(category: RestoreCategory): String = when (category) {
        RestoreCategory.MEMORY, RestoreCategory.CONVERSATIONS -> "projects"
        RestoreCategory.ENCYCLOPEDIA -> "encyclopedia"
        RestoreCategory.SKILLS -> "skills"
        RestoreCategory.PLANS -> "plans"
        RestoreCategory.SPECS -> "specs"
    }

    private fun remotePath(category: RestoreCategory): String =
        "$rcloneRemote:$driveRoot/${categoryRemoteSubpath(category)}"

    private fun rclone(args: List<String>, timeoutSeconds: Long = 60L): SyncService.ExecResult {
        return syncService.execCommand(listOf("rclone") + args, timeoutSeconds = timeoutSeconds)
    }

    override suspend fun listVersions(): List<RestorePoint> = listOf(
        RestorePoint(ref = "HEAD", timestamp = System.currentTimeMillis(), label = "Current backup")
    )

    override suspend fun probe(): Pair<Boolean, List<RestoreCategory>> = withContext(Dispatchers.IO) {
        val categories = mutableListOf<RestoreCategory>()
        try {
            val r = rclone(listOf("lsjson", "$rcloneRemote:$driveRoot", "--max-depth", "1"), timeoutSeconds = 30L)
            if (r.code != 0) return@withContext Pair(false, emptyList<RestoreCategory>())
            val arr = JSONArray(r.stdout)
            val dirNames = mutableSetOf<String>()
            for (i in 0 until arr.length()) {
                val e = arr.getJSONObject(i)
                if (e.optBoolean("IsDir")) dirNames.add(e.optString("Name"))
            }
            if (dirNames.contains("projects")) {
                categories.add(RestoreCategory.MEMORY)
                categories.add(RestoreCategory.CONVERSATIONS)
            }
            if (dirNames.contains("encyclopedia")) categories.add(RestoreCategory.ENCYCLOPEDIA)
            if (dirNames.contains("skills")) categories.add(RestoreCategory.SKILLS)
            if (dirNames.contains("plans")) categories.add(RestoreCategory.PLANS)
            if (dirNames.contains("specs")) categories.add(RestoreCategory.SPECS)
        } catch (_: Exception) {
            return@withContext Pair(false, emptyList<RestoreCategory>())
        }
        Pair(categories.isNotEmpty(), categories)
    }

    override suspend fun previewCategory(
        category: RestoreCategory,
        versionRef: String,
    ): CategoryPreview = withContext(Dispatchers.IO) {
        val remote = remotePath(category)
        val local = File(claudeDir, categoryRemoteSubpath(category))

        // Map of remote path → size
        val remoteFiles = HashMap<String, Long>()
        try {
            val r = rclone(listOf("lsjson", remote, "--recursive", "--files-only"), timeoutSeconds = 60L)
            if (r.code == 0) {
                val arr = JSONArray(r.stdout)
                for (i in 0 until arr.length()) {
                    val e = arr.getJSONObject(i)
                    remoteFiles[e.optString("Path")] = e.optLong("Size", 0L)
                }
            }
            // code != 0 likely means remote doesn't exist — treat as empty backup.
        } catch (_: Exception) {}

        val (localFiles, _) = walkRestoreFiles(local)
        val localSet = localFiles.toHashSet()
        val remoteSet = remoteFiles.keys

        var toAdd = 0
        var toOverwrite = 0
        var bytes = 0L
        for ((p, sz) in remoteFiles) {
            if (localSet.contains(p)) toOverwrite++ else toAdd++
            bytes += sz
        }
        var toDelete = 0
        for (p in localSet) if (!remoteSet.contains(p)) toDelete++

        CategoryPreview(
            category = category,
            remoteFiles = remoteFiles.size,
            localFiles = localFiles.size,
            toAdd = toAdd,
            toOverwrite = toOverwrite,
            toDelete = toDelete,
            bytes = bytes,
        )
    }

    override suspend fun fetchInto(
        category: RestoreCategory,
        stagingDir: File,
        versionRef: String,
        onFile: ((String, Int, Int) -> Unit)?,
    ): Unit = withContext(Dispatchers.IO) {
        val remote = remotePath(category)
        // `rclone sync` is a destructive mirror from remote → staging.
        // --create-empty-src-dirs preserves empty subdirs (memory/ often has
        // empty per-project dirs on fresh projects).
        val r = rclone(
            listOf("sync", remote, stagingDir.absolutePath, "--create-empty-src-dirs", "--stats-one-line"),
            timeoutSeconds = 300L,
        )
        if (r.code != 0) {
            throw java.io.IOException("rclone sync failed (code=${r.code}): ${r.stderr}")
        }

        // Emit one terminal progress event so UI flips staging → swapping.
        onFile?.let {
            val (files, _) = walkRestoreFiles(stagingDir)
            it("", files.size, files.size)
        }
    }
}
