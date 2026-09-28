// The docx/xlsx pending-mutation queue's Android half — T20 of the doc-
// comments build (docs/active/specs/2026-09-26-doc-comments-build-design.md
// §9.2). Mirrors desktop's `pending-mutation-queue.ts` field-for-field, with
// a Kotlin coroutine polling loop standing in for its chokidar watcher (§9.2:
// "not FileObserver... a Kotlin coroutine polling loop inside SessionService"
// — this object is that loop; SessionRegistry/PtyBridge start and stop it).
//
// The byte-identical MCP script (T9c, ClaudeCodeDocCommentsMcp.kt / the
// doc-comments-mcp.js asset) "never touches a .docx/.xlsx file directly"
// (§1.6): for any of the six tools against a Word/Excel target, including a
// plain read, it writes a PendingMutationRequest under
// .youcoded/comments/.pending/<id>.json and polls for a matching
// <id>.result.json. This object is the OTHER end: it notices a new request
// file, applies it through the SAME Kotlin dispatch functions
// (DocCommentsDispatch.kt) the docComments:* bridge already uses — never a
// second, queue-specific copy of "how to write a docx/xlsx comment" — and
// writes the result back.
//
// --- Authorization (mirrors desktop's own three findings, adversarial
//     review 2026-09-27) ---
//
// .pending/ is a plain, filesystem-level drop box: anything with ordinary
// write access to the project folder can place a file there. Two independent
// defenses close this, neither alone sufficient — identical reasoning to
// desktop's pending-mutation-queue.ts, restated here because this is an
// independent Kotlin re-implementation, not a port with a shared import:
//
// 1. The applier never trusts a request's own `projectRoot` field. Every
//    dispatch call below resolves against `entry.realRoot` — the SAME
//    realpathed root `start()` verified via `refuseUnknownProjectRoot` (the
//    SAME authority every other doc-comments surface on Android gates on) —
//    never `req.projectRoot`, which is advisory-only self-reported data from
//    an untrusted file.
// 2. Every request must carry this session's own per-deployment secret
//    (`req.token`, compared against every session currently sharing this
//    entry's `refs` map via `MessageDigest.isEqual` — the JVM's own constant-
//    time byte-array comparison, the same intent as desktop's
//    `crypto.timingSafeEqual`) — a value generated fresh at THIS session's
//    own spawn time (ClaudeCodeDocCommentsMcp.deploy), which nothing planted
//    before the session existed can possibly supply.
//
// A third, purely defense-in-depth check (`isFreshEnough`) refuses to process
// a request file whose own mtime predates this queue's own start — explicitly
// weak alone (a `git clone` commonly stamps a planted file's mtime as "now"),
// never relied on alone; the token check above is the real boundary.
package com.youcoded.app.doccomments

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

object DocCommentsPendingQueue {
    /** ~250ms (§9.2's own figure) — comfortably under the MCP script's own
     *  benchmarked 8s poll bound (claude-code-doc-comments-mcp.ts), while
     *  still cheap: this only lists one small directory on a timer, never
     *  touches the target document itself except when a real request lands. */
    private const val POLL_INTERVAL_MS = 250L

    /** Defense-in-depth margin for the pre-existing-file check (see this
     *  file's own header) — generous on purpose: the token check is the real
     *  boundary, so this only needs to catch an OBVIOUSLY stale file without
     *  false-refusing a genuine near-simultaneous write at session start.
     *  Matches desktop's own FRESHNESS_MARGIN_MS. */
    private const val FRESHNESS_MARGIN_MS = 5000L

    /** How long an orphaned .result.json may sit before a sweep removes it —
     *  matches desktop's own STALE_RESULT_MS (an hour, comfortably longer
     *  than any real wait; mirrors cas-write.ts's sweepStaleTmp precedent). */
    private const val STALE_RESULT_MS = 60 * 60 * 1000L

    private class Entry(
        val realRoot: String,
        val pendingDir: File,
        val startedAt: Long,
    ) {
        /** Claude Code session id -> that session's own request token —
         *  several sessions can share one project root, each with its own
         *  independently-generated token (mirrors desktop's Entry.refs). */
        val refs = ConcurrentHashMap<String, String>()
        val inFlight = ConcurrentHashMap.newKeySet<String>()
        var job: Job? = null

        @Volatile var stopped = false
    }

    /** realpathed project root -> its entry. Guarded by `lock` for start/stop
     *  mutation; `pollOnce`'s own per-entry work reads an already-published
     *  Entry and needs no further synchronization (its own maps are
     *  concurrent). */
    private val entries = HashMap<String, Entry>()
    private val lock = Any()

