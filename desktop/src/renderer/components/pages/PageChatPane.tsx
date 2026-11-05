// The page's assistant, floating over an open page (pages-finish step 3: decisions 2026-11-02, layout rounds 1-5,
// Undo round step3f; build design youcoded-dev/docs/active/specs/2026-11-05-pages-step3-build.md §E). One view for
// asking, changing and redesigning; it replaces Edit in chat. Which chat it holds is use-page-assistant.ts's job.
//
// WHY the main window's own ChatView and InputBar, compact: the buddy's small window already proved
// the main chat reads well at this width (BuddyChat.tsx), so every card, ask and warning is the one
// people know. The chat's top/bottom clearances are set on the pane so the main window's are untouched.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import ChatView from '../ChatView';
import InputBar from '../InputBar';
import { Button, ErrorState, LoadingState, SectionLabel, Tooltip } from '../ui';
import { CompactSurfaceContext, type CompactSurface } from '../../state/compact-surface-context';
import type { PageAssistantChat, PageSummary, PagesBridge, PageVersion } from '../../../shared/pages-types';
import { workbenchPageVersionsOpen } from '../../workbench-mode';
import { useEscClose } from '../../hooks/use-esc-close';
import type { PageAssistantStatus } from './use-page-assistant';

const COMPACT: CompactSurface = { tools: 'summary' };
// The header row's height, which the chat clears at its top (page-chat.css reads it): the page list's
// label row with its 28px buttons.
const HEADER_PX = 44;

interface PageChatPaneProps {
  page: PageSummary;
  /** The chat shown; null while it is starting or could not start. */
  sessionId: string | null;
  /** The conversation's own name, as the session list shows it (Destin, layout deck: "a real session name"). */
  sessionName: string;
  status: PageAssistantStatus;
  error: string | null;
  chats: PageAssistantChat[];
  onListChats: () => void;
  onOpenChat: (chat: PageAssistantChat) => void;
  onNewChat: () => void;
  onRetry: () => void;
  /** Hides the pane; the chat keeps its place and carries on (Destin: an X "reads as end chat permanently"). */
  onHide: () => void;
  className?: string;
  /** Size and place, from the host. */
  style?: React.CSSProperties;
}

type Popover = 'chats' | 'versions' | null;

