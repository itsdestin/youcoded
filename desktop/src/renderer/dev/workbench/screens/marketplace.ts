// The marketplace and the library: tabs, a search, and one skill and one theme detail
// (fixture items civic-report and meadow-mist), plus the brand-new-install empty state.
import type { ScreenEntry } from './types';

const mp = (name: string, ...tags: string[]): ScreenEntry => ({ name, tags: ['marketplace', ...tags] });

export const MARKETPLACE: readonly ScreenEntry[] = [
  mp('marketplace/skills', 'view'),
  mp('marketplace/themes', 'view'),
  mp('marketplace/search', 'view'),
  mp('marketplace/detail', 'dialog'),
  mp('marketplace/theme-detail', 'dialog'),
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