    private fun tokensMatch(a: Any?, b: String): Boolean {
        if (a !is String || a.length != b.length) return false
        return MessageDigest.isEqual(a.toByteArray(Charsets.UTF_8), b.toByteArray(Charsets.UTF_8))
    }

    private fun hasValidToken(entry: Entry, req: JSONObject): Boolean {
        val token = req.opt("token")
        for (candidate in entry.refs.values) {
            if (tokensMatch(token, candidate)) return true
        }
        return false
    }

    /**
     * Start (or add a ref to) the pending-mutation queue for `projectRoot` —
     * called once per Claude Code session that gets a doc-comments MCP server
     * (PtyBridge.start(), via ClaudeCodeDocCommentsMcp.deploy's own
     * `Deployment.token`), keyed on `sessionId` so `stop` below can drop
     * exactly this session's ref without needing its caller to track a
     * refcount itself.
     */
    fun start(
        scope: CoroutineScope,
        sessionId: String,
        projectRoot: String,
        homeDir: File,
        claudeDir: File,
        token: String,
    ) {
        val realRoot = try {
            File(projectRoot).canonicalFile.path
        } catch (_: Exception) {
            return // the project directory vanished before this could start
        }
        // Never watch the bare OS temp directory as a "project" — mirrors
        // desktop's own guard (pending-mutation-queue.ts): several JVM test
        // suites use a shared temp root as a stand-in "some real, existing
        // directory," and without this guard those tests would leave a real,
        // permanent .youcoded/comments/.pending/ under it.
        val tmp = try {
            File(System.getProperty("java.io.tmpdir") ?: "/tmp").canonicalFile.path
        } catch (_: Exception) {
            System.getProperty("java.io.tmpdir") ?: "/tmp"
        }
        if (realRoot == tmp) return
        // Reuse the SAME allowlist authority every other doc-comments surface
        // on Android gates on (DocCommentsGate.kt), rather than a fourth
        // independently-invented check — mirrors desktop's own reuse of
        // isKnownRoot() here (adversarial review finding #1) and this
        // codebase's own `refuseUnknownProjectRoot(realRoot, ..., [realRoot])`
        // precedent (DocCommentsDispatch.kt's own dispatch, whose doc comment
        // explains the "a live session's own cwd counts as known too" reason).
        if (refuseUnknownProjectRoot(realRoot, homeDir, claudeDir, listOf(realRoot))) return

        synchronized(lock) {
            val existing = entries[realRoot]
            if (existing != null) {
                existing.refs[sessionId] = token
                return
            }
            val pendingDir = File(realRoot, ".youcoded/comments/.pending")
            val entry = Entry(realRoot, pendingDir, System.currentTimeMillis())
            entry.refs[sessionId] = token
            entries[realRoot] = entry
            try {
                pendingDir.mkdirs()
            } catch (_: Exception) {
                // best-effort, mirrors DocCommentsStore.kt's own directory creation
            }
            entry.job = scope.launch(Dispatchers.IO) {
                sweepStaleResults(pendingDir)
                while (isActive && !entry.stopped) {
                    pollOnce(entry, homeDir)
                    delay(POLL_INTERVAL_MS)
                }
            }
        }
    }

    /** Drop `sessionId`'s ref; cancels the polling job once the last session
     *  sharing this project ends. Called from PtyBridge.stop(). */
    fun stop(sessionId: String, projectRoot: String) {
        val realRoot = try {
            File(projectRoot).canonicalFile.path
        } catch (_: Exception) {
            return
        }
        synchronized(lock) {
            val entry = entries[realRoot] ?: return
            entry.refs.remove(sessionId)
            if (entry.refs.isEmpty()) {
                entry.stopped = true
                entry.job?.cancel()
                entries.remove(realRoot)
            }
        }
    }

    /** Test helper: tear everything down between cases — mirrors desktop's
     *  own `__resetPendingMutationQueueForTest`. */
    fun resetForTest() {
        synchronized(lock) {
            for (entry in entries.values) {
                entry.stopped = true
                entry.job?.cancel()
            }
            entries.clear()
        }
    }

