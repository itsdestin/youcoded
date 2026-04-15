import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { RestoreWizard } from './RestoreWizard';

// Small entry-point button that drops into a SyncPanel backend row alongside
// "Upload now" / "Download now". Task 12 will plumb the real experimental
// flag — for now the parent passes `enabled`, and when it's false the button
// renders nothing so the flag can gate it without touching layout.

type BackendType = 'drive' | 'github' | 'icloud';

type Props = {
  backendId: string;
  backendLabel: string;
  backendType: BackendType;
  enabled: boolean;
};

export function RestoreFromBackupButton({
  backendId,
  backendLabel,
  backendType,
  enabled,
}: Props) {
  const [open, setOpen] = useState(false);

  // Feature flag gate — skip rendering entirely when disabled.
  if (!enabled) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        // Matches MenuButton styling used by Upload/Download now so this
        // drops naturally into the same overflow menu row.
        className="w-full text-left px-3 py-1.5 text-[11px] text-fg hover:bg-inset transition-colors"
      >
        Restore from backup…
      </button>
      {open &&
        createPortal(
          <RestoreWizard
            backendId={backendId}
            backendLabel={backendLabel}
            backendType={backendType}
            onClose={() => setOpen(false)}
          />,
          document.body,
        )}
    </>
  );
}
