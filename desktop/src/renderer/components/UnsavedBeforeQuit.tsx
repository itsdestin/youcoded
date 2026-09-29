// "A file has unsaved changes" — a quit, or the last window's close, refused because this window
// holds unsaved non-Office edits: a text file open for editing, or a draft parked after its
// editor went away (Task 6 fix rounds 9–11; state/unsaved-editors.ts, draft-store.ts).
//
// WHY it names the files and offers actions (fix round 11): a parked draft has no editor on
// screen, so "save it" alone left the person with nothing to save — and closing the window then
// lost it. Each parked draft gets Save (fix round 13) right here; a file that could no longer take
// it says so. "Discard and quit/close" (confirmed in place) throws the listed edits away and goes on.
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Button, Dialog } from './ui';
import { useScreenOpen } from '../shoot-mode';
import { clearQuitRefused, confirmDiscardForQuit, previewQuitRefused, useOfficeAlerts } from './office/office-store';
import { discardUnsaved, holdUnsavedEditor, unsavedEditsNow as previewEdits, useUnsavedEdits, type UnsavedEdit } from '../state/unsaved-editors';

export function UnsavedBeforeQuit() {
  const { quitRefused: r } = useOfficeAlerts();
  const edits = useUnsavedEdits();
  useScreenOpen('app/unsaved-before-quit', () => { previewFiles(); previewQuitRefused(); });
  // Each state places its files itself, so a capture opened straight onto it is never empty.
  useScreenOpen('app/unsaved-before-quit/after-restart', () => { previewFiles(); previewQuitRefused({ afterTeardown: true, restartDropped: true }); });
  useScreenOpen('app/unsaved-before-quit/discard', () => { previewFiles(); previewQuitRefused({ confirming: true }); });
  // What the person saw listed when they chose to discard: only those go (fix round 12).
  const [listed, setListed] = useState<readonly UnsavedEdit[]>([]);
  // Whether each parked draft's file could still take it (asked when the prompt shows).
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
    discardUnsaved(listed.length > 0 ? listed : edits);
    clearQuitRefused();
    // Main held the quit (or close) for this: it goes ahead now (office-flush 'refused').
    window.claude?.office?.proceedClose?.();
  };
  // Dismissed (OK, Esc, ✕): main forgets the held quit/close (fix round 12).
  const dismiss = () => {
    clearQuitRefused();
    window.claude?.office?.dismissPrompt?.();
  };
  return (
    <Dialog
      open={r !== null}
      onClose={dismiss}
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
      <ul className="flex flex-col gap-2 pb-4">
        {edits.map((e, i) => <UnsavedRow key={`${e.name}-${i}`} edit={e} available={available.get(e)} />)}
      </ul>
      {r?.confirming ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-fg-2">Discard unsaved changes to {files}?</p>
          <div className="flex gap-2 justify-end">
          <Button variant="secondary" onClick={() => confirmDiscardForQuit(false)}>Cancel</Button>
          <Button variant="danger" onClick={discard}>Discard and {goOn}</Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2 justify-end">
          <Button variant="secondary" onClick={() => { setListed(edits); confirmDiscardForQuit(true); }}>Discard and {goOn}</Button>
          <Button variant="primary" onClick={dismiss}>OK</Button>
        </div>
      )}
    </Dialog>
  );
}

// ── One row: a file with unsaved edits, and what can be done about it here ──
// WHY Save rather than "Open it" (fix round 13, controller's decision): opening a parked draft
// meant routing to wherever its editor could come back (its session's drawer, or Project View on
// the right folder), which failed in practice. Saving it right here goes through the editor's own
// save path (saveParkedDraft → artifacts:save: same authorization, temp + rename, changed-on-disk
// check), and leaves nothing to route.
type RowState =
  | { kind: 'saving' }
  | { kind: 'conflict'; unknown?: boolean }
  | { kind: 'confirm-overwrite' }
  | { kind: 'error'; message: string };
const rowStates = new Map<UnsavedEdit, RowState>();
let rowSnapshot: ReadonlyMap<UnsavedEdit, RowState> = new Map();
const rowListeners = new Set<() => void>();
function setRow(e: UnsavedEdit, st: RowState | null): void {
  if (st) rowStates.set(e, st); else rowStates.delete(e);
  rowSnapshot = new Map(rowStates);
  rowListeners.forEach((l) => l());
}
function useRowStates(): ReadonlyMap<UnsavedEdit, RowState> {
  return useSyncExternalStore((l) => { rowListeners.add(l); return () => { rowListeners.delete(l); }; }, () => rowSnapshot, () => rowSnapshot);
}

