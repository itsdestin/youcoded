// PageHost — a page open inside the app (Phase 1 shell).
//
// The page runs in an iframe with the SAME sandbox HtmlView.tsx uses for HTML
// previews — `allow-scripts allow-popups allow-forms`, never
// `allow-same-origin` — so it is an opaque origin that cannot script the app
// (scope §4). Phase 1 adds no bridge into the frame; the only message that
// crosses is the theme.
//
// Theme: page-theme.ts bakes the current tokens and the style kit into the
// document before it is framed, then posts fresh tokens whenever the host's
// theme changes. The frame's srcDoc never changes after load, so a theme
// switch keeps whatever the page was doing (scope §2).
//
// THE PAGE VIEW'S OWN FRAME (shell deck round 3, 2026-09-16). Destin picked
// the side-panel layout and described the frame: "a similar style [to the app
// frame], but a unique frame built for page view. keep exit/maximize/minimize,
// but put the back to chat option where the games/files panels would be, a
// page name where the session browser would be, and the new side panel
// instead of the settings/project panel options." The rail "should list all
// pages, with the pin icon next to them. a centered manage pages button at the
// bottom of this panel will open the full page management screen. esc/back to
// chat should still be its own option at the top right. the rail should be
// collapsible with a button at the top left." So:
//
//   ┌ [☰ rail]            ◷ Page name · Edit in chat        [‹ Back to chat] [– □ ×] ┐
//   │ rail: every page, grouped, pin beside each │  the page, in a rounded pane   │
//   │ … [ Manage pages ]                         │                                 │
//
// Opened by PAGE_OPENED (from a card, a pinned button, or a rail row); renders
// nothing while no page is open. Sits above the library (z-50 over its z-40)
// so Manage pages can open the library on top, and Back returns to chat.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useArtifact } from '../../state/ArtifactContext';
import { useEscClose } from '../../hooks/use-esc-close';
import { Button, LoadingState, ErrorState, Tooltip } from '../ui';
import { CaptionButtons, MacTrafficLights, showCaptionButtons } from '../HeaderBar';
import type { PageDocument, PageLoadFailure, PageSummary, PagesBridge } from '../../../shared/pages-types';
import { MAX_PINNED_PAGES } from '../../../shared/pages-types';
import { PageGlyph, PagesIcon, PinGlyph } from './page-icons';
import { usePages, setPagePinned } from './use-pages';
import { PAGE_KIT_CSS } from './page-kit';
import { PAGE_THEME_MESSAGE, prepareHostedDocument, readThemeCss, watchThemeCss } from './page-theme';

interface PageHostProps {
  /** Opens the creator on THIS page: a conversation that edits it. Owned by App. */
  onEditInChat: (pageId: string) => void;
}

type Load =
  | { state: 'loading' }
  | { state: 'ready'; page: PageDocument; doc: string }
  | { state: 'failed'; failure: PageLoadFailure };

