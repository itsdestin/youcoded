// The page's assistant, beside an open page (pages-finish step 3, decisions 2026-11-02: "a narrow chat
// session on one side and the live-updating page on the other"; one view for asking, changing and
// redesigning; it replaces Edit in chat). DESIGN STAGE: the workbench shows it with whichever session
// is current; which session it holds (a chat started in the page's project, marked with its icon) is
// the build's job.
//
// WHY the main window's own ChatView and InputBar, compact: the buddy's small window already proved
// the main chat reads well at this width (BuddyChat.tsx), so every card, ask and warning is the one
// people know. Only the frame is this pane's: a one-line header (the page's name, New chat, close) and
// the chat's own top/bottom clearances, set on the pane so the main window's are untouched.
import React, { useEffect, useRef } from 'react';
import ChatView from '../ChatView';
import InputBar from '../InputBar';
import { Button, CloseButton, Tooltip } from '../ui';
import { CompactSurfaceContext, type CompactSurface } from '../../state/compact-surface-context';
import { PageGlyph } from './page-icons';
import type { PageSummary } from '../../../shared/pages-types';

const COMPACT: CompactSurface = { tools: 'summary' };
// The header row's height, which the chat clears at its top (page-chat.css reads it).
const HEADER_PX = 40;

interface PageChatPaneProps {
  page: PageSummary;
  sessionId: string;
  cwd?: string;
  onClose: () => void;
  /** Starts a fresh chat for this page (R-memory: the last chat opens, with New chat beside it). */
  onNewChat?: () => void;
  className?: string;
  /** Size and place, from the layout the host chose. */
  style?: React.CSSProperties;
}

export function PageChatPane({ page, sessionId, cwd, onClose, onNewChat, className = '', style }: PageChatPaneProps) {
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
        <div className="page-chat-header absolute top-0 inset-x-0 z-20 flex items-center gap-2 px-3 select-none" style={{ height: HEADER_PX }}>
          <PageGlyph icon={page.icon} customIcon={page.customIcon} className="w-4 h-4 shrink-0 text-fg-muted" />
          <span className="flex-1 min-w-0 truncate text-sm font-medium text-fg">{page.name} chat</span>
          {onNewChat && (
            <Tooltip text="New chat" placement="bottom">
              <Button size="icon-sm" variant="ghost" aria-label="New chat" className="w-7 h-7" onClick={onNewChat}>
                <NewChatGlyph />
              </Button>
            </Tooltip>
          )}
          <CloseButton label="Close the chat" size="icon-sm" onClick={onClose} />
        </div>
        <ChatView sessionId={sessionId} visible sessionActive compact cwd={cwd} />
        <div ref={bottomRef} className="page-chat-bottom absolute bottom-0 inset-x-0 z-20">
          <InputBar sessionId={sessionId} compact />
        </div>
      </div>
    </CompactSurfaceContext.Provider>
  );
}

function NewChatGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}
