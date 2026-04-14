package com.destin.code.runtime.restore

import com.destin.code.runtime.CategoryPreview
import com.destin.code.runtime.RestoreAdapter
import com.destin.code.runtime.RestoreCategory
import com.destin.code.runtime.RestorePoint
import com.destin.code.runtime.SyncService
import com.destin.code.runtime.walkRestoreFiles
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File

/**
 * GithubRestoreAdapter — git-backed restore adapter with point-in-time (PIT) support.
 *
 * This is the novel adapter. Drive is overwrite-in-place and only exposes HEAD.
 * GitHub backends maintain full commit history in the local repo clone at
 * ~/.claude/toolkit-state/personal-sync-repo/, so we surface it via `git log`
 * and let the user restore to any past SHA.
 *
 * fetchInto uses `git --work-tree=<staging> checkout <sha> -- <cat>/` to
 * redirect file writes into staging without touching the repo's index. We then
 * `git reset HEAD -- <cat>/` to clean any index pollution that checkout leaves.
 *
 * Note (parity divergence from desktop): desktop uses a per-instance repo dir
 * `personal-sync-repo-<instance.id>` so users can have multiple github backends.
 * Android's SyncService currently uses a single `personal-sync-repo/` directory
 * (one github backend supported), so this adapter matches that layout. If
 * Android adds per-instance repos later, update repoDir below to match.
 */
