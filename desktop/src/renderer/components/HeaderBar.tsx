import { guardDirtyEditor } from './artifact-views/dirty-editor-guard';
import React, { useRef, useLayoutEffect, useEffect, useState } from 'react';
import { GamepadIcon } from './Icons';
import SessionStrip from './SessionStrip';
import type { SessionStatusColor } from './StatusDot';
import type { SessionProvider } from '../../shared/types';
import { isAndroid, isRemoteMode } from '../platform';
// Artifact drawer trigger — reads session artifact count for the badge.
import { useArtifact } from '../state/ArtifactContext';
import OverflowMenu from './OverflowMenu';
import NarrowViewToggle from './NarrowViewToggle';
import WideViewToggle from './WideViewToggle';
import { useArtifactCount } from '../hooks/useArtifactCount';
import { useNarrowViewport } from '../hooks/use-narrow-viewport';
import { Tooltip } from './ui';

const isMac = typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac');

/** Custom window caption buttons for Windows + Linux desktop. The Electron
 *  BrowserWindow is frameless (`frame: false`) on BOTH — so without these the
 *  window has no minimize/maximize/close at all. macOS uses native traffic
 *  lights, Android has no OS window chrome, remote runs in a browser tab.
 *
 *  Fix: this was gated to `navigator.platform === 'Win32'`, which left Linux
 *  (`navigator.platform` is e.g. `Linux x86_64`) with zero window controls on
 *  a frameless window. Gate on "desktop and not macOS" instead. */
const showCaptionButtons = typeof navigator !== 'undefined'
  && !isMac
  && !isAndroid()
  && !isRemoteMode();

/** Toggle sits on the opposite side of the OS window-control buttons
 *  so the header is balanced. macOS traffic lights live on the left,
 *  so the toggle goes right. Windows/Linux window controls live on
 *  the right, so the toggle goes left. Android has no OS window
 *  controls in-app, so the toggle goes right (matches Mac placement
 *  — don't let the Linux-based navigator.platform pull it left). */
const toggleOnLeft = typeof navigator !== 'undefined'
  && !navigator.platform.startsWith('Mac')
  && !isAndroid();

function CaptionButtons() {
  const claude = (window as any).claude;
  // Android has no OS window controls in-app. A RENDER-time check is needed on
  // top of the bridge check: the workbench declares `__PLATFORM__` only after the
  // module graph has loaded (index.tsx imports App statically, installMock runs
  // later), so import-time constants like `toggleOnLeft` above can't see
  // `?platform=android` — and the workbench bridge does expose `window` (getId).
  // On real Android `__PLATFORM__` is set before any import, so this only narrows.
  if (!claude?.window || isAndroid()) return null;

  const btnClass = "px-2 py-1 rounded-[var(--radius-toggle)] transition-colors text-fg-dim hover:text-fg-2 flex items-center justify-center";

  return (
    <div className="flex bg-inset rounded-md p-0.5 gap-0.5">
      {/* Placement "bottom": these sit in the very top row of the window, where
          there is no room above them for a hint. */}
      <Tooltip text="Minimize" placement="bottom">
        <button className={btnClass} onClick={() => claude.window.minimize()}>
          <svg className="w-3.5 h-3.5" viewBox="0 0 10 10"><rect fill="currentColor" y="5" width="10" height="1" /></svg>
        </button>
      </Tooltip>
      <Tooltip text="Maximize" placement="bottom">
        <button className={btnClass} onClick={() => claude.window.maximize()}>
          <svg className="w-3.5 h-3.5" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1" y="1" width="8" height="8" /></svg>
        </button>
      </Tooltip>
      <Tooltip text="Close" placement="bottom">
        <button className={`${btnClass} hover:!bg-red-500 hover:!text-white`} onClick={() => claude.window.close()}>
          <svg className="w-3.5 h-3.5" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.4"><line x1="1" y1="1" x2="9" y2="9" /><line x1="9" y1="1" x2="1" y2="9" /></svg>
        </button>
      </Tooltip>
    </div>
  );
}

