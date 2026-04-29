package com.youcoded.app.skills

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class LocalSkillProvider(private val homeDir: File, private val context: Context) {

    val configStore = SkillConfigStore(homeDir)
    private val scanner = SkillScanner(homeDir, context)
    private val fetcher = MarketplaceFetcher(homeDir) { getBundledIndex() }
    private var installedCache: JSONArray? = null

    // Injected after construction — plugin installer for marketplace plugins
    var pluginInstaller: PluginInstaller? = null

    // Callback to reload plugins in active Claude Code session after install/uninstall
    var onPluginsChanged: (() -> Unit)? = null

    // Decomposition v3 §9.2: reconciles plugin hooks-manifest.json into
    // settings.json after install. Injected from SessionService (lives in
    // the runtime package, not skills).
    var hookReconciler: com.youcoded.app.runtime.HookReconciler? = null

    // Decomposition v3 §9.3: reconciles plugin mcp-manifest.json into
    // .claude.json mcpServers after install.
    var mcpReconciler: McpReconciler? = null

    private fun nowIso(): String =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).format(Date())

    fun getInstalled(): JSONArray {
        if (installedCache == null) {
            val scanned = scanner.scan()
            val privateSkills = configStore.getPrivateSkills()
            val combined = JSONArray()
            val seenIds = mutableSetOf<String>()
            // Track plugin ids that already have at least one scanned skill —
            // mirrors desktop's pluginsWithScannedSkills (skill-provider.ts
            // lines 174-178). Without this, the backfill below adds a phantom
            // plugin-level entry alongside the real skills (e.g. an
            // "Encyclopedia" placeholder card on top of its 5 individual skills).
            val pluginsWithScannedSkills = mutableSetOf<String>()
            for (i in 0 until scanned.length()) {
                val s = scanned.getJSONObject(i)
                combined.put(s); seenIds.add(s.optString("id"))
                val pluginName = s.optString("pluginName", "")
                if (pluginName.isNotEmpty()) pluginsWithScannedSkills.add(pluginName)
            }
            for (i in 0 until privateSkills.length()) {
                val s = privateSkills.getJSONObject(i)
                combined.put(s); seenIds.add(s.optString("id"))
            }
            // Include marketplace-installed plugins not already discovered
            // by scanner — but skip if the scanner already found their skills.
            val marketplaceInstalled = configStore.getInstalledPlugins()
            val keys = marketplaceInstalled.keys()
            while (keys.hasNext()) {
                val id = keys.next()
                if (seenIds.contains(id)) continue
                if (pluginsWithScannedSkills.contains(id)) continue
                val meta = marketplaceInstalled.optJSONObject(id) ?: continue
                val installPath = meta.optString("installPath", "")
                val dir = if (installPath.isNotEmpty()) File(installPath) else null
                combined.put(JSONObject().apply {
                    put("id", id)
                    put("type", "plugin")
                    put("displayName", id.split("-").joinToString(" ") { it.replaceFirstChar { c -> c.uppercase() } })
                    put("description", "Installed from ${meta.optString("installedFrom", "marketplace")}")
                    put("category", "other")
                    put("source", "marketplace")
                    put("visibility", "published")
                    put("installedAt", meta.optString("installedAt", ""))
                    if (dir != null && !dir.exists()) put("status", "missing")
                })
                seenIds.add(id)
            }
            installedCache = combined
        }
        val overrides = configStore.getOverrides()
        val result = JSONArray()
        val cache = installedCache!!
        for (i in 0 until cache.length()) {
            val skill = JSONObject(cache.getJSONObject(i).toString())
            val o = overrides.optJSONObject(skill.optString("id"))
            if (o != null) {
                val keys = o.keys()
                while (keys.hasNext()) { val key = keys.next(); skill.put(key, o.get(key)) }
            }
            result.put(skill)
        }
        return result
    }

    fun listMarketplace(filters: JSONObject?): JSONArray {
        val entries = fetcher.fetchIndex()
        val stats = fetcher.fetchStats()

        for (i in 0 until entries.length()) {
            val entry = entries.getJSONObject(i)
            val s = stats.optJSONObject(entry.optString("id"))
            if (s != null) {
                entry.put("installs", s.optInt("installs", 0))
                entry.put("rating", s.optDouble("rating", 0.0))
                entry.put("ratingCount", s.optInt("ratingCount", 0))
            }
        }

        val filterType = filters?.optString("type", "")?.takeIf { it.isNotEmpty() }
        val filterCategory = filters?.optString("category", "")?.takeIf { it.isNotEmpty() }
        val filterQuery = filters?.optString("query", "")?.takeIf { it.isNotEmpty() }?.lowercase()
        val filterSort = filters?.optString("sort", "popular") ?: "popular"

        val filtered = mutableListOf<JSONObject>()
        for (i in 0 until entries.length()) {
            val e = entries.getJSONObject(i)
            if (filterType != null && e.optString("type") != filterType) continue
            if (filterCategory != null && e.optString("category") != filterCategory) continue
            if (filterQuery != null) {
                val name = e.optString("displayName", "").lowercase()
                val desc = e.optString("description", "").lowercase()
                if (!name.contains(filterQuery) && !desc.contains(filterQuery)) continue
            }
            filtered.add(e)
        }

        val sorted = when (filterSort) {
            "newest" -> filtered.sortedByDescending { it.optString("updatedAt", "") }
            "rating" -> filtered.sortedByDescending { it.optDouble("rating", 0.0) }
            "name" -> filtered.sortedBy { it.optString("displayName", "") }
            else -> filtered.sortedByDescending { it.optInt("installs", 0) }
        }

        val installed = getInstalled()
        val installedIds = mutableSetOf<String>()
        for (i in 0 until installed.length()) installedIds.add(installed.getJSONObject(i).optString("id"))

        val result = JSONArray()
        for (e in sorted) {
            if (installedIds.contains(e.optString("id"))) {
                e.put("installedAt", e.optString("installedAt", nowIso()))
            }
            result.put(e)
        }
        return result
    }

    fun getSkillDetail(id: String): JSONObject {
        val index = fetcher.fetchIndex()
        var entry: JSONObject? = null
        for (i in 0 until index.length()) {
            if (index.getJSONObject(i).optString("id") == id) { entry = index.getJSONObject(i); break }
        }
        val installed = getInstalled()
        var localEntry: JSONObject? = null
        for (i in 0 until installed.length()) {
            if (installed.getJSONObject(i).optString("id") == id) { localEntry = installed.getJSONObject(i); break }
        }
        val base = entry ?: localEntry ?: throw Exception("Skill not found: $id")
        val result = JSONObject(base.toString())

        val stats = fetcher.fetchStats()
        val s = stats.optJSONObject(id)
        if (s != null) {
            result.put("installs", s.optInt("installs", 0))
            result.put("rating", s.optDouble("rating", 0.0))
            result.put("ratingCount", s.optInt("ratingCount", 0))
        }

        val override = configStore.getOverride(id)
        if (override != null) {
            val keys = override.keys()
            while (keys.hasNext()) { val key = keys.next(); result.put(key, override.get(key)) }
        }
        return result
    }

    fun search(query: String): JSONArray {
        val q = query.lowercase()
        val installed = getInstalled()
        val result = JSONArray()
        val seen = mutableSetOf<String>()

        for (i in 0 until installed.length()) {
            val s = installed.getJSONObject(i)
            val name = s.optString("displayName", "").lowercase()
            val desc = s.optString("description", "").lowercase()
            if (name.contains(q) || desc.contains(q)) {
                result.put(s); seen.add(s.optString("id"))
            }
        }

        try {
            val marketplace = listMarketplace(JSONObject().put("query", query))
            for (i in 0 until marketplace.length()) {
                val s = marketplace.getJSONObject(i)
                if (!seen.contains(s.optString("id"))) result.put(s)
            }
        } catch (_: Exception) {}

        return result
    }

    /** Look up a single marketplace entry by id. */
    fun getMarketplaceEntry(id: String): JSONObject? {
        val index = fetcher.fetchIndex()
        for (i in 0 until index.length()) {
            if (index.getJSONObject(i).optString("id") == id) {
                return index.getJSONObject(i)
            }
        }
        return null
    }

    /** Install a skill or plugin from the marketplace. Returns a JSON result with status. */
    suspend fun install(id: String): JSONObject {
        val index = fetcher.fetchIndex()
        var entry: JSONObject? = null
        for (i in 0 until index.length()) {
            if (index.getJSONObject(i).optString("id") == id) { entry = index.getJSONObject(i); break }
        }
        if (entry == null) return JSONObject().put("status", "failed").put("error", "Skill not found in marketplace: $id")

        if (entry.optString("type") == "prompt") {
            // Prompt skill — store directly in config
            val skill = JSONObject(entry.toString())
            skill.put("source", "marketplace")
            skill.put("visibility", "published")
            skill.put("installedAt", nowIso())
            configStore.createPromptSkill(skill)
            installedCache = null
            return JSONObject().put("status", "installed").put("type", "prompt")
        }

        // Plugin install — delegate to PluginInstaller (all sourceMarketplace values)
        val installer = pluginInstaller
            ?: return JSONObject().put("status", "failed").put("error", "Plugin installer not initialized")

        val result = installer.install(entry)
        val response = when (result) {
            is PluginInstaller.InstallResult.Success -> {
                installedCache = null
                // Notify active sessions so Claude Code discovers the new plugin
                onPluginsChanged?.invoke()
                // Also reconcile plugin hooks — the newly-installed package may
                // declare required hooks that need to land in settings.json.
                try { hookReconciler?.reconcile() } catch (e: Exception) {
                    android.util.Log.w("LocalSkillProvider", "hook reconcile after install failed", e)
                }
                // MCP reconcile — packages declaring auto:true servers land in .claude.json
                try { mcpReconciler?.reconcile() } catch (e: Exception) {
                    android.util.Log.w("LocalSkillProvider", "MCP reconcile after install failed", e)
                }
                JSONObject().put("status", "installed").put("type", "plugin")
            }
            is PluginInstaller.InstallResult.AlreadyInstalled ->
                JSONObject().put("status", "already_installed").put("via", result.via)
            is PluginInstaller.InstallResult.Failed ->
                JSONObject().put("status", "failed").put("error", result.error)
            is PluginInstaller.InstallResult.InProgress ->
                JSONObject().put("status", "installing")
        }
        return response
    }

    /**
     * Phase 3b: update an installed plugin/prompt to the latest marketplace
     * version. Re-runs install logic at the same path. Config in
     * ~/.claude/youcoded-config/<id>.json is NOT touched.
     */
    suspend fun update(id: String): JSONObject {
        val entry = getMarketplaceEntry(id)
            ?: return JSONObject().put("ok", false).put("error", "Skill not found in marketplace: $id")

        if (entry.optString("type") == "prompt") {
            // Prompt update: the config store private skill gets replaced
            configStore.updatePackageVersion(id, entry.optString("version", "1.0.0"))
            installedCache = null
            return JSONObject().put("ok", true).put("newVersion", entry.optString("version"))
        }

        // Plugin update: re-install at the same path
        val installer = pluginInstaller
            ?: return JSONObject().put("ok", false).put("error", "Plugin installer not initialized")

        val result = installer.install(entry)
        return when (result) {
            is PluginInstaller.InstallResult.Success,
            is PluginInstaller.InstallResult.AlreadyInstalled -> {
                configStore.updatePackageVersion(id, entry.optString("version", "1.0.0"))
                installedCache = null
                onPluginsChanged?.invoke()
                JSONObject().put("ok", true).put("newVersion", entry.optString("version"))
            }
            is PluginInstaller.InstallResult.Failed ->
                JSONObject().put("ok", false).put("error", result.error)
            is PluginInstaller.InstallResult.InProgress ->
                JSONObject().put("ok", false).put("error", "Update already in progress")
        }
    }

    /** Uninstall a skill or plugin. Returns a JSON result. */
    suspend fun uninstall(id: String): JSONObject {
        // Check if this is a marketplace-installed plugin
        val installer = pluginInstaller
        if (installer != null && installer.isInstalled(id)) {
            val ok = installer.uninstall(id)
            installedCache = null
            if (ok) {
                // Notify active sessions so Claude Code drops the plugin
                onPluginsChanged?.invoke()
            }
            return JSONObject().put("ok", ok).put("type", "plugin")
        }
        // Prompt skill uninstall
        configStore.deletePromptSkill(id)
        installedCache = null
        return JSONObject().put("ok", true).put("type", "prompt")
    }

    /**
     * Decomposition v3 §9.9: integration metadata for a skill id — used by
     * the detail view to render "Integrates with X (installed)" badges.
     * For installed plugins, reads plugin.json from disk. For non-installed,
     * falls back to the marketplace index entry.
     */
    fun getIntegrationInfo(id: String): JSONObject {
        // Scan both the core-toolkit clone root (~/.claude/plugins/<id>) AND
        // the marketplace subtree (~/.claude/plugins/marketplaces/youcoded/plugins/<id>).
        // See ClaudeCodeRegistry.listInstalledPluginDirs for why both matter.
        val pluginDirs = ClaudeCodeRegistry.listInstalledPluginDirs(homeDir)
        // Build capability → providing-package map across all installed plugins
        val providerMap = mutableMapOf<String, String>()
        pluginDirs.forEach { pluginDir ->
            val manifest = readPluginManifest(pluginDir) ?: return@forEach
            val provides = manifest.optJSONObject("provides") ?: return@forEach
            val keys = provides.keys()
            while (keys.hasNext()) {
                val cap = keys.next()
                providerMap.putIfAbsent(cap, manifest.optString("name"))
            }
        }

        // Try installed plugin manifest first; fall back to marketplace entry.
        // Match id against directory names from both roots.
        val manifest = pluginDirs.firstOrNull { it.name == id }?.let { readPluginManifest(it) }
        val rawProvides: JSONObject
        val rawOptional: JSONObject
        if (manifest != null) {
            rawProvides = manifest.optJSONObject("provides") ?: JSONObject()
            rawOptional = manifest.optJSONObject("optionalIntegrations") ?: JSONObject()
        } else {
            val entry = getMarketplaceEntry(id)
            rawProvides = entry?.optJSONObject("provides") ?: JSONObject()
            rawOptional = entry?.optJSONObject("optionalIntegrations") ?: JSONObject()
        }

        val providesArr = org.json.JSONArray()
        val provKeys = rawProvides.keys()
        while (provKeys.hasNext()) {
            val cap = provKeys.next()
            val spec = rawProvides.optJSONObject(cap) ?: continue
            providesArr.put(JSONObject().apply {
                put("capability", cap)
                put("description", spec.optString("description"))
                put("skill", spec.optString("skill"))
            })
        }

        val optionalArr = org.json.JSONArray()
        val optKeys = rawOptional.keys()
        while (optKeys.hasNext()) {
            val cap = optKeys.next()
            val spec = rawOptional.optJSONObject(cap) ?: continue
            val provider = providerMap[cap]
            optionalArr.put(JSONObject().apply {
                put("capability", cap)
                put("installed", provider != null)
                if (provider != null) put("providerPackageId", provider)
                put("whenAvailable", spec.optString("whenAvailable"))
                put("whenUnavailable", spec.optString("whenUnavailable"))
            })
        }

        return JSONObject().put("provides", providesArr).put("optionalIntegrations", optionalArr)
    }

    // Decomposition v3 §9.10: onboarding bulk install. Sequential (not parallel) so
    // the cache clone doesn't hit git lock contention. Survives individual failures
    // so one broken package doesn't block the rest of the curated set.
    suspend fun installMany(ids: List<String>): JSONArray {
        val results = JSONArray()
        for (id in ids) {
            val entry = JSONObject().put("id", id)
            try {
                val r = install(id)
                entry.put("status", r.optString("status", "ok"))
                if (r.has("error")) entry.put("error", r.optString("error"))
            } catch (e: Exception) {
                entry.put("status", "failed")
                entry.put("error", e.message ?: e.toString())
            }
            results.put(entry)
        }
        return results
    }

    /**
     * Install any bundled plugins that are missing. Runs fire-and-forget on
     * every launch; silent retry next launch on failure. installMany is
     * idempotent — already-installed plugins no-op.
     */
    suspend fun ensureBundledPluginsInstalled() {
        try {
            installMany(BundledPlugins.IDS)
        } catch (e: Exception) {
            Log.w("BundledPlugins", "ensure failed", e)
        }
    }

    // Decomposition v3 §9.10: write activeStyle to
    // ~/.claude/youcoded-config/youcoded-core-output-styles.json so session-start
    // picks it up on next launch. Onboarding calls this after style selection.
    fun applyOutputStyle(styleId: String) {
        val configDir = File(homeDir, ".claude/youcoded-config")
        configDir.mkdirs()
        File(configDir, "youcoded-core-output-styles.json")
            .writeText(JSONObject().put("activeStyle", styleId).toString(2))
    }

    private fun readPluginManifest(pluginDir: File): JSONObject? {
        val candidates = listOf(
            File(pluginDir, ".claude-plugin/plugin.json"),
            File(pluginDir, "plugin.json"),
        )
        for (f in candidates) {
            if (!f.exists()) continue
            try { return JSONObject(f.readText()) } catch (_: Exception) {}
        }
        return null
    }

    fun invalidateCache() { installedCache = null }
    fun getFavorites(): JSONArray = configStore.getFavorites()
    fun setFavorite(id: String, favorited: Boolean) = configStore.setFavorite(id, favorited)
    fun getThemeFavorites(): JSONArray = JSONArray(configStore.getThemeFavorites())
    fun setThemeFavorite(slug: String, favorited: Boolean) = configStore.setThemeFavorite(slug, favorited)
    fun getChips(): JSONArray = configStore.getChips()
    fun setChips(chips: JSONArray) = configStore.setChips(chips)
    fun getOverride(id: String): Any = configStore.getOverride(id) ?: JSONObject.NULL
    fun setOverride(id: String, override: JSONObject) { configStore.setOverride(id, override); installedCache = null }
    fun createPromptSkill(skill: JSONObject): JSONObject { val e = configStore.createPromptSkill(skill)!!; installedCache = null; return e }
    fun deletePromptSkill(id: String) { configStore.deletePromptSkill(id); installedCache = null }

    fun generateShareLink(id: String): String {
        val installed = getInstalled()
        var skill: JSONObject? = null
        for (i in 0 until installed.length()) {
            if (installed.getJSONObject(i).optString("id") == id) { skill = installed.getJSONObject(i); break }
        }
        if (skill == null) throw Exception("Skill not found: $id")
        if (skill.optString("visibility") == "private") throw Exception("Cannot share a private skill")

        val payload = JSONObject().apply {
            put("v", 1)
            put("type", skill.optString("type", "prompt"))
            put("displayName", skill.optString("displayName"))
            put("description", skill.optString("description"))
            if (skill.optString("type") == "prompt") {
                put("prompt", skill.optString("prompt"))
            } else {
                put("name", skill.optString("id"))
                put("repoUrl", skill.optString("repoUrl"))
            }
            put("category", skill.optString("category"))
            put("author", skill.optString("author"))
        }
        return SkillShareCodec.encode(payload)
    }

    /**
     * Import a skill from a share link.
     * @param confirm If false, returns a preview of the parsed skill without saving (for user confirmation).
     *                If true (default), decodes and saves the skill immediately.
     */
    fun importFromLink(url: String, confirm: Boolean = true): JSONObject {
        val payload = SkillShareCodec.decode(url) ?: throw Exception("Invalid share link")

        if (payload.optString("type") == "prompt") {
            val validCategories = setOf("personal", "work", "development", "admin", "other")
            val category = payload.optString("category").let { if (it in validCategories) it else "other" }
            val displayName = payload.optString("displayName", "Imported Skill").take(100)
            val description = payload.optString("description", "").take(500)
            val prompt = payload.optString("prompt", "").take(2000)
            if (prompt.isEmpty()) throw Exception("Share link contains no prompt")

            val skill = JSONObject().apply {
                put("displayName", displayName)
                put("description", description)
                put("prompt", prompt)
                put("category", category)
                put("source", "marketplace")
                put("type", "prompt")
                put("visibility", "shared")
                val author = payload.optString("author", "").take(100)
                if (author.isNotEmpty()) put("author", author)
                put("installedAt", nowIso())
            }

            if (!confirm) {
                // Return preview without saving — caller should show confirmation UI
                skill.put("requiresConfirmation", true)
                return skill
            }
            return configStore.createPromptSkill(skill)!!
        } else {
            throw Exception("Plugin import from link not yet implemented")
        }
    }

    fun getCuratedDefaults(): JSONArray {
        return try {
            val defaults = fetcher.fetchCuratedDefaults()
            if (defaults.length() > 0) defaults else getFallbackDefaults()
        } catch (_: Exception) {
            getFallbackDefaults()
        }
    }

    // Marketplace redesign Phase 1: expose featured (hero/rails) to the
    // shared React UI via the bridge.
    fun getFeatured(): JSONObject {
        return try { fetcher.fetchFeatured() } catch (_: Exception) { JSONObject() }
    }

    private fun getFallbackDefaults(): JSONArray {
        return try {
            val input = context.assets.open("web/data/skill-registry.json")
            val json = input.bufferedReader().use { it.readText() }
            val registry = JSONObject(json)
            val result = JSONArray()
            val keys = registry.keys()
            while (keys.hasNext()) result.put(keys.next())
            result
        } catch (_: Exception) {
            JSONArray()
        }
    }

    /** Convert bundled skill-registry.json into SkillEntry JSONArray for offline marketplace fallback */
    private fun getBundledIndex(): JSONArray {
        return try {
            val input = context.assets.open("web/data/skill-registry.json")
            val json = input.bufferedReader().use { it.readText() }
            val registry = JSONObject(json)
            val result = JSONArray()
            val keys = registry.keys()
            while (keys.hasNext()) {
                val id = keys.next()
                val meta = registry.getJSONObject(id)
                val entry = JSONObject(meta.toString())
                entry.put("id", id)
                if (!entry.has("type")) entry.put("type", "plugin")
                if (!entry.has("visibility")) entry.put("visibility", "published")
                result.put(entry)
            }
            result
        } catch (_: Exception) {
            JSONArray()
        }
    }

    fun ensureMigrated() {
        if (!configStore.configExists()) {
            val scanned = scanner.scan()
            val ids = JSONArray()
            for (i in 0 until scanned.length()) ids.put(scanned.getJSONObject(i).optString("id"))
            configStore.migrate(ids)
        }
    }
}
