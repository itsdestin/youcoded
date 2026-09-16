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
// Opened by PAGE_OPENED (from a card or a pinned button); renders nothing
// while no page is open. Sits above the library (z-50 over its z-40) so a page
// opened from the library returns to the library on back, and a pinned page
// opened from the header returns to chat.
//
// LAYOUT CHOICE (shell deck round 2, 2026-09-16). Destin: "i don't think i
// want a header in that style. i think i want to hide the pinned/edit tags
// things. i think i may want pages to be arranged with a side panel instead of
// a top header? please give me a few different options/styles". Four layouts
// are drawn here for the round-3 Choice deck, picked by `?pageLayout=` in the
// workbench URL:
//   bar       — a slim bar: back, icon, name; page actions behind ⋯
//   frameless — no bar at all; a floating back pill and a floating ⋯
//   rail      — a side panel: back, the page, your pinned pages, all pages;
//               page actions at the bottom of the panel
//   frame     — the page sits inside the app's own frame, under the top bar
//               (which keeps the Pages and pinned buttons), like the chat does
// The knob is workbench-only: the built app reads no query string here, so it
// always gets the default. Once a layout is chosen the other three go.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useArtifact } from '../../state/ArtifactContext';
import { useEscClose } from '../../hooks/use-esc-close';
import { useAnchoredMenu } from '../../hooks/useAnchoredMenu';
import { Button, CloseButton, LoadingState, ErrorState, Tooltip } from '../ui';
import type { PageDocument, PageLoadFailure, PageSummary, PagesBridge } from '../../../shared/pages-types';
import { MAX_PINNED_PAGES } from '../../../shared/pages-types';
import { PageGlyph, PagesIcon } from './page-icons';
import { usePages, setPagePinned } from './use-pages';
import { PAGE_KIT_CSS } from './page-kit';
import { PAGE_THEME_MESSAGE, prepareHostedDocument, readThemeCss, watchThemeCss } from './page-theme';

type Layout = 'bar' | 'frameless' | 'rail' | 'frame';
const DEFAULT_LAYOUT: Layout = 'bar';
function pickLayout(): Layout {
  if (typeof location === 'undefined') return DEFAULT_LAYOUT;
  const v = new URLSearchParams(location.search).get('pageLayout');
  return v === 'frameless' || v === 'rail' || v === 'frame' || v === 'bar' ? v : DEFAULT_LAYOUT;
}

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
  const close = () => dispatch({ type: 'PAGE_CLOSED' });
  useEscClose(pageId !== null, close);
  const { pages } = usePages();
  const summary = pages.find((p) => p.id === pageId) ?? null;
  const pinnedCount = pages.filter((p) => p.pinned).length;
  const layout = useMemo(pickLayout, []);

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

  const pinned = summary?.pinned ?? false;
  const cannotPin = !pinned && pinnedCount >= MAX_PINNED_PAGES;
  const togglePin = () => { if (summary) void setPagePinned(summary.id, !pinned); };
  const edit = () => onEditInChat(pageId);
  const openLibrary = () => dispatch({ type: 'PAGES_VIEW_OPENED' });
  const homeLabel = summary ? (summary.home.kind === 'personal' ? 'Personal' : summary.home.name) : '';

  const body = (
    <>
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
    </>
  );

  const menu = (
    <PageMenu
      pinned={pinned}
      cannotPin={cannotPin}
      onTogglePin={togglePin}
      onEdit={edit}
      onLibrary={openLibrary}
    />
  );

  if (layout === 'frameless') {
    // No bar: two floating pills over the page's own top corners.
    return (
      <div className="fixed inset-0 bg-canvas z-50">
        <div className="absolute inset-0">{body}</div>
        <div className="absolute top-2 left-2 flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={close} className="panel-glass bg-panel/80 border border-edge rounded-full px-2.5" aria-label="Back">
            ‹ Back
          </Button>
        </div>
        <div className="absolute top-2 right-2">{menu}</div>
      </div>
    );
  }

  if (layout === 'frame') {
    // Inside the app's frame: the top bar stays (Pages + pinned buttons keep
    // working), the page takes the pane the chat normally fills.
    return (
      <div
        className="fixed z-40 flex flex-col"
        style={{ top: 'var(--top-chrome-height, 2.5rem)', left: 'var(--frame-edge, 0px)', right: 'var(--frame-edge, 0px)', bottom: 'var(--frame-edge, 0px)' }}
      >
        <div className="relative flex-1 min-h-0 rounded-xl overflow-hidden border border-edge bg-canvas">
          {body}
          <div className="absolute top-2 left-2">
            <Button variant="ghost" size="sm" onClick={close} className="panel-glass bg-panel/80 border border-edge rounded-full px-2.5" aria-label="Back to chat">
              ‹ Chat
            </Button>
          </div>
          <div className="absolute top-2 right-2">{menu}</div>
        </div>
      </div>
    );
  }

  if (layout === 'rail') {
    const pinnedPages = pages.filter((p) => p.pinned);
    return (
      <div className="fixed inset-0 bg-canvas z-50 flex">
        <aside className="w-60 shrink-0 bg-panel border-r border-edge flex flex-col select-none">
          <div className="px-2 pt-2">
            <Button variant="ghost" size="sm" onClick={close} className="w-full justify-start text-fg-2" aria-label="Back to chat">
              ‹ Back to chat
            </Button>
          </div>
          <div className="px-4 pt-4 pb-3 flex items-start gap-3 border-b border-edge-dim">
            <span className="shrink-0 w-9 h-9 rounded-md bg-inset border border-edge-dim flex items-center justify-center text-fg-2">
              {summary && <PageGlyph icon={summary.icon} className="w-5 h-5" />}
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium text-fg truncate">{title}</div>
              <div className="text-2xs text-fg-muted">{homeLabel}</div>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto py-3">
            <div className="text-2xs font-medium text-fg-muted tracking-wider uppercase px-4 pb-1">Pinned</div>
            {pinnedPages.map((p) => (
              <RailRow key={p.id} page={p} current={p.id === pageId} onClick={() => dispatch({ type: 'PAGE_OPENED', pageId: p.id })} />
            ))}
            {pinnedPages.length === 0 && <div className="px-4 py-2 text-xs text-fg-muted">No pinned pages yet</div>}
            <button
              type="button"
              onClick={openLibrary}
              className="mt-2 w-full flex items-center gap-3 px-4 py-2 text-sm text-fg-2 hover:text-fg hover:bg-inset text-left"
            >
              <PagesIcon className="w-4 h-4 shrink-0" />
              <span className="flex-1">All pages</span>
              <span className="text-fg-faint">›</span>
            </button>
          </div>
          <div className="border-t border-edge-dim p-2 flex flex-col gap-1">
            <Button variant="ghost" size="sm" onClick={togglePin} disabled={cannotPin} className="w-full justify-start text-fg-2" aria-pressed={pinned}>
              {pinned ? 'Unpin from the top bar' : 'Pin to the top bar'}
            </Button>
            <Button variant="ghost" size="sm" onClick={edit} className="w-full justify-start text-fg-2">
              Edit in chat
            </Button>
          </div>
        </aside>
        <div className="relative flex-1 min-w-0">{body}</div>
      </div>
    );
  }

  // 'bar' — the slim bar: back, icon, name; actions behind ⋯.
  return (
    <div className="fixed inset-0 bg-canvas z-50 flex flex-col">
      <header className="flex items-center gap-2 px-3 py-1.5 border-b border-edge shrink-0 select-none">
        <Button variant="ghost" size="sm" onClick={close} className="hidden sm:inline-flex shrink-0 text-fg-2 px-2" aria-label="Back">
          ‹ Back
        </Button>
        <CloseButton onClick={close} label="Exit page" className="sm:hidden shrink-0" />
        {summary && <PageGlyph icon={summary.icon} className="w-4 h-4 text-fg-muted shrink-0" />}
        <h2 className="text-sm font-medium text-fg min-w-0 truncate">{title}</h2>
        {summary && <span className="text-2xs text-fg-muted shrink-0 hidden sm:inline">{homeLabel}</span>}
        <div className="flex-1" />
        {menu}
      </header>
      <div className="flex-1 min-h-0 relative">{body}</div>
    </div>
  );
}

