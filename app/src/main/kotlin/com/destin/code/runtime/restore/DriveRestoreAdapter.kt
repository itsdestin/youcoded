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
 * Layout MUST match what SyncService.pushDrive writes:
 *   <driveRoot>/Backup/personal/
 *     memory/<projectKey>/ *                          ← memory category
 *     conversations/<slugName>/(files).jsonl                 ← conversations category
 *     encyclopedia/(files).md                                ← encyclopedia category
 *     skills/<skillName>/ *                           ← skills category
 *     system-backup/plans/ *                          ← plans category
 *     system-backup/specs/ *                          ← specs category
 *
 * Local layout (what we swap into) differs from remote for memory:
 *   ~/.claude/projects/<projectKey>/memory/ *         ← memory nested under a memory/ dir
 *   ~/.claude/projects/<slugName>/(files).jsonl              ← conversations sit flat under the slug
 *
 * So fetchInto restructures memory from remote-shape (<key>/<rest>) into
 * local-shape (<key>/memory/<rest>) as it writes staging. previewCategory walks
 * the same local paths so the delta compares apples to apples.
 *
 * Drive is HEAD-only (overwrite-in-place backend, no history). listVersions
 * returns a single "Current backup" entry.
 */
class DriveRestoreAdapter(
    private val instance: JSONObject,
    private val claudeDir: File,
    private val syncService: SyncService,
) : RestoreAdapter {

    private val rcloneRemote: String
    private val driveRoot: String
    private val remoteBase: String

    init {
        val cfg = instance.optJSONObject("config") ?: JSONObject()
        rcloneRemote = cfg.optString("rcloneRemote", "gdrive").ifEmpty { "gdrive" }
        driveRoot = cfg.optString("DRIVE_ROOT", "Claude").ifEmpty { "Claude" }
        remoteBase = "$rcloneRemote:$driveRoot/Backup/personal"
    }

    /** Remote full path under `Backup/personal/` for a category. */
    private fun remoteCategoryPath(category: RestoreCategory): String = when (category) {
        RestoreCategory.MEMORY -> "$remoteBase/memory"
        RestoreCategory.CONVERSATIONS -> "$remoteBase/conversations"
        RestoreCategory.ENCYCLOPEDIA -> "$remoteBase/encyclopedia"
        RestoreCategory.SKILLS -> "$remoteBase/skills"
        RestoreCategory.PLANS -> "$remoteBase/system-backup/plans"
        RestoreCategory.SPECS -> "$remoteBase/system-backup/specs"
    }

    private fun rclone(args: List<String>, timeoutSeconds: Long = 60L): SyncService.ExecResult {
        return syncService.execCommand(listOf("rclone") + args, timeoutSeconds = timeoutSeconds)
    }

    override suspend fun listVersions(): List<RestorePoint> = listOf(
        RestorePoint(ref = "HEAD", timestamp = System.currentTimeMillis(), label = "Current backup")
    )

    /**
     * Resolve a Drive folder ID for this category and return a
     * https://drive.google.com/drive/folders/<id> deep link. Falls back to
     * the Drive homepage if lookup fails.
     */
    override suspend fun remoteBrowseUrlFor(
        category: RestoreCategory,
        versionRef: String,
    ): String? = withContext(Dispatchers.IO) {
        val full = remoteCategoryPath(category)
        // Strip the "<remote>:" prefix, split by '/', target = last segment,
        // parent path = everything before. rclone lsjson needs the parent.
        val withoutRemote = full.removePrefix("$rcloneRemote:")
        val segments = withoutRemote.split('/').filter { it.isNotEmpty() }
        if (segments.isEmpty()) return@withContext "https://drive.google.com"
        val parent = "$rcloneRemote:${segments.dropLast(1).joinToString("/")}"
        val target = segments.last()
        val fallback = "https://drive.google.com"
        try {
            val r = rclone(listOf("lsjson", parent, "--dirs-only"), timeoutSeconds = 15L)
            if (r.code != 0) return@withContext fallback
            val arr = JSONArray(r.stdout)
            for (i in 0 until arr.length()) {
                val e = arr.getJSONObject(i)
                if (e.optString("Name") == target) {
                    val id = e.optString("ID")
                    if (id.isNotEmpty()) return@withContext "https://drive.google.com/drive/folders/$id"
                }
            }
            fallback
        } catch (_: Exception) {
            fallback
        }
    }

    override suspend fun probe(): Pair<Boolean, List<RestoreCategory>> = withContext(Dispatchers.IO) {
        val categories = mutableListOf<RestoreCategory>()
        try {
            // Walk Backup/personal/ one level deep — matches the push layout.
            val r = rclone(listOf("lsjson", remoteBase, "--dirs-only"), timeoutSeconds = 30L)
            if (r.code != 0) return@withContext Pair(false, emptyList<RestoreCategory>())
            val arr = JSONArray(r.stdout)
            val personalDirs = mutableSetOf<String>()
            for (i in 0 until arr.length()) {
                val e = arr.getJSONObject(i)
                if (e.optBoolean("IsDir")) personalDirs.add(e.optString("Name"))
            }
            if (personalDirs.contains("memory")) categories.add(RestoreCategory.MEMORY)
            if (personalDirs.contains("conversations")) categories.add(RestoreCategory.CONVERSATIONS)
            if (personalDirs.contains("encyclopedia")) categories.add(RestoreCategory.ENCYCLOPEDIA)
            if (personalDirs.contains("skills")) categories.add(RestoreCategory.SKILLS)

            // plans / specs live one level deeper under system-backup/.
            if (personalDirs.contains("system-backup")) {
                try {
                    val r2 = rclone(listOf("lsjson", "$remoteBase/system-backup", "--dirs-only"), timeoutSeconds = 15L)
                    if (r2.code == 0) {
                        val sysArr = JSONArray(r2.stdout)
                        val sysDirs = mutableSetOf<String>()
                        for (i in 0 until sysArr.length()) {
                            sysDirs.add(sysArr.getJSONObject(i).optString("Name"))
                        }
                        if (sysDirs.contains("plans")) categories.add(RestoreCategory.PLANS)
                        if (sysDirs.contains("specs")) categories.add(RestoreCategory.SPECS)
                    }
                } catch (_: Exception) {}
            }
        } catch (_: Exception) {
            return@withContext Pair(false, emptyList<RestoreCategory>())
        }
        Pair(categories.isNotEmpty(), categories)
    }

    /**
     * Map a remote relative path (as rclone reports it) to the corresponding
     * LOCAL relative path under the category's liveDir. Memory remote shape is
     * `<projectKey>/<rest>` but locally lives at `<projectKey>/memory/<rest>` —
     * we inject `memory/` after the first segment. Every other category is
     * shape-identical between remote and local.
     */
    private fun toLocalRel(category: RestoreCategory, remoteRel: String): String {
        val norm = remoteRel.replace('\\', '/')
        if (category == RestoreCategory.MEMORY) {
            val idx = norm.indexOf('/')
            if (idx < 0) return norm // shouldn't happen, defensive
            return "${norm.substring(0, idx)}/memory/${norm.substring(idx + 1)}"
        }
        return norm
    }

    /**
     * Walk the local files a category owns, returning relative paths that
     * match toLocalRel(remoteRel) above. Used for preview delta math only.
     */
    private fun walkLocalCategory(category: RestoreCategory): Pair<List<String>, Long> {
        val projectsDir = File(claudeDir, "projects")
        val files = mutableListOf<String>()
        var bytes = 0L

        when (category) {
            RestoreCategory.MEMORY -> {
                if (!projectsDir.exists()) return Pair(files, bytes)
                projectsDir.listFiles()?.forEach { keyDir ->
                    if (!keyDir.isDirectory) return@forEach
                    val memDir = File(keyDir, "memory")
                    if (!memDir.exists()) return@forEach
                    val (walked, walkedBytes) = walkRestoreFiles(memDir)
                    for (f in walked) files.add("${keyDir.name}/memory/${f.replace('\\', '/')}")
                    bytes += walkedBytes
                }
                return Pair(files, bytes)
            }
            RestoreCategory.CONVERSATIONS -> {
                if (!projectsDir.exists()) return Pair(files, bytes)
                projectsDir.listFiles()?.forEach { slugDir ->
                    if (!slugDir.isDirectory) return@forEach
                    // Only top-level .jsonl files — subdirs (memory/) belong to other categories.
                    slugDir.listFiles()?.forEach { entry ->
                        if (entry.isFile && entry.name.endsWith(".jsonl")) {
                            files.add("${slugDir.name}/${entry.name}")
                            bytes += entry.length()
                        }
                    }
                }
                return Pair(files, bytes)
            }
            RestoreCategory.ENCYCLOPEDIA -> return walkRestoreFiles(File(claudeDir, "encyclopedia"))
            RestoreCategory.SKILLS -> return walkRestoreFiles(File(claudeDir, "skills"))
            RestoreCategory.PLANS -> return walkRestoreFiles(File(claudeDir, "plans"))
            RestoreCategory.SPECS -> return walkRestoreFiles(File(claudeDir, "specs"))
        }
    }

    override suspend fun previewCategory(
        category: RestoreCategory,
        versionRef: String,
    ): CategoryPreview = withContext(Dispatchers.IO) {
        val remote = remoteCategoryPath(category)

        // Map remote Path → size, transformed into local-shape so deltas compare apples to apples.
        val remoteFiles = HashMap<String, Long>()
        try {
            val r = rclone(listOf("lsjson", remote, "--recursive", "--files-only"), timeoutSeconds = 60L)
            if (r.code == 0) {
                val arr = JSONArray(r.stdout)
                for (i in 0 until arr.length()) {
                    val e = arr.getJSONObject(i)
                    remoteFiles[toLocalRel(category, e.optString("Path"))] = e.optLong("Size", 0L)
                }
            }
            // code != 0 likely means remote doesn't exist — treat as empty backup.
        } catch (_: Exception) {}

        val (localFiles, _) = walkLocalCategory(category)
        val localSet = localFiles.map { it.replace('\\', '/') }.toHashSet()
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
        val remote = remoteCategoryPath(category)

        if (category == RestoreCategory.MEMORY) {
            // Pull remote tree into a tmp subdir, then restructure:
            //   tmp/<projectKey>/<rest>  →  staging/<projectKey>/memory/<rest>
            val tmp = File(stagingDir, "__raw_memory")
            tmp.mkdirs()
            val r = rclone(
                listOf("sync", remote, tmp.absolutePath, "--create-empty-src-dirs", "--stats-one-line"),
                timeoutSeconds = 300L,
            )
            if (r.code != 0) {
                throw java.io.IOException("rclone sync failed (code=${r.code}): ${r.stderr}")
            }
            tmp.listFiles()?.forEach { keyDir ->
                if (!keyDir.isDirectory) return@forEach
                val dest = File(stagingDir, "${keyDir.name}/memory")
                dest.parentFile?.mkdirs()
                keyDir.copyRecursively(dest, overwrite = true)
            }
            runCatching { tmp.deleteRecursively() }
        } else {
            // All other categories — remote shape matches local shape; straight sync.
            val r = rclone(
                listOf("sync", remote, stagingDir.absolutePath, "--create-empty-src-dirs", "--stats-one-line"),
                timeoutSeconds = 300L,
            )
            if (r.code != 0) {
                throw java.io.IOException("rclone sync failed (code=${r.code}): ${r.stderr}")
            }
        }

        // Emit one terminal progress event so UI flips staging → swapping.
        onFile?.let {
            val (files, _) = walkRestoreFiles(stagingDir)
            it("", files.size, files.size)
        }
    }
}
