// "A file has unsaved changes" — a quit, or the last window's close, refused because this window
// holds unsaved edits: a text file open for editing, a draft parked after its editor went away
// (Task 6 fix rounds 9–14; state/unsaved-editors.ts, draft-store.ts), or an Office document whose
// autosave has not landed yet (Task 8 — it saves as the prompt opens, office-store.ts).
//
// WHY it names the files and offers actions (fix round 11): a parked draft has no editor on
// screen, so "save it" alone left the person with nothing to save — and closing the window then
// lost it. Each parked draft gets Save (fix round 13) right here; a file that could no longer take
// it says so. "Discard and quit/close" (confirmed in place) throws the listed edits away and goes
// on. Once nothing is left unsaved the prompt says "All saved." and offers to go on (fix round 14)
// — never automatically.
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Button, Callout, CARD_LEVEL_1, CARD_LEVEL_2, Dialog, SettingRow } from './ui';
import { useScreenOpen } from '../shoot-mode';
import { clearQuitRefused, confirmDiscardForQuit, previewQuitRefused, useOfficeAlerts } from './office/office-store';
import { DRAFT_READ_FAILED } from './artifact-views/edit-permission';
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
    // WHY a general message (final review, finding 5): a rejected check carries a raw error that
    // can name folders and guesses nothing useful; it is logged, and the row offers Retry.
    void Promise.all(edits.filter((e) => e.parked).map(async (e) => [e, await e.parked!.available()
      .catch((err: unknown) => { console.error('[UnsavedBeforeQuit] checking a parked draft failed', err); return { error: DRAFT_READ_FAILED }; })] as const))
      .then((pairs) => { if (live) setStatus(new Map(pairs)); });
    return () => { live = false; };
  }, [r, edits, recheck]);
  useRowVersion(); // re-render when a row's state changes (Discard-all waits for saves)
  const anySaving = edits.some((e) => rowStates.get(e)?.kind === 'saving');

  const n = edits.length;
  const files = n === 1 ? '1 file' : `${n} files`;
  const goOn = r?.mode === 'close' ? 'close' : 'quit';
  // Main held the quit (or close) for this prompt: go on now (main/unsaved-quit.ts).
  const proceed = () => { clearQuitRefused(); window.claude?.office?.proceedClose?.(); };
  const discard = () => { void discardUnsaved(listed).then(proceed); };
  // Dismissed (Cancel, OK, Esc, ✕): main forgets the held quit/close (fix round 12).
  const dismiss = () => { clearQuitRefused(); window.claude?.office?.dismissPrompt?.(); };
  const allSaved = r !== null && n === 0;
  // WHY the count moved here from the title (Destin, close-session-5#CS5-2: "the header is too
  // long"; guide: a one-line title naming the popup, detail in the body — Session details, Close
  // session): the title is "Unsaved changes", and this line says how many and what to do.
  const count = n > 1 ? `${n} files have unsaved changes.` : 'A file has unsaved changes.';
  const intro = r?.afterTeardown
    ? `${count} Your chats have stopped. Save ${n > 1 ? 'the files' : 'the file'}, then quit again.`
    : `${count} Save ${n > 1 ? 'them' : 'it'}, then ${goOn === 'close' ? 'close the window' : 'quit'} again.`;
  // Still true once everything is saved: a restart already became a quit.
  const restartNote = r?.restartDropped ? ' YouCoded will quit instead of restarting.' : '';
  return (
    <Dialog
      open={r !== null}
      onClose={dismiss}
      title="Unsaved changes"
      // `panel` (420, still narrow): Close session's and Close window's width, so a file row
      // keeps its name and two buttons on one line.
      size="panel"
      layer={3}
      // Each state its own photo mark (shoot).
      screen={allSaved ? 'app/unsaved-before-quit/all-saved' : r?.confirming ? 'app/unsaved-before-quit/discard' : r?.afterTeardown ? 'app/unsaved-before-quit/after-restart' : 'app/unsaved-before-quit'}
      // WHY the shared body + footer (close-session-friction proposal 1): fix round 15 gave it its
      // own layout so the choices stay pinned under a list that scrolls in whatever height is
      // left. The footer slot does exactly that: the body (intro + list) scrolls under the shared
      // see-through fade — the list's old painted fade is gone — and the buttons never move.
      // WHY stacked, full width, main action on top (close-session-4#CS4-2, "a more comprehensive
      // restyling"; guide: two buttons in a narrow popup stack full width, filled on top; a
      // destructive confirm's red button takes the main action's place): this is a 340-point
      // popup, and its pairs sat side by side at the right.
      footer={allSaved ? (
        <div className="flex flex-col gap-2">
          <Button variant="primary" className="w-full" onClick={proceed}>{goOn === 'close' ? 'Close' : 'Quit'}</Button>
          <Button variant="secondary" className="w-full" onClick={dismiss}>Cancel</Button>
        </div>
      ) : r?.confirming ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-fg-2 pb-1">Discard unsaved changes to {files}?</p>
          <Button variant="danger" className="w-full" onClick={discard} disabled={anySaving}>Discard and {goOn}</Button>
          <Button variant="secondary" className="w-full" onClick={() => confirmDiscardForQuit(false)}>Cancel</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {/* WHY "Keep editing" (Destin, close-session-6#CS6-4): "OK" could read as "OK, quit"; the
              label says what happens — back to YouCoded, nothing quits. */}
          <Button variant="primary" className="w-full" onClick={dismiss}>Keep editing</Button>
          <Button variant="secondary" className="w-full" disabled={anySaving} onClick={() => { setListed(edits); confirmDiscardForQuit(true); }}>Discard and {goOn}</Button>
        </div>
      )}
    >
      {/* WHY one card holding a box per file (Destin, close-session-4#CS4-2 "some kind of
          cards/container"; picked close-session-5#CS5-2 "boxes", and "follow the conventions we've
          already established"): the Games friends list's shape — one first-level card, one nested
          box per item, 8 apart. The text that describes the list lives inside the card. A
          single-card popup, so no label above it. The body scrolls under the shared popup fade
          into the shared footer; nothing here draws its own. */}
      <div className={`${CARD_LEVEL_1} p-3 flex flex-col gap-3`}>
        <p className="text-sm text-fg-2">{allSaved ? `Everything is saved.${restartNote}` : `${intro}${restartNote}`}</p>
        {!allSaved && (
          <ul className="flex flex-col gap-2">
            {edits.map((e, i) => <UnsavedRow key={`${e.name}-${i}`} edit={e} status={status.get(e)} onRetry={() => setRecheck((x) => x + 1)} />)}
          </ul>
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

// One file: the shared setting row in its own nested box — the name as its title, one grey
// line under it, its button at the right — and, when something is wrong or needs a yes, the slim
// notice box inside the same box with its buttons inside it at the right.
// WHY these pieces and no others (Destin, close-session-5#CS5-2: "you're doing a bunch of unique
// styling here again … the buttons for each file are weird"):
// - the row: guide Settings, "rows use the shared setting row" (Session details' "In your lists");
// - one button sits at the right of its line; a row's main action is filled with anything beside
//   it outlined (guide Buttons; Games' Accept beside Decline, games-social-1#GS-3);
// - a problem on an item is the notice box inside the item's box, its buttons inside it
//   (decisions "Problem on a list item"; Model providers' broken key, Specialists' ask);
// - a destructive confirm's red button takes the main action's place (guide Buttons).
function UnsavedRow({ edit: e, status, onRetry }: { edit: UnsavedEdit; status: DraftFileStatus | undefined; onRetry: () => void }) {
  useRowVersion();
  const st = rowStates.get(e) ?? null;
  // A per-row Discard asks first, in place (fix round 14), then comes back to where it was.
  const askDiscard = () => setRow(e, { kind: 'confirm-discard', back: st });
  const btn = (label: string, onClick: () => void, variant: 'primary' | 'secondary' | 'danger' = 'secondary', disabled = false) => (
    <Button variant={variant} size="sm" onClick={onClick} disabled={disabled}>{label}</Button>
  );
  let hint: React.ReactNode = null;
  let control: React.ReactNode = null;
  let notice: { tone: 'warning' | 'danger'; text: React.ReactNode; actions: React.ReactNode } | null = null;
  if (!e.parked) {
    hint = 'Open in this window — save it there';
  } else if (st?.kind === 'confirm-discard') {
    notice = { tone: 'warning', text: 'Discard your changes to this file?', actions: <>{btn('Cancel', () => setRow(e, st.back))}{btn('Discard', () => { setRow(e, null); e.discard(); }, 'danger')}</> };
  } else if (status === 'protected' || st?.kind === 'protected') {
    // A protected location (fix round 15): nothing here can save it — Discard only.
    hint = 'Can’t be saved here';
    control = btn('Discard', askDiscard);
  } else if (status === 'gone') {
    hint = 'The file is no longer there';
    control = btn('Discard', askDiscard);
  } else if (status && typeof status === 'object') {
    // The check itself failed: say why, and let it be tried again.
    notice = { tone: 'danger', text: status.error, actions: <>{btn('Discard', askDiscard)}{btn('Try again', onRetry, 'primary')}</> };
  } else if (st?.kind === 'conflict') {
    notice = { tone: 'warning', text: st.unknown ? 'YouCoded can’t tell whether this file changed on disk.' : 'Changed on disk since you opened it.',
      actions: <>{btn('Discard', askDiscard)}{btn('Save anyway', () => setRow(e, { kind: 'confirm-overwrite', unknown: st.unknown, confirmed: st.confirmed }), 'primary')}</> };
  } else if (st?.kind === 'confirm-overwrite') {
    notice = { tone: 'warning', text: 'Replace the file on disk with your version?', actions: <>{btn('Cancel', () => setRow(e, { kind: 'conflict', unknown: st.unknown, confirmed: st.confirmed }))}{btn('Replace', () => void saveRow(e, { force: true, ...(st.confirmed ? { confirmed: true } : {}) }), 'danger')}</> };
  } else if (st?.kind === 'confirm-settings') {
    notice = { tone: 'warning', text: 'This is a settings file. Save anyway?', actions: <>{btn('Cancel', () => setRow(e, null))}{btn('Save anyway', () => void saveRow(e, { confirmed: true }), 'danger')}</> };
  } else if (st?.kind === 'error') {
    notice = { tone: 'danger', text: st.message, actions: <>{btn('Discard', askDiscard)}{btn('Try again', () => void saveRow(e), 'primary')}</> };
  } else if (status === 'editable') {
    hint = 'Not saved yet';
    control = btn(st?.kind === 'saving' ? 'Saving…' : 'Save', () => void saveRow(e), 'primary', st?.kind === 'saving');
  }
  return (
    <li className={`${CARD_LEVEL_2} px-3 py-1`}>
      <SettingRow header variant="item" title={e.name} description={hint ?? undefined} control={control ?? undefined} />
      {notice && (
        <Callout compact tone={notice.tone} className="mb-2" actions={notice.actions}>{notice.text}</Callout>
      )}
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
