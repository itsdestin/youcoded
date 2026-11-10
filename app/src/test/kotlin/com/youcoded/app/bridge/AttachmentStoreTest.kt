package com.youcoded.app.bridge

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Pins the paperclip's size limit and seven-day clean-up (2026-11-09 final review, Q-15). */
class AttachmentStoreTest {
    private fun root(): File = Files.createTempDirectory("attachments").toFile()

    @Test fun `a picked file is copied under its own name`() {
        val r = root()
        val out = AttachmentStore.save(r, "notes.txt", "hello".byteInputStream())
        assertEquals("notes.txt", out.name)
        assertEquals("hello", out.readText())
    }

    @Test fun `two picks of the same name do not overwrite each other`() {
        val r = root()
        val a = AttachmentStore.save(r, "image.jpg", "one".byteInputStream(), now = 5)
        val b = AttachmentStore.save(r, "image.jpg", "two".byteInputStream(), now = 5)
        assertEquals("one", a.readText())
        assertEquals("two", b.readText())
    }

    @Test fun `a file over the limit is refused by name and leaves nothing behind`() {
        val r = root()
        try {
            AttachmentStore.save(r, "film.mp4", ByteArray(2 * 1024 * 1024 + 1).inputStream(), maxBytes = 2L * 1024 * 1024)
            fail("expected a refusal")
        } catch (e: AttachmentStore.Refused) {
            assertEquals("film.mp4 is larger than 2 MB, so it was not attached.", e.message)
        }
        assertEquals(0, r.listFiles()!!.size)
    }

    @Test fun `a file exactly at the limit is accepted`() {
        val out = AttachmentStore.save(root(), "edge.bin", ByteArray(1024).inputStream(), maxBytes = 1024)
        assertEquals(1024L, out.length())
    }

    @Test fun `copies older than seven days are removed and newer ones kept`() {
        val r = root()
        val old = AttachmentStore.save(r, "old.txt", "x".byteInputStream(), now = 1)
        val fresh = AttachmentStore.save(r, "new.txt", "y".byteInputStream(), now = 2)
        val now = 30L * 24 * 60 * 60 * 1000
        old.setLastModified(now - AttachmentStore.MAX_AGE_MS - 1); old.parentFile!!.setLastModified(now - AttachmentStore.MAX_AGE_MS - 1)
        fresh.setLastModified(now - 1000); fresh.parentFile!!.setLastModified(now - 1000)
        AttachmentStore.sweep(r, now)
        assertFalse(old.exists())
        assertFalse(old.parentFile!!.exists())
        assertTrue(fresh.exists())
    }

    @Test fun `clean-up of a missing folder does nothing`() {
        AttachmentStore.sweep(File(root(), "never-made"))
    }
}
