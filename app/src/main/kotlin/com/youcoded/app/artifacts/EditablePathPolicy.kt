package com.youcoded.app.artifacts

/**
 * Kotlin port of desktop/src/shared/artifacts/editable-path-policy.ts — the
 * D5 security boundary for artifact writes (2026-07-22).
 *
 * Android implements artifacts:save FOR REAL (SessionService.kt), so this
 * policy must be enforced here too or the identical React UI would call an
 * unguarded Kotlin write path. Pinned to the TS implementation by the shared
 * fixture artifacts/editable-path-policy-cases.json (EditablePathPolicyTest).
 *
 * Callers pass a CANONICAL path (canonicalize(p, null)) of the RESOLVED
 * target — File.canonicalFile first — so symlinks cannot dodge a segment match.
 */
object EditablePathPolicy {

    enum class EditTier { FREE, NEEDS_CONFIRM, DENIED }

    /** Segments refused for reads AND writes anywhere in the path. */
    private val SENSITIVE_SEGMENTS = setOf(".ssh", ".gnupg", ".aws", ".azure", ".kube")

    /** Basenames refused outright (credential stores). */
    private val SENSITIVE_BASENAMES = setOf(".netrc", "_netrc", ".credentials.json")

    /** .config/gh holds the GitHub OAuth token (hosts.yml). */
    private val SENSITIVE_SUBPATHS = listOf("/.config/gh/")

    /** Never editable: escalation vectors with no in-pane editing story.
     * Matches a `.git` FILE too (worktrees) — a basename is just a segment. */
    private val DENIED_SEGMENTS = setOf(".git", ".youcoded")

    /** Editable behind an explicit confirm (settings/hooks run commands). */
    private val CONFIRM_SEGMENTS = setOf(".claude")

    /** .env / .env.<suffix> / .envrc — NOT unrelated names like .environment. */
    fun isDotenvBasename(base: String): Boolean =
        base == ".env" || base == ".envrc" || base.startsWith(".env.")

    /** Per-path write policy. Precedence: DENIED > NEEDS_CONFIRM > FREE. */
    fun editTier(canonicalPath: String): EditTier {
        val parts = canonicalPath.split('/')
        val base = parts.lastOrNull() ?: ""
        if (parts.any { it in DENIED_SEGMENTS }) return EditTier.DENIED
        if (parts.any { it in SENSITIVE_SEGMENTS }) return EditTier.DENIED
        if (base in SENSITIVE_BASENAMES) return EditTier.DENIED
        if (SENSITIVE_SUBPATHS.any { canonicalPath.contains(it) }) return EditTier.DENIED
        if (parts.any { it in CONFIRM_SEGMENTS }) return EditTier.NEEDS_CONFIRM
        if (isDotenvBasename(base)) return EditTier.NEEDS_CONFIRM
        return EditTier.FREE
    }

    /** Paths artifacts:get refuses to READ: the sensitive set MINUS dotenv
     * (.env stays viewable because it is confirm-tier editable — D5). */
    fun protectedReadPath(canonicalPath: String): Boolean {
        val parts = canonicalPath.split('/')
        val base = parts.lastOrNull() ?: ""
        if (parts.any { it in SENSITIVE_SEGMENTS }) return true
        if (base in SENSITIVE_BASENAMES) return true
        return SENSITIVE_SUBPATHS.any { canonicalPath.contains(it) }
    }

    /** Full sensitive check INCLUDING dotenv — the read-binary deny-list
     * (port of the desktop isSensitivePath; Kotlin read-binary previously had
     * NO guard at all — pre-existing gap closed 2026-07-22). */
    fun isSensitivePath(canonicalPath: String): Boolean {
        val base = canonicalPath.split('/').lastOrNull() ?: ""
        return protectedReadPath(canonicalPath) || isDotenvBasename(base)
    }

    /** Above this, artifacts:get serves a PREFIX rather than the whole file --
     *  the text editor blocks on a multi-MB string. Governs text only; binary
     *  viewers have their own ceiling. Mirrors desktop EDIT_MAX_BYTES. */
    const val EDIT_MAX_BYTES: Long = 3L * 1024 * 1024

    /** Mirrors desktop FULL_READ_MAX_BYTES -- ceiling on "Load the whole file". */
    const val FULL_READ_MAX_BYTES: Long = 4L * EDIT_MAX_BYTES

    /** Mirrors desktop READ_BINARY_MAX_BYTES. */
    const val READ_BINARY_MAX_BYTES: Long = 50L * 1024 * 1024