class GithubRestoreAdapter(
    @Suppress("unused") private val instance: JSONObject,
    private val claudeDir: File,
    private val syncService: SyncService,
) : RestoreAdapter {

    // Matches SyncService.pullGithub() / pushGithub() hardcoded path.
    private val repoDir: File = File(claudeDir, "toolkit-state/personal-sync-repo")

    private fun categoryRepoSubpath(category: RestoreCategory): String = when (category) {
        RestoreCategory.MEMORY, RestoreCategory.CONVERSATIONS -> "projects"
        RestoreCategory.ENCYCLOPEDIA -> "encyclopedia"
        RestoreCategory.SKILLS -> "skills"
        RestoreCategory.PLANS -> "plans"
        RestoreCategory.SPECS -> "specs"
    }

    private fun git(args: List<String>, cwd: File? = null, timeoutSeconds: Long = 60L): SyncService.ExecResult {
        return syncService.execCommand(listOf("git") + args, cwd = cwd, timeoutSeconds = timeoutSeconds)
    }

    override suspend fun listVersions(): List<RestorePoint> = withContext(Dispatchers.IO) {
        if (!repoDir.exists()) return@withContext emptyList<RestorePoint>()
        // %H = commit SHA, %ct = committer timestamp (unix), %s = subject.
        // \x09 = tab (kept from TS parity so field splitting is identical).
        val r = git(
            listOf("-C", repoDir.absolutePath, "log", "--format=%H%x09%ct%x09%s", "-n", "100"),
            timeoutSeconds = 30L,
        )
        if (r.code != 0) return@withContext emptyList<RestorePoint>()
        val out = mutableListOf<RestorePoint>()
        for (line in r.stdout.split('\n')) {
            if (line.isBlank()) continue
            val parts = line.split('\t', limit = 3)
            if (parts.size < 2) continue
            val sha = parts[0]
            val ts = (parts[1].toLongOrNull() ?: 0L) * 1000L
            val subject = if (parts.size >= 3) parts[2] else ""
            out.add(RestorePoint(ref = sha, timestamp = ts, label = relativeLabel(ts), summary = subject))
        }
        out
    }

    override suspend fun probe(): Pair<Boolean, List<RestoreCategory>> = withContext(Dispatchers.IO) {
        if (!repoDir.exists()) return@withContext Pair(false, emptyList<RestoreCategory>())
        try {
            val r = git(listOf("-C", repoDir.absolutePath, "ls-tree", "--name-only", "HEAD"),
                timeoutSeconds = 15L)
            if (r.code != 0) return@withContext Pair(false, emptyList<RestoreCategory>())
            val dirs = r.stdout.split('\n').map { it.trim() }.filter { it.isNotEmpty() }.toSet()
            val cats = mutableListOf<RestoreCategory>()
            if (dirs.contains("projects")) {
                cats.add(RestoreCategory.MEMORY)
                cats.add(RestoreCategory.CONVERSATIONS)
            }
            if (dirs.contains("encyclopedia")) cats.add(RestoreCategory.ENCYCLOPEDIA)
            if (dirs.contains("skills")) cats.add(RestoreCategory.SKILLS)
            if (dirs.contains("plans")) cats.add(RestoreCategory.PLANS)
            if (dirs.contains("specs")) cats.add(RestoreCategory.SPECS)
            Pair(cats.isNotEmpty(), cats)
        } catch (_: Exception) {
            Pair(false, emptyList())
        }
    }

    override suspend fun previewCategory(
        category: RestoreCategory,
        versionRef: String,
    ): CategoryPreview = withContext(Dispatchers.IO) {
        val sub = categoryRepoSubpath(category)
        val liveDir = File(claudeDir, sub)
        val ref = if (versionRef == "HEAD") "HEAD" else versionRef

        val remoteFiles = mutableListOf<String>()
        var remoteBytes = 0L
        try {
            val r = git(
                listOf("-C", repoDir.absolutePath, "ls-tree", "-r", "--long", ref, "--", "$sub/"),
                timeoutSeconds = 30L,
            )
            if (r.code == 0) {
                // ls-tree --long: <mode> <type> <hash> <size>\t<path>
                val re = Regex("""^\S+\s+\S+\s+\S+\s+(\S+)\t(.+)$""")
                for (line in r.stdout.split('\n')) {
                    if (line.isBlank()) continue
                    val m = re.matchEntire(line) ?: continue
                    val size = m.groupValues[1].toLongOrNull() ?: 0L
                    val full = m.groupValues[2]
                    // strip the "<sub>/" prefix to match walkRestoreFiles() relative paths
                    val rel = if (full.startsWith("$sub/")) full.substring(sub.length + 1) else full
                    remoteFiles.add(rel)
                    remoteBytes += size
                }
            }
            // ref / path missing → treat as empty remote.
        } catch (_: Exception) {}

        val (localFilesList, _) = walkRestoreFiles(liveDir)
        val remoteSet = remoteFiles.map { it.replace('\\', '/') }.toHashSet()
        val localSet = localFilesList.map { it.replace('\\', '/') }.toHashSet()

        var toAdd = 0
        var toOverwrite = 0
        for (p in remoteSet) {
            if (localSet.contains(p)) toOverwrite++ else toAdd++
        }
        var toDelete = 0
        for (p in localSet) if (!remoteSet.contains(p)) toDelete++

        CategoryPreview(
            category = category,
            remoteFiles = remoteFiles.size,
            localFiles = localFilesList.size,
            toAdd = toAdd,
            toOverwrite = toOverwrite,
            toDelete = toDelete,
            bytes = remoteBytes,
        )
    }

    override suspend fun fetchInto(
        category: RestoreCategory,
        stagingDir: File,
        versionRef: String,
        onFile: ((String, Int, Int) -> Unit)?,
    ): Unit = withContext(Dispatchers.IO) {
        if (!repoDir.exists()) {
            throw java.io.IOException("GitHub sync repo missing — run a sync first")
        }
        val sub = categoryRepoSubpath(category)
        val ref = if (versionRef == "HEAD") "HEAD" else versionRef

        // git checkout with --work-tree writes files into <work-tree>/<path>.
        // Pre-create the subpath dir so git doesn't error on the first write.
        val stagedCategoryDir = File(stagingDir, sub)
        stagedCategoryDir.mkdirs()

        val coResult = git(
            listOf(
                "-C", repoDir.absolutePath,
                "--work-tree=${stagingDir.absolutePath}",
                "checkout", ref, "--", "$sub/",
            ),
            timeoutSeconds = 300L,
        )
        if (coResult.code != 0) {
            throw java.io.IOException("git checkout failed (code=${coResult.code}): ${coResult.stderr}")
        }

        // Clean index pollution from the diverted checkout. Without this, a
        // subsequent normal sync push would include stale staged entries.
        runCatching {
            git(
                listOf("-C", repoDir.absolutePath, "reset", "HEAD", "--", "$sub/"),
                timeoutSeconds = 30L,
            )
        }

        // staging/<sub>/* is the real data; lift it up one level so the swap
        // dirs match (liveDirFor returns ~/.claude/<sub>, so staging should
        // contain the category contents at its top level, not nested).
        val lifted = File(stagingDir, "__lift")
        lifted.mkdirs()
        stagedCategoryDir.listFiles()?.forEach { entry ->
            entry.renameTo(File(lifted, entry.name))
        }
        runCatching { stagedCategoryDir.deleteRecursively() }
        lifted.listFiles()?.forEach { entry ->
            entry.renameTo(File(stagingDir, entry.name))
        }
        runCatching { lifted.deleteRecursively() }

        onFile?.let {
            val (files, _) = walkRestoreFiles(stagingDir)
            it("", files.size, files.size)
        }
    }

    private fun relativeLabel(ts: Long): String {
        val diff = System.currentTimeMillis() - ts
        val min = diff / 60_000L
        if (min < 1) return "just now"
        if (min < 60) return "$min minute${if (min == 1L) "" else "s"} ago"
        val hr = min / 60L
        if (hr < 24) return "$hr hour${if (hr == 1L) "" else "s"} ago"
        val d = hr / 24L
        if (d < 30) return "$d day${if (d == 1L) "" else "s"} ago"
        return java.text.DateFormat.getDateInstance(java.text.DateFormat.MEDIUM).format(java.util.Date(ts))
    }
}
