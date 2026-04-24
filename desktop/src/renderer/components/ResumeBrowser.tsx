import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { MODELS, type ModelAlias } from './StatusBar';
import { Scrim, OverlayPanel } from './overlays/Overlay';
import { useScrollFade } from '../hooks/useScrollFade';
import { useEscClose } from '../hooks/use-esc-close';
import { SkipPermissionsInfoTooltip } from './SkipPermissionsInfoTooltip';
import {
  applyFilters,
  sortSessions,
  groupSessions,
  getAvailableProjects,
  type FilterState,
  type FlagName,
} from './resume-browser-filters';

const MODEL_LABELS: Record<string, string> = {
  sonnet: 'Sonnet',
  'opus[1m]': 'Opus 1M',
  haiku: 'Haiku',
};

function formatRelativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(epochMs).toLocaleDateString();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = Math.round(bytes / 1024);
  if (kb < 1024) return `${kb}KB`;
  return `${(kb / 1024).toFixed(1)}MB`;
}

// FlagName is imported from resume-browser-filters.ts (single source of truth).
// Kept in sync with SESSION_FLAG_NAMES in shared/types.ts; that module is
// CommonJS so we don't import it directly. FLAG_ORDER fixes the pill / badge
// ordering in the UI (Priority first, Helpful, then Complete).
const FLAG_ORDER: FlagName[] = ['priority', 'helpful', 'complete'];
const FLAG_LABEL: Record<FlagName, string> = {
  priority: 'Priority',
  helpful: 'Helpful',
  complete: 'Complete',
};
// Compact glyph shown in the session-row badge for each flag.
const FLAG_BADGE: Record<FlagName, string> = {
  priority: '▲',
  helpful: '●',
  complete: '✓',
};

interface PastSession {
  sessionId: string;
  name: string;
  projectSlug: string;
  projectPath: string;
  lastModified: number;
  size: number;
  // User-set flags — multiple allowed. `complete` hides unless Show Complete
  // is on; `priority` pins the session to the top of its project group;
  // `helpful` is informational only.
  flags?: Partial<Record<FlagName, boolean>>;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onResume: (sessionId: string, projectSlug: string, projectPath: string, model: string, dangerous: boolean, launchInNewWindow?: boolean) => void;
  defaultModel?: string;
  defaultSkipPermissions?: boolean;
}

