import { Button } from './ui';
import { BackupLogo } from './BackupLogo';
import { backupTypeOffered } from './backup-availability';

/**
 * The two buttons Backup & sync shows when "Keep a second copy" is on but nothing is connected yet.
 *
 * WHY its own file, and why each button asks backupTypeOffered (backup fixes 2026-11-18): this picker had no platform
 * check at all — it offered Google Drive on a phone (which has no tool to run it) and iCloud on a phone and on Linux
 * (which have no iCloud). With nothing offered it draws nothing.
 */
export function BackupTypePicker({ onPick }: { onPick: (type: 'drive' | 'icloud') => void }) {
  const drive = backupTypeOffered('drive');
  const icloud = backupTypeOffered('icloud');
  if (!drive && !icloud) return null;
  return (
    <div className="flex gap-2">
      {drive && (
        <Button variant="secondary" onClick={() => onPick('drive')} className="flex-1">
          <BackupLogo type="drive" size={14} />
          Google Drive
        </Button>
      )}
      {icloud && (
        <Button variant="secondary" onClick={() => onPick('icloud')} className="flex-1">
          <BackupLogo type="icloud" size={14} />
          iCloud
        </Button>
      )}
    </div>
  );
}
