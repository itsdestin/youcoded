package com.youcoded.app.skills

import android.content.Context
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.mockito.Mockito.mock
import org.mockito.Mockito.`when`
import java.io.ByteArrayInputStream
import java.io.File

/**
 * Tests SkillScanner Pass 1 (top-level plugin scan) and Pass 2 (installed_plugins.json).
 *
 * Regression coverage for the Android-only "duplicate skill ids in drawer" bug:
 * Pass 1 used to walk both ~/.claude/plugins/ AND the marketplace subtree, so any
 * plugin whose directory name starts with "youcoded" produced bare ids in Pass 1
 * AND namespaced ids in Pass 2. Mirroring desktop's top-level-only walk fixes it.
 */
class SkillScannerTest {

    private lateinit var tmpHome: File
    private lateinit var context: Context

    @Before
    fun setUp() {
        tmpHome = createTempDir(prefix = "youcoded-scanner-")
        context = mock(Context::class.java)
        val assets = mock(android.content.res.AssetManager::class.java)
        `when`(context.assets).thenReturn(assets)
        // Empty registry — fallback metadata path
        `when`(assets.open("web/data/skill-registry.json"))
            .thenReturn(ByteArrayInputStream("{}".toByteArray()))
    }

    @After
    fun tearDown() { tmpHome.deleteRecursively() }

    private fun mkdirs(path: String) = File(tmpHome, path).apply { mkdirs() }
    private fun write(path: String, content: String) {
        File(tmpHome, path).apply { parentFile?.mkdirs() }.writeText(content)
    }

    @Test
    fun `youcoded-core at top level produces bare skill ids`() {
        write(".claude/plugins/youcoded-core/plugin.json", """{"name":"youcoded-core"}""")
        mkdirs(".claude/plugins/youcoded-core/skills/setup-wizard")
        mkdirs(".claude/plugins/youcoded-core/skills/remote-setup")

        val skills = SkillScanner(tmpHome, context).scan()
        val ids = (0 until skills.length()).map { skills.getJSONObject(it).getString("id") }.sorted()
        assertEquals(listOf("remote-setup", "setup-wizard"), ids)
    }

    @Test
    fun `marketplace-installed youcoded-prefixed plugin does NOT produce bare skill ids in Pass 1`() {
        // Regression for Android-only duplicate ids bug.
        // Pre-fix: Pass 1 walked the marketplace subtree AND saw youcoded-encyclopedia,
        // adding bare 'journal' alongside 'youcoded-encyclopedia:journal' from Pass 2.
        val pluginPath = ".claude/plugins/marketplaces/youcoded/plugins/youcoded-encyclopedia"
        write("$pluginPath/plugin.json", """{"name":"youcoded-encyclopedia"}""")
        mkdirs("$pluginPath/skills/journal")

        val absInstall = File(tmpHome, pluginPath).absolutePath.replace("\\", "\\\\")
        write(".claude/plugins/installed_plugins.json", """
            {"version":2,"plugins":{"youcoded-encyclopedia@youcoded":[
              {"installPath":"$absInstall","version":"1.0.0","scope":"user"}
            ]}}
        """.trimIndent())

        val skills = SkillScanner(tmpHome, context).scan()
        val ids = (0 until skills.length()).map { skills.getJSONObject(it).getString("id") }
        assertFalse("bare id 'journal' should not appear on Android", ids.contains("journal"))
        assertTrue("namespaced id should appear", ids.contains("youcoded-encyclopedia:journal"))
        assertEquals("no duplicates", ids.distinct().size, ids.size)
    }

    @Test
    fun `marketplace plugin emits pluginName field for the LocalSkillProvider filter`() {
        // Task 3 depends on this — pluginName carries the plugin id, not the skill id.
        val pluginPath = ".claude/plugins/marketplaces/youcoded/plugins/imessage"
        write("$pluginPath/plugin.json", """{"name":"imessage"}""")
        mkdirs("$pluginPath/skills/send-message")

        val absInstall = File(tmpHome, pluginPath).absolutePath.replace("\\", "\\\\")
        write(".claude/plugins/installed_plugins.json", """
            {"version":2,"plugins":{"imessage@youcoded":[
              {"installPath":"$absInstall","version":"1.0.0","scope":"user"}
            ]}}
        """.trimIndent())

        val skills = SkillScanner(tmpHome, context).scan()
        val entry = (0 until skills.length()).map { skills.getJSONObject(it) }
            .first { it.getString("id") == "imessage:send-message" }
        assertEquals("imessage", entry.getString("pluginName"))
    }
}
