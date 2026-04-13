package com.destin.code.marketplace

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject

/**
 * Stores the marketplace OAuth token and signed-in user in SharedPreferences.
 *
 * WHY plain SharedPreferences instead of EncryptedSharedPreferences: the token is
 * a GitHub OAuth token scoped only to the DestinCode marketplace (no repo/email access).
 * It has no password-equivalent sensitivity, unlike the remote-pairing passwords which
 * use EncryptedSharedPreferences. Standard pref storage is sufficient here, matching
 * the desktop's plain keytar/localStorage approach.
 */

data class MarketplaceUser(
    val id: String,        // "github:<numeric id>"
    val login: String,
    val avatarUrl: String,
)

class MarketplaceAuthStore(private val prefs: SharedPreferences) {

    companion object {
        private const val KEY_TOKEN = "marketplace.token"
        private const val KEY_USER  = "marketplace.user"

        /** Factory — opens the dedicated SharedPreferences file. */
        fun create(context: Context): MarketplaceAuthStore {
            val prefs = context.getSharedPreferences("marketplace_auth", Context.MODE_PRIVATE)
            return MarketplaceAuthStore(prefs)
        }
    }

    fun getToken(): String? = prefs.getString(KEY_TOKEN, null)

    fun getUser(): MarketplaceUser? {
        // Reads the camelCase internal format — see setSession for why.
        val raw = prefs.getString(KEY_USER, null) ?: return null
        return try {
            val obj = JSONObject(raw)
            MarketplaceUser(
                id        = obj.getString("id"),
                login     = obj.getString("login"),
                avatarUrl = obj.getString("avatarUrl"),
            )
        } catch (_: Exception) { null }
    }

    /** Persist only the token (use setSession when you also have a user). */
    fun setToken(token: String) {
        prefs.edit().putString(KEY_TOKEN, token).apply()
    }

    /** Persist token + user atomically — called on successful auth:poll. */
    fun setSession(token: String, user: MarketplaceUser) {
        val userJson = JSONObject().apply {
            put("id",        user.id)
            put("login",     user.login)
            // WHY: internal storage format uses camelCase because Kotlin property names
            // match. The wire format to the React renderer uses snake_case avatar_url
            // (see SessionService's marketplace:auth:user handler). Never read this JSON
            // externally — the getUser() reader is the only consumer.
            put("avatarUrl", user.avatarUrl)
        }.toString()
        prefs.edit()
            .putString(KEY_TOKEN, token)
            .putString(KEY_USER, userJson)
            .apply()
    }

    /** Remove all stored credentials — called on sign-out. */
    fun signOut() {
        prefs.edit()
            .remove(KEY_TOKEN)
            .remove(KEY_USER)
            .apply()
    }
}