    private suspend fun pollOnce(entry: Entry, homeDir: File) {
        val files = try {
            entry.pendingDir.listFiles { f -> f.isFile && f.name.endsWith(".json") && !f.name.endsWith(".result.json") }
        } catch (_: Exception) {
            null
        } ?: return
        for (file in files) {
            val id = file.name.removeSuffix(".json")
            if (!entry.inFlight.add(id)) continue // a duplicate poll tick for the same file
            try {
                handleRequestFile(entry, file, homeDir)
            } catch (_: Exception) {
                // Never let one bad request kill the polling loop for the rest
                // of the session — an unexpected exception here (e.g. a
                // result-file write failing on a full disk) is dropped the
                // same way a malformed request already is; the MCP script's
                // own poll times out honestly instead of hanging forever.
            } finally {
                entry.inFlight.remove(id)
            }
        }
    }

    private suspend fun handleRequestFile(entry: Entry, file: File, homeDir: File) {
        // Finding #1's defense-in-depth freshness check — see this file's own
        // header for why this is weak ALONE and why the token check is the
        // real boundary. Left in place (never deleted, never applied) rather
        // than guessed at: a legitimate cold-start race is covered by
        // FRESHNESS_MARGIN_MS; anything older is either a planted file or
        // genuinely stale litter the sweep below handles.
        val mtime = try {
            file.lastModified()
        } catch (_: Exception) {
            0L
        }
        if (mtime == 0L || mtime < entry.startedAt - FRESHNESS_MARGIN_MS) return

        val raw = try {
            file.readText()
        } catch (_: Exception) {
            return // vanished (already handled, or the writer's rename hadn't landed yet)
        }
        val req = try {
            JSONObject(raw)
        } catch (_: JSONException) {
            return // malformed request: no trustworthy id to build a result path from
        }
        val id = req.optString("id", "")
        if (id.isEmpty()) return
        val resultPath = File(entry.pendingDir, "$id.result.json")

        val result = if (!hasValidToken(entry, req)) {
            // Finding #1: the REAL authorization boundary. A mismatched or
            // missing token means this file did not come from a session this
            // queue is currently serving.
            JSONObject().put("ok", false).put("error", "invalid-request-token")
        } else {
            try {
                applyRequest(req, entry.realRoot, homeDir)
            } catch (e: Exception) {
                JSONObject().put("ok", false).put("error", e.message ?: "apply-failed")
            }
        }
        writeResultAtomic(resultPath, result)
        try {
            file.delete()
        } catch (_: Exception) {
            // already gone, or a races-with-someone-else's-delete
        }
        sweepStaleResults(entry.pendingDir)
    }

