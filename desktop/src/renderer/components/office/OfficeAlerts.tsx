// Office alerts shown outside the Office page (Task 6 fix round 2) — the page may be closed and
// kept invisible, and these must still be seen:
//   · a window close or quit found documents whose save failed: the close is held until the
//     person chooses Review (the Office page, on the first such tab, where Retry / Save a copy… /
//     Close without saving show) or Close anyway (main goes ahead: office:proceed);
//   · a tab closed while the page was hidden could not save, so it came back: a toast says so.
import React from 'react';
import { Button, Dialog, Toast } from '../ui';
import { useScreenOpen } from '../../shoot-mode';
import { clearCloseFailed, clearUnsavedPrompt, closeAnyway, previewUnsavedPrompt, useOfficeAlerts } from './office-store';

export function OfficeAlerts({ onReview }: { onReview: (path: string) => void }) {
  const { unsaved, closeFailed } = useOfficeAlerts();
  useScreenOpen('office/unsaved-on-close', () => previewUnsavedPrompt());
  const review = () => {
    if (!unsaved) return;
    clearUnsavedPrompt();
    onReview(unsaved.firstPath);
  };
  return (
    <>
      <Dialog
        open={unsaved !== null}
        // Escape / ✕: dismiss only — the window stays open (main held its close) and the failed
        // tabs keep their actions; nothing else opens. Review is the explicit way there.
        onClose={clearUnsavedPrompt}
        title={unsaved && unsaved.count === 1 ? "1 Office document couldn't be saved." : `${unsaved?.count ?? 0} Office documents couldn't be saved.`}
        size="prompt"
        layer={3}
        screen="office/unsaved-on-close"
      >
        <p className="text-sm text-fg-2 pb-4">Review shows each one with its choices, such as Retry. Closing anyway loses their changes since the last save.</p>
        <div className="flex gap-2 justify-end">
          <Button variant="danger" onClick={closeAnyway}>Close anyway</Button>
          <Button variant="primary" onClick={review}>Review</Button>
        </div>
      </Dialog>
      {closeFailed && (
        <Toast
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
