// Which "a backup is copying" presentations ship (backup fixes 2026-11-18, B-1).
//
// The row in Settings -> Backup & sync always shows "Uploading..." while a copy runs (real state from the backend, so it
// survives closing and reopening the panel). Whether the STATUS BAR also gets a "Backing up..." chip is Destin's pick
// after comparing pictures of both; until he decides it stays off, so users see only the row. Flip this one constant
// to ship the chip too (or delete the chip and this file to ship the row alone).
export const BACKUP_PROGRESS_CHIP_ENABLED = false;

/** The chip draws only while a copy is running and the chip is switched on. */
export function showBackupProgressChip(copyingBackendIds: readonly string[] | undefined, enabled: boolean = BACKUP_PROGRESS_CHIP_ENABLED): boolean {
  return enabled && !!copyingBackendIds && copyingBackendIds.length > 0;
}
