package com.youcoded.app.runtime

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys
import org.json.JSONArray

/**
 * The computers this phone has paired with, kept in encrypted preferences as a
 * JSON array of `{ name, host, port, password }`.
 *
 * WHY its own object: SessionService writes the list (the bridge's
 * android:*-paired-device channels), and WebViewHost now reads it too. The
 * Android app downloads a `/download/<token>` link only when it comes from a
 * computer the phone paired with (T8 review, finding 1: "any http(s) host" let
 * a link in the chat, or a previewed HTML page, save a stranger's file into
 * Downloads). One definition keeps the two from drifting apart.
 */
object PairedDeviceStore {
    private const val ENCRYPTED_PREFS = "remote_devices_encrypted"
    private const val LEGACY_PREFS = "remote_devices"
    private const val KEY = "paired_devices"
    private const val DEFAULT_PORT = 9900

    /**
     * The encrypted store, or the legacy plain one when the keystore is
     * unavailable — exactly the fallback SessionService has always used.
     */
    fun prefs(context: Context): SharedPreferences {
        val app = context.applicationContext
        return try {
            val masterKeyAlias = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC)
            EncryptedSharedPreferences.create(
                ENCRYPTED_PREFS,
                masterKeyAlias,
                app,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
        } catch (e: Exception) {
            android.util.Log.w("PairedDeviceStore", "EncryptedSharedPreferences unavailable, using fallback: ${e.message}")
            app.getSharedPreferences(LEGACY_PREFS, Context.MODE_PRIVATE)
        }
    }

    /**
     * Is host:port one of the paired computers? Reads the encrypted list, and
     * the legacy plain list a device paired before encryption may still hold
     * (SessionService migrates it only when the Settings screen lists devices).
     */
    fun isPaired(context: Context, host: String, port: Int): Boolean {
        val encrypted = try { prefs(context).getString(KEY, null) } catch (_: Exception) { null }
        if (matches(encrypted, host, port)) return true
        val legacy = try {
            context.applicationContext.getSharedPreferences(LEGACY_PREFS, Context.MODE_PRIVATE).getString(KEY, null)
        } catch (_: Exception) { null }
        return matches(legacy, host, port)
    }

    /**
     * Pure matcher, unit-tested. Host names compare case-insensitively (a URL
     * parser may lowercase what the user typed) and an IPv6 literal's brackets
     * are not part of the host. Anything unreadable matches nothing.
     */
    fun matches(devicesJson: String?, host: String, port: Int): Boolean {
        if (devicesJson.isNullOrEmpty()) return false
        val wanted = normalizeHost(host)
        if (wanted.isEmpty()) return false
        val devices = try { JSONArray(devicesJson) } catch (_: Exception) { return false }
        for (i in 0 until devices.length()) {
            val device = devices.optJSONObject(i) ?: continue
            val stored = normalizeHost(device.optString("host", ""))
            if (stored.isNotEmpty() && stored == wanted && device.optInt("port", DEFAULT_PORT) == port) return true
        }
        return false
    }

    private fun normalizeHost(host: String): String =
        host.trim().removePrefix("[").removeSuffix("]").lowercase()
}
