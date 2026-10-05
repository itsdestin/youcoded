// The marketplace and the library: tabs, a search, every kind of detail page (fixture items
// named in MarketplaceScreen's SHOOT_DETAIL_IDS), plus the brand-new-install empty state.
import type { ScreenEntry } from './types';

const mp = (name: string, ...tags: string[]): ScreenEntry => ({ name, tags: ['marketplace', ...tags] });

export const MARKETPLACE: readonly ScreenEntry[] = [
  mp('marketplace/skills', 'view'),
  mp('marketplace/themes', 'view'),
  mp('marketplace/search', 'view'),
  mp('marketplace/detail', 'dialog'),
  // One screen per kind of detail page (2026-10-04 redesign): a bundle with what's inside
  // it, a skill that came in a bundle, an item the automatic check flagged, a listing that
  // cannot be installed from here, a theme not installed yet, and an integration.
  mp('marketplace/detail/bundle', 'dialog'),
  mp('marketplace/detail/member', 'dialog'),
  mp('marketplace/detail/caution', 'dialog'),
  mp('marketplace/detail/connection', 'dialog'),
  mp('marketplace/theme-detail', 'dialog'),
  mp('marketplace/theme-detail/not-installed', 'dialog'),
  mp('marketplace/integration-detail', 'dialog'),
  // The same pages at phone width and in a small window — they must fit and resize.
  { ...mp('marketplace/detail#phone', 'dialog', 'narrow'), viewport: { width: 390, height: 844 } },
  { ...mp('marketplace/theme-detail#phone', 'dialog', 'narrow'), viewport: { width: 390, height: 844 } },
  { ...mp('marketplace/detail#small', 'dialog'), viewport: { width: 640, height: 480 } },
  // The two other arrangements of the same page (workbench-mode.ts `workbenchDetailLayout`),
  // for Destin to pick between; without the switch the page is the one-column `stack`.
  { ...mp('marketplace/detail#columns', 'dialog'), params: { detailLayout: 'columns' } },
  { ...mp('marketplace/detail#folded', 'dialog'), params: { detailLayout: 'folded' } },
  { ...mp('marketplace/detail/bundle#columns', 'dialog'), params: { detailLayout: 'columns' } },
  { ...mp('marketplace/detail/bundle#folded', 'dialog'), params: { detailLayout: 'folded' } },
  { ...mp('marketplace/integration-detail#columns', 'dialog'), params: { detailLayout: 'columns' } },
  // Share/publish sheets — App.tsx owns their id state; both open on the same
  // fixture items marketplace/detail and marketplace/theme-detail use.
  mp('marketplace/share', 'dialog'),
  mp('marketplace/theme-share', 'dialog'),
  // Nothing installed and the registry unreachable.
  { ...mp('marketplace#empty', 'view', 'empty-state'), params: { marketplace: 'empty' } },
  mp('library/themes', 'view'),
  { ...mp('library#empty', 'view', 'empty-state'), params: { marketplace: 'empty' } },
  { ...mp('library#load-failed', 'view', 'error-state'), params: { fail: 'skills.list' } },
  { ...mp('library/themes#load-failed', 'view', 'error-state'), params: { fail: 'theme.marketplace.list' } },
];