/** macOS-only sibling of <CaptionButtons>. Paints a bg-inset pill at the
 *  spot where the OS renders the native traffic-light cluster, and also
 *  tells Electron to reposition those native lights so they sit centered
 *  inside the pill — giving Mac the same "buttons in a container" visual as
 *  the Windows caption buttons. Does nothing on non-Mac / Android / remote.
 *
 *  A ResizeObserver on .header-bar keeps both the pill size and the native
 *  light position in sync as the header height / window left-edge / chrome
 *  style changes. A MutationObserver on body's data-chrome-style / -header-style
 *  attrs covers the case where chrome radius changes without a size change. */
function MacTrafficLights({ headerRef }: { headerRef: React.RefObject<HTMLDivElement | null> }) {
  const pillRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!isMac) return;
    const header = headerRef.current;
    if (!header) return;
    const setPos = (window as any).claude?.window?.setTrafficLightPosition as
      | ((pos: { x: number; y: number } | null) => void)
      | undefined;
    if (!setPos) return;

    // Apple's traffic-light cluster dimensions. 3 circles × 12px + 2 gaps × 8px.
    const LIGHT_GROUP_W = 52;
    const LIGHT_GROUP_H = 14;
    // Pill padding around the lights — matches the visual weight of the
    // Windows caption container (which wraps buttons with p-0.5 + py-1 px-2).
    const PILL_PAD_X = 8;
    const PILL_PAD_Y = 4;

    const update = () => {
      const headerHidden = document.body.getAttribute('data-header-style') === 'hidden';
      const rect = header.getBoundingClientRect();
      const pill = pillRef.current;
      // Not painted yet, or header hidden — reset to OS default and hide pill.
      if (headerHidden || rect.height < 10) {
        setPos(null);
        if (pill) pill.style.display = 'none';
        return;
      }
      const chrome = document.body.getAttribute('data-chrome-style');
      // Floating chrome rounds the top-left corner with --radius-lg; nudge the
      // lights past it. Solid chrome sits flush, so 8px from the header's left
      // edge matches Apple's default.
      const cornerClearance = chrome === 'floating' ? 12 : 0;
      const xWindow = Math.round(rect.left + 8 + cornerClearance);
      const yWindow = Math.round(rect.top + (rect.height - LIGHT_GROUP_H) / 2);
      setPos({ x: xWindow, y: yWindow });

      if (pill) {
        pill.style.display = 'block';
        // Pill coords are relative to .header-bar (its positioned ancestor).
        pill.style.left = `${xWindow - rect.left - PILL_PAD_X}px`;
        pill.style.top = `${yWindow - rect.top - PILL_PAD_Y}px`;
        pill.style.width = `${LIGHT_GROUP_W + 2 * PILL_PAD_X}px`;
        pill.style.height = `${LIGHT_GROUP_H + 2 * PILL_PAD_Y}px`;
      }
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(header);
    // Chrome / header-style attribute changes can alter padding/margin/radius
    // without changing header size — e.g. switching radius only. Watch for them.
    const mo = new MutationObserver(update);
    mo.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-chrome-style', 'data-header-style'],
    });
    // Window move on screen changes rect.left/top without firing ResizeObserver
    // (size didn't change), so lights would drift. Re-measure on window resize
    // and on fullscreen toggle (which Electron relays via onFullscreenChanged).
    //
    // Perf: rAF-coalesced because `window.resize` is not frame-batched — on
    // Wayland it fires once per compositor configure during a drag-resize, and
    // each call measured + setState'd in the window where the compositor is
    // waiting for our new-size frame. The ResizeObserver above is already
    // frame-batched by the browser, so it calls `update` directly.
    let rafId: number | null = null;
    const updateOnFrame = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        update();
      });
    };
    window.addEventListener('resize', updateOnFrame);
    const offFullscreen = (window as any).claude?.window?.onFullscreenChanged?.(() => update());

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener('resize', updateOnFrame);
      offFullscreen?.();
    };
  }, [headerRef]);

  if (!isMac) return null;
  return (
    <div
      ref={pillRef}
      aria-hidden
      // pointer-events-none so clicks pass through to the OS-rendered native
      // traffic lights that paint on top. The pill is purely decorative.
      className="absolute bg-inset rounded-md pointer-events-none"
      style={{ display: 'none' }}
    />
  );
}

