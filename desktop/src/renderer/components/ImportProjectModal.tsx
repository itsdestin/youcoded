// desktop/src/renderer/components/ImportProjectModal.tsx
// Consent + name-confirm modal shared by BOTH spec-§3 import flows (row action
// and folder-picker). The move is consequence-gated: the copy spells out that
// the folder itself MOVES (old path stops existing) before anything happens.
import { useState, useEffect, useRef, useCallback } from 'react';
import { Button, Callout, Dialog, FieldError, OneJobCard, OneJobLabel, OneJobText, TextInput } from './ui';
import { plainMessage } from '../utils/ipc-error';

interface Props {
  sourcePath: string;
  defaultName: string;
  onClose: () => void;
  /** Called with the new project path after a successful import */
  onDone: (newPath: string) => void;
}

export default function ImportProjectModal({ sourcePath, defaultName, onClose, onDone }: Props) {
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Honesty rule (spec decision 6): when global Sync is off, every sync
  // promise softens. This modal is reached from the Project View hero's "Turn
  // on sync" button DIRECTLY (not only via AddProjectModal), so it must carry
  // the note itself. null = unknown (Android has no syncspaces handlers) → no
  // note, matching AddProjectModal's convention.
  const [syncEnabled, setSyncEnabled] = useState<boolean | null>(null);
  // Post-success state: when the move produced warnings we keep the modal open
  // to show them (closing instantly would hide "delete the old copy manually").
  const [doneWarnings, setDoneWarnings] = useState<string[] | null>(null);
  const [donePath, setDonePath] = useState<string | null>(null);

  // cancelledRef — prevent setState after unmount for the async import chain
  // (mirrors RatingSubmitModal): if the modal is closed while the move is in
  // flight, the late resolve must not setState on an unmounted component.
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    // Fetch Sync's on/off state so the honesty note can render. catch → null
    // (unknown) shows no note — same convention AddProjectModal uses.
    (window as any).claude.syncSpaces.status()
      .then((s: any) => { if (!cancelledRef.current) setSyncEnabled(!!s?.enabled); })
      .catch(() => { if (!cancelledRef.current) setSyncEnabled(null); });
    return () => { cancelledRef.current = true; };
  }, []);

  // In-flight latch — a ref, not state, because held-Enter key-repeat can fire
  // confirm() twice BEFORE the `busy` re-render lands, and the folder move is
  // non-idempotent (a second concurrent call would race the first).
  const inFlightRef = useRef(false);

  // After a successful move, EVERY dismissal path (ESC, Scrim click, Done
  // button) must go through onDone so the parent reconciles the folder list —
  // the old path no longer exists on disk. Only the pre-move state may cancel
  // via plain onClose.
  const dismiss = doneWarnings && donePath ? () => onDone(donePath) : onClose;

  // Escape, the ✕ and an outside click all go through the shared popup, and its `busy` holds
  // them while the move runs — dismissing mid-move would unmount the modal and lose the
  // success/warnings handoff. (This used its own useEscClose before PR-8; the Dialog's own
  // Esc made two closers.)

  const confirm = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    // Ref latch catches double-fires that land before the busy state re-renders.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    setError(null);
    // try/catch: on the phone's own bridge the shim refuses at once (no Sync Spaces
    // engine there) — surface the plain sentence inline, never as an unhandled rejection.
    try {
      const r = await (window as any).claude.syncSpaces.importProject(sourcePath, trimmed);
      if (cancelledRef.current) return;
      if (r?.ok) {
        if (r.warnings?.length) { setDoneWarnings(r.warnings); setDonePath(r.path); }
        else onDone(r.path);
      } else {
        setError(r?.error ?? 'Could not move the folder');
      }
    } catch (err: any) {
      if (cancelledRef.current) return;
      setError(plainMessage(err));
    } finally {
      inFlightRef.current = false;
      if (!cancelledRef.current) setBusy(false);
    }
  }, [name, busy, sourcePath, onDone]);

  // WHY the shared notice box (guide "Status and notices": every info notice is Callout), the
  // same one AddProjectModal shows — this copy was still the hand-made inset box (PR-8).
  // Shown only in the pre-move consent state (once the move succeeds the folder IS in the sync home).
  const syncOffNote = syncEnabled === false && (
    <Callout tone="info">
      Sync is currently turned off. This project will start syncing once you turn on Sync in Settings.
    </Callout>
  );

  // WHY rebuilt on the shared popup's own parts (final-review#PR-8, Destin: "this seems a little
  // odd"). Against the guide it broke five rules: a hand-made 14px title with no ✕ and no
  // tapered line (guide "Popups": the shared 16px title, ✕, tapered line); a bare-text Cancel
  // (guide "Buttons": outlined, never bare text); its words and its field sitting bare on the
  // popup (the popup rule, final-review#ST-21/#PR-7: body content sits in a card); a hand-made
  // sync-off note box (Callout); and its own Escape handler beside the Dialog's. Now: the title is
  // the Dialog's, the body is one card (explanation, the name field, its error, the note) with
  // the two buttons inside it at its foot (popup-cards-1#PC-1), stacked with "Move and sync" on
  // top (popup-cards-2#A-3, below). The words are unchanged.
  return (
    <Dialog
      open
      onClose={dismiss}
      busy={busy}
      title={doneWarnings ? 'Folder moved' : 'Move and sync this folder?'}
      size="panel"
      screen="projects/turn-on-sync"
    >
      {/* WHY the shared one-job card (popup-cards-1#PC-1, popup-cards-2#A-3): the same 12px grey
          words, named field and stacked buttons (main on top) as Remove project and the other
          one-job popups. Its two paragraphs were two different greys and its buttons sat side by
          side at the right. The words are unchanged. */}
      {doneWarnings ? (
        <OneJobCard actions={<Button onClick={() => onDone(donePath!)}>Done</Button>}>
          <OneJobText>
            <p>The folder now lives at <span className="text-fg break-all">{donePath}</span> and will sync across your devices. A couple of things need your attention:</p>
            <ul className="space-y-1 list-disc pl-4">
              {doneWarnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </OneJobText>
        </OneJobCard>
      ) : (
        <OneJobCard actions={<>
          <Button onClick={() => void confirm()} disabled={busy || !name.trim()}>
            {busy ? 'Moving…' : 'Move and sync'}
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        </>}>
          <div>
            {/* htmlFor/id pair: screen readers announce the field by its caption. */}
            <OneJobLabel htmlFor="import-project-name">Project name</OneJobLabel>
            <TextInput
              id="import-project-name"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void confirm(); }}
              className="w-full"
              autoFocus
            />
            {/* WHY FieldError (guide: no red/coloured body text for messages);
                it already carries role="alert" itself. */}
            {error && <FieldError as="div" className="mt-1.5">{error}</FieldError>}
          </div>
          {/* WHY under the box (popup-cards-3#B-3, Destin: "grey text below text input box"). */}
          <OneJobText under>
            <p>
              YouCoded will <span className="text-fg">move</span> <span className="break-all">{sourcePath}</span> to{' '}
              <span className="text-fg break-all">~/YouCoded/Projects/{name.trim() || '…'}/</span> so it can sync across your devices.
            </p>
            <p>
              The folder itself moves — anything pointing at the old location (shortcuts, open terminals, editors) will need the new path.
            </p>
          </OneJobText>
          {syncOffNote}
        </OneJobCard>
      )}
    </Dialog>
  );
}
