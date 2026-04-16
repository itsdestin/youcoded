package com.youcoded.app.skills

import org.json.JSONObject
import java.io.File

/**
 * Phase 3c: Per-entry config storage for marketplace packages.
 * Reads/writes ~/.claude/youcoded-config/<id>.json.
 *
 * Separate from the plugin's own config and from youcoded-skills.json.
 * Each marketplace entry that declares a configSchema gets its own file.
 */
class MarketplaceConfigStore(private val homeDir: File) {

    private val configDir: File get() = File(homeDir, ".claude/youcoded-config")

    /** Get the config values for a marketplace entry. */
    fun getConfig(id: String): JSONObject {
        return try {
            val file = File(configDir, "$id.json")
            if (file.exists()) JSONObject(file.readText()) else JSONObject()
        } catch (_: Exception) {
            JSONObject()
        }
    }

    /** Save config values for a marketplace entry. */
    fun setConfig(id: String, values: JSONObject) {
        configDir.mkdirs()
        val file = File(configDir, "$id.json")
        val tmp = File(file.absolutePath + ".tmp")
        tmp.writeText(values.toString(2))
        tmp.renameTo(file)
    }

    /** Delete config for a marketplace entry (used on uninstall). */
    fun deleteConfig(id: String) {
        try {
            val file = File(configDir, "$id.json")
            if (file.exists()) file.delete()
        } catch (_: Exception) {
            // best-effort
        }
    }
}