export function PageChatPane({ page, sessionId, sessionName, status, error, chats, onListChats, onOpenChat, onNewChat, onRetry, onHide, className = '', style }: PageChatPaneProps) {
  const paneRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [popover, setPopover] = useState<Popover>(() => (workbenchPageVersionsOpen() ? 'versions' : null));
  const toggle = (which: Exclude<Popover, null>) => setPopover((p) => (p === which ? null : which));
  const closePopover = useCallback(() => setPopover(null), []);

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
  }, [sessionId]);

  const starting = status === 'starting' || (status === 'idle' && !sessionId);

  return (
    <CompactSurfaceContext.Provider value={COMPACT}>
      {/* WHY no position class here: the host's layout gives one (relative beside the page, absolute over it);
          two would fight, and `relative` won — the floating card and the phone sheet landed top-left. */}
      <div ref={paneRef} className={`page-chat-pane overflow-hidden select-none ${className}`}
        style={{ ...style, '--top-chrome-height': `${HEADER_PX}px` } as React.CSSProperties} data-page-chat>
        {/* WHY the page list's own header, not the buddy's (round 4, Destin: "that's almost worse somehow. we need a
            conversation/chat window that feels native to these screens"): the label is the page list's group label
            (SectionLabel, as "Built in"), naming the conversation, and the buttons are the page list's quiet icon
            buttons (its fold button's size and stroke). */}
        <div className="page-chat-header absolute top-0 inset-x-0 z-30 select-none flex items-center gap-1 pl-4 pr-2" style={{ height: HEADER_PX }}>
          {/* The label cuts a long name with "…" (page-chat.css): SectionLabel owns its type, the row its width. */}
          <div className="flex-1 min-w-0"><SectionLabel>{sessionId ? sessionName : 'New chat'}</SectionLabel></div>
          <Tooltip text="Earlier chats about this page" placement="bottom">
            <Button size="icon-sm" variant="ghost" aria-label={`Earlier chats about ${page.name}`} aria-expanded={popover === 'chats'}
              onClick={() => { if (popover !== 'chats') onListChats(); toggle('chats'); }} className="w-7 h-7"><HistoryGlyph /></Button>
          </Tooltip>
          {/* WHY here and not a line under each reply (Undo round, Destin picked "versions"): changes still land at once,
              and taking one back is a trip to this list, like any version history. */}
          <Tooltip text="Earlier versions of this page" placement="bottom">
            <Button size="icon-sm" variant="ghost" aria-label={`Earlier versions of ${page.name}`} aria-expanded={popover === 'versions'}
              onClick={() => toggle('versions')} className="w-7 h-7"><VersionsGlyph /></Button>
          </Tooltip>
          <Tooltip text="New chat" placement="bottom">
            <Button size="icon-sm" variant="ghost" aria-label={`New chat about ${page.name}`} disabled={status === 'starting'}
              onClick={() => { setPopover(null); onNewChat(); }} className="w-7 h-7"><PlusGlyph /></Button>
          </Tooltip>
          <Tooltip text="Hide the chat" placement="bottom">
            <Button size="icon-sm" variant="ghost" aria-label={`Hide the chat about ${page.name}`} onClick={onHide} className="w-7 h-7">
              <HideDownGlyph />
            </Button>
          </Tooltip>
        </div>
        {popover === 'versions' && <PageVersionsList page={page} onClose={closePopover} />}
        {popover === 'chats' && (
          <PageChatsList page={page} chats={chats} current={sessionId}
            onPick={(c) => { setPopover(null); onOpenChat(c); }} onClose={closePopover} />
        )}
        {sessionId && status === 'ready' ? (
          <>
            <ChatView sessionId={sessionId} visible sessionActive compact />
            <div ref={bottomRef} className="chrome-wrapper chrome-wrapper--bottom bottom-float page-chat-bottom">
              <InputBar sessionId={sessionId} compact />
            </div>
          </>
        ) : (
          <div className="absolute inset-x-3 bottom-3" style={{ top: HEADER_PX + 8 }}>
            {status === 'failed' && error
              ? <ErrorState message={error} onRetry={onRetry} />
              : starting && <LoadingState what="the chat" verb="Starting" />}
          </div>
        )}
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

const timeOf = (ms: number) => {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};

const CHANGE_WORDS: Record<NonNullable<PageVersion['change']>, string> = {
  page: 'The page changed',
  data: 'Its information changed',
  both: 'The page and its information changed',
};

function pagesBridge(): PagesBridge | undefined {
  return (window as unknown as { claude?: { pages?: PagesBridge } }).claude?.pages;
}

/** The page as it was before each request, each with Put back. WHY under the header and the chat's own width: it is
 *  about this page, like the chat; a menu off the button would cover the button row. WHY any version and nothing lost
 *  (Destin, Undo round K-which: "it should just work like any other typical version history menu and let me resume
 *  from any of the checkpoints"): putting one back first saves what is there, so the page you had stays in the list.
 *  Versions that equal the page as it is now are left out: putting one back would change nothing. */
function PageVersionsList({ page, onClose }: { page: PageSummary; onClose: () => void }) {
  // WHY on the app's Escape stack: it sits over the chat, so one Esc closes the list and leaves the chat open
  // (shoot's Escape check caught the list and the whole page closing together).
  useEscClose(true, onClose);
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'ready'; versions: PageVersion[] } | { kind: 'failed'; message: string }>({ kind: 'loading' });
  const [busy, setBusy] = useState<number | null>(null);
  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    const r = await pagesBridge()?.versions?.(page.id).catch((e: unknown) => ({ ok: false as const, message: e instanceof Error ? e.message : String(e) }));
    if (!r) setState({ kind: 'failed', message: 'Versions are not available here.' });
    else setState(r.ok ? { kind: 'ready', versions: r.versions } : { kind: 'failed', message: r.message });
  }, [page.id]);
  useEffect(() => { void load(); }, [load]);
  const putBack = async (at: number) => {
    setBusy(at);
    const r = await pagesBridge()?.restoreVersion?.(page.id, at).catch((e: unknown) => ({ ok: false as const, message: e instanceof Error ? e.message : String(e) }));
    setBusy(null);
    if (!r) setState({ kind: 'failed', message: 'Versions are not available here.' });
    else setState(r.ok ? { kind: 'ready', versions: r.versions } : { kind: 'failed', message: r.message });
  };
  const shown = state.kind === 'ready' ? state.versions.filter((v) => v.change !== null) : [];
  return (
    // WHY two boxes: the surface (its fill and edge) on the outside, the scroll and its edge fade inside, or the
    // fade would fade the surface's own edge too (scroll-mask.css).
    <div className="layer-surface absolute top-11 inset-x-2 z-40 rounded-lg select-none flex flex-col" data-page-popover="versions" role="dialog" aria-label={`Earlier versions of ${page.name}`}>
      <div className="scroll-mask overflow-y-auto min-h-0 p-1.5">
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
      {state.kind === 'loading' && <div className="px-2 py-2"><LoadingState what="versions" variant="inline" /></div>}
      {state.kind === 'failed' && <div className="p-2"><ErrorState message={state.message} onRetry={() => { void load(); }} /></div>}
      {state.kind === 'ready' && shown.length === 0 && (
        <p className="px-2 py-2 text-xs text-fg-muted">None yet. A version is saved before each message you send here.</p>
      )}
      {shown.map((v) => (
        <div key={v.at} className="flex items-center gap-2 px-2 py-2">
          <div className="flex-1 min-w-0">
            <div className="text-sm text-fg truncate">{v.label.startsWith('Before putting back') ? v.label : `Before “${v.label}”`}</div>
            <div className="text-xs text-fg-muted">{timeOf(v.at)} · {CHANGE_WORDS[v.change!]}</div>
          </div>
          <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => { void putBack(v.at); }}>
            {busy === v.at ? 'Putting back…' : 'Put back'}
          </Button>
        </div>
      ))}
      </div>
    </div>
  );
}

