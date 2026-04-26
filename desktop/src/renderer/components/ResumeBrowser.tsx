import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
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

// Shared trigger-button shape for the filter row beneath the search bar.
// Inactive pills look like the search input frame; active pills tint with the
// accent so the user can see at a glance which pills have departed from
// default state — narrowing filters (Projects, Tags) AND a non-default sort
// direction (Sort). Don't "tighten" the predicate to only narrowing — Sort
// would lose its visual cue.
function FilterPill({
  active,
  onClick,
  children,
  hasPopup,
  expanded,
  buttonRef,
}: {
  active: boolean;
  // Receives the MouseEvent so dropdown-owning callers can stopPropagation()
  // — the Projects + Tags pills (Tasks 4 + 5) rely on this to keep their
  // outside-click handler from immediately re-closing the dropdown.
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
  // Optional: when the pill opens a dropdown, callers pass these so screen
  // readers announce both "active filter" (aria-pressed) AND dropdown state.
  // expanded is only read when hasPopup is true; React strips both attrs
  // entirely when hasPopup is falsy (Sort pill).
  hasPopup?: boolean;
  expanded?: boolean;
  // Optional: dropdown-owning callers pass a ref so they can measure the
  // trigger's bounding rect for portal positioning. Sort doesn't need it.
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      // aria-pressed conveys the toggle state to assistive tech. Mirrors the
      // Show Complete toggle's pattern further down in this file.
      aria-pressed={active}
      aria-haspopup={hasPopup ? 'listbox' : undefined}
      aria-expanded={hasPopup ? !!expanded : undefined}
      className={`px-2.5 py-1 rounded-full text-[11px] flex items-center gap-1.5 transition-colors duration-75 ${
        active
          ? 'bg-accent/10 border border-accent/40 text-fg'
          : 'bg-inset border border-edge-dim text-fg-muted hover:text-fg'
      }`}
    >
      {children}
    </button>
  );
}

// Compute fixed-position coords for a portaled dropdown anchored just below a
// trigger button. Clamps the left coordinate so a wide dropdown near the right
// edge of the viewport shifts left rather than overflowing off-screen. Pure;
// callers invoke it synchronously inside the click handler so the dropdown can
// render in the same React commit as `openPill` flipping (no two-render lag).
function measureDropdown(
  triggerRef: React.RefObject<HTMLButtonElement | null>,
  dropdownWidthPx: number,
): { top: number; left: number } | null {
  const el = triggerRef.current;
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  // Clamp so the dropdown's right edge stays at least 8px inside the viewport.
  // If the trigger sits too far right, the dropdown shifts left.
  const maxLeft = Math.max(8, window.innerWidth - dropdownWidthPx - 8);
  return {
    top: rect.bottom + 4,
    left: Math.min(rect.left, maxLeft),
  };
}

