import React, { useState } from 'react';
import { Scrim, OverlayPanel } from '../overlays/Overlay';
import { RestorePointPicker } from './RestorePointPicker';
import { RestorePreview } from './RestorePreview';
import { RestoreProgress } from './RestoreProgress';
import { RestoreSummary } from './RestoreSummary';
import type {
  RestoreCategory,
  RestoreMode,
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
  | 'pick-mode'
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
  // Merge (union) is the default because it's non-destructive on both sides.
  // Wipe (mirror) has to be opted into — and the UI later forces snapshot on.
  const [mode, setMode] = useState<RestoreMode>('merge');
  // Which mode's (i) panel is expanded. Only one can be open at a time.
  const [infoOpen, setInfoOpen] = useState<RestoreMode | null>(null);
  // Only meaningful for wipe; in merge mode we never snapshot (nothing to undo).
  const [snapshotFirst, setSnapshotFirst] = useState(true);
  const [understood, setUnderstood] = useState(false);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadPreview(cats: RestoreCategory[], ref: string, m: RestoreMode) {
    setBusy(true);
    try {
      // @ts-ignore window.claude is contextBridge-provided
      const p: RestorePreviewData = await window.claude.sync.restore.preview({
        backendId,
        versionRef: ref,
        categories: cats,
        snapshotFirst: m === 'wipe' ? snapshotFirst : false,
        mode: m,
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
        // Merge is always non-destructive → snapshot is meaningless and skipped.
        snapshotFirst: mode === 'wipe' ? snapshotFirst : false,
        mode,
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
                  onClick={() => setStep('pick-mode')}
                  className="px-3 py-1.5 rounded-md text-[11px] font-medium bg-accent hover:opacity-90 text-on-accent transition-colors disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>
          )}

          {step === 'pick-mode' && (
            <div className="flex flex-col gap-3">
              <div>
                <div className="text-sm font-medium text-fg">How should we restore?</div>
                <div className="text-[11px] text-fg-dim mt-0.5">
                  Two very different behaviors — pick carefully.
                </div>
              </div>
              <ModeCard
                mode="merge"
                selected={mode === 'merge'}
                onSelect={() => setMode('merge')}
                infoOpen={infoOpen === 'merge'}
                onToggleInfo={() => setInfoOpen(infoOpen === 'merge' ? null : 'merge')}
                title="Merge (recommended)"
                short="Download files from the backup that are missing or older locally, and upload files that are only on this device. Nothing gets deleted on either side."
                details={MERGE_DETAILS}
              />
              <ModeCard
                mode="wipe"
                selected={mode === 'wipe'}
                onSelect={() => setMode('wipe')}
                infoOpen={infoOpen === 'wipe'}
                onToggleInfo={() => setInfoOpen(infoOpen === 'wipe' ? null : 'wipe')}
                title={<>Wipe &amp; restore <span className="text-red-400">(destructive)</span></>}
                short={<>Replace local data with the backup exactly. Any files on this device that aren&apos;t in the backup will be <span className="text-red-400">deleted</span>. A safety snapshot is taken first so you can undo.</>}
                details={WIPE_DETAILS}
                destructive
              />

              <div className="flex justify-between gap-2 pt-2 border-t border-edge-dim">
                <button
                  onClick={() => setStep('pick-categories')}
                  className="px-3 py-1.5 rounded-md text-[11px] font-medium bg-inset hover:bg-edge text-fg-muted transition-colors"
                >
                  Back
                </button>
                <button
                  disabled={busy}
                  onClick={() => loadPreview(categories, versionRef, mode)}
                  className="px-3 py-1.5 rounded-md text-[11px] font-medium bg-accent hover:opacity-90 text-on-accent transition-colors disabled:opacity-50"
                >
                  {busy ? 'Loading…' : 'Preview changes'}
                </button>
              </div>
            </div>
          )}

          {step === 'preview' && preview && (
            <div className="flex flex-col gap-3">
              <RestorePreview
                preview={preview}
                categories={categories}
                backendId={backendId}
                versionRef={versionRef}
              />
              <div className="flex justify-between gap-2 pt-2 border-t border-edge-dim">
                <button
                  onClick={() => setStep('pick-mode')}
                  className="px-3 py-1.5 rounded-md text-[11px] font-medium bg-inset hover:bg-edge text-fg-muted transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={() => setStep(mode === 'wipe' ? 'safety' : 'confirm')}
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
                <div className="text-sm font-medium text-fg">
                  Ready to {mode === 'merge' ? 'merge' : 'restore'}
                </div>
                <div className="text-[11px] text-fg-dim mt-0.5">
                  {mode === 'merge' ? 'Merge' : 'Wipe & restore'}{' '}
                  <span className="text-fg">{categories.length}</span> categor
                  {categories.length === 1 ? 'y' : 'ies'} with{' '}
                  <span className="text-fg">{backendLabel}</span>
                  {mode === 'wipe' && snapshotFirst && ' (with safety snapshot)'}.
                  {mode === 'merge' ? ' Nothing gets deleted.' : ' This can take a minute.'}
                </div>
              </div>
              <div className="flex justify-between gap-2 pt-2 border-t border-edge-dim">
                <button
                  onClick={() => setStep(mode === 'wipe' ? 'safety' : 'preview')}
                  className="px-3 py-1.5 rounded-md text-[11px] font-medium bg-inset hover:bg-edge text-fg-muted transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={executeRestore}
                  className={`px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors ${
                    mode === 'wipe'
                      ? 'bg-red-600 hover:bg-red-500 text-white'
                      : 'bg-accent hover:opacity-90 text-on-accent'
                  }`}
                >
                  {mode === 'merge' ? 'Start merge' : 'Wipe & restore'}
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

// --- Mode picker sub-components ---
//
// Each mode renders as a card with a radio, title, short description, and an
// (i) button that expands a longer explanation inline (no overlay — keeps the
// wizard's focus trap simple). The details list is deliberately concrete:
// Destin is a non-developer and the "what does this actually do" question
// needs to be answerable without reading code.

const MERGE_DETAILS: string[] = [
  'Runs like a two-way sync: pulls new or newer files from the backup, then pushes files that are only on this device up to the backup.',
  'No deletions on either side. If you have a file here that isn\'t in the backup, it stays — and it also gets uploaded.',
  'No safety snapshot is taken (nothing to undo — merge never removes anything).',
  'Use this when you want to pick up where another device left off, or after a fresh install.',
];

const WIPE_DETAILS: string[] = [
  'Replaces local files with the exact contents of the backup. Any local file that isn\'t in the backup is DELETED.',
  'A safety snapshot is taken first under ~/.claude/restore-snapshots/ so you can Undo within 10 snapshots / 90 days.',
  'Use this when you know the backup is the authoritative state (e.g., rolling back an accidentally corrupted local copy).',
  'The regular sync loop is paused during the restore so it can\'t re-upload half-restored state to the cloud.',
];

function ModeCard({
  mode,
  selected,
  onSelect,
  infoOpen,
  onToggleInfo,
  title,
  short,
  details,
  destructive,
}: {
  mode: RestoreMode;
  selected: boolean;
  onSelect: () => void;
  infoOpen: boolean;
  onToggleInfo: () => void;
  title: React.ReactNode;
  short: React.ReactNode;
  details: string[];
  destructive?: boolean;
}) {
  const ringClass = selected
    ? destructive
      ? 'bg-red-500/10 border-red-500/40'
      : 'bg-accent/10 border-accent'
    : 'bg-inset/50 border-edge-dim hover:bg-inset';
  const accent = destructive ? 'accent-red-500' : 'accent-accent';
  return (
    <div className={`rounded-md border ${ringClass}`}>
      {/* Clickable row — NOT a <label> wrapper because the (i) button lives
          inside and a <label> would forward its click to the radio. Instead
          we intercept row clicks to flip the radio, and the (i) stops
          propagation. */}
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelect()}
        className="flex items-start gap-2 px-3 py-2.5 cursor-pointer"
      >
        <input
          type="radio"
          name="restore-mode"
          value={mode}
          checked={selected}
          onChange={onSelect}
          className={`${accent} mt-1`}
          onClick={(e) => e.stopPropagation()}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-fg font-medium">{title}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleInfo();
              }}
              className="text-fg-muted hover:text-fg-2 w-5 h-5 flex items-center justify-center rounded-sm hover:bg-inset"
              aria-label={`What does ${mode} mode do?`}
              aria-expanded={infoOpen}
              title="Show details"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="9" />
                <path strokeLinecap="round" d="M12 11v5" />
                <circle cx="12" cy="8" r="0.5" fill="currentColor" />
              </svg>
            </button>
          </div>
          <div className="text-[11px] text-fg-dim mt-0.5">{short}</div>
        </div>
      </div>
      {infoOpen && (
        <div className="px-3 pb-3 pt-1 border-t border-edge-dim">
          <ul className="text-[11px] text-fg-dim space-y-1.5 list-disc pl-4">
            {details.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