/** This page's chats, the one used last first; pick one to continue it. Names come from Resume's list. */
function PageChatsList({ page, chats, current, onPick, onClose }: { page: PageSummary; chats: PageAssistantChat[]; current: string | null; onPick: (c: PageAssistantChat) => void; onClose: () => void }) {
  useEscClose(true, onClose);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let gone = false;
    void (async () => {
      const rows = await window.claude.session.browse().catch(() => []) as Array<{ sessionId: string; name?: string }>;
      if (!gone) setNames(new Map(rows.filter((r) => r.name).map((r) => [r.sessionId, r.name!])));
    })();
    return () => { gone = true; };
  }, []);
  return (
    <div className="layer-surface absolute top-11 inset-x-2 z-40 rounded-lg select-none flex flex-col" data-page-popover="chats" role="dialog" aria-label={`Earlier chats about ${page.name}`}>
      <div className="scroll-mask overflow-y-auto min-h-0 p-1.5">
      <div className="flex items-center px-2 pt-1 pb-1.5">
        <span className="flex-1 text-xs font-medium text-fg-muted">Chats about this page</span>
      </div>
      {chats.length === 0 && <p className="px-2 py-2 text-xs text-fg-muted">No other chats yet.</p>}
      {chats.map((c) => {
        const isCurrent = !!current && c.sessionId === current;
        const name = (c.conversationId && names.get(c.conversationId)) || 'New chat';
        return (
          <button key={c.conversationId ?? c.sessionId ?? c.startedAt} type="button" disabled={isCurrent}
            onClick={() => onPick(c)}
            className={`w-full flex items-center gap-2 px-2 py-2 rounded-md text-left ${isCurrent ? 'bg-inset' : 'hover:bg-inset'}`}>
            <span className="flex-1 min-w-0">
              <span className="block text-sm text-fg truncate">{name}</span>
              <span className="block text-xs text-fg-muted">{isCurrent ? 'Showing now' : timeOf(c.usedAt)}{!isCurrent && c.provider === 'native' && !c.live ? ' · Opens in the main window' : ''}</span>
            </span>
          </button>
        );
      })}
      </div>
    </div>
  );
}
