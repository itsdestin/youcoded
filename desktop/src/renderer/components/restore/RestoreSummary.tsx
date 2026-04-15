import React from 'react';
import type { RestoreResult } from '../../../shared/types';

// Final "done" step of the wizard. Shows what was restored and offers an
// Undo button when a snapshot was captured (snapshot-first default flow).

type Props = {
  result: RestoreResult;
  onClose: () => void;
  onUndo?: (snapshotId: string) => void;
};

export function RestoreSummary({ result, onClose, onUndo }: Props) {
  const seconds = Math.max(1, Math.round(result.durationMs / 1000));
  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-sm font-medium text-fg">Restore complete</div>
        <div className="text-[11px] text-fg-dim mt-0.5">
          {result.filesWritten} files across {result.categoriesRestored.length} categor
          {result.categoriesRestored.length === 1 ? 'y' : 'ies'} in {seconds}s.
        </div>
      </div>

      <div className="rounded-md border border-edge-dim bg-inset/40 px-3 py-2">
        <div className="text-[11px] text-fg-dim mb-1">Restored</div>
        <div className="flex flex-wrap gap-1.5">
          {result.categoriesRestored.map((c) => (
            <span
              key={c}
              className="px-2 py-0.5 rounded-full bg-inset border border-edge-dim text-[10px] text-fg capitalize"
            >
              {c}
            </span>
          ))}
        </div>
      </div>

      {result.requiresRestart && (
        <div className="text-[11px] px-3 py-2 rounded-md border border-blue-500/30 bg-blue-500/10 text-blue-300">
          Skills or memory changed — restart the app to apply.
        </div>
      )}

      <div className="flex justify-between items-center pt-2 border-t border-edge-dim">
        {result.snapshotId && onUndo ? (
          <button
            onClick={() => onUndo(result.snapshotId!)}
            className="px-3 py-1.5 rounded-md text-[11px] font-medium bg-inset hover:bg-edge text-fg-muted transition-colors"
          >
            Undo restore
          </button>
        ) : (
          <span />
        )}
        <button
          onClick={onClose}
          className="px-3 py-1.5 rounded-md text-[11px] font-medium bg-accent hover:opacity-90 text-on-accent transition-colors"
        >
          Done
        </button>
      </div>
    </div>
  );
}
