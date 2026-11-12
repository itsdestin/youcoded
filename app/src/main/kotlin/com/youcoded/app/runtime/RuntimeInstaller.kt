package com.youcoded.app.runtime

import android.content.Context
import android.os.Build
import android.provider.Settings
import android.util.Log
import java.io.File
import java.io.InputStream
import java.util.zip.GZIPInputStream
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream

/**
 * Lays out the bundled programs and the backend under the app's files folder, once per app version.
 *
 * WHY (2026-10-14, Android clean rebuild): Android only lets an app execute files it unpacked into its
 * native-library folder (the jniLibs built by app/runtime/build-runtime.sh, named lib<name>.so). Every
 * program's interpreter and library path were rewritten at build time to point into
 * files/usr/lib, so this fills files/usr with symlinks into the native-library folder under the names the
 * programs expect (node, bash, libssl.so.3, ld-musl-aarch64.so.1 …). The native-library folder's path
 * changes on every app update, so the links are rebuilt whenever it or the app version changes.
 *
 * Layout (files = context.filesDir):
 *   usr/bin/<name>             → <nativeLibraryDir>/lib<name>.so   (on PATH)
 *   usr/lib/<soname>           → <nativeLibraryDir>/lib_<x>.so     (the programs' RUNPATH)
 *   usr/libexec/git-core/…     → git's helpers
 *   usr/share/{terminfo,git-core}, usr/etc/ssl/certs/ca-certificates.crt, usr/etc/resolv.conf
 *   backend/                    the desktop backend (dist/, node_modules/, hook-scripts/…)
 *   home/                       HOME (Claude Code's ~/.claude, conversations, projects)
 *   userdata/                   the backend's Electron-style userData
 */
class RuntimeInstaller(private val context: Context) {
    // WHY canonical (2026-10-15): Android names this folder twice (/data/user/0/<pkg> and /data/data/<pkg>, one
    // a link to the other). Programs see the kernel's name (/data/data, what Claude Code records in file paths and
    // project slugs); filesDir gives the other. Two spellings of one folder made the backend call files inside
    // the home folder "outside the project". Every path we hand out uses the resolved one.
    val files: File = context.filesDir.canonicalFile
    val usr = File(files, "usr")
    val bin = File(usr, "bin")
    val lib = File(usr, "lib")
    val etc = File(usr, "etc")
    val home = File(files, "home")
    val tmp = File(files, "tmp")
    val userData = File(files, "userdata")
    val backend = File(files, "backend")
    val nativeLibDir: String = context.applicationInfo.nativeLibraryDir

    private val stampFile = File(files, ".runtime-stamp")

    /** What this install was laid out for: the app build and where Android put its native libraries. */
    private fun stamp(): String {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        return "${info.longVersionCode}|${info.lastUpdateTime}|$nativeLibDir"
    }

    /** True when files/ already matches this build (the common, instant case). */
    fun isCurrent(): Boolean = stampFile.isFile && stampFile.readText() == stamp() && File(backend, "dist/main/headless/headless-main.js").isFile

    /** Lay everything out. Safe to repeat: each step replaces what it owns. [progress] gets plain sentences. */
    fun install(progress: (String) -> Unit) {
        val startedAt = System.currentTimeMillis() // logged at the end: how long an update keeps the user on this screen
        progress("Setting up YouCoded…")
        listOf(bin, lib, File(usr, "libexec/git-core"), etc, home, tmp, userData).forEach { it.mkdirs() }

        // Libraries and the loader: usr/lib/<soname> → native-lib folder.
        clearDir(lib)
        readAsset("runtime/libmap.txt").lineSequence().filter { it.isNotBlank() }.forEach { line ->
            val (so, soname) = line.trim().split(' ', limit = 2)
            link(File(nativeLibDir, so), File(lib, soname))
        }
        // Executables: usr/bin/<name> (and git's helper in libexec).
        clearDir(bin)
        readAsset("runtime/binmap.txt").lineSequence().filter { it.isNotBlank() }.forEach { line ->
            val (so, rel) = line.trim().split(' ', limit = 2)
            val target = File(nativeLibDir, so)
            if (rel.contains("libexec/git-core/")) link(target, File(usr, "libexec/git-core/" + rel.substringAfterLast('/')))
            else link(target, File(bin, rel.substringAfterLast('/')))
        }
        // git runs its own subcommands as git-core/git. (usr/bin/claude is the launcher, from binmap.)
        link(File(nativeLibDir, "libgit.so"), File(usr, "libexec/git-core/git"))

        progress("Unpacking tools…")
        File(etc, "ssl/certs").mkdirs()
        copyAsset("runtime/ca-certificates.crt", File(etc, "ssl/certs/ca-certificates.crt"))
        // WHY (2026-11-09 final review): unpacking used to add to whatever an older version left here. After an
        // update that changed the ICU version there were two icu/<version> folders, none was chosen, and the
        // assistant crashed at startup again. Everything in share comes from share.tgz, so start it empty.
        clearDir(File(usr, "share"))
        untarGz(context.assets.open("runtime/share.tgz"), File(usr, "share"))

        val staging = File(files, "backend.new")
        installBackend(staging, progress)
        // node-pty's native part is a library in the native-lib folder; Node loads it from the real path.
        val ptyDir = File(staging, "node_modules/node-pty/build/Release").apply { mkdirs() }
        File(nativeLibDir, "libptynode.so").copyTo(File(ptyDir, "pty.node"), overwrite = true)
        backend.deleteRecursively()
        if (!staging.renameTo(backend)) throw IllegalStateException("Could not move the assistant into place.")

        stampFile.writeText(stamp())
        Log.i(TAG, "runtime laid out in ${System.currentTimeMillis() - startedAt} ms for ${stamp()}")
    }

