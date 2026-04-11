/**
 * SyncPanel.tsx — Sync Management UI for DestinCode.
 *
 * V2 redesign: Supports multiple named backend instances with per-instance
 * sync/storage mode. Replaces the old 3-card grid with a dynamic instance
 * list, add-backend flow, per-backend overflow menu, and manual push/pull.
 *
 * Follows the same pattern as RemoteButton in SettingsPanel:
 * compact section row → createPortal popup modal.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import SettingsExplainer, { InfoIconButton, type ExplainerSection } from './SettingsExplainer';
import SyncSetupWizard from './SyncSetupWizard';

// --- Explainer content (updated for V2 multi-instance model) ---

const SYNC_EXPLAINER: { intro: string; sections: ExplainerSection[] } = {
  intro:
    "Sync saves your DestinClaude data — journal entries, encyclopedia, conversations, custom skills, and settings — to a cloud service. It's both a backup and a way to pick up where you left off on a different device.",
  sections: [
    {
      heading: 'What gets synced',
      paragraphs: [
        "Your journal, encyclopedia, conversations, custom skills, system config, plans, and specs — basically everything personal that DestinClaude stores in your .claude folder.",
        'Your project code is NOT synced here — that\'s what GitHub is for.',
      ],
    },
    {
      heading: 'Pick where to store it',
      bullets: [
        { term: 'Google Drive', text: 'Stores everything in a Drive folder. You can connect multiple Drive accounts (personal, work, etc).' },
        { term: 'GitHub', text: 'Stores it in a private repository. Best for version history of every change.' },
        { term: 'iCloud', text: 'For Mac users. Stores it in your iCloud Drive.' },
        { term: 'Multiple backends', text: "You can connect as many as you want, even multiple of the same type. They all sync independently." },
      ],
    },
    {
      heading: 'Auto-sync vs Storage only',
      bullets: [
        { term: 'Auto-sync (toggle ON)', text: 'Your data is backed up automatically after changes, every 15 minutes. This is the default.' },
        { term: 'Storage only (toggle OFF)', text: 'The backend stays connected but nothing syncs automatically. Use "Upload now" or "Download now" to sync manually.' },
      ],
    },
    {
      heading: 'What the buttons do',
      bullets: [
        { term: 'Sync Now', text: 'Forces an immediate sync to all auto-sync backends.' },
        { term: 'Upload now', text: 'Pushes your local data to that specific backend right now.' },
        { term: 'Download now', text: 'Pulls the latest data from that backend to your device.' },
        { term: '+ Add backup', text: 'Connect a new cloud storage account.' },
        { term: 'The toggle switch', text: 'Turns automatic syncing on or off for that backend. Off = storage only.' },
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
  warnings: string[];
  syncInProgress: boolean;
  syncingBackendId: string | null;
  syncedCategories: string[];
}

// --- Warning display map ---

const WARNING_DISPLAY: Record<string, { text: string; level: 'danger' | 'warn' }> = {
  'OFFLINE': { text: 'No Internet Connection', level: 'danger' },
  'PERSONAL:NOT_CONFIGURED': { text: 'No Sync Backend Configured', level: 'danger' },
  'PERSONAL:STALE': { text: 'No Recent Sync (>24h)', level: 'warn' },
};

function getWarningDisplay(code: string): { text: string; level: 'danger' | 'warn' } {
  if (WARNING_DISPLAY[code]) return WARNING_DISPLAY[code];
  if (code.startsWith('SKILLS:')) return { text: 'Unrouted Skills', level: 'danger' };
  if (code.startsWith('PROJECTS:')) return { text: 'Unsynced Projects', level: 'danger' };
  if (code.startsWith('PERSONAL:PULL_FAILED')) return { text: 'Pull Failed on Last Start', level: 'warn' };
  if (code.startsWith('GIT:')) return { text: code.replace('GIT:', 'Git: '), level: 'warn' };
  if (code.startsWith('MIGRATION:')) return { text: 'Migration Issue', level: 'warn' };
  return { text: code, level: 'warn' };
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

// --- Config fields per backend type ---
const BACKEND_CONFIG_FIELDS: Record<string, { key: string; label: string; placeholder: string }[]> = {
  drive: [
    { key: 'DRIVE_ROOT', label: 'Drive Root Folder', placeholder: 'Claude' },
    { key: 'rcloneRemote', label: 'Rclone Remote Name', placeholder: 'gdrive' },
  ],
  github: [
    { key: 'PERSONAL_SYNC_REPO', label: 'GitHub Repo URL', placeholder: 'https://github.com/user/claude-sync' },
  ],
  icloud: [
    { key: 'ICLOUD_PATH', label: 'iCloud Path', placeholder: 'Auto-detected' },
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
              {storageCount > 0 ? `${storageCount} storage` : ''}
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
  // Per-backend action feedback
  const [actionFeedback, setActionFeedback] = useState<Record<string, string>>({});

  const claude = (window as any).claude;

  useEffect(() => {
    (async () => {
      try {
        const [s, log] = await Promise.all([
          initialStatus ? Promise.resolve(initialStatus) : claude.sync.getStatus(),
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

  const handleDismiss = useCallback(async (warning: string) => {
    try {
      await claude.sync.dismissWarning(warning);
      setStatus(prev => prev ? { ...prev, warnings: prev.warnings.filter(w => w !== warning) } : prev);
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

  // Close overflow menu on outside click
  useEffect(() => {
    if (!menuOpenId) return;
    const handler = () => setMenuOpenId(null);
    const timer = setTimeout(() => document.addEventListener('click', handler), 0);
    return () => { clearTimeout(timer); document.removeEventListener('click', handler); };
  }, [menuOpenId]);

  if (loading) {
    return (
      <>
        <div className="fixed inset-0 bg-black/30 z-[60]" onClick={onClose} />
        <div className="fixed z-[61] rounded-xl bg-panel border border-edge shadow-2xl"
          style={{ top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: 'min(520px, 90vw)', height: 'min(640px, 85vh)' }}>
          <div className="flex items-center justify-center h-full text-fg-muted text-sm">Loading...</div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-[60]" onClick={onClose} />
      <div
        ref={popupRef}
        className="fixed z-[61] rounded-xl bg-panel border border-edge shadow-2xl overflow-hidden"
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
            existingCounts={{
              drive: (status?.backends ?? []).filter(b => b.type === 'drive').length,
              github: (status?.backends ?? []).filter(b => b.type === 'github').length,
              icloud: (status?.backends ?? []).filter(b => b.type === 'icloud').length,
            }}
            onComplete={async (instance) => {
              try {
                await claude.sync.addBackend(instance);
                // Trigger first sync immediately
                await claude.sync.force();
                await refreshStatus();
              } catch {}
            }}
            onClose={() => { setView('main'); setAddType(null); }}
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
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">

            {/* 1. Backend instances list */}
            <div>
              <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-2">Your Backups</h3>

              {status && status.backends.length > 0 ? (
                <div className="space-y-2">
                  {status.backends.map(b => (
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
                           !b.syncEnabled ? 'Storage only' :
                           'Never synced'}
                        </div>
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

                      {/* Status dot */}
                      <div className={`w-2 h-2 rounded-full shrink-0 ${
                        b.lastError ? 'bg-red-500' :
                        actionFeedback[b.id]?.includes('ing') ? 'bg-blue-400 animate-pulse' :
                        b.syncEnabled && b.connected && b.lastPushEpoch && (Date.now() / 1000 - b.lastPushEpoch) < 86400 ? 'bg-green-500' :
                        b.syncEnabled && b.connected ? 'bg-yellow-500' :
                        'bg-fg-muted/40'
                      }`} />

                      {/* Sync toggle — green when auto-sync, gray when storage-only */}
                      <button
                        onClick={() => handleToggleSync(b.id, !b.syncEnabled)}
                        className={`relative w-8 h-4 rounded-full transition-colors shrink-0 ${
                          b.syncEnabled ? 'bg-green-600' : 'bg-inset'
                        }`}
                        title={b.syncEnabled ? 'Auto-sync on \u2014 click to switch to storage only' : 'Storage only \u2014 click to enable auto-sync'}
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
                          <div className="absolute right-0 top-7 w-40 bg-panel border border-edge rounded-lg shadow-xl z-10 py-1"
                            onClick={(e) => e.stopPropagation()}>
                            <MenuButton onClick={() => { handlePushBackend(b.id); setMenuOpenId(null); }}>Upload now</MenuButton>
                            <MenuButton onClick={() => { handlePullBackend(b.id); setMenuOpenId(null); }}>Download now</MenuButton>
                            <MenuButton onClick={() => { claude.sync.openFolder(b.id); setMenuOpenId(null); }}>Open folder</MenuButton>
                            <MenuButton onClick={() => { setEditingId(b.id); setView('edit'); setMenuOpenId(null); }}>Edit settings</MenuButton>
                            <div className="border-t border-edge-dim my-1" />
                            <MenuButton danger onClick={() => handleRemoveBackend(b.id)}>Remove</MenuButton>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
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

            {/* 3. Warnings */}
            {status && status.warnings.length > 0 && (
              <div>
                <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-2">Warnings</h3>
                <div className="space-y-1.5">
                  {status.warnings.map((w, i) => {
                    const display = getWarningDisplay(w);
                    return (
                      <div
                        key={i}
                        className={`flex items-center justify-between px-3 py-2 rounded-lg border ${
                          display.level === 'danger'
                            ? 'bg-[#DD4444]/8 border-[#DD4444]/20'
                            : 'bg-[#FF9800]/8 border-[#FF9800]/20'
                        }`}
                      >
                        <span className={`text-[11px] font-medium ${
                          display.level === 'danger' ? 'text-[#DD4444]' : 'text-[#FF9800]'
                        }`}>
                          {display.text}
                        </span>
                        <button
                          onClick={() => handleDismiss(w)}
                          className="text-[10px] text-fg-muted hover:text-fg-2 px-2 py-0.5 rounded hover:bg-inset transition-colors"
                        >
                          Dismiss
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 4. Synced Data Categories */}
            {status && status.syncedCategories.length > 0 && (
              <div>
                <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-2">Synced Data</h3>
                <div className="flex flex-wrap gap-1.5">
                  {status.syncedCategories.map(cat => (
                    <span key={cat} className="px-2 py-1 rounded-md bg-inset/60 border border-edge-dim text-[10px] text-fg-dim">
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
                    <div className="max-h-48 overflow-y-auto rounded-lg bg-inset/40 border border-edge-dim">
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
                <div className="text-fg-faint text-[11px]">Install the DestinClaude toolkit to enable sync.</div>
              </div>
            )}
          </div>
        </div>
        )}
      </div>
    </>
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

// --- Add backend: Step 1 — Pick type ---

function AddBackendTypePicker({
  backends, onSelect, onBack, onClose,
}: {
  backends: BackendInstanceStatus[];
  onSelect: (type: 'drive' | 'github' | 'icloud') => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const types: { type: 'drive' | 'github' | 'icloud'; desc: string }[] = [
    { type: 'drive', desc: 'Store your data in a Google Drive folder.' },
    { type: 'github', desc: 'Store your data in a private GitHub repository.' },
    { type: 'icloud', desc: 'Store your data in iCloud Drive (Mac/Windows).' },
  ];

  return (
    <div className="flex flex-col h-full">
      <SubViewHeader title="Add a Backup Destination" onBack={onBack} onClose={onClose} />
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {types.map(({ type, desc }) => {
          const existing = backends.filter(b => b.type === type).length;
          return (
            <button
              key={type}
              onClick={() => onSelect(type)}
              className="w-full rounded-lg border border-edge-dim bg-inset/30 p-4 flex items-center gap-3 hover:bg-inset/50 cursor-pointer text-left transition-colors"
            >
              <div className={`w-10 h-10 rounded-full flex items-center justify-center text-lg shrink-0 ${BACKEND_STYLE[type]?.tint ?? ''}`}>
                {BACKEND_STYLE[type]?.icon ?? '?'}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs text-fg font-medium">{BACKEND_LABELS[type]}</div>
                <div className="text-[10px] text-fg-faint mt-0.5">{desc}</div>
                {existing > 0 && (
                  <div className="text-[9px] text-fg-muted mt-1">({existing} already connected)</div>
                )}
              </div>
              <svg className="w-3.5 h-3.5 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// --- Add backend: Step 2 — Configure ---

function AddBackendConfigForm({
  type, onAdd, onBack, onClose,
}: {
  type: 'drive' | 'github' | 'icloud';
  onAdd: (instance: { type: string; label: string; syncEnabled: boolean; config: Record<string, string> }) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState('');
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const fields = BACKEND_CONFIG_FIELDS[type] || [];

  const handleConnect = async () => {
    if (!label.trim()) return;
    setSaving(true);
    await onAdd({ type, label: label.trim(), syncEnabled, config: configValues });
    setSaving(false);
  };

  return (
    <div className="flex flex-col h-full">
      <SubViewHeader title={`Set Up ${BACKEND_LABELS[type]}`} onBack={onBack} onClose={onClose} />
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* Name */}
        <div>
          <label className="block text-[10px] text-fg-muted mb-1">What do you want to call this?</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={`e.g., Personal ${BACKEND_LABELS[type]}, Work Backup`}
            className="w-full px-2 py-1.5 rounded-md bg-inset border border-edge-dim text-xs text-fg placeholder-fg-faint focus:border-accent focus:outline-none"
            autoFocus
          />
        </div>

        {/* Type-specific config fields */}
        {fields.map(field => (
          <div key={field.key}>
            <label className="block text-[10px] text-fg-muted mb-1">{field.label}</label>
            <input
              type="text"
              value={configValues[field.key] || ''}
              onChange={(e) => setConfigValues(prev => ({ ...prev, [field.key]: e.target.value }))}
              placeholder={field.placeholder}
              className="w-full px-2 py-1.5 rounded-md bg-inset border border-edge-dim text-xs text-fg placeholder-fg-faint focus:border-accent focus:outline-none"
            />
          </div>
        ))}

        {/* Auto-sync toggle */}
        <div className="pt-1">
          <label className="flex items-center gap-2 cursor-pointer">
            <button
              onClick={() => setSyncEnabled(!syncEnabled)}
              className={`relative w-8 h-4 rounded-full transition-colors shrink-0 ${syncEnabled ? 'bg-green-600' : 'bg-inset'}`}
            >
              <div className="absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-all"
                style={{ left: syncEnabled ? '18px' : '2px' }} />
            </button>
            <span className="text-xs text-fg">Automatically sync changes</span>
          </label>
          <div className="text-[10px] text-fg-faint mt-0.5 ml-10">
            When on, your data is backed up automatically. Turn off to only sync manually.
          </div>
        </div>

        {/* Connect button */}
        <button
          onClick={handleConnect}
          disabled={!label.trim() || saving}
          className={`px-4 py-2 rounded-md text-[11px] font-medium transition-colors ${
            !label.trim() || saving
              ? 'bg-accent/20 text-accent/40 cursor-not-allowed'
              : 'bg-accent hover:bg-accent/80 text-on-accent cursor-pointer'
          }`}
        >
          {saving ? 'Connecting...' : 'Connect'}
        </button>
      </div>
    </div>
  );
}

// --- Edit backend settings ---

function EditBackendForm({
  backend, onSave, onBack, onClose,
}: {
  backend: BackendInstanceStatus | null;
  onSave: (updates: { label?: string; config?: Record<string, string> }) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(backend?.label ?? '');
  const [configValues, setConfigValues] = useState<Record<string, string>>(backend?.config ?? {});
  const [saving, setSaving] = useState(false);

  if (!backend) return null;

  const fields = BACKEND_CONFIG_FIELDS[backend.type] || [];

  const handleSave = async () => {
    setSaving(true);
    await onSave({ label: label.trim(), config: configValues });
    setSaving(false);
  };

  return (
    <div className="flex flex-col h-full">
      <SubViewHeader title={`Edit ${backend.label}`} onBack={onBack} onClose={onClose} />
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        <div>
          <label className="block text-[10px] text-fg-muted mb-1">Name</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="w-full px-2 py-1.5 rounded-md bg-inset border border-edge-dim text-xs text-fg focus:border-accent focus:outline-none"
          />
        </div>

        {fields.map(field => (
          <div key={field.key}>
            <label className="block text-[10px] text-fg-muted mb-1">{field.label}</label>
            <input
              type="text"
              value={configValues[field.key] || ''}
              onChange={(e) => setConfigValues(prev => ({ ...prev, [field.key]: e.target.value }))}
              placeholder={field.placeholder}
              className="w-full px-2 py-1.5 rounded-md bg-inset border border-edge-dim text-xs text-fg placeholder-fg-faint focus:border-accent focus:outline-none"
            />
          </div>
        ))}

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
