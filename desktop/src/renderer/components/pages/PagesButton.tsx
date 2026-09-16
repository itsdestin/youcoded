// Header buttons for Pages (Phase 1 shell).
//
// PagesButton — the permanent destination between Settings and Projects
// (scope §1: cannot be removed). Same 16px stroke-icon button as the Projects
// folder beside it; dispatches PAGES_VIEW_OPENED.
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

export function PagesButton() {
  const { dispatch } = useArtifact();
  return (
    <Tooltip text="Pages" placement="bottom">
      <button
        type="button"
        className={HEADER_ICON_BUTTON}
        onClick={() => dispatch({ type: 'PAGES_VIEW_OPENED' })}
        aria-label="Open Pages"
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
