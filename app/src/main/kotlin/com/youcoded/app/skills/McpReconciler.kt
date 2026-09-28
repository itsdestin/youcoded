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
 * `platform: "linux"` / `platforms: [..."linux"...]` or `"all"` are eligible.
 * macOS-only and Windows-only entries are skipped.
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

    private fun expandTokens(s: String, pluginRoot: File): String = expandTokens(s, pluginRoot.absolutePath)

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

    private fun buildServerConfig(entry: JSONObject, pluginRoot: File): JSONObject? =
        buildServerConfig(entry, pluginRoot.absolutePath, ::expandTokens)

    private fun buildServerConfig(
        entry: JSONObject,
        pluginRoot: String,
        expand: (String, String) -> String,
    ): JSONObject? {
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
            .put("command", expand(cmd, pluginRoot))
        val args = entry.optJSONArray("args")
        if (args != null) {
            val expanded = JSONArray()
            for (i in 0 until args.length()) {
                expanded.put(expand(args.optString(i), pluginRoot))
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

        val r = applyManifestEntries(servers, manifests.map { (e, root) -> e to root.absolutePath })
        if (r.changed) writeClaudeJsonAtomic(claude)
        return Result(r.added, r.skippedPlatform, r.skippedManual, manifests.size)
    }

    data class ScanResult(
        val added: Int,
        val repaired: Int,
        val skippedPlatform: Int,
        val skippedManual: Int,
    ) {
        val changed: Boolean get() = added + repaired > 0
    }

    /**
     * Pure manifest-scan step (mirror of desktop `applyManifestEntries`,
     * exposed for tests). Mutates [servers]. Additive-only, except that an
     * untouched entry an older build wrote with a literal `${PACKAGE_DIR}`
     * is replaced — WHY: that entry never worked (nothing expanded the token),
     * and without the repair every existing install keeps it forever because
     * the scan never overwrites. Deep equality with the old output means an
     * entry the user edited in any way is still left alone.
     */
    internal fun applyManifestEntries(
        servers: JSONObject,
        manifests: List<Pair<JSONArray, String>>,
    ): ScanResult {
        var added = 0
        var repaired = 0
        var skippedPlatform = 0
        var skippedManual = 0
        for ((entries, pluginRoot) in manifests) {
            for (i in 0 until entries.length()) {
                val entry = entries.optJSONObject(i) ?: continue
                val name = entry.optString("name")
                if (name.isEmpty()) continue
                if (!platformMatches(entry, currentPlatform)) { skippedPlatform++; continue }
                if (!entry.optBoolean("auto", false)) { skippedManual++; continue }
                val config = buildServerConfig(entry, pluginRoot, ::expandTokens) ?: continue
                val existing = servers.optJSONObject(name)
                if (servers.has(name)) {
                    // Never overwrite user-configured entries (repair exception above).
                    val legacy = buildServerConfig(entry, pluginRoot, ::legacyExpand)
                    if (existing != null && legacy != null &&
                        legacy.toString().contains(UNEXPANDED_PACKAGE_DIR) &&
                        jsonEquals(existing, legacy)
                    ) {
                        servers.put(name, config)
                        repaired++
                    }
                    continue
                }
                servers.put(name, config)
                added++
            }
        }
        return ScanResult(added, repaired, skippedPlatform, skippedManual)
    }

    companion object {
        private const val TAG = "McpReconciler"

        private const val UNEXPANDED_PACKAGE_DIR = "\${PACKAGE_DIR}"

        /** WHY: `${PACKAGE_DIR}` is the token the marketplace publisher
         *  skill and two published manifests use; only `{{plugin_root}}` was
         *  expanded, so those servers were written with a literal placeholder
         *  and never started. Both now mean the plugin's install directory. */
        internal fun expandTokens(s: String, pluginRoot: String): String =
            s.replace("{{plugin_root}}", pluginRoot).replace(UNEXPANDED_PACKAGE_DIR, pluginRoot)

        /** What older builds wrote: `{{plugin_root}}` expanded, `${PACKAGE_DIR}` literal. */
        private fun legacyExpand(s: String, pluginRoot: String): String =
            s.replace("{{plugin_root}}", pluginRoot)

        // WHY: manifests use Node's names (darwin/win32) as well as the app's
        // (macos/windows); normalise both so neither is silently a non-match.
        private fun normalizePlatform(p: String): String = when (val v = p.trim().lowercase()) {
            "darwin", "mac", "osx" -> "macos"
            "win32", "win" -> "windows"
            else -> v
        }

        /** WHY: published manifests declare a `platforms` LIST, which the
         *  single `platform` field cannot express; reading only `platform`
         *  let those servers through everywhere. A non-empty list wins; an
         *  empty or missing one falls back to `platform`. */
        internal fun platformMatches(entry: JSONObject, current: String): Boolean {
            val list = entry.optJSONArray("platforms")
            if (list != null && list.length() > 0) {
                val names = (0 until list.length()).mapNotNull { list.opt(it) as? String }.map(::normalizePlatform)
                return "all" in names || current in names
            }
            val declared = entry.optString("platform")
            if (declared.isEmpty() || declared == "all") return true
            return normalizePlatform(declared) == current
        }

        // org.json has no structural equals; compare parsed values recursively
        // so key order in the user's file never matters.
        private fun jsonEquals(a: Any?, b: Any?): Boolean = when {
            a is JSONObject && b is JSONObject -> {
                // Android's org.json has no keySet(); keys() is the portable form.
                val ka = a.keys().asSequence().toSet()
                ka == b.keys().asSequence().toSet() && ka.all { jsonEquals(a.opt(it), b.opt(it)) }
            }
            a is JSONArray && b is JSONArray ->
                a.length() == b.length() && (0 until a.length()).all { jsonEquals(a.opt(it), b.opt(it)) }
            else -> a == b
        }
    }
}
