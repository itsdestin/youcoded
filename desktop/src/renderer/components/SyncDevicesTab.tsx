// The synced device list — the "Devices" tab body inside Backup & sync's sync card.
// WHY its own file (final review F53): moved unchanged out of SyncPanel.tsx, which had grown
// past its line budget on the ui-consistency branch.
import { useState, useCallback } from 'react';
import { Button, Callout, CARD_LEVEL_1, CARD_LEVEL_2, FieldError, TextInput } from './ui';
import { deviceActivityLabel, relativeMs } from './device-activity-label';

// Map process.platform to a plain, human word. Empty string (unknown platform)
// falls through to '' so the caller can omit it rather than print a raw code.
function platformLabel(p: string): string {
  switch (p) {
    case 'win32': return 'Windows';
    case 'darwin': return 'macOS';
    case 'linux': return 'Linux';
    // Android phones join the same device registry; without this the row read a
    // bare lowercase "android" next to "Linux" and "macOS".
    case 'android': return 'Android';
    default: return p || '';
  }
}

// --- DeviceRow + Devices count-tab (Plan 2b spec §10a) ---
// The synced device registry, rendered as the "Devices" tab body inside the sync
// box. PLAIN TEXT only — no status dots/glyphs (spec'd plain; owner dislikes
// glyphs). The current machine is marked "(this device)" and each name is an
// inline-editable nickname. Fetching + rename now live in SyncPopup (so the
// "Devices" count and this list share one source); this component keeps only the
// local editing draft state.

export interface DeviceRow {
  schemaVersion: number;
  id: string;
  name: string;
  platform: string;
  lastSeen: number;
  updatedAt: number;
  // Marks THIS machine — matched by machineId (per-MACHINE) in the main handler.
  // NOT the per-install deviceId: that's the lease id and matches no registry row.
  self: boolean;
}

