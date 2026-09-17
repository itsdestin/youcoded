// Header buttons for Pages (Phase 1 shell).
//
// PagesButton — the permanent destination between Settings and Projects
// (scope §1: cannot be removed). Same 16px stroke-icon button as the Projects
// folder beside it; opens the page VIEW (band + panel + frame), with
// "No page selected" until one is picked (Destin, 2026-09-17). The library
// is reached from that view's Manage pages. `active` marks it in the page
// view's own band, where the same three icons live.
//
// PinnedPageButtons — one button per pinned page, after Projects, capped at
// MAX_PINNED_PAGES; the rest stay in the library. A pinned page opens
// directly (PAGE_OPENED), skipping the library — that is the whole point of
// pinning.
//
// Both call useArtifact(), so like ProjectsButton they must render inside
// ArtifactProvider (HeaderBar's only render site, App.tsx, does).
import React from 'react';
import { useArtifact } from '../../state/ArtifactContext';
import { Tooltip } from '../ui';
import { MAX_PINNED_PAGES } from '../../../shared/pages-types';
import { PageGlyph, PagesIcon } from './page-icons';
import { usePages } from './use-pages';

const HEADER_ICON_BUTTON =
  'relative p-1 rounded-sm hover:bg-inset transition-colors shrink-0 text-fg-muted hover:text-fg';

export function PagesButton({ active = false }: { active?: boolean } = {}) {
  const { state, dispatch } = useArtifact();
  // A second press leaves the page view (Destin, 2026-09-17: "clicking the
  // page button again should exit/go back to chat").
  const toggle = () => dispatch({ type: state.pageViewOpen ? 'PAGE_VIEW_CLOSED' : 'PAGE_VIEW_OPENED' });
  return (
    <Tooltip text={active ? 'Back to chat' : 'Pages'} placement="bottom">
      <button
        type="button"
        className={`${HEADER_ICON_BUTTON} ${active ? 'text-fg bg-inset' : ''}`}
        onClick={toggle}
        aria-label="Open Pages"
        aria-pressed={active}
        data-guide-anchor="pages"
      >
        <PagesIcon />
      </button>
    </Tooltip>
  );
}

export function PinnedPageButtons() {
  const { dispatch } = useArtifact();
  const { pages } = usePages();
  const pinned = pages.filter((p) => p.pinned).slice(0, MAX_PINNED_PAGES);
  if (pinned.length === 0) return null;
  return (
    <>
      {pinned.map((p) => (
        <Tooltip key={p.id} text={p.name} placement="bottom">
          <button
            type="button"
            className={HEADER_ICON_BUTTON}
            onClick={() => dispatch({ type: 'PAGE_OPENED', pageId: p.id })}
            aria-label={`Open ${p.name}`}
          >
            <PageGlyph icon={p.icon} />
          </button>
        </Tooltip>
      ))}
    </>
  );
}
