package com.destins.claudemobile.config

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class ApiKeyStore(context: Context) {
    private val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val prefs = EncryptedSharedPreferences.create(
        context,
        "claude_secrets",
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    var anthropicApiKey: String?
        get() = prefs.getString("anthropic_api_key", null)
        set(value) = prefs.edit().putString("anthropic_api_key", value).apply()

    val hasApiKey: Boolean get() = !anthropicApiKey.isNullOrBlank()
}