export function DevicesTab({ devices, onRename, onRemove, syncInProgress, lastSyncByDevice, lastSyncEpoch }: { devices: DeviceRow[] | null; onRename: (id: string, name: string) => void; onRemove: (id: string) => Promise<string | null>; syncInProgress: boolean; lastSyncByDevice?: Record<string, number>; lastSyncEpoch: number | null }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // Two-step confirm: the id awaiting confirmation, if any. Removal is recoverable
  // (a live device re-registers), so this is a plain inline confirm rather than the
  // typed-confirm gate reserved for irreversible edits.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // Per-row failure note from the last remove attempt (ProvidersSection idiom).
  const [removeNote, setRemoveNote] = useState<{ id: string; text: string } | null>(null);

  const confirmRemove = useCallback(async (id: string) => {
    setConfirmingId(null);
    setRemoveNote(null);
    const failure = await onRemove(id);
    // On success the row simply disappears on the refetch — no note needed.
    if (failure) setRemoveNote({ id, text: failure });
  }, [onRemove]);

  // Commit a rename: reject empty/whitespace and skip a no-op rename so we don't
  // fire a pointless invoke + refetch. The parent (SyncPopup) owns the IPC call.
  const commitRename = useCallback((id: string) => {
    const name = draft.trim();
    setEditingId(null);
    if (!name) return;
    const current = devices?.find(d => d.id === id);
    if (current && current.name === name) return;
    onRename(id, name);
  }, [draft, devices, onRename]);

  // null = not loaded yet; [] = loaded-but-empty (sync off / no personal root).
  if (devices !== null && devices.length === 0) {
    return <p className="text-2xs text-fg-muted">No devices yet — they appear here once sync has run.</p>;
  }

  // WHY one shared container, not one box per row ("bare names ... inside ONE
  // shared container, not 3 separate boxes"): plain rows, matching below.
  return (
    <ul className={`${CARD_LEVEL_2} p-1.5 space-y-0.5`}>
      {(devices ?? []).map(d => {
        const plat = platformLabel(d.platform);
        // Real sync recency instead of the frozen launch-time "last seen":
        // "Synced just now" (<5 min), "Last synced 12 minutes ago" (older), or —
        // when there's no sync record (older main process / never-synced peer) —
        // the launch-time fallback. Self shows a live "Syncing…" mid-sync.
        // lastSyncByDevice is keyed by machineId, which is exactly `d.id`.
        // Self's recency comes from the LOCAL live marker (lastSyncEpoch, in
        // SECONDS → ms), not the DO map: the SyncHub never echoes a device's own
        // signal back to it, so self's own map entry only refreshes on reconnect
        // and would otherwise drift stale (row saying "20 min ago" while the panel
        // header says "just now"). Peers use the map, updated live from relayed signals.
        const lastSyncAt = d.self
          ? (lastSyncEpoch != null ? lastSyncEpoch * 1000 : null)
          : (lastSyncByDevice?.[d.id] ?? null);
        const activity = deviceActivityLabel({
          isSelf: d.self,
          syncInProgress,
          lastSyncAt,
          gitLastSeen: d.lastSeen,
        }, Date.now());
        const right = plat ? `${plat} · ${activity}` : activity;
        return (
          <li key={d.id}>
            <div className="flex items-center justify-between gap-2 px-1 py-1">{/* bare row inside the shared level-2 list */}
              <div className="min-w-0 flex items-center gap-1.5">
                {editingId === d.id ? (
                  /* Shared FIELD surface (spec change 20) — `sm` because this is an
                     inline edit inside a compact list row. min-w-0 stays: it lets the
                     input shrink inside the flex row instead of forcing overflow.
                     aria-label added — the input replaces the name button on click,
                     so there was nothing naming it for a screen reader. */
                  <TextInput
                    size="sm"
                    value={draft}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(d.id);
                      if (e.key === 'Escape') setEditingId(null); // cancel — no rename
                    }}
                    onBlur={() => commitRename(d.id)}
                    aria-label={`Rename ${d.name}`}
                    className="min-w-0"
                  />
                ) : (
                  // Click the name to edit — it's just a nickname, so no confirm gate.
                  <button
                    type="button"
                    onClick={() => { setEditingId(d.id); setDraft(d.name); }}
                    className="text-xs text-fg-2 hover:text-fg truncate text-left"
                    title="Click to rename this device"
                  >
                    {d.name}
                  </button>
                )}
                {d.self && <span className="text-3xs text-fg-muted shrink-0">(this device)</span>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-3xs text-fg-muted">{right}</span>
                {/* No Remove for self: upsertSelf re-creates this row on the next
                    launch, so offering it would read as a button that does nothing.
                    Hidden while confirming — the confirm block below replaces it. */}
                {!d.self && confirmingId !== d.id && (
                  <button
                    type="button"
                    onClick={() => { setConfirmingId(d.id); setRemoveNote(null); }}
                    aria-label={`Remove ${d.name}`}
                    className="text-3xs text-fg-muted hover:text-fg"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
            {/* Confirm block. The consequence lives HERE, at the point of decision —
                it used to be a title= tooltip on the trigger, which unmounts the
                moment this renders (and never shows on touch or to a screen reader). */}
            {confirmingId === d.id && (
              <div
                className={`mt-1.5 space-y-2 ${CARD_LEVEL_2} p-2.5`}
                onKeyDown={(e) => { if (e.key === 'Escape') setConfirmingId(null); }} // matches the rename input's Escape
              >
                <p className="text-2xs text-fg-dim leading-relaxed">
                  Remove {d.name}? It stops being listed here. If this device syncs again, it comes back.
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    type="button"
                    onClick={() => setConfirmingId(null)}
                    aria-label={`Keep ${d.name}`}
                    className="flex-1"
                  >
                    Cancel
                  </Button>
                  {/* autoFocus: the trigger just unmounted, so without this the focus
                      falls to <body> and a keyboard user re-tabs from the top.
                      danger-outline replaces the hand-rolled border-red-500/50 pair, so the
                      red comes from the theme's --destructive token rather than stock red
                      (spec decision 68 — "Remove" reads the same everywhere). */}
                  <Button
                    variant="danger-outline"
                    type="button"
                    autoFocus
                    onClick={() => void confirmRemove(d.id)}
                    aria-label={`Confirm removing ${d.name}`}
                    className="flex-1"
                  >
                    Remove
                  </Button>
                </div>
              </div>
            )}
            {/* Why the remove didn't take. Never invents a cause: the handler's own
                reason when it gave one, otherwise non-committal. */}
            {removeNote?.id === d.id && (
              <FieldError as="p" className="mt-1">{removeNote.text}</FieldError>
            )}
          </li>
        );
      })}
    </ul>
  );
}

