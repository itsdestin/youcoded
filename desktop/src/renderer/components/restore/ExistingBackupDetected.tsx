import React from 'react';
import type { RestoreCategory } from '../../../shared/types';

// Shown inside SyncSetupWizard when probe() detects existing data on the
// chosen backend during first-time setup. Gives the user a choice before
// we do anything destructive on either side.

type Props = {
  backendId: string;
  backendLabel: string;
  categories: RestoreCategory[];
  onRestore: () => void;
  onStartFresh: () => void;
};

export function ExistingBackupDetected({
  backendLabel,
  categories,
  onRestore,
  onStartFresh,
}: Props) {
  const catList = categories.length > 0 ? categories.join(', ') : 'data';
  return (
    <div className="rounded-md border border-edge bg-inset/40 px-4 py-3 flex flex-col gap-3">
      <div>
        <div className="text-sm font-medium text-fg">Existing backup detected</div>
        <div className="text-[11px] text-fg-dim mt-1">
          We found existing backup data at <span className="text-fg">{backendLabel}</span>:{' '}
          <span className="text-fg capitalize">{catList}</span>. Would you like to restore it to
          this device, or start fresh?
        </div>
      </div>

      <div className="flex items-center gap-2 justify-end">
        <button
          onClick={onStartFresh}
          className="px-3 py-1.5 rounded-md text-[11px] font-medium bg-inset hover:bg-edge text-fg-muted transition-colors"
        >
          Start fresh
        </button>
        <button
          onClick={onRestore}
          className="px-3 py-1.5 rounded-md text-[11px] font-medium bg-accent hover:opacity-90 text-on-accent transition-colors"
        >
          Restore from backup
        </button>
      </div>
    </div>
  );
}