function RailRow({ page, current, onClick }: { page: PageSummary; current: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={current ? 'page' : undefined}
      className={`w-full flex items-center gap-3 px-4 py-2 text-sm text-left hover:bg-inset ${current ? 'bg-inset text-fg' : 'text-fg-2 hover:text-fg'}`}
    >
      <PageGlyph icon={page.icon} className="w-4 h-4 shrink-0" />
      <span className="flex-1 min-w-0 truncate">{page.name}</span>
    </button>
  );
}

/** The ⋯ menu that holds a page's actions: pin, edit, all pages. Same menu
 *  anatomy as the header's ||| menu (guide G-21). */
function PageMenu({ pinned, cannotPin, onTogglePin, onEdit, onLibrary }: {
  pinned: boolean; cannotPin: boolean; onTogglePin: () => void; onEdit: () => void; onLibrary: () => void;
}) {
  const { open, toggle, anchorRef, menuRef, pos, choose } = useAnchoredMenu<HTMLButtonElement>(208, 'right');
  const rows = [
    { key: 'pin', label: cannotPin ? `Up to ${MAX_PINNED_PAGES} pinned pages` : pinned ? 'Unpin from the top bar' : 'Pin to the top bar', onClick: choose(onTogglePin), disabled: cannotPin },
    { key: 'edit', label: 'Edit in chat', onClick: choose(onEdit), disabled: false },
    { key: 'library', label: 'All pages', onClick: choose(onLibrary), disabled: false },
  ];
  return (
    <>
      <Tooltip text="Page options" placement="bottom">
        <Button
          ref={anchorRef}
          size="icon"
          variant="ghost"
          aria-label="Page options"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={toggle}
          className="panel-glass bg-panel/80 border border-edge rounded-full text-fg-2"
        >
          <span aria-hidden="true" className="text-base leading-none">⋯</span>
        </Button>
      </Tooltip>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="glass-overlay overlay-no-drag fixed w-52 bg-panel border border-edge rounded-lg shadow-lg z-[9000] overflow-hidden py-1"
          style={{ top: pos.top, left: pos.left }}
        >
          {rows.map((r) => (
            <button
              key={r.key}
              type="button"
              role="menuitem"
              onClick={r.onClick}
              disabled={r.disabled}
              className="coarse-roomy w-full flex items-center gap-3 px-3 py-2.5 text-sm text-left transition-colors text-fg-2 hover:text-fg hover:bg-inset disabled:opacity-50"
            >
              <span className="flex-1 min-w-0 truncate">{r.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
