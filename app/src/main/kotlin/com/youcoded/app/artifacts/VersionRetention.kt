// Mirror of desktop/src/shared/artifacts/version-retention.ts.
//
// WHY THIS EXISTS ON ANDROID TOO
// ------------------------------
// The phone writes the SAME file the desktop does — <project>/.youcoded/artifacts.json —
// through ArtifactStore.appendVersion, and its append was just as un-capped
// (`existing.versions.add(versionEvent)`). Android is in fact the worse case:
// its store has no write queue and does three full reads of the file per
// recorded tool event (spec 2026-08-27 "Paged history…", §3), so an
// ever-growing sidecar costs more there, on the device with the least memory.
// A retention rule that only ran on the desktop would leave the phone growing
// without bound and would make the two platforms disagree about the same file.
//
// THE POLICY (approved by the project owner, 2026-09-03)
//   1. Drop version entries older than VERSION_RETENTION_DAYS.
//   2. BUT always keep at least VERSION_RETENTION_FLOOR of the most recent
//      entries per file, regardless of age — a project left dormant for two
//      months must not lose a file's whole history on its first edit back.
//   3. Never drop what a screen needs to render the record at all.
//
// Keep the two constants and the five keep-rules below in step with the
// TypeScript file; the desktop WHY comments there carry the full reasoning.
package com.youcoded.app.artifacts

import java.time.Instant
import java.time.OffsetDateTime

/** See version-retention.ts — change the policy in BOTH files. */
const val VERSION_RETENTION_DAYS = 30L

/** Safety floor: never leave a file with fewer than this many entries. */
const val VERSION_RETENTION_FLOOR = 10

private const val MS_PER_DAY = 24L * 60L * 60L * 1000L

/**
 * Parse a version's `ts`. Returns null when it cannot be dated — the caller
 * KEEPS those, because a retention rule must only remove what it can prove is
 * old. Instant.parse covers everything both platforms write
 * (Instant.now().toString() and JS toISOString()); the OffsetDateTime fallback
 * covers a hand-edited "+00:00"-style offset.
 */
private fun parseTs(ts: String): Long? =
    try {
        Instant.parse(ts).toEpochMilli()
    } catch (_: Exception) {
        try {
            OffsetDateTime.parse(ts).toInstant().toEpochMilli()
        } catch (_: Exception) {
            null
        }
    }

/**
 * Apply the retention policy to one record's version list, IN PLACE
 * (`ArtifactRecord.versions` is a `val` MutableList).
 *
 * Returns how many entries were removed. Pure apart from that mutation, and
 * `nowMs` is injectable only so tests can age entries deterministically.
 */
fun pruneVersions(versions: MutableList<VersionEvent>, nowMs: Long = System.currentTimeMillis()): Int {
    // Fast path AND the floor's hard guarantee: a record at or under the floor
    // is never touched, so pruning can never empty a record.
    if (versions.size <= VERSION_RETENTION_FLOOR) return 0

    val cutoffMs = nowMs - VERSION_RETENTION_DAYS * MS_PER_DAY
    val keep = HashSet<Int>()

    // (a) Anything we cannot date is kept — see parseTs.
    val datable = ArrayList<Pair<Int, Long>>(versions.size)
    versions.forEachIndexed { i, v ->
        val t = parseTs(v.ts)
        if (t == null) keep.add(i) else datable.add(i to t)
    }

    // Most recent first; ties break toward the LATER array position so the
    // ordering is total and stable — that is what makes pruning idempotent
    // when a replayed batch lands in the same millisecond.
    val byRecency = datable.sortedWith(compareByDescending<Pair<Int, Long>> { it.second }.thenByDescending { it.first })

    // (b) The floor — the N most recent survive whatever their age.
    byRecency.take(VERSION_RETENTION_FLOOR).forEach { keep.add(it.first) }

    // (c) The retention window — everything younger than the cutoff survives.
    datable.forEach { (i, t) -> if (t >= cutoffMs) keep.add(i) }

    // (d) The entry representing the file's CURRENT STATE. `status` is
    //     documented as derived from the latest version, so the newest entry is
    //     pinned explicitly. Both the last slot and the newest timestamp are
    //     pinned because the two can disagree in a hand-edited file.
    keep.add(versions.size - 1)
    if (byRecency.isNotEmpty()) keep.add(byRecency[0].first)

    // (e) The newest non-'read' entry. Load-bearing for the UI: the desktop's
    //     trackedArtifacts() decides whether an in-project file shows in
    //     Project View at all with `versions.some(v => v.type !== 'read')`, and
    //     that same renderer runs on the phone against this file. A file
    //     created months ago and merely opened since would otherwise lose its
    //     only 'create' entry and vanish from the file list.
    byRecency.firstOrNull { versions[it.first].type != "read" }?.let { keep.add(it.first) }

    if (keep.size == versions.size) return 0
    val kept = versions.filterIndexed { i, _ -> keep.contains(i) }   // original order preserved
    val removed = versions.size - kept.size
    versions.clear()
    versions.addAll(kept)
    return removed
}

/**
 * Apply the policy to every record in a sidecar, in place. Returns how many
 * entries were removed in total (0 means the object is untouched).
 */
fun pruneSidecarVersions(sidecar: ProjectSidecar, nowMs: Long = System.currentTimeMillis()): Int {
    var removed = 0
    for (record in sidecar.artifacts) removed += pruneVersions(record.versions, nowMs)
    return removed
}
