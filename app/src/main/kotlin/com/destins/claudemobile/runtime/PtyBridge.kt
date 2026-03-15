package com.destins.claudemobile.runtime

import android.content.Context
import com.destins.claudemobile.parser.EventBridge
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import java.io.File

class PtyBridge(
    private val bootstrap: Bootstrap,
    private val apiKey: String,
) {
    private var session: TerminalSession? = null
    private var parserProcess: Process? = null
    private var eventBridge: EventBridge? = null
    val socketPath: String get() = "${bootstrap.homeDir.absolutePath}/.claude-mobile/parser.sock"

    private val _outputFlow = MutableSharedFlow<String>(replay = 0, extraBufferCapacity = 1000)
    val outputFlow: SharedFlow<String> = _outputFlow
    private val _rawBuffer = StringBuilder()
    val rawBuffer: String get() = _rawBuffer.toString()
    private var lastTranscriptLength = 0

    val isRunning: Boolean get() = session?.isRunning == true

    private val sessionClient = object : TerminalSessionClient {
        override fun onTextChanged(changedSession: TerminalSession) {
            val transcript = changedSession.getEmulator()?.getScreen()?.getTranscriptText() ?: return
            if (transcript.length > lastTranscriptLength) {
                val delta = transcript.substring(lastTranscriptLength)
                lastTranscriptLength = transcript.length
                _rawBuffer.append(delta)
                _outputFlow.tryEmit(delta)
                eventBridge?.sendPtyOutput(delta)
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
        env["ANTHROPIC_API_KEY"] = apiKey

        val claudePath = File(bootstrap.usrDir, "lib/node_modules/@anthropic-ai/claude-code/cli.js")
        val nodePath = File(bootstrap.usrDir, "bin/node")

        val envArray = env.map { "${it.key}=${it.value}" }.toTypedArray()

        session = TerminalSession(
            nodePath.absolutePath,
            bootstrap.homeDir.absolutePath,
            arrayOf(claudePath.absolutePath),
            envArray,
            200,
            sessionClient
        )
    }

    fun writeInput(text: String) {
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
        parserProcess = ProcessBuilder(
            nodePath.absolutePath,
            parserJs.absolutePath
        )
            .directory(parserDir)
            .apply { environment().putAll(env) }
            .redirectErrorStream(true)
            .start()

        val bridge = EventBridge(socketPath)
        bridge.connect(scope)
        eventBridge = bridge
    }

    fun getEventBridge(): EventBridge? = eventBridge

    fun stop() {
        eventBridge?.disconnect()
        parserProcess?.destroyForcibly()
        session?.finishIfRunning()
        session = null
    }
}
