package com.youcoded.app.skills

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class SkillScanner(private val homeDir: File, private val context: Context) {

    fun scan(): JSONArray {
        val registry = loadRegistry()
        val discoveredIds = mutableSetOf<String>()
        val skills = JSONArray()

        fun addSkill(id: String, fallbackName: String, fallbackDesc: String, inferredSource: String, pluginName: String? = null) {
            if (discoveredIds.contains(id)) return
            discoveredIds.add(id)

            val curated = registry.optJSONObject(id)
            if (curated != null) {
                val entry = JSONObject(curated.toString())
                entry.put("id", id)
                entry.put("type", curated.optString("type", "plugin"))
                entry.put("visibility", curated.optString("visibility", "published"))
                if (pluginName != null) entry.put("pluginName", pluginName)
                skills.put(entry)
            } else {
                val displayName = fallbackName.split("-").joinToString(" ") { it.replaceFirstChar { c -> c.uppercase() } }
                skills.put(JSONObject().apply {
                    put("id", id)
                    put("displayName", displayName)
                    put("description", fallbackDesc.ifEmpty { "Run the $fallbackName skill" })
                    put("category", "other")
                    put("prompt", "/$id")
                    put("source", inferredSource)
                    put("type", "plugin")
                    put("visibility", "published")
                    if (pluginName != null) put("pluginName", pluginName)
                })
            }
        }

        val pluginsDir = File(homeDir, ".claude/plugins")

        // Pass 1: top-level scan ONLY (mirrors desktop/src/main/skill-scanner.ts).
        // We deliberately do NOT call ClaudeCodeRegistry.listInstalledPluginDirs()
        // here — that helper walks the marketplace subtree too, which is correct
        // for reconcilers but wrong for the scanner: marketplace plugins are
        // picked up by Pass 2 (installed_plugins.json) with namespaced ids, and
        // walking them here produced duplicate bare ids for any plugin whose
        // directory name starts with "youcoded" (the special-case branch below).
        try {
            pluginsDir.listFiles()?.forEach { pluginRoot ->
                if (!pluginRoot.isDirectory) return@forEach
                if (pluginRoot.name == "marketplaces") return@forEach
                val hasManifest = File(pluginRoot, "plugin.json").exists() ||
                    File(pluginRoot, ".claude-plugin/plugin.json").exists()
                if (!hasManifest) return@forEach

                File(pluginRoot, "skills").listFiles()?.forEach { entry ->
                    if (entry.isDirectory) {
                        // youcoded-core (bundled, top-level) keeps bare skill ids
                        // for backward-compat with existing favorites/curated
                        // defaults. No marketplace plugin can reach this branch
                        // because the marketplaces/ subtree was skipped above.
                        val skillId = if (pluginRoot.name.startsWith("youcoded")) entry.name
                            else "${pluginRoot.name}:${entry.name}"
                        val source = if (pluginRoot.name.startsWith("youcoded")) "youcoded-core" else "plugin"
                        addSkill(skillId, entry.name, "", source, pluginRoot.name)
                    }
                }
            }
        } catch (_: Exception) {}

        // 2. Scan installed plugins
        try {
            val installedPath = File(pluginsDir, "installed_plugins.json")
            val installed = JSONObject(installedPath.readText())
            val plugins = installed.optJSONObject("plugins") ?: JSONObject()
            val keys = plugins.keys()
            while (keys.hasNext()) {
                val pluginKey = keys.next()
                val versions = plugins.optJSONArray(pluginKey) ?: continue
                if (versions.length() == 0) continue
                val latest = versions.getJSONObject(0)
                val installPath = latest.optString("installPath", "") 
                if (installPath.isEmpty()) continue
                val pluginSlug = pluginKey.split("@")[0]

                // skills/ directory
                try {
                    File(installPath, "skills").listFiles()?.forEach { entry ->
                        if (entry.isDirectory) {
                            addSkill("$pluginSlug:${entry.name}", entry.name, "", "plugin", pluginSlug)
                        }
                    }
                } catch (_: Exception) {}

                // commands/ directory
                try {
                    File(installPath, "commands").listFiles()?.forEach { entry ->
                        if (entry.isDirectory) {
                            addSkill("$pluginSlug:${entry.name}", entry.name, "", "plugin", pluginSlug)
                        }
                    }
                } catch (_: Exception) {}
            }
        } catch (_: Exception) {}

        // Fix: do NOT inject curated-registry entries as if they were installed.
        // skill-registry.json is enrichment-only metadata. Injecting its entries
        // here was surfacing ~21 "pre-installed" skills on fresh installs whose
        // plugins weren't actually on disk — clicking them fired unknown slash
        // commands. Desktop already removed this behavior; see the comment on
        // desktop/src/main/skill-scanner.ts loadCuratedRegistry().
        return skills
    }

    private fun loadRegistry(): JSONObject {
        return try {
            val input = context.assets.open("web/data/skill-registry.json")
            val json = input.bufferedReader().use { it.readText() }
            JSONObject(json)
        } catch (e: Exception) {
            Log.w("SkillScanner", "skill-registry.json not found in assets", e)
            JSONObject()
        }
    }
}