    /** The environment every backend process (and everything it starts) runs with. */
    fun environment(extra: Map<String, String>): Map<String, String> = buildMap {
        val path = "${bin.path}:/system/bin"
        put("PATH", path)
        put("HOME", home.path)
        put("TMPDIR", tmp.path)
        put("SHELL", File(bin, "bash").path)
        put("LANG", "C.UTF-8")
        put("TERM", "xterm-256color")
        put("TERMINFO", File(usr, "share/terminfo").path)
        // musl's resolver (patch-musl.py) and the shim's /etc redirection read these.
        put("YOUCODED_ETC", etc.path)
        put("SSL_CERT_FILE", File(etc, "ssl/certs/ca-certificates.crt").path)
        put("GIT_SSL_CAINFO", File(etc, "ssl/certs/ca-certificates.crt").path)
        put("GIT_EXEC_PATH", File(usr, "libexec/git-core").path)
        put("GIT_TEMPLATE_DIR", File(usr, "share/git-core/templates").path)
        // WHY: Alpine's Node carries only a stub ICU; its real data file (usr/share/icu/<version>/icudt<version>l.dat,
        // packed by build-runtime.sh) must be pointed at, or toLocaleString() throws "Icu error" and the
        // backend dies at boot. The version folder is found at runtime so an Alpine upgrade needs no code change.
        newestIcuDir(File(usr, "share/icu"))?.let { put("NODE_ICU_DATA", it.path) }
        put("YOUCODED_USER_DATA", userData.path)
        // WHY: the bundled Linux's hostname is always "localhost", so the phone listed itself as
        // "localhost" in Backup & sync's device list. Hand the backend the phone's own name (the one
        // set in the phone's settings, else its model, e.g. "Galaxy Z Flip7"; device-registry.ts).
        put("YOUCODED_DEVICE_NAME", phoneName())
        // The backend's search tool uses the bundled rg (desktop harness/tools/grep.ts).
        put("YOUCODED_RG_PATH", File(bin, "rg").path)
        // Links Claude Code opens (sign-in) go to the app: usr/bin/xdg-open is yc-open (app/runtime/yc-open.c).
        put("BROWSER", File(bin, "xdg-open").path)
        // Claude Code ships inside the app; its self-updater would download a binary Android cannot run.
        put("DISABLE_AUTOUPDATER", "1")
        putAll(extra)
    }

