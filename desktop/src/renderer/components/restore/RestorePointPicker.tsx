import React, { useEffect, useState } from 'react';
import type { RestorePoint } from '../../../shared/types';

// Lists available restore points (git tags/shas for GitHub backends).
// Drive/iCloud backends are HEAD-only and skip this picker entirely —
// RestoreWizard handles that branch by defaulting ref='HEAD'.

type Props = {
  backendId: string;
  onPick: (ref: string) => void;
  onCancel: () => void;
};

function formatTs(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

export function RestorePointPicker({ backendId, onPick, onCancel }: Props) {
  const [versions, setVersions] = useState<RestorePoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // @ts-ignore — window.claude is contextBridge-provided
        const list: RestorePoint[] = await window.claude.sync.restore.listVersions(backendId);
        if (!cancelled) setVersions(list ?? []);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [backendId]);

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-sm font-medium text-fg">Pick a restore point</div>
        <div className="text-[11px] text-fg-dim mt-0.5">
          Choose which version of the backup to restore from.
        </div>
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
          Failed to load versions: {error}
        </div>
      )}

      {!error && versions === null && (
        <div className="text-xs text-fg-dim px-3 py-6 text-center">Loading versions…</div>
      )}

      {!error && versions && versions.length === 0 && (
        <div className="text-xs text-fg-dim px-3 py-6 text-center">
          No restore points found on this backend.
        </div>
      )}

      {!error && versions && versions.length > 0 && (
        <div className="max-h-72 overflow-y-auto flex flex-col gap-1.5 pr-1">
          {versions.map((v) => (
            <button
              key={v.ref}
              onClick={() => onPick(v.ref)}
              className="text-left px-3 py-2 rounded-md bg-inset/50 hover:bg-inset border border-edge-dim hover:border-edge transition-colors"
            >
              <div className="text-xs font-medium text-fg">{v.label}</div>
              <div className="text-[10px] text-fg-muted mt-0.5">{formatTs(v.timestamp)}</div>
              {v.summary && (
                <div className="text-[10px] text-fg-dim mt-1 line-clamp-2">{v.summary}</div>
              )}
            </button>
          ))}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2 border-t border-edge-dim">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 rounded-md text-[11px] font-medium bg-inset hover:bg-edge text-fg-muted transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
