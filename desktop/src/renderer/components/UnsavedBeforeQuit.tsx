// "A file has unsaved changes" — a quit, or the last window's close, refused because this window
// holds unsaved non-Office edits: a text file open for editing, or a draft parked after its
// editor went away (Task 6 fix rounds 9–11; state/unsaved-editors.ts, draft-store.ts).
//
// WHY it names the files and offers actions (fix round 11): a parked draft has no editor on
// screen, so "save it" alone left the person with nothing to save — and closing the window then
// lost it. Each parked draft gets "Open it" (its file opens in this window's viewer, where the
// draft comes back); a file that can no longer be opened says so. "Discard and quit/close"
// (confirmed in place) throws every listed edit away and goes on.
import React, { useEffect, useState } from 'react';
import { Button, Dialog } from './ui';
import { useScreenOpen } from '../shoot-mode';
import { clearQuitRefused, confirmDiscardForQuit, previewQuitRefused, useOfficeAlerts } from './office/office-store';
import { discardAllUnsaved, holdUnsavedEditor, useUnsavedEdits, type UnsavedEdit } from '../state/unsaved-editors';

export function UnsavedBeforeQuit() {
  const { quitRefused: r } = useOfficeAlerts();
  const edits = useUnsavedEdits();
  useScreenOpen('app/unsaved-before-quit', () => { previewFiles(); previewQuitRefused(); });
  useScreenOpen('app/unsaved-before-quit/after-restart', () => previewQuitRefused({ afterTeardown: true, restartDropped: true }));
  useScreenOpen('app/unsaved-before-quit/discard', () => previewQuitRefused({ confirming: true }));
  // Whether each parked draft's file can still be opened (asked when the prompt shows).
  const [available, setAvailable] = useState<ReadonlyMap<UnsavedEdit, boolean>>(new Map());
  useEffect(() => {
    if (!r) return;
    let live = true;
    void Promise.all(edits.filter((e) => e.parked).map(async (e) => [e, await e.parked!.available().catch(() => false)] as const))
      .then((pairs) => { if (live) setAvailable(new Map(pairs)); });
    return () => { live = false; };
  }, [r, edits]);

  const n = edits.length;
  const files = n === 1 ? '1 file' : `${n} files`;
  const goOn = r?.mode === 'close' ? 'close' : 'quit';
  const discard = () => {
    discardAllUnsaved();
    clearQuitRefused();
    // Main held the quit (or close) for this: it goes ahead now (office-flush 'refused').
    window.claude?.office?.proceedClose?.();
  };
  return (
    <Dialog
      open={r !== null}
      onClose={clearQuitRefused}
      title={n > 1 ? `${n} files have unsaved changes.` : 'A file has unsaved changes.'}
      size="prompt"
      layer={3}
      // Each state its own photo mark (shoot): the discard step, after a restart, or plain.
      screen={r?.confirming ? 'app/unsaved-before-quit/discard' : r?.afterTeardown ? 'app/unsaved-before-quit/after-restart' : 'app/unsaved-before-quit'}
    >
      <p className="text-sm text-fg-2 pb-3">
        {r?.afterTeardown
          ? `Your chats have stopped. Save ${n > 1 ? 'the files' : 'the file'}, then quit again.${r.restartDropped ? ' YouCoded will quit instead of restarting.' : ''}`
          : `Save ${n > 1 ? 'them' : 'it'}, then ${goOn === 'close' ? 'close the window' : 'quit'} again.`}
      </p>
      <ul className="flex flex-col gap-1 pb-4">
        {edits.map((e, i) => (
          <li key={`${e.name}-${i}`} className="flex items-center gap-2 text-sm text-fg">
            <span className="flex-1 min-w-0 truncate">{e.name}</span>
            {e.parked && available.get(e) === true && (
              <Button variant="secondary" size="sm" onClick={() => { clearQuitRefused(); e.parked!.open(); }}>Open it</Button>
            )}
            {e.parked && available.get(e) === false && <span className="text-2xs text-fg-muted">(file no longer available)</span>}
          </li>
        ))}
      </ul>
      {r?.confirming ? (
        <div className="flex items-center gap-2 justify-end">
          <span className="flex-1 text-sm text-fg-2">Discard unsaved changes to {files}?</span>
          <Button variant="secondary" onClick={() => confirmDiscardForQuit(false)}>Cancel</Button>
          <Button variant="danger" onClick={discard}>Discard</Button>
        </div>
      ) : (
        <div className="flex gap-2 justify-end">
          <Button variant="secondary" onClick={() => confirmDiscardForQuit(true)}>Discard and {goOn}</Button>
          <Button variant="primary" onClick={clearQuitRefused}>OK</Button>
        </div>
      )}
    </Dialog>
  );
}

/** Photo-only: an open editor, a parked draft that can be opened, and one whose file is gone. */
let previewed = false;
function previewFiles(): void {
  if (previewed) return;
  previewed = true;
  holdUnsavedEditor({ name: 'notes.md', discard: () => {} });
  holdUnsavedEditor({ name: 'plan.txt', parked: { open: () => {}, available: async () => true }, discard: () => {} });
  holdUnsavedEditor({ name: 'old-draft.txt', parked: { open: () => {}, available: async () => false }, discard: () => {} });
}
