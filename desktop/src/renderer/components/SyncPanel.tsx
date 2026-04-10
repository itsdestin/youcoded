/**
 * SyncPanel.tsx — Sync Management UI for DestinCode.
 *
 * Control plane for the DestinClaude toolkit's sync system. Reads state files
 * written by sync.sh / session-start.sh and provides visual management:
 * backend status, force sync, warning resolution, config, and log viewer.
 *
 * Follows the same pattern as RemoteButton in SettingsPanel:
 * compact section row → createPortal popup modal.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import SettingsExplainer, { InfoIconButton, type ExplainerSection } from './SettingsExplainer';

// Plain-language explainer for the Sync popup. Shown when the user taps the
// (i) icon in the popup header — see SyncPopup's `showInfo` state.
const SYNC_EXPLAINER: { intro: string; sections: ExplainerSection[] } = {
  intro:
    "Sync saves your DestinClaude data — journal entries, encyclopedia, conversations, custom skills, and settings — to a cloud service. It's both a backup (so nothing is lost if your computer dies) and a way to pick up exactly where you left off on a different device.",
  sections: [
    {
      heading: 'What gets synced',
      paragraphs: [
        "Your journal, encyclopedia, conversations, custom skills, system config, plans, and specs — basically everything personal that DestinClaude stores in your hidden .claude folder.",
        'Your project code is NOT synced here — that\'s what GitHub is for. Sync is just for the personal AI stuff.',
      ],
    },
    {
      heading: 'Pick where to store it',
      bullets: [
        { term: 'Google Drive', text: 'The simplest option. Stores everything in a folder of your choice in your Google Drive account.' },
        { term: 'GitHub', text: "Stores it in a private GitHub repository. Best if you're comfortable with git and want full version history of every change." },
        { term: 'iCloud', text: 'For Mac users. Stores it in your iCloud Drive.' },
        { term: 'You can pick more than one', text: "They all sync at the same time, so if one breaks or you lose access, you still have the others as backups." },
      ],
    },
    {
      heading: 'What the buttons do',
      bullets: [
        { term: 'Sync Now', text: "Forces a sync right now instead of waiting for the next automatic one. Good after you've made a lot of changes." },
        { term: 'Configuration', text: 'Expand this to choose which backends are active and fill in their details (folder name, repo URL, etc).' },
        { term: 'Sync Log', text: 'Shows the last 30 sync attempts and any errors. Useful when something\'s not working and you want to know why.' },
        { term: 'Dismiss (on warnings)', text: 'Hides a warning. The underlying issue still exists — dismiss only if you understand and accept it.' },
      ],
    },
    {
      heading: 'Common issues',
      bullets: [
        { term: '"No Internet Connection"', text: 'Sync needs internet to talk to Google/GitHub/iCloud. Check your WiFi or cellular and try again.' },
        { term: '"No Sync Backend Configured"', text: "You haven't picked a place to store backups yet. Open Configuration and check at least one backend (Drive/GitHub/iCloud)." },
        { term: '"No Recent Sync (>24h)"', text: "It's been more than a day since your last successful sync. Tap Sync Now to catch up." },
        { term: '"Pull Failed on Last Start"', text: 'DestinCode tried to pull your latest data when it started but couldn\'t. Usually a temporary network blip — tap Sync Now and it should clear.' },
        { term: '"Unrouted Skills"', text: "Some custom skills aren't being saved anywhere. Open Configuration and make sure at least one backend is active." },
        { term: 'Sync seems stuck', text: 'Open Sync Log and look for ERROR or WARN lines — they usually tell you exactly what went wrong (wrong folder, missing permission, etc).' },
        { term: "Connected the wrong account", text: 'Just change the folder name or repo URL in Configuration and tap Save. The next sync uses the new location.' },
      ],
    },
  ],
};

// --- Types (mirror sync-state.ts) ---

interface SyncBackendInfo {
  name: 'drive' | 'github' | 'icloud';
  configured: boolean;
  detail: string;
}

interface SyncStatus {
  backends: SyncBackendInfo[];
  lastSyncEpoch: number | null;
  backupMeta: { last_backup: string; platform: string; toolkit_version: string } | null;
  warnings: string[];
  syncInProgress: boolean;
  syncedCategories: string[];
}

interface SyncConfig {
  PERSONAL_SYNC_BACKEND: string;
  DRIVE_ROOT: string;
  PERSONAL_SYNC_REPO: string;
  ICLOUD_PATH: string;
  SYNC_WIFI_ONLY?: string; // Android only — "true"/"false", defaults to "true"
}

// --- Warning display map (same codes as StatusBar + /sync skill) ---

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

const BACKEND_ICONS: Record<string, string> = {
  drive: '☁',
  github: '⌂',
  icloud: '⬡',
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

// --- Backend config field definitions ---

interface ConfigField {
  backend: string;
  key: keyof SyncConfig;
  label: string;
  placeholder: string;
}

const CONFIG_FIELDS: ConfigField[] = [
  { backend: 'drive', key: 'DRIVE_ROOT', label: 'Drive Root Folder', placeholder: 'Claude' },
  { backend: 'github', key: 'PERSONAL_SYNC_REPO', label: 'GitHub Repo URL', placeholder: 'https://github.com/user/claude-sync' },
  { backend: 'icloud', key: 'ICLOUD_PATH', label: 'iCloud Path', placeholder: 'Auto-detected' },
];

// --- Main exported component: compact section for SettingsPanel ---

interface SyncSectionProps {
  /** If true, auto-open the popup (used by StatusBar warning click) */
  autoOpen?: boolean;
  onAutoOpenHandled?: () => void;
}

