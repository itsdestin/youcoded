// "A file has unsaved changes" — a quit, or the last window's close, refused because this window
// holds unsaved non-Office edits: a text file open for editing, or a draft parked after its
// editor went away (Task 6 fix rounds 9–14; state/unsaved-editors.ts, draft-store.ts).
//
// WHY it names the files and offers actions (fix round 11): a parked draft has no editor on
// screen, so "save it" alone left the person with nothing to save — and closing the window then
// lost it. Each parked draft gets Save (fix round 13) right here; a file that could no longer take
// it says so. "Discard and quit/close" (confirmed in place) throws the listed edits away and goes
// on. Once nothing is left unsaved the prompt says "All saved." and offers to go on (fix round 14)
// — never automatically.
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Button, Dialog } from './ui';
import { useScreenOpen } from '../shoot-mode';
import { useScrollFade } from '../hooks/useScrollFade';
import { clearQuitRefused, confirmDiscardForQuit, previewQuitRefused, useOfficeAlerts } from './office/office-store';
import {
  discardUnsaved, holdUnsavedEditor, unsavedEditsNow as previewEdits, useUnsavedEdits,
  type DraftFileStatus, type UnsavedEdit,
} from '../state/unsaved-editors';

export function UnsavedBeforeQuit() {
  const { quitRefused: r } = useOfficeAlerts();
  const edits = useUnsavedEdits();
  useScreenOpen('app/unsaved-before-quit', () => { previewFiles(); previewQuitRefused(); });
  // Each state places its files itself, so a capture opened straight onto it is never empty.
  useScreenOpen('app/unsaved-before-quit/after-restart', () => { previewFiles(); previewQuitRefused({ afterTeardown: true, restartDropped: true }); });
  useScreenOpen('app/unsaved-before-quit/discard', () => { previewFiles(); previewQuitRefused({ confirming: true }); });
  useScreenOpen('app/unsaved-before-quit/all-saved', () => { clearPreviewFiles(); previewQuitRefused(); });
  // What the person saw listed when they chose to discard: only those go (fix round 12).
  const [listed, setListed] = useState<readonly UnsavedEdit[]>([]);
  // Whether each parked draft's file could still take it (asked when the prompt shows).
  const [status, setStatus] = useState<ReadonlyMap<UnsavedEdit, DraftFileStatus>>(new Map());
  const [recheck, setRecheck] = useState(0);
  useEffect(() => {
    if (!r) return;
    let live = true;
    void Promise.all(edits.filter((e) => e.parked).map(async (e) => [e, await e.parked!.available()
      .catch((err: unknown) => ({ error: `YouCoded couldn't read this file: ${String(err)}` }))] as const))
      .then((pairs) => { if (live) setStatus(new Map(pairs)); });
    return () => { live = false; };
  }, [r, edits, recheck]);
  useRowVersion(); // re-render when a row's state changes (Discard-all waits for saves)
  const anySaving = edits.some((e) => rowStates.get(e)?.kind === 'saving');

  const n = edits.length;
  const files = n === 1 ? '1 file' : `${n} files`;
  const goOn = r?.mode === 'close' ? 'close' : 'quit';
  // Main held the quit (or close) for this prompt: go on now (office-flush 'refused').
  const proceed = () => { clearQuitRefused(); window.claude?.office?.proceedClose?.(); };
  const discard = () => { discardUnsaved(listed); proceed(); };
  // Dismissed (Cancel, OK, Esc, ✕): main forgets the held quit/close (fix round 12).
  const dismiss = () => { clearQuitRefused(); window.claude?.office?.dismissPrompt?.(); };
  const allSaved = r !== null && n === 0;
  const listRef = useScrollFade<HTMLDivElement>();
  const intro = r?.afterTeardown
    ? `Your chats have stopped. Save ${n > 1 ? 'the files' : 'the file'}, then quit again.`
    : `Save ${n > 1 ? 'them' : 'it'}, then ${goOn === 'close' ? 'close the window' : 'quit'} again.`;
  // Still true once everything is saved: a restart already became a quit.
  const restartNote = r?.restartDropped ? ' YouCoded will quit instead of restarting.' : '';
  return (
    <Dialog
      open={r !== null}
      onClose={dismiss}
      title={allSaved ? 'Nothing left unsaved here.' : n > 1 ? `${n} files have unsaved changes.` : 'A file has unsaved changes.'}
      size="prompt"
      layer={3}
      // Each state its own photo mark (shoot).
      screen={allSaved ? 'app/unsaved-before-quit/all-saved' : r?.confirming ? 'app/unsaved-before-quit/discard' : r?.afterTeardown ? 'app/unsaved-before-quit/after-restart' : 'app/unsaved-before-quit'}
      // WHY its own layout (fix round 15): the list scrolls in whatever height is left (with the
      // app's scroll fade as the "more below" cue) while the choices stay pinned under it, so the
      // buttons are visible at any window height.
      scrollBody={false}
    >
      <div className="flex flex-col flex-1 min-h-0 px-4 py-4 gap-3">
        {allSaved ? (
          <>
            {restartNote && <p className="text-sm text-fg-2">{restartNote.trim()}</p>}
            <div className="flex gap-2 justify-end">
              <Button variant="secondary" onClick={dismiss}>Cancel</Button>
              <Button variant="primary" onClick={proceed}>{goOn === 'close' ? 'Close' : 'Quit'}</Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-fg-2">{intro}{restartNote}</p>
            <div ref={listRef} className="scroll-fade flex-1">
              <ul className="flex flex-col gap-2 py-1">
                {edits.map((e, i) => <UnsavedRow key={`${e.name}-${i}`} edit={e} status={status.get(e)} onRetry={() => setRecheck((x) => x + 1)} />)}
              </ul>
            </div>
            {r?.confirming ? (
              <div className="flex flex-col gap-3 shrink-0">
                <p className="text-sm text-fg-2">Discard unsaved changes to {files}?</p>
                <div className="flex gap-2 justify-end">
                  <Button variant="secondary" onClick={() => confirmDiscardForQuit(false)}>Cancel</Button>
                  <Button variant="danger" onClick={discard} disabled={anySaving}>Discard and {goOn}</Button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2 justify-end shrink-0">
                <Button variant="secondary" disabled={anySaving} onClick={() => { setListed(edits); confirmDiscardForQuit(true); }}>Discard and {goOn}</Button>
                <Button variant="primary" onClick={dismiss}>OK</Button>
              </div>
            )}
          </>
        )}
      </div>
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
  // `confirmed`: the settings-file question was already answered yes (fix round 15) — carried
  // through, so Replace does not loop back to it.
  | { kind: 'conflict'; unknown?: boolean; confirmed?: boolean }
  | { kind: 'confirm-overwrite'; unknown?: boolean; confirmed?: boolean }
  | { kind: 'confirm-settings' }
  | { kind: 'confirm-discard'; back: RowState | null }
  | { kind: 'error'; message: string }
  | { kind: 'protected' };
// WeakMap (fix round 14): a row's state goes with its edit, never lingering after it.
const rowStates = new WeakMap<UnsavedEdit, RowState>();
let rowVersion = 0;
const rowListeners = new Set<() => void>();
function setRow(e: UnsavedEdit, st: RowState | null): void {
  if (st) rowStates.set(e, st); else rowStates.delete(e);
  rowVersion += 1;
  rowListeners.forEach((l) => l());
}
function useRowVersion(): number {
  return useSyncExternalStore((l) => { rowListeners.add(l); return () => { rowListeners.delete(l); }; }, () => rowVersion, () => rowVersion);
}

async function saveRow(e: UnsavedEdit, o: { force?: boolean; confirmed?: boolean } = {}): Promise<void> {
  setRow(e, { kind: 'saving' });
  const r = await e.parked!.save(o).catch((err: unknown) => ({ error: `Save failed: ${String(err)}` }));
  if ('ok' in r) { setRow(e, null); return; } // saved: the draft (and its row) is gone
  if ('needsConfirm' in r) { setRow(e, { kind: 'confirm-settings' }); return; }
  if ('protected' in r) { setRow(e, { kind: 'protected' }); return; }
  if ('conflict' in r) { setRow(e, { kind: 'conflict', unknown: r.unknown, confirmed: o.confirmed }); return; }
  setRow(e, { kind: 'error', message: r.error });
}

function UnsavedRow({ edit: e, status, onRetry }: { edit: UnsavedEdit; status: DraftFileStatus | undefined; onRetry: () => void }) {
  useRowVersion();
  const st = rowStates.get(e) ?? null;
  // A per-row Discard asks first, in place (fix round 14), then comes back to where it was.
  const askDiscard = () => setRow(e, { kind: 'confirm-discard', back: st });
  const small = (label: string, onClick: () => void, variant: 'secondary' | 'danger' = 'secondary', disabled = false) => (
    <Button variant={variant} size="sm" onClick={onClick} disabled={disabled}>{label}</Button>
  );
  const text = (t: string, muted = false) => <span className={`text-2xs ${muted ? 'text-fg-muted' : 'text-fg-2'}`}>{t}</span>;
  let note: React.ReactNode = null;
  let actions: React.ReactNode = null;
  if (!e.parked) {
    note = text('(open in this window)', true);
  } else if (st?.kind === 'confirm-discard') {
    note = text('Discard your changes to this file?');
    actions = <>{small('Cancel', () => setRow(e, st.back))}{small('Discard', () => { setRow(e, null); e.discard(); }, 'danger')}</>;
  } else if (status === 'protected' || st?.kind === 'protected') {
    // A protected location (fix round 15): nothing here can save it — Discard only.
    note = text('(file can’t be saved here)', true);
    actions = small('Discard', askDiscard);
  } else if (status === 'gone') {
    note = text('(file no longer available)', true);
    actions = small('Discard', askDiscard);
  } else if (status && typeof status === 'object') {
    note = text(status.error); // the check itself failed: say why, and let it be tried again
    actions = <>{small('Retry', onRetry)}{small('Discard', askDiscard)}</>;
  } else if (st?.kind === 'conflict') {
    note = text(st.unknown ? 'YouCoded can’t tell whether this file changed on disk — save anyway or discard.' : 'Changed on disk since — save anyway or discard.');
    actions = <>{small('Save anyway', () => setRow(e, { kind: 'confirm-overwrite', unknown: st.unknown, confirmed: st.confirmed }))}{small('Discard', askDiscard)}</>;
  } else if (st?.kind === 'confirm-overwrite') {
    note = text('Replace the file on disk with your version?');
    actions = <>{small('Cancel', () => setRow(e, { kind: 'conflict', unknown: st.unknown, confirmed: st.confirmed }))}{small('Replace', () => void saveRow(e, { force: true, ...(st.confirmed ? { confirmed: true } : {}) }), 'danger')}</>;
  } else if (st?.kind === 'confirm-settings') {
    note = text('This is a settings file. Save anyway?');
    actions = <>{small('Cancel', () => setRow(e, null))}{small('Save anyway', () => void saveRow(e, { confirmed: true }), 'danger')}</>;
  } else if (st?.kind === 'error') {
    note = text(st.message);
    actions = <>{small('Save', () => void saveRow(e))}{small('Discard', askDiscard)}</>;
  } else if (status === 'editable') {
    actions = small(st?.kind === 'saving' ? 'Saving…' : 'Save', () => void saveRow(e), 'secondary', st?.kind === 'saving');
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
 *  failed), one whose file is gone, and one whose check could not read it. */
let previewReleases: Array<() => void> = [];
function previewFiles(): void {
  if (previewReleases.length > 0) return;
  const noSave = async () => ({ error: 'preview' });
  const parked = (s: DraftFileStatus) => ({ available: async () => s, save: noSave });
  previewReleases = [
    holdUnsavedEditor({ name: 'notes.md', discard: () => {} }),
    holdUnsavedEditor({ name: 'plan.txt', parked: parked('editable'), discard: () => {} }),
    holdUnsavedEditor({ name: 'budget.csv', parked: parked('editable'), discard: () => {} }),
    holdUnsavedEditor({ name: 'config.yaml', parked: parked('editable'), discard: () => {} }),
    holdUnsavedEditor({ name: 'old-draft.txt', parked: parked('gone'), discard: () => {} }),
    holdUnsavedEditor({ name: 'shared.md', parked: parked({ error: 'YouCoded couldn’t read this file: permission denied.' }), discard: () => {} }),
  ];
  // The row states are keyed by the listed edits (their wrapped copies), so set them from the list.
  queueMicrotask(() => {
    const list = previewEdits();
    const find = (name: string) => list.find((x) => x.name === name);
    const conflict = find('budget.csv');
    const failed = find('config.yaml');
    if (conflict) setRow(conflict, { kind: 'conflict' });
    if (failed) setRow(failed, { kind: 'error', message: "Save failed: this folder can't be written to." });
  });
}
/** Photo-only: everything saved (the list emptied while the prompt was open). */
function clearPreviewFiles(): void {
  previewReleases.forEach((release) => release());
  previewReleases = [];
}
