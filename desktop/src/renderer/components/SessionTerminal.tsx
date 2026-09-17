import React, { useEffect, useState } from 'react';
import TerminalView from './TerminalView';
import type { SessionProvider } from '../../shared/types';

// One session's terminal pane, mounted only when it can ever show anything.
//
// WHY (2026-09-16 audit W15): App rendered a full <TerminalView> — an xterm
// instance plus a WebGL context and glyph atlas — for EVERY open session,
// including native (non-Claude-Code) sessions, which have no PTY
// (session-manager.ts never spawns one for them) and so can never print into
// it. Six native sessions were six GPU contexts for six structurally blank
// panes, and Chromium evicts the oldest live context at ~16.
//
// A native session's terminal now mounts the first time its terminal view is
// actually selected (Ctrl+` still reaches it; the header hides the toggle) and
// stays mounted from then on, exactly as before. Claude Code and shell
// sessions are UNCHANGED: they mount at once, because usePromptDetector and
// useAttentionClassifier read the xterm buffer from session start and
// TerminalView's signalReady is what releases the PTY output buffered before
// the first mount.
export function SessionTerminal({ sessionId, provider, visible }: {
  sessionId: string;
  provider: SessionProvider | undefined;
  visible: boolean;
}) {
  const [everVisible, setEverVisible] = useState(visible);
  useEffect(() => { if (visible) setEverVisible(true); }, [visible]);
  if (provider === 'native' && !everVisible) return null;
  return <TerminalView sessionId={sessionId} visible={visible} />;
}
