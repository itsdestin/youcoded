import React, { useState } from 'react';
import { Scrim, OverlayPanel } from '../overlays/Overlay';
import { RestorePointPicker } from './RestorePointPicker';
import { RestorePreview } from './RestorePreview';
import { RestoreProgress } from './RestoreProgress';
import { RestoreSummary } from './RestoreSummary';
import type {
  RestoreCategory,
  RestorePreview as RestorePreviewData,
  RestoreResult,
} from '../../../shared/types';

// Top-level restore flow. Step machine:
//   pick-version → pick-categories → preview → safety → confirm → progress → done
// For Drive/iCloud (HEAD-only) backends we skip pick-version and use 'HEAD'.
// 'error' is a terminal-ish state reachable from any step on IPC failure.

type Step =
  | 'pick-version'
  | 'pick-categories'
  | 'preview'
  | 'safety'
  | 'confirm'
  | 'progress'
  | 'done'
  | 'error';

type BackendType = 'drive' | 'github' | 'icloud';

type Props = {
  backendId: string;
  backendLabel: string;
  backendType: BackendType;
  onClose: () => void;
  onRestored?: (result: RestoreResult) => void;
};

const ALL_CATEGORIES: RestoreCategory[] = [
  'memory',
  'conversations',
  'encyclopedia',
  'skills',
  'plans',
  'specs',
];

