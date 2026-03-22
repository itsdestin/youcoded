package com.destin.code.config

import android.content.Context

/**
 * Stores the user's selected package tier in SharedPreferences.
 * Not encrypted — tier selection is not sensitive data.
 */
class TierStore(context: Context) {
    private val prefs = context.getSharedPreferences("destincode_tiers", Context.MODE_PRIVATE)

    var selectedTier: PackageTier
        get() {
            val name = prefs.getString("tier", null) ?: return PackageTier.CORE
            return try { PackageTier.valueOf(name) } catch (_: Exception) { PackageTier.CORE }
        }
        set(value) = prefs.edit().putString("tier", value.name).apply()

    /** True if user has explicitly chosen a tier (even if they chose CORE). */
    val hasSelected: Boolean
        get() = prefs.contains("tier")
}