export function PageHost({ onEditInChat }: PageHostProps) {
  const { state, dispatch } = useArtifact();
  const pageId = state.openPageId;
  // Back to chat closes the page AND the library beneath it: the rail's
  // Manage pages opens the library over the page, but Esc/Back from the page
  // itself means "I am done with pages".
  const backToChat = () => { dispatch({ type: 'PAGE_CLOSED' }); dispatch({ type: 'PAGES_VIEW_CLOSED' }); };
  useEscClose(pageId !== null && !state.pagesViewOpen, backToChat);
  const { pages } = usePages();
  const summary = pages.find((p) => p.id === pageId) ?? null;
  const pinnedCount = pages.filter((p) => p.pinned).length;
  const [railOpen, setRailOpen] = useState(true);
  const headerRef = useRef<HTMLDivElement>(null);

  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const frameRef = useRef<HTMLIFrameElement>(null);

  // Fetch the working version when the open page changes. The document is
  // prepared ONCE here, with the theme of that moment; later theme changes go
  // through postMessage below rather than a new srcDoc (which would reload
  // the page and lose its state).
  useEffect(() => {
    if (pageId === null) return;
    let cancelled = false;
    setLoad({ state: 'loading' });
    const bridge = (window as unknown as { claude?: { pages?: PagesBridge } }).claude?.pages;
    if (!bridge) {
      setLoad({ state: 'failed', failure: { kind: 'unreadable', message: 'Pages are not available in this window.' } });
      return;
    }
    bridge.get(pageId).then((r) => {
      if (cancelled) return;
      if (r.ok) setLoad({ state: 'ready', page: r.page, doc: prepareHostedDocument(r.page.html, readThemeCss(), PAGE_KIT_CSS) });
      else setLoad({ state: 'failed', failure: r.failure });
    }, () => {
      if (!cancelled) setLoad({ state: 'failed', failure: { kind: 'unreadable', message: 'The page could not be read.' } });
    });
    return () => { cancelled = true; };
  }, [pageId]);

  // Live theme: watch the host document and post the fresh tokens in.
  useEffect(() => {
    if (load.state !== 'ready') return;
    return watchThemeCss((css) => {
      frameRef.current?.contentWindow?.postMessage({ type: PAGE_THEME_MESSAGE, css }, '*');
    });
  }, [load.state]);

  const title = useMemo(() => summary?.name ?? (load.state === 'ready' ? load.page.name : 'Page'), [summary, load]);
  if (pageId === null) return null;

  const personal = pages.filter((p) => p.home.kind === 'personal');
  const byProject = new Map<string, PageSummary[]>();
  for (const p of pages) {
    if (p.home.kind !== 'project') continue;
    const list = byProject.get(p.home.name) ?? [];
    list.push(p);
    byProject.set(p.home.name, list);
  }

  return (
    <div className="fixed inset-0 bg-panel z-50 flex flex-col">
      {/* The page view's own header: same band, same drag region and window
          buttons as the app's header; different contents. */}
      <div
        ref={headerRef}
        className="header-bar !relative flex items-center h-10 px-2 sm:px-3 shrink-0 select-none bg-panel border-b border-edge"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <MacTrafficLights headerRef={headerRef} />
        <div className="flex items-center gap-1 sm:gap-2 flex-1 basis-0">
          <Tooltip text={railOpen ? 'Hide the pages panel' : 'Show the pages panel'} placement="bottom">
            <button
              type="button"
              className="relative p-1 rounded-sm hover:bg-inset transition-colors shrink-0 text-fg-muted hover:text-fg"
              onClick={() => setRailOpen((o) => !o)}
              aria-label={railOpen ? 'Hide pages panel' : 'Show pages panel'}
              aria-pressed={railOpen}
            >
              <RailToggleIcon open={railOpen} />
            </button>
          </Tooltip>
        </div>
        {/* Centre: the page's name where the session strip would be, with the
            creator's entry point beside it. */}
        <div className="flex items-center justify-center gap-2 min-w-0 shrink">
          {summary && <PageGlyph icon={summary.icon} className="w-4 h-4 text-fg-muted shrink-0" />}
          <span className="text-sm font-medium text-fg truncate">{title}</span>
          <Button variant="ghost" size="sm" onClick={() => onEditInChat(pageId)} className="shrink-0 text-fg-muted hover:text-fg px-2 hidden sm:inline-flex">
            Edit in chat
          </Button>
        </div>
        <div className="flex items-center justify-end gap-1 sm:gap-2 flex-1 basis-0">
          <Button variant="ghost" size="sm" onClick={backToChat} className="shrink-0 text-fg-2 px-2" aria-label="Back to chat">
            <span className="hidden sm:inline">Esc · </span>Back to chat
          </Button>
          {showCaptionButtons() && <CaptionButtons />}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        {railOpen && (
          <aside className="w-60 shrink-0 flex flex-col select-none border-r border-edge">
            <div className="flex-1 overflow-y-auto py-2">
              {personal.length > 0 && (
                <RailGroup label="Personal">
                  {personal.map((p) => (
                    <RailRow key={p.id} page={p} current={p.id === pageId} pinFull={pinnedCount >= MAX_PINNED_PAGES}
                      onOpen={() => dispatch({ type: 'PAGE_OPENED', pageId: p.id })} />
                  ))}
                </RailGroup>
              )}
              {[...byProject.entries()].map(([name, list]) => (
                <RailGroup key={name} label={name}>
                  {list.map((p) => (
                    <RailRow key={p.id} page={p} current={p.id === pageId} pinFull={pinnedCount >= MAX_PINNED_PAGES}
                      onOpen={() => dispatch({ type: 'PAGE_OPENED', pageId: p.id })} />
                  ))}
                </RailGroup>
              ))}
              {pages.length === 0 && <div className="px-4 py-3 text-xs text-fg-muted">No pages yet</div>}
            </div>
            <div className="p-3 border-t border-edge-dim flex justify-center">
              <Button variant="secondary" size="sm" onClick={() => dispatch({ type: 'PAGES_VIEW_OPENED' })} className="w-full justify-center">
                <PagesIcon className="w-3.5 h-3.5" />
                Manage pages
              </Button>
            </div>
          </aside>
        )}
        {/* The page, in a rounded pane inset by the frame edge — the page
            view's own take on the chat frame. */}
        <div className="flex-1 min-w-0 p-[var(--frame-edge,10px)] pl-0">
          <div className="relative w-full h-full rounded-xl overflow-hidden border border-edge bg-canvas">
            {load.state === 'loading' && <LoadingState what={title} verb="Opening" />}
            {load.state === 'failed' && (
              <div className="p-6 max-w-[34rem] mx-auto">
                <ErrorState message={load.failure.message} onRetry={() => dispatch({ type: 'PAGE_OPENED', pageId })} />
              </div>
            )}
            {load.state === 'ready' && (
              <iframe
                ref={frameRef}
                srcDoc={load.doc}
                sandbox="allow-scripts allow-popups allow-forms"
                className="absolute inset-0 w-full h-full border-0 bg-canvas"
                title={title}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function RailGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="pb-2">
      <div className="text-2xs font-medium text-fg-muted tracking-wider uppercase px-4 pt-2 pb-1">{label}</div>
      {children}
    </div>
  );
}

/** One page in the rail: glyph, name, and its pin at the right. The row opens
 *  the page; the pin is its own control and stops the row's click. */
function RailRow({ page, current, pinFull, onOpen }: { page: PageSummary; current: boolean; pinFull: boolean; onOpen: () => void }) {
  const cannotPin = !page.pinned && pinFull;
  return (
    <div
      role="button"
      tabIndex={0}
      data-rail-page={page.id}
      aria-current={current ? 'page' : undefined}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      className={`group w-full flex items-center gap-3 pl-4 pr-2 py-1.5 text-sm text-left cursor-pointer ${current ? 'bg-inset text-fg' : 'text-fg-2 hover:text-fg hover:bg-inset/60'}`}
    >
      <PageGlyph icon={page.icon} className="w-4 h-4 shrink-0" />
      <span className="flex-1 min-w-0 truncate">{page.name}</span>
      <Tooltip text={cannotPin ? `Up to ${MAX_PINNED_PAGES} pinned pages` : page.pinned ? 'Unpin from the top bar' : 'Pin to the top bar'} placement="bottom">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={page.pinned ? `Unpin ${page.name}` : `Pin ${page.name}`}
          aria-pressed={page.pinned}
          disabled={cannotPin}
          onClick={(e) => { e.stopPropagation(); void setPagePinned(page.id, !page.pinned); }}
          className={page.pinned ? 'text-fg' : 'text-fg-faint group-hover:text-fg-muted'}
        >
          <PinGlyph filled={page.pinned} />
        </Button>
      </Tooltip>
    </div>
  );
}

/** A panel-with-left-sidebar glyph; the sidebar fills when the rail is open. */
function RailToggleIcon({ open }: { open: boolean }) {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" strokeWidth={2} />
      <path d="M9 5v14" strokeWidth={2} />
      {open && <rect x="3" y="5" width="6" height="14" rx="1" fill="currentColor" stroke="none" />}
    </svg>
  );
}
