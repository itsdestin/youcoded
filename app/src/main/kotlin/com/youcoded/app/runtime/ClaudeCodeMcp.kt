package com.youcoded.app.runtime

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Attaching YouCoded's SendUserLink tool to a CLAUDE CODE session on Android —
 * the Kotlin half of desktop/src/main/claude-code-mcp.ts.
 *
 * Claude Code ships SendUserFile and has no link equivalent, so the app hands
 * each session it launches a one-tool MCP server of its own. Everything is
 * per-session and app-owned: the server and its config are written under the
 * app's own .claude-mobile dir and passed with --mcp-config, so nothing is
 * installed into ~/.claude.json (entries written there by the plugin path are
 * never removed again — see McpReconciler.kt / mcp-reconciler.ts).
 *
 * The server source itself is the shared asset send-user-link-mcp.js, kept
 * byte-identical to the desktop copy by claude-code-mcp.test.ts.
 */
object ClaudeCodeMcp {
    /** MCP server id — must match CLAUDE_CODE_MCP_SERVER_ID in shared/send-user-link.ts. */
    const val SERVER_ID = "youcoded"

    /** The name Claude Code composes for the tool, and the exact string the
     *  React UI matches to draw a link tile. Must match CLAUDE_CODE_LINK_TOOL
     *  in shared/send-user-link.ts. */
    const val TOOL_NAME = "mcp__youcoded__SendUserLink"

    /** Asset filename, also the on-disk filename. */
    const val SERVER_FILE = "send-user-link-mcp.js"

    private const val CONFIG_FILE = "mcp-config.json"

    /**
     * The --mcp-config contents.
     *
     * WHY the command is linker64 and not node itself: Android's SELinux policy
     * refuses to exec the embedded binaries from app_data_file directly, which
     * is the same reason PtyBridge launches Claude Code as
     * "linker64 <node> <script>". Claude Code spawns MCP servers itself, with
     * its own environment, so the config has to carry that same indirection —
     * naming bare "node" here would fail to launch with no useful message.
     */
    fun configJson(linkerPath: String, nodePath: String, serverPath: String): String {
        val server = JSONObject()
            .put("type", "stdio")
            .put("command", linkerPath)
            .put("args", JSONArray(listOf(nodePath, serverPath)))
        return JSONObject().put("mcpServers", JSONObject().put(SERVER_ID, server)).toString(2)
    }

    /**
     * Write the server + config into [dir] and return the CLI flags that attach
     * them to one session. Rewritten on every launch so an APK update refreshes
     * the server, mirroring the desktop deploy.
     *
     * Returns a leading-space-prefixed fragment ready to concatenate onto the
     * launch command, or "" if anything failed — a session without the link
     * tool is a working session, a session pointed at a missing --mcp-config
     * file is not.
     */
    fun deploy(dir: File, serverSource: String, linkerPath: String, nodePath: String): String {
        return try {
            dir.mkdirs()
            val serverFile = File(dir, SERVER_FILE)
            serverFile.writeText(serverSource)
            val configFile = File(dir, CONFIG_FILE)
            configFile.writeText(configJson(linkerPath, nodePath, serverFile.absolutePath))
            " --mcp-config ${configFile.absolutePath} --allowedTools $TOOL_NAME"
        } catch (e: Exception) {
            android.util.Log.w("ClaudeCodeMcp", "SendUserLink MCP deploy failed; session starts without the link tool", e)
            ""
        }
    }
}
