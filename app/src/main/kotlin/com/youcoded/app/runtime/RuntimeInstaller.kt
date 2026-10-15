package com.youcoded.app.runtime

import android.content.Context
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
    val files: File = context.filesDir
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
        // git runs its own subcommands as git-core/git; Claude Code is its musl build (interpreter patched).
        link(File(nativeLibDir, "libgit.so"), File(usr, "libexec/git-core/git"))
        link(File(nativeLibDir, "libclaude.so"), File(bin, "claude"))

        progress("Unpacking tools…")
        File(etc, "ssl/certs").mkdirs()
        copyAsset("runtime/ca-certificates.crt", File(etc, "ssl/certs/ca-certificates.crt"))
        File(usr, "share").mkdirs()
        untarGz(context.assets.open("runtime/share.tgz"), File(usr, "share"))

        progress("Unpacking the assistant…")
        val staging = File(files, "backend.new")
        staging.deleteRecursively()
        untarGz(context.assets.open("backend.tgz"), staging)
        // node-pty's native part is a library in the native-lib folder; Node loads it from the real path.
        val ptyDir = File(staging, "node_modules/node-pty/build/Release").apply { mkdirs() }
        File(nativeLibDir, "libptynode.so").copyTo(File(ptyDir, "pty.node"), overwrite = true)
        backend.deleteRecursively()
        if (!staging.renameTo(backend)) throw IllegalStateException("Could not move the assistant into place.")

        stampFile.writeText(stamp())
        Log.i(TAG, "runtime laid out for ${stamp()}")
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
        put("YOUCODED_USER_DATA", userData.path)
        // The backend's search tool uses the bundled rg (desktop harness/tools/grep.ts).
        put("YOUCODED_RG_PATH", File(bin, "rg").path)
        // Links Claude Code opens (sign-in) go to the app: usr/bin/xdg-open is yc-open (app/runtime/yc-open.c).
        put("BROWSER", File(bin, "xdg-open").path)
        // Claude Code ships inside the app; its self-updater would download a binary Android cannot run.
        put("DISABLE_AUTOUPDATER", "1")
        putAll(extra)
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

    companion object { private const val TAG = "RuntimeInstaller" }
}
