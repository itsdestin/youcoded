package com.destins.claudemobile.runtime

import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.io.File

/**
 * Standalone bash shell session — no Claude Code, no parser.
 * Shares the Bootstrap environment (PATH, LD_PRELOAD, etc.) so all
 * embedded binaries (git, node, etc.) are accessible.
 */
class DirectShellBridge(private val bootstrap: Bootstrap) {
    private var session: TerminalSession? = null
    private val _screenVersion = MutableStateFlow(0)
    val screenVersion: StateFlow<Int> = _screenVersion

    val isRunning: Boolean get() = session?.isRunning == true

    private val sessionClient = object : TerminalSessionClient {
        override fun onTextChanged(changedSession: TerminalSession) {
            _screenVersion.value++
        }
        override fun onTitleChanged(changedSession: TerminalSession) {}
        override fun onSessionFinished(finishedSession: TerminalSession) {}
        override fun onCopyTextToClipboard(session: TerminalSession, text: String) {}
        override fun onPasteTextFromClipboard(session: TerminalSession) {}
        override fun onBell(session: TerminalSession) {}
        override fun onColorsChanged(session: TerminalSession) {}
        override fun onTerminalCursorStateChange(state: Boolean) {}
        override fun getTerminalCursorStyle(): Int? = null
        override fun logError(tag: String?, message: String?) {}
        override fun logWarn(tag: String?, message: String?) {}
        override fun logInfo(tag: String?, message: String?) {}
        override fun logDebug(tag: String?, message: String?) {}
        override fun logVerbose(tag: String?, message: String?) {}
        override fun logStackTraceWithMessage(tag: String?, message: String?, e: Exception?) {}
        override fun logStackTrace(tag: String?, e: Exception?) {}
    }

    fun start() {
        val env = bootstrap.buildRuntimeEnv().toMutableMap()

        // Reuse the BASH_ENV linker64 wrapper script (deployed by PtyBridge)
        // so commands like git, node, etc. work in the direct shell
        val bashEnvPath = File(bootstrap.homeDir, ".claude-mobile/linker64-env.sh")
        if (bashEnvPath.exists()) {
            env["BASH_ENV"] = bashEnvPath.absolutePath
        }

        val envArray = env.map { "${it.key}=${it.value}" }.toTypedArray()
        val bashPath = File(bootstrap.usrDir, "bin/bash").absolutePath

        // Launch bash as a login shell through linker64 (SELinux bypass)
        val launchCmd = "exec /system/bin/linker64 $bashPath --login"

        session = TerminalSession(
            "/system/bin/sh",
            bootstrap.homeDir.absolutePath,
            arrayOf("sh", "-c", launchCmd),
            envArray,
            200,
            sessionClient
        )
        session?.initializeEmulator(60, 40)
    }

    fun writeInput(text: String) {
        session?.write(text)
    }

    fun getSession(): TerminalSession? = session

    fun stop() {
        session?.finishIfRunning()
        session = null
    }
}
