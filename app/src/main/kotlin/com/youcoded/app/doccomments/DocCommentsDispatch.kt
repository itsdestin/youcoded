// The docComments:* dispatch point — Android half of T4 (docs/active/specs/
// 2026-09-26-doc-comments-build-design.md §1.1, §3.2a, §4.3a). Word (.docx)
// and Excel (.xlsx) files do NOT get a `PersistedComment` sidecar row — their
// comments live inside the file itself. Mirrors desktop's
// doc-comments-dispatch.ts: the ONE place that decides, by extension, which
// files are native-format vs. sidecar-backed, reused by every channel branch
// in SessionService.kt so it can never disagree with itself about which
// files are which.
//
// READ is real: `listNativeComments` hands the resolved, containment-checked
// file straight to T16/T18's own `readDocxComments`/`readXlsxComments`
// (`DocxComments.kt`/`XlsxComments.kt` — not edited by this task).
//
// F3 (T4 implementation review, major): `listNativeComments` used to call
// those readers with NO exception boundary of its own. Both readers already
// catch their two KNOWN throwing signals (an unsafe-XML DOCTYPE, a
// decompression-bomb) — see their own doc comments — but a corrupt-but-
// openable archive (valid ZIP central directory, malformed inner XML, a
// truncated compressed entry, an unexpected structure) throws something
// else entirely (SAXException, IOException from a bad deflate stream, a
// parsing NPE/NumberFormatException…), which escaped BOTH readers uncaught,
// then `SessionService.handleBridgeMessage`'s own `serviceScope.launch { }`
// (no try/catch of its own), leaving the WebView's request unanswered
// forever rather than refused. `listNativeComments` below now catches at
// this dispatch boundary and returns a typed refusal — the SAME shape every
// other refusal in this module already uses — distinguishing a genuine I/O
// failure (permission denied, or the file vanishing between the containment
// check and the read: `read-failed`, matching this module's own existing
// code for an unreadable/missing file) from a corrupt archive's CONTENT
// (everything else: `invalid-docx`/`invalid-xlsx`, the SAME wire code the
// reader itself would have produced had `ZipFile` failed to open at all).
//
// WRITE (add/reply/resolve/reopen/move): T17 wired the `.docx` half into
// `DocxComments.kt`'s own write functions; T19 (this task) wires the `.xlsx`
// half into `XlsxComments.kt`'s own write functions the identical way — Excel
// comment mutation on Android is now REAL too, dispatched through the exact
// same containment/allowlist gates `listNativeComments` already uses for
// reads (a write is at least as sensitive as a read, never a looser gate).
// `refuseNativeMutation` is now permanently `false` — mirrors desktop's own
// `refuseNativeMutation`, also permanently null there since both its formats
// shipped — kept as a single named function (rather than deleted outright) so
// a future new native format has one place to wire a refusal into, the same
// reasoning that already applied to it before both formats landed.
package com.youcoded.app.doccomments

import java.io.File

enum class NativeFormat { DOCX, XLSX }

/** Extension-based dispatch decision — the ONE place that decides "does this
 *  path have its comments inside the file itself." */
fun nativeFormatFor(filePath: String): NativeFormat? = when (File(filePath).extension.lowercase()) {
    "docx" -> NativeFormat.DOCX
    "xlsx" -> NativeFormat.XLSX
    else -> null
}

sealed class NativeListResult {
    data class Ok(val comments: List<PersistedComment>) : NativeListResult()
    data class Err(val error: String) : NativeListResult()
}

