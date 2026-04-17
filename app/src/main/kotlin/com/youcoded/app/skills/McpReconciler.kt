package com.youcoded.app.skills

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * MCP Reconciler (decomposition v3, §9.3)
 *
 * Kotlin mirror of desktop/src/main/mcp-reconciler.ts. Scans each installed
 * plugin's mcp-manifest.json and reconciles ~/.claude.json `mcpServers`.
 *
 * Android always reports platform "linux" for filtering — Termux's bionic
 * environment is Linux-binary-compatible, so manifests declaring
 * `platform: "linux"` or `"all"` are eligible. macOS-only and Windows-only
 * entries are skipped.
 */
class McpReconciler(private val homeDir: File) {

    data class Result(
        val added: Int,
        val skippedPlatform: Int,
        val skippedManual: Int,
        val manifestCount: Int,
    )

    private val claudeJson = File(homeDir, ".claude.json")

    // Android always counts as linux for MCP platform filtering
    private val currentPlatform = "linux"

    private fun platformMatches(declared: String?): Boolean {
        if (declared.isNullOrEmpty() || declared == "all") return true
        return declared == currentPlatform
    }

    private fun expandTokens(s: String, pluginRoot: File): String =
        s.replace("{{plugin_root}}", pluginRoot.absolutePath)

    private fun readManifest(pluginDir: File): Pair<JSONArray, File>? {
        val f = File(pluginDir, "mcp-manifest.json")
        if (!f.exists()) return null
        return try {
            val raw = f.readText()
            // Manifest can be either a raw array or an object with { servers: [...] }
            val entries = when {
                raw.trimStart().startsWith("[") -> JSONArray(raw)
                else -> JSONObject(raw).optJSONArray("servers") ?: JSONArray()
            }
            entries to pluginDir
        } catch (e: Exception) {
            Log.w(TAG, "Malformed manifest: ${f.absolutePath}", e)
            null
        }
    }

    private fun listManifests(): List<Pair<JSONArray, File>> =
        // Scan both roots — marketplace plugins can declare MCP servers too.
        ClaudeCodeRegistry.listInstalledPluginDirs(homeDir)
            .mapNotNull { readManifest(it) }

    private fun readClaudeJson(): JSONObject =
        try { if (claudeJson.exists()) JSONObject(claudeJson.readText()) else JSONObject() }
        catch (_: Exception) { JSONObject() }

    private fun writeClaudeJsonAtomic(data: JSONObject) {
        val tmp = File(claudeJson.parentFile, "${claudeJson.name}.${android.os.Process.myPid()}.tmp")
        tmp.writeText(data.toString(2))
        if (!tmp.renameTo(claudeJson)) {
            claudeJson.writeText(data.toString(2))
            tmp.delete()
        }
    }

    private fun buildServerConfig(entry: JSONObject, pluginRoot: File): JSONObject? {
        val type = entry.optString("type", "stdio")
        if (type == "http") {
            val url = entry.optString("url")
            if (url.isEmpty()) return null
            return JSONObject().put("type", "http").put("url", url)
        }
        // stdio — Android picks `command` (no command_windows variant applies)
        val cmd = entry.optString("command")
        if (cmd.isEmpty()) return null
        val config = JSONObject()
            .put("type", "stdio")
            .put("command", expandTokens(cmd, pluginRoot))
        val args = entry.optJSONArray("args")
        if (args != null) {
            val expanded = JSONArray()
            for (i in 0 until args.length()) {
                expanded.put(expandTokens(args.optString(i), pluginRoot))
            }
            config.put("args", expanded)
        }
        val env = entry.optJSONObject("env")
        if (env != null) config.put("env", env)
        return config
    }

    fun reconcile(): Result {
        val manifests = listManifests()
        val claude = readClaudeJson()
        val servers = claude.optJSONObject("mcpServers") ?: JSONObject().also {
            claude.put("mcpServers", it)
        }

        var added = 0
        var skippedPlatform = 0
        var skippedManual = 0
        var changed = false

        for ((entries, pluginRoot) in manifests) {
            for (i in 0 until entries.length()) {
                val entry = entries.optJSONObject(i) ?: continue
                val name = entry.optString("name")
                if (name.isEmpty()) continue
                if (!platformMatches(entry.optString("platform").takeIf { it.isNotEmpty() })) {
                    skippedPlatform++; continue
                }
                if (!entry.optBoolean("auto", false)) { skippedManual++; continue }
                // Never overwrite user-configured entries
                if (servers.has(name)) continue

                val config = buildServerConfig(entry, pluginRoot) ?: continue
                servers.put(name, config)
                added++; changed = true
            }
        }

        if (changed) writeClaudeJsonAtomic(claude)
        return Result(added, skippedPlatform, skippedManual, manifests.size)
    }

    companion object {
        private const val TAG = "McpReconciler"
    }
}
