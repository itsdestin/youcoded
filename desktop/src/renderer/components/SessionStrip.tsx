import React, { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { SessionStatusColor } from './StatusDot';
import { isAndroid } from '../platform';
import { MODELS, type ModelAlias } from './StatusBar';

/* ── Narrow viewport hook — mirrors Android's single-session behavior ── */
const NARROW_BREAKPOINT = 640;

function useIsCompact(): boolean {
  const [narrow, setNarrow] = useState(() =>
    isAndroid() || (typeof window !== 'undefined' && window.innerWidth < NARROW_BREAKPOINT)
  );
  useEffect(() => {
    if (isAndroid()) return; // always compact on Android
    const mq = window.matchMedia(`(max-width: ${NARROW_BREAKPOINT - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setNarrow(e.matches);
    setNarrow(mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return narrow;
}

interface SessionEntry {
  id: string;
  name: string;
  cwd: string;
  permissionMode: string;
}

const MODEL_LABELS: Record<string, string> = {
  sonnet: 'Sonnet',
  'opus[1m]': 'Opus 1M',
  haiku: 'Haiku',
};

interface Props {
  sessions: SessionEntry[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onCreateSession: (cwd: string, dangerous: boolean, model: string) => void;
  onCloseSession: (id: string) => void;
  sessionStatuses?: Map<string, SessionStatusColor>;
  onResumeSession: (sessionId: string, projectSlug: string) => void;
  onOpenResumeBrowser: () => void;
  onReorderSessions?: (fromIndex: number, toIndex: number) => void;
  defaultModel?: string;
  defaultSkipPermissions?: boolean;
  defaultProjectFolder?: string;
}

/* ── Status dot color maps ───────────────────────────────── */

const DOT_BG: Record<SessionStatusColor, string> = {
  green: 'bg-green-400',
  red: 'bg-red-400',
  blue: 'bg-blue-400',
  gray: 'bg-gray-500',
};

const GLOW_SHADOW: Record<SessionStatusColor, string> = {
  green: '0 0 6px rgba(76,175,80,0.35)',
  red: '0 0 6px rgba(221,68,68,0.35)',
  blue: '0 0 6px rgba(96,165,250,0.35)',
  gray: 'none',
};

const INDICATOR_COLOR: Record<SessionStatusColor, string> = {
  green: '#4CAF50',
  red: '#DD4444',
  blue: '#60A5FA',
  gray: '#666666',
};

function SessionDot({ color, isActive }: { color: SessionStatusColor; isActive: boolean }) {
  const breathing = color !== 'gray';
  return (
    <span className="relative inline-flex items-center justify-center w-2.5 h-2.5 shrink-0">
      <span
        className={`relative w-2 h-2 rounded-full ${DOT_BG[color]}`}
        style={breathing ? { animation: 'breathe 2s ease-in-out infinite' } : { opacity: isActive ? 1 : 0.5 }}
      />
    </span>
  );
}

/* ── Drag grip icon (6-dot braille pattern) ──────────────── */

function DragGrip() {
  return (
    <svg className="w-3 h-3 text-fg-faint" viewBox="0 0 12 16" fill="currentColor">
      <circle cx="3.5" cy="2" r="1.2" />
      <circle cx="8.5" cy="2" r="1.2" />
      <circle cx="3.5" cy="8" r="1.2" />
      <circle cx="8.5" cy="8" r="1.2" />
      <circle cx="3.5" cy="14" r="1.2" />
      <circle cx="8.5" cy="14" r="1.2" />
    </svg>
  );
}

/* ── Main component ──────────────────────────────────────── */

export default function SessionStrip({
  sessions, activeSessionId, onSelectSession,
  onCreateSession, onCloseSession, sessionStatuses, onResumeSession,
  onOpenResumeBrowser, onReorderSessions,
  defaultModel, defaultSkipPermissions, defaultProjectFolder,
}: Props) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [shiftNavIdx, setShiftNavIdx] = useState<number>(-1);
  const shiftNavActive = useRef(false);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newCwd, setNewCwd] = useState('');
  const [dangerous, setDangerous] = useState(false);
  const [newModel, setNewModel] = useState<string>('sonnet');
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerBtnRef = useRef<HTMLButtonElement>(null);
  const pillBarRef = useRef<HTMLDivElement>(null);

  /* ── Pointer-event drag state ──────────────────────────── */
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [dragLabel, setDragLabel] = useState<string>('');
  const [dragColor, setDragColor] = useState<SessionStatusColor>('gray');
  const [ghostTarget, setGhostTarget] = useState<{ x: number; y: number } | null>(null);
  // Track whether pointer moved enough to distinguish drag from click
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  const isDragging = useRef(false);
  // Suppress the click that fires after a drag release
  const suppressClick = useRef(false);

  // Resolve home path on mount
  useEffect(() => {
    (window as any).claude?.getHomePath?.()
      .then((home: string) => { if (home) setNewCwd(home); })
      .catch(() => {});
  }, []);

  // Close menu on outside click (check both trigger area and portal dropdown)
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const inTrigger = menuRef.current?.contains(target);
      const inDropdown = dropdownRef.current?.contains(target);
      if (!inTrigger && !inDropdown) {
        setMenuOpen(false);
        setShowNewForm(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  // Shift-hold session switcher: hold Shift to open dropdown, arrow keys to
  // navigate, release Shift to switch to the highlighted session
  const shiftHoldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;

      // Bare Shift press — start hold timer to open dropdown
      if (e.key === 'Shift' && !e.ctrlKey && !e.altKey && !e.metaKey && !shiftNavActive.current) {
        shiftHoldTimer.current = setTimeout(() => {
          shiftNavActive.current = true;
          const currentIdx = sessions.findIndex(s => s.id === activeSessionId);
          setShiftNavIdx(currentIdx >= 0 ? currentIdx : 0);
          setMenuOpen(true);
        }, 150);
        return;
      }

      // Arrow keys while shift-nav is active
      if (shiftNavActive.current && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        setShiftNavIdx(prev => {
          if (e.key === 'ArrowDown') return Math.min(prev + 1, sessions.length - 1);
          return Math.max(prev - 1, 0);
        });
        return;
      }

      // Any other key while Shift is held — cancel the hold timer
      if (shiftHoldTimer.current) {
        clearTimeout(shiftHoldTimer.current);
        shiftHoldTimer.current = null;
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        // Cancel hold timer if Shift was released before it fired
        if (shiftHoldTimer.current) {
          clearTimeout(shiftHoldTimer.current);
          shiftHoldTimer.current = null;
        }
        if (shiftNavActive.current) {
          // Release Shift — select the highlighted session and close
          shiftNavActive.current = false;
          setShiftNavIdx(idx => {
            if (idx >= 0 && idx < sessions.length) {
              onSelectSession(sessions[idx].id);
            }
            return -1;
          });
          setMenuOpen(false);
        }
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      if (shiftHoldTimer.current) clearTimeout(shiftHoldTimer.current);
    };
  }, [sessions, activeSessionId, onSelectSession]);

  const handleEnter = useCallback((id: string) => {
    if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null; }
    setHoveredId(id);
  }, []);

  const handleLeave = useCallback(() => {
    leaveTimer.current = setTimeout(() => setHoveredId(null), 80);
  }, []);

  const handleBrowse = useCallback(async () => {
    try {
      const folder = await (window as any).claude.dialog.openFolder();
      if (folder) setNewCwd(folder);
    } catch {}
  }, []);

  const handleMenuToggle = useCallback(() => {
    setMenuOpen(prev => !prev);
    setShowNewForm(false);
  }, []);

  const handleCreate = useCallback(() => {
    onCreateSession(newCwd, dangerous, newModel);
    setMenuOpen(false);
    setShowNewForm(false);
    setDangerous(defaultSkipPermissions || false);
    setNewModel(defaultModel || 'sonnet');
  }, [newCwd, dangerous, newModel, onCreateSession, defaultSkipPermissions, defaultModel]);

  /* ── Pointer-event drag handlers ───────────────────────── */

  const handlePointerDown = useCallback((e: React.PointerEvent, sessionId: string) => {
    // Only primary button
    if (e.button !== 0) return;
    dragOrigin.current = { x: e.clientX, y: e.clientY };
    isDragging.current = false;

    // Resolve canonical index from the full sessions array (visibleSessions
    // may be a filtered subset on Android, so raw map idx can't be trusted).
    const idx = sessions.findIndex(s => s.id === sessionId);
    if (idx === -1) return;
    const s = sessions[idx];
    // Capture label + color eagerly so pointermove can start immediately
    setDragIdx(idx);
    setDragLabel(s.name);
    setDragColor(sessionStatuses?.get(s.id) || 'gray');

    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [sessions, sessionStatuses]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (dragIdx === null || !dragOrigin.current) return;

    // Require 5px movement to start drag (prevents accidental drags on click)
    if (!isDragging.current) {
      const dx = e.clientX - dragOrigin.current.x;
      const dy = e.clientY - dragOrigin.current.y;
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      isDragging.current = true;
      suppressClick.current = true;
    }

    setDragPos({ x: e.clientX, y: e.clientY });

    // Hit-test: find nearest pill by horizontal distance (Y-independent, wide pickup range)
    const bar = pillBarRef.current;
    if (!bar) return;
    const els = bar.querySelectorAll('[data-session-idx]');

    let closest: number | null = null;
    let closestDist = Infinity;
    const pillRects: { idx: number; rect: DOMRect }[] = [];

    els.forEach(el => {
      const idx = parseInt((el as HTMLElement).dataset.sessionIdx!, 10);
      const rect = el.getBoundingClientRect();
      pillRects.push({ idx, rect });
      const centerX = (rect.left + rect.right) / 2;
      const dist = Math.abs(e.clientX - centerX);
      if (idx !== dragIdx && dist < closestDist) {
        closestDist = dist;
        closest = idx;
      }
    });

    setOverIdx(closest);

    // Compute ghost target position — snap to the insertion gap between pills
    if (closest !== null) {
      const targetIdx = closest; // const for TS narrowing in callbacks
      pillRects.sort((a, b) => a.idx - b.idx);
      const barRect = bar.getBoundingClientRect();
      const y = (barRect.top + barRect.bottom) / 2;
      let x: number;

      if (targetIdx < dragIdx) {
        // Ghost appears before the target pill (item moves left)
        const target = pillRects.find(r => r.idx === targetIdx)!;
        const prev = pillRects.find(r => r.idx === targetIdx - 1);
        x = prev ? (prev.rect.right + target.rect.left) / 2 : target.rect.left - 16;
      } else {
        // Ghost appears after the target pill (item moves right)
        const target = pillRects.find(r => r.idx === targetIdx)!;
        const next = pillRects.find(r => r.idx === targetIdx + 1);
        x = next ? (target.rect.right + next.rect.left) / 2 : target.rect.right + 16;
      }

      setGhostTarget({ x, y });
    } else {
      setGhostTarget(null);
    }
  }, [dragIdx]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (dragIdx !== null && isDragging.current) {
      // Reorder if dropped on a different position
      if (overIdx !== null && onReorderSessions) {
        onReorderSessions(dragIdx, overIdx);
      }
      // Select the dragged session so it stays active after drop
      const draggedSession = sessions[dragIdx];
      if (draggedSession) {
        onSelectSession(draggedSession.id);
      }
    }
    // Reset all drag state
    setDragIdx(null);
    setOverIdx(null);
    setDragPos(null);
    setGhostTarget(null);
    dragOrigin.current = null;
    isDragging.current = false;

    // Allow the suppressClick flag to clear after the click event fires
    setTimeout(() => { suppressClick.current = false; }, 0);
  }, [dragIdx, overIdx, onReorderSessions, sessions, onSelectSession]);

  const handleClick = useCallback((id: string) => {
    if (suppressClick.current) return;
    onSelectSession(id);
  }, [onSelectSession]);

  const isCompact = useIsCompact();

  if (sessions.length === 0) return null;

  // Compact mode (Android + narrow desktop): show only the active session pill
  const visibleSessions = isCompact
    ? sessions.filter(s => s.id === activeSessionId)
    : sessions;
  const allExpanded = !isCompact && sessions.length <= 3;
  const dragging = dragIdx !== null && isDragging.current && dragPos !== null;

  return (
    <>
      <div ref={pillBarRef} className="session-strip flex items-center gap-0.5 bg-inset rounded-full px-1.5 py-0.5 overflow-hidden min-w-0 shrink">
        {/* ── Session pills ──────────────────────────────── */}
        {visibleSessions.map((s, idx) => {
          const color = sessionStatuses?.get(s.id) || 'gray';
          const isActive = s.id === activeSessionId;
          const isHovered = hoveredId === s.id;
          const showName = allExpanded || isHovered || isActive;
          const isBeingDragged = dragIdx === idx && isDragging.current;
          const isOver = overIdx === idx;

          return (
            <React.Fragment key={s.id}>
              <button
                data-session-idx={idx}
                onPointerDown={(e) => handlePointerDown(e, s.id)}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onClick={() => handleClick(s.id)}
                onMouseEnter={allExpanded ? undefined : () => handleEnter(s.id)}
                onMouseLeave={allExpanded ? undefined : handleLeave}
                className={`
                  relative flex items-center gap-1 rounded-full px-1.5 py-px
                  border select-none touch-none overflow-hidden
                  ${showName && (isActive || !allExpanded)
                    ? 'border-edge bg-panel'
                    : 'border-transparent'
                  }
                  ${isBeingDragged ? 'opacity-30 scale-95' : ''}
                `}
                style={{
                  transition: isBeingDragged
                    ? 'opacity 150ms, transform 150ms'
                    : 'all 150ms cubic-bezier(0.34, 1.56, 0.64, 1)',
                  transform: (!isBeingDragged && isHovered && !isActive) ? 'scale(1.02)' : undefined,
                  boxShadow: (!isCompact && isActive) ? GLOW_SHADOW[color] : undefined,
                  cursor: 'default',
                }}
                title={s.name}
              >
                <SessionDot color={color} isActive={isActive} />
                <span
                  className="text-xs font-medium text-fg-2 whitespace-nowrap overflow-hidden text-ellipsis"
                  style={{
                    maxWidth: showName
                      ? (isActive ? 'none' : 120)
                      : 0,
                    opacity: showName ? 1 : 0,
                    transition: allExpanded ? 'none' : 'max-width 200ms ease, opacity 150ms ease',
                  }}
                >
                  {s.name}
                </span>
                {/* Active indicator bar — removed (dot is sufficient) */}
              </button>
            </React.Fragment>
          );
        })}

        {/* ── Dropdown trigger ───────────────────────────── */}
        <div ref={menuRef}>
          <button
            ref={triggerBtnRef}
            onClick={handleMenuToggle}
            className="flex items-center justify-center w-5 h-5 ml-1 rounded-sm hover:bg-inset transition-colors text-fg-muted hover:text-fg-2"
            title="All Sessions"
          >
            <svg className={`w-3 h-3 transition-transform ${menuOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── Dropdown menu (portal — escapes overflow-hidden + backdrop-filter) ── */}
      {menuOpen && createPortal(
        <div
          ref={dropdownRef}
          className="fixed w-72 bg-panel border border-edge rounded-lg shadow-lg overflow-hidden z-[9000]"
          style={(() => {
            const triggerRect = triggerBtnRef.current?.getBoundingClientRect();
            const pillRect = pillBarRef.current?.getBoundingClientRect();
            const pillCenter = pillRect
              ? pillRect.left + pillRect.width / 2
              : undefined;
            const halfDropdown = 144; // w-72 = 288px / 2
            return {
              top: triggerRect ? triggerRect.bottom + 4 : 0,
              left: pillCenter != null
                ? Math.min(Math.max(halfDropdown, pillCenter), window.innerWidth - halfDropdown)
                : '50%',
              transform: 'translateX(-50%)',
              animation: 'dropdown-in 120ms cubic-bezier(0.16, 1, 0.3, 1) both',
            };
          })()}
        >
          {sessions.length > 0 && (
            <div className="py-1">
              {sessions.map((s, idx) => {
                const color = sessionStatuses?.get(s.id) || 'gray';
                const isBeingDragged = dragIdx === idx && isDragging.current;
                const isOver = overIdx === idx;
                return (
                  <div
                    key={s.id}
                    data-session-idx={idx}
                    ref={shiftNavIdx === idx ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                    onPointerDown={(e) => handlePointerDown(e, s.id)}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    className={`relative flex items-center pr-1 group/row select-none touch-none ${
                      shiftNavIdx === idx
                        ? 'bg-accent/20 text-fg'
                        : s.id === activeSessionId
                          ? 'bg-inset text-fg'
                          : 'text-fg-dim hover:bg-inset hover:text-fg'
                    } ${isBeingDragged ? 'opacity-30' : ''}`}
                    style={{
                      animation: `row-fade-in 100ms ease both`,
                      animationDelay: `${idx * 20}ms`,
                      transition: 'opacity 150ms, background 150ms',
                      cursor: 'default',
                    }}
                  >
                    {/* Drag grip — visible on hover */}
                    <span className={`shrink-0 flex items-center pl-1.5 transition-opacity ${isAndroid() ? 'hidden' : 'opacity-0 group-hover/row:opacity-100'}`}>
                      <DragGrip />
                    </span>
                    <button
                      onClick={() => { if (!suppressClick.current) { onSelectSession(s.id); setMenuOpen(false); } }}
                      className="flex-1 text-left pl-1 pr-3 py-2 flex items-center gap-2 min-w-0"
                    >
                      <SessionDot color={color} isActive={s.id === activeSessionId} />
                      <span className="text-[13px] leading-snug flex-1 min-w-0 line-clamp-2">{s.name}</span>
                      <span className="shrink-0 flex items-center gap-1.5 ml-auto">
                        {s.permissionMode === 'bypass' && (
                          <span className="text-[9px] font-medium px-1 py-0.5 rounded-sm bg-[#DD4444]/20 text-[#DD4444]">
                            DANGER
                          </span>
                        )}
                        <span className="text-[10px] text-fg-faint whitespace-nowrap">
                          {s.cwd.replace(/\\/g, '/').split('/').pop()}
                        </span>
                      </span>
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); if (!suppressClick.current) onCloseSession(s.id); }}
                      onPointerDown={(e) => e.stopPropagation()}
                      className="shrink-0 w-5 h-5 flex items-center justify-center rounded-sm text-fg-faint hover:text-[#DD4444] hover:bg-inset opacity-0 group-hover/row:opacity-100 transition-all"
                      title="Close Session"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="border-t border-edge" />

          {showNewForm ? (
            <div className="p-3 flex flex-col gap-2">
              <div>
                <label className="text-[10px] uppercase tracking-wider text-fg-muted mb-1 block">Project Folder</label>
                <button
                  onClick={handleBrowse}
                  className="w-full text-left px-2.5 py-1.5 bg-inset border border-edge rounded-md text-xs text-fg-2 hover:border-edge transition-colors truncate"
                >
                  {newCwd || 'Select folder...'}
                </button>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-fg-muted mb-1 block">Model</label>
                <div className="flex gap-1">
                  {MODELS.map((m) => (
                    <button
                      key={m}
                      onClick={() => setNewModel(m)}
                      className={`flex-1 px-1 py-1 rounded-sm text-[10px] transition-colors ${
                        newModel === m
                          ? 'bg-accent text-on-accent font-medium'
                          : 'bg-inset text-fg-dim hover:bg-edge'
                      }`}
                    >
                      {MODEL_LABELS[m] || m}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center justify-between">
                <label className="text-[10px] uppercase tracking-wider text-fg-muted">Skip Permissions</label>
                <button
                  onClick={() => setDangerous(!dangerous)}
                  className={`w-8 h-4.5 rounded-full relative transition-colors ${dangerous ? 'bg-[#DD4444]' : 'bg-inset'}`}
                >
                  <span className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${dangerous ? 'left-[calc(100%-16px)]' : 'left-0.5'}`} />
                </button>
              </div>
              {dangerous && (
                <p className="text-[10px] text-[#DD4444]">Claude will execute tools without asking for approval.</p>
              )}
              <button
                onClick={handleCreate}
                className={`w-full text-sm font-medium rounded-md py-1.5 transition-colors ${
                  dangerous
                    ? 'bg-[#DD4444] hover:bg-[#E55555] text-white'
                    : 'bg-accent hover:bg-accent text-on-accent'
                }`}
              >
                {dangerous ? 'Create (Dangerous)' : 'Create Session'}
              </button>
            </div>
          ) : (
            <div className="flex">
              <button
                onClick={() => { setMenuOpen(false); onOpenResumeBrowser(); }}
                className="flex-1 px-3 py-2 text-sm text-fg-dim hover:bg-inset hover:text-fg transition-colors flex items-center justify-center gap-1.5"
              >
                <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span>Resume</span>
              </button>
              {/* Gradient divider */}
              <div className="w-px my-0.5" style={{ background: 'linear-gradient(to bottom, transparent, var(--fg-faint), transparent)' }} />
              <button
                onClick={() => {
                  setNewCwd(defaultProjectFolder || '');
                  setDangerous(defaultSkipPermissions || false);
                  setNewModel(defaultModel || 'sonnet');
                  setShowNewForm(true);
                }}
                className="flex-1 px-3 py-2 text-sm text-fg-dim hover:bg-inset hover:text-fg transition-colors flex items-center justify-center gap-1.5"
              >
                <span className="text-base leading-none">+</span>
                <span>New Session</span>
              </button>
            </div>
          )}
        </div>,
        document.body
      )}

      {/* ── Insertion indicator — shows where the pill will land ── */}
      {dragging && ghostTarget && (
        <div
          className="fixed z-[9998] pointer-events-none"
          style={{
            left: ghostTarget.x,
            top: ghostTarget.y,
            transform: 'translate(-50%, -50%)',
            transition: 'left 120ms cubic-bezier(0.34, 1.56, 0.64, 1), top 120ms ease',
          }}
        >
          <div className="w-0.5 h-4 rounded-full bg-accent" style={{ opacity: 0.8 }} />
        </div>
      )}

      {/* ── Floating drag ghost — follows cursor freely ──── */}
      {dragging && dragPos && (
        <div
          className="fixed z-[9999] pointer-events-none flex items-center gap-1.5 rounded-full px-2.5 py-1 bg-inset border border-edge shadow-lg shadow-black/40"
          style={{
            left: dragPos.x,
            top: dragPos.y,
            transform: 'translate(-50%, -50%) scale(1.05)',
          }}
        >
          <SessionDot color={dragColor} isActive />
          <span className="text-xs font-medium text-fg whitespace-nowrap max-w-[180px] truncate">
            {dragLabel}
          </span>
        </div>
      )}
    </>
  );
}
