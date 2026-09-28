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
 *    session. This deploy therefore gets its OWN per-session subdirectory
 *    (keyed on the mobile session id Android already mints uniquely at
 *    session-creation time — see SessionRegistry.createSession — never a
 *    randomly-generated one: desktop needs a random directory name because two
 *    of its sessions can race onto the SAME deploy call with no id yet, but
 *    Android's `mobileSessionId` already exists before this function is ever
 *    called, so no race exists here to design around).
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

    private fun randomHex(byteCount: Int): String {
        val bytes = ByteArray(byteCount)
        random.nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    /** What PtyBridge.start()'s combined-flags step and the caller (for the
     *  pending-mutation queue and the permission-auto-approve wiring) need. */
    data class Deployment(
        val configPath: String,
        /** Just `mcp__{serverId}__ReadFileComments` — see this object's own
         *  doc comment for why the five mutation tools are absent. */
        val allowedTools: List<String>,
        val serverId: String,
        val token: String,
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
     * `mobileSessionId` and return what PtyBridge.start() and
     * DocCommentsPendingQueue need. Returns null (never throws) if anything
     * failed — a session without the doc-comments tools is a working
     * session, one pointed at a missing --mcp-config file is not; the caller
     * mirrors ClaudeCodeMcp.deploy's own "best-effort, log and continue"
     * posture.
     */
    fun deploy(
        baseDir: File,
        serverSource: String,
        linkerPath: String,
        nodePath: String,
        projectRoot: String,
        mobileSessionId: String,
    ): Deployment? {
        return try {
            val serverId = "${DocCommentsMcpNames.SERVER_PREFIX}-${randomHex(4)}"
            // 32 hex chars, fixed-length — mirrors deployClaudeCodeDocCommentsMcp's
            // own 16-random-bytes choice so a constant-time comparison on the
            // applying end never has to special-case a variable-length input
            // from a legitimate caller (adversarial review finding #1).
            val token = randomHex(16)
            val dir = File(baseDir, "claude-code-doc-comments-mcp/$mobileSessionId")
            dir.mkdirs()
            val serverFile = File(dir, SERVER_FILE)
            serverFile.writeText(serverSource)
            val configFile = File(dir, CONFIG_FILE)
            configFile.writeText(configJson(linkerPath, nodePath, serverFile.absolutePath, serverId, projectRoot, token))
            Deployment(
                configPath = configFile.absolutePath,
                allowedTools = listOf(DocCommentsMcpNames.readTool(serverId)),
                serverId = serverId,
                token = token,
            )
        } catch (e: Exception) {
            android.util.Log.w("ClaudeCodeDocCommentsMcp", "doc-comments MCP deploy failed; session starts without comment tools", e)
            null
        }
    }
}
