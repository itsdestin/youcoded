// PageHost — a page open inside the app (Phase 1 shell).
//
// Full screen in the Projects/Pages family: one header (glyph + name, then the
// pin, "Edit in chat", and the back affordance) over the page itself. The page
// runs in an iframe with the SAME sandbox HtmlView.tsx uses for HTML previews
// — `allow-scripts allow-popups allow-forms`, never `allow-same-origin` — so
// it is an opaque origin that cannot script the app (scope §4). Phase 1 adds
// no bridge into the frame; the only message that crosses is the theme.
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
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useArtifact } from '../../state/ArtifactContext';
import { useEscClose } from '../../hooks/use-esc-close';
import { Button, CloseButton, LoadingState, ErrorState, Tooltip } from '../ui';
import type { PageDocument, PageLoadFailure, PagesBridge } from '../../../shared/pages-types';
import { MAX_PINNED_PAGES } from '../../../shared/pages-types';
import { PageGlyph } from './page-icons';
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
  const close = () => dispatch({ type: 'PAGE_CLOSED' });
  useEscClose(pageId !== null, close);
  const { pages } = usePages();
  const summary = pages.find((p) => p.id === pageId) ?? null;
  const pinnedCount = pages.filter((p) => p.pinned).length;

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

  return (
    <div className="fixed inset-0 bg-canvas z-50 flex flex-col">
      <header className="flex items-center gap-3 px-4 py-2.5 border-b border-edge shrink-0">
        <h2 className="text-base font-semibold text-fg min-w-0 flex items-center gap-2">
          {summary && <PageGlyph icon={summary.icon} className="w-4 h-4 text-fg-muted shrink-0" />}
          <span className="truncate">{title}</span>
        </h2>
        {summary && (
          <span className="text-2xs text-fg-muted shrink-0 hidden sm:inline">
            {summary.home.kind === 'personal' ? 'Personal' : summary.home.name}
          </span>
        )}
        <div className="flex-1" />
        {summary && (
          <Tooltip text={cannotPin ? `Up to ${MAX_PINNED_PAGES} pinned pages` : pinned ? 'Unpin from the top bar' : 'Pin to the top bar'} placement="bottom">
            <Button
              variant="secondary"
              size="sm"
              aria-pressed={pinned}
              disabled={cannotPin}
              onClick={() => { void setPagePinned(summary.id, !pinned); }}
              className="shrink-0"
            >
              {pinned ? 'Pinned' : 'Pin'}
            </Button>
          </Tooltip>
        )}
        <Button variant="secondary" size="sm" onClick={() => onEditInChat(pageId)} className="shrink-0">
          Edit in chat
        </Button>
        <Button
          variant="ghost"
          onClick={close}
          className="hidden sm:inline-flex shrink-0 text-sm px-2.5 py-1"
          aria-label="Exit page"
        >
          Esc · Back
        </Button>
        <CloseButton
          onClick={close}
          label="Exit page"
          className="sm:hidden shrink-0 panel-glass bg-inset rounded-md border border-edge-dim hover:border-edge"
        />
      </header>

      <div className="flex-1 min-h-0 relative">
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
  );
}
