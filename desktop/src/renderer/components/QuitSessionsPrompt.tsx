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
import { Button, CARD_LEVEL_1, Dialog, Toggle } from './ui';

export default function QuitSessionsPrompt({ count, onCancel, onConfirm, reason }: {
  count: number;
  /** 'update': raised by Restart to update (#183 Q-busy), so it says restart, not close. */
  reason?: 'update';
  onCancel: () => void;
  /** `reopen`: offer these sessions on the Welcome back screen next launch. */
  onConfirm: (reopen: boolean) => void;
}) {
  const [reopen, setReopen] = useState(false);
  return (
    // layer={3}: L3 Critical (Overlay.tsx) — the same stacking layer as the
    // app's other destructive confirmations (ModelSwitchPrompt); this is a
    // z-index-only change, not the dictated copy/layout above.
    // WHY the shared body + footer (close-session-friction proposal 1): it opted out of the
    // shared body only to place its own button row; the footer slot does that, and keeps the
    // row in view on a short window. No Enter-to-confirm: Close window ends sessions, so it
    // takes a click.
    // WHY the restart wording (#183, guide "a button names what it does"): Destin asked for this
    // same prompt on Restart to update; "Close window" there would read as quitting for good.
    <Dialog open onClose={onCancel} size="panel" title={reason === 'update' ? 'Restart to update' : 'Close window'} layer={3} screen="chat/quit-sessions"
      footer={
        <div className="flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-xs text-fg cursor-pointer select-none whitespace-nowrap">
            <Toggle checked={reopen} onChange={setReopen} aria-label="Resume on Next Launch?" />
            Resume on Next Launch?
          </label>
          <Button size="sm" variant="danger" className="whitespace-nowrap" onClick={() => onConfirm(reopen)}>
            {reason === 'update' ? 'Restart' : 'Close window'}
          </Button>
        </div>
      }>
      {/* WHY a card (final-review#PR-7/#ST-21, the one popup rule): the explanation is more than
          a one-line question, so it sits in a card as About's text does. The switch stays on the
          footer line, balanced by the main button (guide "Don't ask again" shape). */}
      <div className={`${CARD_LEVEL_1} p-3 flex flex-col gap-1.5`}>
        <p className="text-xs font-bold text-fg">
          You have {count} active session{count === 1 ? '' : 's'} - proceed?
        </p>
        <p className="text-2xs text-fg-muted leading-snug">
          {reason === 'update' ? 'Restarting' : 'Closing this window'} will end your active sessions. Would you like an offer to resume these sessions the next time you launch YouCoded?
        </p>
      </div>
    </Dialog>
  );
}
