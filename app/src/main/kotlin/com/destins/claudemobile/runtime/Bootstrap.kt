package com.destins.claudemobile.runtime

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.BufferedInputStream
import java.io.File
import java.io.IOException
import java.net.URL
import java.security.MessageDigest
import java.util.zip.ZipInputStream
import org.apache.commons.compress.archivers.ar.ArArchiveInputStream
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.tukaani.xz.XZInputStream
import com.github.luben.zstd.ZstdInputStream

class Bootstrap(private val context: Context) {

    val usrDir: File get() = File(context.filesDir, "usr")
    val homeDir: File get() = File(context.filesDir, "home")
    val isExtracted: Boolean get() = File(usrDir, "bin/bash").exists()
    val isFullySetup: Boolean get() = File(usrDir, "bin/node").exists() &&
        File(usrDir, "lib/node_modules/npm").exists() &&
        File(usrDir, "lib/node_modules/@anthropic-ai/claude-code").exists()
    val isBootstrapped: Boolean get() = isExtracted && isFullySetup

    sealed class Progress {
        data class Extracting(val percent: Int) : Progress()
        data class Installing(val packageName: String, val overallPercent: Int = -1) : Progress()
        data class Error(val message: String) : Progress()
        data object Complete : Progress()
    }

    suspend fun setup(onProgress: (Progress) -> Unit) = withContext(Dispatchers.IO) {
        try {
            setupHome()  // Must exist before any executeInRuntime calls (used as cwd)
            if (!isExtracted) {
                extractBootstrap(onProgress)
            }
            if (!isFullySetup) {
                installPackages(onProgress)
                installClaudeCode(onProgress)
            }
            onProgress(Progress.Complete)
        } catch (e: Exception) {
            onProgress(Progress.Error(e.message ?: "Unknown error"))
        }
    }

    private fun extractBootstrap(onProgress: (Progress) -> Unit) {
        usrDir.mkdirs()
        val asset = context.assets.open("bootstrap-aarch64.zip")
        val zip = ZipInputStream(asset)
        var entry = zip.nextEntry
        var count = 0
        var symlinksContent: String? = null
        while (entry != null) {
            count++
            if (count % 100 == 0) {
                onProgress(Progress.Extracting((count * 100) / 5000))
            }
            if (entry.name == "SYMLINKS.txt") {
                symlinksContent = zip.bufferedReader().readText()
                zip.closeEntry()
                entry = zip.nextEntry
                continue
            }
            val target = File(usrDir, entry.name)
            if (entry.isDirectory) {
                target.mkdirs()
            } else {
                target.parentFile?.mkdirs()
                target.outputStream().use { out -> zip.copyTo(out) }
                // Set all files executable — covers bin/, lib/, libexec/, etc.
                target.setExecutable(true)
            }
            zip.closeEntry()
            entry = zip.nextEntry
        }
        zip.close()

        // Process symlinks from SYMLINKS.txt (format: target←link_path)
        symlinksContent?.lines()?.forEach { line ->
            if (line.isBlank()) return@forEach
            val parts = line.split("←")
            if (parts.size == 2) {
                val symlinkTarget = parts[0].trim()
                val linkPath = parts[1].trim().removePrefix("./")
                val linkFile = File(usrDir, linkPath)
                linkFile.parentFile?.mkdirs()
                try {
                    // Create symlinks using ProcessBuilder (no shell injection risk —
                    // paths come from the trusted Termux bootstrap, not user input)
                    ProcessBuilder("ln", "-sf", symlinkTarget, linkFile.absolutePath)
                        .start().waitFor()
                } catch (_: Exception) {
                    // Symlink creation may fail on some Android versions; non-fatal
                }
            }
        }

        // Configure apt sources for Termux package repos
        setupAptSources()

        onProgress(Progress.Extracting(100))
    }