    /**
     * Cut a byte array to at most maxBytes of text for the partial view.
     * Prefer the last newline so no line is shown cut in half -- unless it
     * would throw away more than half the window (a short header line then
     * one enormous minified line), or there is no newline at all, in which
     * case cut at the last complete UTF-8 character so a multi-byte character
     * is never split. Mirrors desktop textPrefix() in over-cap-read.ts; the
     * shared cases are pinned on both sides so the two cannot drift.
     */
    fun textPrefix(buf: ByteArray, len: Int, maxBytes: Int): String {
        val n = minOf(len, maxBytes)
        if (n <= 0) return ""
        var nl = -1
        for (i in n - 1 downTo 0) if (buf[i] == 0x0A.toByte()) { nl = i; break }
        if (nl >= 0 && (nl + 1) * 2 >= n) return String(buf, 0, nl + 1, Charsets.UTF_8)
        var start = n - 1
        while (start > 0 && (buf[start].toInt() and 0xC0) == 0x80) start--
        val lead = buf[start].toInt() and 0xFF
        val need = when { lead >= 0xF0 -> 4; lead >= 0xE0 -> 3; lead >= 0xC0 -> 2; else -> 1 }
        val end = if (start + need <= n) n else start
        return String(buf, 0, end, Charsets.UTF_8)
    }

    /** Fill `out` from the file -- read() is only required to return SOME bytes,
     *  not to fill the buffer. Returns how many were actually read. */
    fun readFully(f: java.io.File, out: ByteArray): Int {
        f.inputStream().use { s ->
            var off = 0
            while (off < out.size) {
                val n = s.read(out, off, out.size - off)
                if (n <= 0) break
                off += n
            }
            return off
        }
    }

    /** The result of reading a whole file: its bytes, or why it could not be read. */
    sealed class FileRead {
        class Bytes(val bytes: ByteArray) : FileRead()
        data class Unreadable(val reason: String) : FileRead()
    }

    /**
     * Read a whole file, keeping the reason when that fails.
     *
     * WHY (error inventory 2026-09-10, false message 13): artifacts:get did
     * `try { readBytes() } catch (IOException) { null }` and answered the null as
     * orphan — "This file is no longer on disk." — for a file that had just passed
     * exists(). A failed read is a failure with a reason, which is what desktop reports.
     * SecurityException is caught too: on Android it is the same "exists but may not be
     * read" case, and left uncaught it would take the whole bridge handler down.
     */
    fun readWhole(f: java.io.File): FileRead = try {
        FileRead.Bytes(f.readBytes())
    } catch (e: java.io.IOException) {
        FileRead.Unreadable(e.message?.takeIf { it.isNotBlank() } ?: "the file could not be read")
    } catch (e: SecurityException) {
        FileRead.Unreadable(e.message?.takeIf { it.isNotBlank() } ?: "the file could not be read")
    }

    /**
     * Read at most `maxBytes` from the start of a file, keeping the reason when that fails.
     * The over-cap branch of artifacts:get reads a head and a text window this way. WHY
     * (code review 2026-09-11, F6): it used readFully, which throws for the same "exists
     * but can't be read" file readWhole handles, so an unreadable file over the size cap
     * got no answer — or took the bridge handler down.
     */
    fun readPrefix(f: java.io.File, maxBytes: Int): FileRead = try {
        val buf = ByteArray(maxBytes)
        val n = readFully(f, buf)
        FileRead.Bytes(buf.copyOf(n))
    } catch (e: java.io.IOException) {
        FileRead.Unreadable(e.message?.takeIf { it.isNotBlank() } ?: "the file could not be read")
    } catch (e: SecurityException) {
        FileRead.Unreadable(e.message?.takeIf { it.isNotBlank() } ?: "the file could not be read")
    }

    /**
     * True when reading these bytes as UTF-8 loses information: the file is text
     * in an older encoding (Latin-1 / Windows-1252), so every byte the decoder
     * cannot read becomes U+FFFD and SAVING IT BACK would write that damage to
     * disk permanently. Mirrors desktop losesBytesAsUtf8() in
     * editable-path-policy.ts; both platforms hide Edit for such a file.
     */
    fun losesBytesAsUtf8(bytes: ByteArray): Boolean = try {
        java.nio.charset.StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
            .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
            .decode(java.nio.ByteBuffer.wrap(bytes))
        false
    } catch (_: java.nio.charset.CharacterCodingException) {
        true
    }

    /** git-style sniff: NUL byte in the head slice means not-text. */
    fun looksBinary(head: ByteArray): Boolean {
        val n = minOf(head.size, 8192)
        for (i in 0 until n) if (head[i] == 0.toByte()) return true
        return false
    }
}
