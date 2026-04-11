package com.destin.code.runtime

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.provider.Settings
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.InetAddress
import java.util.concurrent.TimeUnit

/**
 * SyncService.kt — Native sync engine for DestinCode Android.
 *
 * Kotlin port of desktop/src/main/sync-service.ts. Mirrors the desktop's
 * full sync lifecycle:
 *   - Pull on app launch (replaces session-start.sh personal data pull)
 *   - Background push every 15 minutes (replaces PostToolUse sync.sh debounce)
 *   - Session-end push (replaces session-end-sync.sh)
 *   - Conversation index management, cross-device slug rewriting, aggregation
 *
 * Shells out to rclone/git via ProcessBuilder + Bootstrap.buildRuntimeEnv()
 * for SELinux-safe binary execution through linker64.
 *
 * iCloud backend is omitted (not available on Android).
 * Project discovery (discoverProjects) is omitted (not relevant on phones).
 *
 * Design ref: backup-system-spec.md v6.0 (shared contract)
 */
class SyncService(
    private val context: Context,
    private val bootstrap: Bootstrap
) {
    // --- Paths ---
    private val claudeDir = File(bootstrap.homeDir, ".claude")
    private val configPath = File(claudeDir, "toolkit-state/config.json")
    private val localConfigPath = File(claudeDir, "toolkit-state/config.local.json")
    private val syncMarkerPath = File(claudeDir, "toolkit-state/.sync-marker")
    private val pullMarkerPath = File(claudeDir, "toolkit-state/.session-sync-marker")
    private val lockDir = File(claudeDir, "toolkit-state/.sync-lock")
    private val backupLogPath = File(claudeDir, "backup.log")
    private val appSyncMarkerPath = File(claudeDir, "toolkit-state/.app-sync-active")
    private val conversationIndexPath = File(claudeDir, "conversation-index.json")
    private val indexStagingDir = File(claudeDir, "toolkit-state/.index-staging")

    // --- Constants ---
    companion object {
        private const val PUSH_INTERVAL_MS = 15 * 60 * 1000L   // 15 minutes
        private const val PUSH_DEBOUNCE_MIN = 15
        private const val PULL_DEBOUNCE_MIN = 10
        private const val INDEX_PRUNE_DAYS = 30
        private const val PROCESS_TIMEOUT_S = 60L
        private const val SESSION_PUSH_TIMEOUT_S = 15L
        private const val TAG = "SyncService"
    }

    // --- State ---
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var pushJob: Job? = null
    private var pulling = false
    private var pushing = false

    // --- Result types ---
    data class PushResult(val success: Boolean, val errors: Int, val backends: List<String>)
    data class ExecResult(val code: Int, val stdout: String, val stderr: String)

    // =========================================================================
    // Lifecycle
    // =========================================================================

    /** Start the sync service: write marker, initial pull, start push timer. */
    fun start() {
        // Write .app-sync-active marker so bash hooks skip sync
        try {
            appSyncMarkerPath.parentFile?.mkdirs()
            appSyncMarkerPath.writeText(android.os.Process.myPid().toString())
        } catch (_: Exception) {}

        logBackup("INFO", "SyncService started (Android)", "sync.lifecycle")

        // Initial pull — don't crash if it fails
        scope.launch {
            try {
                pull()
            } catch (e: Exception) {
                logBackup("ERROR", "Initial pull failed: $e", "sync.pull")
            }
        }

        // Start background push timer
        pushJob = scope.launch {
            while (isActive) {
                delay(PUSH_INTERVAL_MS)
                // Check Wi-Fi preference before pushing
                if (!shouldSyncNow()) {
                    logBackup("INFO", "Push skipped — not on Wi-Fi and Wi-Fi-only enabled", "sync.push")
                    continue
                }
                try {
                    push()
                } catch (e: Exception) {
                    logBackup("ERROR", "Background push failed: $e", "sync.push")
                }
            }
        }
    }

    /** Stop the sync service: cancel timer, release locks, remove marker. */
    fun stop() {
        pushJob?.cancel()
        pushJob = null
        scope.cancel()

        releaseLock()

        // Remove .app-sync-active marker so hooks resume normal operation
        try { appSyncMarkerPath.delete() } catch (_: Exception) {}

        logBackup("INFO", "SyncService stopped", "sync.lifecycle")
    }

    // =========================================================================
    // Network / Wi-Fi Check
    // =========================================================================

    /** Check if we should sync right now (respects SYNC_WIFI_ONLY config). */
    private fun shouldSyncNow(): Boolean {
        val wifiOnly = configGet("SYNC_WIFI_ONLY", "true") == "true"
        if (!wifiOnly) return true

        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return true // Can't determine — allow sync
        val network = cm.activeNetwork ?: return false // No network at all
        val caps = cm.getNetworkCapabilities(network) ?: return false
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
               caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
    }

    // =========================================================================
    // Config Reading
    // =========================================================================

    /** Read a config key, checking local config first (machine-specific), then portable. */
    fun configGet(key: String, default: String = ""): String {
        for (cfgPath in listOf(localConfigPath, configPath)) {
            try {
                val config = JSONObject(cfgPath.readText())
                val value = config.opt(key)
                if (value != null && value != JSONObject.NULL) {
                    return value.toString()
                }
            } catch (_: Exception) {}
        }
        return default
    }

    /** Get active backends as a list. */
    private fun getBackends(): List<String> {
        val raw = configGet("PERSONAL_SYNC_BACKEND", "none")
        return raw.split(",").map { it.trim().lowercase() }.filter { it.isNotEmpty() && it != "none" }
    }

    /** Get preferred backend for pull (first in list). */
    private fun getPreferredBackend(): String? {
        val backends = getBackends()
        return backends.firstOrNull()
    }

    // =========================================================================
    // Slug Generation (CRITICAL — must match Claude Code's algorithm)
    // =========================================================================

    /**
     * Generate the current device's project slug.
     * Must match TranscriptWatcher.cwdToProjectSlug() and desktop's getCurrentSlug().
     * Replace /, \, : with - to match Claude Code's slug algorithm.
     */
    fun getCurrentSlug(): String {
        // Use canonical path to resolve symlinks (e.g., /data/user/0 → /data/data)
        val homePath = try {
            bootstrap.homeDir.canonicalPath
        } catch (_: Exception) {
            bootstrap.homeDir.absolutePath
        }
        // Replace path separators with dashes — same regex as desktop: /[/\\:]/g, '-'
        return homePath.replace('/', '-').replace('\\', '-').replace(':', '-')
    }

    // =========================================================================
    // Device Name (for conversation-index.json)
    // =========================================================================

    /** Get a human-readable device name for the conversation index.
     *  Tries Android's user-set device name first, falls back to model. */
    private fun getDeviceName(): String {
        // Try Settings.Global.DEVICE_NAME (user-set Bluetooth/About name)
        try {
            val name = Settings.Global.getString(context.contentResolver, "device_name")
            if (!name.isNullOrBlank()) return name
        } catch (_: Exception) {}

        // Fallback: "Manufacturer Model" (e.g., "Google Pixel 7")
        val manufacturer = Build.MANUFACTURER.replaceFirstChar { it.uppercase() }
        val model = Build.MODEL
        return if (model.startsWith(manufacturer, ignoreCase = true)) model
               else "$manufacturer $model"
    }

    // =========================================================================
    // Toolkit Ownership Detection
    // =========================================================================

    /** Check if a file is owned by the toolkit (symlinked into TOOLKIT_ROOT). */
    private fun isToolkitOwned(filePath: File): Boolean {
        val toolkitRoot = configGet("toolkit_root")
        if (toolkitRoot.isEmpty()) return false

        val resolved = try { File(toolkitRoot).canonicalPath } catch (_: Exception) { return false }

        // Walk up directory tree checking for symlinks
        var current = filePath.absoluteFile
        repeat(10) {
            try {
                val canonical = current.canonicalPath
                val absolute = current.absolutePath
                // If canonical differs from absolute, there's a symlink
                if (canonical != absolute && (canonical.startsWith("$resolved/") || canonical == resolved)) {
                    return true
                }
            } catch (_: Exception) { return@repeat }
            current = current.parentFile ?: return false
        }
        return false
    }

    // =========================================================================
    // Skill Route Check
    // =========================================================================

    /** Check if a skill should be synced (not routed to 'none'). */
    private fun shouldSyncSkill(skillName: String): Boolean {
        val routesFile = File(claudeDir, "toolkit-state/skill-routes.json")
        val routes = readJson(routesFile) ?: return true
        val route = routes.optJSONObject(skillName) ?: return true
        return route.optString("route") != "none"
    }

    // =========================================================================
    // Mutex (mkdir-based, portable — interops with desktop and toolkit /sync)
    // =========================================================================

    /** Acquire sync lock. Returns true if acquired. */
    private fun acquireLock(): Boolean {
        return try {
            if (lockDir.mkdir()) {
                // Success — write our PID
                try { File(lockDir, "pid").writeText(android.os.Process.myPid().toString()) } catch (_: Exception) {}
                true
            } else {
                // Lock exists — check if holder PID is alive
                val pid = try { File(lockDir, "pid").readText().trim().toInt() } catch (_: Exception) { 0 }
                if (pid > 0 && isPidAlive(pid)) {
                    false // Another sync is genuinely running
                } else {
                    // Stale lock — clean up and retry
                    lockDir.deleteRecursively()
                    if (lockDir.mkdir()) {
                        try { File(lockDir, "pid").writeText(android.os.Process.myPid().toString()) } catch (_: Exception) {}
                        true
                    } else false
                }
            }
        } catch (_: Exception) { false }
    }

    /** Release sync lock. */
    private fun releaseLock() {
        try { lockDir.deleteRecursively() } catch (_: Exception) {}
    }

    /** Check if a PID is alive. On Android, use kill(pid, 0). */
    private fun isPidAlive(pid: Int): Boolean {
        return try {
            android.system.Os.kill(pid, 0)
            true
        } catch (_: Exception) { false }
    }

    // =========================================================================
    // Debounce
    // =========================================================================

    /** Check if enough time has elapsed since last marker write. */
    private fun debounceCheck(markerFile: File, intervalMinutes: Int): Boolean {
        return try {
            val lastEpoch = markerFile.readText().trim().toLong()
            val nowEpoch = System.currentTimeMillis() / 1000
            (nowEpoch - lastEpoch) >= intervalMinutes * 60
        } catch (_: Exception) { true } // No marker = first run, proceed
    }

    /** Write current epoch to debounce marker. */
    private fun debounceTouch(markerFile: File) {
        val epoch = (System.currentTimeMillis() / 1000).toString()
        atomicWrite(markerFile, epoch)
    }

    // =========================================================================
    // Shell-out Wrappers (via Bootstrap.buildRuntimeEnv + linker64)
    // =========================================================================

    /** Execute a command with the termux runtime environment. */
    private fun execCommand(
        command: List<String>,
        cwd: File? = null,
        timeoutSeconds: Long = PROCESS_TIMEOUT_S,
        stdin: String? = null
    ): ExecResult {
        return try {
            val env = bootstrap.buildRuntimeEnv()
            val pb = ProcessBuilder(command)
            pb.environment().putAll(env)
            if (cwd != null) pb.directory(cwd)
            pb.redirectErrorStream(false)

            val process = pb.start()

            if (stdin != null) {
                process.outputStream.write(stdin.toByteArray())
                process.outputStream.close()
            }

            val stdout = process.inputStream.bufferedReader().readText()
            val stderr = process.errorStream.bufferedReader().readText()
            val completed = process.waitFor(timeoutSeconds, TimeUnit.SECONDS)

            if (!completed) {
                process.destroyForcibly()
                ExecResult(1, stdout, "Process timed out after ${timeoutSeconds}s")
            } else {
                ExecResult(process.exitValue(), stdout, stderr)
            }
        } catch (e: Exception) {
            ExecResult(1, "", e.message ?: "exec failed")
        }
    }

    /** Execute rclone with args. */
    private fun rclone(args: List<String>): ExecResult {
        return execCommand(listOf("rclone") + args)
    }

    /** Execute git with args in a working directory. */
    private fun gitExec(args: List<String>, cwd: File): ExecResult {
        return execCommand(listOf("git") + args, cwd = cwd)
    }

    // =========================================================================
    // Logging
    // =========================================================================

    /** Append a structured log entry to backup.log. */
    private fun logBackup(level: String, msg: String, op: String? = null, extra: Map<String, Any>? = null) {
        val ts = java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.US)
            .format(java.util.Date())

        try {
            if (op != null) {
                val entry = JSONObject().apply {
                    put("ts", ts)
                    put("level", level)
                    put("op", op)
                    put("msg", msg)
                    extra?.forEach { (k, v) -> put(k, v) }
                }
                backupLogPath.appendText(entry.toString() + "\n")
            } else {
                backupLogPath.appendText("[$ts] [$level] $msg\n")
            }
        } catch (_: Exception) {}

        // Also log to Android logcat for debugging
        when (level) {
            "ERROR" -> android.util.Log.e(TAG, "[$op] $msg")
            "WARN" -> android.util.Log.w(TAG, "[$op] $msg")
            else -> android.util.Log.d(TAG, "[$op] $msg")
        }
    }

    // =========================================================================
    // File Helpers
    // =========================================================================

    private fun readJson(file: File): JSONObject? {
        return try { JSONObject(file.readText()) } catch (_: Exception) { null }
    }

    /** Atomic write via same-directory temp file + rename. */
    private fun atomicWrite(target: File, content: String) {
        val tmp = File(target.parentFile, "${target.name}.tmp.${android.os.Process.myPid()}")
        target.parentFile?.mkdirs()
        tmp.writeText(content)
        tmp.renameTo(target)
    }

    // =========================================================================
    // Push: Drive Backend
    // =========================================================================

    private fun pushDrive(): Int {
        val driveRoot = configGet("DRIVE_ROOT", "Claude")
        val remoteBase = "gdrive:$driveRoot/Backup/personal"
        val sysRemote = "$remoteBase/system-backup"
        var errors = 0

        // Memory files — per project key
        val projectsDir = File(claudeDir, "projects")
        if (projectsDir.isDirectory) {
            projectsDir.listFiles()?.forEach { projectKeyDir ->
                val memoryDir = File(projectKeyDir, "memory")
                if (!memoryDir.isDirectory) return@forEach
                val r = rclone(listOf("copy", "${memoryDir.absolutePath}/", "$remoteBase/memory/${projectKeyDir.name}/", "--update", "--skip-links"))
                if (r.code != 0) { logBackup("WARN", "Drive push memory/${projectKeyDir.name} failed: ${r.stderr}", "sync.push.drive"); errors++ }
            }
        }

        // CLAUDE.md
        val claudeMd = File(claudeDir, "CLAUDE.md")
        if (claudeMd.exists()) {
            val r = rclone(listOf("copyto", claudeMd.absolutePath, "$remoteBase/CLAUDE.md", "--update"))
            if (r.code != 0) { logBackup("WARN", "Drive push CLAUDE.md failed", "sync.push.drive"); errors++ }
        }

        // Encyclopedia
        val encDir = File(claudeDir, "encyclopedia")
        if (encDir.isDirectory) {
            rclone(listOf("copy", "${encDir.absolutePath}/", "$remoteBase/encyclopedia/", "--update", "--max-depth", "1", "--include", "*.md"))
            // Also push to legacy encyclopedia path from config
            val encRemotePath = configGet("encyclopedia_remote_path", "Encyclopedia/System")
            rclone(listOf("copy", "${encDir.absolutePath}/", "gdrive:$driveRoot/$encRemotePath/", "--update", "--max-depth", "1", "--include", "*.md"))
        }

        // User-created skills (skip toolkit symlinks and skills routed to "none")
        val skillsDir = File(claudeDir, "skills")
        if (skillsDir.isDirectory) {
            skillsDir.listFiles()?.forEach { skillDir ->
                if (!skillDir.isDirectory) return@forEach
                if (isToolkitOwned(skillDir)) return@forEach
                if (!shouldSyncSkill(skillDir.name)) return@forEach
                rclone(listOf("copy", "${skillDir.absolutePath}/", "$remoteBase/skills/${skillDir.name}/", "--update", "--exclude", ".DS_Store"))
            }
        }

        // Conversations — snapshot to temp dir first to avoid races with subagents
        if (projectsDir.isDirectory) {
            val tmpDir = File(bootstrap.homeDir, "tmp")
            tmpDir.mkdirs()
            val snapDir = File.createTempFile("sync-conv-", "", tmpDir).also { it.delete(); it.mkdirs() }
            try {
                projectsDir.listFiles()?.forEach { slugDir ->
                    if (!slugDir.isDirectory) return@forEach
                    // Skip symlinked slug dirs (foreign device slugs)
                    try {
                        if (java.nio.file.Files.isSymbolicLink(slugDir.toPath())) return@forEach
                    } catch (_: Exception) {}

                    val jsonlFiles = slugDir.listFiles()?.filter { f ->
                        f.name.endsWith(".jsonl") && !java.nio.file.Files.isSymbolicLink(f.toPath())
                    } ?: return@forEach
                    if (jsonlFiles.isEmpty()) return@forEach

                    val snapSlugDir = File(snapDir, slugDir.name).also { it.mkdirs() }
                    jsonlFiles.forEach { f -> f.copyTo(File(snapSlugDir, f.name), overwrite = true) }

                    val r = rclone(listOf("copy", "${snapSlugDir.absolutePath}/", "$remoteBase/conversations/${slugDir.name}/", "--checksum", "--include", "*.jsonl"))
                    if (r.code != 0) { logBackup("WARN", "Drive push conversations/${slugDir.name} failed", "sync.push.drive"); errors++ }
                }
            } finally {
                snapDir.deleteRecursively()
            }
        }

        // System config files
        val sysFiles = listOf(
            configPath to "$sysRemote/config.json",
            File(claudeDir, "settings.json") to "$sysRemote/settings.json",
            File(claudeDir, "keybindings.json") to "$sysRemote/keybindings.json",
            File(claudeDir, "mcp.json") to "$sysRemote/mcp.json",
            File(claudeDir, "history.jsonl") to "$sysRemote/history.jsonl",
        )
        for ((local, remote) in sysFiles) {
            if (local.exists()) {
                val r = rclone(listOf("copyto", local.absolutePath, remote, "--update"))
                if (r.code != 0) { logBackup("WARN", "Drive push ${local.name} failed", "sync.push.drive"); errors++ }
            }
        }
        // Plans and specs directories
        for (dir in listOf("plans", "specs")) {
            val localDir = File(claudeDir, dir)
            if (localDir.isDirectory) {
                rclone(listOf("copy", "${localDir.absolutePath}/", "$sysRemote/$dir/", "--update"))
            }
        }

        // Conversation index
        if (conversationIndexPath.exists()) {
            rclone(listOf("copyto", conversationIndexPath.absolutePath, "$sysRemote/conversation-index.json", "--checksum"))
        }

        logBackup(if (errors > 0) "WARN" else "INFO", "Drive sync completed ($errors error(s))", "sync.push.drive")
        return errors
    }

    // =========================================================================
    // Push: GitHub Backend
    // =========================================================================

    private fun pushGithub(): Int {
        val syncRepo = configGet("PERSONAL_SYNC_REPO")
        val repoDir = File(claudeDir, "toolkit-state/personal-sync-repo")
        var errors = 0

        // Init repo if missing
        if (!File(repoDir, ".git").isDirectory) {
            if (syncRepo.isEmpty()) {
                logBackup("ERROR", "PERSONAL_SYNC_REPO not configured", "sync.push.github")
                return 1
            }
            repoDir.mkdirs()
            val cloneResult = gitExec(listOf("clone", syncRepo, repoDir.absolutePath), claudeDir)
            if (cloneResult.code != 0) {
                // Init fresh repo
                gitExec(listOf("init"), repoDir)
                gitExec(listOf("remote", "add", "personal-sync", syncRepo), repoDir)
                File(repoDir, "README.md").writeText("# Personal Claude Data Backup\n")
                File(repoDir, ".gitignore").writeText(".DS_Store\nThumbs.db\n*.tmp\n")
                gitExec(listOf("add", "-A"), repoDir)
                gitExec(listOf("commit", "-m", "Initial commit", "--no-gpg-sign"), repoDir)
                gitExec(listOf("branch", "-M", "main"), repoDir)
                gitExec(listOf("push", "-u", "personal-sync", "main"), repoDir)
            }
        }

        // Ensure remote URL is current
        gitExec(listOf("remote", "set-url", "personal-sync", syncRepo), repoDir)

        val projectsDir = File(claudeDir, "projects")

        // Memory files
        if (projectsDir.isDirectory) {
            projectsDir.listFiles()?.forEach { projectKeyDir ->
                val memoryDir = File(projectKeyDir, "memory")
                if (!memoryDir.isDirectory) return@forEach
                val dest = File(repoDir, "memory/${projectKeyDir.name}")
                dest.mkdirs()
                memoryDir.copyRecursively(dest, overwrite = true)
            }
        }

        // CLAUDE.md
        val claudeMd = File(claudeDir, "CLAUDE.md")
        if (claudeMd.exists()) claudeMd.copyTo(File(repoDir, "CLAUDE.md"), overwrite = true)

        // Encyclopedia
        val encDir = File(claudeDir, "encyclopedia")
        if (encDir.isDirectory) {
            val dest = File(repoDir, "encyclopedia")
            dest.mkdirs()
            encDir.copyRecursively(dest, overwrite = true)
        }

        // User-created skills
        val skillsDir = File(claudeDir, "skills")
        if (skillsDir.isDirectory) {
            skillsDir.listFiles()?.forEach { skillDir ->
                if (!skillDir.isDirectory || isToolkitOwned(skillDir)) return@forEach
                if (!shouldSyncSkill(skillDir.name)) return@forEach
                val dest = File(repoDir, "skills/${skillDir.name}")
                dest.mkdirs()
                skillDir.copyRecursively(dest, overwrite = true)
            }
        }

        // Conversations (real .jsonl files only, skip symlinks)
        if (projectsDir.isDirectory) {
            projectsDir.listFiles()?.forEach { slugDir ->
                if (!slugDir.isDirectory) return@forEach
                try { if (java.nio.file.Files.isSymbolicLink(slugDir.toPath())) return@forEach } catch (_: Exception) {}
                val jsonlFiles = slugDir.listFiles()?.filter { f ->
                    f.name.endsWith(".jsonl") && !java.nio.file.Files.isSymbolicLink(f.toPath())
                } ?: return@forEach
                if (jsonlFiles.isEmpty()) return@forEach
                val dest = File(repoDir, "conversations/${slugDir.name}")
                dest.mkdirs()
                jsonlFiles.forEach { f -> f.copyTo(File(dest, f.name), overwrite = true) }
            }
        }

        // System config
        val sysDir = File(repoDir, "system-backup").also { it.mkdirs() }
        for ((src, name) in listOf(
            configPath to "config.json",
            File(claudeDir, "settings.json") to "settings.json",
            File(claudeDir, "keybindings.json") to "keybindings.json",
            File(claudeDir, "mcp.json") to "mcp.json",
            File(claudeDir, "history.jsonl") to "history.jsonl",
        )) {
            if (src.exists()) src.copyTo(File(sysDir, name), overwrite = true)
        }
        for (dir in listOf("plans", "specs")) {
            val srcDir = File(claudeDir, dir)
            if (srcDir.isDirectory) {
                val dest = File(sysDir, dir)
                dest.mkdirs()
                srcDir.copyRecursively(dest, overwrite = true)
            }
        }
        // Conversation index
        if (conversationIndexPath.exists()) {
            conversationIndexPath.copyTo(File(sysDir, "conversation-index.json"), overwrite = true)
        }

        // Git add, commit, push
        gitExec(listOf("add", "-A"), repoDir)
        val diffResult = gitExec(listOf("diff", "--cached", "--quiet"), repoDir)
        if (diffResult.code != 0) {
            // There are staged changes
            gitExec(listOf("commit", "-m", "auto: sync", "--no-gpg-sign"), repoDir)
            val pushResult = gitExec(listOf("push", "personal-sync", "main"), repoDir)
            if (pushResult.code != 0) {
                logBackup("WARN", "Push to personal-sync repo failed: ${pushResult.stderr}", "sync.push.github")
                errors++
            }
        }

        logBackup(if (errors > 0) "WARN" else "INFO", "GitHub sync completed", "sync.push.github")
        return errors
    }

    // =========================================================================
    // Push: Orchestrator
    // =========================================================================

    /**
     * Push personal data to backends.
     * - Default: pushes to all configured backends (automatic loop)
     * - With backendId: pushes to that specific backend only (manual upsync).
     *   On Android, backendId maps to a backend type from the storage_backends
     *   config. Falls back to legacy flat-key push if instance lookup fails.
     */
    suspend fun push(force: Boolean = false, backendId: String? = null): PushResult {
        if (pushing) return PushResult(false, 0, emptyList())
        pushing = true

        try {
            // Update conversation index before push
            updateConversationIndex()

            // Acquire lock
            if (!acquireLock()) {
                logBackup("INFO", "Push skipped — another sync is running", "sync.push")
                return PushResult(false, 0, emptyList())
            }

            try {
                // Debounce check (skip if force or targeting a specific backend)
                if (!force && backendId == null && !debounceCheck(syncMarkerPath, PUSH_DEBOUNCE_MIN)) {
                    logBackup("INFO", "Push skipped — debounce", "sync.push")
                    return PushResult(true, 0, emptyList())
                }

                // If a specific backend was requested, resolve its type from storage_backends
                val backends: List<String> = if (backendId != null) {
                    val instanceType = resolveBackendType(backendId)
                    if (instanceType != null) listOf(instanceType) else emptyList()
                } else {
                    getBackends()
                }
                if (backends.isEmpty()) return PushResult(true, 0, emptyList())

                var totalErrors = 0
                val pushedIds = mutableListOf<String>()

                for (backend in backends) {
                    try {
                        val backendErrors = withContext(Dispatchers.IO) {
                            when (backend) {
                                "drive" -> pushDrive()
                                "github" -> pushGithub()
                                // iCloud omitted on Android
                                else -> { logBackup("WARN", "Unknown backend: $backend", "sync.push"); 0 }
                            }
                        }
                        totalErrors += backendErrors
                        pushedIds.add(backendId ?: backend)
                    } catch (e: Exception) {
                        logBackup("ERROR", "$backend push failed: $e", "sync.push")
                        totalErrors++
                    }
                }

                // Write backup-meta.json on success
                if (totalErrors == 0) writeBackupMeta()

                // Update debounce marker AFTER sync (critical ordering)
                debounceTouch(syncMarkerPath)

                return PushResult(totalErrors == 0, totalErrors, pushedIds)
            } finally {
                releaseLock()
            }
        } finally {
            pushing = false
        }
    }

    /**
     * Resolve a backend instance ID to its type string by reading storage_backends
     * from config.json. Returns null if not found.
     */
    private fun resolveBackendType(backendId: String): String? {
        try {
            val config = JSONObject(configPath.readText())
            val backends = config.optJSONArray("storage_backends") ?: return null
            for (i in 0 until backends.length()) {
                val b = backends.getJSONObject(i)
                if (b.getString("id") == backendId) return b.getString("type")
            }
        } catch (_: Exception) {}
        return null
    }

    // =========================================================================
    // Pull: Drive Backend
    // =========================================================================

    private fun pullDrive() {
        val driveRoot = configGet("DRIVE_ROOT", "Claude")
        val remoteBase = "gdrive:$driveRoot/Backup/personal"
        val sysRemote = "gdrive:$driveRoot/Backup/system-backup"

        // Memory files — list remote keys, then pull each
        val memResult = rclone(listOf("lsf", "$remoteBase/memory/", "--dirs-only"))
        if (memResult.code == 0) {
            val memKeys = memResult.stdout.split("\n").map { it.trimEnd('/').trim() }.filter { it.isNotEmpty() }
            for (key in memKeys) {
                val dest = File(claudeDir, "projects/$key/memory")
                dest.mkdirs()
                rclone(listOf("copy", "$remoteBase/memory/$key/", "${dest.absolutePath}/", "--update", "--skip-links", "--exclude", ".DS_Store"))
            }
        }

        // CLAUDE.md
        rclone(listOf("copyto", "$remoteBase/CLAUDE.md", File(claudeDir, "CLAUDE.md").absolutePath, "--update"))

        // System config
        rclone(listOf("copyto", "$sysRemote/config.json", configPath.absolutePath, "--update"))

        // Encyclopedia
        val encDir = File(claudeDir, "encyclopedia").also { it.mkdirs() }
        rclone(listOf("copy", "$remoteBase/encyclopedia/", "${encDir.absolutePath}/", "--update", "--max-depth", "1", "--include", "*.md"))

        // Conversations — checksum + ignore-existing (don't overwrite local)
        val projectsDir = File(claudeDir, "projects")
        projectsDir.mkdirs()
        rclone(listOf("copy", "$remoteBase/conversations/", "${projectsDir.absolutePath}/", "--checksum", "--include", "*.jsonl", "--ignore-existing"))

        // Conversation index to staging dir for post-pull merge
        indexStagingDir.mkdirs()
        rclone(listOf("copy", "$sysRemote/conversation-index.json", "${indexStagingDir.absolutePath}/", "--checksum"))
    }

    // =========================================================================
    // Pull: GitHub Backend
    // =========================================================================

    private fun pullGithub() {
        val syncRepo = configGet("PERSONAL_SYNC_REPO")
        val repoDir = File(claudeDir, "toolkit-state/personal-sync-repo")

        if (syncRepo.isEmpty() || !File(repoDir, ".git").isDirectory) return

        val pullResult = gitExec(listOf("pull", "personal-sync", "main"), repoDir)
        if (pullResult.code != 0) {
            logBackup("WARN", "GitHub personal-sync pull failed: ${pullResult.stderr}", "sync.pull.github")
            return
        }

        // Copy restored files to live locations (don't overwrite existing)
        val repoMemory = File(repoDir, "memory")
        if (repoMemory.isDirectory) {
            repoMemory.listFiles()?.forEach { keyDir ->
                val dest = File(claudeDir, "projects/${keyDir.name}/memory")
                dest.mkdirs()
                keyDir.copyRecursively(dest, overwrite = false)
            }
        }

        val repoClaudeMd = File(repoDir, "CLAUDE.md")
        val localClaudeMd = File(claudeDir, "CLAUDE.md")
        if (repoClaudeMd.exists() && !localClaudeMd.exists()) {
            repoClaudeMd.copyTo(localClaudeMd)
        }

        val repoEnc = File(repoDir, "encyclopedia")
        if (repoEnc.isDirectory) {
            val dest = File(claudeDir, "encyclopedia").also { it.mkdirs() }
            repoEnc.copyRecursively(dest, overwrite = false)
        }

        // Conversations
        val repoConv = File(repoDir, "conversations")
        if (repoConv.isDirectory) {
            repoConv.listFiles()?.forEach { slugDir ->
                val dest = File(claudeDir, "projects/${slugDir.name}")
                dest.mkdirs()
                slugDir.copyRecursively(dest, overwrite = false)
            }
        }

        // System config
        val repoSys = File(repoDir, "system-backup")
        val repoConfig = File(repoSys, "config.json")
        if (repoConfig.exists()) repoConfig.copyTo(configPath, overwrite = true)

        // Conversation index to staging
        val repoIndex = File(repoSys, "conversation-index.json")
        if (repoIndex.exists()) {
            indexStagingDir.mkdirs()
            repoIndex.copyTo(File(indexStagingDir, "conversation-index.json"), overwrite = true)
        }
    }

    // =========================================================================
    // Pull: Orchestrator
    // =========================================================================

    /**
     * Pull personal data from a backend + run post-pull operations.
     * - Default: pulls from the preferred (first configured) backend
     * - With backendId: pulls from that specific backend (manual downsync)
     */
    suspend fun pull(backendId: String? = null) {
        if (pulling) return
        pulling = true

        try {
            // Resolve which backend type to pull from
            val backendType: String? = if (backendId != null) {
                resolveBackendType(backendId)
            } else {
                getPreferredBackend()
            }

            if (backendType == null) {
                logBackup("INFO", "No backend for pull", "sync.pull")
                return
            }

            logBackup("INFO", "Pulling from ${backendId ?: backendType}", "sync.pull")

            withContext(Dispatchers.IO) {
                when (backendType) {
                    "drive" -> pullDrive()
                    "github" -> pullGithub()
                }
            }

            // Sequential post-pull operations (order matters)
            withContext(Dispatchers.IO) {
                rewriteProjectSlugs()
                aggregateConversations()

                // Merge staged conversation index (from pull) with local
                val stagedIndex = File(indexStagingDir, "conversation-index.json")
                if (stagedIndex.exists()) {
                    mergeConversationIndex(stagedIndex)
                }

                regenerateTopicCache()

                // Run health check to generate .sync-warnings for the UI
                runHealthCheck()
            }

            logBackup("INFO", "Pull complete", "sync.pull")
        } catch (e: Exception) {
            logBackup("ERROR", "Pull failed: $e", "sync.pull")
            throw e
        } finally {
            pulling = false
        }
    }

    // =========================================================================
    // Conversation Index Management
    // =========================================================================

    /** Scan topic files and upsert into conversation-index.json. */
    fun updateConversationIndex() {
        val topicsDir = File(claudeDir, "topics")
        if (!topicsDir.isDirectory) return

        val index = readJson(conversationIndexPath)?.let {
            JSONObject().apply {
                put("version", it.optInt("version", 1))
                put("sessions", it.optJSONObject("sessions") ?: JSONObject())
            }
        } ?: JSONObject().apply { put("version", 1); put("sessions", JSONObject()) }

        val sessions = index.getJSONObject("sessions")
        val slug = getCurrentSlug()
        val device = getDeviceName()
        val now = System.currentTimeMillis()
        val pruneThreshold = now - INDEX_PRUNE_DAYS * 24L * 60 * 60 * 1000

        topicsDir.listFiles()?.forEach { file ->
            if (!file.name.startsWith("topic-")) return@forEach
            val sessionId = file.name.removePrefix("topic-")

            try {
                val topic = file.readText().trim()
                if (topic.isEmpty() || topic == "New Session") return@forEach

                val lastActive = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US)
                    .apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }
                    .format(java.util.Date(file.lastModified()))

                // Only upsert if newer than existing entry
                val existing = sessions.optJSONObject(sessionId)
                if (existing != null) {
                    try {
                        val existingTime = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US)
                            .parse(existing.optString("lastActive", ""))?.time ?: 0
                        if (existingTime >= file.lastModified()) return@forEach
                    } catch (_: Exception) {}
                }

                sessions.put(sessionId, JSONObject().apply {
                    put("topic", topic)
                    put("lastActive", lastActive)
                    put("slug", slug)
                    put("device", device)
                })
            } catch (_: Exception) {}
        }

        // Prune old entries
        val keysToRemove = mutableListOf<String>()
        sessions.keys().forEach { sid ->
            val entry = sessions.optJSONObject(sid) ?: return@forEach
            try {
                val entryTime = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US)
                    .parse(entry.optString("lastActive", ""))?.time ?: 0
                if (entryTime < pruneThreshold) keysToRemove.add(sid)
            } catch (_: Exception) {}
        }
        keysToRemove.forEach { sessions.remove(it) }

        atomicWrite(conversationIndexPath, index.toString(2))
    }

    /** Merge a remote conversation index with the local one (union, latest wins). */
    private fun mergeConversationIndex(remotePath: File) {
        val remote = readJson(remotePath) ?: return
        val local = readJson(conversationIndexPath) ?: JSONObject().apply { put("version", 1); put("sessions", JSONObject()) }

        val remoteSessions = remote.optJSONObject("sessions") ?: JSONObject()
        val localSessions = local.optJSONObject("sessions") ?: JSONObject()

        // Merge: remote wins when newer
        remoteSessions.keys().forEach { sid ->
            val remoteEntry = remoteSessions.optJSONObject(sid) ?: return@forEach
            val localEntry = localSessions.optJSONObject(sid)

            if (localEntry == null) {
                localSessions.put(sid, remoteEntry)
            } else {
                try {
                    val fmt = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US)
                    val remoteTime = fmt.parse(remoteEntry.optString("lastActive", ""))?.time ?: 0
                    val localTime = fmt.parse(localEntry.optString("lastActive", ""))?.time ?: 0
                    if (remoteTime > localTime) {
                        localSessions.put(sid, remoteEntry)
                    }
                } catch (_: Exception) {}
            }
        }

        local.put("sessions", localSessions)
        atomicWrite(conversationIndexPath, local.toString(2))
    }

    /** Create topic cache files from index for cross-device sessions. */
    private fun regenerateTopicCache() {
        val index = readJson(conversationIndexPath) ?: return
        val sessions = index.optJSONObject("sessions") ?: return
        val topicsDir = File(claudeDir, "topics").also { it.mkdirs() }

        sessions.keys().forEach { sid ->
            val entry = sessions.optJSONObject(sid) ?: return@forEach
            val topicFile = File(topicsDir, "topic-$sid")
            // Only create if local file doesn't exist (local-first)
            if (!topicFile.exists()) {
                try { topicFile.writeText(entry.optString("topic", "")) } catch (_: Exception) {}
            }
        }
    }

    // =========================================================================
    // Cross-Device Operations
    // =========================================================================

    /** Create symlinks from foreign device project slugs into current device's slug.
     *  Falls back to recursive copy if symlinks fail. */
    private fun rewriteProjectSlugs() {
        val projectsDir = File(claudeDir, "projects")
        if (!projectsDir.isDirectory) return

        val currentSlug = getCurrentSlug()

        projectsDir.listFiles()?.forEach { slugDir ->
            if (slugDir.name == currentSlug) return@forEach
            // Skip if it's already a symlink (previous rewrite)
            try { if (java.nio.file.Files.isSymbolicLink(slugDir.toPath())) return@forEach } catch (_: Exception) {}
            if (!slugDir.isDirectory) return@forEach

            val currentSlugDir = File(projectsDir, currentSlug).also { it.mkdirs() }

            slugDir.listFiles()?.forEach inner@{ sub ->
                val target = File(currentSlugDir, sub.name)
                if (target.exists()) return@inner // Don't overwrite local

                val relativeSrc = java.nio.file.Paths.get("..", slugDir.name, sub.name)
                try {
                    java.nio.file.Files.createSymbolicLink(target.toPath(), relativeSrc)
                } catch (_: Exception) {
                    // Fallback: copy if symlink fails
                    try { sub.copyRecursively(target) } catch (_: Exception) {}
                }
            }
        }
    }

    /** Symlink all .jsonl files from non-home slugs into home slug for /resume from ~. */
    private fun aggregateConversations() {
        val projectsDir = File(claudeDir, "projects")
        if (!projectsDir.isDirectory) return

        val currentSlug = getCurrentSlug()
        val homeDir = File(projectsDir, currentSlug)
        if (!homeDir.isDirectory) return

        projectsDir.listFiles()?.forEach { slugDir ->
            if (slugDir.name == currentSlug) return@forEach
            try { if (java.nio.file.Files.isSymbolicLink(slugDir.toPath())) return@forEach } catch (_: Exception) {}
            if (!slugDir.isDirectory) return@forEach

            slugDir.listFiles()?.forEach inner@{ file ->
                if (!file.name.endsWith(".jsonl")) return@inner
                val target = File(homeDir, file.name)
                if (target.exists()) return@inner // Don't overwrite

                val relativeSrc = java.nio.file.Paths.get("..", slugDir.name, file.name)
                try {
                    java.nio.file.Files.createSymbolicLink(target.toPath(), relativeSrc)
                } catch (_: Exception) {}
            }
        }

        // Clean up dangling symlinks in home dir
        homeDir.listFiles()?.forEach { file ->
            try {
                if (java.nio.file.Files.isSymbolicLink(file.toPath()) && !file.exists()) {
                    file.delete()
                }
            } catch (_: Exception) {}
        }
    }

    // =========================================================================
    // Sync Health Check & Warning Generation
    // =========================================================================

    /**
     * Run sync health checks and write .sync-warnings file.
     * Generates: OFFLINE, PERSONAL:NOT_CONFIGURED, PERSONAL:STALE,
     *            SKILLS:unrouted:name1,name2
     * Note: PROJECTS:N is omitted on Android (discoverProjects not relevant on phones).
     */
    fun runHealthCheck(): List<String> {
        val warningsFile = File(claudeDir, ".sync-warnings")
        val warnings = mutableListOf<String>()

        // 0. Internet connectivity check
        try {
            val addr = InetAddress.getByName("github.com")
            if (addr == null || addr.hostAddress.isNullOrEmpty()) {
                warnings.add("OFFLINE")
            }
        } catch (_: Exception) {
            warnings.add("OFFLINE")
        }

        // 1. Personal data sync backend status
        val backends = getBackends()
        if (backends.isEmpty()) {
            warnings.add("PERSONAL:NOT_CONFIGURED")
        } else {
            // Check if last sync is stale (>24 hours)
            try {
                val lastEpoch = syncMarkerPath.readText().trim().toLong()
                val age = System.currentTimeMillis() / 1000 - lastEpoch
                if (age >= 86400) {
                    warnings.add("PERSONAL:STALE")
                }
            } catch (_: Exception) {
                // No marker file — first run, not stale
            }
        }

        // 2. Unrouted user skills
        val unroutedSkills = findUnroutedSkills()
        if (unroutedSkills.isNotEmpty()) {
            warnings.add("SKILLS:unrouted:${unroutedSkills.joinToString(",")}")
        }

        // Write warnings file (or remove if empty)
        if (warnings.isNotEmpty()) {
            warningsFile.writeText(warnings.joinToString("\n") + "\n")
        } else {
            try { warningsFile.delete() } catch (_: Exception) {}
        }

        return warnings
    }

    /** Find user-created skills that are not routed in skill-routes.json. */
    private fun findUnroutedSkills(): List<String> {
        val skillsDir = File(claudeDir, "skills")
        if (!skillsDir.isDirectory) return emptyList()

        val routesFile = File(claudeDir, "toolkit-state/skill-routes.json")
        val routes = readJson(routesFile) ?: JSONObject()
        val toolkitRoot = configGet("toolkit_root")
        val toolkitLayers = listOf("core/skills", "productivity/skills", "life/skills")

        val unrouted = mutableListOf<String>()

        skillsDir.listFiles()?.forEach { skillDir ->
            if (!skillDir.isDirectory) return@forEach
            // Skip symlinks (toolkit-managed)
            try { if (java.nio.file.Files.isSymbolicLink(skillDir.toPath())) return@forEach } catch (_: Exception) {}

            // Skip toolkit copies
            if (toolkitRoot.isNotEmpty()) {
                val isToolkitCopy = toolkitLayers.any { layer ->
                    File(toolkitRoot, "$layer/${skillDir.name}").isDirectory
                }
                if (isToolkitCopy) return@forEach
            }

            // Skip if already routed
            val route = routes.optJSONObject(skillDir.name)
            if (route?.optString("route")?.isNotEmpty() == true) return@forEach

            unrouted.add(skillDir.name)
        }

        return unrouted
    }

    // =========================================================================
    // Backup Metadata
    // =========================================================================

    /** Write backup-meta.json after successful sync. */
    private fun writeBackupMeta() {
        val toolkitRoot = configGet("toolkit_root")
        val toolkitVersion = if (toolkitRoot.isNotEmpty()) {
            try { File(toolkitRoot, "VERSION").readText().trim() } catch (_: Exception) { "unknown" }
        } else "unknown"

        val meta = JSONObject().apply {
            put("schema_version", 1)
            put("toolkit_version", toolkitVersion)
            put("last_backup", java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US)
                .apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }
                .format(java.util.Date()))
            put("platform", "android")
        }

        atomicWrite(File(claudeDir, "backup-meta.json"), meta.toString(2))
    }

    // =========================================================================
    // Session-End Push
    // =========================================================================

    /** Push a single session's JSONL to all backends (called on session close). */
    suspend fun pushSession(sessionId: String) {
        val slug = getCurrentSlug()
        val jsonlFile = File(claudeDir, "projects/$slug/$sessionId.jsonl")
        if (!jsonlFile.exists()) return

        // Update conversation index first
        updateConversationIndex()

        val backends = getBackends()
        val driveRoot = configGet("DRIVE_ROOT", "Claude")

        for (backend in backends) {
            try {
                withContext(Dispatchers.IO) {
                    when (backend) {
                        "drive" -> {
                            rclone(listOf("copy", jsonlFile.absolutePath, "gdrive:$driveRoot/Backup/personal/conversations/$slug/", "--checksum"))
                            // Also push conversation index
                            if (conversationIndexPath.exists()) {
                                rclone(listOf("copyto", conversationIndexPath.absolutePath, "gdrive:$driveRoot/Backup/system-backup/conversation-index.json", "--checksum"))
                            }
                        }
                        "github" -> {
                            val repoDir = File(claudeDir, "toolkit-state/personal-sync-repo")
                            if (!File(repoDir, ".git").isDirectory) return@withContext
                            val convDir = File(repoDir, "conversations/$slug").also { it.mkdirs() }
                            jsonlFile.copyTo(File(convDir, "$sessionId.jsonl"), overwrite = true)
                            if (conversationIndexPath.exists()) {
                                val sysDir = File(repoDir, "system-backup").also { it.mkdirs() }
                                conversationIndexPath.copyTo(File(sysDir, "conversation-index.json"), overwrite = true)
                            }
                            gitExec(listOf("add", "-A"), repoDir)
                            val diff = gitExec(listOf("diff", "--cached", "--quiet"), repoDir)
                            if (diff.code != 0) {
                                gitExec(listOf("commit", "-m", "auto: session-end sync", "--no-gpg-sign"), repoDir)
                                gitExec(listOf("push", "personal-sync", "main"), repoDir)
                            }
                        }
                    }
                }
            } catch (e: Exception) {
                logBackup("WARN", "Session-end $backend sync failed: $e", "sync.sessionend")
            }
        }

        logBackup("INFO", "Session-end sync for ${sessionId.take(8)}", "sync.sessionend")
    }
}
