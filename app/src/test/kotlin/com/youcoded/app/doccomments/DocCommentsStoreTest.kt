// Pins T4 of the doc-comments build (docs/active/specs/2026-09-26-doc-
// comments-build-design.md §1.5, §1.6, §9.1 point 3): the plain-text
// PersistedComment JSON sidecar store on Android — an in-process Mutex fast
// path in front of the REAL cross-process mkdir lock
// (`com.youcoded.app.artifacts.mutateFileUnderLock`, F1, T4 implementation
// review), the SAME lock protocol desktop's `cas-write.ts` uses, so this
// store, desktop's main process, and the Claude Code MCP script's own
// dependency-free reimplementation (design §9.1/§9.2) all exclude each other
// over the same sidecar — see DocCommentsStore.kt's own header for the full
// correction (this file's ORIGINAL header claimed Android needs no
// cross-process lock at all; that was wrong).
//
// Fixture: app/src/test/resources/doc-comments/json-sidecar/thread.json —
// copied VERBATIM from desktop/tests/fixtures/doc-comments/json-sidecar/
// thread.json, so a fixture drift here can never silently make the
// cross-platform parity claim (T4's own pinning-test row: "shared JSON
// fixture both platforms round-trip") compare two different inputs. The
// desktop half of this same parity claim is
// desktop/tests/doc-comments-json-sidecar-fixture-parity.test.ts.
package com.youcoded.app.doccomments

import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import java.io.File
import java.nio.file.Files
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.test.fail

private fun tempProjectRoot(): File = Files.createTempDirectory("ycd-doccomments-store-").toFile().apply { deleteOnExit() }

private fun fixtureText(name: String): String {
    val stream = object {}.javaClass.getResourceAsStream("/doc-comments/json-sidecar/$name")
        ?: fail("missing test resource doc-comments/json-sidecar/$name")
    return stream.use { it.readBytes().toString(Charsets.UTF_8) }
}

private val TEXT_SELECTOR = CommentSelector.Text(TextQuoteSelector(exact = "hello", prefix = "", suffix = " world", occurrence = 0))

class DocCommentsStoreTest {

    // ── listComments — missing-file default ─────────────────────────────
    @Test
    fun `a file with no sidecar returns an empty list, never an error`() = runTest {
        val root = tempProjectRoot()
        val result = listComments("docs/plan.md", root.path, root)
        assertEquals(StoreResult.Ok(emptyList<PersistedComment>()), result)
    }

    // ── read-modify-write round trip ─────────────────────────────────────
    @Test
    fun `add then reply then resolve then reopen round-trips through the sidecar on disk`() = runTest {
        val root = tempProjectRoot()
        val added = addComment(
            "docs/plan.md", root.path, TEXT_SELECTOR, "Can we cut this?", "user", root,
        )
        assertTrue(added is StoreResult.Ok, "expected Ok, got $added")
        val id = (added as StoreResult.Ok).value

        val sidecarFile = File(root, ".youcoded/comments/docs/plan.md.json")
        assertTrue(sidecarFile.exists())
        val onDisk1 = CommentsSidecarFile.parse(sidecarFile.readText())!!
        assertEquals(1, onDisk1.comments.size)
        assertEquals(id, onDisk1.comments[0].id)
        assertEquals(false, onDisk1.comments[0].resolved)
        assertTrue(onDisk1.comments[0].history.isEmpty())

        // T5 review parity (design §1.6, F2): `reply` now returns the real
        // persisted `CommentReply`, mirroring desktop's own enrichment.
        val replied = replyToComment("docs/plan.md", root.path, id, "Yes", "assistant", root)
        assertTrue(replied is StoreResult.Ok, "expected Ok, got $replied")
        assertEquals(CommentReply("$id-r1", "assistant", "Yes", (replied as StoreResult.Ok).value.createdAt), replied.value)

        val resolved = resolveComment("docs/plan.md", root.path, id, "assistant", root)
        assertEquals(StoreResult.Ok(Unit), resolved)

        val reopened = reopenComment("docs/plan.md", root.path, id, "user", root)
        assertEquals(StoreResult.Ok(Unit), reopened)

        val final = CommentsSidecarFile.parse(sidecarFile.readText())!!
        assertEquals(1, final.comments.size)
        val comment = final.comments[0]
        assertEquals(1, comment.replies.size)
        assertEquals("assistant", comment.replies[0].author)
        assertEquals("Yes", comment.replies[0].text)
        assertEquals("$id-r1", comment.replies[0].id)
        // Full resolve/reopen AUDIT TRAIL, not just the latest state (§1.1).
        assertEquals(2, comment.history.size)
        assertEquals("resolved", comment.history[0].action)
        assertEquals("reopened", comment.history[1].action)
        assertEquals(false, comment.resolved)
    }

