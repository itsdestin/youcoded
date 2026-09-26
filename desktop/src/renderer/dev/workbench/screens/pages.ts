// Pages: the view, pages open in it (fixture ids, dev/workbench/fixtures/pages.ts), the
// focused view a pinned button opens, the library over it, and its dialogs. The
// connection pages open on their approval step — nothing in a page runs before a yes.
import type { ScreenEntry } from './types';

const pg = (name: string, ...tags: string[]): ScreenEntry => ({ name, tags: ['pages', ...tags] });
const PHONE = { width: 390, height: 844 };

export const PAGES: readonly ScreenEntry[] = [
  pg('pages', 'view'),
  { ...pg('pages#empty', 'view', 'empty-state'), scenario: 'empty' },
  pg('pages/page/page-week-planner', 'view'),
  pg('pages/focus/page-focus-timer', 'view'),
  // Approval states, one fixture page each.
  pg('pages/page/page-weather', 'view', 'approval'),
  pg('pages/page/page-task-board', 'view', 'approval'),
  { ...pg('pages/page/page-task-board#phone-keys', 'view', 'approval'), params: { pagesPhone: '1' } },
  pg('pages/page/page-headlines', 'view', 'approval'),
  pg('pages/page/page-link-reader', 'view', 'approval'),
  pg('pages/page/page-analytics', 'view', 'approval'),
  pg('pages/page/page-trip-board', 'view', 'approval', 'error-state'),
  pg('pages/library', 'view'),
  pg('pages/library/connections', 'dialog'),
  pg('pages/library/edit', 'dialog'),
  pg('pages/create', 'dialog'),
  // At phone size.
  { ...pg('pages#phone', 'view', 'narrow'), viewport: PHONE },
  { ...pg('pages/library#phone', 'view', 'narrow'), viewport: PHONE },
  { ...pg('pages/focus/page-focus-timer#phone', 'view', 'narrow'), viewport: PHONE },
];
