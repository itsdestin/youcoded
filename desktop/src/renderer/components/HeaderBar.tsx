import React, { useRef, useLayoutEffect, useEffect, useCallback, useState } from 'react';
import { ChatIcon, TerminalIcon, GamepadIcon } from './Icons';
import SessionStrip from './SessionStrip';
import type { SessionStatusColor } from './StatusDot';
import type { PermissionMode } from '../../shared/types';
import { isAndroid, isRemoteMode } from '../platform';

/** Custom window caption buttons for Windows/Linux (macOS uses native traffic lights). */
const showCaptionButtons = typeof navigator !== 'undefined'
  && navigator.platform === 'Win32';

const isMac = typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac');

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
  if (!claude?.window) return null;

  const btnClass = "px-2 py-1 rounded-[var(--radius-toggle)] transition-colors text-fg-dim hover:text-fg-2 flex items-center justify-center";

  return (
    <div className="flex bg-inset rounded-md p-0.5 gap-0.5">
      <button className={btnClass} onClick={() => claude.window.minimize()} title="Minimize">
        <svg className="w-3.5 h-3.5" viewBox="0 0 10 10"><rect fill="currentColor" y="5" width="10" height="1" /></svg>
      </button>
      <button className={btnClass} onClick={() => claude.window.maximize()} title="Maximize">
        <svg className="w-3.5 h-3.5" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1" y="1" width="8" height="8" /></svg>
      </button>
      <button className={`${btnClass} hover:!bg-red-500 hover:!text-white`} onClick={() => claude.window.close()} title="Close">
        <svg className="w-3.5 h-3.5" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.4"><line x1="1" y1="1" x2="9" y2="9" /><line x1="9" y1="1" x2="1" y2="9" /></svg>
      </button>
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
    window.addEventListener('resize', update);
    const offFullscreen = (window as any).claude?.window?.onFullscreenChanged?.(() => update());

    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener('resize', update);
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
}


