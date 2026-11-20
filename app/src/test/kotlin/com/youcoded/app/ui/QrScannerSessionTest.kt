package com.youcoded.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pins "closing the QR scanner stops the camera" (review 2026-11-18 B-5). */
class QrScannerSessionTest {
    @Test fun `release stops the camera, closes the scanner and shuts the thread down`() {
        val calls = mutableListOf<String>()
        val s = QrScannerSession({ calls += "unbind" }, { calls += "close" }, { calls += "shutdown" })
        assertFalse(s.released)
        s.release()
        assertEquals(listOf("unbind", "close", "shutdown"), calls)
        assertTrue(s.released)
    }

    @Test fun `releasing twice only releases once`() {
        var n = 0
        val s = QrScannerSession({ n++ }, {}, {})
        s.release(); s.release()
        assertEquals(1, n)
    }

    @Test fun `one failing step does not stop the others`() {
        val calls = mutableListOf<String>()
        val s = QrScannerSession({ error("camera gone") }, { calls += "close" }, { calls += "shutdown" })
        s.release()
        assertEquals(listOf("close", "shutdown"), calls)
    }
}