// While a dropdown is open, re-measure the trigger on window resize / scroll
// so the dropdown stays anchored as the viewport changes. The initial position
// is captured synchronously in the pill's click handler — this hook only
// handles updates after open, not the open itself.
function useDropdownReposition(
  isOpen: boolean,
  triggerRef: React.RefObject<HTMLButtonElement | null>,
  dropdownWidthPx: number,
  setPosition: React.Dispatch<React.SetStateAction<{ top: number; left: number } | null>>,
): void {
  useEffect(() => {
    if (!isOpen) return;
    const remeasure = () => {
      const next = measureDropdown(triggerRef, dropdownWidthPx);
      if (next) setPosition(next);
    };
    window.addEventListener('resize', remeasure);
    // Capture-phase scroll listener catches scroll on any ancestor, not just
    // window — needed if a scrollable parent moves the trigger.
    window.addEventListener('scroll', remeasure, true);
    return () => {
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('scroll', remeasure, true);
    };
  }, [isOpen, triggerRef, dropdownWidthPx, setPosition]);
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
// Tags filter exposes only Priority + Helpful — Complete is owned by the
// Show Complete header toggle. Tags pill dropdown + label both iterate this
// constant; adding a custom tag in the future is a list extension here, not
// a UI rewrite.
const TAG_FILTER_OPTIONS: ReadonlyArray<Exclude<FlagName, 'complete'>> = ['priority', 'helpful'] as const;

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
  // Wraps the filter pill row so outside-click can close the active dropdown.
  const filterRowRef = useRef<HTMLDivElement>(null);
  // Trigger refs for portal positioning + dropdown refs so the outside-click
  // handler can recognize clicks inside the portaled dropdown body (which is
  // no longer a child of filterRowRef).
  const projectsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const tagsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const projectsDropdownRef = useRef<HTMLDivElement | null>(null);
  const tagsDropdownRef = useRef<HTMLDivElement | null>(null);
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

  // Tracks which filter pill's dropdown is currently open. null = both closed.
  // Single state instead of two booleans so the dropdowns are mutually exclusive.
  const [openPill, setOpenPill] = useState<'projects' | 'tags' | null>(null);

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

  // Layered ESC: close an open filter dropdown first, then collapse the
  // expanded row, then close the browser. Each ESC press peels one layer.
  const handleEscClose = useCallback(() => {
    if (openPill) setOpenPill(null);
    else if (expandedId) setExpandedId(null);
    else onClose();
  }, [openPill, expandedId, onClose]);
  useEscClose(open, handleEscClose);

  // Close the active filter dropdown on outside click. Recognizes clicks
  // inside the trigger row AND the portaled dropdowns (which live in
  // document.body, outside filterRowRef).
  useEffect(() => {
    if (!openPill) return;
    const handler = (e: Event) => {
      const target = e.target as Node;
      if (filterRowRef.current?.contains(target)) return;
      if (projectsDropdownRef.current?.contains(target)) return;
      if (tagsDropdownRef.current?.contains(target)) return;
      setOpenPill(null);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [openPill]);

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

  // Distinct projects with counts — what the Projects pill dropdown displays.
  // Derived from the unfiltered session list so the dropdown always shows
  // every known project, even when the user has narrowed the visible list.
  const availableProjects = useMemo(() => getAvailableProjects(sessions), [sessions]);

  // Trigger label for the Projects pill: 0 selected → "Projects",
  // 1 → label, 2-3 → comma-joined labels, 4+ → "Projects (N)".
  const projectsLabel = useMemo(() => {
    if (selectedProjects.size === 0) return 'Projects';
    const selectedList = availableProjects.filter((p) => selectedProjects.has(p.path));
    if (selectedList.length === 1) return selectedList[0].label;
    if (selectedList.length <= 3) return selectedList.map((p) => p.label).join(', ');
    return `Projects (${selectedList.length})`;
  }, [selectedProjects, availableProjects]);

  // Trigger label for the Tags pill: 0 → "Tags"; 1 → flag label; 2 → "A + B".
  // Iterates TAG_FILTER_OPTIONS so adding a custom tag is a list extension
  // there rather than a memo edit here.
  const tagsLabel = useMemo(() => {
    if (selectedTags.size === 0) return 'Tags';
    return TAG_FILTER_OPTIONS
      .filter((tag) => selectedTags.has(tag))
      .map((tag) => FLAG_LABEL[tag])
      .join(' + ');
  }, [selectedTags]);

  // Portal-anchored dropdown positions. Dropdown widths match the className
  // (Projects: w-64 = 256px, Tags: w-44 = 176px). Keep these in sync if the
  // className width changes.
  // The position is captured synchronously inside each pill's onClick handler
  // (not via useLayoutEffect) so the dropdown can render in the same React
  // commit as `openPill` flipping — eliminates the two-render lag the prior
  // implementation had between pill click and dropdown appearing.
  const [projectsDropdownPos, setProjectsDropdownPos] = useState<{ top: number; left: number } | null>(null);
  const [tagsDropdownPos, setTagsDropdownPos] = useState<{ top: number; left: number } | null>(null);
  // Reposition while open (resize / scroll updates only — not the initial
  // measurement, which is sync in the click handler).
  useDropdownReposition(openPill === 'projects', projectsTriggerRef, 256, setProjectsDropdownPos);
  useDropdownReposition(openPill === 'tags', tagsTriggerRef, 176, setTagsDropdownPos);

  // Clear stale position state when the dropdown closes via outside-click or
  // ESC (the click handlers do this themselves, but those external paths
  // don't). Saves a tiny amount of memory and prevents a stale position from
  // briefly flashing if the same pill reopens before useDropdownReposition
  // has a chance to update.
  useEffect(() => {
    if (openPill !== 'projects' && projectsDropdownPos !== null) setProjectsDropdownPos(null);
    if (openPill !== 'tags' && tagsDropdownPos !== null) setTagsDropdownPos(null);
  }, [openPill, projectsDropdownPos, tagsDropdownPos]);

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
            <div ref={filterRowRef} className="flex items-center gap-1.5 mt-2 relative">
              {/* Projects: multi-select dropdown over distinct projectPaths in the loaded sessions.
                  Dropdown is portaled to document.body so it escapes the OverlayPanel's
                  overflow:hidden clipping (lets it overlap the panel edge). */}
              <FilterPill
                buttonRef={projectsTriggerRef}
                active={selectedProjects.size > 0}
                hasPopup
                expanded={openPill === 'projects'}
                onClick={(e) => {
                  e.stopPropagation();
                  // Measure synchronously so the dropdown renders with its final
                  // position in the same commit as openPill flipping. Avoids the
                  // two-render lag the prior useLayoutEffect approach had.
                  if (openPill === 'projects') {
                    setOpenPill(null);
                    setProjectsDropdownPos(null);
                  } else {
                    setProjectsDropdownPos(measureDropdown(projectsTriggerRef, 256));
                    setOpenPill('projects');
                  }
                }}
              >
                <span>{projectsLabel}</span>
                <span className="text-fg-faint text-[9px]">▾</span>
              </FilterPill>
              {openPill === 'projects' && projectsDropdownPos && createPortal(
                <div
                  ref={projectsDropdownRef}
                  className="layer-surface w-64 max-w-[calc(100vw-1rem)] overflow-hidden"
                  style={{
                    position: 'fixed',
                    top: projectsDropdownPos.top,
                    left: projectsDropdownPos.left,
                    zIndex: 60,
                  }}
                >
                  {/* "Clear" — text-only affordance that empties selectedProjects (which the data
                      model treats as "filter inactive"). No checkbox visual so it doesn't read as
                      a master "select every project" toggle. Muted small-caps style separates it
                      from the checkbox rows below. Always visible; clicks no-op when already cleared. */}
                  <button
                    type="button"
                    onClick={() => setSelectedProjects(new Set())}
                    className="w-full text-left px-2.5 py-1.5 text-[11px] uppercase tracking-wider text-fg-muted hover:text-fg hover:bg-inset transition-colors"
                  >
                    Clear
                  </button>
                  <div className="max-h-56 overflow-y-auto border-t border-edge-dim">
                    {availableProjects.map((p) => {
                      const checked = selectedProjects.has(p.path);
                      return (
                        <button
                          key={p.path}
                          type="button"
                          onClick={() => {
                            setSelectedProjects((prev) => {
                              const next = new Set(prev);
                              if (next.has(p.path)) next.delete(p.path);
                              else next.add(p.path);
                              return next;
                            });
                          }}
                          className="w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-2 hover:bg-inset transition-colors text-fg-2"
                        >
                          <span className={`w-3 h-3 shrink-0 rounded-sm border ${checked ? 'bg-accent border-accent' : 'border-edge'}`} />
                          <span className="flex-1 truncate" title={p.path}>{p.label}</span>
                          <span className="text-[10px] text-fg-faint shrink-0">{p.count}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>,
                document.body,
              )}

              {/* Tags: multi-select dropdown over the per-session flag set. Priority + Helpful only;
                  Complete stays owned by the Show Complete toggle in the header. Dropdown is
                  portaled to escape the OverlayPanel's overflow:hidden clipping. */}
              <FilterPill
                buttonRef={tagsTriggerRef}
                active={selectedTags.size > 0}
                hasPopup
                expanded={openPill === 'tags'}
                onClick={(e) => {
                  e.stopPropagation();
                  // Measure synchronously — see Projects onClick comment.
                  if (openPill === 'tags') {
                    setOpenPill(null);
                    setTagsDropdownPos(null);
                  } else {
                    setTagsDropdownPos(measureDropdown(tagsTriggerRef, 176));
                    setOpenPill('tags');
                  }
                }}
              >
                <span>{tagsLabel}</span>
                <span className="text-fg-faint text-[9px]">▾</span>
              </FilterPill>
              {openPill === 'tags' && tagsDropdownPos && createPortal(
                <div
                  ref={tagsDropdownRef}
                  className="layer-surface w-44 max-w-[calc(100vw-1rem)] overflow-hidden"
                  style={{
                    position: 'fixed',
                    top: tagsDropdownPos.top,
                    left: tagsDropdownPos.left,
                    zIndex: 60,
                  }}
                >
                  {TAG_FILTER_OPTIONS.map((tag) => {
                    const checked = selectedTags.has(tag);
                    return (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => {
                          setSelectedTags((prev) => {
                            const next = new Set(prev);
                            if (next.has(tag)) next.delete(tag);
                            else next.add(tag);
                            return next;
                          });
                        }}
                        className="w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-2 hover:bg-inset transition-colors text-fg-2"
                      >
                        <span className={`w-3 h-3 shrink-0 rounded-sm border ${checked ? 'bg-accent border-accent' : 'border-edge'}`} />
                        <span className="flex-1">{FLAG_LABEL[tag]}</span>
                      </button>
                    );
                  })}
                </div>,
                document.body,
              )}

              {/* Sort toggle — flips lastModified direction. Priority-pin still wins. */}
              <FilterPill active={sortDir !== 'desc'} onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}>
                {sortDir === 'desc' ? 'Most recent ↓' : 'Oldest first ↑'}
              </FilterPill>
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