interface Props {
  sessions: SessionEntry[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onCreateSession: (cwd: string, dangerous: boolean, model: string, provider?: 'claude' | 'gemini') => void;
  onCloseSession: (id: string) => void;
  viewMode: 'chat' | 'terminal';
  onToggleView: (mode: 'chat' | 'terminal') => void;
  gamePanelOpen: boolean;
  onToggleGamePanel: () => void;
  gameConnected: boolean;
  challengePending: boolean;
  permissionMode: PermissionMode;
  onCyclePermission: () => void;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  settingsBadge?: boolean;
  settingsDangerBadge?: boolean;
  sessionStatuses?: Map<string, SessionStatusColor>;
  onResumeSession: (sessionId: string, projectSlug: string, projectPath: string, model?: string, dangerous?: boolean) => void;
  onOpenResumeBrowser: () => void;
  onReorderSessions?: (fromIndex: number, toIndex: number) => void;
  defaultModel?: string;
  defaultSkipPermissions?: boolean;
  defaultProjectFolder?: string;
  geminiEnabled?: boolean;
  windowDirectory?: any;
  myWindowId?: number | null;
}

export default function HeaderBar({
  sessions, activeSessionId, onSelectSession, onCreateSession, onCloseSession,
  viewMode, onToggleView,
  gamePanelOpen, onToggleGamePanel, gameConnected, challengePending,
  permissionMode, onCyclePermission,
  settingsOpen, onToggleSettings, settingsBadge, settingsDangerBadge, sessionStatuses, onResumeSession,
  onOpenResumeBrowser, onReorderSessions,
  defaultModel, defaultSkipPermissions, defaultProjectFolder,
  geminiEnabled,
  windowDirectory, myWindowId,
}: Props) {
  // Pill doesn't track live button widths — it pins to the active button's
  // FINAL rect and CSS-transitions between two cached {left,width} pairs.
  // Buttons still animate their text roll-out (max-width: 0 ↔ target) in
  // parallel; both arrive at their end state at t=300ms. Intermediate
  // misalignment across the gap is invisible because the pill is mid-flight,
  // not touching a button edge. Previous attempts (ae5776ee, 68462e9b,
  // a0103014) tried to glue the pill to the active button as it widened
  // or used a post-commit getBoundingClientRect that returned the button's
  // interpolated (narrow) starting rect — both produced the teleport.
  // Stop tracking; pin to endpoints measured once via a transition-disabled
  // reflow sandwich at mount.
  const containerRef = useRef<HTMLDivElement>(null);
  const chatBtnRef = useRef<HTMLButtonElement>(null);
  const termBtnRef = useRef<HTMLButtonElement>(null);
  const [measured, setMeasured] = useState(false);

  const headerRef = useRef<HTMLDivElement>(null);
  const [showToggleLabels, setShowToggleLabels] = useState(true);

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

  const measureEndpoints = useCallback(() => {
    const container = containerRef.current;
    const chatBtn = chatBtnRef.current;
    const termBtn = termBtnRef.current;
    if (!container || !chatBtn || !termBtn) return;
    const chatSpan = chatBtn.querySelector<HTMLElement>('[data-btn-text]');
    const termSpan = termBtn.querySelector<HTMLElement>('[data-btn-text]');

    // If spans don't exist (narrow header — labels hidden via showToggleLabels),
    // both states collapse to icon-only widths; one measurement covers both.
    if (!chatSpan || !termSpan) {
      const cRect = container.getBoundingClientRect();
      const chatRect = chatBtn.getBoundingClientRect();
      const termRect = termBtn.getBoundingClientRect();
      container.style.setProperty('--pill-chat-left',  `${chatRect.left - cRect.left}px`);
      container.style.setProperty('--pill-chat-width', `${chatRect.width}px`);
      container.style.setProperty('--pill-term-left', `${termRect.left - cRect.left}px`);
      container.style.setProperty('--pill-term-width', `${termRect.width}px`);
      setMeasured(true);
      return;
    }

    const savedChatTrans = chatSpan.style.transition;
    const savedTermTrans = termSpan.style.transition;
    const savedChatMax = chatSpan.style.maxWidth;
    const savedTermMax = termSpan.style.maxWidth;
    chatSpan.style.transition = 'none';
    termSpan.style.transition = 'none';

    // State A: chat expanded, terminal collapsed
    chatSpan.style.maxWidth = '3rem';
    termSpan.style.maxWidth = '0px';
    void container.offsetWidth;
    let cRect = container.getBoundingClientRect();
    const chatExpLeft  = chatBtn.getBoundingClientRect().left - cRect.left;
    const chatExpWidth = chatBtn.getBoundingClientRect().width;

    // State B: chat collapsed, terminal expanded
    chatSpan.style.maxWidth = '0px';
    termSpan.style.maxWidth = '4.5rem';
    void container.offsetWidth;
    cRect = container.getBoundingClientRect();
    const termExpLeft  = termBtn.getBoundingClientRect().left - cRect.left;
    const termExpWidth = termBtn.getBoundingClientRect().width;

    // Restore; React owns these inline styles via the `style` prop on next render
    chatSpan.style.maxWidth = savedChatMax;
    termSpan.style.maxWidth = savedTermMax;
    void container.offsetWidth;
    chatSpan.style.transition = savedChatTrans;
    termSpan.style.transition = savedTermTrans;

    container.style.setProperty('--pill-chat-left',  `${chatExpLeft}px`);
    container.style.setProperty('--pill-chat-width', `${chatExpWidth}px`);
    container.style.setProperty('--pill-term-left', `${termExpLeft}px`);
    container.style.setProperty('--pill-term-width', `${termExpWidth}px`);
    setMeasured(true);
  }, []);

  useLayoutEffect(() => { measureEndpoints(); }, [measureEndpoints]);

  // Re-measure when toggle labels appear/disappear — button widths change
  // drastically between label-visible and icon-only states.
  useEffect(() => {
    // Wait one frame for the new class to apply before measuring.
    requestAnimationFrame(() => measureEndpoints());
  }, [showToggleLabels, measureEndpoints]);

  // Refresh on font load (text widths shift) and window resize (breakpoint crosses,
  // viewport zoom). Theme swaps typically trigger a resize-like layout pass.
  useEffect(() => {
    if ('fonts' in document) {
      let cancelled = false;
      document.fonts.ready.then(() => { if (!cancelled) measureEndpoints(); });
      return () => { cancelled = true; };
    }
  }, [measureEndpoints]);

  useEffect(() => {
    const handler = () => measureEndpoints();
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, [measureEndpoints]);

  // Extracted so it can be rendered into either cluster depending on platform.
  // Task 6 will tweak the inner span classNames; don't edit those here.
  const toggleElement = (
    <div ref={containerRef} className="relative flex bg-inset rounded-md p-0.5 gap-0.5">
      {/* Sliding background pill — left/width come from CSS variables
          set once by measureEndpoints(). Plain CSS transition tweens
          between the two cached endpoints. */}
      <div
        className="absolute top-0.5 bottom-0.5 bg-accent rounded-[var(--radius-toggle)] transition-[left,width] duration-300 ease-in-out"
        style={{
          left:  viewMode === 'chat' ? 'var(--pill-chat-left)'  : 'var(--pill-term-left)',
          width: viewMode === 'chat' ? 'var(--pill-chat-width)' : 'var(--pill-term-width)',
          // Hide until first measurement completes — avoids a 1-frame flash
          // at left: 0, width: auto before CSS vars are set.
          opacity: measured ? 1 : 0,
        }}
      />
      <button
        ref={chatBtnRef}
        onClick={() => onToggleView('chat')}
        className={`relative z-10 px-1.5 sm:px-2.5 py-1 rounded-[var(--radius-toggle)] flex items-center gap-1.5 transition-colors duration-300 ${
          viewMode === 'chat'
            ? 'text-on-accent'
            : 'text-fg-dim hover:text-fg-2'
        }`}
        title="Chat"
      >
        <ChatIcon className="w-3.5 h-3.5 shrink-0" />
        {/* Text rolls out via max-width + opacity transition */}
        <span
          data-btn-text
          className={`text-xs font-medium overflow-hidden whitespace-nowrap transition-all duration-300 ease-in-out ${showToggleLabels ? 'inline-block' : 'hidden'}`}
          style={{
            maxWidth: viewMode === 'chat' ? '3rem' : '0',
            opacity: viewMode === 'chat' ? 1 : 0,
          }}
        >Chat</span>
      </button>
      <button
        ref={termBtnRef}
        onClick={() => onToggleView('terminal')}
        className={`relative z-10 px-1.5 sm:px-2.5 py-1 rounded-[var(--radius-toggle)] flex items-center gap-1.5 transition-colors duration-300 ${
          viewMode === 'terminal'
            ? 'text-on-accent'
            : 'text-fg-dim hover:text-fg-2'
        }`}
        title="Terminal"
      >
        <TerminalIcon className="w-3.5 h-3.5 shrink-0" />
        <span
          data-btn-text
          className={`text-xs font-medium overflow-hidden whitespace-nowrap transition-all duration-300 ease-in-out ${showToggleLabels ? 'inline-block' : 'hidden'}`}
          style={{
            maxWidth: viewMode === 'terminal' ? '4.5rem' : '0',
            opacity: viewMode === 'terminal' ? 1 : 0,
          }}
        >Terminal</span>
      </button>
    </div>
  );

  return (
    <div ref={headerRef} className="header-bar flex items-center h-10 px-2 sm:px-3 border-b border-edge shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
      {/* Mac-only decorative pill under the native traffic lights. Mirrors the
          bg-inset rounded-md look of <CaptionButtons> on Windows/Linux. */}
      <MacTrafficLights headerRef={headerRef} />
      {/* Left — settings gear + REMOTE badge + (Win/Linux) chat/terminal toggle.
          NOTE: no min-w-0 — left children are all shrink-0; letting this collapse
          would allow SessionStrip to overpaint the gear. Keep symmetric with right. */}
      <div className="flex-1 flex items-center gap-1 sm:gap-2">
        <button
          onClick={onToggleSettings}
          className={`relative ${isAndroid() ? 'p-2' : 'p-1'} rounded-sm hover:bg-inset transition-colors shrink-0 ${settingsOpen ? 'text-fg' : 'text-fg-muted'}`}
          title="Settings"
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
        {isRemoteMode() && (
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-sm bg-blue-500/15 text-blue-400 border border-blue-500/25 shrink-0">
            REMOTE
          </span>
        )}
        {toggleOnLeft && toggleElement}
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
        onResumeSession={onResumeSession}
        onOpenResumeBrowser={onOpenResumeBrowser}
        onReorderSessions={onReorderSessions}
        defaultModel={defaultModel}
        defaultSkipPermissions={defaultSkipPermissions}
        defaultProjectFolder={defaultProjectFolder}
        geminiEnabled={geminiEnabled}
        windowDirectory={windowDirectory}
        myWindowId={myWindowId}
      />
      </div>

      {/* Right — view toggles */}
      <div className="flex-1 flex items-center justify-end gap-1 sm:gap-2">
        {!toggleOnLeft && toggleElement}
        <div className="bg-inset rounded-md p-0.5 hidden sm:block">
          <button
            onClick={onToggleGamePanel}
            className={`px-2 py-1 rounded-[var(--radius-toggle)] transition-colors flex items-center gap-1 ${
              gamePanelOpen
                ? 'bg-accent text-on-accent'
                : challengePending && !gamePanelOpen
                  ? 'text-orange-400'
                  : 'text-fg-dim hover:text-fg-2'
            }`}
            style={challengePending && !gamePanelOpen ? {
              animation: 'challenge-pulse 2.5s ease-in-out infinite',
            } : undefined}
            title={challengePending ? 'Incoming challenge!' : 'Connect 4'}
          >
            <GamepadIcon className="w-4 h-4" />
          {gameConnected && (
            <span className={`w-1.5 h-1.5 rounded-full ${challengePending && !gamePanelOpen ? 'bg-orange-400' : 'bg-green-400'}`} />
          )}
          </button>
        </div>

        {/* Custom caption buttons (Windows/Linux only) */}
        {showCaptionButtons && <CaptionButtons />}
      </div>
    </div>
  );
}