    @Test
    fun `moveComment replaces the selector wholesale without touching text or replies`() = runTest {
        val root = tempProjectRoot()
        val added = addComment("docs/plan.md", root.path, TEXT_SELECTOR, "text", "user", root)
        val id = (added as StoreResult.Ok).value
        val newSelector = CommentSelector.Cell(CellSelector("B2", "Sheet1"))
        val moved = moveComment("docs/plan.md", root.path, id, newSelector, root)
        assertEquals(StoreResult.Ok(Unit), moved)

        val listed = listComments("docs/plan.md", root.path, root)
        assertTrue(listed is StoreResult.Ok)
        val comment = (listed as StoreResult.Ok).value.single()
        assertEquals("text", comment.text)
        assertTrue(comment.selector is CommentSelector.Cell)
        assertEquals("B2", (comment.selector as CommentSelector.Cell).selector.cell)
    }

    // ── the "cold-start" case — the same shape T3's own pinning test uses ──
    @Test
    fun `reply resolve reopen and move work against a comment id never previously listed in this process`() = runTest {
        val root = tempProjectRoot()
        val added = addComment("docs/report.md", root.path, TEXT_SELECTOR, "root comment", "user", root)
        val id = (added as StoreResult.Ok).value

        // A FRESH call sequence with no prior listComments() in between —
        // proves path-based resolution works cold, the exact case that most
        // concretely breaks without the required `path` field on these four
        // channels (design review 3, F1; T4's own pinning-test row).
        // T5 review parity (design §1.6, F2): `reply` returns the persisted
        // `CommentReply` here too, cold-start included.
        val cold = replyToComment("docs/report.md", root.path, id, "cold reply", "assistant", root)
        assertTrue(cold is StoreResult.Ok, "expected Ok, got $cold")
        assertEquals(CommentReply("$id-r1", "assistant", "cold reply", (cold as StoreResult.Ok).value.createdAt), cold.value)
        assertEquals(StoreResult.Ok(Unit), resolveComment("docs/report.md", root.path, id, "user", root))
        assertEquals(StoreResult.Ok(Unit), reopenComment("docs/report.md", root.path, id, "user", root))
        assertEquals(StoreResult.Ok(Unit), moveComment("docs/report.md", root.path, id, TEXT_SELECTOR, root))
    }

    @Test
    fun `mutating an unknown comment id refuses comment-not-found, never creates one`() = runTest {
        val root = tempProjectRoot()
        val result = replyToComment("docs/plan.md", root.path, "c-does-not-exist", "hi", "user", root)
        assertEquals(StoreResult.Err(DocCommentsError.COMMENT_NOT_FOUND), result)
    }

    // ── containment refusal ───────────────────────────────────────────────
    @Test
    fun `a traversal-shaped path is refused, never escapes the project`() = runTest {
        val root = tempProjectRoot()
        val result = addComment("../../../../etc/passwd", root.path, TEXT_SELECTOR, "x", "user", root)
        assertEquals(StoreResult.Err(DocCommentsError.PATH_OUTSIDE_PROJECT), result)
    }

    @Test
    fun `an absolute path outside the project is refused`() = runTest {
        val root = tempProjectRoot()
        val outside = Files.createTempFile("ycd-doccomments-outside-", ".md").toFile()
        outside.deleteOnExit()
        val result = addComment(outside.absolutePath, root.path, TEXT_SELECTOR, "x", "user", root)
        assertEquals(StoreResult.Err(DocCommentsError.PATH_OUTSIDE_PROJECT), result)
    }

    @Test
    fun `a symlink inside the project pointing outside it is refused, not trusted by its own name`() = runTest {
        val root = tempProjectRoot()
        val outsideSecret = Files.createTempFile("ycd-doccomments-secret-", ".md").toFile()
        outsideSecret.deleteOnExit()
        val linkPath = File(root, "notes.md").toPath()
        try {
            Files.createSymbolicLink(linkPath, outsideSecret.toPath())
        } catch (_: Exception) {
            return@runTest // no symlink rights on this platform — skip, matches TS test's own escape hatch
        }
        val result = addComment("notes.md", root.path, TEXT_SELECTOR, "x", "user", root)
        assertEquals(StoreResult.Err(DocCommentsError.PATH_OUTSIDE_PROJECT), result)
    }

