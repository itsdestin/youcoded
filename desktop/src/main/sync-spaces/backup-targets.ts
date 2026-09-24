import type { BackendInstance } from '../sync-state';
import type { BackupTarget } from './daily-backup';

export function selectSpaceBackupTargets(backends: BackendInstance[]): BackupTarget[] {
  // WHY: paused/storage-only destinations still allow manual Upload now, but
  // must never receive the automatic daily snapshot without explicit consent.
  return backends
    .filter((b) => b.syncEnabled === true && (b.type === 'drive' || b.type === 'icloud'))
    .map((b) => b.type === 'drive'
      ? { type: 'drive' as const, base: `${b.config?.rcloneRemote ?? 'gdrive'}:${b.config?.DRIVE_ROOT ?? 'Claude'}` }
      : { type: 'icloud' as const, base: b.config?.ICLOUD_PATH ?? '' })
    .filter((t) => t.base.length > 0);
}

// Production composition: read current config on every backup-target request,
// rather than caching a selection made at application startup.
export async function loadSpaceBackupTargets(
  getConfig: () => Promise<{ backends?: BackendInstance[] } | null>,
): Promise<BackupTarget[]> {
  const cfg = await getConfig();
  return selectSpaceBackupTargets(cfg?.backends ?? []);
}
