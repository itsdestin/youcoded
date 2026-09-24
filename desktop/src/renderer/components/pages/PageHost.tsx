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
// First-run refinement (2026-09-23): keep the quoted decision above for pages
// that exist; with none, the frame carries the former Manage pages welcome card.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useArtifactSelector, useArtifactDispatch } from '../../state/ArtifactContext';
import { useDismissTop, useEscClose } from '../../hooks/use-esc-close';
import { workbenchScreenFrame } from '../../workbench-mode';
import { Button, LoadingState, ErrorState, Tooltip } from '../ui';
import { ScreenBand } from '../ScreenBand';
import type { PageDocument, PageFetchRequest, PageFetchResult, PageLoadFailure, PageSummary, PagesBridge } from '../../../shared/pages-types';
import { MAX_PAGE_DATA_BYTES, MAX_PINNED_PAGES } from '../../../shared/pages-types';
import { PageGlyph, PagesIcon, PinGlyph } from './page-icons';
import { PagesEmptyCard } from './PagesEmptyCard';
import { usePages, setPagePinned, refreshPages } from './use-pages';
import { PAGE_KIT_CSS } from './page-kit';
import { PageApproval, needsApproval } from './page-connections';
import { PageFreshness } from './PageFreshness';
import { PageCodeChanged } from './PageCodeChanged';
import {
  PAGE_DATA_MESSAGE, PAGE_DATA_SET_MESSAGE, PAGE_ESC_MESSAGE, PAGE_FETCH_MESSAGE, PAGE_FETCH_RESULT_MESSAGE,
  PAGE_REFRESH_MESSAGE, PAGE_THEME_MESSAGE, prepareHostedDocument, readThemeCss, watchThemeCss,
} from './page-theme';

function pagesBridge(): PagesBridge | undefined {
  return (window as unknown as { claude?: { pages?: PagesBridge } }).claude?.pages;
}

/** A page's own script wrote these, so nothing is assumed about them: only a
 *  flat object of strings is forwarded as request headers (main allows three
 *  of them through anyway — design §4 step 4). */