    @Test
    fun `a symlinked project root still resolves comments inside it correctly`() = runTest {
        val root = tempProjectRoot()
        val alias = File(root.parentFile, "ycd-doccomments-alias-${System.nanoTime()}")
        try {
            Files.createSymbolicLink(alias.toPath(), root.toPath())
        } catch (_: Exception) {
            return@runTest
        }
        try {
            val result = addComment("docs/via-symlink.md", alias.path, TEXT_SELECTOR, "via-symlink", "user", root)
            assertTrue(result is StoreResult.Ok, "expected Ok, got $result")
            val realRoot = root.canonicalFile
            val sidecar = File(realRoot, ".youcoded/comments/docs/via-symlink.md.json")
            assertTrue(sidecar.exists())
        } finally {
            alias.delete()
        }
    }

    @Test
    fun `walk-up depth cap refuses a pathologically deep non-existent ancestor chain instead of hanging`() = runTest {
        val root = tempProjectRoot()
        val deepRel = (0 until 250).joinToString("/") { "level$it" } + "/file.md"
        val result = addComment(deepRel, root.path, TEXT_SELECTOR, "x", "user", root)
        assertEquals(StoreResult.Err(DocCommentsError.PATH_OUTSIDE_PROJECT), result)
    }

    // ── fallback path (no known project root) ────────────────────────────
    @Test
    fun `a relative path with no projectRoot is refused as not-absolute`() = runTest {
        val home = tempProjectRoot()
        val result = addComment("relative/file.md", null, TEXT_SELECTOR, "x", "user", home)
        assertEquals(StoreResult.Err(DocCommentsError.PATH_NOT_ABSOLUTE), result)
    }

    @Test
    fun `a standalone file with no project root lands in the per-machine fallback store`() = runTest {
        val home = tempProjectRoot()
        val looseFile = Files.createTempFile("ycd-doccomments-loose-", ".md").toFile()
        looseFile.deleteOnExit()
        val added = addComment(looseFile.absolutePath, null, TEXT_SELECTOR, "loose", "user", home)
        assertTrue(added is StoreResult.Ok, "expected Ok, got $added")

        val listed = listComments(looseFile.absolutePath, null, home)
        assertTrue(listed is StoreResult.Ok)
        assertEquals(1, (listed as StoreResult.Ok).value.size)
        assertEquals("loose", listed.value[0].text)

        // Lands under ~/.youcoded/loose-file-comments/<sha256>.json, never
        // inside the caller's own directory (§1.4).
        val fallbackDir = File(home, ".youcoded/loose-file-comments")
        assertTrue(fallbackDir.isDirectory)
        assertEquals(1, fallbackDir.listFiles()?.size ?: 0)
    }

    // ── concurrency — a true race, not just a sequential check ───────────
    @Test
    fun `two writers racing to create the SAME sidecar for the first time both land`() = runTest {
        val root = tempProjectRoot()
        val jobs = listOf("first", "second").map { text ->
            async {
                addComment("docs/race.md", root.path, TEXT_SELECTOR, text, "user", root)
            }
        }
        val results = jobs.map { it.await() }
        assertTrue(results.all { it is StoreResult.Ok }, "expected both Ok, got $results")

        val sidecar = File(root, ".youcoded/comments/docs/race.md.json")
        val onDisk = CommentsSidecarFile.parse(sidecar.readText())!!
        assertEquals(2, onDisk.comments.size)
        assertEquals(setOf("first", "second"), onDisk.comments.map { it.text }.toSet())
    }

    // ── shared JSON fixture round trip (T4's own pinning-test row) ────────
    @Test
    fun `Kotlin's own reader parses the checked-in fixture the same way desktop's store produced it`() {
        val json = fixtureText("thread.json")
        val parsed = CommentsSidecarFile.parse(json)
        assertNotNull(parsed, "fixture failed to parse")
        assertEquals(1, parsed.comments.size)
        val comment = parsed.comments[0]
        assertEquals("c-fixture-0001", comment.id)
        assertEquals("docs/plan.md", comment.path)
        assertEquals("Can we cut this?", comment.text)
        assertEquals("person:Priya Shah", comment.author)
        assertEquals(true, comment.resolved)
        assertTrue(comment.selector is CommentSelector.Text)
        val sel = (comment.selector as CommentSelector.Text).selector
        assertEquals("cut the onboarding step", sel.exact)
        assertEquals("we should probably ", sel.prefix)
        assertEquals(" before shipping", sel.suffix)
        assertEquals(1, comment.replies.size)
        assertEquals("Agreed, cutting it.", comment.replies[0].text)
        assertEquals(1, comment.history.size)
        assertEquals("resolved", comment.history[0].action)
    }

