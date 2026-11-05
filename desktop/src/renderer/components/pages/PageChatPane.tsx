// The page's assistant, floating over an open page (pages-finish step 3: decisions 2026-11-02, layout
// rounds 1-3; one view for asking, changing and redesigning; it replaces Edit in chat). DESIGN STAGE: the workbench shows it with whichever session
// is current; which session it holds (a chat started in the page's project, marked with its icon) is
// the build's job.
//
// WHY the main window's own ChatView and InputBar, compact: the buddy's small window already proved
// the main chat reads well at this width (BuddyChat.tsx), so every card, ask and warning is the one
// people know. The header and the message box are the buddy's too (see the header below); the chat's
// top/bottom clearances are set on the pane so the main window's are untouched.
import React, { useEffect, useRef, useState } from 'react';
import ChatView from '../ChatView';
import InputBar from '../InputBar';
import { Button, SectionLabel, Tooltip } from '../ui';
import { CompactSurfaceContext, type CompactSurface } from '../../state/compact-surface-context';
import type { PageSummary } from '../../../shared/pages-types';
import { workbenchPageVersionsOpen } from '../../workbench-mode';
import { useEscClose } from '../../hooks/use-esc-close';

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
  className?: string;
  /** Size and place, from the host. */
  style?: React.CSSProperties;
}

export function PageChatPane({ page, sessionId, sessionName, cwd, onHide, className = '', style }: PageChatPaneProps) {
  const paneRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [versionsOpen, setVersionsOpen] = useState(workbenchPageVersionsOpen);

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
          {/* WHY here and not a line under each reply (Undo round, Destin picked "versions"): changes still land at once,
              and taking one back is a trip to this list, like any version history. */}
          <Tooltip text="Earlier versions of this page" placement="bottom">
            <Button size="icon-sm" variant="ghost" aria-label={`Earlier versions of ${page.name}`} aria-expanded={versionsOpen}
              onClick={() => setVersionsOpen((o) => !o)} className="w-7 h-7"><VersionsGlyph /></Button>
          </Tooltip>
          <Tooltip text="New chat" placement="bottom">
            <Button size="icon-sm" variant="ghost" aria-label={`New chat about ${page.name}`} className="w-7 h-7"><PlusGlyph /></Button>
          </Tooltip>
          <Tooltip text="Hide the chat" placement="bottom">
            <Button size="icon-sm" variant="ghost" aria-label={`Hide the chat about ${page.name}`} onClick={onHide} className="w-7 h-7">
              <HideDownGlyph />
            </Button>
          </Tooltip>
        </div>
        {versionsOpen && <PageVersionsList pageName={page.name} onClose={() => setVersionsOpen(false)} />}
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
// An arrow turning back over a page's corner: "how it was", distinct from the clock of earlier chats.
function VersionsGlyph() {
  return <svg {...GLYPH}><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>;
}
function PlusGlyph() {
  return <svg {...GLYPH}><path d="M12 5v14M5 12h14" /></svg>;
}
function HideDownGlyph() {
  return <svg {...GLYPH}><path d="M6 9l6 6 6-6" /></svg>;
}

/** DESIGN STAGE: the practice conversation's three requests, newest first. The build lists the history points taken
 *  before each reply that changed the page (and the synced history before that), from the page's own git. */
const PRACTICE_VERSIONS = [
  { before: 'let me add a note to each bill', when: '2:14 PM', kind: 'The page' },
  { before: 'move my netflix bill to the 15th', when: '2:10 PM', kind: 'Its information' },
];

/** The page as it was before each change, each with Put back. WHY under the header and the chat's own width: it is
 *  about this page, like the chat; a menu off the button would cover the button row. WHY any version and nothing lost
 *  (Destin, Undo round K-which: "it should just work like any other typical version history menu and let me resume
 *  from any of the checkpoints"): putting one back is itself a new version, so the page you had stays in the list. */
function PageVersionsList({ pageName, onClose }: { pageName: string; onClose: () => void }) {
  // WHY on the app's Escape stack: it sits over the chat, so one Esc closes the list and leaves the chat open
  // (shoot's Escape check caught the list and the whole page closing together).
  useEscClose(true, onClose);
  return (
    <div className="page-versions layer-surface absolute top-11 inset-x-2 z-40 rounded-lg p-1.5 select-none" role="dialog" aria-label={`Earlier versions of ${pageName}`}>
      <div className="flex items-center px-2 pt-1 pb-1.5">
        <span className="flex-1 text-xs font-medium text-fg-muted">Earlier versions</span>
      </div>
      <p className="px-2 pb-2 text-xs text-fg-muted">Putting one back keeps what you have now in this list.</p>
      <div className="flex items-center gap-2 px-2 py-2 rounded-md bg-inset">
        <div className="flex-1 min-w-0">
          <div className="text-sm text-fg">Now</div>
          <div className="text-xs text-fg-muted">What you see</div>
        </div>
      </div>
      {PRACTICE_VERSIONS.map((v) => (
        <div key={v.before} className="flex items-center gap-2 px-2 py-2">
          <div className="flex-1 min-w-0">
            <div className="text-sm text-fg truncate">Before “{v.before}”</div>
            <div className="text-xs text-fg-muted">{v.when} · {v.kind} changed</div>
          </div>
          <Button size="sm" variant="secondary" onClick={onClose}>Put back</Button>
        </div>
      ))}
    </div>
  );
}
