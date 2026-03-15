package com.destins.claudemobile.runtime

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.util.zip.ZipInputStream

class Bootstrap(private val context: Context) {

    val usrDir: File get() = File(context.filesDir, "usr")
    val homeDir: File get() = File(context.filesDir, "home")
    val isBootstrapped: Boolean get() = File(usrDir, "bin/bash").exists()

    sealed class Progress {
        data class Extracting(val percent: Int) : Progress()
        data class Installing(val packageName: String) : Progress()
        data class Error(val message: String) : Progress()
        data object Complete : Progress()
    }

    suspend fun setup(onProgress: (Progress) -> Unit) = withContext(Dispatchers.IO) {
        try {
            if (!isBootstrapped) {
                extractBootstrap(onProgress)
            }
            installPackages(onProgress)
            installClaudeCode(onProgress)
            setupHome()
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
        while (entry != null) {
            count++
            if (count % 100 == 0) {
                onProgress(Progress.Extracting((count * 100) / 5000))
            }
            val target = File(usrDir, entry.name)
            if (entry.isDirectory) {
                target.mkdirs()
            } else {
                target.parentFile?.mkdirs()
                target.outputStream().use { out -> zip.copyTo(out) }
                if (entry.name.contains("/bin/") || entry.name.endsWith(".so")) {
                    target.setExecutable(true)
                }
            }
            zip.closeEntry()
            entry = zip.nextEntry
        }
        zip.close()
        onProgress(Progress.Extracting(100))
    }

    private fun installPackages(onProgress: (Progress) -> Unit) {
        val packages = listOf("nodejs", "git", "rclone")
        for (pkg in packages) {
            onProgress(Progress.Installing(pkg))
            executeInRuntime("apt", "install", "-y", pkg)
        }
    }

    private fun installClaudeCode(onProgress: (Progress) -> Unit) {
        onProgress(Progress.Installing("claude-code"))
        executeInRuntime("npm", "install", "-g", "@anthropic-ai/claude-code")
    }

    private fun setupHome() {
        homeDir.mkdirs()
        File(homeDir, ".claude").mkdirs()
    }

    private fun executeInRuntime(vararg command: String) {
        val env = buildRuntimeEnv()
        val pb = ProcessBuilder(listOf(File(usrDir, "bin/${command[0]}").absolutePath) + command.drop(1))
            .directory(homeDir)
            .redirectErrorStream(true)
        pb.environment().putAll(env)
        val process = pb.start()
        // Drain stdout concurrently to prevent pipe buffer deadlock
        val output = process.inputStream.bufferedReader().readText()
        val exitCode = process.waitFor()
        if (exitCode != 0) {
            throw IOException("${command[0]} failed (exit $exitCode): $output")
        }
    }

    fun buildRuntimeEnv(): Map<String, String> = mapOf(
        "HOME" to homeDir.absolutePath,
        "PREFIX" to usrDir.absolutePath,
        "PATH" to "${usrDir.absolutePath}/bin:${usrDir.absolutePath}/bin/applets",
        "LD_LIBRARY_PATH" to "${usrDir.absolutePath}/lib",
        "LANG" to "en_US.UTF-8",
        "TERM" to "xterm-256color",
    )
}
