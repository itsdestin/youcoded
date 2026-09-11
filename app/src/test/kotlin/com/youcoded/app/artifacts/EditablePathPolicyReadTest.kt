package com.youcoded.app.artifacts

import org.junit.Assume.assumeFalse
import org.junit.Test
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * An existing file that cannot be read is a read FAILURE, never a missing file.
 *
 * Error inventory 2026-09-10, false message 13. SessionService's artifacts:get checked
 * `resolved.exists()`, then did `try { resolved.readBytes() } catch (IOException) { null }`
 * and answered the null as `orphan: true` — which the shared viewer renders as "This file
 * is no longer on disk." for a file that is right there (permission denied, say). Desktop
 * rethrows the same failure into an error state with Retry. readWhole keeps the reason so
 * SessionService can answer `{ ok: false, error }` the way desktop does.
 *
 * Paired with desktop/tests/android-artifact-read-failure.test.ts, which pins that
 * SessionService reads through this helper.
 */
class EditablePathPolicyReadTest {

    @Test
    fun aReadableFileComesBackAsItsBytes() {
        val f = File.createTempFile("readable", ".md").apply { writeText("hello"); deleteOnExit() }
        val read = EditablePathPolicy.readWhole(f)
        assertIs<EditablePathPolicy.FileRead.Bytes>(read)
        assertEquals("hello", String(read.bytes, Charsets.UTF_8))
    }

    @Test
    fun anExistingFileThatCannotBeReadComesBackUnreadableWithItsReason() {
        val f = File.createTempFile("unreadable", ".md").apply { writeText("secret"); deleteOnExit() }
        f.setReadable(false, false)
        // A root user ignores permission bits, so there the premise does not hold.
        assumeFalse("this user can still read a file with no read permission", f.canRead())
        try {
            assertTrue(f.exists(), "the file is really there")
            val read = EditablePathPolicy.readWhole(f)
            assertIs<EditablePathPolicy.FileRead.Unreadable>(read)
            assertTrue(read.reason.isNotBlank(), "the reason is kept, not dropped")
        } finally {
            f.setReadable(true, false)
        }
    }
}
