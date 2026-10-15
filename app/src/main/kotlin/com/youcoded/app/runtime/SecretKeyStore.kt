package com.youcoded.app.runtime

import android.content.Context
import java.security.SecureRandom

/**
 * The key the backend seals saved API keys with (desktop/src/main/headless/electron-headless.ts → safeStorage).
 *
 * WHY (2026-10-14, Android clean rebuild): on a computer Electron's safeStorage uses the OS keychain; on the
 * phone the key is 32 random bytes made once and kept in the app's encrypted preferences, whose own key lives
 * in the Android Keystore. The backend gets it in its environment at each start and never writes it down.
 */
object SecretKeyStore {
    private const val PREF = "backend_secret_key"

    @Synchronized
    fun key(context: Context): String {
        val prefs = PairedDeviceStore.prefs(context)
        prefs.getString(PREF, null)?.takeIf { it.length == 64 }?.let { return it }
        val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val hex = bytes.joinToString("") { "%02x".format(it) }
        prefs.edit().putString(PREF, hex).commit()
        return hex
    }
}
