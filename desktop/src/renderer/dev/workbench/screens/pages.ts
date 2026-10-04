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
  // Home-device deck (2026-10-01): a device line, with its address box.
  pg('pages/page/page-home', 'view', 'approval'),
  { ...pg('pages/page/page-home#key', 'view', 'approval'), params: { pagesStep: 'keys' } },
  { ...pg('pages/page/page-home#refused', 'view', 'approval', 'error-state'), params: { pagesHome: 'refused' } },
  { ...pg('pages/page/page-home#connected', 'view'), params: { pagesHome: 'connected' } },
  { ...pg('pages/page/page-home#edit', 'view'), params: { pagesHome: 'edit' } },
  { ...pg('pages/page/page-home#remote', 'view'), params: { pagesHome: 'remote' } },
  { ...pg('pages/page/page-home#lights', 'view'), params: { pagesHome: 'view-lights' } },
  { ...pg('pages/page/page-home#media', 'view'), params: { pagesHome: 'view-media' } },
  { ...pg('pages/page/page-home#climate', 'view'), params: { pagesHome: 'view-climate' } },
  { ...pg('pages/page/page-home#problems', 'view', 'error-state'), params: { pagesHome: 'view-problems' } },
  { ...pg('pages/page/page-home#settings', 'view'), params: { pagesHome: 'settings' } },
  { ...pg('pages/page/page-home#chips-pills', 'view'), params: { pagesHome: 'chips-pills' } },
  { ...pg('pages/page/page-home#chips-sentence', 'view'), params: { pagesHome: 'chips-sentence' } },
  { ...pg('pages/page/page-home#chips-tiles', 'view'), params: { pagesHome: 'chips-tiles' } },
  { ...pg('pages/page/page-home#mock-device-inplace', 'view'), params: { pagesHome: 'mock-device-inplace' } },
  { ...pg('pages/page/page-home#mock-device-popup', 'view'), params: { pagesHome: 'mock-device-popup' } },
  { ...pg('pages/page/page-home#mock-device-panel', 'view'), params: { pagesHome: 'mock-device-panel' } },
  { ...pg('pages/page/page-home#mock-activity-tab', 'view'), params: { pagesHome: 'mock-activity-tab' } },
  { ...pg('pages/page/page-home#mock-activity-feed', 'view'), params: { pagesHome: 'mock-activity-feed' } },
  { ...pg('pages/page/page-home#mock-activity-timeline', 'view'), params: { pagesHome: 'mock-activity-timeline' } },
  { ...pg('pages/page/page-home#mock-camera-tap', 'view'), params: { pagesHome: 'mock-camera-tap' } },
  { ...pg('pages/page/page-home#mock-camera-always', 'view'), params: { pagesHome: 'mock-camera-always' } },
  { ...pg('pages/page/page-home#mock-camera-events', 'view'), params: { pagesHome: 'mock-camera-events' } },
  pg('pages/page/page-analytics', 'view', 'approval'),
  pg('pages/page/page-trip-board', 'view', 'approval', 'error-state'),
  // Office (built in, design stage). Documents need the editor add-on served on
  // 127.0.0.1:4717 — fixtures/office.ts says how.
  pg('office/home', 'view', 'office'),
  { ...pg('office/first-run', 'view', 'office', 'empty-state'), scenario: 'empty' },
  pg('office/document', 'view', 'office'),
  pg('office/spreadsheet', 'view', 'office'),
  pg('office/presentation', 'view', 'office'),
  // Office's comments panel, restyled like the app's comment cards (finish plan Task 6).
  pg('office/document-comments', 'view', 'office'),
  pg('office/spreadsheet-comments', 'view', 'office'),
  pg('office/versions', 'dialog', 'office'),
  pg('pages/library', 'view'),
  pg('pages/library/connections', 'dialog'),
  pg('pages/library/edit', 'dialog'),
  pg('pages/create', 'dialog'),
  // At phone size.
  { ...pg('pages#phone', 'view', 'narrow'), viewport: PHONE },
  { ...pg('pages/library#phone', 'view', 'narrow'), viewport: PHONE },
  { ...pg('pages/focus/page-focus-timer#phone', 'view', 'narrow'), viewport: PHONE },
];
