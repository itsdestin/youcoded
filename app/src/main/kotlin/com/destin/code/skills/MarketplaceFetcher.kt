package com.destin.code.skills

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URL

class MarketplaceFetcher(
    private val homeDir: File,
    private val bundledIndexProvider: (() -> JSONArray)? = null,
) {

    private val cacheDir = File(homeDir, ".claude/destincode-marketplace-cache")
    private val registryBase = "https://raw.githubusercontent.com/itsdestin/destincode-marketplace/main"
    private val statsTtl = 60 * 60 * 1000L       // 1 hour
    private val indexTtl = 24 * 60 * 60 * 1000L   // 24 hours

    init {
        if (!cacheDir.exists()) cacheDir.mkdirs()
    }

    fun fetchIndex(): JSONArray {
        val cacheFile = File(cacheDir, "index.json")
        readCache(cacheFile, indexTtl)?.let {
            return try { JSONArray(it) } catch (_: Exception) { JSONArray() }
        }
        return try {
            val data = URL("$registryBase/index.json").readText()
            val arr = JSONArray(data)
            writeCache(cacheFile, data)
            arr
        } catch (e: Exception) {
            Log.w("MarketplaceFetcher", "Failed to fetch index", e)
            readCache(cacheFile, Long.MAX_VALUE)?.let {
                try { JSONArray(it) } catch (_: Exception) { JSONArray() }
            } ?: bundledIndexProvider?.invoke() ?: JSONArray()
        }
    }

    fun fetchStats(): JSONObject {
        val cacheFile = File(cacheDir, "stats.json")
        readCache(cacheFile, statsTtl)?.let {
            return try { JSONObject(it) } catch (_: Exception) { JSONObject() }
        }
        return try {
            val data = URL("$registryBase/stats.json").readText()
            val obj = JSONObject(data)
            val skills = obj.optJSONObject("skills") ?: JSONObject()
            writeCache(cacheFile, skills.toString())
            skills
        } catch (e: Exception) {
            Log.w("MarketplaceFetcher", "Failed to fetch stats", e)
            readCache(cacheFile, Long.MAX_VALUE)?.let {
                try { JSONObject(it) } catch (_: Exception) { JSONObject() }
            } ?: JSONObject()
        }
    }

    fun fetchCuratedDefaults(): JSONArray {
        val cacheFile = File(cacheDir, "curated-defaults.json")
        readCache(cacheFile, indexTtl)?.let {
            return try { JSONArray(it) } catch (_: Exception) { JSONArray() }
        }
        return try {
            val data = URL("$registryBase/curated-defaults.json").readText()
            val obj = JSONObject(data)
            val defaults = obj.optJSONArray("defaults") ?: JSONArray()
            writeCache(cacheFile, defaults.toString())
            defaults
        } catch (e: Exception) {
            Log.w("MarketplaceFetcher", "Failed to fetch curated defaults", e)
            readCache(cacheFile, Long.MAX_VALUE)?.let {
                try { JSONArray(it) } catch (_: Exception) { JSONArray() }
            } ?: JSONArray()
        }
    }

    private fun readCache(file: File, ttl: Long): String? {
        return try {
            val raw = file.readText()
            val obj = JSONObject(raw)
            val fetchedAt = obj.optLong("fetchedAt", 0)
            if (System.currentTimeMillis() - fetchedAt > ttl) return null
            obj.optString("data", null)
        } catch (_: Exception) {
            null
        }
    }

    private fun writeCache(file: File, data: String) {
        try {
            file.writeText(JSONObject().apply {
                put("fetchedAt", System.currentTimeMillis())
                put("data", data)
            }.toString())
        } catch (_: Exception) { /* best-effort */ }
    }
}