interface SessionEntry {
  id: string;
  name: string;
  cwd: string;
  permissionMode: string;
  /** Runtime backend — mirrors SessionInfo.provider. */
  provider?: SessionProvider;
  /** Native preset and model — mirror SessionInfo; SessionStrip's All Sessions
   *  menu shows them under the name ("YouCoded Coder · DeepSeek R1"). */
  harnessId?: string;
  model?: string;
  /** provider='shell' only — the shell that was spawned, so the All Sessions
   *  menu can read "Terminal · fish" instead of a Claude Code label. */
  shellName?: string;
}


interface Props {
  sessions: SessionEntry[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  // Passed straight through to SessionStrip — the trailing `preset?` (native
  // harness preset id) must be in the type or a forwarding drift goes unnoticed
  // (bivariance lets a shorter signature compile). Matches SessionStrip's prop.
  onCreateSession: (cwd: string, dangerous: boolean, model: string, provider?: 'claude' | 'native', launchInNewWindow?: boolean, binding?: { providerId: string; modelId: string }, preset?: string) => void;
  onCloseSession: (id: string, name?: string) => void;
  viewMode: 'chat' | 'terminal';
  onToggleView: (mode: 'chat' | 'terminal') => void;
  gamePanelOpen: boolean;
  onToggleGamePanel: () => void;
  gameConnected: boolean;
  challengePending: boolean;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  settingsBadge?: boolean;
  settingsDangerBadge?: boolean;
  sessionStatuses?: Map<string, SessionStatusColor>;
  // WHY: `onResumeSession` removed — HeaderBar accepted it but never called it.
  // Resuming is owned by ResumeBrowser, opened via `onOpenResumeBrowser` below.
  // App.tsx was still passing it through; that call site is updated too.
  onOpenResumeBrowser: () => void;
  onReorderSessions?: (fromIndex: number, toIndex: number) => void;
  defaultModel?: string;
  /** The saved default across every provider (Assistant settings). Passed
   *  through, like the rest of these — this bar has no form of its own. */
  defaultStartModel?: import('./model/ModelPicker').ModelChoice;
  defaultSkipPermissions?: boolean;
  defaultProjectFolder?: string;
  windowDirectory?: any;
  myWindowId?: number | null;
}

/** Projects button — always visible (projects are persistent, not session-local).
 *  Opens ProjectView as a full-screen overlay via PROJECT_VIEW_OPENED dispatch.
 *  HeaderBar must always render inside ArtifactProvider (its only render site,
 *  App.tsx, does) — useArtifact() needs a provider ancestor regardless of which
 *  component calls it. Keeping this in its own small component is just code
 *  organization; SessionStrip now also calls useArtifact() at its top level. */
function ProjectsButton() {
  const { dispatch } = useArtifact();
  return (
    <Tooltip text="Projects" placement="bottom">
    <button
      type="button"
      className="relative p-1 rounded-sm hover:bg-inset transition-colors shrink-0 text-fg-muted hover:text-fg"
      onClick={() => dispatch({ type: 'PROJECT_VIEW_OPENED' })}
      aria-label="Open Projects"
    >
      {/* Folder icon — matches the document icon style used by ArtifactDrawerButton */}
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
      </svg>
    </button>
    </Tooltip>
  );
}

/** Files-drawer button — isolated so it can safely call useArtifact().
 *  Placed inside <ArtifactContext.Provider> (mounted in App.tsx), so the hook
 *  is always in-context when the main app is rendering HeaderBar.
 *  Always rendered (so the drawer is reachable before any files exist); only
 *  the count badge is conditional. (An earlier plan hid the whole button at
 *  zero — that changed; this comment used to say so and was stale.) */
function ArtifactDrawerButton({ activeSessionId, projectRoot }: { activeSessionId: string | null; projectRoot?: string }) {
  const { state, dispatch } = useArtifact();
  // Open/closed is per-session — reflect (and toggle) the ACTIVE session's flag.
  const drawerOpen = activeSessionId ? (state.drawerOpenBySession[activeSessionId] ?? false) : false;
  // Count logic shared with the narrow overflow menu's "Session Files" row.
  const artifactCount = useArtifactCount(activeSessionId, projectRoot);

  // Fix: always show the button so users can open the drawer even before any
  // artifacts exist. The count badge is conditional — hidden when count is 0.
  // Styling mirrors the Connect 4 game-panel toggle exactly: bg-inset outer
  // pill, inner button that fills bg-accent/text-on-accent when its panel
  // is open, text-fg-dim/hover:text-fg-2 otherwise.
  return (
    <div className="bg-inset rounded-md p-0.5">
      {/* "Session Files" (Destin, 2026-07-23; was "Session artifacts" from
          2026-07-20). The "Session" qualifier carries the distinction: this is
          ONE session's activity log (including files merely VIEWED via pills),
          as distinct from Project View's project-wide set. */}
      <Tooltip text="Session Files" placement="bottom">
      <button
        type="button"
        onClick={() => {
          if (!activeSessionId) return;
          // Closing the drawer can discard a dirty editor draft — route
          // through the artifact host's Save/Discard/Cancel guard (D3).
          guardDirtyEditor(() =>
            dispatch({ type: drawerOpen ? 'DRAWER_CLOSED' : 'DRAWER_OPENED', sessionId: activeSessionId }));
        }}
        className={`px-2 py-1 rounded-[var(--radius-toggle)] transition-colors flex items-center gap-1 ${
          drawerOpen ? 'bg-accent text-on-accent' : 'text-fg-dim hover:text-fg-2'
        }`}
        // WHY an explicit name now that `title` is gone: the only text inside
        // this button is the count badge, so the accessible name was the bare
        // number "3" whenever any file was tracked, and fell back to `title`
        // only at zero. Naming it here makes it announce the same thing in both
        // states, and lets the hint be a description rather than the name.
        aria-label="Session Files"
      >
        {/* Document icon — SVG matches the style of the settings gear above */}
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        {/* Count badge — only shown when there are tracked artifacts. Flips to
            bg-on-accent/text-accent while open so it stays legible against the
            now-accent-colored button background. */}
        {artifactCount > 0 && (
          <span className={`text-3xs rounded-full px-1 min-w-[14px] inline-flex items-center justify-center leading-none py-0.5 ${
            drawerOpen ? 'bg-on-accent text-accent' : 'bg-accent text-on-accent'
          }`}>
            {artifactCount}
          </span>
        )}
      </button>
      </Tooltip>
    </div>
  );
}

/** The Settings gear. ONE component for both the session header and the
 *  welcome-screen bare header (P-6, 2026-08-27): Destin asked for the welcome
 *  gear to be byte-identical to the session one, so the class string, badges
 *  and Android hit-size live here and nowhere else. Copying the JSX would let
 *  the two drift on the next tweak. */
function SettingsGearButton({ settingsOpen, onToggleSettings, settingsBadge, settingsDangerBadge }: {
  settingsOpen: boolean;
  onToggleSettings: () => void;
  settingsBadge?: boolean;
  settingsDangerBadge?: boolean;
}) {
  return (
    <Tooltip text="Settings" placement="bottom">
    <button
      onClick={onToggleSettings}
      className={`relative ${isAndroid() ? 'p-2' : 'p-1'} rounded-sm hover:bg-inset transition-colors shrink-0 ${settingsOpen ? 'text-fg' : 'text-fg-muted'}`}
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
      {/* Red dot takes precedence over blue remote-connection badge —
          danger-level sync warnings indicate data-loss risk and must be visible. */}
      {settingsDangerBadge && !settingsOpen ? (
        <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500" />
      ) : settingsBadge && !settingsOpen ? (
        <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-blue-500" />
      ) : null}
    </button>
    </Tooltip>
  );
}

export default function HeaderBar({
  sessions, activeSessionId, onSelectSession, onCreateSession, onCloseSession,
  viewMode, onToggleView,
  gamePanelOpen, onToggleGamePanel, gameConnected, challengePending,
  settingsOpen, onToggleSettings, settingsBadge, settingsDangerBadge, sessionStatuses,
  onOpenResumeBrowser, onReorderSessions,
  defaultModel, defaultStartModel, defaultSkipPermissions, defaultProjectFolder,
  windowDirectory, myWindowId,
}: Props) {
  const headerRef = useRef<HTMLDivElement>(null);
  const [showToggleLabels, setShowToggleLabels] = useState(true);

  // Below 640px the settings cog, projects button, and gamepad collapse into a
  // single ||| menu (see OverflowMenu). Viewport-based, not header-width-based:
  // these three are app-level destinations, so the decision should follow the
  // device, not how much room the session strip happens to have left.
  const narrow = useNarrowViewport();

  // Native harness sessions have no PTY — the chat/terminal toggle would show
  // an empty terminal pane. Hide it for them. A shell session is the mirror
  // image: it is nothing BUT a terminal, and switching it to chat would show an
  // empty chat pane, so it has no toggle either.
  const activeSessionProvider = sessions.find(s => s.id === activeSessionId)?.provider;
  const showToggle = activeSessionProvider !== 'native' && activeSessionProvider !== 'shell';

  // Measure whether the header has room for the toggle labels. The labels
  // are the first things to drop; below that threshold, flex still has
  // room for the icon-only toggle, gamepad, caption buttons, and the
  // session strip is allowed to pack more aggressively.
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const compute = () => {
      // Empirical: at <560 px total header width, labels cause the strip
      // to lose meaningful room. Above 720 px, labels always fit.
      // Between, choose labels-visible unless the right cluster would
      // be narrower than the session strip's minimum viable width (~180px).
      const w = el.clientWidth;
      setShowToggleLabels(w >= 560);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Cluster width reservation. A plain `flex-1` split would cap the session
  // strip at ~1/3 of the header even when the side clusters only fill
  // ~160-200px of content. Instead we measure each cluster's natural content
  // width (sum of shrink-0 children — safe because the containers are
  // flex-stretched but their children report intrinsic widths), reserve
  // max(leftNat, rightNat) * CLUSTER_HEADROOM on BOTH sides, and let the
  // center flex-1 wrapper absorb the rest. Symmetric reservations keep the
  // strip window-center-aligned; the headroom multiplier is a visual buffer
  // so clusters don't feel like they're kissing the strip.
  //
  // Measuring *children* (not the container's clientWidth) avoids a feedback
  // loop: our applied width would otherwise feed back into the next
  // measurement. The children are all `shrink-0`, so offsetWidth always
  // reports their intrinsic width.
  const leftClusterRef = useRef<HTMLDivElement>(null);
  const rightClusterRef = useRef<HTMLDivElement>(null);
  const [reservedWidth, setReservedWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const header = headerRef.current;
    const left = leftClusterRef.current;
    const right = rightClusterRef.current;
    if (!header || !left || !right) return;

    const CLUSTER_HEADROOM = 1.2;   // visual buffer between clusters and strip
    const MIN_STRIP_WIDTH = 180;    // don't starve the strip at narrow widths

    const measureNatural = (el: HTMLElement): number => {
      const children = Array.from(el.children) as HTMLElement[];
      const visible = children.filter(c => c.offsetWidth > 0);
      if (visible.length === 0) return 0;
      const totalW = visible.reduce((sum, c) => sum + c.offsetWidth, 0);
      const gap = parseFloat(window.getComputedStyle(el).columnGap || '0') || 0;
      return totalW + gap * (visible.length - 1);
    };

    const compute = () => {
      const headerW = header.clientWidth;
      if (headerW === 0) return; // not laid out yet
      const natLeft = measureNatural(left);
      const natRight = measureNatural(right);
      const maxNat = Math.max(natLeft, natRight);
      const ideal = maxNat * CLUSTER_HEADROOM;
      // Squeeze the headroom toward 1.0 if the strip would drop below viable
      // width. Never below maxNat itself — the reservation must always cover
      // actual content so the strip can't overpaint the gear (this preserves
      // the "no min-w-0 on left cluster" invariant in a stricter form).
      const cap = Math.max(maxNat, (headerW - MIN_STRIP_WIDTH) / 2);
      const reserved = Math.min(ideal, cap);
      const next = Math.ceil(reserved);
      // 2px dedup dampens sub-pixel jitter during the chat/terminal toggle's
      // label animation; without it RO fires many times across 300ms.
      setReservedWidth(prev =>
        prev != null && Math.abs(prev - next) < 2 ? prev : next,
      );
    };

    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(header);
    ro.observe(left);
    ro.observe(right);
    return () => ro.disconnect();
  }, []);

  // Inline style applied to both clusters. When `reservedWidth` is null
  // (pre-measurement or not-yet-laid-out), we fall back to `flex-1` via
  // className. The width transition smooths the shift that happens when the
  // chat/terminal toggle's active label changes width (Chat=3rem, Term=4.5rem).
  const clusterStyle: React.CSSProperties | undefined = reservedWidth != null
    ? { flex: '0 0 auto', width: `${reservedWidth}px`, transition: 'width 200ms ease' }
    : undefined;
  const clusterFlexClass = reservedWidth == null ? 'flex-1 ' : '';

  // Narrow swaps the two-segment pill for a single target-view icon button.
  //
  // WHY: the wide toggle owns geometry with the DOM instance that consumes it;
  // crossing the narrow breakpoint now unmounts all readiness and cached
  // endpoints together instead of leaving HeaderBar with stale `measured=true`.
  const toggleElement = narrow
    ? <NarrowViewToggle viewMode={viewMode} onToggleView={onToggleView} />
    : (
      <WideViewToggle
        viewMode={viewMode}
        onToggleView={onToggleView}
        showLabels={showToggleLabels}
      />
    );

  return (
    // select-none: the header is chrome, not highlightable or copyable (Destin,
    // 2026-09-10). A session rename box inside stays editable: globals.css
    // re-enables text fields.
    <div ref={headerRef} className="header-bar flex items-center h-10 px-2 sm:px-3 shrink-0 select-none" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
      {/* Mac-only decorative pill under the native traffic lights. Mirrors the
          bg-inset rounded-md look of <CaptionButtons> on Windows/Linux. */}
      <MacTrafficLights headerRef={headerRef} />
      {/* Left — settings gear + REMOTE badge + (Win/Linux) chat/terminal toggle.
          NOTE: no min-w-0 — left children are all shrink-0; letting this collapse
          would allow SessionStrip to overpaint the gear. When reservedWidth is
          set (measured), width is pinned to `max(left, right) * 1.2` so both
          sides reserve equal space; when unset we fall back to flex-1. */}
      <div
        ref={leftClusterRef}
        className={`${clusterFlexClass}flex items-center gap-1 sm:gap-2`}
        style={clusterStyle}
      >
        {narrow ? (
          /* Narrow: cog + projects + gamepad all live behind the ||| menu.
             Rendered as a single shrink-0 child so the cluster-width
             measurement at :368 still reads an intrinsic width. */
          <OverflowMenu
            activeSessionId={activeSessionId}
            projectRoot={sessions.find((s) => s.id === activeSessionId)?.cwd}
            onToggleSettings={onToggleSettings}
            settingsBadge={settingsBadge}
            settingsDangerBadge={settingsDangerBadge}
            onToggleGamePanel={onToggleGamePanel}
            gamePanelOpen={gamePanelOpen}
            gameConnected={gameConnected}
            challengePending={challengePending}
          />
        ) : (
          <SettingsGearButton
            settingsOpen={settingsOpen}
            onToggleSettings={onToggleSettings}
            settingsBadge={settingsBadge}
            settingsDangerBadge={settingsDangerBadge}
          />
        )}
        {/* Projects button — wide layouts only; narrow reaches it via ||| . */}
        {!narrow && <ProjectsButton />}
        {isRemoteMode() && (
          <span className="text-3xs font-medium px-1.5 py-0.5 rounded-sm bg-blue-500/15 text-blue-400 border border-blue-500/25 shrink-0">
            REMOTE
          </span>
        )}
        {/* Narrow puts the toggle on the RIGHT regardless of platform
            (Destin, 2026-07-20): the left cluster is the ||| menu's home and
            the right cluster is now just the view toggle. */}
        {!narrow && toggleOnLeft && showToggle && toggleElement}
      </div>

      {/* Center — session strip.
          flex-1 wrapper gives the strip a pre-allocated budget (~1/3 of the
          header) so packSessions reads an available-space value rather than
          its own current content width (chicken-and-egg fix). */}
      <div className="flex-1 min-w-0 flex justify-center">
      <SessionStrip
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectSession={onSelectSession}
        onCreateSession={onCreateSession}
        onCloseSession={onCloseSession}
        sessionStatuses={sessionStatuses}
        onOpenResumeBrowser={onOpenResumeBrowser}
        onReorderSessions={onReorderSessions}
        defaultModel={defaultModel}
        defaultStartModel={defaultStartModel}
        defaultSkipPermissions={defaultSkipPermissions}
        defaultProjectFolder={defaultProjectFolder}
        windowDirectory={windowDirectory}
        myWindowId={myWindowId}
      />
      </div>

      {/* Right — view toggles. Symmetric reservation with the left cluster
          (see clusterStyle above) keeps the session strip window-centered. */}
      <div
        ref={rightClusterRef}
        className={`${clusterFlexClass}flex items-center justify-end gap-1 sm:gap-2`}
        style={clusterStyle}
      >
        {(narrow || !toggleOnLeft) && showToggle && toggleElement}
        {/* Files-drawer trigger — always visible; only the count badge is
            conditional (the original hide-at-zero plan was dropped — see the
            ArtifactDrawerButton docblock). Grouped with the game-panel toggle
            since both are panel toggles sharing identical pill styling. */}
        {/* Session Files is a ||| menu row on narrow, so the button would
            be a duplicate entry point. */}
        {!narrow && (
          <ArtifactDrawerButton
            activeSessionId={activeSessionId}
            projectRoot={sessions.find((s) => s.id === activeSessionId)?.cwd}
          />
        )}
        <div className="bg-inset rounded-md p-0.5 hidden sm:block">
          {/* §4.1: the pane holds four games now, so the button names the pane,
              not the game. "Games" also matches the accessibility rule that a
              control's name says where it goes. */}
          <Tooltip text={challengePending ? 'Incoming challenge!' : 'Games'} placement="bottom">
          <button
            onClick={onToggleGamePanel}
            className={`px-2 py-1 rounded-[var(--radius-toggle)] transition-colors flex items-center gap-1 ${
              gamePanelOpen
                ? 'bg-accent text-on-accent'
                : challengePending && !gamePanelOpen
                  ? 'text-orange-400'
                  : 'text-fg-dim hover:text-fg-2'
            }`}
            // Perf: steps(8) instead of ease-in-out — this pulses for as long
            // as a challenge is pending, and a smooth animation costs ~29% of
            // one core on a 180Hz panel (frame cost, not element cost). 8
            // opacity changes/sec reads identically on a 16px icon. See the
            // .animate-pulse comment in globals.css.
            style={challengePending && !gamePanelOpen ? {
              animation: 'challenge-pulse 2.5s steps(8) infinite',
            } : undefined}
          >
            <GamepadIcon className="w-4 h-4" />
          {gameConnected && (
            <span className={`w-1.5 h-1.5 rounded-full ${challengePending && !gamePanelOpen ? 'bg-orange-400' : 'bg-green-400'}`} />
          )}
          </button>
          </Tooltip>
        </div>

        {/* Custom caption buttons (Windows/Linux only) */}
        {showCaptionButtons && <CaptionButtons />}
      </div>
    </div>
  );
}

/** The welcome screen's header (P-6, Destin 2026-08-27: "a full frame around
 *  the welcome screen, as exists in terminal view, with settings/projects/
 *  minimize/maximize/close. no sessions switch ... no status bar chips or chat
 *  bar. just bare frame like terminal view").
 *
 *  A separate component rather than a `bare` prop on HeaderBar: HeaderBar's
 *  cluster-measurement hooks, session-strip reservation and view-toggle state
 *  are all session-scoped, and gating its JSX on a flag would still run every
 *  one of them for a bar with nothing to measure. This renders ONLY what works
 *  without a session — the Mac traffic-light pill, the shared gear, the Projects
 *  button (Project View is a full-screen overlay that needs no session) and the
 *  Windows/Linux caption buttons. No OverflowMenu on narrow viewports either:
 *  its rows are session-scoped (Session Files, Connect 4), so the two app-level
 *  buttons render directly at every width.
 *
 *  Same `.header-bar` class + `WebkitAppRegion: drag` as HeaderBar, so the
 *  frameless window is still draggable from the welcome screen, globals.css's
 *  `.header-bar button { no-drag }` keeps the buttons clickable, the theme
 *  engine's header styles apply, and useChromeMeasurements (which queries
 *  `.header-bar` inside App's headerRef wrapper) publishes --top-chrome-height
 *  for the chrome-glass frame exactly as it does for a session. */
export function BareHeaderBar({ settingsOpen, onToggleSettings, settingsBadge, settingsDangerBadge }: {
  settingsOpen: boolean;
  onToggleSettings: () => void;
  settingsBadge?: boolean;
  settingsDangerBadge?: boolean;
}) {
  // MacTrafficLights measures the .header-bar element it sits in.
  const headerRef = useRef<HTMLDivElement>(null);
  return (
    // select-none: the header is chrome, not highlightable or copyable (Destin,
    // 2026-09-10). A session rename box inside stays editable: globals.css
    // re-enables text fields.
    <div ref={headerRef} className="header-bar flex items-center h-10 px-2 sm:px-3 shrink-0 select-none" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
      <MacTrafficLights headerRef={headerRef} />
      <div className="flex items-center gap-1 sm:gap-2">
        <SettingsGearButton
          settingsOpen={settingsOpen}
          onToggleSettings={onToggleSettings}
          settingsBadge={settingsBadge}
          settingsDangerBadge={settingsDangerBadge}
        />
        <ProjectsButton />
      </div>
      {/* Empty middle — stays part of the drag region. */}
      <div className="flex-1 min-w-0" />
      <div className="flex items-center justify-end gap-1 sm:gap-2">
        {showCaptionButtons && <CaptionButtons />}
      </div>
    </div>
  );
}