    /**
     * Configure apt/dpkg to work with our prefix instead of hardcoded
     * /data/data/com.termux/ paths. The Termux-compiled apt binary has paths
     * baked in at compile time, but APT_CONFIG env var + apt.conf can override
     * all directory settings. dpkg needs --admindir/--instdir at invocation.
     */
    private fun setupAptSources() {
        val usr = usrDir.absolutePath
        val etcApt = File(usrDir, "etc/apt")
        etcApt.mkdirs()

        // sources.list — Termux package repos
        File(etcApt, "sources.list").writeText(
            "deb https://packages.termux.dev/apt/termux-main stable main\n"
        )

        // apt.conf — override ALL hardcoded directory paths
        File(etcApt, "apt.conf").writeText(
            """
            Dir "$usr/";
            Dir::State "$usr/var/lib/apt/";
            Dir::State::status "$usr/var/lib/dpkg/status";
            Dir::Cache "$usr/var/cache/apt/";
            Dir::Etc "$usr/etc/apt/";
            Dir::Log "$usr/var/log/apt/";
            Dpkg::Options { "--admindir=$usr/var/lib/dpkg"; "--instdir=$usr"; };
            """.trimIndent() + "\n"
        )

        // Create required state directories
        File(usrDir, "var/lib/apt/lists/partial").mkdirs()
        File(usrDir, "var/cache/apt/archives/partial").mkdirs()
        File(usrDir, "var/lib/dpkg/info").mkdirs()
        File(usrDir, "var/lib/dpkg/updates").mkdirs()
        File(usrDir, "var/log/apt").mkdirs()

        // Initialize dpkg database files if missing
        val statusFile = File(usrDir, "var/lib/dpkg/status")
        if (!statusFile.exists()) statusFile.writeText("")
        val availableFile = File(usrDir, "var/lib/dpkg/available")
        if (!availableFile.exists()) availableFile.writeText("")
    }

    private val termuxRepo = "https://packages.termux.dev/apt/termux-main"

    data class PackageInfo(
        val name: String,
        val version: String,
        val filename: String,
        val sha256: String,
        val depends: List<String>
    )

    /**
     * Parse the Termux Packages index (RFC 822-style stanzas).
     * Returns map of package name to PackageInfo.
     */
    private fun parsePackagesIndex(text: String): Map<String, PackageInfo> {
        val packages = mutableMapOf<String, PackageInfo>()
        val stanzas = text.replace("\r\n", "\n").split("\n\n")
        for (stanza in stanzas) {
            val fields = mutableMapOf<String, String>()
            var currentKey = ""
            for (line in stanza.lines()) {
                if (line.startsWith(" ") || line.startsWith("\t")) {
                    fields[currentKey] = (fields[currentKey] ?: "") + "\n" + line.trim()
                } else if (":" in line) {
                    val (key, value) = line.split(":", limit = 2)
                    currentKey = key.trim()
                    fields[currentKey] = value.trim()
                }
            }
            val name = fields["Package"] ?: continue
            val version = fields["Version"] ?: continue
            val filename = fields["Filename"] ?: continue
            val sha256 = fields["SHA256"] ?: continue
            val depends = fields["Depends"]
                ?.split(",")
                ?.map { it.trim().split("\\s+".toRegex()).first() }
                ?: emptyList()
            packages[name] = PackageInfo(name, version, filename, sha256, depends)
        }
        return packages
    }

    private val indexDir get() = File(usrDir, "var/lib/claude-mobile").also { it.mkdirs() }
    private val cachedIndexFile get() = File(indexDir, "Packages")
    private val installedVersionsFile get() = File(indexDir, "installed.properties")

    private fun loadInstalledVersions(): MutableMap<String, String> {
        val map = mutableMapOf<String, String>()
        if (installedVersionsFile.exists()) {
            for (line in installedVersionsFile.readLines()) {
                val parts = line.split("=", limit = 2)
                if (parts.size == 2) map[parts[0]] = parts[1]
            }
        }
        return map
    }

    private fun saveInstalledVersions(versions: Map<String, String>) {
        installedVersionsFile.writeText(
            versions.entries.joinToString("\n") { "${it.key}=${it.value}" }
        )
    }

    /**
     * Fetch (or use cached) Termux Packages index.
     * Re-fetches if cache is missing, stale (>24h), or force=true.
     */
    private fun fetchPackagesIndex(force: Boolean = false): Map<String, PackageInfo> {
        val cacheMaxAge = 24 * 60 * 60 * 1000L
        val cacheValid = cachedIndexFile.exists() &&
            (System.currentTimeMillis() - cachedIndexFile.lastModified()) < cacheMaxAge

        if (!force && cacheValid) {
            return parsePackagesIndex(cachedIndexFile.readText())
        }

        val indexUrl = "$termuxRepo/dists/stable/main/binary-aarch64/Packages"
        var connection: java.net.HttpURLConnection? = null
        try {
            connection = java.net.URL(indexUrl).openConnection() as java.net.HttpURLConnection
            connection.connectTimeout = 15000
            connection.readTimeout = 30000
            if (connection.responseCode != 200) {
                throw IOException("Failed to fetch package index: HTTP ${connection.responseCode}")
            }
            val text = connection.inputStream.bufferedReader().readText()
            connection.disconnect()
            connection = null
            cachedIndexFile.parentFile?.mkdirs()
            cachedIndexFile.writeText(text)
            return parsePackagesIndex(text)
        } catch (e: Exception) {
            connection?.disconnect()
            if (cachedIndexFile.exists()) {
                return parsePackagesIndex(cachedIndexFile.readText())
            }
            throw IOException("Cannot fetch package index and no cache available: ${e.message}", e)
        }
    }

