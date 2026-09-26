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
  // Nothing installed and the registry unreachable.
  { ...mp('marketplace#empty', 'view', 'empty-state'), params: { marketplace: 'empty' } },
  mp('library/themes', 'view'),
  { ...mp('library#empty', 'view', 'empty-state'), params: { marketplace: 'empty' } },
];
