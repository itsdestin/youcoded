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
// THE PAGE VIEW'S OWN FRAME (shell deck rounds 3–4, 2026-09-16/17). Destin
// picked the side-panel layout and described the frame: "a similar style [to
// the app frame], but a unique frame built for page view. keep
// exit/maximize/minimize, but put the back to chat option where the
// games/files panels would be, a page name where the session browser would
// be, and the new side panel instead of the settings/project panel options."
// The panel "should list all pages, with the pin icon next to them. a centered
// manage pages button at the bottom of this panel will open the full page
// management screen. esc/back to chat should still be its own option at the
// top right. the rail should be collapsible with a button at the top left."
// Round 4: no divider under the band and none above Manage pages — "the edge
// of the frame itself should be the divider"; the page pane is inset from the
// chrome by the frame edge on every side, like the chat pane. Round 5: the
// panel sits in its own rounded container "kinda like games/files in framed
// chat sessions"; Back to chat is styled like the window buttons (the same
// inset pill, no outline); Edit is gone from the band — editing lives only in
// the Manage pages screen.
//
//   ┌ [▣]                    ◷ Page name                    [Back to chat Esc] [– □ ×] ┐
//   │╭─────────────────────╮ ╭──────────────────────────────────────────────────╮│
//   ││ every page, grouped, │ │  the page, in a rounded pane inset by the edge   ││
//   ││ pin beside each      │ │                                                  ││
//   ││ [   Manage pages   ] │ ╰──────────────────────────────────────────────────╯│
//
// Opened by PAGE_OPENED (from a card, a pinned button, or a panel row); renders
// nothing while no page is open. Sits above the library (z-50 over its z-40)
// so Manage pages can open the library on top, and Back returns to chat.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useArtifact } from '../../state/ArtifactContext';
import { useEscClose } from '../../hooks/use-esc-close';
import { Button, LoadingState, ErrorState, Tooltip } from '../ui';
import { CaptionButtons, MacTrafficLights, showCaptionButtons } from '../HeaderBar';
import type { PageDocument, PageLoadFailure, PageSummary, PagesBridge } from '../../../shared/pages-types';
import { MAX_PAGE_DATA_BYTES, MAX_PINNED_PAGES } from '../../../shared/pages-types';
import { PageGlyph, PagesIcon, PinGlyph } from './page-icons';
import { usePages, setPagePinned, refreshPages } from './use-pages';
import { PAGE_KIT_CSS } from './page-kit';
import { PAGE_DATA_SET_MESSAGE, PAGE_THEME_MESSAGE, prepareHostedDocument, readThemeCss, watchThemeCss } from './page-theme';


type Load =
  | { state: 'loading' }
  | { state: 'ready'; page: PageDocument; doc: string }
  | { state: 'failed'; failure: PageLoadFailure };

/** The band's icon buttons: the same 24px square the app's header uses for
 *  Settings, Pages and Projects, so the band reads as the same chrome. */
const BAND_ICON_BUTTON =
  'relative p-1 rounded-sm hover:bg-inset transition-colors shrink-0 text-fg-muted hover:text-fg';

