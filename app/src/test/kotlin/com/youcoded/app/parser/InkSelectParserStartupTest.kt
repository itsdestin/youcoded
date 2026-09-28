package com.youcoded.app.parser

import org.json.JSONObject
import org.junit.Test
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Claude Code's real startup dialogs (CC 2.1.281: folder trust, bypass warning,
 * MCP-server approval — unnumbered, "No, exit" first) read by the Android parser.
 *
 * The screens and the expected readings come from desktop's
 * tests/startup-dialogs.test.ts, which replays the real captures
 * (desktop/tests/fixtures/startup-dialogs/) through the desktop parser and writes
 * app/src/test/resources/startup-dialogs/. Both platforms must agree exactly: an
 * Android card's buttons are answered by the shared renderer's driver, which
 * re-parses its own terminal and types NOTHING if the option set (the signature)
 * differs from the one Kotlin put on the card.
 */
class InkSelectParserStartupTest {

    private fun screens(): List<Pair<String, JSONObject>> {
        val dir = File(javaClass.classLoader!!.getResource("startup-dialogs")!!.toURI())
        return dir.listFiles()!!.filter { it.name.endsWith(".json") }.sortedBy { it.name }
            .map { it.name to JSONObject(it.readText()) }
    }

    @Test
    fun everyCapturedStartupDialogReadsExactlyAsOnDesktop() {
        val all = screens()
        assertTrue(all.size >= 20, "expected the startup-dialog screens, found ${all.size}")
        for ((name, fx) in all) {
            val menu = InkSelectParser.parse(fx.getString("screen"))
            if (fx.isNull("expected")) {
                assertTrue(menu == null || !menu.dialog, "$name: desktop reads no dialog here")
                continue
            }
            val want = fx.getJSONObject("expected")
            requireNotNull(menu) { "$name: Android read no menu" }
            assertEquals(want.getString("title"), menu.title, "$name title")
            val options = want.getJSONArray("options").let { a -> (0 until a.length()).map { a.getString(it) } }
            assertEquals(options, menu.options, "$name options")
            assertEquals(want.getInt("selectedIndex"), menu.selectedIndex, "$name cursor")
            assertEquals(want.getString("signature"), menu.signature, "$name signature")
            assertEquals(if (want.isNull("heading")) null else want.getString("heading"), menu.heading, "$name heading")
            val buttons = InkSelectParser.toPromptButtons(menu)
            if (want.getBoolean("picks")) {
                buttons.forEachIndexed { i, b ->
                    assertEquals(Pick(menu.signature, i), b.pick, "$name button $i")
                    assertEquals("", b.input, "$name button $i types nothing itself")
                    assertNull(b.submitInput, "$name button $i")
                }
            }
        }
    }

    @Test
    fun theMultiServerMcpCheckboxDialogIsNeverTurnedIntoButtons() {
        val (_, fx) = screens().first { it.first.startsWith("mcp-two-100x35-dialog-2") }
        assertNull(InkSelectParser.parse(fx.getString("screen")))
    }

    @Test
    fun aListWithoutClaudeCodesFooterIsNotAMenu() {
        val rule = "─".repeat(60)
        val screen = listOf(rule, " Accessing workspace:", "", " ❯ No, exit", "   Yes, I trust this folder", "").joinToString("\n")
        assertNull(InkSelectParser.parse(screen))
    }

    @Test
    fun theOlderNumberedTrustDialogStillAnswersByDigit() {
        val menu = InkSelectParser.parse(" ❯ 1. Yes, I trust this folder\n   2. No, exit")!!
        assertEquals("Trust This Folder?", menu.title)
        assertEquals(listOf("1", "2"), InkSelectParser.toPromptButtons(menu).map { it.input })
        assertTrue(InkSelectParser.toPromptButtons(menu).all { it.pick == null })
    }
}