    /** Packages required for Claude Mobile, in dependency order. */
    private val requiredPackages = listOf(
        // Node.js runtime + deps
        "c-ares", "libicu", "libsqlite", "nodejs", "npm",
        // SELinux exec bypass
        "termux-exec",
        // Git + deps (deps first)
        "openssl", "libcurl", "libexpat", "libiconv", "pcre2", "zlib", "git",
        // GitHub CLI + deps
        "openssh", "gh"
    )

    /** Check files that indicate a package is properly installed. */
    private fun packageFileExists(name: String): Boolean {
        val checkFile = when (name) {
            "c-ares" -> "lib/libcares.so"
            "libicu" -> return usrDir.resolve("lib").listFiles()
                ?.any { it.name.startsWith("libicuuc.so") } == true
            "libsqlite" -> "lib/libsqlite3.so"
            "nodejs" -> "bin/node"
            "npm" -> "lib/node_modules/npm"
            "termux-exec" -> "lib/libtermux-exec-linker-ld-preload.so"
            "openssl" -> "lib/libssl.so"
            "libcurl" -> "lib/libcurl.so"
            "libexpat" -> "lib/libexpat.so"
            "libiconv" -> "lib/libiconv.so"
            "pcre2" -> "lib/libpcre2-8.so"
            "zlib" -> "lib/libz.so"
            "git" -> "bin/git"
            "gh" -> "bin/gh"
            "openssh" -> "bin/ssh"
            else -> return false
        }
        return File(usrDir, checkFile).exists()
    }

    private fun installPackages(onProgress: (Progress) -> Unit) {
        val index = fetchPackagesIndex()
        val installed = loadInstalledVersions()

        val total = requiredPackages.size
        for ((i, name) in requiredPackages.withIndex()) {
            val pkg = index[name]
            if (pkg == null) {
                Log.w("Bootstrap", "Package '$name' not found in Termux index — skipping")
                continue
            }

            val fileExists = packageFileExists(name)
            val versionMatch = installed[name] == pkg.version

            // Skip only if BOTH version matches AND binary exists (crash-safe)
            if (fileExists && versionMatch) continue

            // Packages = 30-80% of overall progress
            val overallPercent = 30 + (i * 50) / total
            onProgress(Progress.Installing(name, overallPercent))
            installDeb(pkg)
            installed[name] = pkg.version
            saveInstalledVersions(installed)
        }

        // termux-exec postinst: copy linker variant to primary .so
        val linkerSo = File(usrDir, "lib/libtermux-exec-linker-ld-preload.so")
        val primarySo = File(usrDir, "lib/libtermux-exec-ld-preload.so")
        if (linkerSo.exists() && !primarySo.exists()) {
            linkerSo.inputStream().use { input ->
                primarySo.outputStream().use { output -> input.copyTo(output) }
            }
            primarySo.setExecutable(true)
        }
    }