/**
 * `docComments:list` for a `.docx`/`.xlsx` target. Resolves the SOURCE file's
 * own containment-verified absolute path (never a sidecar), reads its bytes
 * via T16/T18's own file-based reader (no in-memory byte hop over IPC — this
 * Kotlin code already has direct filesystem access, unlike a renderer that
 * needs `artifacts:read-binary` to get bytes at all).
 *
 * F4 (T4 implementation review, major/security — supersedes this function's
 * original denylist-only design): a no-`projectRoot` native read used to
 * check ONLY `EditablePathPolicy.isSensitivePath` — a DENYLIST of well-known
 * secret locations, refusing nothing else. That was a stand-in for desktop's
 * real authority (`authorizeBytesRead`, `read-service.ts`), not a match for
 * it, and the gap widens as more native tools gain model-controlled path
 * arguments (§1.5's own "a new tool surface must implement its own
 * containment check, it inherits none" applies here too) — a caller naming
 * ANY path outside the few denied segments read straight through. This now
 * checks the SAME two-pass ALLOWLIST desktop's `evaluateBinaryRead`
 * (`read-binary-access.ts`) uses instead, via `DocCommentsGate.kt`'s
 * `allowUntrackedNativeRead` — the app's own known project roots (or a
 * descendant of one) OR a path recorded as a tracked EXTERNAL artifact/
 * manual include in one of those projects' own sidecars (a temp-dir
 * spreadsheet the session drawer legitimately shows lives outside every
 * root) — with the sensitive-path denylist kept as a FIRST-pass refusal even
 * inside an otherwise-allowed root, exactly how `evaluateBinaryRead` orders
 * its own two checks (defense in depth, not a replacement for one or the
 * other). Deliberately excludes live session cwds, unlike
 * `refuseUnknownProjectRoot`'s own roots — see `allowUntrackedNativeRead`'s
 * own doc comment for why.
 *
 * A prior implementation review's own F4 — threading contract (unrelated to
 * this T4 review's F4 above; finding numbers reset per review round):
 * `readDocxComments`/
 * `readXlsxComments` (called below) are plain, BLOCKING, synchronous
 * functions — not `suspend` — and perform real file/zip I/O directly on the
 * calling thread. This is safe ONLY because of THIS function's own caller:
 * `SessionService.handleBridgeMessage` is always invoked as
 * `serviceScope.launch { handleBridgeMessage(ws, msg) }` (SessionService.kt's
 * `onCreate()`), and `serviceScope` is
 * `CoroutineScope(Dispatchers.IO + SupervisorJob())` — so EVERY
 * `docComments:*` branch, including this function's own call into T16/T18's
 * readers, already runs on `Dispatchers.IO` by the time it gets here, never
 * on `Dispatchers.Main`/the UI thread. Making these readers `suspend fun` +
 * wrapping their bodies in their own `withContext(Dispatchers.IO)` would be
 * redundant (an extra dispatch hop onto a dispatcher the call is already
 * running on) rather than a real safety improvement — this doc comment
 * records that contract explicitly instead, so a future caller added OUTSIDE
 * `handleBridgeMessage` doesn't assume these functions are main-thread-safe
 * just because they carry no `Dispatchers.IO` mention of their own.
 */
fun listNativeComments(format: NativeFormat, path: String, projectRoot: String?, homeDir: File): NativeListResult {
    val resolved = resolveSourceFilePath(path, projectRoot, homeDir)
    if (resolved is StoreResult.Err) return NativeListResult.Err(resolved.error.wire)
    val absolutePath = (resolved as StoreResult.Ok).value
    if (projectRoot.isNullOrEmpty()) {
        // F4: allowlist (known roots + tracked/opened files), not a denylist
        // — see this function's own doc comment above.
        if (!allowUntrackedNativeRead(absolutePath, homeDir, File(homeDir, ".claude"))) {
            return NativeListResult.Err("path-not-tracked")
        }
    }
    val file = File(absolutePath)
    if (!file.exists()) return NativeListResult.Err("read-failed")
    // F3: every reader call is now wrapped — see this function's own doc
    // comment above for the read-failed vs. invalid/corrupt distinction.
    return try {
        when (format) {
            NativeFormat.DOCX -> when (val r = readDocxComments(file, path)) {
                is DocxReadResult.Ok -> NativeListResult.Ok(r.comments)
                is DocxReadResult.Err -> NativeListResult.Err(r.error.name.lowercase().replace('_', '-'))
            }
            NativeFormat.XLSX -> when (val r = readXlsxComments(file, path)) {
                is XlsxReadResult.Ok -> NativeListResult.Ok(r.comments)
                is XlsxReadResult.Err -> NativeListResult.Err(r.error.name.lowercase().replace('_', '-'))
            }
        }
    } catch (_: SecurityException) {
        NativeListResult.Err("read-failed")
    } catch (_: java.io.FileNotFoundException) {
        NativeListResult.Err("read-failed")
    } catch (_: Exception) {
        // Everything else (malformed XML, a truncated compressed entry, an
        // unexpected structure a legitimate Word/Excel file never produces)
        // is the archive's CONTENT being corrupt, not an I/O failure — the
        // SAME wire code the reader itself would have returned had `ZipFile`
        // failed to open at all. `Exception`, never `Throwable` — an OOM or
        // stack overflow is a real crash this boundary should not mask.
        NativeListResult.Err(
            when (format) {
                NativeFormat.DOCX -> DocxReadError.INVALID_DOCX.name.lowercase().replace('_', '-')
                NativeFormat.XLSX -> XlsxReadError.INVALID_XLSX.name.lowercase().replace('_', '-')
            },
        )
    }
}