function isStringMap(v: unknown): v is Record<string, string> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');
}


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
  // Narrow selectors (perf, 2026-09-23): only the page flags this host shows.
  const dispatch = useArtifactDispatch();
  const open = useArtifactSelector((s) => s.pageViewOpen);
  const pageId = useArtifactSelector((s) => s.openPageId);
  const pagesViewOpen = useArtifactSelector((s) => s.pagesViewOpen);
  const pageFocus = useArtifactSelector((s) => s.pageFocus);
  // Back to chat leaves pages altogether (the library over this view goes too).
  const backToChat = () => dispatch({ type: 'PAGE_VIEW_CLOSED' });
  const managePages = () => dispatch({ type: 'PAGES_VIEW_OPENED' });
  useEscClose(open && !pagesViewOpen && !settingsOpen, backToChat);
  // Esc pressed INSIDE the page (the frame swallows the key) is forwarded by
  // the page's bootstrap; it dismisses whatever is on top exactly as the key
  // would — Settings or the library over the view, else the view itself.
  // (Before: ignored while Settings was open, so Settings could not be
  // closed by Esc with the page focused — Destin, 2026-09-17.)
  const dismissTop = useDismissTop();
  const { pages, loaded, failed } = usePages();
  const summary = pages.find((p) => p.id === pageId) ?? null;
  const pinnedCount = pages.filter((p) => p.pinned).length;
  // The frame reloads when page.html was rewritten (the stamp moves) and not
  // when the page saved its own data (it does not) — review F7.
  const htmlStamp = summary?.htmlStamp ?? 0;

  // What the LIST says about this page's approvals. It is not what the gate
  // reads (finding 17 — that is the loaded document, below), but a change to it
  // means the answer on disk moved, so the document is read again: approving a
  // line is what turns the approval screen back into the page.
  const connSig = useMemo(
    () => (summary?.connections ?? []).map((c) => `${c.id}:${c.approved ? 1 : 0}`).join('|'),
    [summary],
  );

  const [load, setLoad] = useState<Load>({ state: 'loading' });
  // Only the confirmed first-run state replaces the rail, not loading, errors, or an open page.
  const emptyPages = pageId === null && load.state === 'idle' && loaded && !failed && pages.length === 0;
  const frameRef = useRef<HTMLIFrameElement>(null);
  // The data the page in the frame is known to hold, so an outside change can
  // be told apart from the echo of the page's own save (see the onData effect).
  const frameDataRef = useRef<string>('null');

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
    const bridge = pagesBridge();
    if (!bridge) {
      setLoad({ state: 'failed', failure: { kind: 'unreadable', message: 'Pages are not available in this window.' } });
      return;
    }
    bridge.get(pageId).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        try { frameDataRef.current = JSON.stringify(r.page.data ?? null); } catch { frameDataRef.current = 'null'; }
        // The policy the document carries is built from THIS page's connections
        // (design §6), so a page that reaches nothing gets the tightest one.
        setLoad({ state: 'ready', page: r.page, doc: prepareHostedDocument(r.page.html, readThemeCss(), PAGE_KIT_CSS, r.page.data, r.page.connections ?? []) });
      } else setLoad({ state: 'failed', failure: r.failure });
    }, () => {
      if (!cancelled) setLoad({ state: 'failed', failure: { kind: 'unreadable', message: 'The page could not be read.' } });
    });
    return () => { cancelled = true; };
  }, [open, pageId, htmlStamp, connSig]);

  // Everything the page says to the host. Only THIS frame is heard: every
  // sandboxed frame in the app has origin 'null' (HtmlView's artifact previews
  // use the same sandbox), so a type-only filter would let a previewed file
  // write page data — the check is e.source (review F4), and an answer goes
  // back to that same window and nowhere else.
  //   · save  — debounced so a page that saves on every keystroke writes once
  //             per pause; last write wins.
  //   · fetch — forwarded to pages.fetch, which is where the approvals are
  //             checked. The renderer never holds the credential (design §4),
  //             and only the four known fields are passed on.
  useEffect(() => {
    if (load.state !== 'ready' || pageId === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: unknown = undefined;
    const flush = () => {
      timer = null;
      if (pending === undefined) return;
      const data = pending; pending = undefined;
      void pagesBridge()?.setData(pageId, data);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow) return;
      const d = e.data as { type?: unknown; data?: unknown; id?: unknown; url?: unknown; method?: unknown; headers?: unknown; body?: unknown } | null;
      if (!d) return;
      // Esc inside the page = Esc on the view: leave, unless Settings or the
      // library is open over it (their own Esc handling owns the key then).
      if (d.type === PAGE_ESC_MESSAGE) { dismissTop(); return; }
      if (d.type === PAGE_FETCH_MESSAGE) {
        if (typeof d.id !== 'string') return;
        const id = d.id;
        const source = e.source as Window;
        const answer = (result: PageFetchResult) => {
          try { source.postMessage({ type: PAGE_FETCH_RESULT_MESSAGE, id, result }, '*'); } catch { /* the frame went away */ }
        };
        const bridge = pagesBridge();
        if (!bridge?.fetch) {
          // Not a guess about the network: this window simply has no such
          // channel (an older host, or a platform that answers unsupported).
          answer({ ok: false, reason: 'unsupported', message: 'This window cannot make requests for pages.' });
          return;
        }
        const req: PageFetchRequest = {
          url: typeof d.url === 'string' ? d.url : '',
          ...(typeof d.method === 'string' ? { method: d.method } : {}),
          ...(isStringMap(d.headers) ? { headers: d.headers } : {}),
          ...(typeof d.body === 'string' ? { body: d.body } : {}),
        };
        bridge.fetch(pageId, req).then(answer, () => {
          answer({ ok: false, reason: 'network', message: 'The request could not be completed.' });
        });
        return;
      }
      if (d.type !== PAGE_DATA_SET_MESSAGE) return;
      let json = '';
      try { json = JSON.stringify(d.data ?? null); } catch { return; }
      if (json.length > MAX_PAGE_DATA_BYTES) return; // main refuses it too; no point posting
      frameDataRef.current = json;
      pending = d.data ?? null;
      if (timer === null) timer = setTimeout(flush, 500);
    };
    window.addEventListener('message', onMessage);
    return () => { window.removeEventListener('message', onMessage); if (timer !== null) { clearTimeout(timer); flush(); } };
  }, [load.state, pageId, dismissTop]);

  // A page's data can change under it — the same page open in another window,
  // or a sync arrival — and `youcoded.onData` is the page's way of hearing
  // about it. Any pages:changed broadcast means a file under Pages/ moved, so
  // the data is read again and posted in ONLY when it differs from what the
  // frame already holds; the echo of the page's own save therefore posts
  // nothing and cannot loop.
  useEffect(() => {
    if (load.state !== 'ready' || pageId === null) return;
    const bridge = pagesBridge();
    if (!bridge) return;
    let cancelled = false;
    bridge.get(pageId).then((r) => {
      if (cancelled || !r.ok) return;
      let json = '';
      try { json = JSON.stringify(r.page.data ?? null); } catch { return; }
      if (json === frameDataRef.current) return;
      frameDataRef.current = json;
      frameRef.current?.contentWindow?.postMessage({ type: PAGE_DATA_MESSAGE, data: r.page.data ?? null }, '*');
    }, () => { /* the next broadcast tries again */ });
    return () => { cancelled = true; };
  }, [pages, load.state, pageId]);

  // Live theme: watch the host document and post the fresh tokens in.
  useEffect(() => {
    if (load.state !== 'ready') return;
    return watchThemeCss((css) => {
      frameRef.current?.contentWindow?.postMessage({ type: PAGE_THEME_MESSAGE, css }, '*');
    });
  }, [load.state]);

  const title = useMemo(() => summary?.name ?? (load.state === 'ready' ? load.page.name : ''), [summary, load]);
  // The gate reads the LOADED document, never the list summary (design review
  // 1, finding 17): the list is a broadcast that can be a moment stale, and the
  // page that would run is this one. The list is the fallback only before the
  // document has been read, when nothing is running yet either way.
  // Named loadedPage, not loaded: `loaded` is the list store's "has the list
  // arrived" flag (first-run landing, merged from master 2026-09-23).
  const loadedPage = load.state === 'ready' ? load.page : null;
  const awaitingApproval = needsApproval(loadedPage ?? summary);
  /** The band's refresh button is how a person asks the page for fresh
   *  information; the page hears it through `youcoded.onRefresh` (§5). */
  const askPageToRefresh = () => {
    frameRef.current?.contentWindow?.postMessage({ type: PAGE_REFRESH_MESSAGE }, '*');
  };
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
    // .screen-view / .screen-pane: floating-chrome themes restyle them (see
    // globals.css → "Screens in floating chrome"); data-screen-frame is the
    // workbench's variant switch for that design round, 'cards' in the app.
    <div className="screen-view fixed inset-0 bg-panel z-40 flex flex-col" data-screen-frame={workbenchScreenFrame()}>
      <ScreenBand
        settingsOpen={settingsOpen}
        onToggleSettings={onToggleSettings}
        settingsBadge={settingsBadge}
        settingsDangerBadge={settingsDangerBadge}
        active={pageFocus ? null : 'pages'}
        onBack={backToChat}
        title={<>
          {summary && <PageGlyph icon={summary.icon} className="w-4 h-4 text-fg-muted shrink-0" />}
          <span className="truncate">{title || 'Pages'}</span>
          {/* Freshness belongs to the app, not the page (deck Q-last-updated):
              same place on every connected page, and true because the app made
              the request. Hidden until the page is approved. */}
          {summary && !awaitingApproval && <PageFreshness page={summary} onRefresh={askPageToRefresh} />}
          {summary && !awaitingApproval && <PageCodeChanged page={summary} />}
        </>}
      />

      {/* Below the band: the panel in its own rounded container and the page
          pane, both inset by the frame edge, like the chat pane and the
          files/games pane are in a chat session. */}
      <div className="screen-body flex-1 min-h-0 flex">
        {!pageFocus && !emptyPages && (
        <aside className="screen-pane screen-pane--panel w-60 shrink-0 flex flex-col select-none rounded-xl bg-canvas overflow-hidden">
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
          </div>
          <div className="p-3 flex flex-col gap-2">
            {/* The welcome card owns the primary action when the library is empty (G-4). */}
            {pages.length > 0 && <Button variant="primary" onClick={onCreatePage} className="w-full justify-center rounded-full">
              <PlusGlyph />
              Create a page
            </Button>}
            <Button variant="secondary" onClick={managePages} className="w-full justify-center rounded-full">
              <PagesIcon className="w-3.5 h-3.5" />
              Manage pages
            </Button>
          </div>
        </aside>
        )}
        <div className="screen-pane screen-pane--frame relative flex-1 min-w-0 rounded-xl overflow-hidden bg-canvas">
          {/* WHY: first-run belongs where the Pages button lands, not a second click into Manage pages. */}
          {load.state === 'idle' && !loaded && <LoadingState what="pages" />}
          {load.state === 'idle' && loaded && failed && <ErrorState message="The list of pages could not be read." onRetry={() => void refreshPages()} />}
          {emptyPages && (
            <div className="absolute inset-0 overflow-y-auto flex flex-col">
              <PagesEmptyCard onMake={onCreatePage} />
            </div>
          )}
          {load.state === 'idle' && loaded && !failed && pages.length > 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 select-none">
              <div className="text-sm font-medium text-fg-2">No page selected</div>
              <div className="text-xs text-fg-muted">Pick one from the list, or create a page.</div>
            </div>
          )}
          {load.state === 'loading' && <LoadingState what={title} verb="Opening" />}
          {load.state === 'failed' && (
            <div className="p-6 max-w-xl mx-auto">
              <ErrorState message={load.failure.message} onRetry={() => { if (pageId !== null) dispatch({ type: 'PAGE_OPENED', pageId }); }} />
            </div>
          )}
          {/* A page with a line waiting for a yes stays closed: the approval
              shows IN PLACE OF it, so nothing in the page runs first (decks
              Q-own-pages, S-change). "Not now" leaves the page unselected — or, from
              a pinned button (no panel to fall back to), goes back to chat. */}
          {load.state === 'ready' && awaitingApproval && (
            <PageApproval page={load.page} onNotNow={() => dispatch({ type: state.pageFocus ? 'PAGE_VIEW_CLOSED' : 'PAGE_CLOSED' })} />
          )}
          {load.state === 'ready' && !awaitingApproval && (
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
          className="w-6 h-6"
        >
          {/* The colour rides on the glyph, not the Button (the primitive owns
              its own text colour): quiet until the row is hovered, solid when pinned. */}
          <span className={page.pinned ? 'text-fg' : 'text-fg-faint group-hover:text-fg-muted'}><PinGlyph filled={page.pinned} /></span>
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
