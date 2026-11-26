// Alerts shown outside the Office page (Task 6 fix round 2) — the page may be closed and kept
// invisible, and these must still be seen:
//   · a quit (or the last window's close) refused for unsaved files: their list (UnsavedBeforeQuit),
//     Office documents included (Task 8);
//   · a tab closed while the page was hidden could not save, so it came back: a toast says so.
// (Task 8 removed the "N Office documents couldn't be saved" close/quit prompt: a document's edits
// reach its recovery journal as they are made, so a closing window never has to wait on its saves.)
import React, { useEffect } from 'react';
import { announce } from '../../utils/announce';
import { clearCloseFailed, useOfficeAlerts, watchUnsavedPrompt } from './office-store';
import { UnsavedBeforeQuit } from '../UnsavedBeforeQuit';

export function OfficeAlerts({ onReview }: { onReview: (path: string) => void }) {
  const { closeFailed } = useOfficeAlerts();
  // Main's refused-quit prompt reaches every window, whether or not it ever opened Office (fix round 9).
  useEffect(() => { watchUnsavedPrompt(); }, []);
  // WHY through announce, untilClosed (Destin, waiting-notice deck K-7): a document that could not be saved needs you, so the
  // notice stays until you close it or press Open Office, and it waits its turn behind any other notice instead of replacing it.
  // The alert is handed over at once and cleared, so the store never holds a notice the floating list already owns.
  useEffect(() => {
    if (!closeFailed) return;
    const path = closeFailed;
    clearCloseFailed();
    announce("An Office document couldn't be saved.", { action: { label: 'Open Office', onClick: () => onReview(path) }, untilClosed: true, tone: 'error' });
  }, [closeFailed, onReview]);
  return (
    <>
      <UnsavedBeforeQuit />
    </>
  );
}