export function PageHost() {
  const { state, dispatch } = useArtifact();
  const pageId = state.openPageId;
  // Back to chat closes the page AND the library beneath it: the panel's
  // Manage pages opens the library over the page, but Esc/Back from the page
  // itself means "I am done with pages".
  const backToChat = () => { dispatch({ type: 'PAGE_CLOSED' }); dispatch({ type: 'PAGES_VIEW_CLOSED' }); };
  useEscClose(pageId !== null && !state.pagesViewOpen, backToChat);
  const { pages } = usePages();
  const summary = pages.find((p) => p.id === pageId) ?? null;
  const pinnedCount = pages.filter((p) => p.pinned).length;
  // The frame reloads when page.html was rewritten (the stamp moves) and not
  // when the page saved its own data (it does not) — review F7.
  const htmlStamp = summary?.htmlStamp ?? 0;
  // Hidden by default, everywhere (Destin, 2026-09-17: "lets just always default to hidden").
  const [railOpen, setRailOpen] = useState(false);
  const headerRef = useRef<HTMLDivElement>(null);

  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const frameRef = useRef<HTMLIFrameElement>(null);

  // Fetch the working version when the open page changes or its document was
  // rewritten. The document is prepared ONCE here, with the theme and the
  // saved data of that moment; later theme changes go through postMessage
  // below rather than a new srcDoc (which would reload the page and lose its
  // state).
  useEffect(() => {
    if (pageId === null) return;
    let cancelled = false;
    setLoad({ state: 'loading' });
    void refreshPages();
    const bridge = (window as unknown as { claude?: { pages?: PagesBridge } }).claude?.pages;
    if (!bridge) {
      setLoad({ state: 'failed', failure: { kind: 'unreadable', message: 'Pages are not available in this window.' } });
      return;
    }
    bridge.get(pageId).then((r) => {
      if (cancelled) return;
      if (r.ok) setLoad({ state: 'ready', page: r.page, doc: prepareHostedDocument(r.page.html, readThemeCss(), PAGE_KIT_CSS, r.page.data) });
      else setLoad({ state: 'failed', failure: r.failure });
    }, () => {
      if (!cancelled) setLoad({ state: 'failed', failure: { kind: 'unreadable', message: 'The page could not be read.' } });
    });
    return () => { cancelled = true; };
  }, [pageId, htmlStamp]);

  // Saves from the page. Only THIS frame may write this page's data: every
  // sandboxed frame in the app has origin 'null' (HtmlView's artifact previews
  // use the same sandbox), so a type-only filter would let a previewed file
  // write page data — the check is e.source (review F4). Debounced so a page
  // that saves on every keystroke writes once per pause; last write wins.
  useEffect(() => {
    if (load.state !== 'ready' || pageId === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: unknown = undefined;
    const flush = () => {
      timer = null;
      if (pending === undefined) return;
      const data = pending; pending = undefined;
      const bridge = (window as unknown as { claude?: { pages?: PagesBridge } }).claude?.pages;
      void bridge?.setData(pageId, data);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow) return;
      const d = e.data as { type?: unknown; data?: unknown } | null;
      if (!d || d.type !== PAGE_DATA_SET_MESSAGE) return;
      let size = 0;
      try { size = JSON.stringify(d.data ?? null).length; } catch { return; }
      if (size > MAX_PAGE_DATA_BYTES) return; // main refuses it too; no point posting
      pending = d.data ?? null;
      if (timer === null) timer = setTimeout(flush, 500);
    };
    window.addEventListener('message', onMessage);
    return () => { window.removeEventListener('message', onMessage); if (timer !== null) { clearTimeout(timer); flush(); } };
  }, [load.state, pageId]);

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
      {/* The band: same height, drag region and window buttons as the app's
          header; three columns so the page's name is truly centred. No border
          underneath — the page pane's own edge is the divider (round 4). */}
      <div
        ref={headerRef}
        className="header-bar !relative grid grid-cols-[1fr_auto_1fr] items-center h-10 px-2 sm:px-3 shrink-0 select-none"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <MacTrafficLights headerRef={headerRef} />
        <div className="flex items-center gap-1 sm:gap-2">
          <Tooltip text={railOpen ? 'Hide the pages panel' : 'Show the pages panel'} placement="bottom">
            <button
              type="button"
              className={BAND_ICON_BUTTON}
              onClick={() => setRailOpen((o) => !o)}
              aria-label={railOpen ? 'Hide pages panel' : 'Show pages panel'}
              aria-pressed={railOpen}
            >
              <RailToggleIcon open={railOpen} />
            </button>
          </Tooltip>
        </div>
        <div className="flex items-center justify-center gap-2 min-w-0 px-3">
          {summary && <PageGlyph icon={summary.icon} className="w-4 h-4 text-fg-muted shrink-0" />}
          <span className="text-sm font-medium text-fg truncate">{title}</span>
        </div>
        <div className="flex items-center justify-end gap-1 sm:gap-2">
          {/* Same inset pill and quiet text as the window buttons beside it
              (round 5: "should match styling of max/min/exit"). */}
          <div className="flex bg-inset rounded-md p-0.5">
            <button
              type="button"
              onClick={backToChat}
              aria-label="Back to chat"
              className="px-2 py-1 rounded-[var(--radius-toggle)] transition-colors text-fg-dim hover:text-fg-2 flex items-center gap-1.5 text-xs leading-none"
            >
              {/* One size and one baseline for all three parts (round 6: the
                  key cap sat a hair low), with a dot between the words and the key. */}
              <span>Back to chat</span>
              <span aria-hidden="true" className="hidden sm:inline text-fg-faint">·</span>
              <span className="hidden sm:inline text-fg-muted">Esc</span>
            </button>
          </div>
          {showCaptionButtons() && <CaptionButtons />}
        </div>
      </div>

      {/* Below the band: the panel in its own rounded container and the page
          pane, both inset by the frame edge, like the chat pane and the
          files/games pane are in a chat session. */}
      <div className="flex-1 min-h-0 flex" style={{ gap: 'var(--frame-edge, 10px)', padding: '0 var(--frame-edge, 10px) var(--frame-edge, 10px)' }}>
        {railOpen && (
          <aside className="w-60 shrink-0 flex flex-col select-none rounded-xl bg-canvas overflow-hidden">
            <div className="flex-1 overflow-y-auto p-2">
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
              {pages.length === 0 && <div className="px-3 py-3 text-xs text-fg-muted">No pages yet</div>}
            </div>
            <div className="p-3">
              {/* The library sits BELOW the page view (z-40 under z-50), so opening
                  it alone changed nothing on screen (found 2026-09-17). Manage
                  pages leaves the page and shows the library; a card reopens one. */}
              <Button variant="secondary" onClick={() => { dispatch({ type: 'PAGE_CLOSED' }); dispatch({ type: 'PAGES_VIEW_OPENED' }); }} className="w-full justify-center rounded-full">
                <PagesIcon className="w-3.5 h-3.5" />
                Manage pages
              </Button>
            </div>
          </aside>
        )}
        <div className="relative flex-1 min-w-0 rounded-xl overflow-hidden bg-canvas">
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
  );
}

function RailGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="pb-2">
      <div className="text-2xs font-medium text-fg-muted tracking-wider uppercase px-2 pt-2 pb-1">{label}</div>
      {children}
    </div>
  );
}

/** One page in the panel: glyph, name, and its pin at the right. The row opens
 *  the page; the pin is its own control and stops the row's click. Rows are
 *  rounded pills inside the panel, so the current one reads as selected
 *  without a hard-edged band. */
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
      className={`group flex items-center gap-2.5 h-8 pl-2 pr-1 rounded-md text-sm text-left cursor-pointer transition-colors ${current ? 'bg-inset text-fg' : 'text-fg-2 hover:text-fg hover:bg-inset/60'}`}
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
          className={`w-6 h-6 ${page.pinned ? 'text-fg' : 'text-fg-faint group-hover:text-fg-muted'}`}
        >
          <PinGlyph filled={page.pinned} />
        </Button>
      </Tooltip>
    </div>
  );
}

/** A panel-with-left-sidebar glyph; the sidebar fills when the panel is open. */
function RailToggleIcon({ open }: { open: boolean }) {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" strokeWidth={2} />
      <path d="M9 5v14" strokeWidth={2} />
      {open && <rect x="3" y="5" width="6" height="14" rx="1" fill="currentColor" stroke="none" />}
    </svg>
  );
}

function EditIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M16.5 3.5a2.1 2.1 0 013 3L8 18l-4 1 1-4L16.5 3.5zM14 6l4 4" />
    </svg>
  );
}
