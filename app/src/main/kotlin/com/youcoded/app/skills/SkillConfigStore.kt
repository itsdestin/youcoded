package com.youcoded.app.skills

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Reads/writes ~/.claude/youcoded-skills.json.
 * Provides favorites, chips, overrides, and private prompt-skill storage.
 */
class SkillConfigStore(private val homeDir: File) {

    private val configFile: File get() = File(homeDir, ".claude/youcoded-skills.json")
    private var config: JSONObject = JSONObject()

    companion object {
        private const val MAX_CHIPS = 10
        private const val MAX_PRIVATE_SKILLS = 100

        // Shape mirrors desktop/src/main/skill-config-store.ts DEFAULT_CHIPS —
        // React's QuickChips maps c.label and c.prompt, so chips MUST be
        // objects, not bare strings. Seeding strings (the old shape) produced
        // chips with undefined labels on fresh Android installs.
        private fun defaultChipsJson(): JSONArray = JSONArray().apply {
            put(JSONObject().put("skillId", "journaling-assistant").put("label", "Journal").put("prompt", "let's journal"))
            put(JSONObject().put("skillId", "claudes-inbox").put("label", "Inbox").put("prompt", "check my inbox"))
            put(JSONObject().put("label", "Git Status").put("prompt", "run git status and summarize what's changed"))
            put(JSONObject().put("label", "Review PR").put("prompt", "review the latest PR on this repo"))
            put(JSONObject().put("label", "Fix Tests").put("prompt", "run the tests and fix any failures"))
            put(JSONObject().put("skillId", "encyclopedia-librarian").put("label", "Briefing").put("prompt", "brief me on "))
            put(JSONObject().put("label", "Draft Text").put("prompt", "help me draft a text to "))
        }
    }

    fun configExists(): Boolean = configFile.exists()

    fun load() {
        if (!configFile.exists()) {
            migrate(JSONArray())
            return
        }
        try {
            val text = configFile.readText()
            config = JSONObject(text)
            // Auto-migrate v1 → v2: convert installed_plugins to packages
            val version = config.optInt("version", 1)
            if (version < 2) {
                migrateV1toV2()
            }
            // Ensure packages field exists
            if (!config.has("packages")) {
                config.put("packages", JSONObject())
            }
            // Phase 6: one-time migration of toolkit layers + community themes
            if (!config.optBoolean("migrated", false)) {
                migrateExistingInstalls()
            }
            // Fix: existing installs have chips stored as bare label strings
            // (old migrate() bug). React expects {label, prompt} objects —
            // promote the legacy string-chips to the canonical shape once.
            migrateLegacyStringChips()
        } catch (_: Exception) {
            // Back up corrupt file
            val bak = File(configFile.absolutePath + ".bak")
            try { configFile.copyTo(bak, overwrite = true) } catch (_: Exception) {}
            migrate(JSONArray())
        }
    }

