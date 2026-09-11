import type { BackendInstance } from '../sync-state';
import type { BackupTarget } from './daily-backup';

export function selectSpaceBackupTargets(backends: BackendInstance[]): BackupTarget[] {
  return backends
    .filter((b) => b.syncEnabled === true && (b.type === 'drive' || b.type === 'icloud'))
    .map((b) => b.type === 'drive'
      ? { type: 'drive' as const, base: `${b.config?.rcloneRemote ?? 'gdrive'}:${b.config?.DRIVE_ROOT ?? 'Claude'}` }
      // iCloud base is a local folder path — drop backends that never set one.
      : { type: 'icloud' as const, base: b.config?.ICLOUD_PATH ?? '' })
    .filter((t) => t.base.length > 0);
}
