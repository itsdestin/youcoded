// Pins final review F1 (blocker) on Android: the YouCoded default theme reaches NEW installs only.
// An install set up before this release has no answer in its appearance file and must stay on Midnight;
// the answer, once written, never changes — not even when the file is later read by a "new" path.
package com.youcoded.app.runtime

import org.json.JSONObject
import org.junit.Test
import java.io.File
import java.nio.file.Files
import kotlin.test.assertEquals

class ThemeDefaultTest {
    private fun tempFile(): File = File(Files.createTempDirectory("ycd-theme-default-").toFile(), ".claude-mobile/youcoded-appearance.json")

    @Test
    fun `an existing install with no saved theme is recorded as Midnight and keeps its other settings`() {
        val f = tempFile()
        f.parentFile!!.mkdirs()
        f.writeText(JSONObject().put("reducedEffects", true).toString())
        assertEquals("midnight", ThemeDefault.ensure(f, isNewInstall = false))
        val onDisk = JSONObject(f.readText())
        assertEquals("midnight", onDisk.getString("defaultTheme"))
        assertEquals(true, onDisk.getBoolean("reducedEffects"))
    }

    @Test
    fun `an existing install with no appearance file at all is Midnight`() {
        val f = tempFile()
        assertEquals("midnight", ThemeDefault.ensure(f, isNewInstall = false))
        assertEquals("midnight", JSONObject(f.readText()).getString("defaultTheme"))
    }

    @Test
    fun `a new install is recorded as YouCoded and later reads keep it`() {
        val f = tempFile()
        assertEquals("youcoded", ThemeDefault.ensure(f, isNewInstall = true))
        // appearance:get on every later launch passes isNewInstall = false — the first answer must win.
        assertEquals("youcoded", ThemeDefault.ensure(f, isNewInstall = false))
        assertEquals("youcoded", JSONObject(f.readText()).getString("defaultTheme"))
    }

    @Test
    fun `an answer already on disk is never replaced`() {
        val f = tempFile()
        f.parentFile!!.mkdirs()
        f.writeText(JSONObject().put("defaultTheme", "midnight").put("theme", "creme").toString())
        assertEquals("midnight", ThemeDefault.ensure(f, isNewInstall = true))
        assertEquals("creme", JSONObject(f.readText()).getString("theme"))
    }
}