async function saveRow(e: UnsavedEdit, force: boolean): Promise<void> {
  setRow(e, { kind: 'saving' });
  const r = await e.parked!.save(force).catch((err: unknown) => ({ error: `Save failed: ${String(err)}` }));
  if ('ok' in r) { setRow(e, null); return; } // saved: the draft (and its row) is gone
  if ('conflict' in r) { setRow(e, { kind: 'conflict', unknown: r.unknown }); return; }
  setRow(e, { kind: 'error', message: r.error });
}

function UnsavedRow({ edit: e, available }: { edit: UnsavedEdit; available: boolean | undefined }) {
  const st = useRowStates().get(e);
  const discard = () => { setRow(e, null); e.discard(); };
  const small = (label: string, onClick: () => void, variant: 'secondary' | 'danger' = 'secondary', disabled = false) => (
    <Button variant={variant} size="sm" onClick={onClick} disabled={disabled}>{label}</Button>
  );
  let note: React.ReactNode = null;
  let actions: React.ReactNode = null;
  if (!e.parked) {
    note = <span className="text-2xs text-fg-muted">(open in this window)</span>;
  } else if (available === false) {
    note = <span className="text-2xs text-fg-muted">(file no longer available)</span>;
    actions = small('Discard', discard);
  } else if (st?.kind === 'conflict') {
    note = <span className="text-2xs text-fg-2">{st.unknown ? 'YouCoded can’t tell whether this file changed on disk — save anyway or discard.' : 'Changed on disk since — save anyway or discard.'}</span>;
    actions = <>{small('Save anyway', () => setRow(e, { kind: 'confirm-overwrite' }))}{small('Discard', discard)}</>;
  } else if (st?.kind === 'confirm-overwrite') {
    note = <span className="text-2xs text-fg-2">Replace the file on disk with your version?</span>;
    actions = <>{small('Cancel', () => setRow(e, { kind: 'conflict' }))}{small('Replace', () => void saveRow(e, true), 'danger')}</>;
  } else if (st?.kind === 'error') {
    note = <span className="text-2xs text-fg-2">{st.message}</span>;
    actions = small('Save', () => void saveRow(e, false));
  } else if (available === true) {
    actions = small(st?.kind === 'saving' ? 'Saving…' : 'Save', () => void saveRow(e, false), 'secondary', st?.kind === 'saving');
  }
  return (
    <li className="flex flex-col gap-1 text-sm text-fg">
      <div className="flex items-center gap-2">
        <span className="flex-1 min-w-0 truncate">{e.name}</span>
        {!e.parked ? note : null}
        {actions}
      </div>
      {e.parked && note}
    </li>
  );
}

/** Photo-only: an open editor, parked drafts (one to save, one changed on disk, one whose save
 *  failed) and one whose file is gone. */
let previewed = false;
function previewFiles(): void {
  if (previewed) return;
  previewed = true;
  const noSave = async () => ({ error: 'preview' });
  holdUnsavedEditor({ name: 'notes.md', discard: () => {} });
  holdUnsavedEditor({ name: 'plan.txt', parked: { available: async () => true, save: noSave }, discard: () => {} });
  holdUnsavedEditor({ name: 'budget.csv', parked: { available: async () => true, save: noSave }, discard: () => {} });
  holdUnsavedEditor({ name: 'config.yaml', parked: { available: async () => true, save: noSave }, discard: () => {} });
  holdUnsavedEditor({ name: 'old-draft.txt', parked: { available: async () => false, save: noSave }, discard: () => {} });
  // The row states are keyed by the listed edits (their wrapped copies), so set them from the list.
  queueMicrotask(() => {
    const list = previewEdits();
    const find = (n: string) => list.find((x) => x.name === n);
    const conflict = find('budget.csv');
    const failed = find('config.yaml');
    if (conflict) setRow(conflict, { kind: 'conflict' });
    if (failed) setRow(failed, { kind: 'error', message: "Save failed: this folder can't be written to." });
  });
}
