package com.destins.claudemobile.runtime

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.BufferedInputStream
import java.io.File
import java.io.IOException
import java.net.URL
import java.util.zip.ZipInputStream
import org.apache.commons.compress.archivers.ar.ArArchiveInputStream
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.tukaani.xz.XZInputStream

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
        data class Installing(val packageName: String) : Progress()
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

    private fun setupAptSources() {
        val etcApt = File(usrDir, "etc/apt")
        etcApt.mkdirs()
        val sourcesList = File(etcApt, "sources.list")
        sourcesList.writeText(
            "deb https://packages.termux.dev/apt/termux-main stable main\n"
        )
    }

    private val termuxRepo = "https://packages.termux.dev/apt/termux-main"

    /**
     * Download .deb packages directly from Termux repos and extract them.
     * We can't use apt because it has hardcoded /data/data/com.termux/ paths.
     */
    private fun installPackages(onProgress: (Progress) -> Unit) {
        // Node.js dependencies first
        if (!File(usrDir, "lib/libcares.so").exists()) {
            onProgress(Progress.Installing("c-ares"))
            installDeb("pool/main/c/c-ares/c-ares_1.34.6_aarch64.deb")
        }
        if (!File(usrDir, "lib/libicuuc.so.78").exists()) {
            onProgress(Progress.Installing("libicu"))
            installDeb("pool/main/libi/libicu/libicu_78.2_aarch64.deb")
        }
        if (!File(usrDir, "lib/libsqlite3.so").exists()) {
            onProgress(Progress.Installing("libsqlite"))
            installDeb("pool/main/libs/libsqlite/libsqlite_3.52.0-1_aarch64.deb")
        }

        // Node.js is required for Claude Code and the parser
        if (!File(usrDir, "bin/node").exists()) {
            onProgress(Progress.Installing("nodejs"))
            installDeb("pool/main/n/nodejs/nodejs_25.8.1_aarch64.deb")
        }

        // npm is needed to install Claude Code
        if (!File(usrDir, "lib/node_modules/npm").exists()) {
            onProgress(Progress.Installing("npm"))
            installDeb("pool/main/n/npm/npm_11.11.1_all.deb")
        }

        // termux-exec: LD_PRELOAD library that intercepts execve() calls and routes
        // embedded binaries through /system/bin/linker64 (bypasses SELinux).
        // Required for Claude Code's Bash tool to spawn shell subprocesses.
        if (!File(usrDir, "lib/libtermux-exec-linker-ld-preload.so").exists()) {
            onProgress(Progress.Installing("termux-exec"))
            installDeb("pool/main/t/termux-exec/termux-exec_1:2.4.0-1_aarch64.deb")
        }
        // The postinst script normally runs `termux-exec-ld-preload-lib setup` to
        // create the primary .so, but that requires a working shell. Instead, copy
        // the linker variant directly (needed for Android 15+ SELinux restrictions).
        val linkerSo = File(usrDir, "lib/libtermux-exec-linker-ld-preload.so")
        val primarySo = File(usrDir, "lib/libtermux-exec-ld-preload.so")
        if (linkerSo.exists() && !primarySo.exists()) {
            linkerSo.inputStream().use { input ->
                primarySo.outputStream().use { output -> input.copyTo(output) }
            }
            primarySo.setExecutable(true)
        }

        // Git is deferred to on-demand installation via installGit().
        // Claude Code runs without git for journaling/inbox use cases.
    }

    /**
     * Install git and its runtime dependencies on demand.
     * Git is not included in the initial bootstrap to keep first-run setup fast.
     * Call this before any operation that requires git (repo clone, commit, etc.).
     *
     * Dependencies are installed in order: shared libraries first, then git itself.
     * Each package is skipped if its sentinel file already exists (idempotent).
     */
    suspend fun installGit(onProgress: (Progress) -> Unit) = withContext(Dispatchers.IO) {
        try {
            if (!File(usrDir, "lib/libssl.so").exists()) {
                onProgress(Progress.Installing("openssl"))
                // TODO: Resolve exact .deb path from https://packages.termux.dev/apt/termux-main/
                //       e.g. pool/main/o/openssl/openssl_3.x.x_aarch64.deb
                installDeb("pool/main/o/openssl/openssl_3.5.0_aarch64.deb")
            }
            if (!File(usrDir, "lib/libcurl.so").exists()) {
                onProgress(Progress.Installing("libcurl"))
                // TODO: Resolve exact .deb path from https://packages.termux.dev/apt/termux-main/
                //       e.g. pool/main/c/curl/libcurl_8.x.x_aarch64.deb
                installDeb("pool/main/c/curl/libcurl_8.13.0_aarch64.deb")
            }
            if (!File(usrDir, "lib/libexpat.so").exists()) {
                onProgress(Progress.Installing("libexpat"))
                // TODO: Resolve exact .deb path from https://packages.termux.dev/apt/termux-main/
                //       e.g. pool/main/e/expat/libexpat_2.x.x_aarch64.deb
                installDeb("pool/main/e/expat/libexpat_2.7.1_aarch64.deb")
            }
            if (!File(usrDir, "lib/libiconv.so").exists()) {
                onProgress(Progress.Installing("libiconv"))
                // TODO: Resolve exact .deb path from https://packages.termux.dev/apt/termux-main/
                //       e.g. pool/main/libi/libiconv/libiconv_1.x.x_aarch64.deb
                installDeb("pool/main/libi/libiconv/libiconv_1.18_aarch64.deb")
            }
            if (!File(usrDir, "lib/libpcre2-8.so").exists()) {
                onProgress(Progress.Installing("pcre2"))
                // TODO: Resolve exact .deb path from https://packages.termux.dev/apt/termux-main/
                //       e.g. pool/main/p/pcre2/libpcre2_10.x.x_aarch64.deb
                installDeb("pool/main/p/pcre2/libpcre2_10.45_aarch64.deb")
            }
            if (!File(usrDir, "lib/libz.so").exists()) {
                onProgress(Progress.Installing("zlib"))
                // TODO: Resolve exact .deb path from https://packages.termux.dev/apt/termux-main/
                //       e.g. pool/main/z/zlib/zlib_1.x.x_aarch64.deb
                installDeb("pool/main/z/zlib/zlib_1.3.1_aarch64.deb")
            }
            if (!File(usrDir, "bin/git").exists()) {
                onProgress(Progress.Installing("git"))
                // TODO: Resolve exact .deb path from https://packages.termux.dev/apt/termux-main/
                //       e.g. pool/main/g/git/git_2.x.x_aarch64.deb
                installDeb("pool/main/g/git/git_2.49.0_aarch64.deb")
            }
            onProgress(Progress.Complete)
        } catch (e: Exception) {
            onProgress(Progress.Error(e.message ?: "Unknown error during git installation"))
        }
    }

    /**
     * Download a .deb from Termux repos and extract it using pure Java.
     * No shelling out — avoids all SELinux exec restrictions.
     *
     * A .deb is an ar archive containing:
     *   - debian-binary (version string)
     *   - control.tar.xz (package metadata)
     *   - data.tar.xz (actual files to install)
     *
     * We parse the ar format, find data.tar.xz, decompress with XZ,
     * then extract the tar entries directly into usrDir.
     */
    private fun installDeb(debPath: String) {
        val url = "$termuxRepo/$debPath"
        val tmpDeb = File(context.cacheDir, "tmp.deb")
        try {
            // Download .deb
            URL(url).openStream().use { input ->
                tmpDeb.outputStream().use { output -> input.copyTo(output) }
            }

            // Parse the ar archive to find data.tar.xz
            ArArchiveInputStream(BufferedInputStream(tmpDeb.inputStream())).use { arStream ->
                var arEntry = arStream.nextEntry
                while (arEntry != null) {
                    if (arEntry.name.startsWith("data.tar")) {
                        // Decompress XZ and extract tar
                        val tarStream = TarArchiveInputStream(XZInputStream(arStream))
                        var tarEntry = tarStream.nextEntry
                        while (tarEntry != null) {
                            // Strip Termux prefix from tar paths.
                            // Entries may be "./bin/node" or "data/data/com.termux/files/usr/bin/node"
                            val termuxPrefix = "data/data/com.termux/files/usr/"
                            var entryPath = tarEntry.name.removePrefix("./").removePrefix("/")
                            if (entryPath.startsWith(termuxPrefix)) {
                                entryPath = entryPath.removePrefix(termuxPrefix)
                            }
                            // Also handle absolute paths
                            val absPrefix = "/data/data/com.termux/files/usr/"
                            if (tarEntry.name.startsWith(absPrefix)) {
                                entryPath = tarEntry.name.removePrefix(absPrefix)
                            }
                            if (entryPath.isEmpty()) {
                                tarEntry = tarStream.nextEntry
                                continue
                            }
                            val target = File(usrDir, entryPath)

                            if (tarEntry.isDirectory) {
                                target.mkdirs()
                            } else if (tarEntry.isSymbolicLink) {
                                // Create symlink
                                target.parentFile?.mkdirs()
                                try {
                                    java.nio.file.Files.createSymbolicLink(
                                        target.toPath(),
                                        java.nio.file.Paths.get(tarEntry.linkName)
                                    )
                                } catch (_: Exception) {
                                    // Symlinks may fail on some Android versions; non-fatal
                                }
                            } else {
                                target.parentFile?.mkdirs()
                                target.outputStream().use { out ->
                                    tarStream.copyTo(out)
                                }
                                target.setExecutable(true)
                            }
                            tarEntry = tarStream.nextEntry
                        }
                        break // Done with data.tar
                    }
                    arEntry = arStream.nextEntry
                }
            }
        } finally {
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
        val output = process.inputStream.bufferedReader().readText()
        val exitCode = process.waitFor()
        if (exitCode != 0) {
            throw IOException("npm install claude-code failed (exit $exitCode): $output")
        }
    }

    private fun setupHome() {
        homeDir.mkdirs()
        File(homeDir, ".claude").mkdirs()
        File(homeDir, "tmp").mkdirs()

        // Deploy the Node.js wrapper that patches child_process/fs to route
        // embedded binary execution through linker64. This is the primary fix
        // for Claude Code's "No suitable shell found" error — it intercepts
        // shell validation (fs.accessSync X_OK) and spawn calls at the JS level.
        val mobileDir = File(homeDir, ".claude-mobile")
        mobileDir.mkdirs()
        val wrapperFile = File(mobileDir, "claude-wrapper.js")
        context.assets.open("claude-wrapper.js").use { input ->
            wrapperFile.outputStream().use { output -> input.copyTo(output) }
        }
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
        val output = process.inputStream.bufferedReader().readText()
        val exitCode = process.waitFor()
        if (exitCode != 0) {
            throw IOException("${command[0]} failed (exit $exitCode): $output")
        }
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
            put("PATH", "$usr/bin:$usr/bin/applets:/system/bin")
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
            put("TMPDIR", "$home/tmp")
            // Claude Code uses CLAUDE_CODE_TMPDIR for its own temp files
            // (sandbox dirs, etc.). Falls back to /tmp which doesn't exist on Android.
            put("CLAUDE_CODE_TMPDIR", "$home/tmp")
        }
    }
}
