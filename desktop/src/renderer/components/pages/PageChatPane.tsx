// The page's assistant, floating over an open page (pages-finish step 3: decisions 2026-11-02, layout
// rounds 1-3; one view for asking, changing and redesigning; it replaces Edit in chat). DESIGN STAGE: the workbench shows it with whichever session
// is current; which session it holds (a chat started in the page's project, marked with its icon) is
// the build's job.
//
// WHY the main window's own ChatView and InputBar, compact: the buddy's small window already proved
// the main chat reads well at this width (BuddyChat.tsx), so every card, ask and warning is the one
// people know. The header and the message box are the buddy's too (see the header below); the chat's
// top/bottom clearances are set on the pane so the main window's are untouched.
import React, { useEffect, useRef } from 'react';
import ChatView from '../ChatView';
import InputBar from '../InputBar';
import SessionStrip from '../SessionStrip';
import { Tooltip } from '../ui';
import { ON_INSET_CONTROL } from '../header/control-states';
import { CompactSurfaceContext, type CompactSurface } from '../../state/compact-surface-context';
import type { PageSummary } from '../../../shared/pages-types';

const COMPACT: CompactSurface = { tools: 'summary' };
// The header row's height, which the chat clears at its top (page-chat.css reads it): the buddy's bar
// (34px) plus its 6px inset.
const HEADER_PX = 40;

interface PageChatPaneProps {
  page: PageSummary;
  sessionId: string;
  /** The conversation's own name, as the session list shows it (Destin, layout deck: "a real session name"). */
  sessionName: string;
  cwd?: string;
  /** Hides the pane; the chat keeps its place and carries on (Destin: an X "reads as end chat permanently"). */
  onHide: () => void;
  className?: string;
  /** Size and place, from the host. */
  style?: React.CSSProperties;
}

export function PageChatPane({ page, sessionId, sessionName, cwd, onHide, className = '', style }: PageChatPaneProps) {
  const paneRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // The message box's height, written on THIS pane (never <html>): the main window's chat, behind the
  // page, keeps its own. Skips identical writes, like useChromeMeasurements.
  useEffect(() => {
    const pane = paneRef.current;
    const bottom = bottomRef.current;
    if (!pane || !bottom) return;
    const update = () => {
      const v = `${Math.ceil(bottom.getBoundingClientRect().height)}px`;
      if (pane.style.getPropertyValue('--bottom-chrome-height') !== v) pane.style.setProperty('--bottom-chrome-height', v);
    };
    const observer = new ResizeObserver(update);
    observer.observe(bottom);
    update();
    return () => observer.disconnect();
  }, []);

  return (
    <CompactSurfaceContext.Provider value={COMPACT}>
      {/* WHY no position class here: the host's layout gives one (relative beside the page, absolute over it);
          two would fight, and `relative` won — the floating card and the phone sheet landed top-left. */}
      <div ref={paneRef} className={`page-chat-pane overflow-hidden ${className}`}
        style={{ ...style, '--top-chrome-height': `${HEADER_PX}px` } as React.CSSProperties} data-page-chat>
        {/* WHY the buddy's header, not one of its own (round 3, Destin: "it still looks like an entirely unique
            window/element that matches nothing else used in the app"): the app's other small floating chat is the
            buddy, whose title is the main window's own session pill in a frosted bar (BuddyChat.tsx, buddy.css).
            The same pill here names the conversation, opens the list of this page's chats, and its + starts a new one,
            so there is no separate title or New chat button. Minimize is the window's own minimize button. */}
        <div className="page-chat-header absolute top-0 inset-x-0 z-30 select-none" style={{ height: HEADER_PX }}>
          <div className="header-bar page-chat-bar">
            <div className="flex-1 min-w-0 flex justify-center">
              <SessionStrip
                sessions={[{ id: sessionId, name: sessionName, cwd: cwd ?? '', permissionMode: 'normal' }]}
                activeSessionId={sessionId}
                // DESIGN STAGE: the build lists this page's chats here, and + starts one in the page's project.
                onSelectSession={() => {}}
                onCreateSession={() => {}}
                onCloseSession={() => {}}
                onOpenResumeBrowser={() => {}}
                viewer
              />
            </div>
            <div className="caption-buttons flex bg-inset rounded-md p-0.5 shrink-0">
              <Tooltip text="Hide the chat" placement="bottom">
                <button className={`px-2 py-1 rounded-[var(--radius-toggle)] flex items-center justify-center ${ON_INSET_CONTROL}`}
                  aria-label={`Hide the chat about ${page.name}`} onClick={onHide}>
                  <svg className="w-3.5 h-3.5" viewBox="0 0 10 10" aria-hidden><rect fill="currentColor" y="5" width="10" height="1" /></svg>
                </button>
              </Tooltip>
            </div>
          </div>
        </div>
        <ChatView sessionId={sessionId} visible sessionActive compact cwd={cwd} />
        <div ref={bottomRef} className="chrome-wrapper chrome-wrapper--bottom bottom-float page-chat-bottom">
          <InputBar sessionId={sessionId} compact />
        </div>
      </div>
    </CompactSurfaceContext.Provider>
  );
}
