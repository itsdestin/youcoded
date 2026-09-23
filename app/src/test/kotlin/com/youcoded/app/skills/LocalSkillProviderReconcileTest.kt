package com.youcoded.app.skills

import android.content.Context
import com.youcoded.app.runtime.Bootstrap
import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.mockito.Mockito.mock
import java.io.File
import kotlin.io.path.createTempDirectory

/**
 * Task B5 review round 2, Finding 1b: a real process kill mid-swap in
 * PluginInstaller.upgradeFromLocal() can leave ".upgrade-<id>" or ".old-<id>"
 * directories behind in the marketplace plugins dir. Finding 1a (see
 * ClaudeCodeRegistryTest) stops them from being scanned as phantom plugins,
 * but nothing previously cleared the litter itself — this pins
 * LocalSkillProvider.reconcileBundledPlugins()'s startup sweep, which
 * removes them on the very next launch.
 */
class LocalSkillProviderReconcileTest {
    private lateinit var tmpHome: File
    private lateinit var context: Context

    @Before
    fun setUp() {
        tmpHome = createTempDirectory(prefix = "youcoded-reconcile-").toFile()
        context = mock(Context::class.java)
    }

    @After
    fun tearDown() {
        tmpHome.deleteRecursively()
    }

    private fun write(path: String, content: String) {
        File(tmpHome, path).apply { parentFile?.mkdirs() }.writeText(content)
    }

    @Test
    fun `reconcile sweeps stale old and upgrade dirs but leaves real and unrelated dirs alone`() = runTest {
        val base = ".claude/plugins/marketplaces/youcoded/plugins"

        // Pre-populate the catalog cache (the FIRST fetchIndex() source, before
        // index.json or network). Seeding only index.json let the Worker request
        // stall for 30+ seconds and time out runTest under load. Include every
        // bundled id so the missing-entry retry cannot contact the network.
        // sourceType "none" makes install() hit
        // its "Unknown source type" branch immediately for every bundled id
        // (no git shell-out, no network) — irrelevant to what this test is
        // checking, which is the sweep that runs before any of that.
        val indexEntries = JSONArray()
        for (id in BundledPlugins.IDS) {
            indexEntries.put(JSONObject().put("id", id).put("sourceType", "none"))
        }
        write(
            ".claude/youcoded-marketplace-cache/catalog.json",
            JSONObject().put("fetchedAt", System.currentTimeMillis()).put("data", indexEntries.toString()).toString(),
        )
        // Pre-seed the marketplace CACHE REPO CLONE's own timestamp file
        // (fresh, well inside the 1h CACHE_REFRESH_MS gate) so
        // refreshLocalMarketplaceCache() takes its "already fresh, nothing to
        // do" shortcut and returns true — without this, the repo dir doesn't
        // exist, it tries to `git clone`, fails in this sandbox (no real git
        // binary / no network), and reconcile logs a Log.w warning that
        // crashes a plain JVM unit test (android.util.Log is unmocked here —
        // this project deliberately avoids Robolectric, see
        // MarketplaceAuthStoreTest's WHY comment). Irrelevant to what this
        // test checks.
        write(
            ".claude/youcoded-marketplace-cache/wecoded-marketplace/.youcoded-last-pull",
            System.currentTimeMillis().toString(),
        )

        // Stale leftovers from a killed prior upgrade of an unrelated id —
        // must be removed.
        write("$base/.old-some-plugin/plugin.json", """{"version":"0.9.0"}""")
        write("$base/.upgrade-some-plugin/plugin.json", """{"version":"1.1.0"}""")
        // A real, currently-installed plugin — must survive untouched.
        write("$base/youcoded-chatsearch/plugin.json", """{"version":"1.0.0"}""")
        write("$base/youcoded-chatsearch/marker.txt", "keep me")
        // An unrelated directory that merely starts with "old" / "upgrade"
        // but not the dot-prefixed staging names — must survive untouched
        // (the sweep is a prefix match on ".old-" / ".upgrade-", not a
        // substring match).
        write("$base/old-fashioned-plugin/plugin.json", """{"version":"1.0.0"}""")

        val provider = LocalSkillProvider(tmpHome, context)
        provider.pluginInstaller = PluginInstaller(tmpHome, mock(Bootstrap::class.java), SkillConfigStore(tmpHome))

        provider.reconcileBundledPlugins()

        assertFalse("stale .old-some-plugin must be swept", File(tmpHome, "$base/.old-some-plugin").exists())
        assertFalse("stale .upgrade-some-plugin must be swept", File(tmpHome, "$base/.upgrade-some-plugin").exists())
        assertTrue("real plugin dir must survive", File(tmpHome, "$base/youcoded-chatsearch").exists())
        assertTrue(
            "real plugin's own files must survive untouched",
            File(tmpHome, "$base/youcoded-chatsearch/marker.txt").exists(),
        )
        assertTrue(
            "unrelated directory sharing only a substring must survive",
            File(tmpHome, "$base/old-fashioned-plugin").exists(),
        )
    }
}