    /** The name the person gave this phone (Settings → About phone), else maker and model. */
    private fun phoneName(): String {
        val set = runCatching { Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull()
        if (!set.isNullOrBlank()) return set.trim()
        val model = Build.MODEL.orEmpty()
        val maker = Build.MANUFACTURER.orEmpty().replaceFirstChar { it.uppercase() }
        return if (model.startsWith(maker, ignoreCase = true) || maker.isBlank()) model.ifBlank { "Android phone" } else "$maker $model"
    }

    private fun clearDir(dir: File) { dir.listFiles()?.forEach { it.deleteRecursively() }; dir.mkdirs() }

    private fun link(target: File, at: File) {
        at.parentFile?.mkdirs()
        at.delete()
        android.system.Os.symlink(target.path, at.path)
    }

    private fun readAsset(name: String): String = context.assets.open(name).use { it.readBytes().toString(Charsets.UTF_8) }

    private fun copyAsset(name: String, to: File) {
        to.parentFile?.mkdirs()
        context.assets.open(name).use { input -> to.outputStream().use { input.copyTo(it) } }
    }

    /**
     * Unpack backend.tgz into [staging]. WHY (2026-11-01 phone test: "Unpacking…" took ~11 s after every update): ~15,400 of
     * its ~17,000 files are third-party code (node_modules + legal) that only changes with the dependencies. The archive
     * starts with ./.deps-stamp, a fingerprint of that part, and ends with it (build-backend.sh). When the fingerprint matches
     * the copy already on the phone, that copy is moved over as it is and reading stops at the first dependency entry, so an
     * ordinary update writes only the app's own files. Anything else (first install, changed dependencies, a missing or
     * damaged copy) unpacks everything, as before. Moves are renames inside files/, so they are instant.
     */
    private fun installBackend(staging: File, progress: (String) -> Unit) {
        staging.deleteRecursively()
        staging.mkdirs()
        val root = staging.canonicalPath + File.separator
        val keptStamp = File(backend, "node_modules/$DEPS_STAMP_FILE").takeIf { it.isFile }?.readText()?.trim()
        TarArchiveInputStream(GZIPInputStream(context.assets.open("backend.tgz").buffered(1 shl 16), 1 shl 16)).use { tar ->
            var entry = tar.nextEntry
            val stamp = if (entry != null && entry.name.removePrefix("./") == ".deps-stamp") tar.readBytes().toString(Charsets.UTF_8).trim() else null
            val reuse = stamp != null && stamp == keptStamp && File(backend, "node_modules").isDirectory && File(backend, "legal").isDirectory
            progress(if (reuse) "Updating the assistant…" else "Unpacking the assistant…")
            if (reuse) {
                // The old copy moves into the new layout before anything is written; a crash now just means a full unpack next time.
                if (!File(backend, "node_modules").renameTo(File(staging, "node_modules")) || !File(backend, "legal").renameTo(File(staging, "legal"))) {
                    throw IllegalStateException("Could not keep the assistant's existing files.")
                }
            }
            if (stamp != null) entry = tar.nextEntry
            while (entry != null) {
                val name = entry.name.removePrefix("./")
                val isDeps = name == "node_modules" || name == "legal" || name.startsWith("node_modules/") || name.startsWith("legal/")
                // The dependencies come last in the archive, so with a kept copy there is nothing more to read.
                if (reuse && isDeps) break
                extractEntry(tar, entry, File(staging, name), root, staging)
                entry = tar.nextEntry
            }
            // Written only after a full unpack of the dependencies, so a half-written copy is never trusted.
            if (!reuse && stamp != null) File(staging, "node_modules/$DEPS_STAMP_FILE").writeText(stamp)
        }
    }

    private fun extractEntry(tar: TarArchiveInputStream, entry: org.apache.commons.compress.archivers.tar.TarArchiveEntry, out: File, root: String, dest: File) {
        if (!out.canonicalPath.startsWith(root) && out.canonicalPath != dest.canonicalPath) return
        when {
            entry.isDirectory -> out.mkdirs()
            entry.isSymbolicLink -> { out.parentFile?.mkdirs(); out.delete(); android.system.Os.symlink(entry.linkName, out.path) }
            else -> {
                out.parentFile?.mkdirs()
                out.outputStream().buffered(1 shl 16).use { tar.copyTo(it, 1 shl 16) }
                if (entry.mode and 0b001_001_001 != 0) out.setExecutable(true, false)
            }
        }
    }

    /** Extract a .tar.gz, keeping symlinks and the executable bit; refuses entries that escape [dest]. */
    private fun untarGz(input: InputStream, dest: File) {
        dest.mkdirs()
        val root = dest.canonicalPath + File.separator
        TarArchiveInputStream(GZIPInputStream(input.buffered())).use { tar ->
            while (true) {
                val entry = tar.nextEntry ?: break
                val out = File(dest, entry.name)
                if (!out.canonicalPath.startsWith(root) && out.canonicalPath != dest.canonicalPath) continue
                when {
                    entry.isDirectory -> out.mkdirs()
                    entry.isSymbolicLink -> { out.parentFile?.mkdirs(); out.delete(); android.system.Os.symlink(entry.linkName, out.path) }
                    else -> {
                        out.parentFile?.mkdirs()
                        out.outputStream().use { tar.copyTo(it) }
                        if (entry.mode and 0b001_001_001 != 0) out.setExecutable(true, false)
                    }
                }
            }
        }
    }

    companion object {
        /**
         * The icu/<version> folder to point Node at: the highest version that really holds a data file.
         * WHY (2026-11-09 final review): this used to demand exactly one folder and set nothing otherwise, so a
         * leftover folder from an older version brought the startup crash back. install() now clears leftovers;
         * this is the second guard, and it also ignores an empty folder.
         */
        fun newestIcuDir(icu: File): File? =
            icu.listFiles { f -> f.isDirectory && f.listFiles { d -> d.name.startsWith("icudt") && d.name.endsWith(".dat") }?.isNotEmpty() == true }
                ?.maxWithOrNull(compareBy<File>({ versionKey(it.name).getOrElse(0) { 0 } }, { versionKey(it.name).getOrElse(1) { 0 } }, { versionKey(it.name).getOrElse(2) { 0 } }, { it.name }))

        private fun versionKey(name: String): List<Int> = name.split('.').map { it.toIntOrNull() ?: 0 }

        private const val TAG = "RuntimeInstaller"
        /** Inside the unpacked node_modules: the fingerprint of the dependencies it holds (see installBackend). */
        private const val DEPS_STAMP_FILE = ".youcoded-deps-stamp"
    }
}
