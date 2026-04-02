package com.destin.code.runtime

import com.destin.code.parser.EventBridge
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import java.io.File

class PtyBridge(
    private val bootstrap: Bootstrap,
    private val apiKey: String? = null,
    private val socketName: String = "${bootstrap.homeDir.absolutePath}/.claude-mobile/parser.sock",
    private val cwd: File = bootstrap.homeDir,
    private val dangerousMode: Boolean = false,
    val mobileSessionId: String? = null,
    private val resumeSessionId: String? = null,
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
        override fun onSessionFinished(finishedSession: TerminalSession) {}
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
        val wrapperPath = File(mobileDir, "claude-wrapper.js")
        wrapperPath.writeText(WRAPPER_JS)

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
        val launchCmd = "exec /system/bin/linker64 ${nodePath.absolutePath} ${wrapperPath.absolutePath} ${claudePath.absolutePath}$dangerousFlag$resumeFlag"

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
    }

    companion object {
        // Embedded wrapper JS — patches Node.js for Android quirks.
        // ARCHITECTURE: termux-exec LD_PRELOAD handles exec routing through
        // linker64 for all C/Rust programs. This wrapper only handles things
        // termux-exec cannot: /tmp rewriting, fs.accessSync X_OK bypass,
        // shell path fixing, -l flag stripping, BASH_ENV injection, and
        // xdg-open/browser-open interception.
        private val WRAPPER_JS = """
'use strict';
var child_process = require('child_process');
var fs = require('fs');
var PREFIX = process.env.PREFIX || '';
var BASH_ENV_FILE = process.env.BASH_ENV || '';
var HOME = process.env.HOME || '';
var TERMUX_PREFIX = '/data/data/com.termux/files/usr';
var ALT_PREFIX = '';
if (PREFIX.indexOf('/data/user/0/') === 0) ALT_PREFIX = '/data/data/' + PREFIX.substring('/data/user/0/'.length);
else if (PREFIX.indexOf('/data/data/') === 0) ALT_PREFIX = '/data/user/0/' + PREFIX.substring('/data/data/'.length);
function fixTmp(p) { if (typeof p === 'string') { if (p === '/tmp') return HOME + '/tmp'; if (p.startsWith('/tmp/')) return HOME + '/tmp/' + p.substring(5); if (p === '/var/tmp') return HOME + '/tmp'; if (p.startsWith('/var/tmp/')) return HOME + '/tmp/' + p.substring(9); } return p; }
function fixTmpArgs(args) { if (!Array.isArray(args)) return args; return args.map(function(a) { return typeof a === 'string' ? fixTmp(a) : a; }); }
function fixTmpInShellCmd(cmd) { if (typeof cmd !== 'string') return cmd; return cmd.replace(/(^|[\s=:])\/tmp\b/g, '${'$'}1' + HOME + '/tmp').replace(/(^|[\s=:])\/var\/tmp\b/g, '${'$'}1' + HOME + '/tmp'); }
function isEB(f) { return f && (PREFIX && f.startsWith(PREFIX + '/') || f.startsWith(TERMUX_PREFIX + '/') || (ALT_PREFIX && f.startsWith(ALT_PREFIX + '/'))); }
function fixPath(f) { if (f.startsWith(TERMUX_PREFIX + '/')) return PREFIX + f.substring(TERMUX_PREFIX.length); if (ALT_PREFIX && f.startsWith(ALT_PREFIX + '/')) return PREFIX + f.substring(ALT_PREFIX.length); return f; }
function fixShell(s) { if (s === true) return PREFIX + '/bin/bash'; return (typeof s === 'string' && isEB(s)) ? fixPath(s) : s; }
function fixOpts(o) { if (o && o.shell != null && o.shell !== false) { var s = fixShell(o.shell); if (s !== o.shell) return Object.assign({}, o, {shell: s}); } return o; }
function fixExecShell(o) { o = Object.assign({}, o || {}); if (!o.shell || o.shell === true) o.shell = PREFIX + '/bin/bash'; else if (typeof o.shell === 'string' && isEB(o.shell)) o.shell = fixPath(o.shell); return o; }
var _as = fs.accessSync;
fs.accessSync = function(p, m) { p = fixTmp(p); if (isEB(p) && m !== undefined && (m & fs.constants.X_OK)) return _as.call(this, fixPath(p), fs.constants.R_OK); var a = Array.prototype.slice.call(arguments); a[0] = p; return _as.apply(this, a); };
['writeFileSync','readFileSync','existsSync','statSync','lstatSync','readdirSync','mkdirSync','unlinkSync','rmdirSync','chmodSync','renameSync','copyFileSync'].forEach(function(m) { var orig = fs[m]; if (!orig) return; fs[m] = function() { var a = Array.prototype.slice.call(arguments); if (typeof a[0] === 'string') a[0] = fixTmp(a[0]); if (m === 'renameSync' || m === 'copyFileSync') { if (typeof a[1] === 'string') a[1] = fixTmp(a[1]); } return orig.apply(this, a); }; });
['writeFile','readFile','stat','lstat','readdir','mkdir','unlink','rmdir','chmod','rename','copyFile','access'].forEach(function(m) { var orig = fs[m]; if (!orig) return; fs[m] = function() { var a = Array.prototype.slice.call(arguments); if (typeof a[0] === 'string') a[0] = fixTmp(a[0]); if ((m === 'rename' || m === 'copyFile') && typeof a[1] === 'string') a[1] = fixTmp(a[1]); return orig.apply(this, a); }; });
var _openSync = fs.openSync; fs.openSync = function(p) { var a = Array.prototype.slice.call(arguments); a[0] = fixTmp(a[0]); return _openSync.apply(this, a); };
var _open = fs.open; fs.open = function(p) { var a = Array.prototype.slice.call(arguments); a[0] = fixTmp(a[0]); return _open.apply(this, a); };
var _cws = fs.createWriteStream; fs.createWriteStream = function(p) { var a = Array.prototype.slice.call(arguments); if (typeof a[0] === 'string') a[0] = fixTmp(a[0]); return _cws.apply(this, a); };
var _crs = fs.createReadStream; fs.createReadStream = function(p) { var a = Array.prototype.slice.call(arguments); if (typeof a[0] === 'string') a[0] = fixTmp(a[0]); return _crs.apply(this, a); };
function stripLogin(args) { return args.filter(function(a) { return a !== '-l'; }); }
function injectEnv(cmd, args) { if (BASH_ENV_FILE && cmd.endsWith('/bash') && Array.isArray(args) && args[0] === '-c' && args.length >= 2) { args = args.slice(); args[1] = '. "' + BASH_ENV_FILE + '" 2>/dev/null; ' + args[1]; } return args; }
function isBrowserOpen(name) { var fn = String(name).replace(/^.*\//, ''); return fn === 'xdg-open' || fn === 'open' || fn === 'browser-open' || String(name).endsWith('/browser-open'); }
function handleBrowserOpen(args) { var a = Array.isArray(args) ? args : []; var url = a.find(function(x) { return typeof x === 'string' && x.startsWith('http'); }); if (url) { try { fs.writeFileSync(HOME + '/.claude-mobile/open-url', url); } catch(e) {} return true; } return false; }
// child_process patches — no longer route through linker64 (termux-exec handles
// that via LD_PRELOAD). Only fix /tmp, -l, BASH_ENV, shell paths, browser-open.
var _efs = child_process.execFileSync;
child_process.execFileSync = function(file) {
    if (isBrowserOpen(file)) { var a0 = arguments.length > 1 && Array.isArray(arguments[1]) ? arguments[1] : []; if (handleBrowserOpen(a0)) return Buffer.alloc(0); }
    file = fixTmp(file); if (isEB(file)) file = fixPath(file);
    var args = arguments.length > 1 && Array.isArray(arguments[1]) ? arguments[1] : [];
    var opts = arguments.length > 1 && Array.isArray(arguments[1]) ? arguments[2] : arguments[1];
    if (file.endsWith('/bash') || file.endsWith('/sh')) { args = stripLogin(args); var ci = args.indexOf('-c'); if (ci !== -1 && ci + 1 < args.length && typeof args[ci + 1] === 'string') { args = args.slice(); args[ci + 1] = fixTmpInShellCmd(args[ci + 1]); } }
    args = fixTmpArgs(args); args = injectEnv(file, args);
    return _efs.call(this, file, args, opts);
};
var _ef = child_process.execFile;
child_process.execFile = function(file) {
    if (isBrowserOpen(file)) { var rest0 = Array.prototype.slice.call(arguments, 1); var a0 = rest0.length > 0 && Array.isArray(rest0[0]) ? rest0[0] : []; if (handleBrowserOpen(a0)) { var cb0 = rest0.find(function(x) { return typeof x === 'function'; }); if (cb0) cb0(null, '', ''); return; } }
    file = fixTmp(file); if (isEB(file)) file = fixPath(file);
    var rest = Array.prototype.slice.call(arguments, 1);
    var args = rest.length > 0 && Array.isArray(rest[0]) ? rest[0] : [];
    var remaining = rest.length > 0 && Array.isArray(rest[0]) ? rest.slice(1) : rest;
    if (file.endsWith('/bash') || file.endsWith('/sh')) { args = stripLogin(args); var ci = args.indexOf('-c'); if (ci !== -1 && ci + 1 < args.length && typeof args[ci + 1] === 'string') { args = args.slice(); args[ci + 1] = fixTmpInShellCmd(args[ci + 1]); } }
    args = fixTmpArgs(args); args = injectEnv(file, args);
    return _ef.apply(this, [file, args].concat(remaining));
};
function spawnFix(orig, command, args, options) {
    if (isBrowserOpen(command)) { var urlArgs = Array.isArray(args) ? args : []; if (handleBrowserOpen(urlArgs)) return orig.call(this, '/system/bin/sh', ['-c', 'true'], {}); }
    command = fixTmp(String(command)); if (isEB(command)) command = fixPath(command);
    var o = Array.isArray(args) ? options : args;
    var hasShell = o && o.shell && o.shell !== false;
    if (hasShell) { var fo = fixOpts(o); if (Array.isArray(args)) return orig.call(this, command, fixTmpArgs(args), fo); return orig.call(this, command, fo); }
    var actualArgs = Array.isArray(args) ? args : [];
    if (command.endsWith('/bash') || command.endsWith('/sh')) { actualArgs = stripLogin(actualArgs); var ci = actualArgs.indexOf('-c'); if (ci !== -1 && ci + 1 < actualArgs.length && typeof actualArgs[ci + 1] === 'string') { actualArgs = actualArgs.slice(); actualArgs[ci + 1] = fixTmpInShellCmd(actualArgs[ci + 1]); } }
    actualArgs = fixTmpArgs(actualArgs); actualArgs = injectEnv(command, actualArgs);
    return orig.call(this, command, actualArgs, o);
}
var _sp = child_process.spawn;
child_process.spawn = function(command, args, options) { return spawnFix.call(this, _sp, command, args, options); };
var _sps = child_process.spawnSync;
child_process.spawnSync = function(command, args, options) { return spawnFix.call(this, _sps, command, args, options); };
var _exec = child_process.exec;
child_process.exec = function(cmd, opts, cb) { if (typeof opts === 'function') { cb = opts; opts = undefined; } var m = typeof cmd === 'string' && cmd.match(/^(?:.*\/)?(?:xdg-open|open|browser-open)\s+(https?:\/\/\S+)/); if (m) { try { fs.writeFileSync(HOME + '/.claude-mobile/open-url', m[1]); } catch(e) {} cmd = 'true'; } return _exec.call(this, fixTmpInShellCmd(cmd), fixExecShell(opts), cb); };
var _execSync = child_process.execSync;
child_process.execSync = function(cmd, opts) { var m2 = typeof cmd === 'string' && cmd.match(/^(?:.*\/)?(?:xdg-open|open|browser-open)\s+(https?:\/\/\S+)/); if (m2) { try { fs.writeFileSync(HOME + '/.claude-mobile/open-url', m2[1]); } catch(e) {} cmd = 'true'; } return _execSync.call(this, fixTmpInShellCmd(cmd), fixExecShell(opts)); };
var cliPath = process.argv[2];
if (!cliPath) { process.stderr.write('claude-wrapper: missing CLI path\n'); process.exit(1); }
process.argv = [process.argv[0], cliPath].concat(process.argv.slice(3));
require(cliPath);
        """.trimIndent()

        // buildBashEnvSh logic is now in Bootstrap.deployBashEnv()
        // so both PtyBridge and DirectShellBridge can use it.
    }
}