    /**
     * Download a .deb from Termux repos, verify SHA256, and extract.
     * Supports data.tar.xz, data.tar.zst, and data.tar.gz compression.
     */
    private fun installDeb(pkg: PackageInfo) {
        val url = "$termuxRepo/${pkg.filename}"
        val tmpDeb = File(context.cacheDir, "tmp.deb")
        var connection: java.net.HttpURLConnection? = null
        try {
            // Download with HTTP error checking
            connection = java.net.URL(url).openConnection() as java.net.HttpURLConnection
            connection.connectTimeout = 15000
            connection.readTimeout = 60000
            if (connection.responseCode != 200) {
                throw IOException("Failed to download ${pkg.name}: HTTP ${connection.responseCode} from $url")
            }
            connection.inputStream.use { input ->
                tmpDeb.outputStream().use { output -> input.copyTo(output) }
            }
            connection.disconnect()
            connection = null

            // SHA256 verification
            if (pkg.sha256.isNotEmpty()) {
                val digest = MessageDigest.getInstance("SHA-256")
                tmpDeb.inputStream().use { input ->
                    val buf = ByteArray(8192)
                    var n: Int
                    while (input.read(buf).also { n = it } != -1) {
                        digest.update(buf, 0, n)
                    }
                }
                val actualSha256 = digest.digest().joinToString("") { "%02x".format(it) }
                if (actualSha256 != pkg.sha256) {
                    throw IOException(
                        "SHA256 mismatch for ${pkg.name}: expected ${pkg.sha256}, got $actualSha256"
                    )
                }
            }

            // Parse ar archive to find data.tar
            ArArchiveInputStream(BufferedInputStream(tmpDeb.inputStream())).use { arStream ->
                var arEntry = arStream.nextEntry
                while (arEntry != null) {
                    if (arEntry.name.startsWith("data.tar")) {
                        val decompressed: java.io.InputStream = when {
                            arEntry.name.contains(".xz") -> XZInputStream(arStream)
                            arEntry.name.contains(".zst") -> ZstdInputStream(arStream)
                            arEntry.name.contains(".gz") -> java.util.zip.GZIPInputStream(arStream)
                            else -> arStream
                        }
                        val tarStream = TarArchiveInputStream(decompressed)
                        var tarEntry = tarStream.nextEntry
                        while (tarEntry != null) {
                            val termuxPrefix = "data/data/com.termux/files/usr/"
                            var entryPath = tarEntry.name.removePrefix("./").removePrefix("/")
                            if (entryPath.startsWith(termuxPrefix)) {
                                entryPath = entryPath.removePrefix(termuxPrefix)
                            }
                            val absPrefix = "/data/data/com.termux/files/usr/"
                            if (tarEntry.name.startsWith(absPrefix)) {
                                entryPath = tarEntry.name.removePrefix(absPrefix)
                            }
                            // Skip entries outside usr/ (e.g., home/.ssh defaults)
                            val homePrefix = "data/data/com.termux/files/home/"
                            if (entryPath.startsWith(homePrefix) ||
                                tarEntry.name.startsWith("/data/data/com.termux/files/home/")) {
                                tarEntry = tarStream.nextEntry
                                continue
                            }
                            if (entryPath.isEmpty() || entryPath.startsWith("data/")) {
                                tarEntry = tarStream.nextEntry
                                continue
                            }
                            val target = File(usrDir, entryPath)

                            if (tarEntry.isDirectory) {
                                target.mkdirs()
                            } else if (tarEntry.isSymbolicLink) {
                                target.parentFile?.mkdirs()
                                try {
                                    target.delete() // Remove old file/symlink before creating
                                    java.nio.file.Files.createSymbolicLink(
                                        target.toPath(),
                                        java.nio.file.Paths.get(tarEntry.linkName)
                                    )
                                } catch (_: Exception) {}
                            } else {
                                target.parentFile?.mkdirs()
                                target.outputStream().use { out ->
                                    tarStream.copyTo(out)
                                }
                                target.setExecutable(true)
                            }
                            tarEntry = tarStream.nextEntry
                        }
                        break
                    }
                    arEntry = arStream.nextEntry
                }
            }
        } finally {
            connection?.disconnect()
            tmpDeb.delete()
        }
    }

    private fun installClaudeCode(onProgress: (Progress) -> Unit) {
        if (File(usrDir, "lib/node_modules/@anthropic-ai/claude-code").exists()) return
        onProgress(Progress.Installing("claude-code"))
        // npm is a JS script, not an ELF binary — run it via node + linker64.
        // node <npm-cli.js> install -g @anthropic-ai/claude-code
        val nodePath = File(usrDir, "bin/node").absolutePath
        val npmCliPath = File(usrDir, "lib/node_modules/npm/bin/npm-cli.js").absolutePath

        val cmdList = mutableListOf("/system/bin/linker64", nodePath, npmCliPath, "install", "-g", "@anthropic-ai/claude-code")
        val pb = ProcessBuilder(cmdList)
            .directory(homeDir)
            .redirectErrorStream(true)
        pb.environment().putAll(buildRuntimeEnv())
        val process = pb.start()
        // Read stdout in a separate thread to avoid pipe buffer deadlock.
        // npm install can produce >64KB of output, which fills the OS pipe buffer
        // and blocks the process if the reader hasn't drained it.
        val outputFuture = java.util.concurrent.CompletableFuture.supplyAsync {
            process.inputStream.bufferedReader().readText()
        }
        val exitCode = process.waitFor()
        val output = outputFuture.get()
        if (exitCode != 0) {
            throw IOException("npm install claude-code failed (exit $exitCode): $output")
        }
    }