    @Test
    fun `a reply Kotlin appends to the fixture keeps the exact field shape desktop's own reader expects`() = runTest {
        val root = tempProjectRoot()
        val sidecar = File(root, ".youcoded/comments/docs/plan.md.json")
        sidecar.parentFile?.mkdirs()
        sidecar.writeText(fixtureText("thread.json"))

        // T5 review parity (design §1.6, F2): `reply` returns the real
        // persisted `CommentReply` — the fixture already has one reply, so
        // this new one lands as ordinal 2.
        val replied = replyToComment("docs/plan.md", root.path, "c-fixture-0001", "from android", "assistant", root)
        assertTrue(replied is StoreResult.Ok, "expected Ok, got $replied")
        assertEquals(
            CommentReply("c-fixture-0001-r2", "assistant", "from android", (replied as StoreResult.Ok).value.createdAt),
            replied.value,
        )

        val onDiskRaw = JSONObject(sidecar.readText())
        assertEquals(1, onDiskRaw.getInt("version"))
        val comment = onDiskRaw.getJSONArray("comments").getJSONObject(0)
        // Field names/types a TS `JSON.parse` of this same file would see —
        // the desktop half of this parity claim
        // (doc-comments-json-sidecar-fixture-parity.test.ts) asserts the
        // mirror image: a reply DESKTOP appends keeps this same shape.
        for (key in listOf("id", "path", "selector", "text", "author", "createdAt", "replies", "resolved", "history")) {
            assertTrue(comment.has(key), "missing key: $key")
        }
        assertTrue(comment.get("createdAt") is Number)
        assertTrue(comment.get("resolved") is Boolean)
        val replies = comment.getJSONArray("replies")
        assertEquals(2, replies.length())
        val newReply = replies.getJSONObject(1)
        assertEquals("assistant", newReply.getString("author"))
        assertEquals("from android", newReply.getString("text"))
        assertEquals("c-fixture-0001-r2", newReply.getString("id"))
    }

    // ── F2 (T4 implementation review, major) — unknown fields survive ──────
    @Test
    fun `an Android reply and resolve preserve unknown top-level comment reply and history fields byte-equivalently`() = runTest {
        val root = tempProjectRoot()
        val sidecar = File(root, ".youcoded/comments/docs/plan.md.json")
        sidecar.parentFile?.mkdirs()
        // A sidecar carrying a field this Kotlin build doesn't know about at
        // every level the design calls out: the FILE itself, a COMMENT, and
        // one of its REPLIES — standing in for a newer schema field, or one
        // written by desktop/the MCP script (the other two of the three-way
        // JSON sidecar story, design §9.1).
        val onDiskBefore = JSONObject()
            .put("version", 1)
            .put("syncedFromDevice", "pixel-9a") // unknown TOP-LEVEL field
            .put(
                "comments",
                JSONArray().put(
                    JSONObject()
                        .put("id", "c-unknown-0001")
                        .put("path", "docs/plan.md")
                        .put("selector", TEXT_SELECTOR.toJson())
                        .put("text", "Can we cut this?")
                        .put("author", "user")
                        .put("createdAt", 1758000000000L)
                        .put("priority", "high") // unknown COMMENT field
                        .put(
                            "replies",
                            JSONArray().put(
                                JSONObject()
                                    .put("id", "c-unknown-0001-r1")
                                    .put("author", "assistant")
                                    .put("text", "Agreed")
                                    .put("createdAt", 1758000100000L)
                                    .put("reactedWith", "👍"), // unknown REPLY field
                            ),
                        )
                        .put("resolved", false)
                        .put("history", JSONArray()),
                ),
            )
        sidecar.writeText(onDiskBefore.toString())

        // T5 review parity (design §1.6, F2): `reply` returns the persisted
        // `CommentReply` here too.
        val repliedToUnknown = replyToComment("docs/plan.md", root.path, "c-unknown-0001", "from android", "assistant", root)
        assertTrue(repliedToUnknown is StoreResult.Ok, "expected Ok, got $repliedToUnknown")
        assertEquals(
            CommentReply("c-unknown-0001-r2", "assistant", "from android", (repliedToUnknown as StoreResult.Ok).value.createdAt),
            repliedToUnknown.value,
        )
        assertEquals(
            StoreResult.Ok(Unit),
            resolveComment("docs/plan.md", root.path, "c-unknown-0001", "user", root),
        )

        val onDiskAfter = JSONObject(sidecar.readText())
        // Top-level unknown field survived reply's/resolve's overlay.
        assertEquals("pixel-9a", onDiskAfter.getString("syncedFromDevice"))
        val mutatedComment = onDiskAfter.getJSONArray("comments").getJSONObject(0)
        // Comment-level unknown field survived, even after two mutations.
        assertEquals("high", mutatedComment.getString("priority"))
        val mutatedReplies = mutatedComment.getJSONArray("replies")
        assertEquals(2, mutatedReplies.length())
        // The ORIGINAL reply's own unknown field survived being carried
        // through two more mutations on a DIFFERENT part of the record.
        assertEquals("👍", mutatedReplies.getJSONObject(0).getString("reactedWith"))
        assertEquals("from android", mutatedReplies.getJSONObject(1).getString("text"))
        assertEquals(1, mutatedComment.getJSONArray("history").length())
        assertEquals("resolved", mutatedComment.getJSONArray("history").getJSONObject(0).getString("action"))

        // And Kotlin's own reader still parses the result back out correctly
        // — the unknown fields are extra, not corrupting.
        val reparsed = CommentsSidecarFile.parse(onDiskAfter.toString())
        assertNotNull(reparsed)
        assertEquals(1, reparsed.comments.size)
        assertEquals(true, reparsed.comments[0].resolved)
    }

