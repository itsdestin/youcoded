// The warning shown when a window that still has sessions is closed.
//
// WHY in the app, not an OS pop-up: Destin, review deck 2026-09-24 (S-dialog) —
// "we should also make this warning an app native warning instead of an os
// popup." It replaces main.ts's dialog.showMessageBox, and gains the Welcome
// back choice: whether these sessions come back next launch (Q-quit: ask at
// quit; Q-default: starts OFF, so a deliberate quit is a clean slate unless you
// ask). Copy and layout are Destin's, word for word (round 2, B-quit): no
// subtitle, a bold line under the header divider, and the switch on the same
// row as Close window — `panel` width so that row fits.
import { useState } from 'react';
import { Button, Dialog, Toggle } from './ui';

export default function QuitSessionsPrompt({ count, onCancel, onConfirm }: {
  count: number;
  onCancel: () => void;
  /** `reopen`: offer these sessions on the Welcome back screen next launch. */
  onConfirm: (reopen: boolean) => void;
}) {
  const [reopen, setReopen] = useState(false);
  return (
    <Dialog open onClose={onCancel} size="panel" title="Close window" scrollBody={false}>
      <div className="px-4 pt-4 pb-3 flex flex-col gap-1.5">
        <p className="text-xs font-bold text-fg">
          You have {count} active session{count === 1 ? '' : 's'} - proceed?
        </p>
        <p className="text-2xs text-fg-muted leading-snug">
          Closing this window will end your active sessions. Would you like an offer to resume these sessions the next time you launch YouCoded?
        </p>
      </div>
      <div className="px-4 pb-4 flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-xs text-fg cursor-pointer select-none whitespace-nowrap">
          <Toggle checked={reopen} onChange={setReopen} aria-label="Resume on Next Launch?" />
          Resume on Next Launch?
        </label>
        <Button size="sm" variant="danger" className="whitespace-nowrap" onClick={() => onConfirm(reopen)}>
          Close window
        </Button>
      </div>
    </Dialog>
  );
}