    private fun setupHome() {
        homeDir.mkdirs()
        File(homeDir, ".claude").mkdirs()
        File(homeDir, "tmp").mkdirs()

        val mobileDir = File(homeDir, ".claude-mobile")
        mobileDir.mkdirs()

        // Ensure .bash_profile and .bashrc source linker64-env.sh.
        // The env file won't exist yet (deployed per-launch by deployBashEnv),
        // but the [ -f ] guards handle that gracefully.
        ensureShellProfileSources(
            File(mobileDir, "linker64-env.sh").absolutePath
        )

        installHooks()
    }

    /**
     * Install hook-relay.js and write Claude Code hook configuration.
     * Hooks relay structured JSON events (tool calls, responses, notifications)
     * over a Unix socket to EventBridge for rendering in the chat view.
     */
    fun installHooks() {
        val mobileDir = File(homeDir, ".claude-mobile")
        mobileDir.mkdirs()

        // Deploy hook-relay.js from assets
        val relayFile = File(mobileDir, "hook-relay.js")
        // Always redeploy — ensures latest version after APK update
        context.assets.open("hook-relay.js").use { input ->
            relayFile.outputStream().use { output -> input.copyTo(output) }
        }

        // Write hook configuration into Claude Code's settings
        val claudeDir = File(homeDir, ".claude")
        claudeDir.mkdirs()
        val settingsFile = File(claudeDir, "settings.json")

        val nodePath = File(usrDir, "bin/node").absolutePath
        val relayPath = relayFile.absolutePath
        val hookCommand = "$nodePath $relayPath"

        // Build hook entries for all events we care about
        val hookEvents = listOf(
            "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "Notification"
        )

        // Read existing settings and merge (additive — don't overwrite user hooks)
        val existingJson = if (settingsFile.exists()) {
            try { org.json.JSONObject(settingsFile.readText()) } catch (_: Exception) { org.json.JSONObject() }
        } else {
            org.json.JSONObject()
        }

        val hooksObj = existingJson.optJSONObject("hooks") ?: org.json.JSONObject()

        for (event in hookEvents) {
            val eventArray = hooksObj.optJSONArray(event) ?: org.json.JSONArray()

            // Check if our hook is already registered (avoid duplicates)
            var alreadyRegistered = false
            for (i in 0 until eventArray.length()) {
                val entry = eventArray.optJSONObject(i)
                val hooks = entry?.optJSONArray("hooks")
                if (hooks != null) {
                    for (j in 0 until hooks.length()) {
                        val h = hooks.optJSONObject(j)
                        if (h?.optString("command")?.contains("hook-relay.js") == true) {
                            alreadyRegistered = true
                            break
                        }
                    }
                }
                if (alreadyRegistered) break
            }

            if (!alreadyRegistered) {
                val hookEntry = org.json.JSONObject()
                hookEntry.put("matcher", ".*")
                val hooksList = org.json.JSONArray()
                val hookDef = org.json.JSONObject()
                hookDef.put("type", "command")
                hookDef.put("command", hookCommand)
                hooksList.put(hookDef)
                hookEntry.put("hooks", hooksList)
                eventArray.put(hookEntry)
            }

            hooksObj.put(event, eventArray)
        }

        existingJson.put("hooks", hooksObj)
        settingsFile.writeText(existingJson.toString(2))
    }

    /**
     * Execute a command inside the embedded runtime.
     * Uses /system/bin/linker64 to bypass SELinux restrictions that prevent
     * direct execution of binaries from app_data_file contexts.
     * The linker loads the ELF binary directly, bypassing the exec permission check.
     */
    private fun executeInRuntime(vararg command: String) {
        val binPath = File(usrDir, "bin/${command[0]}").absolutePath
        val cmdList = mutableListOf("/system/bin/linker64", binPath)
        cmdList.addAll(command.drop(1))

        val pb = ProcessBuilder(cmdList)
            .directory(homeDir)
            .redirectErrorStream(true)
        pb.environment().putAll(buildRuntimeEnv())
        val process = pb.start()
        val outputFuture = java.util.concurrent.CompletableFuture.supplyAsync {
            process.inputStream.bufferedReader().readText()
        }
        val exitCode = process.waitFor()
        val output = outputFuture.get()
        if (exitCode != 0) {
            throw IOException("${command[0]} failed (exit $exitCode): $output")
        }
    }

