import React, { useRef, useLayoutEffect } from 'react';
import { ChatIcon, TerminalIcon, GamepadIcon } from './Icons';
import SessionStrip from './SessionStrip';
import type { SessionStatusColor } from './StatusDot';
import type { PermissionMode } from '../../shared/types';
import { isAndroid, isRemoteMode } from '../platform';

/** Custom window caption buttons for Windows/Linux (macOS uses native traffic lights). */
const showCaptionButtons = typeof navigator !== 'undefined'
  && navigator.platform === 'Win32';

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
  announcement: string | null;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  settingsBadge?: boolean;
  sessionStatuses?: Map<string, SessionStatusColor>;
  onResumeSession: (sessionId: string, projectSlug: string, projectPath: string, model?: string, dangerous?: boolean) => void;
  onOpenResumeBrowser: () => void;
  onReorderSessions?: (fromIndex: number, toIndex: number) => void;
  defaultModel?: string;
  defaultSkipPermissions?: boolean;
  defaultProjectFolder?: string;
  geminiEnabled?: boolean;
}

export default function HeaderBar({
  sessions, activeSessionId, onSelectSession, onCreateSession, onCloseSession,
  viewMode, onToggleView,
  gamePanelOpen, onToggleGamePanel, gameConnected, challengePending,
  permissionMode, onCyclePermission, announcement,
  settingsOpen, onToggleSettings, settingsBadge, sessionStatuses, onResumeSession,
  onOpenResumeBrowser, onReorderSessions,
  defaultModel, defaultSkipPermissions, defaultProjectFolder,
  geminiEnabled,
}: Props) {
  // Sliding pill between two fixed button positions.
  //
  // Fix: prior versions animated button text via max-width (0 ↔ 3rem) and
  // tried to make the pill track the button's live width with a
  // ResizeObserver. That race caused stutter then teleport-on-toggle
  // artifacts because getBoundingClientRect returned the button's
  // interpolated (narrow) rect at the moment of the click.
  //
  // Now button widths are FIXED per active/inactive state (w-9 inactive,
  // wider when active) with a width transition on the button itself, and
  // text uses opacity-only crossfade. Because button rects settle to
  // their final values immediately on viewMode change, measuring the
  // active button once in useLayoutEffect gives the correct endpoint,
  // and a plain CSS transition on the pill's left/width animates it
  // smoothly across the gap. No observer, no per-frame work.
  const containerRef = useRef<HTMLDivElement>(null);
  const chatBtnRef = useRef<HTMLButtonElement>(null);
  const termBtnRef = useRef<HTMLButtonElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const pill = pillRef.current;
    const activeBtn = viewMode === 'chat' ? chatBtnRef.current : termBtnRef.current;
    if (!container || !pill || !activeBtn) return;
    const cRect = container.getBoundingClientRect();
    const bRect = activeBtn.getBoundingClientRect();
    pill.style.left = `${bRect.left - cRect.left}px`;
    pill.style.width = `${bRect.width}px`;
  }, [viewMode]);

  return (
    <div className="header-bar flex items-center h-10 px-2 sm:px-3 border-b border-edge shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
      {/* Left — settings + remote/announcement badges */}
      <div className="flex-1 flex items-center gap-1 sm:gap-2 min-w-0">
        <button
          onClick={onToggleSettings}
          className={`relative ${isAndroid() ? 'p-2' : 'p-1'} rounded-sm hover:bg-inset transition-colors shrink-0 ${settingsOpen ? 'text-fg' : 'text-fg-muted'}`}
          title="Settings"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          {settingsBadge && !settingsOpen && (
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-blue-500" />
          )}
        </button>
        {isRemoteMode() && (
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-sm bg-blue-500/15 text-blue-400 border border-blue-500/25 shrink-0">
            REMOTE
          </span>
        )}
        {announcement && (
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-sm bg-[#FF9800]/15 text-[#FF9800] border border-[#FF9800]/25 truncate max-w-[200px] hidden sm:inline" title={announcement}>
            ★ {announcement}
          </span>
        )}
      </div>

      {/* Center — session strip */}
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
      />

      {/* Right — view toggles */}
      <div className="flex-1 flex items-center justify-end gap-1 sm:gap-2">
        {/* Chat/Terminal toggle — sliding pill with text roll-out */}
        <div ref={containerRef} className="relative flex bg-inset rounded-md p-0.5 gap-0.5">
          {/* Sliding background pill — left/width set imperatively in the
              layout effect above; the CSS transition here tweens between
              the two stable endpoints. */}
          <div
            ref={pillRef}
            className="absolute top-0.5 bottom-0.5 bg-accent rounded-[var(--radius-toggle)] transition-[left,width] duration-300 ease-in-out"
          />
          <button
            ref={chatBtnRef}
            onClick={() => onToggleView('chat')}
            className={`relative z-10 py-1 rounded-[var(--radius-toggle)] flex items-center justify-center gap-1.5 transition-[width,color] duration-300 ease-in-out ${
              viewMode === 'chat'
                ? 'text-on-accent w-9 sm:w-20'
                : 'text-fg-dim hover:text-fg-2 w-9'
            }`}
            title="Chat"
          >
            <ChatIcon className="w-3.5 h-3.5 shrink-0" />
            {/* Text crossfades via opacity; width is owned by the button */}
            <span
              className={`text-xs font-medium hidden sm:inline-block whitespace-nowrap transition-opacity duration-300 ease-in-out ${
                viewMode === 'chat' ? 'opacity-100' : 'opacity-0 pointer-events-none'
              }`}
            >Chat</span>
          </button>
          <button
            ref={termBtnRef}
            onClick={() => onToggleView('terminal')}
            className={`relative z-10 py-1 rounded-[var(--radius-toggle)] flex items-center justify-center gap-1.5 transition-[width,color] duration-300 ease-in-out ${
              viewMode === 'terminal'
                ? 'text-on-accent w-9 sm:w-[6.5rem]'
                : 'text-fg-dim hover:text-fg-2 w-9'
            }`}
            title="Terminal"
          >
            <TerminalIcon className="w-3.5 h-3.5 shrink-0" />
            <span
              className={`text-xs font-medium hidden sm:inline-block whitespace-nowrap transition-opacity duration-300 ease-in-out ${
                viewMode === 'terminal' ? 'opacity-100' : 'opacity-0 pointer-events-none'
              }`}
            >Terminal</span>
          </button>
        </div>
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