export default function ResumeBrowser({ open, onClose, onResume, defaultModel, defaultSkipPermissions }: Props) {
  const [sessions, setSessions] = useState<PastSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useScrollFade<HTMLDivElement>();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [resumeModel, setResumeModel] = useState<string>(defaultModel || 'sonnet');
  const [resumeDangerous, setResumeDangerous] = useState(defaultSkipPermissions || false);
  // Launch the resumed session in a new peer window (multi-window only).
  const [resumeLaunchInNewWindow, setResumeLaunchInNewWindow] = useState(false);
  const detachAvailable = typeof (window as any).claude?.detach?.openDetached === 'function';
  // Show Complete: when off, sessions marked complete are hidden (default).
  // Persists across opens via localStorage so Destin doesn't re-toggle each time.
  const [showComplete, setShowComplete] = useState<boolean>(() => {
    try { return localStorage.getItem('youcoded-resume-show-complete') === '1'; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('youcoded-resume-show-complete', showComplete ? '1' : '0'); } catch {}
  }, [showComplete]);

  // Sessions the user flagged Complete during the current open. They stay
  // visible until the menu is closed and reopened, so the row doesn't vanish
  // mid-interaction when Show Complete is off. Reset on every open.
  const [stickyComplete, setStickyComplete] = useState<Set<string>>(new Set());

  // New filter state — all reset on each open (no localStorage). Default values
  // (empty Sets, sortDir='desc') produce identical behaviour to the prior
  // hard-coded filter pipeline.
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());
  const [selectedTags, setSelectedTags] = useState<Set<FlagName>>(new Set());
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  // Fetch sessions when opened
  useEffect(() => {
    if (open) {
      setSearch('');
      setExpandedId(null);
      setResumeModel(defaultModel || 'sonnet');
      setResumeDangerous(defaultSkipPermissions || false);
      // Reset the sticky-visible set each open — previously kept rows drop out.
      setStickyComplete(new Set());
      // Reset filter pills each open — current spec: no persistence.
      setSelectedProjects(new Set());
      setSelectedTags(new Set());
      setSortDir('desc');
      setLoading(true);
      (window as any).claude.session.browse()
        .then((list: PastSession[]) => setSessions(list))
        .catch(() => setSessions([]))
        .finally(() => setLoading(false));
      const t = setTimeout(() => searchRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Close on Escape — collapse the expanded row first, then close the browser.
  // Extracted into a callback so useEscClose sees the layered close behavior.
  const handleEscClose = useCallback(() => {
    if (expandedId) setExpandedId(null);
    else onClose();
  }, [expandedId, onClose]);
  useEscClose(open, handleEscClose);

  const filtered = useMemo(() => {
    // Filter pipeline lives in resume-browser-filters.ts so it can be unit tested.
    // Order: Show Complete + sticky → project → tag → search.
    const state: FilterState = {
      search,
      showComplete,
      stickyComplete,
      selectedProjects,
      selectedTags,
    };
    return applyFilters(sessions, state);
  }, [sessions, search, showComplete, stickyComplete, selectedProjects, selectedTags]);

  // Group by project path; within-group sort priority-pinned + lastModified by sortDir.
  // Between-group order also follows sortDir (newest-first when desc, oldest-first when asc).
  const grouped = useMemo(() => {
    if (search.trim()) return null;
    return groupSessions(filtered, sortDir);
  }, [filtered, search, sortDir]);

  // Flat list (search mode) — priority-pinned, lastModified by sortDir.
  const flatSorted = useMemo(() => {
    if (!search.trim()) return filtered;
    return sortSessions(filtered, sortDir);
  }, [filtered, search, sortDir]);

  // Optimistically flip a flag in local state, then persist via IPC. On failure
  // we revert. A meta-changed push from other tabs/devices also refreshes the
  // list — see the subscription effect below.
  const toggleFlag = async (sessionId: string, flag: FlagName, next: boolean) => {
    const apply = (val: boolean) => setSessions((prev) => prev.map((s) =>
      s.sessionId === sessionId ? { ...s, flags: { ...(s.flags || {}), [flag]: val } } : s,
    ));
    apply(next);
    // Pin just-flagged-Complete rows visible for the remainder of this open.
    if (flag === 'complete' && next && !showComplete) {
      setStickyComplete((prev) => {
        const ns = new Set(prev);
        ns.add(sessionId);
        return ns;
      });
    }
    try {
      const res: any = await (window as any).claude.session.setFlag(sessionId, flag, next);
      if (res && res.ok === false) apply(!next);
    } catch {
      apply(!next);
    }
  };

  // Listen for cross-tab / cross-device meta changes while the browser is open.
  useEffect(() => {
    if (!open) return;
    const sub = (window as any).claude?.on?.sessionMetaChanged;
    if (!sub) return;
    const off = sub((sid: string, meta: { flag?: string; value?: boolean }) => {
      if (!meta?.flag) return;
      setSessions((prev) => prev.map((s) =>
        s.sessionId === sid
          ? { ...s, flags: { ...(s.flags || {}), [meta.flag as FlagName]: !!meta.value } }
          : s,
      ));
    });
    // Desktop preload returns the raw handler; remote-shim returns an unsubscribe fn.
    return () => {
      try { if (typeof off === 'function') off(); } catch {}
    };
  }, [open]);

  const handleSelectSession = (sessionId: string) => {
    if (expandedId === sessionId) {
      setExpandedId(null);
    } else {
      setExpandedId(sessionId);
      setResumeModel(defaultModel || 'sonnet');
      setResumeDangerous(defaultSkipPermissions || false);
      setResumeLaunchInNewWindow(false);
    }
  };

  const handleConfirmResume = (s: PastSession) => {
    onResume(s.sessionId, s.projectSlug, s.projectPath, resumeModel, resumeDangerous, resumeLaunchInNewWindow);
    onClose();
  };

  if (!open) return null;

  const renderExpandedOptions = (s: PastSession) => (
    <div className="px-4 pb-2">
      <div className="rounded-lg bg-inset/50 border border-edge-dim p-3 flex flex-col gap-2">
        {/* Model selector */}
        <div>
          <label className="text-[10px] uppercase tracking-wider text-fg-muted mb-1 block">Model</label>
          <div className="flex gap-1">
            {MODELS.map((m) => (
              <button
                key={m}
                onClick={() => setResumeModel(m)}
                className={`flex-1 px-1 py-1 rounded-sm text-[10px] transition-colors ${
                  resumeModel === m
                    ? 'bg-accent text-on-accent font-medium'
                    : 'bg-inset text-fg-dim hover:bg-edge'
                }`}
              >
                {MODEL_LABELS[m] || m}
              </button>
            ))}
          </div>
        </div>

        {/* Skip Permissions */}
        <div className="flex items-center justify-between">
          <label className="text-[10px] uppercase tracking-wider text-fg-muted inline-flex items-center">
            Skip Permissions
            <SkipPermissionsInfoTooltip />
          </label>
          <button
            onClick={() => setResumeDangerous(!resumeDangerous)}
            className={`w-8 h-4.5 rounded-full relative transition-colors ${resumeDangerous ? 'bg-[#DD4444]' : 'bg-inset'}`}
          >
            <span className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${resumeDangerous ? 'left-[calc(100%-16px)]' : 'left-0.5'}`} />
          </button>
        </div>
        {resumeDangerous && (
          <p className="text-[10px] text-[#DD4444]">Claude will execute tools without asking for approval.</p>
        )}

        {/* Launch in new window — hidden on remote/Android (single-window) */}
        {detachAvailable && (
          <div className="flex items-center justify-between">
            <label className="text-[10px] uppercase tracking-wider text-fg-muted">Launch in New Window</label>
            <button
              onClick={() => setResumeLaunchInNewWindow(!resumeLaunchInNewWindow)}
              className={`w-8 h-4.5 rounded-full relative transition-colors ${resumeLaunchInNewWindow ? 'bg-accent' : 'bg-inset'}`}
            >
              <span className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${resumeLaunchInNewWindow ? 'left-[calc(100%-16px)]' : 'left-0.5'}`} />
            </button>
          </div>
        )}

        {/* Flags — one row of multi-select pills (Priority / Helpful / Complete).
            Complete can be toggled on with Show Complete off; the row stays
            visible until the menu is closed and reopened (stickyComplete). */}
        <div>
          <label className="text-[10px] uppercase tracking-wider text-fg-muted mb-1 block">Flags</label>
          <div className="flex gap-1">
            {FLAG_ORDER.map((flag) => {
              const active = !!s.flags?.[flag];
              return (
                <button
                  key={flag}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleFlag(s.sessionId, flag, !active);
                  }}
                  className={`flex-1 px-1 py-1 rounded-sm text-[10px] transition-colors ${
                    active
                      ? 'bg-accent text-on-accent font-medium'
                      : 'bg-inset text-fg-dim hover:bg-edge'
                  }`}
                  aria-pressed={active}
                >
                  {FLAG_LABEL[flag]}
                </button>
              );
            })}
          </div>
        </div>

        {/* Resume button */}
        <button
          onClick={() => handleConfirmResume(s)}
          className={`w-full text-sm font-medium rounded-md py-1.5 transition-colors ${
            resumeDangerous
              ? 'bg-[#DD4444] hover:bg-[#E55555] text-white'
              : 'bg-accent hover:bg-accent text-on-accent'
          }`}
        >
          {resumeDangerous ? 'Resume (Dangerous)' : 'Resume Session'}
        </button>
      </div>
    </div>
  );

  const renderSessionRow = (s: PastSession, showPath?: boolean) => (
    <div key={s.sessionId}>
      <button
        onClick={() => handleSelectSession(s.sessionId)}
        className={`w-full text-left px-4 py-2 flex items-center gap-3 transition-colors ${
          expandedId === s.sessionId
            ? 'bg-inset text-fg'
            : 'text-fg-dim hover:bg-inset hover:text-fg'
        }`}
      >
        <div className="flex-1 min-w-0">
          <div className="text-sm truncate flex items-center gap-1.5">
            {/* Compact per-flag badges before the name. Priority sits leftmost so
                it reads like an at-a-glance pin marker. */}
            {FLAG_ORDER.filter((f) => s.flags?.[f]).map((f) => (
              <span
                key={f}
                className="text-[9px] leading-none px-1 py-[1px] rounded-sm bg-accent text-on-accent shrink-0"
                title={FLAG_LABEL[f]}
              >{FLAG_BADGE[f]}</span>
            ))}
            <span className="truncate">{s.name}</span>
          </div>
          <div className="text-[10px] text-fg-faint">
            {showPath
              ? s.projectPath.replace(/\\/g, '/').split('/').pop()
              : formatSize(s.size)}
          </div>
        </div>
        <span className="text-[10px] text-fg-faint shrink-0">
          {formatRelativeTime(s.lastModified)}
        </span>
      </button>
      {expandedId === s.sessionId && renderExpandedOptions(s)}
    </div>
  );

  return (
    <>
      {/* L1 drawer-style modal — theme-driven via Scrim/OverlayPanel. */}
      <Scrim layer={1} onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <OverlayPanel
          layer={1}
          className="w-full max-w-md max-h-[70vh] flex flex-col pointer-events-auto"
          style={{ position: 'relative', zIndex: 'auto' }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="px-4 pt-4 pb-3 border-b border-edge">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold text-fg">Resume Session</h2>
              {/* Show Complete — same toggle pattern as Skip Permissions + Gemini CLI
                  in SessionStrip, but accent-colored to signal "on" rather than "danger". */}
              <div className="flex items-center gap-2">
                <label className="text-[10px] uppercase tracking-wider text-fg-muted">Show Complete</label>
                <button
                  onClick={() => setShowComplete(!showComplete)}
                  className={`w-8 h-4.5 rounded-full relative transition-colors ${showComplete ? 'bg-accent' : 'bg-inset'}`}
                  aria-pressed={showComplete}
                >
                  <span className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${showComplete ? 'left-[calc(100%-16px)]' : 'left-0.5'}`} />
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2 bg-inset rounded-lg px-3 py-2 border border-edge-dim">
              <svg className="w-4 h-4 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.35-4.35" strokeLinecap="round" />
              </svg>
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search sessions..."
                className="flex-1 bg-transparent text-sm text-fg placeholder-fg-muted outline-none"
              />
            </div>
          </div>

          {/* Session list */}
          {/* No flex-1: OverlayPanel only has max-h (indefinite height), which breaks
              flex-grow in Chromium. Using default flex: 0 1 auto lets flex-shrink
              clamp this div when content exceeds max-h so overflow-y: auto engages
              and the scroll-fade hook sees a real scroll. */}
          {/* Padding lives on an inner wrapper so the scroll-fade element itself has
              no padding. Sticky fade pseudos then sit flush with the scroll-fade's
              outer edge, and the `overflow: hidden` on .layer-surface clips them to
              the OverlayPanel's rounded corners. */}
          <div ref={listRef} className="scroll-fade">
            <div className="py-2">
              {loading ? (
                <p className="text-sm text-fg-muted text-center py-8">Loading sessions...</p>
              ) : filtered.length === 0 ? (
                <p className="text-sm text-fg-muted text-center py-8">
                  {search.trim() ? 'No matching sessions' : 'No previous sessions found'}
                </p>
              ) : grouped ? (
                // Grouped by project
                [...grouped.entries()].map(([projectPath, items]) => (
                  <div key={projectPath} className="mb-2">
                    <div className="px-4 py-1">
                      <span className="text-[10px] uppercase tracking-wider text-fg-muted">
                        {projectPath.replace(/\\/g, '/').split('/').pop() || projectPath}
                      </span>
                    </div>
                    {items.map((s) => renderSessionRow(s))}
                  </div>
                ))
              ) : (
                // Flat search results, priority-pinned
                flatSorted.map((s) => renderSessionRow(s, true))
              )}
            </div>
          </div>
        </OverlayPanel>
      </div>
    </>
  );
}