    /**
     * Generate and deploy linker64-env.sh — shell functions that route each
     * binary through /system/bin/linker64 (SELinux exec bypass).
     *
     * Detects file type by reading the first bytes:
     * - ELF binaries → `linker64 binary "$@"`
     * - Scripts (#!/usr/bin/env node) → `linker64 node script "$@"`
     *
     * Called by both PtyBridge (Claude Code) and DirectShellBridge (Shell view)
     * to ensure functions are available regardless of which view launches first.
     *
     * @return the absolute path to the deployed script
     */
    fun deployBashEnv(): String {
        val mobileDir = File(homeDir, ".claude-mobile")
        mobileDir.mkdirs()
        val bashEnvPath = File(mobileDir, "linker64-env.sh")
        bashEnvPath.writeText(buildBashEnvSh(usrDir.absolutePath))

        // Repair .bash_profile/.bashrc sourcing every launch — a previous app
        // version or Claude Code may have clobbered these files.
        ensureShellProfileSources(bashEnvPath.absolutePath)

        return bashEnvPath.absolutePath
    }

    /**
     * Ensure .bash_profile and .bashrc source linker64-env.sh.
     * Called every shell launch (not just bootstrap) to self-heal after
     * external modifications to profile files.
     */
    private fun ensureShellProfileSources(bashEnvPath: String) {
        val bashProfile = File(homeDir, ".bash_profile")
        val existingProfile = if (bashProfile.exists()) bashProfile.readText() else ""
        val profileAdditions = StringBuilder()
        if (!existingProfile.contains(".bashrc")) {
            profileAdditions.appendLine("# Source .bashrc for login shells")
            profileAdditions.appendLine("[ -f \"\$HOME/.bashrc\" ] && . \"\$HOME/.bashrc\"")
        }
        if (!existingProfile.contains("linker64-env.sh")) {
            profileAdditions.appendLine("# Load linker64 wrapper functions for embedded binaries")
            profileAdditions.appendLine("[ -f \"\$HOME/.claude-mobile/linker64-env.sh\" ] && . \"\$HOME/.claude-mobile/linker64-env.sh\"")
        }
        if (profileAdditions.isNotEmpty()) {
            bashProfile.writeText(profileAdditions.toString() + existingProfile)
        }

        val bashrc = File(homeDir, ".bashrc")
        val existingBashrc = if (bashrc.exists()) bashrc.readText() else ""
        if (!existingBashrc.contains("linker64-env.sh")) {
            bashrc.writeText(
                "# Load linker64 wrapper functions for embedded binaries\n" +
                "[ -f \"\$HOME/.claude-mobile/linker64-env.sh\" ] && . \"\$HOME/.claude-mobile/linker64-env.sh\"\n" +
                if (existingBashrc.isNotEmpty()) "\n$existingBashrc" else ""
            )
        }
    }

