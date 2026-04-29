package com.youcoded.app.skills

import android.content.Context
import android.content.res.AssetManager
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.mockito.Mockito.mock
import org.mockito.Mockito.`when`
import java.io.ByteArrayInputStream
import java.io.File

/**
 * Tests LocalSkillProvider.getInstalled() backfill behavior — specifically the
 * pluginsWithScannedSkills filter that mirrors desktop/src/main/skill-provider.ts
 * lines 174-178 + 182.
 *
 * Pre-fix bug: When marketplace plugins like youcoded-encyclopedia were installed,
 * the scanner emitted entries for each individual skill (e.g. youcoded-encyclopedia:journal),
 * but configStore.getInstalledPlugins() also returned the plugin id. Since seenIds only
 * tracked skill ids (not plugin ids), the backfill loop added a phantom plugin-level
 * entry alongside the real skills — surfacing as both an "Encyclopedia" placeholder card
 * AND its 5 real skill cards in the marketplace UI.
 */
class LocalSkillProviderInstalledTest {

    private lateinit var tmpHome: File
    private lateinit var context: Context

    @Before
    fun setUp() {
        tmpHome = createTempDir(prefix = "youcoded-localprov-")
        context = mock(Context::class.java)
        val assets = mock(AssetManager::class.java)
        `when`(context.assets).thenReturn(assets)
        `when`(assets.open("web/data/skill-registry.json"))
            .thenReturn(ByteArrayInputStream("{}".toByteArray()))
    }

    @After
    fun tearDown() { tmpHome.deleteRecursively() }

    private fun mkdirs(path: String) = File(tmpHome, path).apply { mkdirs() }
    private fun write(path: String, content: String) {
        File(tmpHome, path).apply { parentFile?.mkdirs() }.writeText(content)
    }

    /**
     * Writes ~/.claude/youcoded-skills.json in the canonical v2 packages schema
     * for a single plugin component. SkillConfigStore.getInstalledPlugins() reads
     * the `packages` map and projects entries with a plugin component into the
     * legacy {installedAt, installPath} shape — that's the shape LocalSkillProvider
     * consumes.
     */
    private fun writePackageConfig(pluginId: String, installPath: String, installedAt: String) {
        val absInstall = installPath.replace("\\", "\\\\")
        write(".claude/youcoded-skills.json", """
            {
              "version": 2,
              "packages": {
                "$pluginId": {
                  "version": "1.0.0",
                  "source": "marketplace",
                  "installedAt": "$installedAt",
                  "removable": true,
                  "components": [
                    {"type": "plugin", "path": "$absInstall"}
                  ]
                }
              }
            }
        """.trimIndent())
    }

    @Test
    fun `does not emit phantom plugin-level entry when scanner found that plugin's skills`() {
        // Plugin 'imessage' has skill 'send-message' on disk and is registered
        // in installed_plugins.json AND in the marketplace config store.
        // Scanner emits one entry: imessage:send-message with pluginName=imessage.
        // Backfill must NOT also add a placeholder entry with id='imessage'.
        val pluginPath = ".claude/plugins/marketplaces/youcoded/plugins/imessage"
        write("$pluginPath/plugin.json", """{"name":"imessage"}""")
        mkdirs("$pluginPath/skills/send-message")
        val absInstall = File(tmpHome, pluginPath).absolutePath.replace("\\", "\\\\")
        write(".claude/plugins/installed_plugins.json", """
            {"version":2,"plugins":{"imessage@youcoded":[
              {"installPath":"$absInstall","version":"1.0.0","scope":"user"}
            ]}}
        """.trimIndent())
        // Mark as marketplace-installed in the config store (v2 packages shape)
        writePackageConfig("imessage", File(tmpHome, pluginPath).absolutePath, "2026-04-28T00:00:00Z")

        val provider = LocalSkillProvider(tmpHome, context)
        // ensureMigrated() is a no-op when the config file already exists, but
        // SkillConfigStore.config stays empty until load() runs. Force load so
        // getInstalledPlugins() sees the packages we just wrote.
        provider.configStore.load()
        val installed = provider.getInstalled()
        val ids = (0 until installed.length()).map { installed.getJSONObject(it).getString("id") }

        assertTrue("real skill id should be present", ids.contains("imessage:send-message"))
        assertFalse("plugin-level placeholder must not appear", ids.contains("imessage"))
    }
}
