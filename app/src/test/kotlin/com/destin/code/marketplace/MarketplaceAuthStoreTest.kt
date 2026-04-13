package com.destin.code.marketplace

import android.content.SharedPreferences
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * Unit tests for MarketplaceAuthStore using an in-memory SharedPreferences fake.
 * WHY no Robolectric: existing tests in this project use plain JUnit + org.json —
 * no Android framework deps. We inject a fake SharedPreferences to stay consistent.
 */
class MarketplaceAuthStoreTest {

    /** Minimal in-memory SharedPreferences fake — no Android framework needed. */
    private class FakePrefs : SharedPreferences {
        private val map = mutableMapOf<String, Any?>()
        private val editor = object : SharedPreferences.Editor {
            override fun putString(key: String, value: String?) = apply { map[key] = value }
            override fun putInt(key: String, value: Int) = apply { map[key] = value }
            override fun putLong(key: String, value: Long) = apply { map[key] = value }
            override fun putFloat(key: String, value: Float) = apply { map[key] = value }
            override fun putBoolean(key: String, value: Boolean) = apply { map[key] = value }
            override fun putStringSet(key: String, values: MutableSet<String>?) = apply { map[key] = values }
            override fun remove(key: String) = apply { map.remove(key) }
            override fun clear() = apply { map.clear() }
            override fun commit(): Boolean = true
            override fun apply() { /* in-memory, no async needed */ }
        }
        override fun contains(key: String) = map.containsKey(key)
        override fun getAll(): MutableMap<String, *> = map
        override fun getString(key: String, defValue: String?) = (map[key] as? String) ?: defValue
        override fun getInt(key: String, defValue: Int) = (map[key] as? Int) ?: defValue
        override fun getLong(key: String, defValue: Long) = (map[key] as? Long) ?: defValue
        override fun getFloat(key: String, defValue: Float) = (map[key] as? Float) ?: defValue
        override fun getBoolean(key: String, defValue: Boolean) = (map[key] as? Boolean) ?: defValue
        override fun getStringSet(key: String, defValues: MutableSet<String>?) = (map[key] as? MutableSet<String>) ?: defValues
        override fun registerOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) {}
        override fun unregisterOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) {}
        override fun edit(): SharedPreferences.Editor = editor
    }

    private lateinit var prefs: FakePrefs
    private lateinit var store: MarketplaceAuthStore

    @Before
    fun setUp() {
        prefs = FakePrefs()
        store = MarketplaceAuthStore(prefs)
    }

    @Test
    fun `getToken returns null when nothing stored`() {
        assertNull(store.getToken())
    }

    @Test
    fun `setToken persists and getToken retrieves`() {
        store.setToken("gh_tok_abc123")
        assertEquals("gh_tok_abc123", store.getToken())
    }

    @Test
    fun `getUser returns null when nothing stored`() {
        assertNull(store.getUser())
    }

    @Test
    fun `setSession persists token and user`() {
        val user = MarketplaceUser(id = "github:42", login = "destin", avatarUrl = "https://example.com/a.png")
        store.setSession("gh_tok_xyz", user)

        assertEquals("gh_tok_xyz", store.getToken())
        val retrieved = store.getUser()
        assertNotNull(retrieved)
        assertEquals("github:42", retrieved!!.id)
        assertEquals("destin", retrieved.login)
        assertEquals("https://example.com/a.png", retrieved.avatarUrl)
    }

    @Test
    fun `signOut removes token and user`() {
        store.setSession("gh_tok", MarketplaceUser("github:1", "user", "https://example.com/a.png"))
        store.signOut()

        assertNull(store.getToken())
        assertNull(store.getUser())
    }

    @Test
    fun `getUser returns null when stored JSON is malformed`() {
        // Force a broken user JSON via the prefs directly
        prefs.edit().putString("marketplace.user", "not-valid-json").apply()
        assertNull(store.getUser())
    }

    @Test
    fun `setToken does not affect stored user`() {
        val user = MarketplaceUser("github:7", "alice", "https://example.com/b.png")
        store.setSession("old_token", user)
        store.setToken("new_token")

        assertEquals("new_token", store.getToken())
        // User should still be present — setToken doesn't touch user prefs
        assertNotNull(store.getUser())
        assertEquals("alice", store.getUser()!!.login)
    }
}
