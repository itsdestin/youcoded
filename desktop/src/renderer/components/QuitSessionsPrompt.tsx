// The warning shown when a window that still has sessions is closed.
//
// WHY in the app, not an OS pop-up: Destin, review deck 2026-09-24 (S-dialog) —
// "we should also make this warning an app native warning instead of an os
// popup." It replaces main.ts's dialog.showMessageBox, and gains the Welcome
// back choice: whether these sessions come back next launch (Q-quit: ask at
// quit; Q-default: starts OFF, so a deliberate quit is a clean slate unless you
// ask). Built the way CloseSessionPrompt is: the shared Dialog, its ✕ as Cancel,
// one action on the right.
import { useState } from 'react';
import { Button, Dialog, Toggle } from './ui';

export default function QuitSessionsPrompt({ count, onCancel, onConfirm }: {
  count: number;
  onCancel: () => void;
  /** `reopen`: offer these sessions on the Welcome back screen next launch. */
  onConfirm: (reopen: boolean) => void;
}) {
  const [reopen, setReopen] = useState(false);
  const one = count === 1;
  return (
    <Dialog open onClose={onCancel} size="prompt" title="Close window" subtitle={`${count} session${one ? '' : 's'} open`} scrollBody={false}>
      <div className="px-4 py-4 flex flex-col gap-3">
        <p className="text-2xs text-fg-muted leading-snug">
          Closing the window ends {one ? 'it' : 'them'}. They stay in Resume Session.
        </p>
        <label className="flex items-center justify-between gap-3 text-xs text-fg cursor-pointer select-none">
          Reopen {one ? 'it' : 'them'} next time
          <Toggle checked={reopen} onChange={setReopen} aria-label={`Reopen ${one ? 'it' : 'them'} next time`} />
        </label>
      </div>
      <div className="px-4 pb-4 flex justify-end">
        <Button size="sm" variant="danger" className="whitespace-nowrap" onClick={() => onConfirm(reopen)}>
          Close window
        </Button>
      </div>
    </Dialog>
  );
}
