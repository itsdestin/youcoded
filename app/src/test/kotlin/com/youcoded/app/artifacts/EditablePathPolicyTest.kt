package com.youcoded.app.artifacts

import org.json.JSONObject
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Runs the SAME fixture as the desktop editable-path-policy.test.ts so the two
 * implementations of the D5 write boundary cannot drift — Android implements
 * artifacts:save for real, so a verdict mismatch here is a security bug, not a
 * cosmetic one.
 */
class EditablePathPolicyTest {

    private fun tierOf(s: String) = when (s) {
        "free" -> EditablePathPolicy.EditTier.FREE
        "needs-confirm" -> EditablePathPolicy.EditTier.NEEDS_CONFIRM
        "denied" -> EditablePathPolicy.EditTier.DENIED
        else -> error("unknown tier in fixture: $s")
    }

    @Test
    fun runsAllSharedFixtures() {
        val text = javaClass.classLoader!!
            .getResourceAsStream("artifacts/editable-path-policy-cases.json")!!
            .bufferedReader().readText()
        val cases = JSONObject(text).getJSONArray("cases")
        for (i in 0 until cases.length()) {
            val o = cases.getJSONObject(i)
            val path = o.getString("path")
            assertEquals(tierOf(o.getString("tier")), EditablePathPolicy.editTier(path), "tier for $path")
            assertEquals(o.getBoolean("protectedRead"), EditablePathPolicy.protectedReadPath(path), "protectedRead for $path")
        }
    }

    @Test
    fun recordTrustMatchesTheSharedFixture() {
        val text = javaClass.classLoader!!
            .getResourceAsStream("artifacts/editable-path-policy-cases.json")!!
            .bufferedReader().readText()
        val cases = JSONObject(text).getJSONArray("recordPrivate")
        for (i in 0 until cases.length()) {
            val o = cases.getJSONObject(i)
            val path = o.getString("path")
            assertEquals(o.getBoolean("private"), EditablePathPolicy.privateForRecordTrust(path), "recordPrivate for $path")
        }
    }

    @Test
    fun readBinaryDenyIncludesDotenv() {
        // isSensitivePath is the read-binary deny-list: sensitive set PLUS dotenv
        // (unlike protectedReadPath, which exempts dotenv for the edit flow).
        assertTrue(EditablePathPolicy.isSensitivePath("/home/u/proj/.env"))
        assertTrue(EditablePathPolicy.isSensitivePath("/home/u/.ssh/id_rsa"))
        assertFalse(EditablePathPolicy.isSensitivePath("/home/u/proj/src/app.ts"))
    }

    // The SAME cases desktop pins in tests/over-cap-read.test.ts. Both sides
    // serve the partial view, so a divergence here means the same file reads
    // differently on the phone than on the laptop.
    @Test
    fun textPrefixCutsBackToTheLastNewline() {
        val b = "alpha\nbravo\ncharlie-cut".toByteArray()
        assertEquals("alpha\nbravo\n", EditablePathPolicy.textPrefix(b, b.size, 20))
    }

    @Test
    fun textPrefixReturnsEverythingWhenItAlreadyFits() {
        val b = "alpha\nbravo\n".toByteArray()
        assertEquals("alpha\nbravo\n", EditablePathPolicy.textPrefix(b, b.size, 999))
    }

    @Test
    fun textPrefixFallsBackWhenThereIsNoNewlineAtAll() {
        // Minified JS and one-line JSON: the newline rule alone returns "".
        val b = "x".repeat(100).toByteArray()
        assertEquals("x".repeat(40), EditablePathPolicy.textPrefix(b, b.size, 40))
    }

    @Test
    fun textPrefixIgnoresANewlineThatWouldDiscardMostOfTheWindow() {
        // A short header line then one enormous line would otherwise give a
        // five-byte pane under a bar claiming megabytes.
        val b = ("head\n" + "x".repeat(200)).toByteArray()
        assertEquals(100, EditablePathPolicy.textPrefix(b, b.size, 100).toByteArray().size)
    }

    @Test
    fun textPrefixNeverSplitsAMultiByteCharacter() {
        val b = ("x".repeat(40) + "\u00e9" + "x".repeat(40)).toByteArray() // e9 = C3 A9
        assertEquals("x".repeat(40), EditablePathPolicy.textPrefix(b, b.size, 41))
        assertEquals("x".repeat(40) + "\u00e9", EditablePathPolicy.textPrefix(b, b.size, 42))
    }

    @Test
    fun textPrefixReturnsEmptyForAnEmptyBuffer() {
        assertEquals("", EditablePathPolicy.textPrefix(ByteArray(0), 0, 10))
    }

    @Test
    fun sizeConstantsMirrorTheDesktopValues() {
        assertEquals(3L * 1024 * 1024, EditablePathPolicy.EDIT_MAX_BYTES)
        assertEquals(4L * EditablePathPolicy.EDIT_MAX_BYTES, EditablePathPolicy.FULL_READ_MAX_BYTES)
        assertEquals(50L * 1024 * 1024, EditablePathPolicy.READ_BINARY_MAX_BYTES)
    }

    @Test
    fun looksBinarySniffsNulInHeadOnly() {
        assertTrue(EditablePathPolicy.looksBinary(byteArrayOf(0x50, 0x4b, 0x00, 0x01)))
        assertFalse(EditablePathPolicy.looksBinary("plain text".toByteArray()))
        val big = ByteArray(10000) { 0x61 }
        big[9000] = 0 // beyond the 8KB sniff window
        assertFalse(EditablePathPolicy.looksBinary(big))
    }
}
