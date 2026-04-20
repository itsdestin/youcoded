/**
 * SyncPanel.tsx — Sync Management UI for YouCoded.
 *
 * V2 redesign: Supports multiple named backend instances with per-instance
 * sync/storage mode. Replaces the old 3-card grid with a dynamic instance
 * list, add-backend flow, per-backend overflow menu, and manual push/pull.
 *
 * Follows the same pattern as RemoteButton in SettingsPanel:
 * compact section row → createPortal popup modal.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { SyncWarning } from '../../main/sync-state';
import { createPortal } from 'react-dom';
import SettingsExplainer, { InfoIconButton, type ExplainerSection } from './SettingsExplainer';
import SyncSetupWizard from './SyncSetupWizard';
import { useScrollFade } from '../hooks/useScrollFade';
import { Scrim, OverlayPanel } from './overlays/Overlay';
import { RestoreWizard } from './restore/RestoreWizard';
import { SnapshotsPanel } from './restore/SnapshotsPanel';

// --- Explainer content (updated for V2 multi-instance model) ---

const SYNC_EXPLAINER: { intro: string; sections: ExplainerSection[] } = {
  intro:
    "Sync saves your YouCoded data — journal entries, encyclopedia, conversations, custom skills, and settings — to a cloud service. It's both a backup and a way to pick up where you left off on a different device.",
  sections: [
    {
      heading: 'What gets synced',
      paragraphs: [
        "Your journal, encyclopedia, conversations, custom skills, system config, plans, and specs — basically everything personal that YouCoded stores in your .claude folder.",
        'Your project code is NOT synced here — that\'s what GitHub is for.',
      ],
    },
    {
      heading: 'Pick where to store it',
      bullets: [
        { term: 'Google Drive', text: 'Stores everything in a Drive folder. You can connect multiple Google accounts (e.g. personal, work, school) — each one syncs independently.' },
        { term: 'GitHub', text: 'Stores it in a private repository. Best for version history of every change. One GitHub account at a time.' },
        { term: 'iCloud', text: 'Stores it in your iCloud Drive. Works on macOS and Windows (install iCloud for Windows). One iCloud location at a time.' },
        { term: 'Mixing backends', text: 'You can connect one GitHub and one iCloud plus as many Google Drive accounts as you want — all running in parallel.' },
      ],
    },
    {
      heading: 'Auto-sync vs Paused',
      bullets: [
        { term: 'Auto-sync (toggle ON)', text: 'Your data is backed up automatically after changes, every 15 minutes. This is the default.' },
        { term: 'Paused (toggle OFF)', text: 'Auto-backup is paused. The backend stays connected but nothing syncs automatically. Use "Upload now" or "Download now" to sync manually.' },
      ],
    },
    {
      heading: 'What the buttons do',
      bullets: [
        { term: 'Sync Now', text: 'Forces an immediate sync to all auto-sync backends.' },
        { term: 'Upload now', text: 'Pushes your local data to that specific backend right now.' },
        { term: 'Download now', text: 'Pulls the latest data from that backend to your device.' },
        { term: '+ Add backup', text: 'Connect a new cloud storage account.' },
        { term: 'The toggle switch', text: 'Turns automatic syncing on or off for that backend. Off = paused (manual only).' },
      ],
    },
    {
      heading: 'Common issues',
      bullets: [
        { term: '"No Internet Connection"', text: 'Check your WiFi or cellular and try again.' },
        { term: '"No Sync Backend Configured"', text: "You haven't added any backup destinations yet. Tap + Add backup." },
        { term: '"No Recent Sync (>24h)"', text: "It's been more than a day since your last sync. Tap Sync Now." },
        { term: 'Sync seems stuck', text: 'Open Sync Log and look for ERROR or WARN lines.' },
      ],
    },
  ],
};

// --- Types (mirror sync-state.ts V2 model) ---

interface BackendInstanceStatus {
  id: string;
  type: 'drive' | 'github' | 'icloud';
  label: string;
  syncEnabled: boolean;
  config: Record<string, string>;
  connected: boolean;
  lastPushEpoch: number | null;
  lastError: string | null;
}

interface SyncStatus {
  backends: BackendInstanceStatus[];
  lastSyncEpoch: number | null;
  backupMeta: { last_backup: string; platform: string; toolkit_version: string } | null;
  // Fix: was string[] — now matches getSyncStatus() which returns SyncWarning[].
  warnings: SyncWarning[];
  syncInProgress: boolean;
  syncingBackendId: string | null;
  syncedCategories: string[];
}

// --- Helpers ---

function timeAgo(epoch: number): string {
  const seconds = Math.floor(Date.now() / 1000 - epoch);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const BACKEND_LABELS: Record<string, string> = {
  drive: 'Google Drive',
  github: 'GitHub',
  icloud: 'iCloud',
};

// Backend type icon + tint color for the circle background
const BACKEND_STYLE: Record<string, { icon: string; tint: string }> = {
  drive: { icon: '\u2601', tint: 'bg-blue-500/10 text-blue-400' },
  github: { icon: '\u2302', tint: 'bg-purple-500/10 text-purple-400' },
  icloud: { icon: '\u2B21', tint: 'bg-sky-500/10 text-sky-400' },
};

const CATEGORY_LABELS: Record<string, string> = {
  memory: 'Memory',
  conversations: 'Conversations',
  encyclopedia: 'Encyclopedia',
  skills: 'Skills',
  'system-config': 'System Config',
  plans: 'Plans',
  specs: 'Specs',
};

// Hover descriptions — shown via title attribute on the badge spans
const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  memory: 'Your Claude memory files and preferences',
  conversations: 'Chat history and conversation logs',
  encyclopedia: 'Your personal encyclopedia entries',
  skills: 'Custom skills you\'ve created or installed',
  'system-config': 'App settings and preferences (not passwords or API keys)',
  plans: 'Implementation plans and design documents',
  specs: 'Technical specifications and reference docs',
};

// --- Config display fields per backend type (read-only in edit form) ---
const BACKEND_CONFIG_DISPLAY: Record<string, { key: string; label: string }[]> = {
  drive: [
    { key: 'DRIVE_ROOT', label: 'Drive Folder' },
    { key: 'rcloneRemote', label: 'Connected via' },
  ],
  github: [
    { key: 'PERSONAL_SYNC_REPO', label: 'Repository' },
  ],
  icloud: [
    { key: 'ICLOUD_PATH', label: 'iCloud Path' },
  ],
};

// --- Main exported component ---

interface SyncSectionProps {
  autoOpen?: boolean;
  onAutoOpenHandled?: () => void;
}

export default function SyncSection({ autoOpen, onAutoOpenHandled }: SyncSectionProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const popupRef = useRef<HTMLDivElement>(null);

  const loadStatus = useCallback(async () => {
    try {
      const s = await (window as any).claude.sync.getStatus();
      setStatus(s);
    } catch {}
    setLoading(false);
  }, []);

  // Defer initial fetch until after SettingsPanel slide-in animation
  useEffect(() => {
    const timer = setTimeout(() => { loadStatus(); }, 350);
    return () => clearTimeout(timer);
  }, [loadStatus]);

  // Keep the compact row fresh: patch sync fields from the 10s status:data push
  // so "Last synced X ago" doesn't freeze on the value captured at mount.
  // (Full status still comes from getSyncStatus — status:data only has the
  // live-updating fields: lastSyncEpoch, syncInProgress, backupMeta.)
  useEffect(() => {
    const handler = (window as any).claude?.on?.statusData?.((data: any) => {
      if (!data) return;
      setStatus(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          lastSyncEpoch: data.lastSyncEpoch ?? prev.lastSyncEpoch,
          syncInProgress: data.syncInProgress ?? prev.syncInProgress,
          backupMeta: data.backupMeta ?? prev.backupMeta,
        };
      });
    });
    return () => {
      if (handler) (window as any).claude?.off?.('status:data', handler);
    };
  }, []);

  useEffect(() => {
    if (autoOpen && !open) {
      setOpen(true);
      onAutoOpenHandled?.();
    }
  }, [autoOpen, open, onAutoOpenHandled]);

  // Derive summary for compact row
  const syncCount = status?.backends.filter(b => b.syncEnabled).length ?? 0;
  const storageCount = status?.backends.filter(b => !b.syncEnabled).length ?? 0;
  const warningCount = status?.warnings.length ?? 0;
  const lastSyncText = status?.lastSyncEpoch ? timeAgo(status.lastSyncEpoch) : 'Never';

  // Status dot: only considers sync-enabled backends
  const syncBackends = status?.backends.filter(b => b.syncEnabled) ?? [];
  const dotColor = !status || syncBackends.length === 0
    ? 'bg-fg-muted/40'
    : status.syncInProgress
      ? 'bg-blue-400 animate-pulse'
      : status.lastSyncEpoch && (Date.now() / 1000 - status.lastSyncEpoch) < 86400
        ? 'bg-green-500'
        : 'bg-yellow-500';

  return (
    <section>
      <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-3">Sync</h3>

      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-inset/50 hover:bg-inset transition-colors text-left"
      >
        <div className="flex items-center justify-center shrink-0" style={{ width: 32, height: 20 }}>
          <div className={`w-2.5 h-2.5 rounded-full ${dotColor}`} />
        </div>
        <div className="flex-1 min-w-0">
          <span className="text-xs text-fg font-medium">
            {loading ? 'Loading...' :
             (syncCount + storageCount) === 0 ? 'Not configured' :
             status?.syncInProgress ? 'Syncing...' :
             `Last synced ${lastSyncText}`}
          </span>
          {(syncCount + storageCount) > 0 && (
            <span className="text-[10px] text-fg-muted ml-2">
              {syncCount > 0 ? `${syncCount} synced` : ''}
              {syncCount > 0 && storageCount > 0 ? ' \u00B7 ' : ''}
              {storageCount > 0 ? `${storageCount} paused` : ''}
            </span>
          )}
        </div>
        {warningCount > 0 && (
          <span className="px-1.5 py-0.5 rounded-full bg-[#DD4444]/15 text-[#DD4444] text-[9px] font-medium shrink-0">
            {warningCount}
          </span>
        )}
        <svg className="w-3.5 h-3.5 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {open && createPortal(
        <SyncPopup
          popupRef={popupRef}
          initialStatus={status}
          onClose={() => setOpen(false)}
          onRefresh={loadStatus}
        />,
        document.body
      )}
    </section>
  );
}

// --- Popup modal ---

interface SyncPopupProps {
  popupRef: React.RefObject<HTMLDivElement | null>;
  initialStatus: SyncStatus | null;
  onClose: () => void;
  onRefresh: () => void;
}

function SyncPopup({ popupRef, initialStatus, onClose, onRefresh }: SyncPopupProps) {
  const [status, setStatus] = useState<SyncStatus | null>(initialStatus);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(!initialStatus);
  const [syncing, setSyncing] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  // View stack: 'main' | 'add-type' | 'add-config' | 'edit'
  const [view, setView] = useState<'main' | 'add-type' | 'add-config' | 'edit'>('main');
  const [addType, setAddType] = useState<'drive' | 'github' | 'icloud' | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Overflow menu state
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const mainScrollRef = useScrollFade<HTMLDivElement>();
  const logScrollRef = useScrollFade<HTMLDivElement>();
  // Per-backend action feedback
  const [actionFeedback, setActionFeedback] = useState<Record<string, string>>({});
  // Confirmation dialog state
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [confirmPullId, setConfirmPullId] = useState<string | null>(null);
  // Restore flow: stash the backend the user picked so RestoreWizard can open.
  const [restoreTarget, setRestoreTarget] = useState<{ id: string; label: string; type: 'drive' | 'github' | 'icloud' } | null>(null);
  const [showSnapshots, setShowSnapshots] = useState(false);

  const claude = (window as any).claude;

  useEffect(() => {
    (async () => {
      try {
        const [s, log] = await Promise.all([
          claude.sync.getStatus(),
          claude.sync.getLog(30),
        ]);
        setStatus(s);
        setLogLines(log);
      } catch {}
      setLoading(false);
    })();
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await claude.sync.getStatus();
      setStatus(s);
      onRefresh();
    } catch {}
  }, [claude, onRefresh]);

  // While the popup is open, patch live-updating fields from the 10s status:data
  // push AND refetch full status when the global marker advances so per-backend
  // lastPushEpoch values stay in sync with the compact header.
  // Ref-tracked epoch avoids scheduling refreshStatus from inside a setState
  // updater (which is a React anti-pattern and was unreliable).
  const lastSeenEpochRef = useRef<number | null>(initialStatus?.lastSyncEpoch ?? null);
  useEffect(() => {
    const handler = (window as any).claude?.on?.statusData?.((data: any) => {
      if (!data) return;
      const epoch = typeof data.lastSyncEpoch === 'number' ? data.lastSyncEpoch : null;
      const advanced = epoch !== null && epoch !== lastSeenEpochRef.current;
      if (advanced) {
        lastSeenEpochRef.current = epoch;
        // Fire-and-forget — refetches full status including per-backend markers
        refreshStatus();
      } else {
        // Same cycle: just patch the cheap fields so timeAgo() re-renders tick forward
        setStatus(prev =>
          prev
            ? {
                ...prev,
                lastSyncEpoch: epoch ?? prev.lastSyncEpoch,
                syncInProgress: data.syncInProgress ?? prev.syncInProgress,
                backupMeta: data.backupMeta ?? prev.backupMeta,
              }
            : prev,
        );
      }
    });
    return () => {
      if (handler) (window as any).claude?.off?.('status:data', handler);
    };
  }, [refreshStatus]);

  // Force sync all sync-enabled backends
  const handleForceSync = useCallback(async () => {
    setSyncing(true);
    try {
      await claude.sync.force();
      await refreshStatus();
      const log = await claude.sync.getLog(30);
      setLogLines(log);
    } catch {}
    setSyncing(false);
  }, [claude, refreshStatus]);

  const handleDismiss = useCallback(async (code: string) => {
    try {
      await claude.sync.dismissWarning(code);
      // Fix: filter by w.code now that warnings are SyncWarning objects, not strings.
      setStatus(prev => prev ? { ...prev, warnings: prev.warnings.filter(w => w.code !== code) } : prev);
    } catch {}
  }, [claude]);

  // Per-backend actions
  const handlePushBackend = useCallback(async (id: string) => {
    setActionFeedback(prev => ({ ...prev, [id]: 'uploading' }));
    try {
      const result = await claude.sync.pushBackend(id);
      setActionFeedback(prev => ({ ...prev, [id]: result.success ? 'uploaded' : 'error' }));
      await refreshStatus();
    } catch {
      setActionFeedback(prev => ({ ...prev, [id]: 'error' }));
    }
    setTimeout(() => setActionFeedback(prev => { const n = { ...prev }; delete n[id]; return n; }), 2000);
  }, [claude, refreshStatus]);

  const handlePullBackend = useCallback(async (id: string) => {
    setActionFeedback(prev => ({ ...prev, [id]: 'downloading' }));
    try {
      const result = await claude.sync.pullBackend(id);
      setActionFeedback(prev => ({ ...prev, [id]: result.success ? 'downloaded' : 'error' }));
      await refreshStatus();
    } catch {
      setActionFeedback(prev => ({ ...prev, [id]: 'error' }));
    }
    setTimeout(() => setActionFeedback(prev => { const n = { ...prev }; delete n[id]; return n; }), 2000);
  }, [claude, refreshStatus]);

  const handleToggleSync = useCallback(async (id: string, syncEnabled: boolean) => {
    try {
      await claude.sync.updateBackend(id, { syncEnabled });
      await refreshStatus();
    } catch {}
  }, [claude, refreshStatus]);

  const handleRemoveBackend = useCallback(async (id: string) => {
    try {
      await claude.sync.removeBackend(id);
      await refreshStatus();
    } catch {}
    setMenuOpenId(null);
  }, [claude, refreshStatus]);

  // Wizard preselect: when a warning fix-action opens the wizard for a specific backend,
  // we stash the backend id+type here so SyncSetupWizard jumps straight to the right flow.
  const [wizardPreselect, setWizardPreselect] = useState<{ id: string; type: 'drive' | 'github' | 'icloud' } | undefined>();

  const handleFixAction = useCallback(async (w: SyncWarning) => {
    const action = w.fixAction;
    if (!action) return;
    switch (action.kind) {
      case 'open-sync-setup': {
        const backendId = action.payload?.backendId;
        if (backendId) {
          const backend = status?.backends.find(b => b.id === backendId);
          if (backend) {
            setWizardPreselect({ id: backend.id, type: backend.type });
          }
        }
        setView('add-config');
        break;
      }
      case 'open-external':
        await (window as any).claude.shell.openExternal(action.payload.url);
        break;
      case 'retry': {
        setActionFeedback(prev => ({ ...prev, [action.payload.backendId]: 'uploading' }));
        try {
          await claude.sync.pushBackend(action.payload.backendId);
          setActionFeedback(prev => ({ ...prev, [action.payload.backendId]: 'uploaded' }));
        } catch {
          setActionFeedback(prev => ({ ...prev, [action.payload.backendId]: 'error' }));
        }
        await refreshStatus();
        break;
      }
      case 'dismiss':
        await handleDismiss(w.code);
        break;
    }
  }, [status, claude, refreshStatus, handleDismiss]);

  // Close overflow menu on outside click
  useEffect(() => {
    if (!menuOpenId) return;
    const handler = () => setMenuOpenId(null);
    const timer = setTimeout(() => document.addEventListener('click', handler), 0);
    return () => { clearTimeout(timer); document.removeEventListener('click', handler); };
  }, [menuOpenId]);

  if (loading) {
    // Overlay layer L2 — theme-driven via Scrim/OverlayPanel (matches SettingsPanel popups).
    return (
      <>
        <Scrim layer={2} onClick={onClose} />
        <OverlayPanel
          layer={2}
          className="fixed overflow-hidden"
          style={{ top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: 'min(520px, 90vw)', height: 'min(640px, 85vh)' }}
        >
          <div className="flex items-center justify-center h-full text-fg-muted text-sm">Loading...</div>
        </OverlayPanel>
      </>
    );
  }

  return (
    // Overlay layer L2 — theme-driven via Scrim/OverlayPanel (matches SettingsPanel popups).
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        ref={popupRef}
        layer={2}
        className="fixed overflow-hidden"
        style={{
          top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          width: 'min(520px, 90vw)', height: 'min(640px, 85vh)',
        }}
      >
        {showInfo ? (
          <SettingsExplainer
            title="Sync"
            intro={SYNC_EXPLAINER.intro}
            sections={SYNC_EXPLAINER.sections}
            onBack={() => setShowInfo(false)}
            onClose={onClose}
          />
        ) : (view === 'add-type' || view === 'add-config') ? (
          // Guided setup wizard handles type selection, prereq check, OAuth, and config
          <SyncSetupWizard
            initialType={addType ?? undefined}
            existingBackends={(status?.backends ?? []).map(b => ({ type: b.type, config: b.config }))}
            onComplete={async (instance) => {
              try {
                await claude.sync.addBackend(instance);
                // Trigger first sync immediately
                await claude.sync.force();
                await refreshStatus();
              } catch {}
            }}
            onClose={() => { setView('main'); setAddType(null); setWizardPreselect(undefined); }}
            preselectedBackendId={wizardPreselect?.id}
            preselectedBackendType={wizardPreselect?.type}
          />
        ) : view === 'edit' && editingId ? (
          <EditBackendForm
            backend={status?.backends.find(b => b.id === editingId) ?? null}
            onSave={async (updates) => {
              try {
                await claude.sync.updateBackend(editingId, updates);
                await refreshStatus();
              } catch {}
              setView('main');
              setEditingId(null);
            }}
            onBack={() => { setView('main'); setEditingId(null); }}
            onClose={onClose}
          />
        ) : (
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
            <h2 className="text-sm font-bold text-fg">Sync Management</h2>
            <div className="flex items-center gap-1">
              <InfoIconButton onClick={() => setShowInfo(true)} />
              <button onClick={onClose} className="text-fg-muted hover:text-fg-2 text-lg leading-none w-8 h-8 flex items-center justify-center rounded-sm hover:bg-inset">
                {'\u2715'}
              </button>
            </div>
          </div>

          {/* Scrollable content */}
          <div ref={mainScrollRef} className="scroll-fade flex-1 px-4 py-4 space-y-5">

            {/* 1. Backend instances list */}
            <div>
              <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-2">Your Backups</h3>

              {status && status.backends.length > 0 ? (
                <div className="space-y-2">
                  {(() => {
                    // Fix: warnings are now SyncWarning objects, not strings — check by .code.
                    const isOffline = status.warnings.some(w => w.code === 'OFFLINE');
                    return status.backends.map(b => {
                  // Pending = sync-enabled backend that can't currently push (offline or errored)
                  const isPending = b.syncEnabled && (b.lastError != null || isOffline);
                  return (
                    <div
                      key={b.id}
                      className={`rounded-lg border px-3 py-2.5 flex items-center gap-3 ${
                        b.lastError ? 'border-red-500/20 bg-red-500/5' :
                        b.syncEnabled && b.connected ? 'border-green-500/20 bg-green-500/5' :
                        'border-edge bg-inset/30'
                      }`}
                    >
                      {/* Type icon */}
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm shrink-0 ${BACKEND_STYLE[b.type]?.tint ?? ''}`}>
                        {BACKEND_STYLE[b.type]?.icon ?? '?'}
                      </div>

                      {/* Name + detail */}
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-fg font-medium truncate">{b.label}</div>
                        <div className="text-[10px] text-fg-faint truncate">
                          {b.lastError ? b.lastError :
                           b.lastPushEpoch ? `Synced ${timeAgo(b.lastPushEpoch)}` :
                           !b.syncEnabled ? 'Auto-backup paused' :
                           'Never synced'}
                        </div>
                        {/* Pending changes badge — only when sync is on but blocked */}
                        {isPending && !actionFeedback[b.id] && (
                          <span className="text-[9px] font-medium text-amber-400">Changes pending upload</span>
                        )}
                        {/* Action feedback badge */}
                        {actionFeedback[b.id] && (
                          <span className={`text-[9px] font-medium ${
                            actionFeedback[b.id] === 'error' ? 'text-red-400' :
                            actionFeedback[b.id]?.includes('ing') ? 'text-blue-400' :
                            'text-green-400'
                          }`}>
                            {actionFeedback[b.id] === 'uploading' ? 'Uploading...' :
                             actionFeedback[b.id] === 'downloading' ? 'Downloading...' :
                             actionFeedback[b.id] === 'uploaded' ? 'Uploaded!' :
                             actionFeedback[b.id] === 'downloaded' ? 'Downloaded!' :
                             'Error'}
                          </span>
                        )}
                      </div>

                      {/* Status dot — color derived from scoped warnings for this backend. */}
                      {(() => {
                        const scoped = status.warnings.filter(w => w.backendId === b.id);
                        const hasDanger = scoped.some(w => w.level === 'danger');
                        const hasWarn = scoped.some(w => w.level === 'warn');
                        const dotClass =
                          hasDanger ? 'bg-red-500'
                          : hasWarn ? 'bg-amber-500'
                          : actionFeedback[b.id]?.includes('ing') ? 'bg-blue-400 animate-pulse'
                          : b.syncEnabled && b.connected && b.lastPushEpoch && (Date.now() / 1000 - b.lastPushEpoch) < 86400 ? 'bg-green-500'
                          : b.syncEnabled && b.connected ? 'bg-yellow-500'
                          : 'bg-fg-muted/40';
                        return <div className={`w-2 h-2 rounded-full shrink-0 ${dotClass}`} />;
                      })()}

                      {/* Sync toggle — green when auto-sync, gray when storage-only */}
                      <button
                        onClick={() => handleToggleSync(b.id, !b.syncEnabled)}
                        className={`relative w-8 h-4 rounded-full transition-colors shrink-0 ${
                          b.syncEnabled ? 'bg-green-600' : 'bg-inset'
                        }`}
                        title={b.syncEnabled ? 'Auto-backup on \u2014 click to pause' : 'Auto-backup paused \u2014 click to resume'}
                      >
                        <div className="absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-all"
                          style={{ left: b.syncEnabled ? '18px' : '2px' }} />
                      </button>

                      {/* Overflow menu (three-dot) */}
                      <div className="relative shrink-0">
                        <button
                          onClick={(e) => { e.stopPropagation(); setMenuOpenId(menuOpenId === b.id ? null : b.id); }}
                          className="w-6 h-6 flex items-center justify-center rounded hover:bg-inset text-fg-muted hover:text-fg-2 text-xs"
                        >
                          {'\u00B7\u00B7\u00B7'}
                        </button>
                        {menuOpenId === b.id && (
                          /* Overflow menu — .layer-surface for theme-consistent look + glass. */
                          <div className="layer-surface absolute right-0 top-7 w-40 py-1"
                            style={{ zIndex: 10 }}
                            onClick={(e) => e.stopPropagation()}>
                            <MenuButton onClick={() => { handlePushBackend(b.id); setMenuOpenId(null); }}>Upload now</MenuButton>
                            <MenuButton onClick={() => { setConfirmPullId(b.id); setMenuOpenId(null); }}>Download now</MenuButton>
                            <MenuButton onClick={() => { setRestoreTarget({ id: b.id, label: b.label, type: b.type }); setMenuOpenId(null); }}>Restore from backup...</MenuButton>
                            <MenuButton onClick={() => { claude.sync.openFolder(b.id); setMenuOpenId(null); }}>Open folder</MenuButton>
                            <MenuButton onClick={() => { setEditingId(b.id); setView('edit'); setMenuOpenId(null); }}>Edit settings</MenuButton>
                            <div className="border-t border-edge-dim my-1" />
                            <MenuButton danger onClick={() => { setConfirmRemoveId(b.id); setMenuOpenId(null); }}>Remove</MenuButton>
                          </div>
                        )}
                      </div>
                    </div>
                  ); }); })()}
                </div>
              ) : (
                <div className="text-center py-6">
                  <div className="text-fg-muted text-sm mb-1">No backup destinations</div>
                  <div className="text-fg-faint text-[11px] mb-3">Add one to start protecting your data.</div>
                </div>
              )}

              {/* Add backend button */}
              <button
                onClick={() => setView('add-type')}
                className="w-full mt-2 border border-dashed border-edge-dim rounded-lg py-3 text-center text-[11px] text-fg-muted hover:text-fg-2 hover:border-edge hover:bg-inset/30 transition-colors"
              >
                + Add backup
              </button>

              {/* Restore snapshots expander — lists pre-restore backups users can undo.
                  Collapsed by default; only surfaces when at least one backend exists
                  (snapshots are pointless without a backend). */}
              {(status?.backends?.length ?? 0) > 0 && (
                <div className="mt-2">
                  <button
                    onClick={() => setShowSnapshots(v => !v)}
                    className="w-full text-left px-3 py-2 rounded-md text-[11px] text-fg-muted hover:text-fg-2 hover:bg-inset/30"
                  >
                    {showSnapshots ? '▾' : '▸'} Restore snapshots
                  </button>
                  {showSnapshots && (
                    <div className="mt-1 px-1">
                      <SnapshotsPanel />
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 2. Sync Now bar */}
            <div className="flex items-center justify-between px-3 py-2.5 rounded-lg bg-inset/50">
              <div>
                <div className="text-xs text-fg font-medium">
                  {status?.syncInProgress || syncing
                    ? 'Syncing...'
                    : status?.lastSyncEpoch
                      ? `Last synced ${timeAgo(status.lastSyncEpoch)}`
                      : 'Never synced'}
                </div>
                {status?.backupMeta?.platform && (
                  <div className="text-[10px] text-fg-faint mt-0.5">
                    from {status.backupMeta.platform} {'\u00B7'} toolkit {status.backupMeta.toolkit_version}
                  </div>
                )}
              </div>
              <button
                onClick={handleForceSync}
                disabled={syncing}
                className={`px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors ${
                  syncing
                    ? 'bg-blue-500/20 text-blue-300 cursor-wait'
                    : 'bg-blue-600 hover:bg-blue-500 text-white cursor-pointer'
                }`}
              >
                {syncing ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-3 border-2 border-blue-300/30 border-t-blue-300 rounded-full animate-spin" />
                    Syncing
                  </span>
                ) : 'Sync Now'}
              </button>
            </div>

            {/* 3. Warnings — typed SyncWarning objects with title/body/fix-action/stderr */}
            {status && status.warnings.length > 0 && (
              <div>
                <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-2">Warnings</h3>
                <div className="space-y-2">
                  {status.warnings.map((w) => (
                    <div
                      key={`${w.code}:${w.backendId ?? ''}`}
                      className={`rounded-lg border px-3 py-2 ${
                        w.level === 'danger'
                          ? 'border-red-500/30 bg-red-500/5'
                          : 'border-amber-500/30 bg-amber-500/5'
                      }`}
                    >
                      <div className="text-xs font-medium text-fg">{w.title}</div>
                      <div className="text-[11px] text-fg-muted mt-0.5">{w.body}</div>
                      {/* Collapsible stderr for UNKNOWN-code warnings where raw output helps diagnose */}
                      {w.code === 'UNKNOWN' && w.stderr && (
                        <details className="mt-1">
                          <summary className="text-[10px] text-fg-faint cursor-pointer">
                            Show error details
                          </summary>
                          <pre className="mt-1 p-2 bg-inset rounded text-[10px] whitespace-pre-wrap font-mono">
                            {w.stderr}
                          </pre>
                        </details>
                      )}
                      <div className="flex gap-2 mt-2">
                        {w.fixAction && (
                          <button
                            onClick={() => handleFixAction(w)}
                            className="text-[11px] px-2 py-0.5 rounded bg-accent text-on-accent hover:brightness-110"
                          >
                            {w.fixAction.label}
                          </button>
                        )}
                        {w.dismissible && (
                          <button
                            onClick={() => handleDismiss(w.code)}
                            className="text-[11px] px-2 py-0.5 rounded border border-edge-dim text-fg-muted hover:bg-inset"
                          >
                            Dismiss
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 4. Synced Data Categories */}
            {status && status.syncedCategories.length > 0 && (
              <div>
                <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-2">Synced Data</h3>
                <div className="flex flex-wrap gap-1.5">
                  {status.syncedCategories.map(cat => (
                    <span
                      key={cat}
                      title={CATEGORY_DESCRIPTIONS[cat] || ''}
                      className="px-2 py-1 rounded-md bg-inset/60 border border-edge-dim text-[10px] text-fg-dim cursor-help"
                    >
                      {CATEGORY_LABELS[cat] || cat}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* 5. Sync Log (collapsible) */}
            <div>
              <button
                onClick={async () => {
                  setShowLog(!showLog);
                  if (!showLog) {
                    try { const log = await claude.sync.getLog(30); setLogLines(log); } catch {}
                  }
                }}
                className="flex items-center gap-1.5 text-[10px] font-medium text-fg-muted tracking-wider uppercase hover:text-fg-2 transition-colors"
              >
                <svg className={`w-3 h-3 transition-transform ${showLog ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                Sync Log
              </button>

              {showLog && (
                <div className="mt-2">
                  {logLines.length === 0 ? (
                    <div className="text-[11px] text-fg-faint px-2 py-3">No sync log entries yet.</div>
                  ) : (
                    <div ref={logScrollRef} className="scroll-fade max-h-48 rounded-lg bg-inset/40 border border-edge-dim">
                      <pre className="text-[10px] text-fg-dim font-mono px-2 py-2 whitespace-pre-wrap break-all leading-relaxed">
                        {logLines.map((line, i) => {
                          try {
                            const entry = JSON.parse(line);
                            const levelColor = entry.level === 'ERROR' ? 'text-[#DD4444]'
                              : entry.level === 'WARN' ? 'text-[#FF9800]'
                              : 'text-fg-dim';
                            return (
                              <div key={i} className="py-0.5">
                                <span className="text-fg-faint">{entry.ts?.slice(11) || ''} </span>
                                <span className={levelColor}>[{entry.level}]</span>{' '}
                                <span className="text-fg-dim">{entry.msg}</span>
                              </div>
                            );
                          } catch {
                            return <div key={i} className="py-0.5">{line}</div>;
                          }
                        })}
                      </pre>
                    </div>
                  )}
                  <button
                    onClick={async () => { try { setLogLines(await claude.sync.getLog(30)); } catch {} }}
                    className="mt-1.5 text-[10px] text-fg-muted hover:text-fg-2 transition-colors"
                  >
                    Refresh
                  </button>
                </div>
              )}
            </div>

            {/* Empty state when no toolkit */}
            {!status && !loading && (
              <div className="text-center py-6">
                <div className="text-fg-muted text-sm mb-1">No Sync Data</div>
                <div className="text-fg-faint text-[11px]">Install the YouCoded toolkit to enable sync.</div>
              </div>
            )}
          </div>
        </div>
        )}
      </OverlayPanel>

      {/* Restore-from-backup wizard — own modal layer so it overlays the sync popup.
          Refreshes sync status on close so lastPush/lastError reflect the restore. */}
      {restoreTarget && (
        <RestoreWizard
          backendId={restoreTarget.id}
          backendLabel={restoreTarget.label}
          backendType={restoreTarget.type}
          onClose={() => { setRestoreTarget(null); refreshStatus(); }}
        />
      )}

      {/* Confirmation dialog: Remove backend */}
      {confirmRemoveId && (() => {
        const target = status?.backends.find(b => b.id === confirmRemoveId);
        return target ? (
          <ConfirmDialog
            title="Remove backup?"
            message={<>Remove <strong>{target.label}</strong>? This disconnects this backup destination. Your backed-up data in {BACKEND_LABELS[target.type]} won't be deleted &mdash; you can reconnect later.</>}
            confirmLabel="Remove"
            confirmColor="red"
            onConfirm={() => { handleRemoveBackend(confirmRemoveId); setConfirmRemoveId(null); }}
            onCancel={() => setConfirmRemoveId(null)}
          />
        ) : null;
      })()}

      {/* Confirmation dialog: Download from backend */}
      {confirmPullId && (() => {
        const target = status?.backends.find(b => b.id === confirmPullId);
        return target ? (
          <ConfirmDialog
            title="Download from backup?"
            message={<>Download from <strong>{target.label}</strong>? This will update your local data with the version stored in {BACKEND_LABELS[target.type]}. Your conversations won&apos;t be overwritten, but your settings and config will be replaced with the backed-up version.</>}
            confirmLabel="Download"
            confirmColor="blue"
            onConfirm={() => { handlePullBackend(confirmPullId); setConfirmPullId(null); }}
            onCancel={() => setConfirmPullId(null)}
          />
        ) : null;
      })()}
    </>
  );
}

// --- Confirmation dialog (reusable) ---
// L3 destructive confirmation — uses OverlayPanel destructive variant for theme-driven danger border.

function ConfirmDialog({
  title, message, confirmLabel, confirmColor, onConfirm, onCancel,
}: {
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  confirmColor: 'red' | 'blue';
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const borderColor = confirmColor === 'red' ? 'border-red-600/30' : 'border-blue-600/30';
  const headerBg = confirmColor === 'red' ? 'bg-red-600/10' : 'bg-blue-600/10';
  const headerText = confirmColor === 'red' ? 'text-[#DD4444]' : 'text-blue-400';
  const btnBg = confirmColor === 'red'
    ? 'bg-red-600/70 hover:bg-red-600/90 text-white'
    : 'bg-blue-600 hover:bg-blue-500 text-white';

  return createPortal(
    // Overlay layer L3 — destructive confirmations use OverlayPanel destructive variant.
    <>
      <Scrim layer={3} onClick={onCancel} />
      <OverlayPanel
        layer={3}
        destructive={confirmColor === 'red'}
        className="fixed overflow-hidden"
        style={{ top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: 'min(360px, 85vw)' }}
      >
        <div className={`px-4 py-3 border-b ${borderColor} ${headerBg}`}>
          <h3 className={`text-xs font-bold ${headerText}`}>{title}</h3>
        </div>
        <div className="px-4 py-3 space-y-3">
          <p className="text-[11px] text-fg-dim leading-relaxed">{message}</p>
          <div className="flex gap-2 pt-1">
            <button
              onClick={onCancel}
              className="flex-1 px-3 py-1.5 text-[11px] font-medium rounded-md bg-inset hover:bg-edge text-fg-muted transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              className={`flex-1 px-3 py-1.5 text-[11px] font-medium rounded-md transition-colors ${btnBg}`}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </OverlayPanel>
    </>,
    document.body,
  );
}

// --- Overflow menu button ---

function MenuButton({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-1.5 text-[11px] transition-colors ${
        danger ? 'text-red-400 hover:bg-red-500/10' : 'text-fg hover:bg-inset'
      }`}
    >
      {children}
    </button>
  );
}

// --- Sub-view header (shared by add/edit flows) ---

function SubViewHeader({ title, onBack, onClose }: { title: string; onBack: () => void; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="text-fg-muted hover:text-fg-2 w-6 h-6 flex items-center justify-center rounded hover:bg-inset">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h2 className="text-sm font-bold text-fg">{title}</h2>
      </div>
      <button onClick={onClose} className="text-fg-muted hover:text-fg-2 text-lg leading-none w-8 h-8 flex items-center justify-center rounded-sm hover:bg-inset">
        {'\u2715'}
      </button>
    </div>
  );
}

// (AddBackendTypePicker and AddBackendConfigForm removed — replaced by SyncSetupWizard)

// --- Edit backend settings ---

function EditBackendForm({
  backend, onSave, onBack, onClose,
}: {
  backend: BackendInstanceStatus | null;
  onSave: (updates: { label?: string }) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(backend?.label ?? '');
  const [saving, setSaving] = useState(false);
  const actionsScrollRef = useScrollFade<HTMLDivElement>();

  if (!backend) return null;

  const displayFields = BACKEND_CONFIG_DISPLAY[backend.type] || [];

  const handleSave = async () => {
    setSaving(true);
    // Only the label is editable — config changes require remove + re-add
    await onSave({ label: label.trim() });
    setSaving(false);
  };

  return (
    <div className="flex flex-col h-full">
      <SubViewHeader title={`Edit ${backend.label}`} onBack={onBack} onClose={onClose} />
      <div ref={actionsScrollRef} className="scroll-fade flex-1 px-4 py-4 space-y-4">
        <div>
          <label className="block text-[10px] text-fg-muted mb-1">Name</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="w-full px-2 py-1.5 rounded-md bg-inset border border-edge-dim text-xs text-fg focus:border-accent focus:outline-none"
          />
        </div>

        {/* Config fields are read-only — prevents users from breaking rclone remotes or repo URLs */}
        {displayFields.map(field => (
          <div key={field.key}>
            <div className="text-[10px] text-fg-muted mb-1">{field.label}</div>
            <div className="px-2 py-1.5 rounded-md bg-inset/30 border border-edge-dim text-xs text-fg-dim">
              {backend.config[field.key] || '(not set)'}
            </div>
          </div>
        ))}
        <div className="text-[10px] text-fg-faint">
          To change these settings, remove this backup and add a new one.
        </div>

        <button
          onClick={handleSave}
          disabled={!label.trim() || saving}
          className={`px-4 py-1.5 rounded-md text-[11px] font-medium transition-colors ${
            saving ? 'bg-accent/20 text-accent/60 cursor-wait' : 'bg-accent hover:bg-accent/80 text-on-accent cursor-pointer'
          }`}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}
