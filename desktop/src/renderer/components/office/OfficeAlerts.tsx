// Alerts shown outside the Office page (Task 6 fix round 2) — the page may be closed and kept
// invisible, and these must still be seen:
//   · a quit (or the last window's close) refused for unsaved files: their list (UnsavedBeforeQuit),
//     Office documents included (Task 8);
//   · a tab closed while the page was hidden could not save, so it came back: a toast says so.
// (Task 8 removed the "N Office documents couldn't be saved" close/quit prompt: a document's edits
// reach its recovery journal as they are made, so a closing window never has to wait on its saves.)
import React, { useEffect } from 'react';
import { Button, Toast } from '../ui';
import { clearCloseFailed, useOfficeAlerts, watchUnsavedPrompt } from './office-store';
import { UnsavedBeforeQuit } from '../UnsavedBeforeQuit';

export function OfficeAlerts({ onReview }: { onReview: (path: string) => void }) {
  const { closeFailed } = useOfficeAlerts();
  // Main's refused-quit prompt reaches every window, whether or not it ever opened Office (fix round 9).
  useEffect(() => { watchUnsavedPrompt(); }, []);
  return (
    <>
      <UnsavedBeforeQuit />
      {closeFailed && (
        <Toast
          // A new key per file restarts the toast's timer when another failed close follows.
          key={closeFailed}
          tone="error"
          message="An Office document couldn't be saved."
          durationMs={10_000}
          onDismiss={clearCloseFailed}
          action={<Button variant="secondary" size="sm" onClick={() => { const p = closeFailed; clearCloseFailed(); onReview(p); }}>Open Office</Button>}
        />
      )}
    </>
  );
}