    // ── F1 (T4 implementation review, blocker) — a real second process ─────
    @Test
    fun `a real second OS process holding the sidecar lock blocks the store writer until it releases`() = runTest {
        val root = tempProjectRoot()
        val sidecarPath = File(root, ".youcoded/comments/docs/plan.md.json")
        sidecarPath.parentFile?.mkdirs()
        val lockDir = File(sidecarPath.path + ".lock")
        val releasedMarker = File(root, "released.marker")
        // A plain `sh` child — no JVM, standing in for the Claude Code MCP
        // script's own dependency-free reimplementation of this SAME
        // mkdir-lock algorithm (design §9.1 point 2) — mkdir's the SAME lock
        // directory DocCommentsStore's cross-process lock uses, holds it for
        // a while, drops a marker right before releasing it, then releases.
        val proc = ProcessBuilder(
            "sh", "-c",
            "mkdir -p '${lockDir.parentFile!!.path}' && mkdir '${lockDir.path}' && sleep 0.4 " +
                "&& touch '${releasedMarker.path}' && rmdir '${lockDir.path}'",
        ).start()
        val waitStart = System.currentTimeMillis()
        while (!lockDir.isDirectory) {
            assertTrue(System.currentTimeMillis() - waitStart < 2000, "child process never created the lock dir")
            Thread.sleep(5)
        }

        val result = addComment("docs/plan.md", root.path, TEXT_SELECTOR, "after the foreign lock releases", "user", root)
        proc.waitFor()

        assertTrue(result is StoreResult.Ok, "expected Ok, got $result")
        // The real assertion: the store's writer did not proceed until the
        // foreign process had ALREADY dropped the marker on its way to
        // releasing the lock — waiting on the actual signal, never a fixed
        // sleep or a wall-clock-duration guess.
        assertTrue(releasedMarker.exists(), "the store's writer returned before the foreign process released its lock")
    }

    // ── F4 (T5 implementation review) — caller-supplied id ──────────────────
    @Test
    fun `uses the caller-supplied id instead of minting its own`() = runTest {
        val root = tempProjectRoot()
        val callerId = "c-11111111-2222-4333-8444-555555555555"
        val added = addComment("docs/id.md", root.path, TEXT_SELECTOR, "x", "user", root, callerId)
        assertEquals(StoreResult.Ok(callerId), added)
        val sidecarFile = File(root, ".youcoded/comments/docs/id.md.json")
        val onDisk = CommentsSidecarFile.parse(sidecarFile.readText())!!
        assertEquals(callerId, onDisk.comments[0].id)
    }

    @Test
    fun `still mints its own id when none is supplied (an unupdated caller)`() = runTest {
        val root = tempProjectRoot()
        val added = addComment("docs/id2.md", root.path, TEXT_SELECTOR, "x", "user", root)
        assertTrue(added is StoreResult.Ok, "expected Ok, got $added")
        val id = (added as StoreResult.Ok).value
        assertTrue(Regex("^c-[0-9a-f-]{36}$", RegexOption.IGNORE_CASE).matches(id), "id '$id' is not shaped like a real comment id")
    }

