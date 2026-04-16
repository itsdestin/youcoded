package com.youcoded.app.runtime

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Hook Reconciler (decomposition v3, §9.2)
 *
 * Kotlin mirror of desktop/src/main/hook-reconciler.ts. Reads each installed
 * plugin's hooks-manifest.json and reconciles ~/.claude/settings.json:
 *   - Adds missing required hooks
 *   - Enforces MAX(user_timeout, manifest_timeout)
 *   - Updates stale command paths
 *   - Never removes user-added hooks
 *
 * Matches manifest entries to existing settings entries by script basename
 * + matcher so the same logical hook is recognized across path changes.
 */
class HookReconciler(private val homeDir: File) {

    data class Result(val added: Int, val updatedPath: Int, val updatedTimeout: Int, val manifestCount: Int)

    private val pluginsDir = File(homeDir, ".claude/plugins")
    private val settingsFile = File(homeDir, ".claude/settings.json")

    // Matches the last path component of a script reference inside a command
    // string, e.g., `bash ~/.claude/plugins/x/hooks/session-start.sh` → session-start.sh
    private val scriptBasenameRegex = Regex("""[/\\]([^/\\\s]+\.(sh|js|py|ts|bash))(?:\s|$|")""")

    private fun extractScriptBasename(command: String): String? =
        scriptBasenameRegex.find(command)?.groupValues?.get(1)

    private fun readManifest(pluginDir: File): JSONObject? {
        val candidates = listOf(
            File(pluginDir, "hooks/hooks-manifest.json"),
            File(pluginDir, "hooks-manifest.json"),
        )
        for (f in candidates) {
            if (!f.exists()) continue
            try { return JSONObject(f.readText()) } catch (e: Exception) {
                Log.w(TAG, "Malformed manifest: ${f.absolutePath}", e)
            }
        }
        return null
    }

    private fun listManifests(): List<JSONObject> {
        if (!pluginsDir.exists()) return emptyList()
        return pluginsDir.listFiles { f -> f.isDirectory }
            ?.mapNotNull { readManifest(it) }
            ?.filter { it.has("hooks") }
            ?: emptyList()
    }

    private fun readSettings(): JSONObject =
        try { if (settingsFile.exists()) JSONObject(settingsFile.readText()) else JSONObject() }
        catch (_: Exception) { JSONObject() }

    private fun writeSettingsAtomic(settings: JSONObject) {
        settingsFile.parentFile?.mkdirs()
        val tmp = File(settingsFile.parentFile, "${settingsFile.name}.${android.os.Process.myPid()}.tmp")
        tmp.writeText(settings.toString(2))
        if (!tmp.renameTo(settingsFile)) {
            settingsFile.writeText(settings.toString(2))
            tmp.delete()
        }
    }

    /** Locate a settings hook entry matching the given manifest spec. Returns
     *  (matcherEntryIdx, hookIdx) or null. */
    private fun findMatching(
        event: JSONArray,
        specMatcher: String,
        specCommand: String,
    ): Pair<Int, Int>? {
        val targetBasename = extractScriptBasename(specCommand) ?: return null
        for (i in 0 until event.length()) {
            val entry = event.optJSONObject(i) ?: continue
            val entryMatcher = entry.optString("matcher")
            if (entryMatcher != specMatcher) continue
            val hooks = entry.optJSONArray("hooks") ?: continue
            for (j in 0 until hooks.length()) {
                val h = hooks.optJSONObject(j) ?: continue
                if (extractScriptBasename(h.optString("command")) == targetBasename) {
                    return i to j
                }
            }
        }
        return null
    }

    fun reconcile(): Result {
        val manifests = listManifests()
        val settings = readSettings()
        val hooksObj = settings.optJSONObject("hooks") ?: JSONObject().also { settings.put("hooks", it) }

        var added = 0
        var updatedPath = 0
        var updatedTimeout = 0
        var changed = false

        for (manifest in manifests) {
            val manifestHooks = manifest.optJSONObject("hooks") ?: continue
            val events = manifestHooks.keys()
            while (events.hasNext()) {
                val event = events.next()
                val specs = manifestHooks.optJSONArray(event) ?: continue
                val eventList = hooksObj.optJSONArray(event) ?: JSONArray().also { hooksObj.put(event, it) }

                for (s in 0 until specs.length()) {
                    val spec = specs.optJSONObject(s) ?: continue
                    val specCmd = spec.optString("command")
                    val specMatcher = spec.optString("matcher")
                    val specTimeout = spec.optInt("timeout", 0)
                    val required = spec.optBoolean("required", false)

                    val match = findMatching(eventList, specMatcher, specCmd)
                    if (match != null) {
                        val (entryIdx, hookIdx) = match
                        val hook = eventList.getJSONObject(entryIdx).getJSONArray("hooks").getJSONObject(hookIdx)
                        if (hook.optString("command") != specCmd) {
                            hook.put("command", specCmd)
                            updatedPath++; changed = true
                        }
                        val existingTimeout = hook.optInt("timeout", 0)
                        val max = maxOf(specTimeout, existingTimeout)
                        if (max != existingTimeout) {
                            hook.put("timeout", max)
                            updatedTimeout++; changed = true
                        }
                    } else if (required) {
                        eventList.put(JSONObject().apply {
                            put("matcher", specMatcher)
                            put("hooks", JSONArray().put(JSONObject().apply {
                                put("type", "command")
                                put("command", specCmd)
                                put("timeout", if (specTimeout > 0) specTimeout else 10)
                            }))
                        })
                        added++; changed = true
                    }
                    // Missing non-required hooks stay missing — user may have removed them
                }
            }
        }

        if (changed) writeSettingsAtomic(settings)
        return Result(added, updatedPath, updatedTimeout, manifests.size)
    }

    companion object {
        private const val TAG = "HookReconciler"
    }
}
