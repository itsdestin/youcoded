package com.youcoded.app.runtime

import com.youcoded.app.doccomments.DocCommentsMcpNames
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.SecureRandom

/**
 * Attaching the six document-comment tools (docs/active/specs/2026-09-26-doc-
 * comments-build-design.md §5, §9) to a Claude Code session on Android — T9c
 * (Android byte-identical MCP asset) and half of T20 (deploy + wiring; the
 * queue applier itself is DocCommentsPendingQueue.kt).
 *
 * Mirrors ClaudeCodeMcp.kt's SendUserLink deploy (itself the Android half of
 * claude-code-mcp.ts), citing that as the precedent this task was scoped
 * against (design §9.2, T9c row: "citing ClaudeCodeMcp.kt / claude-code-mcp.ts's
 * existing SendUserLink deploy as precedent"). Two differences from that
 * precedent, both load-bearing:
 *
 * 1. This server carries a per-session SECRET (`token`) and a per-session
 *    random `serverId` (adversarial review 2026-09-27, findings #1/#2, ported
 *    from claude-code-doc-comments-mcp.ts's own header) — SendUserLink has
 *    neither, so it can safely reuse ONE fixed on-disk path across every
 *    session. This deploy therefore gets its OWN per-DEPLOYMENT subdirectory,
 *    keyed on the freshly-minted `serverId` itself (T9c/T20 review, finding
 *    #2 fix — an EARLIER version of this file keyed the directory on the
 *    caller-supplied `mobileSessionId` instead, with a `?: "no-session-id"`
 *    fallback at the one call site: harmless today because that call site
 *    always supplies a real UUID, but a landmine identical in shape to the
 *    exact fixed-path collision desktop's own finding #2 fix closed — a
 *    future caller hitting the default would silently collide with any other
 *    session sharing that same placeholder string. Keying on `serverId`
 *    instead removes the caller's input from the uniqueness guarantee
 *    entirely: `serverId` is ALWAYS a fresh random value, generated inside
 *    this very function, so no caller mistake can ever reintroduce a fixed
 *    path — the same guarantee desktop's `deployClaudeCodeDocCommentsMcp`
 *    already has by construction).
 * 2. Only `ReadFileComments` is allow-listed (`allowedTools` below) — the five
 *    mutation tools are deliberately NOT pre-approved; DocCommentsPermission.kt
 *    decides those per-call, by argument, through the SAME PermissionRequest
 *    hook path ManagedSession.kt already auto-approves other categories
 *    through (see that file's own header for the full reasoning, ported from
 *    permission-auto-approve.ts).
 *
 * The server source itself is the shared asset doc-comments-mcp.js, kept
 * byte-identical to desktop's `DOC_COMMENTS_SERVER_JS` constant by a desktop-
 * side parity test (claude-code-doc-comments-mcp.test.ts), the same shape as
 * claude-code-mcp.test.ts's existing SendUserLink parity test.
 *
 * --- Cleanup (T9c/T20 review, finding #3) ---
 *
 * Every deployment's directory (config + token) is deleted by PtyBridge.stop()
 * once that session ends (`Deployment.deployDir`, below) — a session that
 * ends without calling stop() (a process kill, a crash) leaves its directory
 * behind, so `sweepStaleDeploysOnce` below also wipes every OTHER pre-existing
 * subdirectory the first time this object deploys anything in a fresh process
 * — safe because no in-memory `Entry` from a previous process life could
 * possibly still reference one of those directories (this app's queue state
 * is all in-process; nothing persists it across a process restart).
 */
object ClaudeCodeDocCommentsMcp {
    /** Asset filename, also the on-disk filename — must match the desktop
     *  parity test's ANDROID_ASSET path. */
    const val SERVER_FILE = "doc-comments-mcp.js"

    private const val CONFIG_FILE = "mcp-config.json"

    /** Must match YOUCODED_PROJECT_ROOT_ENV in desktop/src/shared/doc-comments-mcp.ts. */
    const val PROJECT_ROOT_ENV = "YOUCODED_PROJECT_ROOT"

