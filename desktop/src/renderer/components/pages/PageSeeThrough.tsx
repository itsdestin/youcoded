// PageSeeThrough — the per-page "Theme background" switch, in the band beside
// the page's name (owner, 2026-10-05: every page shows the theme's wallpaper
// through it "like the Office editor does", and "should be optional").
//
// Shown ONLY while the app's page pane is glass (a wallpaper theme in a
// floating style): anywhere else the switch would do nothing, and a control
// that does nothing teaches people to ignore the band. On the plain themes the
// page is simply what it always was.
import React from 'react';
import type { PageSummary } from '../../../shared/pages-types';
import { Toggle, Tooltip } from '../ui';
import { setPageSeeThrough } from './use-pages';

export function PageSeeThrough({ page, glass }: { page: PageSummary; glass: boolean }) {
  if (!glass) return null;
  const on = page.seeThrough !== false;
  return (
    <span
      className="flex items-center gap-1.5 shrink-0 text-xs font-normal text-fg-muted"
      data-page-see-through={on ? 'on' : 'off'}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <span aria-hidden="true" className="text-fg-faint">·</span>
      <Tooltip text="Let the theme's background show through this page" placement="bottom">
        <span className="max-sm:hidden">Theme background</span>
      </Tooltip>
      <Toggle
        checked={on}
        onChange={(next) => { void setPageSeeThrough(page.id, next); }}
        aria-label="Show theme background"
      />
    </span>
  );
}