/** T19: `.xlsx` writes are real now too (docx already was, T17) — neither
 *  native format refuses a mutation any more. Kept as a single named function
 *  (mirroring desktop's own `refuseNativeMutation`, also permanently null
 *  there) rather than deleted outright, so a FUTURE new native format has one
 *  place to wire a refusal into instead of a per-channel special case. */
fun refuseNativeMutation(filePath: String): Boolean = false

/** Generic Ok/Err result for a `.docx`/`.xlsx` WRITE dispatch — mirrors
 *  `NativeListResult` above, kept generic (unlike that one) because `add`
 *  returns a new comment id while reply/resolve/reopen/move return nothing. */
sealed class NativeMutateResult<out T> {
    data class Ok<T>(val value: T) : NativeMutateResult<T>()
    data class Err(val error: String) : NativeMutateResult<Nothing>()
}

/**
 * Resolves a `.docx`/`.xlsx` mutation's target the SAME way `listNativeComments`
 * resolves its read target: `resolveSourceFilePath`'s containment check when
 * `projectRoot` is given (already vetted by `refuseUnknownProjectRoot` at the
 * bridge layer before dispatch is ever reached — see that function's own doc
 * comment), or `allowUntrackedNativeRead`'s allowlist when it isn't. A write
 * is at least as sensitive as a read, so it gets the exact same gate, never a
 * looser one. Mirrors desktop's `resolveDocxTarget`/`resolveXlsxTarget`
 * (doc-comments-dispatch.ts).
 */
private fun resolveNativeWriteTarget(path: String, projectRoot: String?, homeDir: File): NativeMutateResult<String> {
    val resolved = resolveSourceFilePath(path, projectRoot, homeDir)
    if (resolved is StoreResult.Err) return NativeMutateResult.Err(resolved.error.wire)
    val absolutePath = (resolved as StoreResult.Ok).value
    if (projectRoot.isNullOrEmpty()) {
        if (!allowUntrackedNativeRead(absolutePath, homeDir, File(homeDir, ".claude"))) {
            return NativeMutateResult.Err("path-not-tracked")
        }
    }
    return NativeMutateResult.Ok(absolutePath)
}

