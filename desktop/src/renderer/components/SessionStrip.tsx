import React, { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { SessionStatusColor } from './StatusDot';
import { isAndroid } from '../platform';
import { MODELS, type ModelAlias } from './StatusBar';
import FolderSwitcher from './FolderSwitcher';
import { ModelInfoTooltip } from './ModelPickerPopup';
import { SkipPermissionsInfoTooltip } from './SkipPermissionsInfoTooltip';
import { packSessions, type SessionMeasurement, type PackResult } from './header/pack-sessions';
import { useScrollFade } from '../hooks/useScrollFade';

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
  onCreateSession: (cwd: string, dangerous: boolean, model: string, provider?: 'claude' | 'gemini', launchInNewWindow?: boolean) => void;
  onCloseSession: (id: string) => void;
  sessionStatuses?: Map<string, SessionStatusColor>;
  onResumeSession: (sessionId: string, projectSlug: string, projectPath: string, model?: string, dangerous?: boolean) => void;
  onOpenResumeBrowser: () => void;
  onReorderSessions?: (fromIndex: number, toIndex: number) => void;
  defaultModel?: string;
  defaultSkipPermissions?: boolean;
  defaultProjectFolder?: string;
  /** When true, show Gemini CLI toggle in new session form */
  geminiEnabled?: boolean;
  /** Window directory (for switcher's "Sessions in other windows" group). */
  windowDirectory?: {
    leaderWindowId: number;
    windows: { window: { id: number; label: string; createdAt: number }; sessions: SessionEntry[] }[];
  } | null;
  /** This renderer's own window id — excluded from remote sessions group. */
  myWindowId?: number | null;
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

/* ── Adaptive session name — shrinks font / adds lines to fit ── */

function SessionName({ name }: { name: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [fontSize, setFontSize] = useState(13);

  // After mount (and on name change), check if the text overflows at
  // the default 13px size.  If so, step down to 11px so the full name
  // is always readable.  Three lines at 11px comfortably fits names up
  // to ~60 chars in the available width.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Reset to default size before measuring
    setFontSize(13);
    // Measure after the browser paints at 13px
    requestAnimationFrame(() => {
      if (!el) return;
      if (el.scrollHeight > el.clientHeight) {
        setFontSize(11);
      }
    });
  }, [name]);

  return (
    <span
      ref={ref}
      className="leading-snug flex-1 min-w-0"
      style={{
        fontSize: `${fontSize}px`,
        display: '-webkit-box',
        WebkitLineClamp: 3,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
        wordBreak: 'break-word',
      }}
    >
      {name}
    </span>
  );
}

/* ── Main component ──────────────────────────────────────── */