    /** Applies one request through the SAME dispatch functions the
     *  docComments:* bridge uses — never a second, queue-specific copy of
     *  "how to write a docx/xlsx comment." `trustedProjectRoot` is ALWAYS
     *  this queue's own verified `entry.realRoot` — see this file's own
     *  header, finding #1: `req.projectRoot` (self-reported, unauthenticated)
     *  is never read here. */
    private suspend fun applyRequest(req: JSONObject, trustedProjectRoot: String, homeDir: File): JSONObject {
        val formatName = req.optString("format", "")
        val format = when (formatName) {
            "docx" -> NativeFormat.DOCX
            "xlsx" -> NativeFormat.XLSX
            else -> return JSONObject().put("ok", false).put("error", "unknown-format")
        }
        val path = req.optString("path", "")
        val kind = req.optString("kind", "")

        return when (kind) {
            "list" -> when (val r = listNativeComments(format, path, trustedProjectRoot, homeDir)) {
                is NativeListResult.Ok -> JSONObject().put("ok", true).put(
                    "comments",
                    org.json.JSONArray(r.comments.map { it.toJson() }),
                )
                is NativeListResult.Err -> JSONObject().put("ok", false).put("error", r.error)
            }
            "add" -> {
                val selector = CommentSelector.fromJson(req.optJSONObject("selector"))
                    ?: return JSONObject().put("ok", false).put("error", "missing-field")
                val text = req.optString("text", "")
                val author = req.optString("author", "assistant")
                val r = when (format) {
                    NativeFormat.DOCX -> addNativeDocxComment(path, trustedProjectRoot, selector, text, author, homeDir)
                    NativeFormat.XLSX -> addNativeXlsxComment(path, trustedProjectRoot, selector, text, author, homeDir)
                }
                when (r) {
                    is NativeMutateResult.Ok -> JSONObject().put("ok", true).put("id", r.value)
                    is NativeMutateResult.Err -> JSONObject().put("ok", false).put("error", r.error)
                }
            }
            "reply" -> {
                val commentId = req.optString("commentId", "")
                val text = req.optString("text", "")
                val author = req.optString("author", "assistant")
                val r = when (format) {
                    NativeFormat.DOCX -> replyToNativeDocxComment(path, trustedProjectRoot, commentId, text, author, homeDir)
                    NativeFormat.XLSX -> replyToNativeXlsxComment(path, trustedProjectRoot, commentId, text, author, homeDir)
                }
                when (r) {
                    // Mirrors desktop's own "forward `reply` once the writer
                    // provides one" (design commit 6c612cb9, §1.5/§1.6/§7) —
                    // unlike desktop, Android's write functions already
                    // return the real persisted CommentReply unconditionally
                    // (T17/T19), so this is never a no-op the way the TS
                    // queue's own optional cast currently is.
                    is NativeMutateResult.Ok -> JSONObject().put("ok", true).put("reply", r.value.toJson())
                    is NativeMutateResult.Err -> JSONObject().put("ok", false).put("error", r.error)
                }
            }
            "resolve" -> {
                val commentId = req.optString("commentId", "")
                val r = when (format) {
                    NativeFormat.DOCX -> resolveNativeDocxComment(path, trustedProjectRoot, commentId, homeDir)
                    NativeFormat.XLSX -> resolveNativeXlsxComment(path, trustedProjectRoot, commentId, homeDir)
                }
                when (r) {
                    is NativeMutateResult.Ok -> JSONObject().put("ok", true)
                    is NativeMutateResult.Err -> JSONObject().put("ok", false).put("error", r.error)
                }
            }
            "reopen" -> {
                val commentId = req.optString("commentId", "")
                val r = when (format) {
                    NativeFormat.DOCX -> reopenNativeDocxComment(path, trustedProjectRoot, commentId, homeDir)
                    NativeFormat.XLSX -> reopenNativeXlsxComment(path, trustedProjectRoot, commentId, homeDir)
                }
                when (r) {
                    is NativeMutateResult.Ok -> JSONObject().put("ok", true)
                    is NativeMutateResult.Err -> JSONObject().put("ok", false).put("error", r.error)
                }
            }
            "move" -> {
                val commentId = req.optString("commentId", "")
                val newSelector = CommentSelector.fromJson(req.optJSONObject("newSelector"))
                    ?: return JSONObject().put("ok", false).put("error", "missing-field")
                val r = when (format) {
                    NativeFormat.DOCX -> moveNativeDocxComment(path, trustedProjectRoot, commentId, newSelector, homeDir)
                    NativeFormat.XLSX -> moveNativeXlsxComment(path, trustedProjectRoot, commentId, newSelector, homeDir)
                }
                when (r) {
                    is NativeMutateResult.Ok -> JSONObject().put("ok", true)
                    is NativeMutateResult.Err -> JSONObject().put("ok", false).put("error", r.error)
                }
            }
            // Adversarial review 2026-09-27, finding #3 (mirrored from
            // desktop): an unrecognized or malformed `kind` gets an honest,
            // typed refusal — never silently falls through into the `move`
            // path with blank commentId/newSelector.
            else -> JSONObject().put("ok", false).put("error", "unknown-mutation-kind")
        }
    }

    /** Writes the result via the SAME mkdir-lock-plus-atomic-rename primitive
     *  every other write in this feature uses (com.youcoded.app.artifacts.
     *  mutateFileUnderLock) — no real contention exists on a freshly-and-
     *  uniquely-named result file, but reusing the shared primitive keeps
     *  this write fsync'd and torn-write-free the same way every sidecar
     *  write already is, mirroring desktop's own writeResult. */
    private fun writeResultAtomic(resultPath: File, result: JSONObject) {
        com.youcoded.app.artifacts.mutateFileUnderLock(resultPath.absolutePath) { result.toString() }
    }

    /** `.result.json` is otherwise only ever deleted by the MCP script's OWN
     *  successful poll — if that script gave up (its own timeout) or its
     *  whole process was killed (the session ended) before reading a slow
     *  request's result, nothing else ever removes the file. Best-effort,
     *  never blocks or fails request handling — mirrors desktop's own
     *  sweepStaleResults (finding #4). */
    private fun sweepStaleResults(pendingDir: File) {
        val names = try {
            pendingDir.list()
        } catch (_: Exception) {
            null
        } ?: return
        val now = System.currentTimeMillis()
        for (name in names) {
            if (!name.endsWith(".result.json")) continue
            val f = File(pendingDir, name)
            try {
                if (now - f.lastModified() > STALE_RESULT_MS) f.delete()
            } catch (_: Exception) {
                // vanished, or races with someone else's delete — nothing to sweep
            }
        }
    }
}