// F2 (T17 implementation review, major/crash risk): every write dispatch
// function below now wraps its call into DocxComments.kt's own write
// pipeline in the SAME exception boundary `listNativeComments` already has
// for reads (see that function's own doc comment, F3, T4 review) — a
// corrupt-but-openable archive (a bad `w:id` that fails `.toIntOrNull()`
// somewhere this module doesn't already guard, a truncated deflate stream
// mid-write, an XML shape `javax.xml.parsers`' strict parser refuses that
// `readDocxComments` never needed to reach) can throw something other than
// the two typed exceptions `loadArchiveForWrite`/`writeDocxMutation` already
// catch (`DocxUnsafeXmlDoctypeException`, `ZipBombDetectedException`) — and
// before this fix, that throw escaped uncaught through this dispatch
// function, then `SessionService`'s own `serviceScope.launch { }` (no
// CoroutineExceptionHandler installed on that scope), which is a PROCESS
// CRASH on Android, not just a dropped response. `SecurityException`/
// `FileNotFoundException` map to `read-failed` (the file vanished or became
// unreadable between the containment check and the write, an I/O failure);
// everything else maps to `invalid-docx` — the SAME wire code
// `loadArchiveForWrite` itself already returns when `ZipFile(file)` fails to
// open at all, so a caller sees one consistent code for "this archive's
// content is unusable," not a leaked stack trace. `Exception`, never
// `Throwable` — an OOM or stack overflow is a real crash this boundary must
// not mask, same reasoning as `listNativeComments`'s own catch.
// T19: `invalidFormatWire` is now a parameter, not a hardcoded
// `DocxWriteError.INVALID_DOCX.wire` — this boundary is shared by BOTH
// native formats' dispatch functions, and reporting "invalid-docx" for a
// corrupt `.xlsx` (the wire code every xlsx call site got before this fix)
// would be a wrong, misleading refusal, not just an imprecise one. Defaults
// to docx's own wire code so every existing `.docx` call site above is
// unaffected; the new `.xlsx` dispatch functions below pass
// `XlsxWriteError.INVALID_XLSX.wire` explicitly.
private suspend fun <T> nativeMutateExceptionBoundary(
    invalidFormatWire: String = DocxWriteError.INVALID_DOCX.wire,
    block: suspend () -> NativeMutateResult<T>,
): NativeMutateResult<T> = try {
    block()
} catch (_: SecurityException) {
    NativeMutateResult.Err(DocxWriteError.READ_FAILED.wire)
} catch (_: java.io.FileNotFoundException) {
    NativeMutateResult.Err(DocxWriteError.READ_FAILED.wire)
} catch (_: Exception) {
    NativeMutateResult.Err(invalidFormatWire)
}

/** T17: Android's real `.docx` write dispatch — the Kotlin equivalent of
 *  desktop's `addNativeDocxComment`/etc. (doc-comments-dispatch.ts), calling
 *  straight into `DocxComments.kt`'s own write pipeline (§3.2a/§3.3). */
suspend fun addNativeDocxComment(
    path: String,
    projectRoot: String?,
    selector: CommentSelector,
    text: String,
    author: CommentAuthor,
    homeDir: File,
): NativeMutateResult<String> {
    val resolved = resolveNativeWriteTarget(path, projectRoot, homeDir)
    if (resolved is NativeMutateResult.Err) return resolved
    val absolutePath = (resolved as NativeMutateResult.Ok).value
    return nativeMutateExceptionBoundary {
        when (val r = addDocxComment(absolutePath, path, selector, text, author, homeDir)) {
            is DocxWriteResult.Ok -> NativeMutateResult.Ok(r.value)
            is DocxWriteResult.Err -> NativeMutateResult.Err(r.error.wire)
        }
    }
}

/** T5 review parity (design §1.6, F2): returns the real persisted
 *  `CommentReply` — the SAME enrichment desktop's own `docComments:reply`
 *  IPC response carries, so `DocCommentsBridge.kt`'s wire JSON stays in
 *  parity with desktop/remote. */
suspend fun replyToNativeDocxComment(
    path: String,
    projectRoot: String?,
    id: String,
    text: String,
    author: CommentAuthor,
    homeDir: File,
): NativeMutateResult<CommentReply> {
    val resolved = resolveNativeWriteTarget(path, projectRoot, homeDir)
    if (resolved is NativeMutateResult.Err) return resolved
    val absolutePath = (resolved as NativeMutateResult.Ok).value
    return nativeMutateExceptionBoundary {
        when (val r = replyToDocxComment(absolutePath, path, id, text, author, homeDir)) {
            is DocxWriteResult.Ok -> NativeMutateResult.Ok(r.value)
            is DocxWriteResult.Err -> NativeMutateResult.Err(r.error.wire)
        }
    }
}

