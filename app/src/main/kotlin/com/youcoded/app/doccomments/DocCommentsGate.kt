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

import com.youcoded.app.artifacts.canonicalize
import com.youcoded.app.artifacts.listProjects
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
