// Pins F1 (T4 doc-comments implementation review, blocker): `mutateFileUnder
// Lock` is the Kotlin port of desktop's `cas-write.ts` primitive of the SAME
// name — the mkdir-based lock, 30s stale-lock break, and atomic
// tmp-then-rename write that lets THIS app, a dev-instance-plus-built-app
// pair on desktop, AND the Claude Code MCP script's own dependency-free
// reimplementation (doc-comments design §9.1/§9.2) all exclude each other
// over the SAME file, not just coroutines inside one JVM.
//
// These tests spawn a REAL second OS process (a plain `sh` child) rather
// than a second coroutine or thread: a second coroutine only proves the
// in-process Mutex some callers layer on top works — it says nothing about
// whether the ON-DISK lock protocol itself (a directory a foreign,
// dependency-free process can mkdir/rmdir with no shared runtime at all)
// actually excludes something outside this JVM, which is the entire point
// of this primitive existing.
package com.youcoded.app.artifacts

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import org.junit.Test
import java.io.File
import java.nio.file.Files
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private fun tempTarget(): File = Files.createTempFile("ycd-cas-write-", ".txt").toFile().apply {
    delete() // mutateFileUnderLock must handle "doesn't exist yet"
    deleteOnExit()
}

class CasWriteTest {

    @Test
    fun `round-trips a read-modify-write with no lock contention, including file creation`() {
        val target = tempTarget()
        var sawOnDisk: String? = "not called"
        val acquired = mutateFileUnderLock(target.toPath()) { onDisk ->
            sawOnDisk = onDisk
            "1"
        }
        assertTrue(acquired)
        assertEquals(null, sawOnDisk)
        assertEquals("1", target.readText())

        val acquired2 = mutateFileUnderLock(target.toPath()) { onDisk -> ((onDisk?.toIntOrNull() ?: 0) + 1).toString() }
        assertTrue(acquired2)
        assertEquals("2", target.readText())
    }

    @Test
    fun `returning null from mutate skips the write entirely`() {
        val target = tempTarget()
        val acquired = mutateFileUnderLock(target.toPath()) { null }
        assertTrue(acquired)
        assertTrue(!target.exists(), "a null mutate result must never create the file")
    }

    @Test
    fun `a real second OS process holding the lock directory blocks the writer until it releases`() {
        val target = tempTarget()
        val lockDir = File(target.parentFile, target.name + ".lock")
        val releasedMarker = File(target.parentFile, target.name + ".released-marker")
        releasedMarker.deleteOnExit()
        // A plain `sh` child — no JVM, no node_modules, exactly the
        // "dependency-free" shape the MCP script itself is constrained to
        // (doc-comments design §9.1 point 2) — mkdir's the SAME lock
        // directory this primitive uses, holds it briefly, drops a marker
        // right before releasing, then releases.
        val proc = ProcessBuilder(
            "sh", "-c",
            "mkdir '${lockDir.path}' && sleep 0.4 && touch '${releasedMarker.path}' && rmdir '${lockDir.path}'",
        ).start()
        // Wait for the child to actually acquire the lock before racing it —
        // otherwise this test could spuriously pass by winning a startup race.
        val waitStart = System.currentTimeMillis()
        while (!lockDir.isDirectory) {
            assertTrue(System.currentTimeMillis() - waitStart < 2000, "child process never created the lock dir")
            Thread.sleep(5)
        }

        val acquired = mutateFileUnderLock(target.toPath()) { "written-after-release" }
        proc.waitFor()

        assertTrue(acquired)
        assertEquals("written-after-release", target.readText())
        // The real assertion: this call did not return until the foreign
        // process had ALREADY dropped the marker on its way to releasing the
        // lock — a signal, never a fixed sleep or a wall-clock guess.
        assertTrue(releasedMarker.exists(), "mutateFileUnderLock returned before the foreign process released its lock")
    }

    @Test
    fun `a real two-process race increments a shared counter with no lost update`() {
        val target = tempTarget()
        target.writeText("0")
        val lockDir = File(target.parentFile, target.name + ".lock")

        // A foreign process implementing the SAME mkdir-lock-plus-atomic-
        // rename algorithm from scratch, in POSIX shell — standing in for the
        // MCP script's own from-scratch reimplementation (design §9.1 point
        // 2: "it cannot import cas-write.ts... it needs a small,
        // dependency-free reimplementation of the SAME algorithm"). Retries
        // mkdir in a tight loop (POSIX mkdir is atomic — the same property
        // Files.createDirectory relies on here), reads-increments-writes the
        // counter via a temp file + atomic `mv`, then rmdir's the lock.
        val shellIncrements = 15
        val script = """
            n=0
            while [ ${'$'}n -lt $shellIncrements ]; do
              if mkdir '${lockDir.path}' 2>/dev/null; then
                v=${'$'}(cat '${target.path}')
                v=${'$'}((v + 1))
                echo -n ${'$'}v > '${target.path}.shtmp'
                mv '${target.path}.shtmp' '${target.path}'
                rmdir '${lockDir.path}'
                n=${'$'}((n + 1))
              else
                sleep 0.01
              fi
            done
        """.trimIndent()
        val proc = ProcessBuilder("sh", "-c", script).start()

        val kotlinIncrements = 15
        runBlocking {
            val jobs = (0 until kotlinIncrements).map {
                async(Dispatchers.IO) {
                    val ok = mutateFileUnderLock(target.toPath()) { onDisk -> ((onDisk?.trim()?.toIntOrNull() ?: 0) + 1).toString() }
                    assertTrue(ok, "the Kotlin writer failed to acquire the lock within the timeout")
                }
            }
            jobs.awaitAll()
        }
        assertEquals(0, proc.waitFor())

        assertEquals(shellIncrements + kotlinIncrements, target.readText().trim().toInt())
    }
}
