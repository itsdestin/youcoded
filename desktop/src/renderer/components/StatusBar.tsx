import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTheme } from '../state/theme-context';
import type { PermissionMode } from '../../shared/types';

interface StatusData {
  usage: {
    five_hour?: { utilization: number; resets_at: string };
    seven_day?: { utilization: number; resets_at: string };
  } | null;
  updateStatus: {
    current: string;
    latest: string;
    update_available: boolean;
  } | null;
  contextPercent: number | null;
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

interface Props {
  statusData: StatusData;
  onRunSync?: () => void;
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

// --- Widget visibility customizer ---

type WidgetId = 'usage-5h' | 'usage-7d' | 'context' | 'sync-warnings' | 'theme' | 'version';

const WIDGET_DEFS: { id: WidgetId; label: string }[] = [
  { id: 'usage-5h', label: '5h Usage' },
  { id: 'usage-7d', label: '7d Usage' },
  { id: 'context', label: 'Context %' },
  { id: 'sync-warnings', label: 'Sync Warnings' },
  { id: 'theme', label: 'Theme' },
  { id: 'version', label: 'Version' },
];

const STORAGE_KEY = 'destincode-statusbar-widgets';
const ALL_VISIBLE = new Set<WidgetId>(WIDGET_DEFS.map((w) => w.id));

function loadVisibility(): Set<WidgetId> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const arr = JSON.parse(stored) as WidgetId[];
      return new Set(arr.filter((id) => WIDGET_DEFS.some((w) => w.id === id)));
    }
  } catch { /* ignore */ }
  return new Set(ALL_VISIBLE);
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

// Pencil SVG icon (inline to avoid extra dependencies)
function PencilIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M12.146.854a.5.5 0 0 1 .708 0l2.292 2.292a.5.5 0 0 1 0 .708l-9.5 9.5a.5.5 0 0 1-.168.11l-4 1.5a.5.5 0 0 1-.638-.638l1.5-4a.5.5 0 0 1 .11-.168l9.5-9.5zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5z"/>
    </svg>
  );
}

export default function StatusBar({ statusData, onRunSync, model, onCycleModel, permissionMode, onCyclePermission }: Props) {
  const { usage, updateStatus, contextPercent, syncStatus, syncWarnings } = statusData;
  const warnings = parseSyncWarnings(syncWarnings);
  const { activeTheme, cycleTheme } = useTheme();
  const { visible, toggle } = useWidgetVisibility();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const show = (id: WidgetId) => visible.has(id);

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

      {/* Sync warnings */}
      {show('sync-warnings') && warnings.map((w, i) => (
        <button
          key={i}
          onClick={onRunSync}
          className={`px-1.5 py-0.5 rounded-sm border text-[9px] sm:text-[10px] ${warnStyles[w.level]} ${onRunSync ? 'cursor-pointer hover:brightness-125 transition-all' : ''}`}
        >
          {w.text}
        </button>
      ))}

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

      {/* Version — hidden on very narrow screens */}
      {show('version') && updateStatus && (
        <button
          onClick={() => window.claude.shell.openChangelog()}
          className="px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim cursor-pointer hover:bg-inset transition-colors hidden sm:inline-flex"
        >
          {updateStatus.update_available ? (
            <span className="text-[#FF9800]">
              v{updateStatus.current} → v{updateStatus.latest}
            </span>
          ) : (
            <span>v{updateStatus.current}</span>
          )}
        </button>
      )}

      {/* Customize widget — pencil icon, always last */}
      <div className="relative ml-auto" ref={menuRef}>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="flex items-center justify-center w-5 h-5 rounded-sm bg-panel border border-edge-dim cursor-pointer hover:bg-inset transition-colors"
          title="Customize Status Bar"
        >
          <PencilIcon />
        </button>
        {menuOpen && (
          <div className="absolute bottom-full right-0 mb-1 w-44 rounded-md border border-edge-dim bg-panel shadow-lg z-50 py-1 text-[11px]">
            <div className="px-2 py-1 text-fg-faint font-semibold border-b border-edge-dim text-[10px] uppercase tracking-wide">
              Status Bar Widgets
            </div>
            {WIDGET_DEFS.map((w) => (
              <button
                key={w.id}
                onClick={() => toggle(w.id)}
                className="flex items-center gap-2 w-full px-2 py-1 hover:bg-inset transition-colors text-left"
              >
                <span
                  className={`w-3 h-3 rounded-sm border flex-shrink-0 flex items-center justify-center ${
                    visible.has(w.id)
                      ? 'bg-accent border-accent text-on-accent'
                      : 'border-edge-dim'
                  }`}
                >
                  {visible.has(w.id) && (
                    <svg width="8" height="8" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z" />
                    </svg>
                  )}
                </span>
                <span className="text-fg">{w.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export { MODELS, type ModelAlias };
