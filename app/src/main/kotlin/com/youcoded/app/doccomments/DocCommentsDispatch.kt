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

import com.youcoded.app.artifacts.EditablePathPolicy
import com.youcoded.app.artifacts.canonicalize
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
 * WHY the sensitive-path denylist stands in for desktop's `authorizeBytesRead`
 * when `projectRoot` is absent: desktop's fallback gate additionally checks
 * the path against a roots allowlist (saved folders/indexed projects/tracked
 * artifacts) before reading raw bytes with no project context at all. This
 * Kotlin bridge follows the SAME precedent Android's own `artifacts:read-binary`
 * handler already set for exactly this class of read (SessionService.kt, "The
 * desktop roots-allowlist half is NOT ported... the Android bridge is only
 * reachable from the local WebView (no remote server), so the deny-list is
 * the load-bearing part here") — the sensitive-path denylist
 * (`EditablePathPolicy.isSensitivePath`) is the load-bearing check for a
 * no-`projectRoot` native read on this platform, not a full roots allowlist.
 *
 * F4 (implementation review) — threading contract: `readDocxComments`/
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
        if (EditablePathPolicy.isSensitivePath(canonicalize(absolutePath, null))) {
            return NativeListResult.Err("path-not-tracked")
        }
    }
    val file = File(absolutePath)
    if (!file.exists()) return NativeListResult.Err("read-failed")
    return when (format) {
        NativeFormat.DOCX -> when (val r = readDocxComments(file, path)) {
            is DocxReadResult.Ok -> NativeListResult.Ok(r.comments)
            is DocxReadResult.Err -> NativeListResult.Err(r.error.name.lowercase().replace('_', '-'))
        }
        NativeFormat.XLSX -> when (val r = readXlsxComments(file, path)) {
            is XlsxReadResult.Ok -> NativeListResult.Ok(r.comments)
            is XlsxReadResult.Err -> NativeListResult.Err(r.error.name.lowercase().replace('_', '-'))
        }
    }
}

/** add/reply/resolve/reopen/move against a `.docx`/`.xlsx` target: refused
 *  honestly until T17/T19 build the Kotlin write halves — see this file's
 *  own header. Kept as a single named check (mirroring desktop's now-
 *  always-null `refuseNativeMutation`) so a future task has one place to
 *  wire a real write into, rather than a per-channel special case. */
fun refuseNativeMutation(filePath: String): Boolean = nativeFormatFor(filePath) != null
