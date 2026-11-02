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
import { Button, Tooltip } from '../ui';
import { CompactSurfaceContext, type CompactSurface } from '../../state/compact-surface-context';
import type { PageSummary } from '../../../shared/pages-types';

const COMPACT: CompactSurface = { tools: 'summary' };
// The header row's height, which the chat clears at its top (page-chat.css reads it).
const HEADER_PX = 40;

interface PageChatPaneProps {
  page: PageSummary;
  sessionId: string;
  /** The conversation's own name, as the session list shows it (Destin, layout deck: "a real session name"). */
  sessionName: string;
  cwd?: string;
  /** Hides the pane; the chat keeps its place and carries on (Destin: an X "reads as end chat permanently"). */
  onHide: () => void;
  /** Starts a fresh chat for this page (R-memory: the last chat opens, with New chat beside it). */
  onNewChat?: () => void;
  className?: string;
  /** Size and place, from the layout the host chose. */
  style?: React.CSSProperties;
}

export function PageChatPane({ page, sessionId, sessionName, cwd, onHide, onNewChat, className = '', style }: PageChatPaneProps) {
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
          {/* WHY no page icon and no rule under it (layout deck review): the page is right beside the chat, and a
              full-width line breaks the guide's no-full-width-lines rule. */}
          <span className="flex-1 min-w-0 truncate text-sm font-medium text-fg" title={sessionName}>{sessionName}</span>
          {onNewChat && (
            // WHY words, not an icon: a bare pencil read as "edit something" (layout deck review).
            <Button size="sm" variant="ghost" onClick={onNewChat} aria-label={`New chat about ${page.name}`}>
              <PlusGlyph />
              New chat
            </Button>
          )}
          <Tooltip text="Hide the chat" placement="bottom">
            <Button size="icon-sm" variant="ghost" aria-label="Hide the chat" className="w-7 h-7" onClick={onHide}>
              <MinimizeGlyph />
            </Button>
          </Tooltip>
        </div>
        <ChatView sessionId={sessionId} visible sessionActive compact cwd={cwd} />
        <div ref={bottomRef} className="page-chat-bottom absolute bottom-0 inset-x-0 z-20">
          <InputBar sessionId={sessionId} compact />
        </div>
      </div>
    </CompactSurfaceContext.Provider>
  );
}

function PlusGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function MinimizeGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M6 12h12" />
    </svg>
  );
}
