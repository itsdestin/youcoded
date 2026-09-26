// snapshot-retention.ts — PURE tiered retention for dated daily backup snapshots.
//
// Given the dated snapshot folder names (YYYY-MM-DD) that exist in a backend's
// Backup/ dir and "today", decide which folders to DELETE. This is the classic
// grandfather-father-son scheme (Destin's decision):
//
//   age <= 7 days      → keep every snapshot (dailies)
//   8 <= age <= 28     → keep only the NEWEST snapshot per ISO calendar week
//   29 <= age <= 90    → keep only the NEWEST snapshot per calendar month
//   age > 90 days      → delete
//
// Fail-safe: any folder name that isn't a valid YYYY-MM-DD date is treated as
// unknown and NEVER returned for deletion — so a stray "personal"/"spaces"/etc.
// dir sitting under Backup/ can never be purged by the retention sweep.
//
// This module is deliberately IO-free (pure function) so it can be unit-tested
// exhaustively; the thin IO shell (rclone purge / fs.rm) lives in sync-service.ts.

/** Parse a strict YYYY-MM-DD name into a UTC-midnight Date, or null if invalid. */
function parseSnapshotName(name: string): Date | null {
  // Regex first (rejects arbitrary dir names), then a real-date round-trip so
  // regex-passing-but-invalid dates like 2026-13-99 / 2026-02-30 are rejected.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) return null;
  const d = new Date(`${name}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  if (d.toISOString().slice(0, 10) !== name) return null; // e.g. rolled-over invalid day
  return d;
}

/** Whole UTC days between a snapshot date and today (both at UTC midnight). */
function ageInDays(snapshot: Date, today: Date): number {
  const snapMid = Date.UTC(snapshot.getUTCFullYear(), snapshot.getUTCMonth(), snapshot.getUTCDate());
  const todayMid = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.floor((todayMid - snapMid) / 86400000);
}

/** ISO-8601 week key "YYYY-Www" (ISO week-year + week number) for grouping. */
function isoWeekKey(d: Date): string {
  // Shift to the Thursday of this week — ISO week-year is defined by that Thursday.
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const isoYear = date.getUTCFullYear();
  // Week 1 is the week containing Jan 4th.
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/**
 * Reduce a group of snapshot names to the ones to DELETE: keep the newest
 * (lexicographically max — safe for YYYY-MM-DD), delete the rest.
 */
function deleteAllButNewest(group: string[]): string[] {
  if (group.length <= 1) return [];
  const newest = group.reduce((a, b) => (a > b ? a : b));
  return group.filter(n => n !== newest);
}

/**
 * Decide whether to stamp today's daily snapshot marker after a push() cycle.
 * The marker is ONE stamp for every destination, so it may close the day only
 * when the cycle covered every sync-enabled snapshot backend (Drive/iCloud) and
 * EACH finished with zero errors. WHY every, not any: Drive succeeding used to
 * stamp the day while iCloud had failed, so iCloud never retried; likewise a
 * manual Upload now to one destination closed the day for the others. A
 * failure leaves the marker unwritten and the next hourly poll retries (rclone
 * --update makes re-copying the finished destinations cheap). Pure so it's
 * unit-tested.
 */
export function shouldStampDailyMarker(due: boolean, coveredAll: boolean, snapshotOutcomes: boolean[]): boolean {
  return due && coveredAll && snapshotOutcomes.length > 0 && snapshotOutcomes.every(Boolean);
}

export function snapshotsToDelete(folderNames: string[], today: Date): string[] {
  const toDelete: string[] = [];
  const weekBuckets = new Map<string, string[]>();   // 8..28d, grouped by ISO week
  const monthBuckets = new Map<string, string[]>();  // 29..90d, grouped by YYYY-MM

  // Plain get-or-create push into a bucket Map (readable for a non-dev maintainer).
  const addTo = (buckets: Map<string, string[]>, key: string, name: string) => {
    let group = buckets.get(key);
    if (!group) {
      group = [];
      buckets.set(key, group);
    }
    group.push(name);
  };

  for (const name of folderNames) {
    const date = parseSnapshotName(name);
    if (!date) continue; // unparseable → never delete (fail-safe)

    const age = ageInDays(date, today);
    if (age <= 7) continue; // keep-all tier
    if (age <= 28) {
      addTo(weekBuckets, isoWeekKey(date), name);
    } else if (age <= 90) {
      addTo(monthBuckets, name.slice(0, 7) /* YYYY-MM */, name);
    } else {
      toDelete.push(name); // age > 90 → delete outright
    }
  }

  for (const group of weekBuckets.values()) toDelete.push(...deleteAllButNewest(group));
  for (const group of monthBuckets.values()) toDelete.push(...deleteAllButNewest(group));
  // WHY: the newest snapshot is the last known-good copy — kept past any age,
  // so months of failed backups can never leave zero.
  const newest = folderNames.filter((n) => parseSnapshotName(n)).reduce((a, b) => (a > b ? a : b), '');
  return toDelete.filter((n) => n !== newest);
}
