package com.youcoded.app.runtime

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Pins the startup-crash guard: Node is always pointed at a real ICU data folder (2026-11-09 final review). */
class IcuDirTest {
    private fun icu(vararg versions: String, empty: List<String> = emptyList()): File {
        val root = Files.createTempDirectory("icu").toFile()
        for (v in versions) File(root, v).apply { mkdirs(); File(this, "icudt${v.substringBefore('.')}l.dat").writeText("x") }
        for (v in empty) File(root, v).mkdirs()
        return root
    }

    @Test fun `one folder is chosen`() = assertEquals("76.1", RuntimeInstaller.newestIcuDir(icu("76.1"))!!.name)

    @Test fun `a leftover older folder does not stop the newer one being chosen`() {
        assertEquals("78.1", RuntimeInstaller.newestIcuDir(icu("76.1", "78.1"))!!.name)
        // Compared as numbers, not text: 100 is newer than 99.
        assertEquals("100.1", RuntimeInstaller.newestIcuDir(icu("99.2", "100.1"))!!.name)
        assertEquals("76.10", RuntimeInstaller.newestIcuDir(icu("76.2", "76.10"))!!.name)
    }

    @Test fun `a folder with no data file is ignored`() {
        assertEquals("76.1", RuntimeInstaller.newestIcuDir(icu("76.1", empty = listOf("78.1")))!!.name)
    }

    @Test fun `no folder at all sets nothing`() {
        assertNull(RuntimeInstaller.newestIcuDir(icu()))
        assertNull(RuntimeInstaller.newestIcuDir(File("/nonexistent/icu")))
    }
}
