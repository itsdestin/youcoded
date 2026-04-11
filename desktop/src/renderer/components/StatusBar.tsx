import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from '../state/theme-context';
import type { PermissionMode } from '../../shared/types';

// --- Session stats shape (written by statusline.sh to .session-stats-{id}.json) ---

interface SessionStats {
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  contextTokens: number | null;
  duration: number | null;
  apiDuration: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  commits: number | null;
  pullRequests: number | null;
  toolsAccepted: number | null;
  toolsRejected: number | null;
}

interface StatusData {
  usage: {
    five_hour?: { utilization: number; resets_at: string };
    seven_day?: { utilization: number; resets_at: string };
  } | null;
  updateStatus: {
    current: string;
    latest: string;
    update_available: boolean;
    download_url: string | null;
  } | null;
  contextPercent: number | null;
  gitBranch: string | null;
  sessionStats: SessionStats | null;
  syncStatus: string | null;
  syncWarnings: string | null;
}

const MODELS = ['haiku', 'sonnet', 'opus[1m]'] as const;
type ModelAlias = typeof MODELS[number];

const MODEL_DISPLAY: Record<ModelAlias, { label: string; color: string; bg: string; border: string }> = {
  sonnet:      { label: 'Sonnet',   color: '#9CA3AF', bg: 'rgba(156,163,175,0.15)', border: 'rgba(156,163,175,0.25)' },
  'opus[1m]':  { label: 'Opus 1M',  color: '#818CF8', bg: 'rgba(129,140,248,0.15)', border: 'rgba(129,140,248,0.25)' },
  haiku:       { label: 'Haiku',    color: '#2DD4BF', bg: 'rgba(45,212,191,0.15)',  border: 'rgba(45,212,191,0.25)' },
};

const PERMISSION_DISPLAY: Record<PermissionMode, { label: string; shortLabel: string; color: string; bg: string; border: string }> = {
  normal:        { label: 'NORMAL',             shortLabel: 'NORMAL',  color: 'var(--fg-muted)', bg: 'var(--inset)',  border: 'var(--edge-dim)' },
  'auto-accept': { label: 'ACCEPT CHANGES',     shortLabel: 'ACCEPT',  color: 'var(--accent)',   bg: 'var(--well)',   border: 'var(--edge)' },
  plan:          { label: 'PLAN MODE',           shortLabel: 'PLAN',    color: 'var(--fg-2)',     bg: 'var(--inset)',  border: 'var(--edge)' },
  bypass:        { label: 'BYPASS PERMISSIONS',  shortLabel: 'BYPASS',  color: '#FA8072', bg: 'rgba(250,128,114,0.15)', border: 'rgba(250,128,114,0.25)' },
};

function utilizationColor(pct: number): string {
  if (pct >= 80) return 'text-[#DD4444]';
  if (pct >= 50) return 'text-[#FF9800]';
  return 'text-[#4CAF50]';
}