/** `by` accepted for call-site symmetry with the generic `{path, id, by}`
 *  payload but not forwarded — see `resolveDocxComment`'s own doc comment
 *  (DocxComments.kt) for why a native Word comment has nowhere to record it. */
suspend fun resolveNativeDocxComment(path: String, projectRoot: String?, id: String, homeDir: File): NativeMutateResult<Unit> {
    val resolved = resolveNativeWriteTarget(path, projectRoot, homeDir)
    if (resolved is NativeMutateResult.Err) return resolved
    val absolutePath = (resolved as NativeMutateResult.Ok).value
    return nativeMutateExceptionBoundary {
        when (val r = resolveDocxComment(absolutePath, path, id, homeDir)) {
            is DocxWriteResult.Ok -> NativeMutateResult.Ok(Unit)
            is DocxWriteResult.Err -> NativeMutateResult.Err(r.error.wire)
        }
    }
}

suspend fun reopenNativeDocxComment(path: String, projectRoot: String?, id: String, homeDir: File): NativeMutateResult<Unit> {
    val resolved = resolveNativeWriteTarget(path, projectRoot, homeDir)
    if (resolved is NativeMutateResult.Err) return resolved
    val absolutePath = (resolved as NativeMutateResult.Ok).value
    return nativeMutateExceptionBoundary {
        when (val r = reopenDocxComment(absolutePath, path, id, homeDir)) {
            is DocxWriteResult.Ok -> NativeMutateResult.Ok(Unit)
            is DocxWriteResult.Err -> NativeMutateResult.Err(r.error.wire)
        }
    }
}

suspend fun moveNativeDocxComment(
    path: String,
    projectRoot: String?,
    id: String,
    newSelector: CommentSelector,
    homeDir: File,
): NativeMutateResult<Unit> {
    val resolved = resolveNativeWriteTarget(path, projectRoot, homeDir)
    if (resolved is NativeMutateResult.Err) return resolved
    val absolutePath = (resolved as NativeMutateResult.Ok).value
    return nativeMutateExceptionBoundary {
        when (val r = moveDocxComment(absolutePath, path, id, newSelector, homeDir)) {
            is DocxWriteResult.Ok -> NativeMutateResult.Ok(Unit)
            is DocxWriteResult.Err -> NativeMutateResult.Err(r.error.wire)
        }
    }
}

// -----------------------------------------------------------------------
// T19: Android's real `.xlsx` write dispatch — the Kotlin equivalent of
// desktop's `addNativeXlsxComment`/etc. (doc-comments-dispatch.ts), calling
// straight into `XlsxComments.kt`'s own write pipeline (§4.3/§4.3a). Mirrors
// the `.docx` dispatch functions above field-for-field; kept as its own
// exception-boundary wrapper (`XlsxWriteError.READ_FAILED`/`INVALID_XLSX`
// wire codes, not docx's) for the identical reason `nativeMutateExceptionBoundary`
// itself is generic over `NativeMutateResult<T>` — a corrupt-but-openable
// xlsx archive can throw something other than this module's own typed
// exceptions (already caught one layer in, inside `writeXlsxMutation` itself)
// before ever reaching a typed `XlsxWriteResult`, and this boundary is what
// turns THAT into a clean refusal instead of a process crash, the same
// reasoning F2 (T17 implementation review) already established for docx.
// -----------------------------------------------------------------------

suspend fun addNativeXlsxComment(
    path: String,
    projectRoot: String?,
    selector: CommentSelector,
    text: String,
    author: CommentAuthor,
    homeDir: File,
): NativeMutateResult<String> {
    val resolved = resolveNativeWriteTarget(path, projectRoot, homeDir)
    if (resolved is NativeMutateResult.Err) return resolved
    val absolutePath = (resolved as NativeMutateResult.Ok).value
    return nativeMutateExceptionBoundary(XlsxWriteError.INVALID_XLSX.wire) {
        when (val r = addXlsxComment(absolutePath, path, selector, text, author, homeDir)) {
            is XlsxWriteResult.Ok -> NativeMutateResult.Ok(r.value)
            is XlsxWriteResult.Err -> NativeMutateResult.Err(r.error.wire)
        }
    }
}