export default function SyncSection({ autoOpen, onAutoOpenHandled }: SyncSectionProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const popupRef = useRef<HTMLDivElement>(null);

  // Load status when section mounts or popup opens
  const loadStatus = useCallback(async () => {
    try {
      const s = await (window as any).claude.sync.getStatus();
      setStatus(s);
    } catch {
      // sync API not available (no toolkit)
    }
    setLoading(false);
  }, []);

  // Fix: defer the initial sync status fetch until after the SettingsPanel
  // slide-in animation finishes. SyncSection mounts as part of the parent
  // panel and would otherwise block the main thread mid-transition.
  useEffect(() => {
    const timer = setTimeout(() => { loadStatus(); }, 350);
    return () => clearTimeout(timer);
  }, [loadStatus]);

  // Handle autoOpen from StatusBar warning click
  useEffect(() => {
    if (autoOpen && !open) {
      setOpen(true);
      onAutoOpenHandled?.();
    }
  }, [autoOpen, open, onAutoOpenHandled]);

  // Derive summary for compact row
  const configuredCount = status?.backends.filter(b => b.configured).length ?? 0;
  const warningCount = status?.warnings.length ?? 0;
  const lastSyncText = status?.lastSyncEpoch
    ? timeAgo(status.lastSyncEpoch)
    : 'Never';

  // Status dot color: green if synced recently, yellow if stale, gray if never/not configured
  const dotColor = !status || configuredCount === 0
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
        {/* Status dot */}
        <div className="flex items-center justify-center shrink-0" style={{ width: 32, height: 20 }}>
          <div className={`w-2.5 h-2.5 rounded-full ${dotColor}`} />
        </div>
        <div className="flex-1 min-w-0">
          <span className="text-xs text-fg font-medium">
            {loading ? 'Loading...' :
             configuredCount === 0 ? 'Not configured' :
             status?.syncInProgress ? 'Syncing...' :
             `Last synced ${lastSyncText}`}
          </span>
          {configuredCount > 0 && (
            <span className="text-[10px] text-fg-muted ml-2">
              {configuredCount} backend{configuredCount > 1 ? 's' : ''}
            </span>
          )}
        </div>
        {/* Warning badge */}
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

// --- Popup modal (full sync dashboard) ---

interface SyncPopupProps {
  popupRef: React.RefObject<HTMLDivElement | null>;
  initialStatus: SyncStatus | null;
  onClose: () => void;
  onRefresh: () => void;
}

function SyncPopup({ popupRef, initialStatus, onClose, onRefresh }: SyncPopupProps) {
  const [status, setStatus] = useState<SyncStatus | null>(initialStatus);
  const [config, setConfig] = useState<SyncConfig | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(!initialStatus);
  const [syncing, setSyncing] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [configDraft, setConfigDraft] = useState<Partial<SyncConfig>>({});
  const [configSaving, setConfigSaving] = useState(false);
  const [configSaved, setConfigSaved] = useState(false);
  // Flips the popup body to the plain-language explainer view via the (i) icon.
  const [showInfo, setShowInfo] = useState(false);

  const claude = (window as any).claude;

  // Load all data on mount
  useEffect(() => {
    (async () => {
      try {
        const [s, c, log] = await Promise.all([
          initialStatus ? Promise.resolve(initialStatus) : claude.sync.getStatus(),
          claude.sync.getConfig(),
          claude.sync.getLog(30),
        ]);
        setStatus(s);
        setConfig(c);
        setConfigDraft({});
        setLogLines(log);
      } catch {}
      setLoading(false);
    })();
  }, []);

  // Force sync handler
  const handleForceSync = useCallback(async () => {
    setSyncing(true);
    try {
      await claude.sync.force();
      // Refresh status after sync completes
      const s = await claude.sync.getStatus();
      setStatus(s);
      const log = await claude.sync.getLog(30);
      setLogLines(log);
      onRefresh();
    } catch {}
    setSyncing(false);
  }, [claude, onRefresh]);

  // Dismiss warning
  const handleDismiss = useCallback(async (warning: string) => {
    try {
      await claude.sync.dismissWarning(warning);
      // Remove from local state immediately
      setStatus(prev => prev ? { ...prev, warnings: prev.warnings.filter(w => w !== warning) } : prev);
    } catch {}
  }, [claude]);

  // Save config
  const handleSaveConfig = useCallback(async () => {
    if (!config || Object.keys(configDraft).length === 0) return;
    setConfigSaving(true);
    try {
      // Build the updated backends string from checkboxes
      const merged = { ...config, ...configDraft };
      const updated = await claude.sync.setConfig(merged);
      setConfig(updated);
      setConfigDraft({});
      // Refresh status to reflect new config
      const s = await claude.sync.getStatus();
      setStatus(s);
      setConfigSaved(true);
      setTimeout(() => setConfigSaved(false), 2000);
      onRefresh();
    } catch {}
    setConfigSaving(false);
  }, [claude, config, configDraft, onRefresh]);

  // Backend toggle handler
  const toggleBackend = useCallback((name: string, enabled: boolean) => {
    const currentBackends = (configDraft.PERSONAL_SYNC_BACKEND || config?.PERSONAL_SYNC_BACKEND || 'none')
      .split(',').map(b => b.trim()).filter(b => b && b !== 'none');
    let next: string[];
    if (enabled) {
      next = [...currentBackends, name];
    } else {
      next = currentBackends.filter(b => b !== name);
    }
    setConfigDraft(prev => ({
      ...prev,
      PERSONAL_SYNC_BACKEND: next.length > 0 ? next.join(',') : 'none',
    }));
  }, [config, configDraft]);

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

  // Derive active backends for config toggles
  const activeBackendStr = configDraft.PERSONAL_SYNC_BACKEND ?? config?.PERSONAL_SYNC_BACKEND ?? 'none';
  const activeBackends = activeBackendStr.split(',').map(b => b.trim()).filter(b => b && b !== 'none');

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-[60]" onClick={onClose} />
      <div
        ref={popupRef}
        className="fixed z-[61] rounded-xl bg-panel border border-edge shadow-2xl overflow-hidden"
        style={{
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(520px, 90vw)',
          height: 'min(640px, 85vh)',
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
        ) : (
        <div className="flex flex-col h-full">
          {/* Header — info icon (left of close) reveals the explainer view */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
            <h2 className="text-sm font-bold text-fg">Sync Management</h2>
            <div className="flex items-center gap-1">
              <InfoIconButton onClick={() => setShowInfo(true)} />
              <button onClick={onClose} className="text-fg-muted hover:text-fg-2 text-lg leading-none w-8 h-8 flex items-center justify-center rounded-sm hover:bg-inset">
                ✕
              </button>
            </div>
          </div>

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">

            {/* 1. Backend Status Cards */}
            <div>
              <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-2">Backends</h3>
              <div className="grid grid-cols-3 gap-2">
                {status?.backends.map(b => (
                  <div
                    key={b.name}
                    className={`rounded-lg border p-2.5 text-center ${
                      b.configured
                        ? 'border-green-500/30 bg-green-500/5'
                        : 'border-edge-dim bg-inset/30'
                    }`}
                  >
                    <div className="text-base mb-1">{BACKEND_ICONS[b.name]}</div>
                    <div className="text-[11px] font-medium text-fg">{BACKEND_LABELS[b.name]}</div>
                    <div className={`text-[9px] mt-0.5 ${b.configured ? 'text-green-400' : 'text-fg-faint'}`}>
                      {b.configured ? 'Connected' : 'Not configured'}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* 2. Last Sync + Force Sync */}
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
                    from {status.backupMeta.platform} · toolkit {status.backupMeta.toolkit_version}
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

            {/* 3. Active Warnings */}
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
                    <span
                      key={cat}
                      className="px-2 py-1 rounded-md bg-inset/60 border border-edge-dim text-[10px] text-fg-dim"
                    >
                      {CATEGORY_LABELS[cat] || cat}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* 5. Backend Configuration (collapsible) */}
            <div>
              <button
                onClick={() => setShowConfig(!showConfig)}
                className="flex items-center gap-1.5 text-[10px] font-medium text-fg-muted tracking-wider uppercase hover:text-fg-2 transition-colors"
              >
                <svg
                  className={`w-3 h-3 transition-transform ${showConfig ? 'rotate-90' : ''}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                Configuration
              </button>

              {showConfig && config && (
                <div className="mt-3 space-y-4 pl-1">
                  {/* Backend toggles */}
                  <div className="space-y-2">
                    <div className="text-[10px] text-fg-faint uppercase tracking-wider">Active Backends</div>
                    {(['drive', 'github', 'icloud'] as const).map(name => (
                      <label key={name} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={activeBackends.includes(name)}
                          onChange={(e) => toggleBackend(name, e.target.checked)}
                          className="rounded border-edge-dim accent-accent"
                        />
                        <span className="text-xs text-fg">{BACKEND_LABELS[name]}</span>
                      </label>
                    ))}
                  </div>

                  {/* Wi-Fi only toggle — Android only */}
                  {location.protocol === 'file:' && (
                    <div className="pt-1">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={(configDraft.SYNC_WIFI_ONLY ?? config?.SYNC_WIFI_ONLY ?? 'true') === 'true'}
                          onChange={(e) => setConfigDraft(prev => ({
                            ...prev,
                            SYNC_WIFI_ONLY: e.target.checked ? 'true' : 'false',
                          }))}
                          className="rounded border-edge-dim accent-accent"
                        />
                        <span className="text-xs text-fg">Sync only on Wi-Fi</span>
                      </label>
                      <div className="text-[10px] text-fg-faint mt-0.5 ml-5">
                        When off, sync runs on cellular data too
                      </div>
                    </div>
                  )}

                  {/* Config fields */}
                  {CONFIG_FIELDS.map(field => {
                    // Only show field if its backend is active
                    if (!activeBackends.includes(field.backend)) return null;
                    const currentValue = (configDraft as any)[field.key] ?? (config as any)[field.key] ?? '';
                    return (
                      <div key={field.key}>
                        <label className="block text-[10px] text-fg-muted mb-1">{field.label}</label>
                        <input
                          type="text"
                          value={currentValue}
                          onChange={(e) => setConfigDraft(prev => ({ ...prev, [field.key]: e.target.value }))}
                          placeholder={field.placeholder}
                          className="w-full px-2 py-1.5 rounded-md bg-inset border border-edge-dim text-xs text-fg placeholder-fg-faint focus:border-accent focus:outline-none"
                        />
                      </div>
                    );
                  })}

                  {/* Save button */}
                  {Object.keys(configDraft).length > 0 && (
                    <button
                      onClick={handleSaveConfig}
                      disabled={configSaving}
                      className={`px-4 py-1.5 rounded-md text-[11px] font-medium transition-colors ${
                        configSaved
                          ? 'bg-green-600/20 text-green-400'
                          : configSaving
                            ? 'bg-accent/20 text-accent/60 cursor-wait'
                            : 'bg-accent hover:bg-accent/80 text-on-accent cursor-pointer'
                      }`}
                    >
                      {configSaved ? 'Saved!' : configSaving ? 'Saving...' : 'Save Configuration'}
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* 6. Sync Log (collapsible) */}
            <div>
              <button
                onClick={async () => {
                  setShowLog(!showLog);
                  if (!showLog) {
                    // Refresh log when opening
                    try {
                      const log = await claude.sync.getLog(30);
                      setLogLines(log);
                    } catch {}
                  }
                }}
                className="flex items-center gap-1.5 text-[10px] font-medium text-fg-muted tracking-wider uppercase hover:text-fg-2 transition-colors"
              >
                <svg
                  className={`w-3 h-3 transition-transform ${showLog ? 'rotate-90' : ''}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                >
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
                          // Try to parse JSON log lines for colored display
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
                            // Plaintext fallback
                            return <div key={i} className="py-0.5">{line}</div>;
                          }
                        })}
                      </pre>
                    </div>
                  )}
                  <button
                    onClick={async () => {
                      try {
                        const log = await claude.sync.getLog(30);
                        setLogLines(log);
                      } catch {}
                    }}
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
                <div className="text-fg-faint text-[11px]">
                  Install the DestinClaude toolkit to enable sync.
                </div>
              </div>
            )}
          </div>
        </div>
        )}
      </div>
    </>
  );
}
