// Retention policy for an artifact record's version history.
//
// WHY THIS EXISTS
// ---------------
// `appendVersion` pushed every recorded tool call onto `ArtifactRecord.versions[]`
// with no cap, no eviction and no pruning, so `<project>/.youcoded/artifacts.json`
// only ever grew. Every save and every listing parses that whole file, and an
// over-large sidecar is what made the two August 2026 out-of-memory crashes
// reachable (6.4 MB / 21,311 versions measured in one project on 2026-08-27).
// The read-side costs were mitigated by PR #318 and PR #335; the GROWTH was not.
// Investigation: docs/active/investigations/2026-09-01-sidecar-versions-unbounded.md
//
// THE POLICY (approved by the project owner, 2026-09-03)
// -----------------------------------------------------
//   1. Drop version entries older than VERSION_RETENTION_DAYS.
//   2. BUT always keep at least VERSION_RETENTION_FLOOR of the most recent
//      entries per file, regardless of age.
//   3. Never drop what a screen needs to render the record at all.
//
// Rule 2 is the reason rule 1 is safe. Without a floor, a project left alone for
// two months would lose a file's ENTIRE history the moment it was touched
// again — which is exactly the case where the old history is most likely to
// still matter to someone.
//
// This module is PURE (no fs, no path, no clock unless you pass one) so the
// policy is unit-testable on its own and can never touch a live sidecar by
// accident — same shape as migrate-relative-externals.ts next door.
// Kotlin mirror: app/.../artifacts/VersionRetention.kt (Android writes the same
// file and must apply the same policy — see the WHY there).

import type { ProjectSidecar, VersionEvent } from './types';

/** Version entries older than this many days are eligible to be dropped.
 *  30 days is the owner's call: long enough that "what happened to this file
 *  recently" is always answerable, short enough that a busy project's sidecar
 *  stops being the biggest file in the folder. Change the policy HERE — this
 *  constant and the floor below are the only two knobs. */
export const VERSION_RETENTION_DAYS = 30;

/** …but never leave a file with fewer than this many version entries, no
 *  matter how old they are. This is the safety floor on the rule above: a
 *  dormant project must not have its history erased by the first edit after a
 *  long gap. 10 keeps a readable recent history for every file at a cost of
 *  ~3 KB per file, which is nothing next to the megabytes this bounds. */
export const VERSION_RETENTION_FLOOR = 10;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Apply the retention policy to one record's version list.
 *
 * Returns the SAME array reference when nothing is dropped, so callers can
 * cheaply tell "unchanged" from "pruned" without comparing contents.
 *
 * `nowMs` is injectable purely so tests can age entries deterministically;
 * production always passes the real clock.
 */
export function pruneVersions(versions: VersionEvent[], nowMs: number = Date.now()): VersionEvent[] {
  // Fast path AND the floor's hard guarantee in one line: a record at or under
  // the floor is never touched, so pruning can never empty a record.
  if (versions.length <= VERSION_RETENTION_FLOOR) return versions;

  const cutoffMs = nowMs - VERSION_RETENTION_DAYS * MS_PER_DAY;
  const keep = new Set<number>();

  // (a) Anything we cannot date is KEPT. A hand-edited or foreign sidecar with
  //     an unparseable `ts` must not have entries deleted on a guess — the
  //     whole point of a retention rule is that it only removes what it can
  //     prove is old.
  const datable: { i: number; t: number }[] = [];
  versions.forEach((v, i) => {
    const t = Date.parse(v.ts);
    if (Number.isNaN(t)) keep.add(i);
    else datable.push({ i, t });
  });

  // Most recent first. Ties break toward the LATER array position, so the
  // ordering is total and stable — that is what makes pruning idempotent when
  // several entries share a timestamp (a replayed batch lands in the same ms).
  const byRecency = [...datable].sort((a, b) => b.t - a.t || b.i - a.i);

  // (b) The floor — the N most recent survive whatever their age.
  for (const { i } of byRecency.slice(0, VERSION_RETENTION_FLOOR)) keep.add(i);

  // (c) The retention window — everything younger than the cutoff survives.
  for (const { i, t } of datable) if (t >= cutoffMs) keep.add(i);

  // (d) The entry that represents the file's CURRENT STATE. `status` is
  //     documented in types.ts as "derived from the latest version", and
  //     migrate-relative-externals.ts re-derives it from `versions[last]`, so
  //     the newest entry is pinned explicitly rather than left to rule (b).
  //     Both the last array slot and the newest timestamp are pinned because
  //     the two can disagree in a merged/hand-edited file.
  keep.add(versions.length - 1);
  if (byRecency.length > 0) keep.add(byRecency[0].i);

  // (e) The newest entry that is NOT a 'read'. This one is load-bearing for the
  //     UI, not for the data: trackedArtifacts() in main/artifacts/visible-artifacts.ts
  //     decides whether an in-project file appears in Project View at all with
  //     `versions.some(v => v.type !== 'read')`. A file created three months ago
  //     and merely opened a dozen times since would otherwise lose its only
  //     'create' entry and VANISH from the file list. Keeping one non-'read'
  //     entry makes that test's answer identical before and after pruning.
  const newestNonRead = byRecency.find(({ i }) => versions[i].type !== 'read');
  if (newestNonRead) keep.add(newestNonRead.i);

  if (keep.size === versions.length) return versions;   // nothing to drop
  return versions.filter((_, i) => keep.has(i));        // original order preserved
}

/**
 * Apply the policy to every record in a sidecar, IN PLACE. Returns how many
 * entries were removed (0 means the object is untouched).
 *
 * Callers must own a private copy of the sidecar — `readSidecarShared` hands
 * out a copy that is read-only by contract (see artifact-store.ts).
 */
export function pruneSidecarVersions(sidecar: ProjectSidecar, nowMs: number = Date.now()): number {
  let removed = 0;
  for (const record of sidecar.artifacts) {
    const next = pruneVersions(record.versions, nowMs);
    if (next !== record.versions) {
      removed += record.versions.length - next.length;
      record.versions = next;
    }
  }
  return removed;
}