    private fun buildBashEnvSh(usrPath: String): String {
        val binDir = File(usrPath, "bin")
        if (!binDir.isDirectory) return "# bin dir not found\n"
        val skip = setOf("bash", "sh", "sh-wrapper", "env")
        // Package manager binaries need special handling — they have hardcoded
        // /data/data/com.termux/ paths that must be overridden via config/flags.
        val pkgManagerOverrides = setOf("apt", "apt-get", "apt-cache", "apt-key", "dpkg", "dpkg-deb", "pkg")
        val sb = StringBuilder("# linker64 wrapper functions for embedded binaries\n")
        val functionNames = mutableListOf<String>()
        // Track generated functions to avoid duplicates when scanning multiple dirs
        val generated = mutableSetOf<String>()

        // Scan a directory for binaries and generate linker64 shell function wrappers.
        // binDirPath = the directory to scan, usrBinPath = where interpreters live ($PREFIX/bin)
        fun scanBinDir(scanDir: File, label: String) {
            if (!scanDir.isDirectory) return
            sb.appendLine()
            sb.appendLine("# Wrappers for $label")
            scanDir.listFiles()?.sorted()?.forEach { file ->
                if (!file.isFile) return@forEach
                val n = file.name
                if (n in skip) return@forEach
                if (n in pkgManagerOverrides) return@forEach
                if (n in generated) return@forEach  // already generated from higher-priority dir
                if (!n.matches(Regex("[a-zA-Z_][a-zA-Z0-9_.+-]*"))) return@forEach

                val filePath = file.absolutePath
                val header = ByteArray(512)
                val bytesRead = try {
                    file.inputStream().use { it.read(header) }
                } catch (_: Exception) { return@forEach }
                if (bytesRead < 2) return@forEach

                val isElf = bytesRead >= 4 &&
                    header[0] == 0x7f.toByte() &&
                    header[1] == 'E'.code.toByte() &&
                    header[2] == 'L'.code.toByte() &&
                    header[3] == 'F'.code.toByte()

                val isScript = header[0] == '#'.code.toByte() &&
                    header[1] == '!'.code.toByte()

                if (isElf) {
                    sb.appendLine("""$n() { /system/bin/linker64 "$filePath" "${'$'}@"; }""")
                } else if (isScript) {
                    val shebangLine = String(header, 0, bytesRead)
                        .lines().first().removePrefix("#!").trim()
                    val parts = shebangLine.split(Regex("\\s+"))
                    val interpreter = parts[0]
                    val interpArgs = parts.drop(1)

                    if (interpreter.endsWith("/env") && interpArgs.isNotEmpty()) {
                        val prog = interpArgs[0]
                        sb.appendLine("""$n() { /system/bin/linker64 "$usrPath/bin/$prog" "$filePath" "${'$'}@"; }""")
                    } else {
                        val interpName = File(interpreter).name
                        sb.appendLine("""$n() { /system/bin/linker64 "$usrPath/bin/$interpName" "$filePath" "${'$'}@"; }""")
                    }
                } else {
                    val headerStr = String(header, 0, bytesRead.coerceAtMost(64))
                    val looksLikeJs = headerStr.startsWith("import ") ||
                        headerStr.startsWith("import{") ||
                        headerStr.startsWith("require(") ||
                        headerStr.startsWith("\"use strict\"") ||
                        headerStr.startsWith("'use strict'") ||
                        headerStr.startsWith("//") ||
                        headerStr.startsWith("/*") ||
                        headerStr.startsWith("module.exports")
                    if (looksLikeJs) {
                        sb.appendLine("""$n() { /system/bin/linker64 "$usrPath/bin/node" "$filePath" "${'$'}@"; }""")
                    } else {
                        sb.appendLine("""$n() { /system/bin/linker64 "$filePath" "${'$'}@"; }""")
                    }
                }
                generated.add(n)
                functionNames.add(n)
            }
        }

        // Scan $PREFIX/bin first (highest priority), then ~/.local/bin
        scanBinDir(binDir, "$usrPath/bin")
        scanBinDir(File(homeDir, ".local/bin"), "~/.local/bin")

        // Package manager functions — override hardcoded /data/data/com.termux/ paths.
        // apt reads APT_CONFIG env var which points to our apt.conf with all Dir overrides.
        // dpkg needs --admindir and --instdir flags at every invocation.
        sb.appendLine()
        sb.appendLine("# Package manager wrappers — redirect hardcoded Termux paths")
        val aptConf = "$usrPath/etc/apt/apt.conf"
        val dpkgAdmin = "$usrPath/var/lib/dpkg"

        for (aptCmd in listOf("apt", "apt-get", "apt-cache", "apt-key")) {
            if (File(binDir, aptCmd).exists()) {
                sb.appendLine("""$aptCmd() { APT_CONFIG="$aptConf" /system/bin/linker64 "$usrPath/bin/$aptCmd" "${'$'}@"; }""")
                functionNames.add(aptCmd)
            }
        }
        if (File(binDir, "dpkg").exists()) {
            sb.appendLine("""dpkg() { /system/bin/linker64 "$usrPath/bin/dpkg" --admindir="$dpkgAdmin" "${'$'}@"; }""")
            functionNames.add("dpkg")
        }
        if (File(binDir, "dpkg-deb").exists()) {
            sb.appendLine("""dpkg-deb() { /system/bin/linker64 "$usrPath/bin/dpkg-deb" "${'$'}@"; }""")
            functionNames.add("dpkg-deb")
        }
        // pkg is Termux's friendly wrapper — redirect to our configured apt
        sb.appendLine("""pkg() {
  case "${'$'}1" in
    install) shift; apt install -y "${'$'}@" ;;
    update)  apt update ;;
    upgrade) shift; apt upgrade -y "${'$'}@" ;;
    search)  shift; apt search "${'$'}@" ;;
    list)    shift; apt list "${'$'}@" ;;
    show)    shift; apt show "${'$'}@" ;;
    *)       apt "${'$'}@" ;;
  esac
}""")
        functionNames.add("pkg")

        // Android filesystem fixes
        sb.appendLine()
        sb.appendLine("# Android has no /tmp — redirect to \$HOME/tmp")
        sb.appendLine("""cd() {
  case "${'$'}1" in
    /tmp)     builtin cd "${'$'}HOME/tmp" ;;
    /tmp/*)   builtin cd "${'$'}HOME/tmp/${'$'}{1#/tmp/}" ;;
    /var/tmp) builtin cd "${'$'}HOME/tmp" ;;
    *)        builtin cd "${'$'}@" ;;
  esac
}""")
        functionNames.add("cd")

        sb.appendLine()
        sb.appendLine("# Force logical pwd — Android FUSE gives inconsistent inodes")
        sb.appendLine("# that break physical pwd's directory walk")
        sb.appendLine("set +P")
        sb.appendLine("""pwd() { builtin pwd -L "${'$'}@" 2>/dev/null || echo "${'$'}PWD"; }""")
        functionNames.add("pwd")

        // Ensure PWD is always set (physical fallback can fail on FUSE)
        sb.appendLine("[ -z \"\$PWD\" ] && PWD=\"\$HOME\" && export PWD")

        if (functionNames.isNotEmpty()) {
            sb.appendLine()
            sb.appendLine("# Export functions for subshells")
            for (n in functionNames) {
                sb.appendLine("export -f $n 2>/dev/null")
            }
        }
        return sb.toString()
    }