    @Test
    fun `refuses a caller-supplied id that is not shaped like this store's own ids`() = runTest {
        val root = tempProjectRoot()
        val result = addComment("docs/id3.md", root.path, TEXT_SELECTOR, "x", "user", root, "not-a-real-id")
        assertEquals(StoreResult.Err(DocCommentsError.INVALID_ID), result)
    }

    @Test
    fun `refuses a caller-supplied id that collides with one already in this file's sidecar`() = runTest {
        val root = tempProjectRoot()
        val callerId = "c-11111111-2222-4333-8444-555555555555"
        val first = addComment("docs/id4.md", root.path, TEXT_SELECTOR, "first", "user", root, callerId)
        assertTrue(first is StoreResult.Ok, "expected Ok, got $first")
        val second = addComment("docs/id4.md", root.path, TEXT_SELECTOR, "second", "user", root, callerId)
        assertEquals(StoreResult.Err(DocCommentsError.DUPLICATE_ID), second)
        val sidecarFile = File(root, ".youcoded/comments/docs/id4.md.json")
        val onDisk = CommentsSidecarFile.parse(sidecarFile.readText())!!
        assertEquals(1, onDisk.comments.size)
        assertEquals("first", onDisk.comments[0].text)
    }

    // ── mutateSidecar's IOException mapping (code review 2026-09-27, F3) ──
    // Before this fix, EVERY java.io.IOException escaping mutateFileUnderLock
    // — from the READ side (an unreadable existing sidecar) or the WRITE side
    // (a failed atomic rename) — was reported as SIDECAR_CORRUPT. These two
    // tests pin that the two are now told apart.

    @Test
    fun `malformed JSON content in an existing sidecar still refuses as SIDECAR_CORRUPT`() = runTest {
        val root = tempProjectRoot()
        // A real, readable, regular file — just not valid sidecar JSON.
        // `CommentsSidecarFile.parse` returning null (not an exception) is
        // the common real-world "sidecar corrupt" shape (a torn write, hand
        // edited by mistake); this pins it's still SIDECAR_CORRUPT and was
        // NEVER routed through the IOException catch this review's F3
        // finding is about — it must stay unaffected by that fix.
        val sidecarFile = File(root, ".youcoded/comments/docs/plan.md.json")
        sidecarFile.parentFile!!.mkdirs()
        sidecarFile.writeText("{ not valid json at all")

        val result = addComment("docs/plan.md", root.path, TEXT_SELECTOR, "x", "user", root)
        assertEquals(StoreResult.Err(DocCommentsError.SIDECAR_CORRUPT), result)
    }

    @Test
    fun `a write-time failure (not a read failure) refuses as SIDECAR_WRITE_FAILED, never SIDECAR_CORRUPT`() = runTest {
        val root = tempProjectRoot()
        // A real, valid, READABLE sidecar first — the read (and `apply`)
        // succeed; only the SUBSEQUENT write must fail.
        val added = addComment("docs/plan.md", root.path, TEXT_SELECTOR, "first", "user", root)
        assertTrue(added is StoreResult.Ok, "expected Ok, got $added")

        // `mutateFileUnderLock` (CasWrite.kt) writes its new content to
        // "<target>.tmp" before the atomic rename onto `target` — a
        // DIRECTORY already sitting at exactly that ".tmp" path makes that
        // specific write step fail (`writeText` onto a directory throws),
        // strictly AFTER the read and `apply` have already succeeded. This
        // is more precise than a permission-bit trick: this codebase's own
        // mkdir-based lock (`acquireLock`) ALSO creates something inside the
        // SAME parent directory the tmp/rename step writes into, so making
        // that whole directory non-writable fails lock ACQUISITION instead
        // (a different, pre-existing failure this fix doesn't change) —
        // confirmed empirically while writing this test.
        val sidecarFile = File(root, ".youcoded/comments/docs/plan.md.json")
        val tmpPath = File(sidecarFile.parentFile, "${sidecarFile.name}.tmp")
        assertTrue(tmpPath.mkdirs(), "test setup: could not pre-create the .tmp collision directory")

        val result = replyToComment(
            "docs/plan.md", root.path, (added as StoreResult.Ok).value, "a reply", "user", root,
        )
        assertEquals(StoreResult.Err(DocCommentsError.SIDECAR_WRITE_FAILED), result)
    }
}
