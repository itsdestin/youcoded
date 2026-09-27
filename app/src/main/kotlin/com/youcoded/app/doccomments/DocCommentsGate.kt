// Shared `projectRoot` gate for Android's docComments:* surface — T4 of the
// doc-comments build (docs/active/specs/2026-09-26-doc-comments-build-
// design.md §1.5). Kotlin port of desktop/src/main/doc-comments/doc-comments-
// gate.ts's `refuseUnknownProjectRoot`, using Android's OWN notion of a
// "known project root" rather than desktop's `isKnownRoot()` (which reads a
// central index + saved-folders store that only exists in the Electron main
// process) — the same authority `WorkingDirStore`/`CentralIndex.listProjects`
// already give `artifacts:get`/`artifacts:save`'s own relative-record judging
// (ProjectManager.kt's `judgeRelativeRecord`) on this platform.
//
// WHY this exists (mirrors the TS module's own WHY, T3 build review F1 —
// blocker, security): doc-comments-store.ts's containment check only proves
// a `path` resolves INSIDE whatever `projectRoot` it is given — nothing
// proves `projectRoot` itself is a folder the app actually recognizes. A
// caller naming `projectRoot: "/"` (or the phone's home directory) would
// make that containment check a no-op, so every docComments:* channel could
// create/mutate a sidecar anywhere on disk, and a `.docx`/`.xlsx` `list`
// could read and parse any such file on the device. This module is the ONE
// place that decision is made, reused identically by every channel's `when`
// branch in SessionService.kt — never a per-channel re-derivation.
//
// `extraSessionRoots` mirrors remote-server.ts's own `sessionRoots()` /
// desktop's `useActiveProject.ts` synthetic-project fallback (§1.4): a live
// session's own cwd counts as known even when it was never saved as a
// working directory or indexed, so a file opened from an unregistered
// session's drawer doesn't start refusing. The caller (SessionService.kt)
// supplies its OWN live session cwds; this module never discovers them.
package com.youcoded.app.doccomments

import com.youcoded.app.artifacts.EditablePathPolicy
import com.youcoded.app.artifacts.ReadResult
import com.youcoded.app.artifacts.canonicalize
import com.youcoded.app.artifacts.listProjects
import com.youcoded.app.artifacts.readSidecar
import com.youcoded.app.config.WorkingDirStore
import java.io.File

/** Canonicalizes `path` two ways — string-normalized (`canonicalize`, no fs
 *  touch) and filesystem-real (`File.canonicalPath`, follows symlinks) —
 *  mirroring desktop's `withRealForms`. Either form matching a known root is
 *  enough: a caller may spell the same root either way. */
private fun realForms(path: String): Set<String> {
    val out = mutableSetOf<String>()
    if (path.isEmpty()) return out
    out.add(canonicalize(path, null))
    try {
        out.add(canonicalize(File(path).canonicalPath, null))
    } catch (_: java.io.IOException) {
        // Doesn't exist / unresolvable — the string form above still applies.
    }
    return out
}

/** The device's known project roots: saved working directories +
 *  central-index projects, mirroring desktop's own `knownRoots()`
 *  (readFolders() + listProjects(CLAUDE_DIR)) — plus the caller's own live
 *  session cwds, which the TS side folds in as `extraRoots` at the call
 *  site rather than discovering independently. */
private fun knownRoots(homeDir: File, claudeDir: File, extraSessionRoots: List<String>): Set<String> {
    val saved = WorkingDirStore(homeDir).dirs.value.map { it.path }
    val indexed = listProjects(claudeDir.path).map { it.path }
    val all = saved + indexed + extraSessionRoots
    val out = mutableSetOf<String>()
    for (root in all) out.addAll(realForms(root))
    return out
}

/**
 * Refuses when `projectRoot` is present but is not a root the app itself
 * shows — a saved working directory, an indexed project, or one of
 * `extraSessionRoots`. Returns `null` (proceed) when `projectRoot` is null or
 * empty: the caller then takes the fallback (loose-file) path, which never
 * claims a project at all (§1.4) and is gated separately, at the point it
 * would read a file's actual bytes (see DocCommentsDispatch.kt).
 */
fun refuseUnknownProjectRoot(
    projectRoot: String?,
    homeDir: File,
    claudeDir: File,
    extraSessionRoots: List<String> = emptyList(),
): Boolean {
    if (projectRoot.isNullOrEmpty()) return false
    val known = knownRoots(homeDir, claudeDir, extraSessionRoots)
    return realForms(projectRoot).none { known.contains(it) }
}

/**
 * F4 (T4 implementation review, major/security): the allowlist a
 * no-`projectRoot` native (`.docx`/`.xlsx`) read now checks — replacing that
 * read's own former denylist-only design (see `DocCommentsDispatch.kt`'s
 * `listNativeComments`, whose doc comment has the full before/after
 * reasoning). Mirrors desktop's two-pass `evaluateBinaryRead`
 * (`read-binary-access.ts`):
 *
 *  1. Refuse a well-known secret location OUTRIGHT, even one that happens to
 *     sit under an otherwise-allowed root (`EditablePathPolicy.isSensitivePath`
 *     — the SAME denylist this read used to rely on alone, kept as a
 *     first-pass check, not replaced).
 *  2. Otherwise allow only a path that is itself (or a descendant of) one of
 *     the app's own known project roots, OR one recorded as a tracked
 *     EXTERNAL artifact / manual include in ANY of those projects' own
 *     `.youcoded/artifacts.json` sidecars — desktop's own comment on this
 *     second pass explains why it exists: "a temp-dir xlsx the session
 *     drawer legitimately shows lives outside every root."
 *
 * Deliberately excludes live session cwds, unlike `refuseUnknownProjectRoot`
 * above (which DOES fold them in via `extraSessionRoots`) — mirrors
 * desktop's OWN `knownRoots()` as used INSIDE `authorizeBytesRead`
 * specifically (not the broader one `doc-comments-gate.ts`'s
 * `refuseUnknownProjectRoot` uses), whose own comment says why: "a phone can
 * start a session in any folder, and a by-path read there handed out every
 * file in it." `absolutePath` need not be pre-canonicalized — every
 * comparison below goes through `realForms` itself, same as
 * `refuseUnknownProjectRoot`.
 */
fun allowUntrackedNativeRead(absolutePath: String, homeDir: File, claudeDir: File): Boolean {
    val forms = realForms(absolutePath)
    if (forms.any { EditablePathPolicy.isSensitivePath(it) }) return false
    val roots = knownRoots(homeDir, claudeDir, emptyList())
    if (forms.any { f -> roots.any { r -> f == r || f.startsWith(r + File.separator) } }) return true
    for (root in roots) {
        val sidecar = when (val r = readSidecar(root)) {
            is ReadResult.Ok -> r.sidecar
            else -> continue
        }
        for (a in sidecar.artifacts) {
            if (a.kind == "external" && a.absolutePath != null && realForms(a.absolutePath).any { forms.contains(it) }) return true
        }
        for (inc in sidecar.manualIncludes) {
            if (realForms(inc.path).any { forms.contains(it) }) return true
        }
    }
    return false
}