    fun buildRuntimeEnv(): Map<String, String> {
        val usr = usrDir.absolutePath
        val home = homeDir.absolutePath
        val bashPath = "$usr/bin/bash"
        val ldPreloadSo = "$usr/lib/libtermux-exec-ld-preload.so"

        return buildMap {
            put("HOME", home)
            put("PREFIX", usr)
            // Point SHELL and CLAUDE_CODE_SHELL to embedded bash.
            // Claude Code ONLY accepts shells with "bash" or "zsh" in the path —
            // /system/bin/sh is silently ignored regardless of POSIX compliance.
            put("SHELL", bashPath)
            put("CLAUDE_CODE_SHELL", bashPath)
            put("PATH", "$home/.local/bin:$usr/bin:$usr/bin/applets:/system/bin")
            put("LD_LIBRARY_PATH", "$usr/lib")
            // termux-exec LD_PRELOAD: intercepts execve() in bash subprocesses
            // and routes them through linker64. Complements the JS wrapper which
            // only covers Node.js-level spawn calls.
            if (File(ldPreloadSo).exists()) {
                put("LD_PRELOAD", ldPreloadSo)
            }
            put("LANG", "en_US.UTF-8")
            put("TERM", "xterm-256color")
            // Override hardcoded Termux paths in compiled binaries
            put("OPENSSL_CONF", "$usr/etc/tls/openssl.cnf")
            put("SSL_CERT_FILE", "$usr/etc/tls/cert.pem")
            put("SSL_CERT_DIR", "$usr/etc/tls/certs")
            // termux-exec v2.x reads TERMUX__PREFIX (double underscore) to
            // determine the runtime prefix. Without this, it falls back to
            // the hardcoded /data/data/com.termux/files/usr path.
            put("TERMUX__PREFIX", usr)
            put("TERMUX_PREFIX", usr)
            // Git helper programs (git-remote-https, git-upload-pack, etc.)
            // have Termux paths baked in — override with our relocated prefix.
            put("GIT_EXEC_PATH", "$usr/libexec/git-core")
            put("GIT_TEMPLATE_DIR", "$usr/share/git-core/templates")
            put("TMPDIR", "$home/tmp")
            // Claude Code uses CLAUDE_CODE_TMPDIR for its own temp files
            // (sandbox dirs, etc.). Falls back to /tmp which doesn't exist on Android.
            put("CLAUDE_CODE_TMPDIR", "$home/tmp")
        }
    }
}