export default function SessionStrip({
  sessions, activeSessionId, onSelectSession,
  onCreateSession, onCloseSession, sessionStatuses, onResumeSession,
  onOpenResumeBrowser, onReorderSessions,
  defaultModel, defaultSkipPermissions, defaultProjectFolder,
  geminiEnabled,
  windowDirectory, myWindowId,
}: Props) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [shiftNavIdx, setShiftNavIdx] = useState<number>(-1);
  const shiftNavActive = useRef(false);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newCwd, setNewCwd] = useState('');
  const [dangerous, setDangerous] = useState(false);
  const [newModel, setNewModel] = useState<string>('sonnet');
  // Gemini CLI session toggle — only visible when enabled in settings
  const [isGemini, setIsGemini] = useState(false);
  // Launch the new session in its own peer window instead of this one.
  // Hidden on platforms without multi-window support (Android / remote-shim).
  const [launchInNewWindow, setLaunchInNewWindow] = useState(false);
  const detachAvailable = typeof (window as any).claude?.detach?.openDetached === 'function';
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerBtnRef = useRef<HTMLButtonElement>(null);
  const pillBarRef = useRef<HTMLDivElement>(null);
  const sessionListRef = useScrollFade<HTMLDivElement>();

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
  // Chrome-style live tear-off: once the user drags the pill far enough below
  // the header, we spawn the new window mid-drag and stream cursor positions
  // to it so it follows the mouse. Ref (not state) because we read/write it
  // from pointermove without wanting a re-render per frame. `pending` guards
  // the async spawn so we only fire the IPC once per drag.
  const liveDetachedWindowId = useRef<number | null>(null);
  const liveDetachPending = useRef(false);
  // Where inside the grabbed pill the cursor sits when pointerdown fires.
  // Reused during live tear-off to position the new window so the cursor ends
  // up over the *same spot* on the torn-off pill, not the window's corner.
  const grabOffsetInPill = useRef<{ x: number; y: number }>({ x: 40, y: 12 });
  const pointerCaptureEl = useRef<HTMLElement | null>(null);
  const pointerCaptureId = useRef<number | null>(null);
  // Cross-window re-dock: true while another window is dragging a pill and
  // the cursor is currently over this window's strip. Drives a visual drop-
  // target highlight. Cleared on any non-hover tick or when the drag ends.
  const [incomingDropActive, setIncomingDropActive] = useState(false);

  // Listen for cross-window cursor updates from main — fires ~30Hz while
  // a peer window is dragging a pill. We hit-test each update against our
  // own strip's bounding box to decide whether to show the drop highlight.
  useEffect(() => {
    const det = (window as any).claude?.detach;
    if (!det?.onCrossWindowCursor) return;
    const unsub = det.onCrossWindowCursor(({ screenX, screenY }: { screenX: number; screenY: number }) => {
      const bar = pillBarRef.current;
      if (!bar) { setIncomingDropActive(false); return; }
      // Ignore cursor broadcasts originating from our own drag — the source
      // window also receives these but shouldn't highlight its own strip.
      if (isDragging.current) { setIncomingDropActive(false); return; }
      const rect = bar.getBoundingClientRect();
      const localX = screenX - window.screenX;
      const localY = screenY - window.screenY;
      const inside =
        localX >= rect.left && localX <= rect.right &&
        localY >= rect.top && localY <= rect.bottom;
      setIncomingDropActive(inside);
    });
    return () => { try { unsub?.(); } catch {} setIncomingDropActive(false); };
  }, []);

  // Home path is now auto-selected by FolderSwitcher on mount

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
          shiftHoldTimer.current = null;
          shiftNavActive.current = true;
          const currentIdx = sessions.findIndex(s => s.id === activeSessionId);
          setShiftNavIdx(currentIdx >= 0 ? currentIdx : 0);
          setMenuOpen(true);
        }, 350);
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

      // Any other key while Shift is held — cancel switcher (timer or already open)
      if (shiftHoldTimer.current) {
        clearTimeout(shiftHoldTimer.current);
        shiftHoldTimer.current = null;
      }
      if (shiftNavActive.current) {
        shiftNavActive.current = false;
        setShiftNavIdx(-1);
        setMenuOpen(false);
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


  const handleMenuToggle = useCallback(() => {
    setMenuOpen(prev => !prev);
    setShowNewForm(false);
  }, []);

  const handleCreate = useCallback(() => {
    onCreateSession(newCwd, dangerous, newModel, isGemini ? 'gemini' : 'claude', launchInNewWindow);
    setMenuOpen(false);
    setShowNewForm(false);
    setDangerous(defaultSkipPermissions || false);
    setNewModel(defaultModel || 'sonnet');
    setIsGemini(false);
    setLaunchInNewWindow(false);
  }, [newCwd, dangerous, newModel, isGemini, launchInNewWindow, onCreateSession, defaultSkipPermissions, defaultModel]);

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

    // Measure where in the pill the cursor landed. Used when the live-detach
    // spawns a new window: we offset that window's screen position so the
    // cursor stays over the pill, not the window's top-left corner.
    const pillEl = (e.target as HTMLElement).closest('[data-session-idx]') as HTMLElement | null;
    if (pillEl) {
      const r = pillEl.getBoundingClientRect();
      grabOffsetInPill.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    // Capture on the strip container (not the pill) so capture survives when
    // the pill unmounts after ownership transfer during a live tear-off. If
    // we captured on the pill itself, unmounting would release capture and
    // the new window would stop following the cursor mid-drag.
    const captureEl = (pillBarRef.current ?? (e.target as HTMLElement)) as HTMLElement;
    try { captureEl.setPointerCapture(e.pointerId); } catch { /* container not capturable */ }
    pointerCaptureEl.current = captureEl;
    pointerCaptureId.current = e.pointerId;
  }, [sessions, sessionStatuses]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    // Live tear-off continuation — runs even after we've cleared dragIdx so the
    // detached window keeps following the cursor. Must be checked BEFORE the
    // dragIdx null-guard below.
    if (liveDetachedWindowId.current !== null) {
      (window as any).claude?.detach?.dragWindowMove?.({
        windowId: liveDetachedWindowId.current,
        screenX: e.screenX,
        screenY: e.screenY,
        offsetX: grabOffsetInPill.current.x,
        offsetY: grabOffsetInPill.current.y,
      });
      return;
    }

    if (dragIdx === null || !dragOrigin.current) return;

    // Require 5px movement to start drag (prevents accidental drags on click)
    if (!isDragging.current) {
      const dx = e.clientX - dragOrigin.current.x;
      const dy = e.clientY - dragOrigin.current.y;
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      isDragging.current = true;
      suppressClick.current = true;
      // Tell main this is a real drag — it starts the cross-window cursor
      // ticker so peer windows can highlight their strip as a drop target.
      const draggedSession = sessions[dragIdx];
      (window as any).claude?.detach?.dragStarted?.({ sessionId: draggedSession.id });
    }

    setDragPos({ x: e.clientX, y: e.clientY });

    // Chrome-style live tear-off. Once the pill has been dragged past the
    // header (cursor Y below the strip's bottom by >= 60px, or outside the
    // source window entirely), spawn the peer window NOW instead of waiting
    // for pointerup. Subsequent pointermove frames hit the early-return block
    // at the top of this callback and stream cursor positions to the new window.
    const bar = pillBarRef.current;
    // Don't allow tearing off the only session in a window — matches Chrome
    // (a single tab can't be torn out of its window) and avoids the broken
    // click-through state when the source window empties mid-drag.
    if (!liveDetachPending.current && bar && dragIdx !== null && sessions.length > 1) {
      const stripRect = bar.getBoundingClientRect();
      const outsideOwnWindow =
        e.clientY < 0 || e.clientY > window.innerHeight ||
        e.clientX < 0 || e.clientX > window.innerWidth;
      // 60px past the strip's bottom ≈ "this pill is clearly not in the strip
      // anymore" without being so eager that a fumbled drag tears a window.
      const belowStrip = e.clientY > stripRect.bottom + 60;
      if (belowStrip || outsideOwnWindow) {
        liveDetachPending.current = true;
        const draggedSession = sessions[dragIdx];
        const det = (window as any).claude?.detach;
        if (det?.detachLive) {
          det.detachLive({
            sessionId: draggedSession.id,
            screenX: e.screenX,
            screenY: e.screenY,
            offsetX: grabOffsetInPill.current.x,
            offsetY: grabOffsetInPill.current.y,
          }).then((res: { windowId: number }) => {
            liveDetachedWindowId.current = res?.windowId ?? null;
            // Clear the source window's drag UI immediately. The pill has moved
            // to the detached window; the floating ghost shouldn't linger.
            // Pointer capture stays on pillBarRef so the source keeps getting
            // pointermove (via Electron's mouse passthrough on the new window)
            // and fires pointerup when the user releases.
            setDragIdx(null);
            setOverIdx(null);
            setDragPos(null);
            setGhostTarget(null);
          }).catch(() => {
            liveDetachPending.current = false;
          });
        }
        return;
      }
    }

    // Hit-test: find nearest pill by horizontal distance (Y-independent, wide pickup range)
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
    const wasDragging = isDragging.current;
    const releasedDragIdx = dragIdx;
    const releasedOverIdx = overIdx;
    const releasedSession = releasedDragIdx !== null ? sessions[releasedDragIdx] : null;
    const wasLiveDetached = liveDetachedWindowId.current !== null;

    // Reset all local drag state immediately so the UI snaps back cleanly.
    // We do the cross-window resolution async below using the captured values.
    setDragIdx(null);
    setOverIdx(null);
    setDragPos(null);
    setGhostTarget(null);
    dragOrigin.current = null;
    isDragging.current = false;
    liveDetachedWindowId.current = null;
    liveDetachPending.current = false;
    setTimeout(() => { suppressClick.current = false; }, 0);

    // Always notify main that the drag ended — even when live-detach already
    // cleared dragIdx (so releasedSession is null). Main relies on this to
    // turn off mouse-passthrough on the detached window and focus it. Skipping
    // it leaves the new window click-through forever.
    const det = (window as any).claude?.detach;
    if (wasDragging) det?.dragEnded?.();

    // Chrome-style live tear-off already spawned the new window and handed off
    // ownership mid-drag — nothing to resolve on release.
    if (wasLiveDetached) return;

    // Pointer capture is set on the strip container (not the pill button) so
    // that capture survives live tear-off ownership transfer. Side-effect: the
    // browser won't synthesize a click event on the button after pointerup
    // (click requires the same physical target for both down and up). Handle
    // session selection here for the no-drag case instead of relying on onClick.
    if (!wasDragging) {
      if (releasedSession) {
        suppressClick.current = true; // guard against onClick double-fire
        onSelectSession(releasedSession.id);
      }
      return;
    }

    if (!releasedSession) return;

    // Resolve drop across all peer windows: main hit-tests [data-session-strip]
    // in each window against the current cursor. If a hit, re-dock there;
    // if no hit and the cursor is outside our own viewport, detach to a
    // new peer window; otherwise fall through to the local reorder path.
    const clientX = e.clientX;
    const clientY = e.clientY;
    const outsideOwnWindow =
      clientX < 0 || clientY < 0 ||
      clientX > window.innerWidth || clientY > window.innerHeight;

    const resolveAndRoute = async () => {
      let resolved: { targetWindowId: number | null } = { targetWindowId: null };
      try { resolved = await det?.dropResolve?.(); } catch { /* fall through */ }

      const myId = (window as any).__youcodedWindowId;
      const target = resolved?.targetWindowId;

      if (target != null && target !== myId) {
        // Dropped on a peer window's strip → re-dock
        det?.dragDropped?.({ sessionId: releasedSession.id, targetWindowId: target, insertIndex: 0 });
        return;
      }
      // Dropped outside any window's strip → spawn new peer window. Skip if
      // this would empty the source window (matches the live-tear-off rule:
      // can't tear off a window's only session).
      if (outsideOwnWindow && sessions.length > 1) {
        const screenX = (e as any).screenX ?? (window.screenX + clientX);
        const screenY = (e as any).screenY ?? (window.screenY + clientY);
        det?.detachStart?.({ sessionId: releasedSession.id, screenX, screenY });
        return;
      }
      // Local drop → reorder within this window's strip (existing behavior)
      if (releasedOverIdx !== null && onReorderSessions && releasedDragIdx !== null) {
        onReorderSessions(releasedDragIdx, releasedOverIdx);
      }
      onSelectSession(releasedSession.id);
    };

    // If detach IPC isn't available (remote-shim / Android), fall back to
    // the legacy local-only behavior.
    if (!det?.dropResolve) {
      if (releasedOverIdx !== null && onReorderSessions && releasedDragIdx !== null) {
        onReorderSessions(releasedDragIdx, releasedOverIdx);
      }
      onSelectSession(releasedSession.id);
      return;
    }

    resolveAndRoute();
  }, [dragIdx, overIdx, onReorderSessions, sessions, onSelectSession]);

  const handleClick = useCallback((id: string) => {
    if (suppressClick.current) return;
    onSelectSession(id);
  }, [onSelectSession]);

  // --- Space-aware packing ---
  // We measure each pill's expanded width offscreen using a hidden canvas
  // (no layout thrash). Collapsed width is constant (dot + padding ≈ 24 px).
  const [pack, setPack] = useState<PackResult>({
    expanded: new Set(),
    collapsed: sessions.map(s => s.id),
    overflow: [],
  });

  // Persistent measuring canvas — exists once per component, reused.
  const measureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  if (measureCanvasRef.current === null && typeof document !== 'undefined') {
    measureCanvasRef.current = document.createElement('canvas');
  }

  const measureExpandedWidth = useCallback((name: string): number => {
    const canvas = measureCanvasRef.current;
    if (!canvas) return 120; // fallback
    const ctx = canvas.getContext('2d');
    if (!ctx) return 120;
    // Match the pill's label styling: text-xs = 12px, medium weight.
    ctx.font = '500 12px system-ui, -apple-system, sans-serif';
    const textWidth = ctx.measureText(name).width;
    // Pill chrome: 6px left pad + dot (10) + 4px gap + text + 6px right pad + 2px border.
    return Math.ceil(textWidth + 28);
  }, []);

  const repack = useCallback(() => {
    const bar = pillBarRef.current;
    if (!bar) return;
    // Fix: read the flex-1 wrapper's allocated width, not the strip's own
    // content width. Without this, the budget equals whatever 1 pill happens
    // to occupy — a chicken-and-egg that prevents a 2nd pill from ever
    // appearing (2nd session would need space that wasn't measured yet).
    const budget = bar.parentElement?.clientWidth ?? bar.clientWidth;
    const measurements: SessionMeasurement[] = sessions.map(s => ({
      id: s.id,
      expandedWidth: measureExpandedWidth(s.name),
      collapsedWidth: 24, // dot (10) + horizontal padding (12) + border (2)
    }));
    const result = packSessions({
      sessions: measurements,
      activeId: activeSessionId,
      budget,
      gap: 2,          // matches gap-0.5 on the strip
      triggerWidth: 24, // ▾ button is w-5 + ml-1
    });
    setPack(result);
  }, [sessions, activeSessionId, measureExpandedWidth]);

  // Pack on mount, on session-list change, and on any container resize.
  useLayoutEffect(() => { repack(); }, [repack]);
  useEffect(() => {
    const bar = pillBarRef.current;
    if (!bar) return;
    // Observe the wrapper (parentElement), not the strip itself. The strip is
    // content-sized and never grows on its own, so observing it would never
    // fire when more space becomes available.
    const target = bar.parentElement ?? bar;
    const ro = new ResizeObserver(() => repack());
    ro.observe(target);
    return () => ro.disconnect();
  }, [repack]);

  // Android always forces single-session mode (no room for siblings on mobile chrome).
  const forceSingle = isAndroid();
  const visibleSessions = forceSingle
    ? sessions.filter(s => s.id === activeSessionId)
    : sessions.filter(s => pack.expanded.has(s.id) || pack.collapsed.includes(s.id));

  if (sessions.length === 0) return null;

  const dragging = dragIdx !== null && isDragging.current && dragPos !== null;

  return (
    <>
      <div
        ref={pillBarRef}
        data-session-strip
        // Pointer capture is set on this container during drag (see handlePointerDown).
        // React's event delegation still fires the pill's onPointerMove/onPointerUp
        // because events bubble up through the captured element, but we also listen
        // here as a safety net in case the pill unmounts mid-drag (live tear-off).
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        className={`session-strip flex items-center gap-0.5 bg-inset rounded-full px-1.5 py-0.5 overflow-hidden min-w-0 shrink transition-shadow ${incomingDropActive ? 'ring-2 ring-accent/70' : ''}`}
      >
        {/* ── Session pills ──────────────────────────────── */}
        {visibleSessions.map((s, idx) => {
          const color = sessionStatuses?.get(s.id) || 'gray';
          const isActive = s.id === activeSessionId;
          const isHovered = hoveredId === s.id;
          const showName = forceSingle
            ? isActive
            : pack.expanded.has(s.id) || isHovered || isActive;
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
                onMouseEnter={pack.expanded.has(s.id) ? undefined : () => handleEnter(s.id)}
                onMouseLeave={pack.expanded.has(s.id) ? undefined : handleLeave}
                className={`
                  relative flex items-center gap-1 rounded-full px-1.5 py-px
                  border select-none touch-none overflow-hidden
                  ${isActive ? 'min-w-0 shrink' : 'shrink-0'}
                  ${showName && (isActive || !pack.expanded.has(s.id))
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
                  boxShadow: (!forceSingle && isActive) ? GLOW_SHADOW[color] : undefined,
                  cursor: 'default',
                }}
                title={s.name}
              >
                <SessionDot color={color} isActive={isActive} />
                <span
                  className={`text-xs font-medium text-fg-2 whitespace-nowrap overflow-hidden text-ellipsis ${isActive ? 'min-w-0' : ''}`}
                  style={{
                    // Active pill flex-shrinks so ellipsis kicks in when the
                    // strip is narrower than the full name (no hard cap).
                    maxWidth: showName
                      ? (isActive ? undefined : 120)
                      : 0,
                    opacity: showName ? 1 : 0,
                    transition: pack.expanded.has(s.id) ? 'none' : 'max-width 200ms ease, opacity 150ms ease',
                  }}
                >
                  {s.name}
                </span>
                {/* Active indicator bar — removed (dot is sufficient) */}
              </button>
            </React.Fragment>
          );
        })}

        {/* Overflow count: sessions open in this window that the strip couldn't fit.
            Purely an indicator — clicking the trigger (or this badge) opens the full list. */}
        {sessions.length - visibleSessions.length > 0 && (
          <button
            onClick={handleMenuToggle}
            className="inline-flex items-center justify-center min-w-[18px] h-[16px] px-1 ml-1 rounded-full bg-inset text-fg-2 text-[10px] font-semibold leading-none hover:bg-well transition-colors"
            title={`${sessions.length - visibleSessions.length} more session${sessions.length - visibleSessions.length === 1 ? '' : 's'}`}
            aria-label={`${sessions.length - visibleSessions.length} more sessions`}
          >
            +{sessions.length - visibleSessions.length}
          </button>
        )}

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
          className="glass-overlay overlay-no-drag fixed w-72 bg-panel border border-edge rounded-lg shadow-lg z-[9000] overflow-hidden"
          style={(() => {
            const triggerRect = triggerBtnRef.current?.getBoundingClientRect();
            const pillRect = pillBarRef.current?.getBoundingClientRect();
            const pillCenter = pillRect
              ? pillRect.left + pillRect.width / 2
              : undefined;
            const halfDropdown = 144; // w-72 = 288px / 2
            // Compute left-edge directly (no transform: translateX(-50%))
            // so backdrop-filter isn't broken by a persistent transform
            return {
              top: triggerRect ? triggerRect.bottom + 4 : 0,
              left: pillCenter != null
                ? Math.min(Math.max(0, pillCenter - halfDropdown), window.innerWidth - halfDropdown * 2)
                : `calc(50% - ${halfDropdown}px)`,
              animation: 'dropdown-in 120ms cubic-bezier(0.16, 1, 0.3, 1) both',
            };
          })()}
        >
          {sessions.length > 0 && (
            <>
              <div className="px-3 pt-1.5 text-[10px] uppercase tracking-wider text-fg-muted">
                Sessions in this window
              </div>
            </>
          )}
          {sessions.length > 0 && (
            <div ref={sessionListRef} className="scroll-fade py-1" style={{ maxHeight: 'min(336px, 50vh)' }}>
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
                      className="flex-1 text-left pl-1 pr-1.5 py-2 flex items-center gap-2 min-w-0"
                    >
                      <SessionDot color={color} isActive={s.id === activeSessionId} />
                      {/* Session name — shrinks font and allows up to 3 lines to
                          ensure the full name is always visible */}
                      <SessionName name={s.name} />
                      <span className="shrink-0 flex flex-col items-end gap-0.5 ml-auto">
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
                      // Close the dropdown so the CloseSessionPrompt (L2 popup)
                      // isn't competing with the still-open session menu above it.
                      onClick={(e) => { e.stopPropagation(); if (!suppressClick.current) { setMenuOpen(false); onCloseSession(s.id); } }}
                      onPointerDown={(e) => e.stopPropagation()}
                      className="shrink-0 w-5 h-5 flex items-center justify-center rounded-sm text-fg-faint hover:text-[#DD4444] hover:bg-inset opacity-0 group-hover/row:opacity-100 transition-opacity"
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

          {/* Sessions in other windows — only shown when the detach subsystem
              reports peer windows owning sessions. Selecting one tells main
              to focus that window and switch its active session. */}
          {(() => {
            const remoteGroups = (windowDirectory?.windows ?? [])
              .filter((w) => w.window.id !== myWindowId)
              .map((w) => ({
                label: w.window.label,
                windowId: w.window.id,
                sessions: w.sessions,
              }))
              .filter((g) => g.sessions.length > 0);
            if (remoteGroups.length === 0) return null;
            return (
              <>
                <div className="border-t border-edge" />
                <div className="px-3 pt-1.5 text-[10px] uppercase tracking-wider text-fg-muted">
                  Sessions in other windows
                </div>
                <div className="py-1">
                  {remoteGroups.flatMap((g) =>
                    g.sessions.map((s) => {
                      const color = sessionStatuses?.get(s.id) || 'gray';
                      return (
                        <button
                          key={s.id}
                          onClick={() => {
                            (window as any).claude?.detach?.focusAndSwitch?.({ windowId: g.windowId, sessionId: s.id });
                            setMenuOpen(false);
                          }}
                          className="w-full text-left pl-3 pr-2 py-2 flex items-center gap-2 text-fg-dim hover:bg-inset hover:text-fg transition-colors"
                        >
                          <SessionDot color={color} isActive={false} />
                          <SessionName name={s.name} />
                          <span className="ml-auto shrink-0 text-[10px] text-fg-faint whitespace-nowrap flex items-center gap-1">
                            <span>→</span>
                            <span>{g.label}</span>
                          </span>
                        </button>
                      );
                    }),
                  )}
                </div>
              </>
            );
          })()}

          <div className="border-t border-edge" />

          {showNewForm ? (
            <div className="p-3 flex flex-col gap-2 rounded-b-lg overflow-hidden">
              <div>
                <label className="text-[10px] uppercase tracking-wider text-fg-muted mb-1 block">Project Folder</label>
                <FolderSwitcher value={newCwd} onChange={setNewCwd} />
              </div>
              {/* Model selector — grayed out when Gemini is selected */}
              <div style={{ opacity: isGemini ? 0.4 : 1, pointerEvents: isGemini ? 'none' : 'auto', transition: 'opacity 200ms' }}>
                <label className="text-[10px] uppercase tracking-wider text-fg-muted mb-1 block">Model</label>
                <div className="flex gap-1">
                  {MODELS.map((m) => (
                    <button
                      key={m}
                      onClick={() => setNewModel(m)}
                      className={`flex-1 px-1 py-1 rounded-sm text-[10px] transition-colors flex items-center justify-center ${
                        newModel === m
                          ? 'bg-accent text-on-accent font-medium'
                          : 'bg-inset text-fg-dim hover:bg-edge'
                      }`}
                    >
                      {MODEL_LABELS[m] || m}
                      <ModelInfoTooltip model={m} />
                    </button>
                  ))}
                </div>
              </div>
              {/* Skip Permissions — grayed out when Gemini is selected */}
              <div className="flex items-center justify-between" style={{ opacity: isGemini ? 0.4 : 1, pointerEvents: isGemini ? 'none' : 'auto', transition: 'opacity 200ms' }}>
                <label className="text-[10px] uppercase tracking-wider text-fg-muted inline-flex items-center">
                  Skip Permissions
                  <SkipPermissionsInfoTooltip />
                </label>
                <button
                  onClick={() => setDangerous(!dangerous)}
                  className={`w-8 h-4.5 rounded-full relative transition-colors ${dangerous ? 'bg-[#DD4444]' : 'bg-inset'}`}
                >
                  <span className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${dangerous ? 'left-[calc(100%-16px)]' : 'left-0.5'}`} />
                </button>
              </div>
              {dangerous && !isGemini && (
                <p className="text-[10px] text-[#DD4444]">Claude will execute tools without asking for approval.</p>
              )}
              {/* Launch in new window — hidden on platforms without multi-window support */}
              {detachAvailable && (
                <div className="flex items-center justify-between">
                  <label className="text-[10px] uppercase tracking-wider text-fg-muted">Launch in New Window</label>
                  <button
                    onClick={() => setLaunchInNewWindow(!launchInNewWindow)}
                    className={`w-8 h-4.5 rounded-full relative transition-colors ${launchInNewWindow ? 'bg-accent' : 'bg-inset'}`}
                  >
                    <span className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${launchInNewWindow ? 'left-[calc(100%-16px)]' : 'left-0.5'}`} />
                  </button>
                </div>
              )}
              {/* Gemini CLI toggle — only visible when enabled in settings */}
              {geminiEnabled && (
                <div className="flex items-center justify-between">
                  <label className="text-[10px] uppercase tracking-wider text-fg-muted">Gemini CLI</label>
                  <button
                    onClick={() => {
                      const next = !isGemini;
                      setIsGemini(next);
                      // Gemini sessions don't support skip-permissions
                      if (next) setDangerous(false);
                    }}
                    className="w-8 h-4.5 rounded-full relative transition-colors"
                    style={{ backgroundColor: isGemini ? '#4285F4' : 'var(--inset)' }}
                  >
                    <span className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${isGemini ? 'left-[calc(100%-16px)]' : 'left-0.5'}`} />
                  </button>
                </div>
              )}
              <button
                onClick={handleCreate}
                className={`w-full text-sm font-medium rounded-md py-1.5 transition-colors ${
                  isGemini
                    ? 'text-white'
                    : dangerous
                      ? 'bg-[#DD4444] hover:bg-[#E55555] text-white'
                      : 'bg-accent hover:bg-accent text-on-accent'
                }`}
                style={isGemini ? { background: 'linear-gradient(135deg, #4285F4, #7B68EE)' } : undefined}
              >
                {isGemini ? 'Create Gemini Session' : dangerous ? 'Create (Dangerous)' : 'Create Session'}
              </button>
            </div>
          ) : (
            <div className="flex rounded-b-lg overflow-hidden">
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
                  setIsGemini(false);
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
        document.getElementById('root')! // Portal to #root (not body) so
        // backdrop-filter can sample the compositing tree for live content blur
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