export function RestoreWizard({ backendId, backendLabel, backendType, onClose, onRestored }: Props) {
  // GitHub is the only backend with full history; others are HEAD-only.
  const needsVersionPicker = backendType === 'github';

  const [step, setStep] = useState<Step>(needsVersionPicker ? 'pick-version' : 'pick-categories');
  const [versionRef, setVersionRef] = useState<string>('HEAD');
  const [categories, setCategories] = useState<RestoreCategory[]>([...ALL_CATEGORIES]);
  const [preview, setPreview] = useState<RestorePreviewData | null>(null);
  const [snapshotFirst, setSnapshotFirst] = useState(true);
  const [understood, setUnderstood] = useState(false);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadPreview(cats: RestoreCategory[], ref: string) {
    setBusy(true);
    try {
      // @ts-ignore window.claude is contextBridge-provided
      const p: RestorePreviewData = await window.claude.sync.restore.preview({
        backendId,
        versionRef: ref,
        categories: cats,
        snapshotFirst,
      });
      setPreview(p);
      setStep('preview');
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setStep('error');
    } finally {
      setBusy(false);
    }
  }

  async function executeRestore() {
    setStep('progress');
    try {
      // @ts-ignore
      const r: RestoreResult = await window.claude.sync.restore.execute({
        backendId,
        versionRef,
        categories,
        snapshotFirst,
      });
      setResult(r);
      setStep('done');
      onRestored?.(r);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setStep('error');
    }
  }

  async function handleUndo(snapshotId: string) {
    setBusy(true);
    try {
      // @ts-ignore
      await window.claude.sync.restore.undo(snapshotId);
      onClose();
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setStep('error');
    } finally {
      setBusy(false);
    }
  }

  function toggleCategory(c: RestoreCategory) {
    setCategories((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]));
  }

  return (
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        layer={2}
        role="dialog"
        aria-modal
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[520px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-48px)] flex flex-col"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
          <div>
            <div className="text-sm font-medium text-fg">Restore from backup</div>
            <div className="text-[10px] text-fg-muted mt-0.5">{backendLabel}</div>
          </div>
          <button
            onClick={onClose}
            className="text-fg-muted hover:text-fg-2 text-lg leading-none w-8 h-8 flex items-center justify-center rounded-sm hover:bg-inset"
          >
            ×
          </button>
        </div>

        <div className="px-4 py-4 overflow-y-auto flex-1">
          {step === 'pick-version' && (
            <RestorePointPicker
              backendId={backendId}
              onPick={(ref) => {
                setVersionRef(ref);
                setStep('pick-categories');
              }}
              onCancel={onClose}
            />
          )}

          {step === 'pick-categories' && (
            <div className="flex flex-col gap-3">
              <div>
                <div className="text-sm font-medium text-fg">What to restore</div>
                <div className="text-[11px] text-fg-dim mt-0.5">
                  Pick the categories you want to pull from this backup.
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                {ALL_CATEGORIES.map((c) => {
                  const checked = categories.includes(c);
                  return (
                    <label
                      key={c}
                      className="flex items-center gap-2 px-3 py-2 rounded-md bg-inset/50 border border-edge-dim hover:bg-inset cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleCategory(c)}
                        className="accent-accent"
                      />
                      <span className="text-xs text-fg capitalize">{c}</span>
                    </label>
                  );
                })}
              </div>
              <div className="flex justify-between gap-2 pt-2 border-t border-edge-dim">
                <button
                  onClick={onClose}
                  className="px-3 py-1.5 rounded-md text-[11px] font-medium bg-inset hover:bg-edge text-fg-muted transition-colors"
                >
                  Cancel
                </button>
                <button
                  disabled={categories.length === 0 || busy}
                  onClick={() => loadPreview(categories, versionRef)}
                  className="px-3 py-1.5 rounded-md text-[11px] font-medium bg-accent hover:opacity-90 text-on-accent transition-colors disabled:opacity-50"
                >
                  {busy ? 'Loading…' : 'Preview changes'}
                </button>
              </div>
            </div>
          )}

          {step === 'preview' && preview && (
            <div className="flex flex-col gap-3">
              <RestorePreview preview={preview} categories={categories} />
              <div className="flex justify-between gap-2 pt-2 border-t border-edge-dim">
                <button
                  onClick={() => setStep('pick-categories')}
                  className="px-3 py-1.5 rounded-md text-[11px] font-medium bg-inset hover:bg-edge text-fg-muted transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={() => setStep('safety')}
                  className="px-3 py-1.5 rounded-md text-[11px] font-medium bg-accent hover:opacity-90 text-on-accent transition-colors"
                >
                  Continue
                </button>
              </div>
            </div>
          )}

          {step === 'safety' && preview && (
            <div className="flex flex-col gap-3">
              <div>
                <div className="text-sm font-medium text-fg">Safety check</div>
                <div className="text-[11px] text-fg-dim mt-0.5">
                  Restore overwrites local data with the backup. A safety snapshot lets you
                  undo if something goes wrong.
                </div>
              </div>

              {preview.warnings.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  {preview.warnings.map((w, i) => (
                    <div
                      key={i}
                      className="text-[11px] px-3 py-2 rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-300"
                    >
                      {w}
                    </div>
                  ))}
                </div>
              )}

              <label className="flex items-start gap-2 px-3 py-2 rounded-md bg-inset/50 border border-edge-dim cursor-pointer">
                <input
                  type="checkbox"
                  checked={snapshotFirst}
                  onChange={(e) => setSnapshotFirst(e.target.checked)}
                  className="accent-accent mt-0.5"
                />
                <span className="text-[11px] text-fg">
                  Take a safety snapshot first (recommended)
                </span>
              </label>
              {!snapshotFirst && (
                // Snapshot-first is a load-bearing safety net — if the user
                // opts out, surface a warning so it's a conscious decision.
                <div className="text-[11px] px-3 py-2 rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-300">
                  Without a snapshot, this restore cannot be undone.
                </div>
              )}

              <label className="flex items-start gap-2 px-3 py-2 rounded-md bg-inset/50 border border-edge cursor-pointer">
                <input
                  type="checkbox"
                  checked={understood}
                  onChange={(e) => setUnderstood(e.target.checked)}
                  className="accent-accent mt-0.5"
                />
                <span className="text-[11px] text-fg">
                  I understand this will overwrite local data
                </span>
              </label>

              <div className="flex justify-between gap-2 pt-2 border-t border-edge-dim">
                <button
                  onClick={() => setStep('preview')}
                  className="px-3 py-1.5 rounded-md text-[11px] font-medium bg-inset hover:bg-edge text-fg-muted transition-colors"
                >
                  Back
                </button>
                <button
                  disabled={!understood}
                  onClick={() => setStep('confirm')}
                  className="px-3 py-1.5 rounded-md text-[11px] font-medium bg-accent hover:opacity-90 text-on-accent transition-colors disabled:opacity-50"
                >
                  Continue
                </button>
              </div>
            </div>
          )}

          {step === 'confirm' && (
            <div className="flex flex-col gap-3">
              <div>
                <div className="text-sm font-medium text-fg">Ready to restore</div>
                <div className="text-[11px] text-fg-dim mt-0.5">
                  Restore <span className="text-fg">{categories.length}</span> categor
                  {categories.length === 1 ? 'y' : 'ies'} from{' '}
                  <span className="text-fg">{backendLabel}</span>
                  {snapshotFirst && ' (with safety snapshot)'}. This can take a minute.
                </div>
              </div>
              <div className="flex justify-between gap-2 pt-2 border-t border-edge-dim">
                <button
                  onClick={() => setStep('safety')}
                  className="px-3 py-1.5 rounded-md text-[11px] font-medium bg-inset hover:bg-edge text-fg-muted transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={executeRestore}
                  className="px-3 py-1.5 rounded-md text-[11px] font-medium bg-accent hover:opacity-90 text-on-accent transition-colors"
                >
                  Start restore
                </button>
              </div>
            </div>
          )}

          {step === 'progress' && <RestoreProgress categories={categories} />}

          {step === 'done' && result && (
            <RestoreSummary result={result} onClose={onClose} onUndo={handleUndo} />
          )}

          {step === 'error' && (
            <div className="flex flex-col gap-3">
              <div>
                <div className="text-sm font-medium text-fg">Restore failed</div>
                <div className="text-[11px] text-fg-dim mt-0.5">{error ?? 'Unknown error.'}</div>
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t border-edge-dim">
                <button
                  onClick={onClose}
                  className="px-3 py-1.5 rounded-md text-[11px] font-medium bg-inset hover:bg-edge text-fg-muted transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </div>
      </OverlayPanel>
    </>
  );
}
