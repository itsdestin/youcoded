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
// THE PAGE VIEW (shell decks rounds 3–8, then Destin's redirection on
// 2026-09-17): "when i click the pages icon, i want it to open straight into
// the view with the left sidebar and the frame page window. the framed window
// will just say No Page Selected until user picks a page. a new filled Create
// a page button above manage pages with a plus sign. pin the drawer to the
// open state and remove the panel/drawer icon from the top left. re-insert the
// settings, project view, and pages icon at the top left (but NOT chat/terminal
// toggle, file browser, or games panel). the old page icon page will now only
// be accessible via manage pages."
//
//   ┌ [⚙][▤][▢]              ◷ Page name                    [Back to chat Esc] [– □ ×] ┐
//   │╭─────────────────────╮ ╭──────────────────────────────────────────────────╮│
//   ││ every page, grouped, │ │  the page — or "No page selected"                ││
//   ││ pin beside each      │ │                                                  ││
//   ││ [ + Create a page  ] │ │                                                  ││
//   ││ [   Manage pages   ] │ ╰──────────────────────────────────────────────────╯│
//
// Opened by PAGE_VIEW_OPENED (the Pages button) or PAGE_OPENED (a card, a
// pinned button, a panel row). Renders nothing while closed. The library
// (Manage pages) opens OVER it and closes back onto it.
//
// FOCUS (Destin, 2026-09-17): a pinned button opens its page "full screen
// framed with no side bar" — PAGE_OPENED with focus. The band is the same
// (ScreenBand, shared with Project View), the pinned button lights instead of
// the Pages icon, and the panel is simply not rendered; the Pages icon brings
// it back with the page still open.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useArtifact } from '../../state/ArtifactContext';
import { useEscClose } from '../../hooks/use-esc-close';
import { Button, LoadingState, ErrorState, Tooltip } from '../ui';
import { ScreenBand } from '../ScreenBand';
import type { PageDocument, PageLoadFailure, PageSummary, PagesBridge } from '../../../shared/pages-types';
import { MAX_PAGE_DATA_BYTES, MAX_PINNED_PAGES } from '../../../shared/pages-types';
import { PageGlyph, PagesIcon, PinGlyph } from './page-icons';
import { usePages, setPagePinned, refreshPages } from './use-pages';
import { PAGE_KIT_CSS } from './page-kit';
import { PAGE_DATA_SET_MESSAGE, PAGE_ESC_MESSAGE, PAGE_THEME_MESSAGE, prepareHostedDocument, readThemeCss, watchThemeCss } from './page-theme';


interface PageHostProps {
  /** The same three icons the app's band shows, wired to the same places. */
  settingsOpen: boolean;
  onToggleSettings: () => void;
  settingsBadge?: boolean;
  settingsDangerBadge?: boolean;
  /** Starts the creator in a new conversation. Owned by App. */
  onCreatePage: () => void;
}

type Load =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; page: PageDocument; doc: string }
  | { state: 'failed'; failure: PageLoadFailure };

