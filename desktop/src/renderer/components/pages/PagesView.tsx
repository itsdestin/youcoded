// PagesView — the Pages library, a full screen in the same family as Projects
// (design guide §4.4: one header, title left, back affordance right; content
// on canvas). Opened by the Pages button (PAGES_VIEW_OPENED); renders nothing
// while closed, like ProjectView.
//
// Cards, not rows: a page is a thing with a look of its own (guide §4.6 —
// "cards are for things with a preview"). Phase 1 cards carry the glyph, name,
// description, where the page lives, and the pin. The ONE primary on this
// screen is "Make a page" (G-4); everything else is secondary/ghost.
//
// Personal pages and project pages are grouped under eyebrows (G-7) rather
// than filtered, so a person sees both at once and the project name on each
// card says which folder owns it (scope §1: explicit source bindings).
import React from 'react';
import { useArtifact } from '../../state/ArtifactContext';
import { useEscClose } from '../../hooks/use-esc-close';
import { Button, CloseButton, LoadingState, ErrorState, Tooltip } from '../ui';
import type { PageSummary } from '../../../shared/pages-types';
import { MAX_PINNED_PAGES } from '../../../shared/pages-types';
import { PageGlyph, PagesIcon } from './page-icons';
import { usePages, setPagePinned } from './use-pages';

interface PagesViewProps {
  /** Starts the creator: a new conversation that builds a page. Owned by
   *  App, which knows how to open a session with an opening prompt. */
  onMakePage: () => void;
}

export function PagesView({ onMakePage }: PagesViewProps) {
  const { state, dispatch } = useArtifact();
  const open = state.pagesViewOpen;
  useEscClose(open, () => dispatch({ type: 'PAGES_VIEW_CLOSED' }));
  const { pages, loaded, failed } = usePages();
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

  return (
    <div className="fixed inset-0 bg-canvas z-40 flex flex-col">
      <header className="flex items-center gap-3 px-4 py-2.5 border-b border-edge shrink-0">
        <h2 className="text-base font-semibold text-fg shrink-0 flex items-center gap-2">
          <PagesIcon className="w-4 h-4 text-fg-muted" />
          Pages
        </h2>
        <div className="flex-1" />
        {pages.length > 0 && (
          <Button variant="primary" size="sm" onClick={onMakePage} className="shrink-0">
            Make a page
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={close}
          className="hidden sm:inline-flex shrink-0 text-sm px-2.5 py-1"
          aria-label="Exit pages"
        >
          Esc · Back to chat
        </Button>
        <CloseButton
          onClick={close}
          label="Exit pages"
          className="sm:hidden shrink-0 panel-glass bg-inset rounded-md border border-edge-dim hover:border-edge"
        />
      </header>

      <main className="flex-1 overflow-y-auto min-h-0">
        <div className="w-full max-w-[1100px] mx-auto px-2 sm:px-4 py-4 flex flex-col gap-6">
          {!loaded && <LoadingState what="pages" />}
          {loaded && failed && (
            <ErrorState
              message="The list of pages could not be read."
              onRetry={() => window.location.reload()}
            />
          )}
          {loaded && !failed && pages.length === 0 && <PagesEmptyCard onMake={onMakePage} />}
          {loaded && !failed && personal.length > 0 && (
            <Section label="Personal">
              {personal.map((p) => (
                <PageCard key={p.id} page={p} onOpen={() => openPage(p.id)} pinFull={pinnedCount >= MAX_PINNED_PAGES} />
              ))}
            </Section>
          )}
          {loaded && !failed && [...byProject.entries()].map(([name, list]) => (
            <Section key={name} label={name}>
              {list.map((p) => (
                <PageCard key={p.id} page={p} onOpen={() => openPage(p.id)} pinFull={pinnedCount >= MAX_PINNED_PAGES} />
              ))}
            </Section>
          ))}
        </div>
      </main>
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

function PageCard({ page, onOpen, pinFull }: { page: PageSummary; onOpen: () => void; pinFull: boolean }) {
  // The card is one button (open); the pin is a second control INSIDE it, so
  // it stops propagation. The pin is always visible — unlike a theme card's
  // favourite star it sits on text, not on a picture (guide §4.4).
  const cannotPin = !page.pinned && pinFull;
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
        <Tooltip text={cannotPin ? `Up to ${MAX_PINNED_PAGES} pinned pages` : page.pinned ? 'Unpin from the top bar' : 'Pin to the top bar'} placement="bottom">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={page.pinned ? `Unpin ${page.name}` : `Pin ${page.name}`}
            aria-pressed={page.pinned}
            disabled={cannotPin}
            onClick={(e) => { e.stopPropagation(); void setPagePinned(page.id, !page.pinned); }}
            className={page.pinned ? 'text-fg' : 'text-fg-muted'}
          >
            <PinGlyph filled={page.pinned} />
          </Button>
        </Tooltip>
      </div>
      <div className="flex items-center gap-2 text-2xs text-fg-muted">
        <span>{page.home.kind === 'personal' ? 'Personal' : page.home.name}</span>
        <span aria-hidden="true" className="text-fg-faint">·</span>
        <span>Updated {relative(page.updatedAt)}</span>
      </div>
    </div>
  );
}

function PinGlyph({ filled }: { filled: boolean }) {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M15 4l5 5-4 1-3 3v6l-2-2-4 4-1-1 4-4-2-2h6l3-3 1-4z" />
    </svg>
  );
}

/** First-run: no pages at all. Same card species as ProjectsEmptyCard — plain
 *  words about what a page is, and exactly one thing to do. */
function PagesEmptyCard({ onMake }: { onMake: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center max-sm:items-start px-2 py-8 min-h-0">
      <div className="w-full max-w-[34rem] bg-panel border border-edge rounded-lg p-5 sm:p-6 flex flex-col items-center text-center gap-4 sm:flex-row sm:items-start sm:text-left">
        <span aria-hidden="true" className="shrink-0 inline-flex w-16 h-16 rounded-lg bg-inset border border-edge-dim items-center justify-center text-fg-dim">
          <PagesIcon className="w-8 h-8" />
        </span>
        <div className="min-w-0 flex flex-col gap-3 items-center sm:items-start">
          <div>
            <div className="text-2xs font-medium text-fg-muted tracking-wider uppercase mb-1">Pages</div>
            <h3 className="text-base font-semibold text-fg leading-snug">Pages are little apps you describe</h3>
          </div>
          <p className="text-sm text-fg-2 leading-relaxed">
            Tell the assistant what you want — a timer, a notes board, a dashboard — and it
            builds a page that looks like the rest of YouCoded and follows your theme.
          </p>
          <p className="text-sm text-fg-2 leading-relaxed">
            Pin the ones you use most and they get their own button up top.
          </p>
          <Button variant="primary" onClick={onMake} className="w-full">
            Make a page
          </Button>
        </div>
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
