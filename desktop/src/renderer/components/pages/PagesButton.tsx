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
// directly (PAGE_OPENED with focus), skipping the library — that is the whole
// point of pinning. Destin, 2026-09-17: "when one of those is clicked, it
// should appear to be the selected option and show the page full screen
// framed with no side bar" — so the button lights while its page is the
// focused one, and a second press returns to chat, like the Pages button.
//
// Both call the artifact hooks, so like ProjectsButton they must render inside
// ArtifactProvider (HeaderBar's only render site, App.tsx, does).
import React from 'react';
import { useArtifactSelector, useArtifactDispatch } from '../../state/ArtifactContext';
import { Tooltip } from '../ui';
import { MAX_PINNED_PAGES } from '../../../shared/pages-types';
import { PageGlyph, PagesIcon } from './page-icons';
import { usePages } from './use-pages';
// Shared with Settings and Projects — it used to be a private copy here.
import { HEADER_ICON_BUTTON } from '../header/control-states';

export function PagesButton({ active = false }: { active?: boolean } = {}) {
  const dispatch = useArtifactDispatch();
  // A second press leaves the page view (Destin, 2026-09-17: "clicking the
  // page button again should exit/go back to chat"). From a FOCUSED page (a
  // pinned button's, no panel) it is not lit, and a press brings the panel
  // back instead — PAGE_VIEW_OPENED keeps the page and clears the focus.
  // Narrow selector (perf, 2026-09-23): redraws only when this flag flips.
  const inView = useArtifactSelector((s) => s.pageViewOpen && !s.pageFocus);
  const toggle = () => dispatch({ type: inView ? 'PAGE_VIEW_CLOSED' : 'PAGE_VIEW_OPENED' });
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
  const dispatch = useArtifactDispatch();
  // Selected BEFORE the early return below — hooks must run on every render.
  const focusedId = useArtifactSelector((s) => (s.pageViewOpen && s.pageFocus ? s.openPageId : null));
  const { pages } = usePages();
  const pinned = pages.filter((p) => p.pinned).slice(0, MAX_PINNED_PAGES);
  if (pinned.length === 0) return null;
  return (
    <>
      {pinned.map((p) => {
        const active = p.id === focusedId;
        return (
          <Tooltip key={p.id} text={active ? 'Back to chat' : p.name} placement="bottom">
            <button
              type="button"
              className={`${HEADER_ICON_BUTTON} ${active ? 'text-fg bg-inset' : ''}`}
              onClick={() => dispatch(active ? { type: 'PAGE_VIEW_CLOSED' } : { type: 'PAGE_OPENED', pageId: p.id, focus: true })}
              aria-label={`Open ${p.name}`}
              aria-pressed={active}
            >
              <PageGlyph icon={p.icon} />
            </button>
          </Tooltip>
        );
      })}
    </>
  );
}
