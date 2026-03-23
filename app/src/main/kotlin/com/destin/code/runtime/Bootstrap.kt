package com.destin.code.runtime

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
import com.destin.code.config.PackageTier

class Bootstrap(private val context: Context) {

    val usrDir: File get() = File(context.filesDir, "usr")
    val homeDir: File get() = File(context.filesDir, "home")
    val isExtracted: Boolean get() = File(usrDir, "bin/bash").exists()
    val isFullySetup: Boolean get() = File(usrDir, "bin/node").exists() &&
        File(usrDir, "lib/node_modules/npm").exists() &&
        File(usrDir, "lib/node_modules/@anthropic-ai/claude-code").exists()
    val isBootstrapped: Boolean get() = isExtracted && isFullySetup

    /** The package tier to install. Set before calling setup(). */
    var packageTier: PackageTier = PackageTier.CORE

    /** True if all packages for the current tier are installed. */
    fun isTierSatisfied(): Boolean {
        val packages = requiredPackagesForTier()
        return packages.all { packageFileExists(it) }
    }

    sealed class Progress {
        data class Extracting(val percent: Int) : Progress()
        data class Installing(val packageName: String, val overallPercent: Int = -1) : Progress()
        data class Error(val message: String) : Progress()
        data object Complete : Progress()
        /** Shown briefly after a tier upgrade installs new packages. */
        data class TierUpgradeComplete(val tierName: String) : Progress()
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
            } else if (!isTierSatisfied()) {
                // Tier was upgraded — install new packages only
                installPackages(onProgress)
                onProgress(Progress.TierUpgradeComplete(packageTier.displayName))
                kotlinx.coroutines.delay(2000) // Show success briefly
            }
            // Create post-install symlinks every launch (idempotent).
            // Termux packages rely on post-install scripts for these, which we
            // don't run. Placed here instead of installPackages() so symlinks
            // are created even when no new packages need installing.
            applyPostInstallFixups()
            onProgress(Progress.Complete)
        } catch (e: Exception) {
            onProgress(Progress.Error(e.message ?: "Unknown error"))
        }
    }

    /**
     * Post-install fixups for packages with hardcoded Termux paths.
     * Runs every launch (idempotent). Handles:
     * - Symlinks for binaries in libexec/
     * - Bulk rewrite of hardcoded Termux prefix in all scripts and configs
     *
     * Termux's build system rewrites every shebang from #!/usr/bin/env sh to
     * #!/data/data/com.termux/files/usr/bin/sh. Scripts also reference the
     * Termux prefix in paths to libraries, configs, and helper programs.
     * Since we relocate to a different prefix, all of these must be rewritten.
     *
     * This is the same approach Termux itself uses in post-install scripts.
     */
    private fun applyPostInstallFixups() {
        val usr = usrDir.absolutePath
        val termuxUsr = "/data/data/com.termux/files/usr"
        val termuxHome = "/data/data/com.termux/files/home"

        // 1. Symlinks — bin/ entries for binaries in libexec/
        val symlinks = mapOf(
            "bin/vim" to "../libexec/vim/vim",
            "bin/vi" to "../libexec/vim/vim",
            "bin/vimdiff" to "../libexec/vim/vim",
        )
        for ((link, target) in symlinks) {
            val linkFile = File(usrDir, link)
            val targetFile = File(usrDir, link.substringBeforeLast("/") + "/" + target)
            if (!linkFile.exists() && targetFile.canonicalFile.exists()) {
                try {
                    java.nio.file.Files.createSymbolicLink(
                        linkFile.toPath(),
                        java.nio.file.Paths.get(target)
                    )
                } catch (_: Exception) {}
            }
        }

        // 2. Bulk rewrite hardcoded Termux prefix in scripts and configs.
        // Scan bin/, libexec/, and etc/ for text files containing the old prefix.
        // Use a sentinel file to avoid re-scanning on every launch.
        val sentinel = File(usrDir, "var/lib/claude-mobile/prefix-rewritten")
        if (sentinel.exists()) return  // already done

        val dirsToScan = listOf("bin", "libexec", "etc")
        var rewriteCount = 0

        for (dirName in dirsToScan) {
            val dir = File(usrDir, dirName)
            if (!dir.isDirectory) continue

            dir.walkTopDown()
                .filter { it.isFile && !it.name.endsWith(".so") && it.length() < 512_000 }
                .forEach { file ->
                    try {
                        val bytes = file.readBytes()
                        // Skip binary files (check for null bytes in first 512 bytes)
                        val checkLen = minOf(bytes.size, 512)
                        if (bytes.take(checkLen).any { it == 0.toByte() }) return@forEach

                        val content = String(bytes)
                        if (content.contains(termuxUsr) || content.contains(termuxHome)) {
                            val rewritten = content
                                .replace(termuxUsr, usr)
                                .replace(termuxHome, homeDir.absolutePath)
                            file.writeText(rewritten)
                            file.setExecutable(true)
                            rewriteCount++
                        }
                    } catch (_: Exception) {
                        // Skip files we can't read/write
                    }
                }
        }

        // Write sentinel so we don't re-scan on subsequent launches.
        // Delete sentinel when new packages are installed (in installPackages).
        sentinel.parentFile?.mkdirs()
        sentinel.writeText("$rewriteCount files rewritten at ${System.currentTimeMillis()}")
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
                // Extraction = 0-30% of overall progress
                onProgress(Progress.Extracting((count * 30) / 5000))
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

        onProgress(Progress.Extracting(30))
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

    /** Core packages — always installed regardless of tier. */
    private val corePackages = listOf(
        "libandroid-support", "libandroid-posix-semaphore", "openssl", "zlib",
        "libiconv", "libexpat", "pcre2",
        "c-ares", "libicu", "libsqlite", "nodejs", "npm",
        "termux-exec",
        "libnghttp2", "libnghttp3", "libngtcp2", "libssh2", "libcurl", "curl",
        "git",
        "openssh", "gh",
        "gdbm", "libbz2", "libcrypt", "libffi", "liblzma",
        "ncurses", "ncurses-ui-libs", "readline", "python",
        "libunistring", "libidn2", "libuuid", "wget",
        "rclone",
        // ripgrep is required by Claude Code's built-in Grep and Glob tools.
        // Without it, these core tools fail with ENOENT even with the vendor symlink.
        "ripgrep", "oniguruma"
    )

    /** Returns all packages to install based on the configured tier. */
    private fun requiredPackagesForTier(): List<String> {
        return corePackages + packageTier.allAdditionalPackages()
    }

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
            "rclone" -> "bin/rclone"
            "libandroid-support" -> "lib/libandroid-support.so"
            "libandroid-posix-semaphore" -> "lib/libandroid-posix-semaphore.so"
            "libnghttp2" -> "lib/libnghttp2.so"
            "libnghttp3" -> "lib/libnghttp3.so"
            "libngtcp2" -> "lib/libngtcp2.so"
            "libssh2" -> "lib/libssh2.so"
            "curl" -> "bin/curl"
            "gdbm" -> "lib/libgdbm.so"
            "libbz2" -> "lib/libbz2.so"
            "libcrypt" -> "lib/libcrypt.so"
            "libffi" -> "lib/libffi.so"
            "liblzma" -> "lib/liblzma.so"
            "ncurses" -> "lib/libncurses.so"
            "ncurses-ui-libs" -> "lib/libform.so"
            "readline" -> "lib/libreadline.so"
            "python" -> "bin/python3"
            "libunistring" -> "lib/libunistring.so"
            "libidn2" -> "lib/libidn2.so"
            "libuuid" -> "lib/libuuid.so"
            "wget" -> "bin/wget"
            // Tier 1: Developer Essentials
            "fd" -> "bin/fd"
            "micro" -> "bin/micro"
            "tree" -> "bin/tree"
            "ripgrep" -> "bin/rg"
            "findutils" -> "bin/find"
            "ncurses-utils" -> "bin/tput"
            "fzf" -> "bin/fzf"
            "oniguruma" -> "lib/libonig.so"
            "jq" -> "bin/jq"
            "libgit2" -> "lib/libgit2.so"
            "bat" -> "bin/bat"
            "eza" -> "bin/eza"
            "libevent" -> "lib/libevent.so"
            "libandroid-glob" -> "lib/libandroid-glob.so"
            "tmux" -> "bin/tmux"
            "nano" -> "bin/nano"
            // Tier 2: Full Dev Environment
            "libsodium" -> "lib/libsodium.so"
            "vim" -> "libexec/vim/vim"
            "libmsgpack" -> "lib/libmsgpack-c.so"
            "libunibilium" -> "lib/libunibilium.so"
            "libuv" -> "lib/libuv.so"
            "libvterm" -> "lib/libvterm.so"
            "lua51" -> "lib/liblua5.1.so"
            "lua51-lpeg" -> "lib/lua/5.1/lpeg.so"
            "luajit" -> "bin/luajit"
            "luv" -> "lib/libluv.so"
            "tree-sitter" -> "lib/libtree-sitter.so"
            // Tree-sitter parsers install as lib/libtree-sitter-{lang}.so
            "tree-sitter-c" -> "lib/libtree-sitter-c.so"
            "tree-sitter-lua" -> "lib/libtree-sitter-lua.so"
            "tree-sitter-markdown" -> "lib/libtree-sitter-markdown.so"
            "tree-sitter-query" -> "lib/libtree-sitter-query.so"
            "tree-sitter-vimdoc" -> "lib/libtree-sitter-vimdoc.so"
            "tree-sitter-vim" -> "lib/libtree-sitter-vim.so"
            "tree-sitter-parsers" -> "lib/libtree-sitter-c.so" // meta-package; check any parser
            "utf8proc" -> "lib/libutf8proc.so"
            "neovim" -> "bin/nvim"
            "make" -> "bin/make"
            "libxml2" -> "lib/libxml2.so"
            "libarchive" -> "lib/libarchive.so"
            "jsoncpp" -> "lib/libjsoncpp.so"
            "rhash" -> "lib/librhash.so"
            "cmake" -> "bin/cmake"
            "sqlite" -> "bin/sqlite3"
            else -> return false
        }
        return File(usrDir, checkFile).exists()
    }

    private fun installPackages(onProgress: (Progress) -> Unit) {
        // Invalidate prefix-rewrite sentinel so applyPostInstallFixups()
        // re-scans scripts after new packages are installed.
        File(usrDir, "var/lib/claude-mobile/prefix-rewritten").delete()

        val index = fetchPackagesIndex()
        val installed = loadInstalledVersions()

        val packages = requiredPackagesForTier()
        val total = packages.size
        for ((i, name) in packages.withIndex()) {
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

        // termux-exec postinst: always overwrite primary .so with linker variant.
        // The linker variant intercepts execve() in subprocesses and routes them
        // through /system/bin/linker64, which is required for SELinux bypass.
        // The default (direct) variant only fixes paths but doesn't use linker64,
        // causing "Permission denied" when binaries fork+exec helpers (e.g. git
        // calling git-remote-https).
        val linkerSo = File(usrDir, "lib/libtermux-exec-linker-ld-preload.so")
        val primarySo = File(usrDir, "lib/libtermux-exec-ld-preload.so")
        if (linkerSo.exists()) {
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
        onProgress(Progress.Installing("claude-code", 80))
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

    data class SelfTestResult(
        val bashOk: Boolean,
        val nodeOk: Boolean,
        val cliExists: Boolean,
    ) {
        val passed: Boolean get() = bashOk && nodeOk && cliExists
        val failureMessage: String? get() = when {
            !bashOk -> "bash failed to execute through linker64"
            !nodeOk -> "Node.js failed to start"
            !cliExists -> "Claude Code CLI entry point not found"
            else -> null
        }
    }

    fun selfTest(): SelfTestResult {
        val prefix = usrDir.absolutePath
        val env = mapOf(
            "LD_LIBRARY_PATH" to "$prefix/lib",
            "HOME" to homeDir.absolutePath,
            "TMPDIR" to File(homeDir, "tmp").absolutePath,
        )

        fun runTest(vararg cmd: String): Boolean = try {
            val p = ProcessBuilder(*cmd).redirectErrorStream(true).apply {
                environment().putAll(env)
            }.start()
            p.inputStream.readBytes()
            p.waitFor() == 0
        } catch (_: Exception) { false }

        val bashOk = runTest("/system/bin/linker64", "$prefix/bin/bash", "--version")
        val nodeOk = runTest("/system/bin/linker64", "$prefix/bin/node", "-e", "process.exit(0)")
        val cliExists = File("$prefix/lib/node_modules/@anthropic-ai/claude-code/cli.js").exists()

        return SelfTestResult(bashOk, nodeOk, cliExists)
    }

    private fun setupHome() {
        homeDir.mkdirs()
        File(homeDir, ".claude").mkdirs()
        File(homeDir, "tmp").mkdirs()
        // Create .cache/tmpdir as the TMPDIR location (avoids Termux Node.js
        // compiled-in /tmp rewriting — see buildRuntimeEnv() comment).
        // This is a real directory, not a symlink, so all temp file operations work.
        val cacheDir = File(homeDir, ".cache")
        cacheDir.mkdirs()
        val tmpDirAlias = File(cacheDir, "tmpdir")
        if (!tmpDirAlias.exists()) {
            tmpDirAlias.mkdirs()
        }

        val mobileDir = File(homeDir, ".claude-mobile")
        mobileDir.mkdirs()
        File(mobileDir, "titles").mkdirs()

        // Deploy browser-open helper — uses Android's am start to open URLs.
        // Tools like rclone, gh, and npm read the BROWSER env var for OAuth
        // flows. Without this, browser-based auth fails on Android.
        // Uses /system/bin/sh (always available) and calls app_process directly
        // with the termux-am APK, avoiding broken Termux shebangs and SELinux.
        val amApkPath = File(usrDir, "libexec/termux-am/am.apk").absolutePath
        val browserScript = File(mobileDir, "browser-open")
        browserScript.writeText(
            "#!/system/bin/sh\n" +
            "AM_APK=\"$amApkPath\"\n" +
            "if [ -f \"\$AM_APK\" ]; then\n" +
            "  export CLASSPATH=\"\$AM_APK\"\n" +
            "  unset LD_LIBRARY_PATH LD_PRELOAD\n" +
            "  /system/bin/app_process -Xnoimage-dex2oat / com.termux.termuxam.Am " +
            "start -a android.intent.action.VIEW -d \"\$1\" >/dev/null 2>&1\n" +
            "else\n" +
            "  /system/bin/am start -a android.intent.action.VIEW -d \"\$1\" >/dev/null 2>&1\n" +
            "fi\n"
        )
        browserScript.setExecutable(true)

        // Deploy xdg-open and open wrappers — Claude Code calls xdg-open (Linux)
        // or open (macOS) during auth. Neither exists on Android.
        // These wrappers delegate to browser-open so auth URLs open correctly.
        val browserOpenPath = browserScript.absolutePath
        for (name in listOf("xdg-open", "open")) {
            val wrapper = File(mobileDir, name)
            wrapper.writeText(
                "#!/system/bin/sh\nexec \"$browserOpenPath\" \"\$@\"\n"
            )
            wrapper.setExecutable(true)
        }

        // Sync gh CLI token to ~/.netrc so git can authenticate over HTTPS.
        // Git's credential helper system doesn't work on Android because:
        // 1. `gh auth setup-git` fails (Go binaries bypass LD_PRELOAD)
        // 2. Shell-based credential helpers fail (git can't exec scripts
        //    through its internal shell on our SELinux-restricted prefix)
        // .netrc is read natively by libcurl with no script execution needed.
        syncGhTokenToNetrc()

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
     * Sync the gh CLI OAuth token into ~/.netrc so git can authenticate.
     * Called during setupHome() and can be called again after `gh auth login`.
     * Only updates the github.com entry; preserves other .netrc entries.
     */
    private fun syncGhTokenToNetrc() {
        val hostsFile = File(homeDir, ".config/gh/hosts.yml")
        if (!hostsFile.exists()) return

        // Parse oauth_token from gh's hosts.yml using simple line scanning.
        var token: String? = null
        for (line in hostsFile.readLines()) {
            val trimmed = line.trim()
            if (trimmed.startsWith("oauth_token:")) {
                token = trimmed.removePrefix("oauth_token:").trim()
                break
            }
        }
        if (token.isNullOrBlank()) return

        val netrc = File(homeDir, ".netrc")
        val entry = "machine github.com login x-access-token password $token"

        if (netrc.exists()) {
            // Replace existing github.com line or append
            val lines = netrc.readLines().toMutableList()
            val idx = lines.indexOfFirst { it.contains("machine github.com") }
            if (idx >= 0) {
                if (lines[idx] == entry) return  // Already up to date
                lines[idx] = entry
            } else {
                lines.add(entry)
            }
            netrc.writeText(lines.joinToString("\n") + "\n")
        } else {
            netrc.writeText(entry + "\n")
        }
        // .netrc must be owner-readable only
        netrc.setReadable(false, false)
        netrc.setReadable(true, true)
        netrc.setWritable(false, false)
        netrc.setWritable(true, true)
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

        // Deploy xdg-open/open wrappers every launch — Claude Code calls these
        // during auth to open the browser. Neither exists on Android natively.
        // Placed in both ~/.claude-mobile (on PATH for shell) and $PREFIX/bin
        // (where claude-wrapper.js resolveCmd() looks up bare command names).
        val browserOpenPath = File(mobileDir, "browser-open").absolutePath
        for (name in listOf("xdg-open", "open")) {
            val wrapperContent = "#!/system/bin/sh\nexec \"$browserOpenPath\" \"\$@\"\n"
            val wrapper = File(mobileDir, name)
            wrapper.writeText(wrapperContent)
            wrapper.setExecutable(true)
            // Also place in $PREFIX/bin so claude-wrapper.js resolveCmd() finds them
            val binWrapper = File(usrDir, "bin/$name")
            binWrapper.writeText(wrapperContent)
            binWrapper.setExecutable(true)
        }

        // Deploy script-based exec wrappers for binaries commonly spawned as
        // child processes by Go/Rust/Python programs (which bypass LD_PRELOAD).
        // These are real #!/system/bin/sh scripts that route through linker64,
        // so exec.LookPath() in non-bash contexts finds a working wrapper.
        // Example: `gh repo clone` calls exec("git") which fails without this.
        val execWrappersDir = File(mobileDir, "exec-wrappers")
        execWrappersDir.mkdirs()
        val wrapperBinaries = listOf(
            "git", "ssh", "ssh-keygen", "gpg", "gpg2", "curl", "wget",
            "rclone",  // Go binary — spawns xdg-open, curl for OAuth
            "node",    // commonly exec'd by Go/Rust tools (e.g. npx packages)
            "python3", "python",  // subprocess.Popen with absolute paths
        )
        for (name in wrapperBinaries) {
            val realBin = File(usrDir, "bin/$name")
            // Resolve symlinks to get the actual ELF binary path
            val targetPath = if (realBin.exists()) realBin.canonicalPath else continue
            val wrapper = File(execWrappersDir, name)
            wrapper.writeText("#!/system/bin/sh\nexec /system/bin/linker64 \"$targetPath\" \"\$@\"\n")
            wrapper.setExecutable(true)
        }

        // Create vendor symlinks for Claude Code's built-in tools.
        // Claude Code looks for vendor/<tool>/<platform>/<binary> but doesn't ship
        // arm64-android variants. Symlink to installed binaries or compatible
        // arm64-linux variants (Android IS Linux on arm64).
        val claudeCodeDir = File(usrDir, "lib/node_modules/@anthropic-ai/claude-code")
        if (claudeCodeDir.exists()) {
            // Ripgrep — needed for Grep/Glob tools
            val systemRg = File(usrDir, "bin/rg")
            val vendorRgDir = File(claudeCodeDir, "vendor/ripgrep/arm64-android")
            if (systemRg.exists() && !File(vendorRgDir, "rg").exists()) {
                vendorRgDir.mkdirs()
                val rgLink = File(vendorRgDir, "rg")
                try {
                    java.nio.file.Files.createSymbolicLink(
                        rgLink.toPath(),
                        systemRg.canonicalFile.toPath()
                    )
                } catch (_: Exception) {
                    systemRg.copyTo(rgLink, overwrite = true)
                    rgLink.setExecutable(true)
                }
            }

            // tree-sitter-bash — needed for bash syntax analysis.
            // The arm64-linux .node binary is compatible with Android (same kernel ABI).
            val tsLinux = File(claudeCodeDir, "vendor/tree-sitter-bash/arm64-linux/tree-sitter-bash.node")
            val tsAndroidDir = File(claudeCodeDir, "vendor/tree-sitter-bash/arm64-android")
            if (tsLinux.exists() && !File(tsAndroidDir, "tree-sitter-bash.node").exists()) {
                tsAndroidDir.mkdirs()
                val tsLink = File(tsAndroidDir, "tree-sitter-bash.node")
                try {
                    java.nio.file.Files.createSymbolicLink(
                        tsLink.toPath(),
                        tsLinux.canonicalFile.toPath()
                    )
                } catch (_: Exception) {
                    tsLinux.copyTo(tsLink, overwrite = true)
                }
            }

            // audio-capture — same pattern, symlink arm64-linux for Android
            val acLinux = File(claudeCodeDir, "vendor/audio-capture/arm64-linux")
            val acAndroidDir = File(claudeCodeDir, "vendor/audio-capture/arm64-android")
            if (acLinux.exists() && !acAndroidDir.exists()) {
                try {
                    java.nio.file.Files.createSymbolicLink(
                        acAndroidDir.toPath(),
                        acLinux.canonicalFile.toPath()
                    )
                } catch (_: Exception) { /* non-critical — voice input may not be used */ }
            }
        }

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
        val skip = setOf("bash", "sh", "sh-wrapper", "env", "xdg-open", "open")
        // Package manager binaries need special handling — they have hardcoded
        // /data/data/com.termux/ paths that must be overridden via config/flags.
        val pkgManagerOverrides = setOf("apt", "apt-get", "apt-cache", "apt-key", "dpkg", "dpkg-deb", "pkg")
        val sb = StringBuilder("# linker64 wrapper functions for embedded binaries\n")
        // Helper function to rewrite /tmp and /var/tmp paths in command arguments.
        // Android has no /tmp — we redirect to $HOME/tmp. This fixes install scripts
        // and other programs that hardcode /tmp paths in arguments (e.g. curl -o /tmp/file).
        sb.appendLine()
        sb.appendLine("# Rewrite /tmp paths in command arguments — Android has no /tmp")
        sb.appendLine("""__fix_tmp() {
  __FT=()
  for __ft_a in "${'$'}@"; do
    case "${'$'}__ft_a" in
      /tmp)       __FT+=("${'$'}HOME/tmp") ;;
      /tmp/*)     __FT+=("${'$'}HOME/tmp/${'$'}{__ft_a#/tmp/}") ;;
      /var/tmp)   __FT+=("${'$'}HOME/tmp") ;;
      /var/tmp/*) __FT+=("${'$'}HOME/tmp/${'$'}{__ft_a#/var/tmp/}") ;;
      *=/tmp)     __FT+=("${'$'}{__ft_a%=/tmp}=${'$'}HOME/tmp") ;;
      *=/tmp/*)   __FT+=("${'$'}{__ft_a%%=/tmp/*}=${'$'}HOME/tmp/${'$'}{__ft_a#*=/tmp/}") ;;
      *)          __FT+=("${'$'}__ft_a") ;;
    esac
  done
}""")
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

                if (isElf && n == "make") {
                    // GNU make ignores the SHELL env var and uses its compiled-in
                    // default (/data/data/com.termux/.../bin/sh). Override via
                    // command-line variable assignment which takes highest priority.
                    sb.appendLine("""$n() { __fix_tmp "${'$'}@"; /system/bin/linker64 "$filePath" "SHELL=$usrPath/bin/bash" "${'$'}{__FT[@]}"; }""")
                } else if (isElf) {
                    sb.appendLine("""$n() { __fix_tmp "${'$'}@"; /system/bin/linker64 "$filePath" "${'$'}{__FT[@]}"; }""")
                } else if (isScript) {
                    val shebangLine = String(header, 0, bytesRead)
                        .lines().first().removePrefix("#!").trim()
                    val parts = shebangLine.split(Regex("\\s+"))
                    val interpreter = parts[0]
                    val interpArgs = parts.drop(1)

                    if (interpreter.endsWith("/env") && interpArgs.isNotEmpty()) {
                        val prog = interpArgs[0]
                        sb.appendLine("""$n() { __fix_tmp "${'$'}@"; /system/bin/linker64 "$usrPath/bin/$prog" "$filePath" "${'$'}{__FT[@]}"; }""")
                    } else {
                        val interpName = File(interpreter).name
                        sb.appendLine("""$n() { __fix_tmp "${'$'}@"; /system/bin/linker64 "$usrPath/bin/$interpName" "$filePath" "${'$'}{__FT[@]}"; }""")
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
                        sb.appendLine("""$n() { __fix_tmp "${'$'}@"; /system/bin/linker64 "$usrPath/bin/node" "$filePath" "${'$'}{__FT[@]}"; }""")
                    } else {
                        sb.appendLine("""$n() { __fix_tmp "${'$'}@"; /system/bin/linker64 "$filePath" "${'$'}{__FT[@]}"; }""")
                    }
                }
                generated.add(n)
                functionNames.add(n)
            }
        }

        // Scan $PREFIX/bin first (highest priority), then ~/.local/bin
        scanBinDir(binDir, "$usrPath/bin")
        scanBinDir(File(homeDir, ".local/bin"), "~/.local/bin")

        // Shell wrappers — bash and sh are in the skip set (we don't want the auto-scan
        // to generate standard linker64 wrappers for them) but they DO need /tmp rewriting.
        // Without these, `bash /tmp/install.sh` fails because bash opens the literal path.
        // Subshells via (...) fork the process and don't invoke these functions.
        sb.appendLine()
        sb.appendLine("# Shell wrappers — /tmp rewriting for script arguments")
        val bashBin = File(binDir, "bash")
        if (bashBin.exists()) {
            sb.appendLine("""bash() { __fix_tmp "${'$'}@"; /system/bin/linker64 "${bashBin.absolutePath}" "${'$'}{__FT[@]}"; }""")
            functionNames.add("bash")
        }
        val shBin = File(binDir, "sh")
        if (shBin.exists() && shBin.canonicalPath != bashBin.canonicalPath) {
            sb.appendLine("""sh() { __fix_tmp "${'$'}@"; /system/bin/linker64 "${shBin.absolutePath}" "${'$'}{__FT[@]}"; }""")
            functionNames.add("sh")
        } else if (shBin.exists()) {
            // sh is a link to bash — use the same wrapper
            sb.appendLine("""sh() { bash "${'$'}@"; }""")
            functionNames.add("sh")
        }

        // Package manager functions — override hardcoded /data/data/com.termux/ paths.
        // apt reads APT_CONFIG env var which points to our apt.conf with all Dir overrides.
        // dpkg needs --admindir and --instdir flags at every invocation.
        sb.appendLine()
        sb.appendLine("# Package manager wrappers — redirect hardcoded Termux paths")
        val aptConf = "$usrPath/etc/apt/apt.conf"
        val dpkgAdmin = "$usrPath/var/lib/dpkg"

        for (aptCmd in listOf("apt", "apt-get", "apt-cache", "apt-key")) {
            if (File(binDir, aptCmd).exists()) {
                sb.appendLine("""$aptCmd() { __fix_tmp "${'$'}@"; APT_CONFIG="$aptConf" /system/bin/linker64 "$usrPath/bin/$aptCmd" "${'$'}{__FT[@]}"; }""")
                functionNames.add(aptCmd)
            }
        }
        if (File(binDir, "dpkg").exists()) {
            sb.appendLine("""dpkg() { __fix_tmp "${'$'}@"; /system/bin/linker64 "$usrPath/bin/dpkg" --admindir="$dpkgAdmin" "${'$'}{__FT[@]}"; }""")
            functionNames.add("dpkg")
        }
        if (File(binDir, "dpkg-deb").exists()) {
            sb.appendLine("""dpkg-deb() { __fix_tmp "${'$'}@"; /system/bin/linker64 "$usrPath/bin/dpkg-deb" "${'$'}{__FT[@]}"; }""")
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
            sb.appendLine("export -f __fix_tmp 2>/dev/null")
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
            // exec-wrappers comes before $usr/bin so Go/Rust/Python programs find
            // shell script wrappers (which route through linker64) instead of raw
            // ELF binaries (which SELinux blocks when exec'd by non-bash processes).
            put("PATH", "$home/.claude-mobile:$home/.claude-mobile/exec-wrappers:$home/.local/bin:$usr/bin:$usr/bin/applets:/system/bin")
            put("LD_LIBRARY_PATH", "$usr/lib")
            // termux-exec LD_PRELOAD: intercepts execve() in bash subprocesses
            // and routes them through linker64. Complements the JS wrapper which
            // only covers Node.js-level spawn calls.
            if (File(ldPreloadSo).exists()) {
                put("LD_PRELOAD", ldPreloadSo)
            }
            put("LANG", "en_US.UTF-8")
            put("TERM", "xterm-256color")
            // Override hardcoded Termux paths in compiled binaries.
            // GIT_SSL_CAINFO is required because git's libcurl has the Termux
            // cert path compiled in and ignores SSL_CERT_FILE.
            put("OPENSSL_CONF", "$usr/etc/tls/openssl.cnf")
            put("SSL_CERT_FILE", "$usr/etc/tls/cert.pem")
            put("SSL_CERT_DIR", "$usr/etc/tls/certs")
            put("GIT_SSL_CAINFO", "$usr/etc/tls/cert.pem")
            // termux-exec v2.x reads these env vars to determine the runtime
            // prefix and enable linker64 exec mode. Without them, it falls back
            // to the hardcoded /data/data/com.termux/files/usr path and won't
            // intercept execve() calls for our relocated prefix.
            val filesDir = context.filesDir.absolutePath
            put("TERMUX__PREFIX", usr)
            put("TERMUX_PREFIX", usr)
            put("TERMUX__ROOTFS", filesDir)
            put("TERMUX_APP__DATA_DIR", filesDir)
            put("TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE", "enable")
            // Git helper programs (git-remote-https, git-upload-pack, etc.)
            // have Termux paths baked in — override with our relocated prefix.
            put("GIT_EXEC_PATH", "$usr/libexec/git-core")
            put("GIT_TEMPLATE_DIR", "$usr/share/git-core/templates")
            // Git has /data/data/com.termux/.../etc/gitconfig compiled in as the
            // system config path. That path doesn't exist in our prefix and causes
            // "Permission denied" errors. Disable system config entirely.
            put("GIT_CONFIG_NOSYSTEM", "1")
            put("GIT_ATTR_NOSYSTEM", "1")
            // Vim has the Termux prefix baked in for $VIM/$VIMRUNTIME.
            // Override so it can find defaults.vim, syntax files, etc.
            put("VIM", "$usr/share/vim")
            put("VIMRUNTIME", "$usr/share/vim/vim92")
            // Nano looks for nanorc at the hardcoded Termux path.
            val nanorc = "$usr/etc/nanorc"
            if (File(nanorc).exists()) put("NANORC", nanorc)
            // Tmux uses a hardcoded tmpdir for its socket.
            put("TMUX_TMPDIR", "$home/tmp")
            // CMake needs to find its modules at the relocated prefix.
            val cmakeRoot = "$usr/share/cmake"
            if (File(cmakeRoot).isDirectory) put("CMAKE_ROOT", cmakeRoot)
            // IMPORTANT: Use ".cache/tmpdir" instead of "tmp" to avoid the
            // Termux-compiled Node.js binary's compiled-in /tmp path rewriting.
            // The Node binary intercepts getenv("TMPDIR") and rewrites any path
            // containing "/tmp" by substituting "$HOME/tmp", causing double-prefix
            // when TMPDIR is already "$HOME/tmp". Using a name without "tmp" as a
            // substring avoids triggering this rewriting entirely.
            val tmpDir = "$home/.cache/tmpdir"
            put("TMPDIR", tmpDir)
            // Claude Code uses CLAUDE_CODE_TMPDIR for its own temp files
            // (sandbox dirs, etc.). Falls back to /tmp which doesn't exist on Android.
            put("CLAUDE_CODE_TMPDIR", tmpDir)
            // BROWSER tells rclone, gh, npm, etc. how to open URLs for OAuth.
            // Points to our browser-open script that uses Android's am start.
            val browserOpen = "$home/.claude-mobile/browser-open"
            if (File(browserOpen).exists()) {
                put("BROWSER", browserOpen)
            }
        }
    }
}
