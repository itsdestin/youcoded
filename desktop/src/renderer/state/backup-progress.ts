// Which "a backup is copying" presentations ship (backup fixes 2026-11-18, B-1).
//
// The row in Settings -> Backup & sync always shows "Uploading..." while a copy runs (real state from the backend, so it
// survives closing and reopening the panel). Whether the STATUS BAR also gets a "Backing up..." chip is Destin's pick
// after comparing pictures of both; he chose to ship the chip too (deck U-2, 2026-11-25). It still follows the
// status bar's own 'Sync warnings' switch. Flip this constant to turn the chip off again.
export const BACKUP_PROGRESS_CHIP_ENABLED = true;

/** The chip draws only while a copy is running and the chip is switched on. */
export function showBackupProgressChip(copyingBackendIds: readonly string[] | undefined, enabled: boolean = BACKUP_PROGRESS_CHIP_ENABLED): boolean {
  return enabled && !!copyingBackendIds && copyingBackendIds.length > 0;
}
