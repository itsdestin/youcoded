// PagesView — the Pages library ("Manage pages"), a full screen in the same
// family as Projects (design guide §4.4: one header, title left, back
// affordance right; content on canvas). Since 2026-09-17 it is reached only
// from the page view's Manage pages button and sits OVER that view; Back
// returns to it. Renders nothing while closed, like ProjectView.
//
// Cards, not rows: a page is a thing with a look of its own (guide §4.6 —
// "cards are for things with a preview"). Phase 1 cards carry the glyph, name,
// description, where the page lives, and the pin. The ONE primary on this
// screen is "Make a page" (G-4); everything else is secondary/ghost.
//
// Personal pages and project pages are grouped under eyebrows (G-7) rather
// than filtered, so a person sees both at once and the project name on each
// card says which folder owns it (scope §1: explicit source bindings).
import React, { useEffect, useState } from 'react';
import { useArtifactSelector, useArtifactDispatch } from '../../state/ArtifactContext';
import { useEscClose } from '../../hooks/use-esc-close';
import { Button, CloseButton, LoadingState, ErrorState, Tooltip } from '../ui';
import type { PageSummary } from '../../../shared/pages-types';
import { MAX_PINNED_PAGES } from '../../../shared/pages-types';
import { EditGlyph, PageGlyph, PagesIcon, PinGlyph } from './page-icons';
import { usePages, setPagePinned, refreshPages } from './use-pages';
import { PageConnectionsDialog } from './page-connections';

interface PagesViewProps {
  /** Starts the creator: a new conversation that builds a page. Owned by
   *  App, which knows how to open a session with an opening prompt. */
  onMakePage: () => void;
  /** Opens the creator on an existing page. The ONLY place a page is edited
   *  from (round 5: "keep it only accessible in the manage pages view"). */
  onEditPage: (page: PageSummary) => void;
}

export function PagesView({ onMakePage, onEditPage }: PagesViewProps) {
  // Narrow selector (perf, 2026-09-23): redraws only when the library opens or closes.
  const dispatch = useArtifactDispatch();
  const open = useArtifactSelector((s) => s.pagesViewOpen);
  useEscClose(open, () => dispatch({ type: 'PAGES_VIEW_CLOSED' }));
  const { pages, loaded, failed } = usePages();
  // Fresh list on every open (see refreshPages).
  useEffect(() => { if (open) void refreshPages(); }, [open]);
  const [connectionsFor, setConnectionsFor] = useState<string | null>(null);
  if (!open) return null;

  const close = () => dispatch({ type: 'PAGES_VIEW_CLOSED' });
  const openPage = (id: string) => dispatch({ type: 'PAGE_OPENED', pageId: id });
  const personal = pages.filter((p) => p.home.kind === 'personal');
  const byProject = new Map<string, PageSummary[]>();
  for (const p of pages) {
    if (p.home.kind !== 'project') continue;
    const list = byProject.get(p.home.name) ?? [];
    list.push(p);
    byProject.set(p.home.name, list);
  }
  const pinnedCount = pages.filter((p) => p.pinned).length;
  // By id, so the dialog follows the live list when a connection is removed.
  const connectionsPage = pages.find((p) => p.id === connectionsFor) ?? null;

  return (
    // z-50: above the page view (z-40) it opens from.
    <div className="fixed inset-0 bg-canvas z-50 flex flex-col">
      <header className="flex items-center gap-3 px-4 py-2.5 border-b border-edge shrink-0">
        <h2 className="text-base font-semibold text-fg shrink-0 flex items-center gap-2">
          <PagesIcon className="w-4 h-4 text-fg-muted" />
          Manage pages
        </h2>
        <div className="flex-1" />
        <Button variant="primary" size="sm" onClick={onMakePage} className="shrink-0">
          Make a page
        </Button>
        <Button
          variant="ghost"
          onClick={close}
          size="sm"
          className="hidden sm:inline-flex shrink-0"
          aria-label="Exit pages"
        >
          Esc · Back
        </Button>
        <CloseButton
          onClick={close}
          label="Exit pages"
          className="sm:hidden shrink-0"
        />
      </header>

      <main className="flex-1 overflow-y-auto min-h-0">
        <div className="w-full max-w-6xl mx-auto px-2 sm:px-4 py-4 flex flex-col gap-6">
          {!loaded && <LoadingState what="pages" />}
          {loaded && failed && (
            <ErrorState
              message="The list of pages could not be read."
              onRetry={() => window.location.reload()}
            />
          )}
          {loaded && !failed && personal.length > 0 && (
            <Section label="Personal">
              {personal.map((p) => (
                <PageCard key={p.id} page={p} onOpen={() => openPage(p.id)} onEdit={() => onEditPage(p)} onConnections={() => setConnectionsFor(p.id)} pinFull={pinnedCount >= MAX_PINNED_PAGES} />
              ))}
            </Section>
          )}
          {loaded && !failed && [...byProject.entries()].map(([name, list]) => (
            <Section key={name} label={name}>
              {list.map((p) => (
                <PageCard key={p.id} page={p} onOpen={() => openPage(p.id)} onEdit={() => onEditPage(p)} onConnections={() => setConnectionsFor(p.id)} pinFull={pinnedCount >= MAX_PINNED_PAGES} />
              ))}
            </Section>
          ))}
        </div>
      </main>
      <PageConnectionsDialog page={connectionsPage} onClose={() => setConnectionsFor(null)} onConnect={(id) => { setConnectionsFor(null); openPage(id); }} />
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="text-2xs font-medium text-fg-muted tracking-wider uppercase px-1">{label}</div>
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </section>
  );
}

