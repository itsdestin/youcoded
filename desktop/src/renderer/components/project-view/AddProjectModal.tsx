// desktop/src/renderer/components/project-view/AddProjectModal.tsx
// The unified "Add a project" flow (2026-07-09 project-sync UX spec §3).
// A thin ROUTER over existing machinery — no new main-process flows:
//   Start something new        → syncSpaces.createProject(name)
//   Use existing → keep        → folders.add(path)
//   Use existing → move+sync   → the existing ImportProjectModal (consent+move)
// Step 1 asks the only question a new user can answer instantly (new or
// existing?); step 2 makes the sync decision explicit with its consequence.
import { useState, useEffect, useRef, useCallback } from 'react';
import { Scrim, OverlayPanel } from '../overlays/Overlay';
import { useEscClose } from '../../hooks/use-esc-close';
import ImportProjectModal from '../ImportProjectModal';
import { plainMessage } from '../../utils/ipc-error';
import { Button, InputGroup } from '../ui';

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
  // consent copy, name confirm, warnings). ESC/scrim for THIS modal only
  // apply outside the move step (ImportProjectModal manages its own).
  useEscClose(step.kind !== 'move' && !busy, onClose);

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

  const syncOffNote = syncEnabled === false && (
    <div className="mt-3 rounded-md border border-edge bg-inset px-3 py-2 text-xs text-fg-dim" role="note">
      <span className="text-fg-2 font-medium">Sync is currently turned off.</span>{' '}
      This project will start syncing once you turn on Sync in Settings.
    </div>
  );

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

  return (
    <>
      <Scrim layer={2} onClick={busy ? undefined : onClose} />
      <OverlayPanel
        layer={2}
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[26rem] max-w-[calc(100vw-2rem)] p-4"
        role="dialog"
        aria-modal
        aria-labelledby="add-project-title"
      >
        {step.kind === 'choose' ? (
          <>
            <div id="add-project-title" className="text-sm font-medium text-fg">Add a project</div>

            {/* Choice 1: start new (inline name + create) */}
            <div className="mt-3 rounded-lg border border-edge p-3">
              <div className="text-sm-tight font-semibold text-fg">Start something new</div>
              <div className="mt-0.5 text-xs text-fg-dim">Creates an empty project in YouCoded that syncs across your devices.</div>
              {/* Change 77: Create submits this field, so it moves INSIDE the
                  field rather than sitting alongside it. Cancel stays in the
                  modal footer — only the submit goes inside. */}
              <InputGroup className="mt-2">
                {/* No autoFocus (deliberate): the choose step presents two co-equal
                    choices — auto-focusing would bias toward create-new and pre-arm Enter. */}
                <InputGroup.Field
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void createNew(); }}
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
            <button
              onClick={() => void pickExisting()}
              disabled={busy}
              className="mt-2 w-full text-left rounded-lg border border-edge p-3 hover:border-accent hover:bg-inset transition-colors"
            >
              <div className="text-sm-tight font-semibold text-fg">Use a folder already on this computer</div>
              <div className="mt-0.5 text-xs text-fg-dim">Pick any folder — you'll choose whether it syncs next.</div>
            </button>

            {error && <div className="mt-2 text-xs text-destructive-fg" role="alert">{error}</div>}
            {syncOffNote}
            <div className="mt-4 flex justify-end">
              <Button variant="ghost" size="lg" className="py-1" onClick={onClose} disabled={busy}>Cancel</Button>
            </div>
          </>
        ) : (
          <>
            <div id="add-project-title" className="text-sm font-medium text-fg">How should “{step.baseName}” work?</div>

            <button
              onClick={() => void keepInPlace()}
              disabled={busy}
              className="mt-3 w-full text-left rounded-lg border border-edge p-3 hover:border-accent hover:bg-inset transition-colors"
            >
              <div className="text-sm-tight font-semibold text-fg">Keep it where it is</div>
              <div className="mt-0.5 text-xs text-fg-dim">Only on this computer. The folder doesn't move and nothing changes.</div>
            </button>

            <button
              // Clear any stale keep-in-place error so it doesn't reappear after
              // Cancel-ing back from ImportProjectModal.
              onClick={() => { setError(null); setStep({ kind: 'move', path: step.path, baseName: step.baseName }); }}
              disabled={busy}
              className="mt-2 w-full text-left rounded-lg border border-edge p-3 hover:border-accent hover:bg-inset transition-colors"
            >
              <div className="text-sm-tight font-semibold text-fg">Move it into YouCoded so it syncs</div>
              <div className="mt-0.5 text-xs text-fg-dim">The folder moves to ~/YouCoded/Projects/ and syncs across your devices. Anything pointing at the old location (shortcuts, open terminals) will need the new path.</div>
            </button>

            {error && <div className="mt-2 text-xs text-destructive-fg" role="alert">{error}</div>}
            {syncOffNote}
            <div className="mt-4 flex justify-between">
              <Button variant="ghost" size="lg" className="py-1" onClick={() => { setError(null); setStep({ kind: 'choose' }); }} disabled={busy}>Back</Button>
              <Button variant="ghost" size="lg" className="py-1" onClick={onClose} disabled={busy}>Cancel</Button>
            </div>
          </>
        )}
      </OverlayPanel>
    </>
  );
}
