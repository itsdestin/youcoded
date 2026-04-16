package com.youcoded.app.runtime

import android.content.Context
import com.youcoded.app.parser.EventBridge
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import java.io.File

class PtyBridge(
    private val context: Context,
    private val bootstrap: Bootstrap,
    private val apiKey: String? = null,
    private val socketName: String = "${bootstrap.homeDir.absolutePath}/.claude-mobile/parser.sock",
    private val cwd: File = bootstrap.homeDir,
    private val dangerousMode: Boolean = false,
    val mobileSessionId: String? = null,
    private val resumeSessionId: String? = null,
    private val model: String? = null,
) {
    private var session: TerminalSession? = null
    private var eventBridge: EventBridge? = null
    val socketPath: String get() = socketName
    val homeDir: File get() = bootstrap.homeDir

    private val _outputFlow = MutableSharedFlow<String>(replay = 0, extraBufferCapacity = 1000)
    val outputFlow: SharedFlow<String> = _outputFlow

    private val _screenVersion = MutableStateFlow(0)
    val screenVersion: StateFlow<Int> = _screenVersion

    /** Timestamp of last PTY output — used by activity indicator */
    private val _lastPtyOutputTime = MutableStateFlow(0L)
    val lastPtyOutputTime: StateFlow<Long> = _lastPtyOutputTime

    private val _rawBuffer = StringBuffer()  // Thread-safe; capped to prevent OOM
    val rawBuffer: String get() = _rawBuffer.toString()
    private var lastTranscriptLength = 0
    private val RAW_BUFFER_MAX = 512 * 1024  // 512 KB rolling window

    /** Reactive signal that the session process has exited. */
    private val _sessionFinished = MutableStateFlow(false)
    val sessionFinished: StateFlow<Boolean> = _sessionFinished

    val isRunning: Boolean get() = session?.isRunning == true

    /** Set by the factory (e.g. SessionRegistry) to handle clipboard copy from terminal. */
    var onCopyToClipboard: ((String) -> Unit)? = null

    /** Set by SessionService to open URLs via Android Intent (bypasses SELinux shell issues). */
    var onOpenUrl: ((String) -> Unit)? = null

    private val sessionClient = object : TerminalSessionClient {
        override fun onTextChanged(changedSession: TerminalSession) {
            _screenVersion.value++
            _lastPtyOutputTime.value = System.currentTimeMillis()

            val transcript = changedSession.getEmulator()?.getScreen()?.getTranscriptText() ?: return
            if (transcript.length > lastTranscriptLength) {
                val delta = transcript.substring(lastTranscriptLength)
                lastTranscriptLength = transcript.length
                _rawBuffer.append(delta)
                if (_rawBuffer.length > RAW_BUFFER_MAX) {
                    _rawBuffer.delete(0, _rawBuffer.length - RAW_BUFFER_MAX)
                }
                _outputFlow.tryEmit(delta)
            } else if (transcript.length < lastTranscriptLength) {
                lastTranscriptLength = transcript.length
            }
        }

        override fun onTitleChanged(changedSession: TerminalSession) {}
        override fun onSessionFinished(finishedSession: TerminalSession) {
            _sessionFinished.value = true
        }
        override fun onCopyTextToClipboard(session: TerminalSession, text: String) {
            onCopyToClipboard?.invoke(text)
        }
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

    fun startEventBridge(scope: CoroutineScope) {
        // Stop any existing bridge to release the socket before binding a new one
        eventBridge?.stop()
        val bridge = EventBridge(socketPath)
        bridge.startServer(scope)
        eventBridge = bridge
    }

    fun start() {
        val env = bootstrap.buildRuntimeEnv().toMutableMap()
        apiKey?.let { env["ANTHROPIC_API_KEY"] = it }

        // Set socket path for hook-relay.js
        env["CLAUDE_MOBILE_SOCKET"] = socketPath
        // Set mobile session ID so hook-relay can inject it for session mapping
        mobileSessionId?.let { env["CLAUDE_MOBILE_SESSION_ID"] = it }

        val claudePath = File(bootstrap.usrDir, "lib/node_modules/@anthropic-ai/claude-code/cli.js")
        val nodePath = File(bootstrap.usrDir, "bin/node")

        // Always deploy/update helper files before launch — setup() may not run
        // on existing installations after an APK update.
        val mobileDir = File(bootstrap.homeDir, ".claude-mobile")
        mobileDir.mkdirs()
        val wrapperJs = context.assets.open("claude-wrapper.js").bufferedReader().readText()
        val wrapperPath = File(mobileDir, "claude-wrapper.js")
        wrapperPath.writeText(wrapperJs)

        // Deploy hook-relay.js and write hook config — must happen at launch
        // because setup() is skipped on already-bootstrapped installations.
        bootstrap.installHooks()

        // Deploy BASH_ENV script — shell functions routing binaries through linker64.
        // Generated by Bootstrap so DirectShellBridge can also use it.
        env["BASH_ENV"] = bootstrap.deployBashEnv()

        // Launch Claude Code through the JS wrapper, which patches child_process
        // and fs to route embedded binary exec calls through linker64.
        // The wrapper fixes Claude Code's shell detection (it requires bash/zsh
        // but can't exec them directly due to SELinux on app_data_file).
        val dangerousFlag = if (dangerousMode) " --dangerously-skip-permissions" else ""
        val resumeFlag = if (resumeSessionId != null) " --resume $resumeSessionId" else ""
        val modelFlag = if (model != null) " --model $model" else ""
        val launchCmd = "exec /system/bin/linker64 ${nodePath.absolutePath} ${wrapperPath.absolutePath} ${claudePath.absolutePath}$dangerousFlag$resumeFlag$modelFlag"

        File(bootstrap.homeDir, "tmp").mkdirs()

        val envArray = env.map { "${it.key}=${it.value}" }.toTypedArray()

        // TerminalSession passes args as argv to execvp. argv[0] must be the
        // program name ("sh"), then "-c", then the command string.
        session = TerminalSession(
            "/system/bin/sh",
            cwd.absolutePath,
            arrayOf("sh", "-c", launchCmd),
            envArray,
            2000,
            sessionClient
        )
        // initializeEmulator forks the process and starts the PTY.
        // Without this call, the session is created but nothing runs.
        // Use 80x60 so Claude Code's Ink UI renders fully — TerminalView will
        // resize to actual dimensions when attached, but this ensures the setup
        // screens (theme, auth, trust) render their full content before that.
        session?.initializeEmulator(80, 60)
    }

    fun writeInput(text: String) {
        // If input combines an escape sequence with Enter, split them so the
        // PTY doesn't deliver ESC as a standalone byte (which Ink interprets
        // as the Escape key, cancelling the menu).
        if (text.length > 2 && text.contains("\u001b[") && text.endsWith("\r")) {
            val nav = text.dropLast(1)
            session?.write(nav)
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                session?.write("\r")
            }, 80)
        } else {
            session?.write(text)
        }
    }

    /** Send approval response to Claude Code's Ink Select permission prompt.
     *  Options: 1. Yes (Enter), 2. Yes + don't ask again (↓ Enter), 3. No (Esc) */
    fun sendApproval(option: ApprovalOption) {
        when (option) {
            ApprovalOption.Yes -> writeInput("\r")
            ApprovalOption.YesAlways -> writeInput("\u001b[B\r") // down-arrow then Enter
            ApprovalOption.No -> writeInput("\u001b")
        }
    }

    enum class ApprovalOption { Yes, YesAlways, No }

    /** Check whether the current PTY screen contains an "always allow" option.
     *  Used to distinguish 2-option (Yes/No) from 3-option (Yes/Always/No) prompts. */
    /** Read current visible screen content directly from the terminal emulator. */
    fun readScreenText(): String {
        val screen = session?.emulator?.screen ?: return ""
        val rows = screen.getActiveRows()
        val cols = session?.emulator?.mColumns ?: 80
        val sb = StringBuilder(rows * cols)
        for (row in 0 until rows) {
            try {
                val internalRow = screen.externalToInternalRow(row)
                val termRow = screen.allocateFullLineIfNecessary(internalRow)
                for (col in 0 until cols) {
                    val charIndex = termRow.findStartOfColumn(col)
                    val spaceUsed = termRow.getSpaceUsed()
                    if (charIndex >= spaceUsed) { sb.append(' '); continue }
                    val ch = termRow.mText[charIndex]
                    val cp = if (Character.isHighSurrogate(ch) && charIndex + 1 < spaceUsed) {
                        val low = termRow.mText[charIndex + 1]
                        if (Character.isLowSurrogate(low)) Character.toCodePoint(ch, low) else ch.code
                    } else ch.code
                    sb.append(if (cp == 0) ' ' else String(Character.toChars(cp)))
                }
                sb.append('\n')
            } catch (_: Exception) { continue }
        }
        return sb.toString()
    }

    /** Check whether the current PTY screen contains an "always allow" option.
     *  Reads the live screen buffer to detect 3-option vs 2-option prompts. */
    fun hasAlwaysAllowOption(): Boolean {
        val screenText = readScreenText().lowercase()
        val result = "always" in screenText || "ask again" in screenText
        return result
    }

    fun sendBtw(message: String) {
        writeInput("/btw $message\r")
    }

    fun getSession(): TerminalSession? = session

    fun getEventBridge(): EventBridge? = eventBridge

    fun stop() {
        eventBridge?.stop()
        session?.finishIfRunning()
        session = null
        _rawBuffer.setLength(0)
        lastTranscriptLength = 0
        _sessionFinished.value = true
    }

    // buildBashEnvSh logic is now in Bootstrap.deployBashEnv()
    // so both PtyBridge and DirectShellBridge can use it.
}