    /** Must match YOUCODED_MCP_TOKEN_ENV in desktop/src/shared/doc-comments-mcp.ts. */
    const val TOKEN_ENV = "YOUCODED_MCP_TOKEN"

    private val random = SecureRandom()

    /** Guards the once-per-process leftover sweep (finding #3) — a plain,
     *  non-atomic flag is fine: `deploy()` only ever runs on the single PTY
     *  launch path, never concurrently with itself for a fresh process. */
    @Volatile private var sweptStaleDeploysThisProcess = false

    /** Test-only: re-arms the once-per-process sweep so a test can observe it
     *  firing against its own fresh temp directory, rather than only ever
     *  once across an entire shared-JVM test run. */
    fun resetSweepForTest() {
        sweptStaleDeploysThisProcess = false
    }

    private fun randomHex(byteCount: Int): String {
        val bytes = ByteArray(byteCount)
        random.nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    /**
     * Owner-only permissions (T9c/T20 review, finding #1 — cheap hardening).
     * Mirrors Bootstrap.kt's own `syncGhTokenToNetrc` technique for `~/.netrc`
     * (revoke-for-everyone, then grant-for-owner, via the two-arg
     * `File.setReadable`/`setWritable`, never POSIX attribute views) rather
     * than inventing a second technique for the same class of file. Extended
     * with `setExecutable` for a directory, which needs its own `x` bit to
     * stay traversable by its owning process at all.
     *
     * WHY this is real but narrow hardening, not a fix for finding #1's own
     * threat (see the WHY note beside token generation, below, for the full
     * reasoning): Android's per-UID app sandbox already denies every OTHER
     * app's process regardless of this file's own mode bits, and this app's
     * OWN Bash/Write tools run under the SAME uid this file is already
     * "owner-only" for — unaffected either way. What this DOES close: a
     * rooted device, an ADB `run-as` shell, or a backup/extraction tool that
     * can read arbitrary files under this uid without going through Android's
     * per-app permission model at all would otherwise see a
     * world/group-readable file purely because nothing ever restricted it —
     * cheap to close, worth closing, not the primary defense.
     */
    private fun restrictToOwner(target: File, isDirectory: Boolean) {
        target.setReadable(false, false)
        target.setReadable(true, true)
        target.setWritable(false, false)
        target.setWritable(true, true)
        if (isDirectory) {
            target.setExecutable(false, false)
            target.setExecutable(true, true)
        }
    }

    /**
     * Finding #3: every directory this object has EVER deployed lives under
     * one parent (`claude-code-doc-comments-mcp/`) with no per-deployment
     * cleanup guaranteed (a crash or a process kill skips PtyBridge.stop()'s
     * own delete). Called once, the first time THIS process ever deploys
     * anything — never mid-process, since a sibling deployment from earlier
     * in the SAME process run is still live and must not be swept.
     */
    private fun sweepStaleDeploysOnce(baseDir: File) {
        if (sweptStaleDeploysThisProcess) return
        sweptStaleDeploysThisProcess = true
        try {
            File(baseDir, "claude-code-doc-comments-mcp").deleteRecursively()
        } catch (e: Exception) {
            android.util.Log.w("ClaudeCodeDocCommentsMcp", "leftover-deploy sweep failed (non-fatal)", e)
        }
    }

    /** What PtyBridge.start()'s combined-flags step and the caller (for the
     *  pending-mutation queue, the permission-auto-approve wiring, and
     *  PtyBridge.stop()'s own cleanup, finding #3) need. */
    data class Deployment(
        val configPath: String,
        /** Just `mcp__{serverId}__ReadFileComments` — see this object's own
         *  doc comment for why the five mutation tools are absent. */
        val allowedTools: List<String>,
        val serverId: String,
        val token: String,
        /** This deployment's own directory — PtyBridge.stop() deletes it
         *  wholesale when the session ends (finding #3). */
        val deployDir: String,
    )

    /** The --mcp-config contents. Mirrors ClaudeCodeMcp.configJson's WHY
     *  (linker64, never bare node — SELinux refuses a direct exec of the
     *  embedded node from app_data_file, and Claude Code spawns MCP servers
     *  itself with its own environment) plus this server's own per-session
     *  `env` (the ONE trusted project root, never model input — §1.5 — and
     *  this session's own secret token, §9.1 finding #1). */
    fun configJson(linkerPath: String, nodePath: String, serverPath: String, serverId: String, projectRoot: String, token: String): String {
        val server = JSONObject()
            .put("type", "stdio")
            .put("command", linkerPath)
            .put("args", JSONArray(listOf(nodePath, serverPath)))
            .put("env", JSONObject().put(PROJECT_ROOT_ENV, projectRoot).put(TOKEN_ENV, token))
        return JSONObject().put("mcpServers", JSONObject().put(serverId, server)).toString(2)
    }

    /**
     * Write the server + config into `baseDir`/claude-code-doc-comments-mcp/
     * `serverId` and return what PtyBridge.start() and DocCommentsPendingQueue
     * need. Returns null (never throws) if anything failed — a session
     * without the doc-comments tools is a working session, one pointed at a
     * missing --mcp-config file is not; the caller mirrors ClaudeCodeMcp
     * .deploy's own "best-effort, log and continue" posture.
     *
     * No `mobileSessionId` parameter (T9c/T20 review, finding #2 fix) — this
     * function's own freshly-minted `serverId` is what names the directory,
     * so nothing a caller passes (or fails to pass) can affect path
     * uniqueness. See this object's own doc comment for the full reasoning.
     */
    fun deploy(
        baseDir: File,
        serverSource: String,
        linkerPath: String,
        nodePath: String,
        projectRoot: String,
    ): Deployment? {
        return try {
            sweepStaleDeploysOnce(baseDir)
            val serverId = "${DocCommentsMcpNames.SERVER_PREFIX}-${randomHex(4)}"
            // 32 hex chars, fixed-length — mirrors deployClaudeCodeDocCommentsMcp's
            // own 16-random-bytes choice so a constant-time comparison on the
            // applying end never has to special-case a variable-length input
            // from a legitimate caller (adversarial review finding #1).
            //
            // WHY this token is real, tested defense against SOME threats and
            // not others (T9c/T20 review, finding #1 — triage, review 2026-
            // 09-27): it stops a request PLANTED before this session existed
            // (nothing before spawn time could know it) and a request from a
            // DIFFERENT session/process that never received it. It does NOT,
            // and was never meant to, stop code running INSIDE this already-
            // live session (this session's own Bash/Write tools, a skill file
            // it runs, a compromised dependency it executes) from reading its
            // own token and forging a request — that code already has the
            // SAME filesystem access needed to edit the target .docx/.xlsx
            // directly, with no token required at all, and in `default`
            // permission mode that same Bash/Write access would itself
            // trigger an ordinary PermissionRequest prompt. The token's job
            // is closing the pre-planted-file and cross-session/cross-process
            // mix-up cases, never same-uid code execution — see the review
            // file's own triage section for the full reasoning.
            val token = randomHex(16)
            val dir = File(baseDir, "claude-code-doc-comments-mcp/$serverId")
            dir.mkdirs()
            restrictToOwner(dir, isDirectory = true)
            val serverFile = File(dir, SERVER_FILE)
            serverFile.writeText(serverSource)
            val configFile = File(dir, CONFIG_FILE)
            configFile.writeText(configJson(linkerPath, nodePath, serverFile.absolutePath, serverId, projectRoot, token))
            // Owner-only (finding #1, cheap hardening) — the config file is
            // the one that actually holds the token; see restrictToOwner's
            // own doc comment for exactly what this does and doesn't defend
            // against.
            restrictToOwner(configFile, isDirectory = false)
            Deployment(
                configPath = configFile.absolutePath,
                allowedTools = listOf(DocCommentsMcpNames.readTool(serverId)),
                serverId = serverId,
                token = token,
                deployDir = dir.absolutePath,
            )
        } catch (e: Exception) {
            android.util.Log.w("ClaudeCodeDocCommentsMcp", "doc-comments MCP deploy failed; session starts without comment tools", e)
            null
        }
    }
}
