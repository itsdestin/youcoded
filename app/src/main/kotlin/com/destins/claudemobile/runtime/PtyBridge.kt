package com.destins.claudemobile.runtime

import android.content.Context
import com.destins.claudemobile.parser.EventBridge
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import java.io.File

class PtyBridge(
    private val bootstrap: Bootstrap,
    private val apiKey: String? = null,
) {
    private var session: TerminalSession? = null
    private var parserProcess: Process? = null
    private var eventBridge: EventBridge? = null
    val socketPath: String get() = "${bootstrap.homeDir.absolutePath}/.claude-mobile/parser.sock"

    private val _outputFlow = MutableSharedFlow<String>(replay = 0, extraBufferCapacity = 1000)
    val outputFlow: SharedFlow<String> = _outputFlow

    // Incremented on every onTextChanged — observed by TerminalPanel to trigger recomposition
    private val _screenVersion = kotlinx.coroutines.flow.MutableStateFlow(0)
    val screenVersion: kotlinx.coroutines.flow.StateFlow<Int> = _screenVersion
    private val _rawBuffer = StringBuilder()
    val rawBuffer: String get() = _rawBuffer.toString()
    private var lastTranscriptLength = 0

    private val accumulatorBuffer = StringBuilder()
    private var accumulatorJob: Job? = null
    private var lastOutputTime = 0L
    private var socketConnected = false
    private val accumulatorScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    val isRunning: Boolean get() = session?.isRunning == true

    private val sessionClient = object : TerminalSessionClient {
        override fun onTextChanged(changedSession: TerminalSession) {
            // Always trigger terminal panel redraw — ink-based menus use cursor
            // movement to redraw in-place, which can SHRINK the transcript.
            // The panel reads the screen buffer directly, so it just needs to
            // know WHEN to redraw, not what changed.
            _screenVersion.value++

            val transcript = changedSession.getEmulator()?.getScreen()?.getTranscriptText() ?: return
            if (transcript.length > lastTranscriptLength) {
                val delta = transcript.substring(lastTranscriptLength)
                lastTranscriptLength = transcript.length
                _rawBuffer.append(delta)
                _outputFlow.tryEmit(delta)
                onPtyOutput(delta)
            } else if (transcript.length < lastTranscriptLength) {
                // Transcript shrank (ink redrew the screen). Re-emit the
                // current screen content so the parser can detect new menus.
                lastTranscriptLength = transcript.length
                _outputFlow.tryEmit(transcript)
                onPtyOutput(transcript)
            }
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
        // Only set API key if provided; otherwise Claude Code handles its own OAuth auth
        apiKey?.let { env["ANTHROPIC_API_KEY"] = it }

        val claudePath = File(bootstrap.usrDir, "lib/node_modules/@anthropic-ai/claude-code/cli.js")
        val nodePath = File(bootstrap.usrDir, "bin/node")

        // TerminalSession calls execvp(shellPath, args) where args[0] is typically
        // the program name. To launch Claude Code via linker64, we use sh -c with
        // the full command inline.
        val usrPath = bootstrap.usrDir.absolutePath
        val homePath = bootstrap.homeDir.absolutePath
        val launchCmd = "exec /system/bin/linker64 ${nodePath.absolutePath} ${claudePath.absolutePath}"

        // Add all env vars needed for the runtime
        env["OPENSSL_CONF"] = "$usrPath/etc/tls/openssl.cnf"
        env["SSL_CERT_FILE"] = "$usrPath/etc/tls/cert.pem"
        env["SSL_CERT_DIR"] = "$usrPath/etc/tls/certs"
        env["TMPDIR"] = "$homePath/tmp"
        File(bootstrap.homeDir, "tmp").mkdirs()

        val envArray = env.map { "${it.key}=${it.value}" }.toTypedArray()

        // TerminalSession passes args as argv to execvp. argv[0] must be the
        // program name ("sh"), then "-c", then the command string.
        session = TerminalSession(
            "/system/bin/sh",
            bootstrap.homeDir.absolutePath,
            arrayOf("sh", "-c", launchCmd),
            envArray,
            200,
            sessionClient
        )
        // initializeEmulator forks the process and starts the PTY.
        // Without this call, the session is created but nothing runs.
        session?.initializeEmulator(60, 40)
    }

    fun writeInput(text: String) {
        android.util.Log.d("PtyBridge", "writeInput: ${text.map { if (it.code < 32) "\\x${it.code.toString(16)}" else it.toString() }.joinToString("")}")
        session?.write(text)
    }

    fun sendApproval(accepted: Boolean) {
        writeInput(if (accepted) "y\n" else "n\n")
    }

    fun sendBtw(message: String) {
        writeInput("/btw $message\n")
    }

    fun startParser(scope: CoroutineScope, context: Context) {
        val parserDir = File(bootstrap.homeDir, ".claude-mobile")
        parserDir.mkdirs()

        val parserJs = File(parserDir, "parser.js")
        if (!parserJs.exists()) {
            for (fileName in listOf("parser.js", "patterns.js", "package.json")) {
                context.assets.open("parser/$fileName").use { input ->
                    File(parserDir, fileName).outputStream().use { output -> input.copyTo(output) }
                }
            }
        }

        val env = bootstrap.buildRuntimeEnv().toMutableMap()
        env["PARSER_SOCKET"] = socketPath

        val nodePath = File(bootstrap.usrDir, "bin/node")
        // Use linker64 to bypass SELinux exec restrictions on app_data_file binaries
        parserProcess = ProcessBuilder(
            "/system/bin/linker64", nodePath.absolutePath,
            parserJs.absolutePath
        )
            .directory(parserDir)
            .apply { environment().putAll(env) }
            .redirectErrorStream(true)
            .start()

        val bridge = EventBridge(socketPath)
        bridge.onConnected = { onSocketConnected() }
        bridge.connect(scope)
        eventBridge = bridge
    }

    fun getSession(): TerminalSession? = session

    fun getEventBridge(): EventBridge? = eventBridge

    private val approvalPattern = Regex("""Do you want to proceed\?|Approve\?|y/n|yes/no""", RegexOption.IGNORE_CASE)

    fun onPtyOutput(delta: String) {
        val hasApprovalMatch: Boolean
        synchronized(accumulatorBuffer) {
            accumulatorBuffer.append(delta)
            hasApprovalMatch = approvalPattern.containsMatchIn(accumulatorBuffer)
        }

        if (hasApprovalMatch) {
            accumulatorJob?.cancel()
            accumulatorJob = null
            flushAccumulator()
        } else {
            accumulatorJob?.cancel()
            accumulatorJob = accumulatorScope.launch {
                delay(100)
                flushAccumulator()
            }
        }
        lastOutputTime = System.currentTimeMillis()
    }

    fun flushAccumulator() {
        val chunk: String
        synchronized(accumulatorBuffer) {
            chunk = accumulatorBuffer.toString()
            accumulatorBuffer.clear()
        }
        if (socketConnected && chunk.isNotEmpty()) {
            eventBridge?.sendPtyOutput(chunk)
        }
    }

    fun onSocketConnected() {
        socketConnected = true
        flushAccumulator()
    }

    fun stop() {
        accumulatorScope.cancel()
        eventBridge?.disconnect()
        parserProcess?.destroyForcibly()
        session?.finishIfRunning()
        session = null
    }
}
