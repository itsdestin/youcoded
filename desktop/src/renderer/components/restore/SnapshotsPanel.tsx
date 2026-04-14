import React, { useEffect, useState } from 'react';
import type { Snapshot } from '../../../shared/types';

// Lists safety-snapshots captured before each restore. Lets the user roll
// back a bad restore or free disk space by deleting old snapshots.
// Designed to embed inside SyncPanel (no scrim/modal wrapper).

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatTs(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

export function SnapshotsPanel() {
  const [snaps, setSnaps] = useState<Snapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  async function load() {
    try {
      // @ts-ignore
      const list: Snapshot[] = await window.claude.sync.restore.listSnapshots();
      setSnaps(list ?? []);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleRestore(id: string) {
    setBusyId(id);
    try {
      // @ts-ignore
      await window.claude.sync.restore.undo(id);
      await load();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(id: string) {
    setBusyId(id);
    try {
      // @ts-ignore
      await window.claude.sync.restore.deleteSnapshot(id);
      setConfirmDeleteId(null);
      await load();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <div className="text-sm font-medium text-fg">Safety snapshots</div>
        <div className="text-[11px] text-fg-dim mt-0.5">
          Each restore saves a snapshot of your device first so you can roll back.
        </div>
      </div>

      {error && (
        <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      {snaps === null && !error && (
        <div className="text-[11px] text-fg-dim px-3 py-4 text-center">Loading…</div>
      )}

      {snaps && snaps.length === 0 && (
        <div className="text-[11px] text-fg-muted px-3 py-4 text-center border border-dashed border-edge-dim rounded-md">
          No snapshots yet.
        </div>
      )}

      {snaps && snaps.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {snaps.map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-3 px-3 py-2 rounded-md bg-inset/50 border border-edge-dim"
            >
              <div className="flex-1 min-w-0">
                <div className="text-[11px] text-fg font-medium">{formatTs(s.timestamp)}</div>
                <div className="text-[10px] text-fg-dim truncate">
                  {s.categories.join(', ')} · {formatBytes(s.sizeBytes)}
                  {s.triggeredBy === 'manual' && ' · manual'}
                </div>
              </div>
              {confirmDeleteId === s.id ? (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-fg-dim">Delete?</span>
                  <button
                    disabled={busyId === s.id}
                    onClick={() => handleDelete(s.id)}
                    className="px-2 py-1 rounded text-[10px] bg-red-500/20 hover:bg-red-500/30 text-red-300 disabled:opacity-50"
                  >
                    Yes
                  </button>
                  <button
                    onClick={() => setConfirmDeleteId(null)}
                    className="px-2 py-1 rounded text-[10px] bg-inset hover:bg-edge text-fg-muted"
                  >
                    No
                  </button>
                </div>
              ) : (
                <>
                  <button
                    disabled={busyId === s.id}
                    onClick={() => handleRestore(s.id)}
                    className="px-2 py-1 rounded-md text-[10px] font-medium bg-inset hover:bg-edge text-fg transition-colors disabled:opacity-50"
                  >
                    {busyId === s.id ? 'Restoring…' : 'Restore'}
                  </button>
                  <button
                    onClick={() => setConfirmDeleteId(s.id)}
                    className="px-2 py-1 rounded-md text-[10px] text-fg-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