function PageCard({ page, onOpen, onEdit, onConnections, pinFull }: { page: PageSummary; onOpen: () => void; onEdit: () => void; onConnections: () => void; pinFull: boolean }) {
  // The card is one button (open); the pin is a second control INSIDE it, so
  // it stops propagation. The pin is always visible — unlike a theme card's
  // favourite star it sits on text, not on a picture (guide §4.4).
  const cannotPin = !page.pinned && pinFull;
  const connectionCount = page.connections?.length ?? 0;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      className="relative bg-panel border border-edge rounded-lg p-4 text-left flex flex-col gap-3 cursor-pointer card-interactive focus:outline-none focus-visible:ring-2 focus-visible:ring-accent select-none"
    >
      <div className="flex items-start gap-3">
        <span className="shrink-0 w-9 h-9 rounded-md bg-inset border border-edge-dim flex items-center justify-center text-fg-2">
          <PageGlyph icon={page.icon} className="w-5 h-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-fg truncate" title={page.name}>{page.name}</div>
          <div className="text-xs text-fg-muted line-clamp-2">{page.description}</div>
        </div>
        <Tooltip text="Edit in chat" placement="bottom">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Edit ${page.name} in chat`}
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
          >
            {/* Colour on the glyph, not the Button: the primitive owns its own text colour. */}
            <span className="text-fg-muted"><EditGlyph /></span>
          </Button>
        </Tooltip>
        <Tooltip text={cannotPin ? `Up to ${MAX_PINNED_PAGES} pinned pages` : page.pinned ? 'Unpin from the top bar' : 'Pin to the top bar'} placement="bottom">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={page.pinned ? `Unpin ${page.name}` : `Pin ${page.name}`}
            aria-pressed={page.pinned}
            disabled={cannotPin}
            onClick={(e) => { e.stopPropagation(); void setPagePinned(page.id, !page.pinned); }}
          >
            <span className={page.pinned ? 'text-fg' : 'text-fg-muted'}><PinGlyph filled={page.pinned} /></span>
          </Button>
        </Tooltip>
      </div>
      <div className="flex items-center gap-2 text-2xs text-fg-muted">
        <span>{page.home.kind === 'personal' ? 'Personal' : page.home.name}</span>
        <span aria-hidden="true" className="text-fg-faint">·</span>
        <span>Updated {relative(page.updatedAt)}</span>
        {/* A quiet line, only on pages that reach outside (deck Q-manage: the
            library stays calm; no badge on every card — deck Q-levels). */}
        {connectionCount > 0 && (
          <>
            <span aria-hidden="true" className="text-fg-faint">·</span>
            <Button
              variant="ghost"
              size="sm"
              data-page-connections-link
              onClick={(e) => { e.stopPropagation(); onConnections(); }}
            >
              {connectionCount === 1 ? '1 connection' : `${connectionCount} connections`}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}


function relative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(iso).toLocaleDateString();
}
