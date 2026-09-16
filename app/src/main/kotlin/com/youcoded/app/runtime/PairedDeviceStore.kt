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
     * Built once and kept. WHY (T8 re-review, finding 4): rebuilding it means a
     * keystore call and a key decryption, and WebViewHost asks from the main
     * thread for every download-shaped link; two threads building it at once is
     * also a known EncryptedSharedPreferences hazard, hence the lock.
     */
    @Volatile private var encrypted: SharedPreferences? = null

    /**
     * The encrypted store, or the legacy plain one when the keystore is
     * unavailable — exactly the fallback SessionService has always used. Only a
     * successfully built encrypted store is kept, so a transient keystore failure
     * is retried next time rather than remembered.
     */
    fun prefs(context: Context): SharedPreferences {
        encrypted?.let { return it }
        val app = context.applicationContext
        return try {
            synchronized(this) {
                encrypted ?: EncryptedSharedPreferences.create(
                    ENCRYPTED_PREFS,
                    MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC),
                    app,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
                ).also { encrypted = it }
            }
        } catch (e: Exception) {
            android.util.Log.w("PairedDeviceStore", "EncryptedSharedPreferences unavailable, using fallback: ${e.message}")
            app.getSharedPreferences(LEGACY_PREFS, Context.MODE_PRIVATE)
        }
    }

    /** Is host:port one of the paired computers? */
    fun isPaired(context: Context, host: String, port: Int): Boolean {
        val app = context.applicationContext
        val stored = try { prefs(app).getString(KEY, null) } catch (_: Exception) { null }
        val json = effectiveDevicesJson(stored) {
            try { app.getSharedPreferences(LEGACY_PREFS, Context.MODE_PRIVATE).getString(KEY, null) } catch (_: Exception) { null }
        }
        return matches(json, host, port)
    }

    /**
     * The list that counts: the encrypted one whenever it exists — even when it
     * is empty — and the old unencrypted one only before any encrypted list was
     * written, which is exactly when SessionService would migrate it. WHY
     * (T8 re-review, finding 3): Remove edits only the encrypted list, so reading
     * the old list as well kept a removed computer trusted for good.
     */
    fun effectiveDevicesJson(encryptedJson: String?, legacy: () -> String?): String? =
        encryptedJson ?: legacy()

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