    /**
     * Phase 6: Migrate existing toolkit layer installs and community themes
     * into the unified packages map. Runs once, guarded by `migrated` flag.
     * Non-destructive — only adds entries, never deletes files or overwrites
     * existing package entries.
     */
    private fun migrateExistingInstalls() {
        val packages = config.optJSONObject("packages") ?: JSONObject()
        val now = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US)
            .apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }
            .format(java.util.Date())

        // --- Toolkit layers ---
        try {
            val toolkitConfigFile = File(homeDir, ".claude/toolkit-state/config.json")
            if (toolkitConfigFile.exists()) {
                val toolkitConfig = JSONObject(toolkitConfigFile.readText())
                val installedLayers = toolkitConfig.optJSONArray("installed_layers") ?: JSONArray()
                val toolkitRoot = toolkitConfig.optString("toolkit_root", "")

                for (i in 0 until installedLayers.length()) {
                    val layer = installedLayers.optString(i) ?: continue
                    val layerName = "youcoded-core-$layer"

                    // Don't overwrite existing package entries (idempotent)
                    if (packages.has(layerName)) continue

                    // Determine layer directory path from toolkit root
                    val layerDir = if (toolkitRoot.isNotEmpty()) {
                        File(toolkitRoot, layer)
                    } else {
                        File(homeDir, ".claude/plugins/youcoded-core/$layer")
                    }

                    // Verify the layer directory actually exists
                    if (!layerDir.exists()) {
                        android.util.Log.w("SkillConfigStore", "Migration: skipping layer \"$layer\" — directory not found at ${layerDir.absolutePath}")
                        continue
                    }

                    // Try to read version from the layer's plugin.json
                    var version = "0.1.0"
                    try {
                        val pluginJson = JSONObject(File(layerDir, "plugin.json").readText())
                        val v = pluginJson.optString("version", "")
                        if (v.isNotEmpty()) version = v
                    } catch (_: Exception) {
                        // Fallback to default version
                    }

                    // Core layer is not removable; other layers are
                    val removable = layer != "core"

                    packages.put(layerName, JSONObject().apply {
                        put("version", version)
                        put("source", "marketplace")
                        put("installedAt", now)
                        put("removable", removable)
                        put("components", JSONArray().put(JSONObject().apply {
                            put("type", "plugin")
                            put("path", layerDir.absolutePath)
                        }))
                    })
                }
            }
        } catch (e: Exception) {
            android.util.Log.w("SkillConfigStore", "Migration: failed to read toolkit config, skipping layers", e)
        }

        // --- Community themes ---
        try {
            val themesDir = File(homeDir, ".claude/wecoded-themes")
            if (themesDir.exists() && themesDir.isDirectory) {
                val themeDirs = themesDir.listFiles()?.filter { it.isDirectory } ?: emptyList()
                for (themeDir in themeDirs) {
                    val slug = themeDir.name
                    val packageKey = "theme:$slug"

                    // Don't overwrite existing package entries (idempotent)
                    if (packages.has(packageKey)) continue

                    val manifestFile = File(themeDir, "manifest.json")
                    if (!manifestFile.exists()) continue

                    try {
                        val manifest = JSONObject(manifestFile.readText())
                        val source = manifest.optString("source", "")

                        // Skip built-in themes (youcoded-core or missing source)
                        if (source.isEmpty() || source == "youcoded-core") continue

                        // Map manifest source to package source
                        val pkgSource = if (source == "community") "marketplace"
                            else if (source == "user") "user"
                            else "marketplace"

                        packages.put(packageKey, JSONObject().apply {
                            put("version", manifest.optString("version", "1.0.0"))
                            put("source", pkgSource)
                            put("installedAt", now)
                            put("removable", true)
                            put("components", JSONArray().put(JSONObject().apply {
                                put("type", "theme")
                                put("path", themeDir.absolutePath)
                            }))
                        })
                    } catch (e: Exception) {
                        android.util.Log.w("SkillConfigStore", "Migration: skipping theme \"$slug\" — corrupt manifest", e)
                    }
                }
            }
        } catch (e: Exception) {
            android.util.Log.w("SkillConfigStore", "Migration: failed to scan themes directory, skipping themes", e)
        }

        // Mark migration complete and persist
        config.put("packages", packages)
        config.put("migrated", true)
        save()
    }

    // Migrate v1 → v2: convert installed_plugins to packages format
    private fun migrateV1toV2() {
        val oldPlugins = config.optJSONObject("installed_plugins") ?: JSONObject()
        val packages = JSONObject()

        val keys = oldPlugins.keys()
        while (keys.hasNext()) {
            val id = keys.next()
            val meta = oldPlugins.optJSONObject(id) ?: continue
            val pluginsDir = File(homeDir, ".claude/plugins/$id")
            packages.put(id, JSONObject().apply {
                put("version", "1.0.0")
                put("source", "marketplace")
                put("installedAt", meta.optString("installedAt", ""))
                put("removable", true)
                put("components", JSONArray().put(JSONObject().apply {
                    put("type", "plugin")
                    put("path", meta.optString("installPath", pluginsDir.absolutePath))
                }))
            })
        }

        config.remove("installed_plugins")
        config.put("version", 2)
        config.put("packages", packages)
        save()
    }

    /**
     * Promote legacy bare-string chips (e.g. ["Journal", "Inbox", ...]) to
     * the canonical `{label, prompt, skillId?}` shape React expects. Matches
     * entries to defaultChipsJson() by label so users keep their seeded
     * prompts and skillIds; unknown labels keep the label with an empty
     * prompt. Idempotent — does nothing if chips are already objects.
     */
    private fun migrateLegacyStringChips() {
        val current = config.optJSONArray("chips") ?: return
        if (current.length() == 0) return
        // Sniff first element — if it's already a JSONObject, nothing to do.
        if (current.opt(0) is JSONObject) return

        val defaults = defaultChipsJson()
        val defaultsByLabel = mutableMapOf<String, JSONObject>()
        for (i in 0 until defaults.length()) {
            val c = defaults.getJSONObject(i)
            defaultsByLabel[c.optString("label")] = c
        }

        val upgraded = JSONArray()
        for (i in 0 until current.length()) {
            val label = current.optString(i).takeIf { it.isNotEmpty() } ?: continue
            val seeded = defaultsByLabel[label]
            if (seeded != null) {
                upgraded.put(JSONObject(seeded.toString()))
            } else {
                upgraded.put(JSONObject().put("label", label).put("prompt", ""))
            }
        }
        config.put("chips", upgraded)
        save()
    }

    fun reload() {
        load()
    }

    fun migrate(existingSkillIds: JSONArray) {
        config = JSONObject().apply {
            put("favorites", JSONArray())
            put("chips", defaultChipsJson())
            put("overrides", JSONObject())
            put("privateSkills", JSONArray())
        }
        save()
    }

    fun save() {
        configFile.parentFile?.mkdirs()
        val tmp = File(configFile.absolutePath + ".tmp")
        tmp.writeText(config.toString(2))
        tmp.renameTo(configFile)
    }

    // ── Favorites ──────────────────────────────────────────────────

    fun getFavorites(): JSONArray = config.optJSONArray("favorites") ?: JSONArray()

    fun setFavorite(skillId: String, favorite: Boolean) {
        val favs = getFavorites()
        val existing = mutableListOf<String>()
        for (i in 0 until favs.length()) {
            existing.add(favs.getString(i))
        }
        if (favorite && skillId !in existing) {
            existing.add(skillId)
        } else if (!favorite) {
            existing.remove(skillId)
        }
        config.put("favorites", JSONArray(existing))
        save()
    }

    // ── Chips ──────────────────────────────────────────────────────

    fun getChips(): JSONArray = config.optJSONArray("chips") ?: defaultChipsJson()

    fun setChips(chips: JSONArray) {
        val limited = JSONArray()
        val count = minOf(chips.length(), MAX_CHIPS)
        for (i in 0 until count) {
            limited.put(chips.get(i))
        }
        config.put("chips", limited)
        save()
    }

    // ── Overrides ──────────────────────────────────────────────────

    fun getOverrides(): JSONObject = config.optJSONObject("overrides") ?: JSONObject()

    fun getOverride(skillId: String): JSONObject? =
        getOverrides().optJSONObject(skillId)

    fun setOverride(skillId: String, overrideData: JSONObject) {
        val overrides = getOverrides()
        overrides.put(skillId, overrideData)
        config.put("overrides", overrides)
        save()
    }

    // ── Private / Prompt Skills ────────────────────────────────────

    fun getPrivateSkills(): JSONArray =
        config.optJSONArray("privateSkills") ?: JSONArray()

    fun createPromptSkill(skill: JSONObject): JSONObject? {
        val skills = getPrivateSkills()
        if (skills.length() >= MAX_PRIVATE_SKILLS) return null
        skills.put(skill)
        config.put("privateSkills", skills)
        save()
        return skill
    }

    // ── Packages (unified marketplace tracking, replaces installed_plugins) ──

    fun getPackages(): JSONObject =
        config.optJSONObject("packages") ?: JSONObject()

    fun getPackage(id: String): JSONObject? =
        getPackages().optJSONObject(id)

    /**
     * Decomposition v3 §9.8: return packages with status computed from disk
     * presence. After cross-device sync, Android may have a desktop-installed
     * package in config but no files on disk yet — surface that as "pending"
     * so the UI can show an Install CTA.
     */
    fun getPackagesWithStatus(): JSONObject {
        val packages = getPackages()
        val result = JSONObject()
        val keys = packages.keys()
        while (keys.hasNext()) {
            val id = keys.next()
            val pkg = packages.optJSONObject(id) ?: continue
            val components = pkg.optJSONArray("components")
            var onDisk = true
            if (components != null) {
                for (i in 0 until components.length()) {
                    val c = components.optJSONObject(i) ?: continue
                    if (c.optString("type") == "plugin") {
                        onDisk = java.io.File(c.optString("path")).exists()
                        break
                    }
                }
            }
            // Clone + annotate without mutating the stored object
            val copy = JSONObject(pkg.toString())
            copy.put("status", if (onDisk) "installed" else "pending")
            result.put(id, copy)
        }
        return result
    }

    fun recordPackageInstall(id: String, pkg: JSONObject) {
        val packages = getPackages()
        packages.put(id, pkg)
        config.put("packages", packages)
        save()
    }

    // Phase 3b: update just the version after a successful update.
    // Does NOT touch components, config, or other metadata.
    fun updatePackageVersion(id: String, newVersion: String) {
        val packages = getPackages()
        val pkg = packages.optJSONObject(id) ?: return
        pkg.put("version", newVersion)
        config.put("packages", packages)
        save()
    }

    fun removePackage(id: String) {
        val packages = getPackages()
        packages.remove(id)
        config.put("packages", packages)

        // Cascade: remove from favorites, chips, overrides
        val favs = getFavorites()
        val filteredFavs = JSONArray()
        for (i in 0 until favs.length()) {
            val fid = favs.optString(i)
            if (fid != id) filteredFavs.put(fid)
        }
        config.put("favorites", filteredFavs)

        val chips = getChips()
        val filteredChips = JSONArray()
        for (i in 0 until chips.length()) {
            val chip = chips.optString(i)
            if (chip != id) filteredChips.put(chip)
        }
        config.put("chips", filteredChips)

        val overrides = getOverrides()
        overrides.remove(id)
        config.put("overrides", overrides)

        save()
    }

    // ── Legacy API (wraps packages for backwards compat with callers) ──

    fun getInstalledPlugins(): JSONObject {
        // Return packages that have a plugin component, shaped like old API
        val packages = getPackages()
        val result = JSONObject()
        val keys = packages.keys()
        while (keys.hasNext()) {
            val id = keys.next()
            val pkg = packages.optJSONObject(id) ?: continue
            val components = pkg.optJSONArray("components") ?: continue
            for (i in 0 until components.length()) {
                val comp = components.optJSONObject(i) ?: continue
                if (comp.optString("type") == "plugin") {
                    result.put(id, JSONObject().apply {
                        put("installedAt", pkg.optString("installedAt"))
                        put("installPath", comp.optString("path"))
                    })
                    break
                }
            }
        }
        return result
    }

    fun recordPluginInstall(id: String, meta: JSONObject) {
        // Bridge to packages API
        val pluginsDir = File(homeDir, ".claude/plugins/$id")
        val pkg = JSONObject().apply {
            put("version", "1.0.0")
            put("source", "marketplace")
            put("installedAt", meta.optString("installedAt", ""))
            put("removable", true)
            put("components", JSONArray().put(JSONObject().apply {
                put("type", "plugin")
                put("path", meta.optString("installPath", pluginsDir.absolutePath))
            }))
        }
        recordPackageInstall(id, pkg)
    }

    fun removePluginInstall(id: String) {
        removePackage(id)
    }

    // ── Prompt Skills ─────────────────────────────────────────────

    fun deletePromptSkill(skillId: String) {
        // Remove from privateSkills
        val skills = getPrivateSkills()
        val filtered = JSONArray()
        for (i in 0 until skills.length()) {
            val s = skills.optJSONObject(i)
            if (s != null && s.optString("id") != skillId) {
                filtered.put(s)
            }
        }
        config.put("privateSkills", filtered)

        // Cascade: remove from favorites
        val favs = getFavorites()
        val filteredFavs = JSONArray()
        for (i in 0 until favs.length()) {
            val id = favs.optString(i)
            if (id != skillId) filteredFavs.put(id)
        }
        config.put("favorites", filteredFavs)

        // Cascade: remove from chips
        val chips = getChips()
        val filteredChips = JSONArray()
        for (i in 0 until chips.length()) {
            val chip = chips.optString(i)
            if (chip != skillId) filteredChips.put(chip)
        }
        config.put("chips", filteredChips)

        // Cascade: remove from overrides
        val overrides = getOverrides()
        overrides.remove(skillId)
        config.put("overrides", overrides)

        save()
    }
}
