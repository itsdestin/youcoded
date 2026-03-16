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
                // Transcript shrank (ink redrew). Reset tracking.
                lastTranscriptLength = transcript.length
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

        // Always deploy/update helper files before launch — setup() may not run
        // on existing installations after an APK update.
        val mobileDir = File(bootstrap.homeDir, ".claude-mobile")
        mobileDir.mkdirs()
        val wrapperPath = File(mobileDir, "claude-wrapper.js")
        wrapperPath.writeText(WRAPPER_JS)

        // Deploy BASH_ENV script that creates shell functions for all embedded
        // binaries, routing them through linker64. This fixes "Permission denied"
        // errors when bash tries to exec binaries in app_data_file (SELinux blocks
        // direct exec, but shell functions run in-process — no exec needed).
        val bashEnvPath = File(mobileDir, "linker64-env.sh")
        bashEnvPath.writeText(buildBashEnvSh(bootstrap.usrDir.absolutePath))
        env["BASH_ENV"] = bashEnvPath.absolutePath

        // Launch Claude Code through the JS wrapper, which patches child_process
        // and fs to route embedded binary exec calls through linker64.
        // The wrapper fixes Claude Code's shell detection (it requires bash/zsh
        // but can't exec them directly due to SELinux on app_data_file).
        val launchCmd = "exec /system/bin/linker64 ${nodePath.absolutePath} ${wrapperPath.absolutePath} ${claudePath.absolutePath}"

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
        writeInput(if (accepted) "y\r" else "n\r")
    }

    fun sendBtw(message: String) {
        writeInput("/btw $message\r")
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

    /** Create a standalone bash shell session (no Claude Code). */
    fun createDirectShell(): DirectShellBridge {
        return DirectShellBridge(bootstrap).also { it.start() }
    }

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

    companion object {
        // Embedded wrapper JS — patches child_process/fs for SELinux exec bypass.
        // Key addition: injectEnv() explicitly sources BASH_ENV into every bash -c
        // command, ensuring shell function wrappers are always available.
        private val WRAPPER_JS = """
'use strict';
var child_process = require('child_process');
var fs = require('fs');
var LINKER64 = '/system/bin/linker64';
var PREFIX = process.env.PREFIX || '';
var BASH_ENV_FILE = process.env.BASH_ENV || '';
function isEB(f) { return f && PREFIX && f.startsWith(PREFIX + '/'); }
var _as = fs.accessSync;
fs.accessSync = function(p, m) {
    if (isEB(p) && m !== undefined && (m & fs.constants.X_OK)) return _as.call(this, p, fs.constants.R_OK);
    return _as.apply(this, arguments);
};
function injectEnv(cmd, args) {
    if (BASH_ENV_FILE && cmd.endsWith('/bash') && Array.isArray(args) && args[0] === '-c' && args.length >= 2) {
        args = args.slice();
        args[1] = '. "' + BASH_ENV_FILE + '" 2>/dev/null; ' + args[1];
    }
    return args;
}
var _efs = child_process.execFileSync;
child_process.execFileSync = function(file) {
    if (isEB(file)) {
        var args = arguments.length > 1 && Array.isArray(arguments[1]) ? arguments[1] : [];
        var opts = arguments.length > 1 && Array.isArray(arguments[1]) ? arguments[2] : arguments[1];
        args = injectEnv(file, args);
        return _efs.call(this, LINKER64, [file].concat(args), opts);
    }
    return _efs.apply(this, arguments);
};
var _ef = child_process.execFile;
child_process.execFile = function(file) {
    if (isEB(file)) {
        var rest = Array.prototype.slice.call(arguments, 1);
        var args = rest.length > 0 && Array.isArray(rest[0]) ? rest[0] : [];
        var remaining = rest.length > 0 && Array.isArray(rest[0]) ? rest.slice(1) : rest;
        args = injectEnv(file, args);
        return _ef.apply(this, [LINKER64, [file].concat(args)].concat(remaining));
    }
    return _ef.apply(this, arguments);
};
// Strip -l flag from bash args. Claude Code sends ["-c", "-l", cmd] but
// via linker64 bash treats -l as the command string, not an option.
function stripLogin(args) {
    return args.filter(function(a) { return a !== '-l'; });
}
var _sp = child_process.spawn;
child_process.spawn = function(command, args, options) {
    if (isEB(command)) {
        var actualArgs = Array.isArray(args) ? args : [];
        var actualOpts = Array.isArray(args) ? options : args;
        actualArgs = stripLogin(actualArgs);
        actualArgs = injectEnv(command, actualArgs);
        return _sp.call(this, LINKER64, [command].concat(actualArgs), actualOpts);
    }
    return _sp.call(this, command, args, options);
};
var _sps = child_process.spawnSync;
child_process.spawnSync = function(command, args, options) {
    if (isEB(command)) {
        var actualArgs = Array.isArray(args) ? args : [];
        var actualOpts = Array.isArray(args) ? options : args;
        actualArgs = stripLogin(actualArgs);
        actualArgs = injectEnv(command, actualArgs);
        return _sps.call(this, LINKER64, [command].concat(actualArgs), actualOpts);
    }
    return _sps.call(this, command, args, options);
};
var cliPath = process.argv[2];
if (!cliPath) { process.stderr.write('claude-wrapper: missing CLI path\n'); process.exit(1); }
process.argv = [process.argv[0], cliPath].concat(process.argv.slice(3));
require(cliPath);
        """.trimIndent()

        /**
         * Generate BASH_ENV script with explicit shell functions for each binary.
         * Generated at launch time from the actual files in usr/bin/ — avoids all
         * shell eval/escaping issues since each function is a static string.
         */
        private fun buildBashEnvSh(usrPath: String): String {
            val binDir = File(usrPath, "bin")
            if (!binDir.isDirectory) return "# bin dir not found\n"
            val skip = setOf("bash", "sh", "sh-wrapper", "env")
            val sb = StringBuilder("# linker64 wrapper functions for embedded binaries\n")
            binDir.listFiles()?.sorted()?.forEach { file ->
                if (!file.isFile) return@forEach
                val n = file.name
                if (n in skip) return@forEach
                if (!n.matches(Regex("[a-zA-Z_][a-zA-Z0-9_.+-]*"))) return@forEach
                // Shell function: runs in-process, no exec syscall, SELinux can't block
                sb.appendLine("""$n() { /system/bin/linker64 "$usrPath/bin/$n" "${'$'}@"; }""")
            }
            return sb.toString()
        }
    }
}
