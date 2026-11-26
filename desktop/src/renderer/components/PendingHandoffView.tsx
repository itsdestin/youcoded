import React from 'react';
import type { PendingTab } from '../state/pending-handoff';
import SessionPreviewPane from './SessionPreviewPane';
import { HandoffFreshnessInline } from './HandoffFreshnessInline';
import { ErrorState } from './ui';
import { SessionDrawer } from './SessionDrawer';
import { useActiveProject } from '../hooks/useActiveProject';
import { ScreenMark } from '../shoot-mode';

/** WHY: the saved provider-local transcript is a read-only preview, not a
 * fabricated writer. Its pager never opens a native host or Claude process. */
export default function PendingHandoffView({ tab, visible, onRetry, onContinue, drawerOpen, expanded, gamePane, note }: {
  tab: PendingTab;
  visible: boolean;
  onRetry: () => void;
  onContinue: () => void;
  drawerOpen: boolean;
  expanded: boolean;
  gamePane: React.ReactNode;
  /** A sentence about the last move attempt ("Couldn't take over from your other computer…"), shown here and nowhere else.
   *  WHY sentence only (Destin, waiting-notice deck R-screen): this screen already has its own Try again and Continue buttons,
   *  so a floating notice with a button of its own would show two sets of buttons for one problem. */
  note?: string | null;
}) {
  const gameOpen = !!gamePane;
  const activeProject = useActiveProject(tab.cwd, drawerOpen && !gameOpen);
  return (
    <div className="absolute inset-0 flex flex-col" style={{ visibility: visible ? 'visible' : 'hidden' }}>
      {/* WHY: use ChatView's right-slot geometry, not a full-width imitation.
          The notice remains full width of the CHAT column with a drawer/game open. */}
      <div className={`framed-shell${drawerOpen || gameOpen ? ' drawer-open' : ''}${expanded && drawerOpen && !gameOpen ? ' drawer-expanded' : ''}`}>
        <div className="frame-edge" />
        <div className="chat-pane">
          {visible && <ScreenMark name="chat/handoff" />}
          <div className="flex-1 min-h-0 overflow-hidden" style={{ paddingTop: 'var(--top-chrome-bottom, 3rem)', paddingBottom: 'var(--bottom-chrome-height, 5rem)' }}>
            <SessionPreviewPane provider={tab.provider} id={tab.conversationId} title={tab.name} projectSlug={tab.projectSlug} backdrop={false} />
          </div>
          {note && (
            <div className="absolute inset-x-3 text-sm text-fg-2 layer-surface px-4 py-2" role="status" style={{ top: 'calc(var(--top-chrome-bottom, 3rem) + 0.5rem)' }}>{note}</div>
          )}
          {tab.phase === 'failed' ? (
            <div className="handoff-freshness-toast absolute inset-x-3">
              <ErrorState message="Couldn't finish moving this conversation here." onRetry={onRetry} />
            </div>
          ) : <HandoffFreshnessInline phase={tab.phase} onRetry={onRetry} onContinue={onContinue} />}
        </div>
        {visible && (gameOpen ? (
          <><div className="frame-divider" /><div className="drawer-pane game-pane">{gamePane}</div></>
        ) : drawerOpen && (
          <><div className="frame-divider" /><div className="drawer-pane">
            <SessionDrawer sessionId={tab.tabId} cwd={tab.cwd} projectRoot={activeProject?.path ?? ''}
              projectId={activeProject?.id ?? ''} projectName={activeProject?.name ?? 'project'} />
          </div></>
        ))}
        <div className="frame-edge" />
      </div>
    </div>
  );
}