function contextColor(pct: number): string {
  if (pct < 20) return 'text-[#DD4444]';
  if (pct < 50) return 'text-[#FF9800]';
  return 'text-[#4CAF50]';
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatTime12(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, '0')}${ampm}`;
}

function format5hReset(iso: string): string {
  try {
    const d = new Date(iso);
    return `Resets @ ${formatTime12(d)}`;
  } catch {
    return '';
  }
}

function format7dReset(iso: string): string {
  try {
    const d = new Date(iso);
    return `Resets ${DAYS[d.getDay()]} @ ${formatTime12(d)}`;
  } catch {
    return '';
  }
}

/** Format token count as human-readable (e.g. 1234 -> "1.2k", 1234567 -> "1.2M") */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

/** Format seconds as human-readable duration (e.g. 125 -> "2m 5s", 3700 -> "1h 1m") */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

interface Props {
  statusData: StatusData;
  onRunSync?: () => void;
  onOpenSync?: () => void;
  model?: ModelAlias;
  onCycleModel?: () => void;
  permissionMode?: PermissionMode;
  onCyclePermission?: () => void;
}

// Map raw warning codes to the same descriptive text used in the terminal statusline
const WARNING_MAP: Record<string, { text: string; level: 'danger' | 'warn' }> = {
  'OFFLINE': { text: 'DANGER: No Internet Connection', level: 'danger' },
  'PERSONAL:NOT_CONFIGURED': { text: 'DANGER: No Sync Act. for Personal Data', level: 'danger' },
  'PERSONAL:STALE': { text: 'WARN: No Recent Personal Sync (>24h)', level: 'warn' },
};

function parseSyncWarnings(raw: string | null): { text: string; level: 'danger' | 'warn' }[] {
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((line) => {
    // Check for exact match first
    if (WARNING_MAP[line]) return WARNING_MAP[line];
    // Prefix match for SKILLS:* and PROJECTS:*
    if (line.startsWith('SKILLS:')) return { text: 'DANGER: Unsynced Skills', level: 'danger' as const };
    if (line.startsWith('PROJECTS:')) return { text: 'DANGER: Projects Excluded From Sync', level: 'danger' as const };
    // Fallback: pass through raw text
    if (line.startsWith('DANGER:') || line.startsWith('OFFLINE')) {
      return { text: line, level: 'danger' as const };
    }
    return { text: line, level: 'warn' as const };
  });
}

const warnStyles = {
  danger: 'bg-[#DD4444]/15 text-[#DD4444] border-[#DD4444]/25',
  warn: 'bg-[#FF9800]/15 text-[#FF9800] border-[#FF9800]/25',
};

// --- Widget visibility system ---

type WidgetId =
  | 'usage-5h' | 'usage-7d' | 'context' | 'git-branch' | 'sync-warnings' | 'theme' | 'version'
  | 'session-cost' | 'tokens-in' | 'tokens-out' | 'cache-stats' | 'code-changes' | 'session-time';

// Widget categories and definitions with info tooltips
// defaultVisible: true = shown for new installs, false = opt-in only
interface WidgetDef {
  id: WidgetId;
  label: string;
  defaultVisible: boolean;
  description: string;  // Shown in (i) tooltip in config popup
  bestFor: string;      // Who benefits most from this widget
}

interface WidgetCategory {
  name: string;
  widgets: WidgetDef[];
}

const WIDGET_CATEGORIES: WidgetCategory[] = [
  {
    name: 'Rate Limits',
    widgets: [
      {
        id: 'usage-5h',
        label: '5h Usage',
        defaultVisible: true,
        description: 'Shows how much of your 5-hour rate limit you\'ve used. Resets on a rolling window.',
        bestFor: 'Everyone. Helps you pace usage and avoid hitting rate limits during heavy sessions.',
      },
      {
        id: 'usage-7d',
        label: '7d Usage',
        defaultVisible: true,
        description: 'Shows how much of your 7-day rate limit you\'ve used. Resets on a rolling window.',
        bestFor: 'Everyone. Track your weekly usage pattern so you don\'t run out mid-week.',
      },
    ],
  },
  {
    name: 'Session',
    widgets: [
      {
        id: 'context',
        label: 'Context %',
        defaultVisible: true,
        description: 'How much of Claude\'s conversation memory remains. Lower means Claude may forget earlier context.',
        bestFor: 'Everyone. When this drops below 20%, consider starting a new session to avoid lost context.',
      },
      {
        id: 'session-cost',
        label: 'Session Cost',
        defaultVisible: false,
        description: 'Estimated cost of this session in USD. For Pro/Max subscribers this is informational only (you\'re not billed per-token).',
        bestFor: 'API users tracking spend. Also useful for Pro/Max users curious about what their session would cost on the API.',
      },
      {
        id: 'session-time',
        label: 'Session Duration',
        defaultVisible: false,
        description: 'Total session time and how much of it Claude spent thinking (API time). Helps you understand your workflow pace.',
        bestFor: 'Power users who want to see how much of a session is active Claude work vs your own thinking/typing time.',
      },
    ],
  },
  {
    name: 'Tokens',
    widgets: [
      {
        id: 'tokens-in',
        label: 'Input Tokens',
        defaultVisible: false,
        description: 'Cumulative input tokens sent to Claude this session. Includes your messages, files, and system context.',
        bestFor: 'Power users monitoring how much context is being sent. Helpful for optimizing large-file workflows.',
      },
      {
        id: 'tokens-out',
        label: 'Output Tokens',
        defaultVisible: false,
        description: 'Cumulative output tokens Claude has generated this session. Higher means more verbose responses.',
        bestFor: 'Users who want to understand how much Claude is writing. Useful for gauging response verbosity.',
      },
      {
        id: 'cache-stats',
        label: 'Cache Efficiency',
        defaultVisible: false,
        description: 'Tokens read from the prompt cache vs created. Higher cached reads mean faster, cheaper requests.',
        bestFor: 'API users and power users. Shows how effectively prompt caching is working in your conversation.',
      },
    ],
  },
  {
    name: 'Code',
    widgets: [
      {
        id: 'code-changes',
        label: 'Code Changes',
        defaultVisible: false,
        description: 'Lines of code added and removed this session. A quick productivity snapshot.',
        bestFor: 'Developers using Claude for coding tasks. See at a glance how much code Claude has written.',
      },
      {
        id: 'git-branch',
        label: 'Git Branch',
        defaultVisible: true,
        description: 'The current git repository and branch for your working directory.',
        bestFor: 'Developers working across multiple branches or repos.',
      },
    ],
  },
  {
    name: 'App',
    widgets: [
      {
        id: 'sync-warnings',
        label: 'Sync Warnings',
        defaultVisible: true,
        description: 'Alerts when sync isn\'t working (no internet, stale data, unsynced skills).',
        bestFor: 'DestinClaude toolkit users. Keeps you aware of sync issues that could cause data loss.',
      },
      {
        id: 'theme',
        label: 'Theme',
        defaultVisible: true,
        description: 'Shows the active theme. Click to cycle through your configured themes.',
        bestFor: 'Anyone who uses multiple themes or wants quick access to theme switching.',
      },
      {
        id: 'version',
        label: 'Version',
        defaultVisible: true,
        description: 'Current DestinCode version. Glows when an update is available.',
        bestFor: 'Everyone. Stay up to date with the latest features and fixes.',
      },
    ],
  },
];

// Flat list for iteration
const ALL_WIDGET_DEFS = WIDGET_CATEGORIES.flatMap((c) => c.widgets);
const DEFAULT_VISIBLE = new Set<WidgetId>(ALL_WIDGET_DEFS.filter((w) => w.defaultVisible).map((w) => w.id));

const STORAGE_KEY = 'destincode-statusbar-widgets';

function loadVisibility(): Set<WidgetId> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const arr = JSON.parse(stored) as WidgetId[];
      // Only keep IDs that still exist in our definitions
      return new Set(arr.filter((id) => ALL_WIDGET_DEFS.some((w) => w.id === id)));
    }
  } catch { /* ignore */ }
  // Fresh install — use defaultVisible flags, not ALL
  return new Set(DEFAULT_VISIBLE);
}

function saveVisibility(visible: Set<WidgetId>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...visible]));
  } catch { /* ignore */ }
}

function useWidgetVisibility() {
  const [visible, setVisible] = useState<Set<WidgetId>>(loadVisibility);

  const toggle = useCallback((id: WidgetId) => {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveVisibility(next);
      return next;
    });
  }, []);

  return { visible, toggle };
}

// --- Icons ---

// Pencil SVG icon (inline to avoid extra dependencies)
function PencilIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M12.146.854a.5.5 0 0 1 .708 0l2.292 2.292a.5.5 0 0 1 0 .708l-9.5 9.5a.5.5 0 0 1-.168.11l-4 1.5a.5.5 0 0 1-.638-.638l1.5-4a.5.5 0 0 1 .11-.168l9.5-9.5zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5z"/>
    </svg>
  );
}

// Info (i) icon for widget descriptions
function InfoIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
      <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
    </svg>
  );
}

// --- Config Popup ---
// Centered modal (matches SettingsPanel popup style) for customizing status bar widgets

function WidgetConfigPopup({ open, onClose, visible, toggle }: {
  open: boolean;
  onClose: () => void;
  visible: Set<WidgetId>;
  toggle: (id: WidgetId) => void;
}) {
  // Track which widget's (i) tooltip is expanded
  const [expandedInfo, setExpandedInfo] = useState<WidgetId | null>(null);

  if (!open) return null;

  return createPortal(
    <>
      <div className="fixed inset-0 bg-black/30 z-[60]" onClick={onClose} />
      <div
        className="fixed z-[61] rounded-xl bg-panel border border-edge shadow-2xl overflow-hidden"
        style={{
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(420px, 90vw)',
          maxHeight: '80vh',
        }}
      >
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
            <h2 className="text-sm font-bold text-fg">Status Bar Widgets</h2>
            <button
              onClick={onClose}
              className="text-fg-muted hover:text-fg-2 text-lg leading-none w-7 h-7 flex items-center justify-center rounded-sm hover:bg-inset"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Scrollable widget list grouped by category */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
            {WIDGET_CATEGORIES.map((cat) => (
              <section key={cat.name}>
                <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-2">
                  {cat.name}
                </h3>
                <div className="space-y-0.5">
                  {cat.widgets.map((w) => {
                    const isExpanded = expandedInfo === w.id;
                    return (
                      <div key={w.id}>
                        <div className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-inset transition-colors">
                          {/* Toggle checkbox */}
                          <button
                            onClick={() => toggle(w.id)}
                            className="flex items-center gap-2 flex-1 text-left"
                          >
                            <span
                              className={`w-3.5 h-3.5 rounded-sm border flex-shrink-0 flex items-center justify-center transition-colors ${
                                visible.has(w.id)
                                  ? 'bg-accent border-accent text-on-accent'
                                  : 'border-edge-dim'
                              }`}
                            >
                              {visible.has(w.id) && (
                                <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor">
                                  <path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z" />
                                </svg>
                              )}
                            </span>
                            <span className="text-[11px] text-fg">{w.label}</span>
                          </button>

                          {/* (i) info toggle */}
                          <button
                            onClick={() => setExpandedInfo(isExpanded ? null : w.id)}
                            className={`flex-shrink-0 p-0.5 rounded-sm transition-colors ${
                              isExpanded ? 'text-accent' : 'text-fg-faint hover:text-fg-muted'
                            }`}
                            title="More info"
                          >
                            <InfoIcon />
                          </button>
                        </div>

                        {/* Expanded info panel */}
                        {isExpanded && (
                          <div className="ml-7 mr-2 mb-1.5 px-2.5 py-2 rounded-md bg-inset border border-edge-dim text-[10px] space-y-1.5">
                            <p className="text-fg-dim leading-relaxed">{w.description}</p>
                            <p className="text-fg-faint leading-relaxed">
                              <span className="font-medium text-fg-muted">Best for:</span> {w.bestFor}
                            </p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}

// --- Main StatusBar component ---

export default function StatusBar({ statusData, onRunSync, onOpenSync, model, onCycleModel, permissionMode, onCyclePermission }: Props) {
  const { usage, updateStatus, contextPercent, gitBranch, sessionStats, syncStatus, syncWarnings } = statusData;
  const warnings = parseSyncWarnings(syncWarnings);
  const { activeTheme, cycleTheme } = useTheme();
  const { visible, toggle } = useWidgetVisibility();
  const [popupOpen, setPopupOpen] = useState(false);

  const show = (id: WidgetId) => visible.has(id);
  const ss = sessionStats; // shorthand

  return (
    <div className="status-bar flex flex-wrap items-center gap-x-2 gap-y-1 px-2 sm:px-3 py-1 text-[10px] text-fg-muted border-t border-edge-dim">
      {/* Model selector chip — always first */}
      {model && (
        <button
          onClick={onCycleModel}
          className="px-1.5 py-0.5 rounded-sm border cursor-pointer hover:brightness-125 transition-colors"
          style={{
            backgroundColor: MODEL_DISPLAY[model].bg,
            color: MODEL_DISPLAY[model].color,
            borderColor: MODEL_DISPLAY[model].border,
          }}
          title={`Model: ${MODEL_DISPLAY[model].label} (click to cycle)`}
        >
          {MODEL_DISPLAY[model].label}
        </button>
      )}

      {/* Permission mode chip — always second */}
      {permissionMode && (
        <button
          onClick={onCyclePermission}
          className="px-1.5 py-0.5 rounded-sm border cursor-pointer hover:brightness-125 transition-colors"
          style={{
            backgroundColor: PERMISSION_DISPLAY[permissionMode].bg,
            color: PERMISSION_DISPLAY[permissionMode].color,
            borderColor: PERMISSION_DISPLAY[permissionMode].border,
          }}
          title="Click to cycle permission mode (Shift+Tab)"
        >
          <span className="sm:hidden">{PERMISSION_DISPLAY[permissionMode].shortLabel}</span>
          <span className="hidden sm:inline">{PERMISSION_DISPLAY[permissionMode].label}</span>
        </button>
      )}

      {/* Rate limits */}
      {show('usage-5h') && usage?.five_hour != null && (
        <button
          onClick={() => window.claude.shell.openExternal('https://claude.ai/settings/usage')}
          className="flex items-center gap-1 sm:gap-1.5 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim cursor-pointer hover:bg-inset transition-colors"
          title="View usage on claude.ai"
        >
          <span>5h:</span>
          <span className={utilizationColor(usage.five_hour.utilization)}>
            {usage.five_hour.utilization}%
          </span>
          <span className="text-fg-faint hidden sm:inline">{format5hReset(usage.five_hour.resets_at)}</span>
        </button>
      )}
      {show('usage-7d') && usage?.seven_day != null && (
        <button
          onClick={() => window.claude.shell.openExternal('https://claude.ai/settings/usage')}
          className="flex items-center gap-1 sm:gap-1.5 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim cursor-pointer hover:bg-inset transition-colors"
          title="View usage on claude.ai"
        >
          <span>7d:</span>
          <span className={utilizationColor(usage.seven_day.utilization)}>
            {usage.seven_day.utilization}%
          </span>
          <span className="text-fg-faint hidden sm:inline">{format7dReset(usage.seven_day.resets_at)}</span>
        </button>
      )}

      {/* Context remaining */}
      {show('context') && contextPercent != null && (
        <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim">
          <span>Context:</span>
          <span className={contextColor(contextPercent)}>
            {contextPercent}%
          </span>
          <span>Remaining</span>
        </span>
      )}

      {/* Session cost — estimated USD cost for this session */}
      {show('session-cost') && ss?.costUsd != null && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
          title="Estimated session cost (informational for Pro/Max subscribers)"
        >
          <span>Cost:</span>
          <span className="text-fg-2">${ss.costUsd < 0.01 ? '<0.01' : ss.costUsd.toFixed(2)}</span>
        </span>
      )}

      {/* Session duration — wall time and API thinking time */}
      {show('session-time') && ss?.duration != null && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
          title={ss.apiDuration != null ? `Wall: ${formatDuration(ss.duration)} | API: ${formatDuration(ss.apiDuration)}` : `Session duration: ${formatDuration(ss.duration)}`}
        >
          <span>{formatDuration(ss.duration)}</span>
          {ss.apiDuration != null && (
            <span className="text-fg-faint hidden sm:inline">({formatDuration(ss.apiDuration)} API)</span>
          )}
        </span>
      )}

      {/* Input tokens */}
      {show('tokens-in') && ss?.inputTokens != null && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
          title={`Input tokens: ${ss.inputTokens.toLocaleString()}`}
        >
          <span className="text-fg-faint">In:</span>
          <span className="text-fg-2">{formatTokens(ss.inputTokens)}</span>
        </span>
      )}

      {/* Output tokens */}
      {show('tokens-out') && ss?.outputTokens != null && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
          title={`Output tokens: ${ss.outputTokens.toLocaleString()}`}
        >
          <span className="text-fg-faint">Out:</span>
          <span className="text-fg-2">{formatTokens(ss.outputTokens)}</span>
        </span>
      )}

      {/* Cache efficiency */}
      {show('cache-stats') && ss?.cacheReadTokens != null && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
          title={`Cache read: ${(ss.cacheReadTokens ?? 0).toLocaleString()} | Cache created: ${(ss.cacheCreationTokens ?? 0).toLocaleString()}`}
        >
          <span className="text-fg-faint">Cached:</span>
          <span className="text-[#4CAF50]">{formatTokens(ss.cacheReadTokens)}</span>
        </span>
      )}

      {/* Code changes — lines added/removed */}
      {show('code-changes') && ss != null && (ss.linesAdded != null || ss.linesRemoved != null) && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
          title={`Lines added: ${ss.linesAdded ?? 0} | Lines removed: ${ss.linesRemoved ?? 0}`}
        >
          {ss.linesAdded != null && <span className="text-[#4CAF50]">+{ss.linesAdded}</span>}
          {ss.linesRemoved != null && <span className="text-[#DD4444]">-{ss.linesRemoved}</span>}
          <span className="text-fg-faint hidden sm:inline">lines</span>
        </span>
      )}

      {/* Git branch — reads from statusline.sh's .gitbranch-{sessionId} file */}
      {show('git-branch') && gitBranch && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm border"
          style={{ backgroundColor: 'rgba(45,212,191,0.10)', color: '#2DD4BF', borderColor: 'rgba(45,212,191,0.25)' }}
          title={`Git: ${gitBranch}`}
        >
          {/* Branch icon (octicon git-branch) */}
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
            <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/>
          </svg>
          <span>{gitBranch}</span>
        </span>
      )}

      {/* Sync warnings */}
      {show('sync-warnings') && warnings.map((w, i) => {
        const handler = onOpenSync || onRunSync;
        return (
          <button
            key={i}
            onClick={handler}
            className={`px-1.5 py-0.5 rounded-sm border text-[9px] sm:text-[10px] ${warnStyles[w.level]} ${handler ? 'cursor-pointer hover:brightness-125 transition-all' : ''}`}
          >
            {w.text}
          </button>
        );
      })}

      {/* Theme pill */}
      {show('theme') && (
        <button
          onClick={cycleTheme}
          className="px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim cursor-pointer hover:bg-inset transition-colors"
          title="Click to cycle theme"
        >
          {activeTheme.name}
        </button>
      )}

      {/* Version pill — shows DestinCode app version, glows yellow when update available */}
      {show('version') && updateStatus && (
        <button
          onClick={() => {
            if (updateStatus.update_available && updateStatus.download_url) {
              window.claude.shell.openExternal(updateStatus.download_url);
            } else {
              window.claude.shell.openChangelog();
            }
          }}
          className={`px-1.5 py-0.5 rounded-sm border cursor-pointer transition-colors hidden sm:inline-flex ${
            updateStatus.update_available
              ? 'bg-[rgba(234,179,8,0.12)] border-[rgba(234,179,8,0.5)] hover:bg-[rgba(234,179,8,0.22)] animate-[version-glow_2s_ease-in-out_infinite]'
              : 'bg-panel border-edge-dim hover:bg-inset'
          }`}
          title={updateStatus.update_available ? `Update available: v${updateStatus.latest} — click to download` : `DestinCode v${updateStatus.current}`}
        >
          {updateStatus.update_available ? (
            <span className="text-[#EAB308] font-medium">
              v{updateStatus.latest} — Update Available
            </span>
          ) : (
            <span>v{updateStatus.current}</span>
          )}
        </button>
      )}

      {/* Customize widget — pencil icon opens config popup, always last */}
      <button
        onClick={() => setPopupOpen(true)}
        className="ml-auto flex items-center justify-center w-5 h-5 rounded-sm bg-panel border border-edge-dim cursor-pointer hover:bg-inset transition-colors"
        title="Customize Status Bar"
      >
        <PencilIcon />
      </button>

      {/* Config popup — centered modal with grouped widgets + (i) info */}
      <WidgetConfigPopup
        open={popupOpen}
        onClose={() => setPopupOpen(false)}
        visible={visible}
        toggle={toggle}
      />
    </div>
  );
}

export { MODELS, type ModelAlias };
