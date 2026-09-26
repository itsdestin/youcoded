import { describe, it, expect } from 'vitest';
import { snapshotsToDelete, shouldStampDailyMarker } from '../src/main/snapshot-retention';

// All tests pin "today" to 2026-07-14 (UTC) so they're fully deterministic.
const TODAY = new Date(Date.UTC(2026, 6, 14)); // month is 0-indexed → 6 = July

describe('snapshotsToDelete', () => {
  it('returns [] for an empty list', () => {
    expect(snapshotsToDelete([], TODAY)).toEqual([]);
  });

  it('keeps all snapshots aged <= 7 days (all-recent list)', () => {
    // ages 0..7 relative to 2026-07-14
    const recent = ['2026-07-14', '2026-07-13', '2026-07-10', '2026-07-07'];
    expect(snapshotsToDelete(recent, TODAY)).toEqual([]);
  });

  it('keep-all (<=7d) wins over week-bucketing even for same-week snapshots', () => {
    // 2026-07-08 (age 6) and 2026-07-10 (age 4) are same ISO week but both <=7d,
    // so both are kept — proving the 7/8-day boundary.
    expect(snapshotsToDelete(['2026-07-08', '2026-07-10'], TODAY)).toEqual([]);
  });

  it('keeps only the newest snapshot per ISO week in the 8..28d tier', () => {
    // 2026-06-29 (age 15) and 2026-07-01 (age 13) are the same ISO week.
    // Newest (2026-07-01) kept, older (2026-06-29) deleted.
    expect(snapshotsToDelete(['2026-06-29', '2026-07-01'], TODAY)).toEqual(['2026-06-29']);
  });

  it('treats day 28 as week-bucketed (not month/delete)', () => {
    // age 28 (2026-06-16) and age 27 (2026-06-17), same ISO week → newer kept, day-28 deleted.
    expect(snapshotsToDelete(['2026-06-16', '2026-06-17'], TODAY)).toEqual(['2026-06-16']);
  });

  it('keeps only the newest snapshot per calendar month in the 29..90d tier', () => {
    // 2026-05-10 (age 65) and 2026-05-20 (age 55), same month → newer kept, older deleted.
    expect(snapshotsToDelete(['2026-05-10', '2026-05-20'], TODAY)).toEqual(['2026-05-10']);
  });

  it('keeps a day-90 snapshot (month-bucketed) but deletes a day-91 snapshot', () => {
    // 2026-04-15 is exactly age 90 (month-tiered, sole April member → kept).
    // 2026-04-14 is age 91 (>90 → deleted outright).
    expect(snapshotsToDelete(['2026-04-15', '2026-04-14'], TODAY)).toEqual(['2026-04-14']);
  });

  it('never returns unparseable names for deletion', () => {
    const names = ['personal', 'Backup', '2026-13-99', 'random', '2026-01-01', '2026-07-13'];
    // Only the valid, >90d date is deleted; every unparseable name is kept.
    expect(snapshotsToDelete(names, TODAY)).toEqual(['2026-01-01']);
  });

  it('buckets TWO distinct ISO weeks independently (no bucket-key collision)', () => {
    // Week A: 2026-06-29 (age 15) + 2026-07-01 (age 13) → delete 2026-06-29
    // Week B: 2026-06-22 (age 22) + 2026-06-24 (age 20) → delete 2026-06-22
    // Both weeks are in the 8..28d tier; the newest in EACH week is kept.
    const names = ['2026-06-22', '2026-06-24', '2026-06-29', '2026-07-01'];
    expect(snapshotsToDelete(names, TODAY).sort()).toEqual(['2026-06-22', '2026-06-29']);
  });

  it('buckets TWO distinct calendar months independently (no bucket-key collision)', () => {
    // May: 2026-05-10 (age 65) + 2026-05-20 (age 55) → delete 2026-05-10
    // June: 2026-06-05 (age 39) + 2026-06-10 (age 34) → delete 2026-06-05
    // Both months are in the 29..90d tier; the newest in EACH month is kept.
    const names = ['2026-05-10', '2026-05-20', '2026-06-05', '2026-06-10'];
    expect(snapshotsToDelete(names, TODAY).sort()).toEqual(['2026-05-10', '2026-06-05']);
  });
});

describe('shouldStampDailyMarker', () => {
  it('stamps only when due, every destination was tried, and every one succeeded', () => {
    expect(shouldStampDailyMarker(true, true, [true])).toBe(true);
    expect(shouldStampDailyMarker(true, true, [true, true])).toBe(true);
  });
  it('does NOT stamp when any destination failed (it must retry the same day)', () => {
    expect(shouldStampDailyMarker(true, true, [true, false])).toBe(false);
    expect(shouldStampDailyMarker(true, true, [false])).toBe(false);
  });
  it('does NOT stamp for a one-destination manual upload or a cycle with no snapshot destination', () => {
    expect(shouldStampDailyMarker(true, false, [true])).toBe(false);
    expect(shouldStampDailyMarker(true, true, [])).toBe(false);
  });
  it('does NOT stamp when not due, regardless of success', () => {
    expect(shouldStampDailyMarker(false, true, [true])).toBe(false);
    expect(shouldStampDailyMarker(false, true, [false])).toBe(false);
  });
});

describe('snapshotsToDelete keeps the newest snapshot', () => {
  it('never deletes the newest folder, even past 90 days', () => {
    expect(snapshotsToDelete(['2025-01-01', '2025-02-01'], TODAY)).toEqual(['2025-01-01']);
  });
});
