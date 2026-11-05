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
import { Button, SectionLabel, Tooltip } from '../ui';
import { CompactSurfaceContext, type CompactSurface } from '../../state/compact-surface-context';
import type { PageSummary } from '../../../shared/pages-types';

const COMPACT: CompactSurface = { tools: 'summary' };
// The header row's height, which the chat clears at its top (page-chat.css reads it): the page list's
// label row with its 28px buttons.
const HEADER_PX = 44;

interface PageChatPaneProps {
  page: PageSummary;
  sessionId: string;
  /** The conversation's own name, as the session list shows it (Destin, layout deck: "a real session name"). */
  sessionName: string;
  cwd?: string;
  /** Hides the pane; the chat keeps its place and carries on (Destin: an X "reads as end chat permanently"). */
  onHide: () => void;
  /** Docked beside the page it folds away like the page list (a panel glyph); floating it drops down (a chevron). */
  hideGlyph: 'panel' | 'minimize';
  className?: string;
  /** Size and place, from the host. */
  style?: React.CSSProperties;
}

export function PageChatPane({ page, sessionId, sessionName, cwd, onHide, hideGlyph, className = '', style }: PageChatPaneProps) {
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
      <div ref={paneRef} className={`page-chat-pane overflow-hidden select-none ${className}`}
        style={{ ...style, '--top-chrome-height': `${HEADER_PX}px` } as React.CSSProperties} data-page-chat>
        {/* WHY the page list's own header, not the buddy's (round 4, Destin: "that's almost worse somehow. we need a
            conversation/chat window that feels native to these screens"): the label is the page list's group label
            (SectionLabel, as "Built in"), naming the conversation, and the buttons are the page list's quiet icon
            buttons (its fold button's size and stroke). Earlier chats and a new one get their own buttons again. */}
        <div className="page-chat-header absolute top-0 inset-x-0 z-30 select-none flex items-center gap-1 pl-4 pr-2" style={{ height: HEADER_PX }}>
          <SectionLabel className="flex-1 min-w-0 truncate">{sessionName}</SectionLabel>
          {/* DESIGN STAGE: the build lists this page's chats here, and + starts one in the page's project. */}
          <Tooltip text="Earlier chats about this page" placement="bottom">
            <Button size="icon-sm" variant="ghost" aria-label={`Earlier chats about ${page.name}`} className="w-7 h-7"><HistoryGlyph /></Button>
          </Tooltip>
          <Tooltip text="New chat" placement="bottom">
            <Button size="icon-sm" variant="ghost" aria-label={`New chat about ${page.name}`} className="w-7 h-7"><PlusGlyph /></Button>
          </Tooltip>
          <Tooltip text="Hide the chat" placement="bottom">
            <Button size="icon-sm" variant="ghost" aria-label={`Hide the chat about ${page.name}`} onClick={onHide} className="w-7 h-7">
              {hideGlyph === 'panel' ? <HidePanelGlyph /> : <HideDownGlyph />}
            </Button>
          </Tooltip>
        </div>
        <ChatView sessionId={sessionId} visible sessionActive compact cwd={cwd} />
        <div ref={bottomRef} className="chrome-wrapper chrome-wrapper--bottom bottom-float page-chat-bottom">
          <InputBar sessionId={sessionId} compact />
        </div>
      </div>
    </CompactSurfaceContext.Provider>
  );
}

// The page list's icon language: 24-unit strokes at 1.8, 16px (PageHost's RailToggleGlyph).
const GLYPH = { className: 'w-4 h-4', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
function HistoryGlyph() {
  return <svg {...GLYPH}><path d="M4 12a8 8 0 1 0 2.4-5.7" /><path d="M4 4v3.5h3.5" /><path d="M12 8v4l2.5 2" /></svg>;
}
function PlusGlyph() {
  return <svg {...GLYPH}><path d="M12 5v14M5 12h14" /></svg>;
}
/** The page list's fold glyph, mirrored: the panel's right column, the chevron pointing the way it goes. */
function HidePanelGlyph() {
  return <svg {...GLYPH}><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M15 4v16" /><path d="M8 10l2 2-2 2" /></svg>;
}
function HideDownGlyph() {
  return <svg {...GLYPH}><path d="M6 9l6 6 6-6" /></svg>;
}
