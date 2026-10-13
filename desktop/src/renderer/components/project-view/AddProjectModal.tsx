// desktop/src/renderer/components/project-view/AddProjectModal.tsx
// The unified "Add a project" flow (2026-07-09 project-sync UX spec §3).
// A thin ROUTER over existing machinery — no new main-process flows:
//   Start something new        → syncSpaces.createProject(name)
//   Use existing → keep        → folders.add(path)
//   Use existing → move+sync   → the existing ImportProjectModal (consent+move)
// Step 1 asks the only question a new user can answer instantly (new or
// existing?); step 2 makes the sync decision explicit with its consequence.
import { useState, useEffect, useRef, useCallback } from 'react';
import ImportProjectModal from '../ImportProjectModal';
import { plainMessage } from '../../utils/ipc-error';
import { Button, Callout, CARD_LEVEL_1, Dialog, FieldError, InputGroup } from '../ui';

interface Props {
  onClose: () => void;
  /** Called with the project path after ANY successful add path. */
  onAdded: (path: string) => void;
}

type Step =
  | { kind: 'choose' }
  | { kind: 'existing'; path: string; baseName: string }
  | { kind: 'move'; path: string; baseName: string };

export default function AddProjectModal({ onClose, onAdded }: Props) {
  const [step, setStep] = useState<Step>({ kind: 'choose' });
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Honesty rule: when global Sync is off, every sync promise softens to
  // "will sync once you turn on Sync in Settings". null = unknown (e.g.
  // Android where syncspaces handlers don't exist) — show no note.
  const [syncEnabled, setSyncEnabled] = useState<boolean | null>(null);
  const cancelledRef = useRef(false);
  const inFlightRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    (window as any).claude.syncSpaces.status()
      .then((s: any) => { if (!cancelledRef.current) setSyncEnabled(!!s?.enabled); })
      .catch(() => { if (!cancelledRef.current) setSyncEnabled(null); });
    return () => { cancelledRef.current = true; };
  }, []);

  // The move step delegates entirely to ImportProjectModal (it owns the
  // consent copy, name confirm, warnings); this popup is not drawn then, so
  // its Esc (the shared Dialog's) only applies outside the move step.

  const createNew = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    setError(null);
    // try/catch: on the phone's own bridge the shim refuses at once (no Sync Spaces
    // engine there) — surface the plain sentence inline, never the channel id.
    try {
      const r = await (window as any).claude.syncSpaces.createProject(trimmed);
      if (cancelledRef.current) return;
      if (r?.ok) onAdded(r.path);
      else setError(r?.error ?? 'Could not create the project');
    } catch (err: any) {
      if (!cancelledRef.current) setError(plainMessage(err));
    } finally {
      inFlightRef.current = false;
      if (!cancelledRef.current) setBusy(false);
    }
  }, [name, onAdded]);

  const pickExisting = useCallback(async () => {
    try {
      const folder: string | null = await (window as any).claude.dialog.openFolder();
      if (!folder || cancelledRef.current) return;
      const baseName = folder.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
      setError(null);
      setStep({ kind: 'existing', path: folder, baseName });
    } catch (err: any) {
      // Cancel resolves to null (handled above), NOT a rejection — anything
      // caught here is a genuine failure worth showing, not a user cancel.
      if (!cancelledRef.current) setError(plainMessage(err));
    }
  }, []);

  const keepInPlace = useCallback(async () => {
    if (step.kind !== 'existing' || inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await (window as any).claude.folders.add(step.path);
      if (!cancelledRef.current) onAdded(step.path);
    } catch (err: any) {
      if (!cancelledRef.current) setError(plainMessage(err));
    } finally {
      inFlightRef.current = false;
      if (!cancelledRef.current) setBusy(false);
    }
  }, [step, onAdded]);

  // WHY the shared notice box (guide "Status and notices": every info notice is Callout) —
  // it was a hand-made inset box with its own border.
  const syncOffNote = syncEnabled === false && (
    <Callout tone="info">
      Sync is currently turned off. This project will start syncing once you turn on Sync in Settings.
    </Callout>
  );

  // One recipe for every choice: the first-level card Add a backup's choices use
  // (SyncSetupWizard, small-fixes-3#SF3-1), lighting on hover.
  const CHOICE = `w-full ${CARD_LEVEL_1} p-3 text-left transition-colors hover:bg-inset disabled:opacity-50`;

  if (step.kind === 'move') {
    return (
      <ImportProjectModal
        sourcePath={step.path}
        defaultName={step.baseName}
        onClose={() => setStep({ kind: 'existing', path: step.path, baseName: step.baseName })}
        onDone={(p) => onAdded(p)}
      />
    );
  }

  // WHY the shared popup (decisions "Popup and side-panel titles", H-2, names "Add a project";
  // "Closing popups", B-1): this was a hand-built panel — its own 14px title, no ✕, no tapered
  // line, ghost Cancel / Back buttons and its own bordered choice boxes. Now the 16px title with
  // the ✕; the second step is a page inside the popup, so "Back" is the popup's back arrow
  // (guide "A page inside a popup"); the choices are first-level cards (CHOICE). The ✕ and Esc
  // replace Cancel, and stay disabled while something is being added (busy).
  const existing = step.kind === 'existing' ? step : null;
  return (
    <Dialog
      open
      onClose={onClose}
      title={existing ? `How should “${existing.baseName}” work?` : 'Add a project'}
      onBack={existing ? () => { setError(null); setStep({ kind: 'choose' }); } : undefined}
      size="panel"
      busy={busy}
      screen={existing ? undefined : 'projects/add'}
      noScreen={existing ? 'Reached only after picking a folder in the system folder picker.' : undefined}
    >
      <div className="flex flex-col gap-2">
        {!existing ? (
          <>
            {/* Choice 1: start new (inline name + create) */}
            <div className={`${CARD_LEVEL_1} p-3`}>
              <div className="text-sm-tight font-semibold text-fg">Start something new</div>
              <div className="mt-0.5 text-xs text-fg-dim">Creates an empty project in YouCoded that syncs across your devices.</div>
              {/* Change 77: Create submits this field, so it sits INSIDE the field. */}
              <InputGroup className="mt-2">
                {/* No autoFocus (deliberate): the choose step presents two co-equal
                    choices — auto-focusing would bias toward create-new and pre-arm Enter. */}
                <InputGroup.Field
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void createNew(); }}
                  placeholder="Project name…"
                  aria-label="Project name"
                />
                <Button
                  size="sm"
                  onClick={() => void createNew()}
                  disabled={busy || !name.trim()}
                >
                  {busy ? 'Creating…' : 'Create'}
                </Button>
              </InputGroup>
            </div>

            {/* Choice 2: existing folder → step 2 */}
            <button onClick={() => void pickExisting()} disabled={busy} className={CHOICE}>
              <div className="text-sm-tight font-semibold text-fg">Use a folder already on this computer</div>
              <div className="mt-0.5 text-xs text-fg-dim">Pick any folder — you'll choose whether it syncs next.</div>
            </button>
          </>
        ) : (
          <>
            <button onClick={() => void keepInPlace()} disabled={busy} className={CHOICE}>
              <div className="text-sm-tight font-semibold text-fg">Keep it where it is</div>
              <div className="mt-0.5 text-xs text-fg-dim">Only on this computer. The folder doesn't move and nothing changes.</div>
            </button>

            <button
              // Clear any stale keep-in-place error so it doesn't reappear after
              // Cancel-ing back from ImportProjectModal.
              onClick={() => { setError(null); setStep({ kind: 'move', path: existing.path, baseName: existing.baseName }); }}
              disabled={busy}
              className={CHOICE}
            >
              <div className="text-sm-tight font-semibold text-fg">Move it into YouCoded so it syncs</div>
              <div className="mt-0.5 text-xs text-fg-dim">The folder moves to ~/YouCoded/Projects/ and syncs across your devices. Anything pointing at the old location (shortcuts, open terminals) will need the new path.</div>
            </button>
          </>
        )}
        {/* WHY FieldError (guide: no red/coloured body text for messages) */}
        {error && <FieldError as="div">{error}</FieldError>}
        {syncOffNote}
      </div>
    </Dialog>
  );
}
