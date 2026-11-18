import type { BackendInstance } from '../sync-state';
import type { BackupTarget } from './daily-backup';
import { isRunningOnPhone } from '../backup-platform';

/** One backend as a copy destination, or null when it cannot be one here.
 *  WHY the phone check (backup fixes 2026-11-18): a phone has no rclone, so a Drive entry there (migrated from
 *  the old app) failed every hourly spaces backup with a log line and could never succeed. */
export function targetForBackend(b: BackendInstance): BackupTarget | null {
  if (b.type === 'drive') {
    if (isRunningOnPhone()) return null;
    return { type: 'drive', base: `${b.config?.rcloneRemote ?? 'gdrive'}:${b.config?.DRIVE_ROOT ?? 'Claude'}` };
  }
  if (b.type === 'icloud') {
    const base = b.config?.ICLOUD_PATH ?? '';
    return base.length > 0 ? { type: 'icloud', base } : null;
  }
  return null;
}

function selectSpaceBackupTargets(backends: BackendInstance[]): BackupTarget[] {
  // WHY: paused/storage-only destinations still allow manual Upload now, but
  // must never receive the automatic daily snapshot without explicit consent.
  return backends
    .filter((b) => b.syncEnabled === true)
    .map(targetForBackend)
    .filter((t): t is BackupTarget => t !== null);
}

// Production composition: read current config on every backup-target request,
// rather than caching a selection made at application startup.
export async function loadSpaceBackupTargets(
  getConfig: () => Promise<{ backends?: BackendInstance[] } | null>,
): Promise<BackupTarget[]> {
  const cfg = await getConfig();
  return selectSpaceBackupTargets(cfg?.backends ?? []);
}
