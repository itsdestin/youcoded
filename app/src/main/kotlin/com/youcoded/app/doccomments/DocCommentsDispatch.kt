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
// WRITE (add/reply/resolve/reopen/move) is NOT yet real for `.docx`/`.xlsx`
// on Android: T17 (Word write) and T19 (Excel write) — the Kotlin ports of
// desktop's `addDocxComment`/`addXlsxComment` etc. — are separate, not-yet-
// built tasks per the design's own task table (T4's row: "dispatching to
// DocxComments.kt/XlsxComments.kt for .docx/.xlsx targets — T16/T17/T18/T19
// below, not this task"). Until T17/T19 land, a native-format mutation
// refuses with a typed `not-yet-supported` — the SAME shape desktop's own
// `refuseNativeMutation` answered before T11/T13 landed (doc-comments-
// dispatch.ts). This is an honest interim answer, not a silent no-op: the
// phone reports "not yet supported" rather than claiming success or hanging.
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

/** add/reply/resolve/reopen/move against a `.docx`/`.xlsx` target: refused
 *  honestly until T17/T19 build the Kotlin write halves — see this file's
 *  own header. Kept as a single named check (mirroring desktop's now-
 *  always-null `refuseNativeMutation`) so a future task has one place to
 *  wire a real write into, rather than a per-channel special case. */
fun refuseNativeMutation(filePath: String): Boolean = nativeFormatFor(filePath) != null
