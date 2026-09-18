import React from 'react';
import { SessionDrawer } from './SessionDrawer';
import { useActiveProject } from '../hooks/useActiveProject';
import { RightPaneSlot } from './RightPaneSlot';
import type { RightPane } from '../hooks/use-right-pane-motion';

interface Props {
  sessionId: string;
  cwd?: string;
  /** The active game pane element, or null when no game panel is open. */
  gamePane: React.ReactNode;
  /** App's right-pane motion table: what is shown, and whether it is leaving. */
  pane: RightPane;
  /** Whether the artifact drawer is in expand-in-place mode (game pane never expands). */
  expanded: boolean;
}

/**
 * Terminal-view right-slot overlay (Bug #2).
 *
 * The artifact drawer and game pane normally live inside ChatView's
 * framed-shell right slot. In terminal view ChatView is hidden
 * (visibility:hidden), so opening a panel there expanded the chrome-glass
 * cutout but showed no content. This renders a single framed-shell CLONE that
 * floats over the terminal, reusing the exact `.framed-shell > .drawer-pane`
 * chrome (framed margins, floating-pill variants, rounded corners) so the
 * panel looks identical to chat view.
 *
 * The container + empty chat-pane spacer are click-through (pointer-events
 * none in globals.css) so the terminal underneath stays interactive; only the
 * drawer-pane itself takes pointer events. ChatView gates its own copy on
 * `visible`, so exactly one instance of the drawer/game mounts at a time.
 */
export default function TerminalRightSlot({ sessionId, cwd, gamePane, pane, expanded }: Props) {
  const gameOpen = pane.motion.shown === 'game';
  // Resolve the project only while the artifact drawer (not the game pane) is
  // shown — which includes the moment it glides OUT, or its header would flicker.
  const activeProject = useActiveProject(cwd, pane.motion.shown === 'drawer');

  return (
    <div className="terminal-panel-shell">
      <div className={`framed-shell drawer-open${expanded && !gameOpen ? ' drawer-expanded' : ''}`}>
        {/* Transparent spacer standing in for the chat pane — pushes the
            drawer to the right and lets the terminal show through + stay
            interactive (click-through via CSS). */}
        <div className="chat-pane terminal-panel-spacer" />
        {/* key: remount the drawer when the active session changes so per-session
            state (open file, scroll, review, a late git discard failure banner)
            can't cross-paint into the other session's drawer. Chat view gets this
            by construction — App mounts one ChatView per session — but this
            overlay is a single instance bound to the ACTIVE session. */}
        <RightPaneSlot pane={pane} sessionId={sessionId} gamePane={gamePane} renderDrawer={() => (
          <SessionDrawer key={sessionId} sessionId={sessionId} cwd={cwd ?? ''} projectRoot={activeProject?.path ?? ''}
            projectId={activeProject?.id ?? ''} projectName={activeProject?.name ?? 'project'} />
        )} />
      </div>
    </div>
  );
}