export function PageHost({ settingsOpen, onToggleSettings, settingsBadge, settingsDangerBadge, onCreatePage }: PageHostProps) {
  const { state, dispatch } = useArtifact();
  const open = state.pageViewOpen;
  const pageId = state.openPageId;
  // Back to chat leaves pages altogether (the library over this view goes too).
  const backToChat = () => dispatch({ type: 'PAGE_VIEW_CLOSED' });
  useEscClose(open && !state.pagesViewOpen && !settingsOpen, backToChat);
  const { pages } = usePages();
  const summary = pages.find((p) => p.id === pageId) ?? null;
  const pinnedCount = pages.filter((p) => p.pinned).length;
  // The frame reloads when page.html was rewritten (the stamp moves) and not
  // when the page saved its own data (it does not) — review F7.
  const htmlStamp = summary?.htmlStamp ?? 0;

  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const frameRef = useRef<HTMLIFrameElement>(null);

  // Fetch the working version when the open page changes or its document was
  // rewritten. The document is prepared ONCE here, with the theme and the
  // saved data of that moment; later theme changes go through postMessage
  // below rather than a new srcDoc (which would reload the page and lose its
  // state).
  useEffect(() => {
    if (!open) return;
    void refreshPages();
    if (pageId === null) { setLoad({ state: 'idle' }); return; }
    let cancelled = false;
    setLoad({ state: 'loading' });
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
  }, [open, pageId, htmlStamp]);

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
      if (!d) return;
      // Esc inside the page = Esc on the view: leave, unless Settings or the
      // library is open over it (their own Esc handling owns the key then).
      if (d.type === PAGE_ESC_MESSAGE) { if (!settingsOpen && !state.pagesViewOpen) backToChat(); return; }
      if (d.type !== PAGE_DATA_SET_MESSAGE) return;
      let size = 0;
      try { size = JSON.stringify(d.data ?? null).length; } catch { return; }
      if (size > MAX_PAGE_DATA_BYTES) return; // main refuses it too; no point posting
      pending = d.data ?? null;
      if (timer === null) timer = setTimeout(flush, 500);
    };
    window.addEventListener('message', onMessage);
    return () => { window.removeEventListener('message', onMessage); if (timer !== null) { clearTimeout(timer); flush(); } };
  }, [load.state, pageId, settingsOpen, state.pagesViewOpen]);

  // Live theme: watch the host document and post the fresh tokens in.
  useEffect(() => {
    if (load.state !== 'ready') return;
    return watchThemeCss((css) => {
      frameRef.current?.contentWindow?.postMessage({ type: PAGE_THEME_MESSAGE, css }, '*');
    });
  }, [load.state]);

  const title = useMemo(() => summary?.name ?? (load.state === 'ready' ? load.page.name : ''), [summary, load]);
  if (!open) return null;

  const personal = pages.filter((p) => p.home.kind === 'personal');
  const byProject = new Map<string, PageSummary[]>();
  for (const p of pages) {
    if (p.home.kind !== 'project') continue;
    const list = byProject.get(p.home.name) ?? [];
    list.push(p);
    byProject.set(p.home.name, list);
  }

  return (
    // z-40, the same layer as Project View (they replace each other, never
    // coexist) and BELOW the Settings drawer's click-outside backdrop, so the
    // gear opens the drawer and a click beside it closes it (found 2026-09-17:
    // at z-45 the backdrop sat under the view and Settings could not be
    // closed). The library (z-[60]) opens over this from Manage pages.
    <div className="fixed inset-0 bg-panel z-40 flex flex-col">
      <ScreenBand
        settingsOpen={settingsOpen}
        onToggleSettings={onToggleSettings}
        settingsBadge={settingsBadge}
        settingsDangerBadge={settingsDangerBadge}
        active={state.pageFocus ? null : 'pages'}
        onBack={backToChat}
        title={<>
          {summary && <PageGlyph icon={summary.icon} className="w-4 h-4 text-fg-muted shrink-0" />}
          <span className="truncate">{title || 'Pages'}</span>
        </>}
      />

      {/* Below the band: the panel in its own rounded container and the page
          pane, both inset by the frame edge, like the chat pane and the
          files/games pane are in a chat session. */}
      <div className="flex-1 min-h-0 flex" style={{ gap: 'var(--frame-edge, 10px)', padding: '0 var(--frame-edge, 10px) var(--frame-edge, 10px)' }}>
        {!state.pageFocus && (
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
            {pages.length === 0 && <div className="px-2 py-3 text-xs text-fg-muted">No pages yet. Create one below.</div>}
          </div>
          <div className="p-3 flex flex-col gap-2">
            {/* The ONE primary in this view (G-4). */}
            <Button variant="primary" onClick={onCreatePage} className="w-full justify-center rounded-full">
              <PlusGlyph />
              Create a page
            </Button>
            <Button variant="secondary" onClick={() => dispatch({ type: 'PAGES_VIEW_OPENED' })} className="w-full justify-center rounded-full">
              <PagesIcon className="w-3.5 h-3.5" />
              Manage pages
            </Button>
          </div>
        </aside>
        )}
        <div className="relative flex-1 min-w-0 rounded-xl overflow-hidden bg-canvas">
          {load.state === 'idle' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 select-none">
              <div className="text-sm font-medium text-fg-2">No page selected</div>
              <div className="text-xs text-fg-muted">Pick one from the list, or create a page.</div>
            </div>
          )}
          {load.state === 'loading' && <LoadingState what={title} verb="Opening" />}
          {load.state === 'failed' && (
            <div className="p-6 max-w-[34rem] mx-auto">
              <ErrorState message={load.failure.message} onRetry={() => { if (pageId !== null) dispatch({ type: 'PAGE_OPENED', pageId }); }} />
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


function PlusGlyph() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <path strokeLinecap="round" strokeWidth={2.5} d="M12 5v14M5 12h14" />
    </svg>
  );
}