suspend fun replyToNativeXlsxComment(
    path: String,
    projectRoot: String?,
    id: String,
    text: String,
    author: CommentAuthor,
    homeDir: File,
): NativeMutateResult<CommentReply> {
    val resolved = resolveNativeWriteTarget(path, projectRoot, homeDir)
    if (resolved is NativeMutateResult.Err) return resolved
    val absolutePath = (resolved as NativeMutateResult.Ok).value
    return nativeMutateExceptionBoundary(XlsxWriteError.INVALID_XLSX.wire) {
        when (val r = replyToXlsxComment(absolutePath, path, id, text, author, homeDir)) {
            is XlsxWriteResult.Ok -> NativeMutateResult.Ok(r.value)
            is XlsxWriteResult.Err -> NativeMutateResult.Err(r.error.wire)
        }
    }
}

/** `by` accepted for call-site symmetry but not forwarded — see
 *  `resolveXlsxComment`'s own doc comment (XlsxComments.kt). */
suspend fun resolveNativeXlsxComment(path: String, projectRoot: String?, id: String, homeDir: File): NativeMutateResult<Unit> {
    val resolved = resolveNativeWriteTarget(path, projectRoot, homeDir)
    if (resolved is NativeMutateResult.Err) return resolved
    val absolutePath = (resolved as NativeMutateResult.Ok).value
    return nativeMutateExceptionBoundary(XlsxWriteError.INVALID_XLSX.wire) {
        when (val r = resolveXlsxComment(absolutePath, path, id, homeDir)) {
            is XlsxWriteResult.Ok -> NativeMutateResult.Ok(Unit)
            is XlsxWriteResult.Err -> NativeMutateResult.Err(r.error.wire)
        }
    }
}

suspend fun reopenNativeXlsxComment(path: String, projectRoot: String?, id: String, homeDir: File): NativeMutateResult<Unit> {
    val resolved = resolveNativeWriteTarget(path, projectRoot, homeDir)
    if (resolved is NativeMutateResult.Err) return resolved
    val absolutePath = (resolved as NativeMutateResult.Ok).value
    return nativeMutateExceptionBoundary(XlsxWriteError.INVALID_XLSX.wire) {
        when (val r = reopenXlsxComment(absolutePath, path, id, homeDir)) {
            is XlsxWriteResult.Ok -> NativeMutateResult.Ok(Unit)
            is XlsxWriteResult.Err -> NativeMutateResult.Err(r.error.wire)
        }
    }
}

/** T19's own `MoveComment` — returns the moved thread's FRESH id (§4.2/§4.3's
 *  own "never guessing at a stale hint" reasoning), unlike docx's move (a
 *  `TextQuoteSelector`-anchored comment's own id never changes on move). The
 *  IPC response shape (`DocCommentsBridge.kt`) stays `{ok:true}` either way,
 *  per §1.6's own reasoning — no tool or IPC caller currently reads a move's
 *  returned id back. */
suspend fun moveNativeXlsxComment(
    path: String,
    projectRoot: String?,
    id: String,
    newSelector: CommentSelector,
    homeDir: File,
): NativeMutateResult<String> {
    val resolved = resolveNativeWriteTarget(path, projectRoot, homeDir)
    if (resolved is NativeMutateResult.Err) return resolved
    val absolutePath = (resolved as NativeMutateResult.Ok).value
    return nativeMutateExceptionBoundary(XlsxWriteError.INVALID_XLSX.wire) {
        when (val r = moveXlsxComment(absolutePath, path, id, newSelector, homeDir)) {
            is XlsxWriteResult.Ok -> NativeMutateResult.Ok(r.value)
            is XlsxWriteResult.Err -> NativeMutateResult.Err(r.error.wire)
        }
    }
}
