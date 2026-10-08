// Pages: the view, pages open in it (fixture ids, dev/workbench/fixtures/pages.ts), the
// focused view a pinned button opens, the library over it, and its dialogs. The
// connection pages open on their approval step — nothing in a page runs before a yes.
import type { ScreenEntry } from './types';
import { homeVariantEntries } from '../fixtures/home-variants/registry';

const pg = (name: string, ...tags: string[]): ScreenEntry => ({ name, tags: ['pages', ...tags] });
const PHONE = { width: 390, height: 844 };

export const PAGES: readonly ScreenEntry[] = [
  pg('pages', 'view'),
  { ...pg('pages#empty', 'view', 'empty-state'), scenario: 'empty' },
  pg('pages/page/page-week-planner', 'view'),
  pg('pages/focus/page-focus-timer', 'view'),
  // The theme's wallpaper through a page in the newer 'float' chrome style (shoot with a wallpaper theme: --themes halftone-dimension).
  { ...pg('pages/page/page-week-planner#float', 'view'), params: { chrome: 'float' } },
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
  // The camera card (spec 2026-10-04): recent events with thumbnails, Watch live; the other camera has none yet.
  { ...pg('pages/page/page-home#camera', 'view'), params: { pagesHome: 'camera' } },
  // The camera card with events that have no recording (the owner's newer Nest cameras): plain icon rows among the recordings.
  { ...pg('pages/page/page-home#camera-events', 'view'), params: { pagesHome: 'camera-events' } },
  // The Cameras tab while Google refuses live video: the calm "trying again at" state, with Retry.
  { ...pg('pages/page/page-home#camera-limited', 'view'), params: { pagesHome: 'camera-limited' } },
  // The Cameras tab: every camera in a grid, all live at once (pretend video).
  { ...pg('pages/page/page-home#cameras', 'view'), params: { pagesHome: 'view-cameras' } },
  { ...pg('pages/page/page-home#remote', 'view'), params: { pagesHome: 'remote' } },
  // The Media tab with the remote open (the pad, the Back/Home row and the app buttons inside the now-playing box).
  { ...pg('pages/page/page-home#remote-media', 'view'), params: { pagesHome: 'remote-media' } },
  { ...pg('pages/page/page-home#media-group', 'view'), params: { pagesHome: 'media-group' } },
  // The Media tab with the remote open on a very wide card (the page's width cap lifted): the app drawer takes the left two thirds with big tiles.
  { ...pg('pages/page/page-home#remote-wide', 'view'), params: { pagesHome: 'remote-wide' } },
  // The connected Home tab with the theme's background showing through (Show theme background, on by
  // default). Only wallpaper themes in a floating style are glass, so shoot it with
  // `--themes halftone-dimension,kuromi-dreamer`; elsewhere it matches #connected by design.
  { ...pg('pages/page/page-home#see-through', 'view'), params: { pagesHome: 'connected' }, sameAs: { name: 'pages/page/page-home#connected', why: 'see-through is on by default, so the connected view already shows it; this name exists to be shot in a wallpaper theme' } },
  { ...pg('pages/page/page-home#group', 'view'), params: { pagesHome: 'group' } },
  { ...pg('pages/page/page-home#device', 'view'), params: { pagesHome: 'device' } },
  { ...pg('pages/page/page-home#activity', 'view'), params: { pagesHome: 'view-activity' } },
  { ...pg('pages/page/page-home#lights', 'view'), params: { pagesHome: 'view-lights' } },
  // `#lights` shows Destin's Room unfolded (cards start closed); `#lights-colour` adds the floating colour panel on its desk backlight.
  { ...pg('pages/page/page-home#lights-colour', 'view'), params: { pagesHome: 'lights-colour' } },
  { ...pg('pages/page/page-home#media', 'view'), params: { pagesHome: 'view-media' } },
  { ...pg('pages/page/page-home#climate', 'view'), params: { pagesHome: 'view-climate' } },
  // The thermostat dial with the room at the dial's two ends (and Auto), on the Home tab's narrow card and on the Climate tab: where "Now 79" goes.
  { ...pg('pages/page/page-home#thermo-cold', 'view'), params: { pagesHome: 'thermo-50' } },
  { ...pg('pages/page/page-home#thermo-hot', 'view'), params: { pagesHome: 'thermo-90' } },
  { ...pg('pages/page/page-home#thermo-auto', 'view'), params: { pagesHome: 'thermo-79-auto' } },
  { ...pg('pages/page/page-home#thermo-cold-climate', 'view'), params: { pagesHome: 'thermo-50-climate' } },
  { ...pg('pages/page/page-home#thermo-hot-climate', 'view'), params: { pagesHome: 'thermo-90-climate' } },
  { ...pg('pages/page/page-home#thermo-auto-climate', 'view'), params: { pagesHome: 'thermo-79-climate-auto' } },
  { ...pg('pages/page/page-home#problems', 'view', 'error-state'), params: { pagesHome: 'view-problems' } },
  { ...pg('pages/page/page-home#settings', 'view'), params: { pagesHome: 'settings' } },
  { ...pg('pages/page/page-home#chips-pills', 'view'), params: { pagesHome: 'chips-pills' } },
  { ...pg('pages/page/page-home#chips-sentence', 'view'), params: { pagesHome: 'chips-sentence' } },
  { ...pg('pages/page/page-home#chips-tiles', 'view'), params: { pagesHome: 'chips-tiles' } },
  // Redesign options, one screen each (fixtures/home-variants/), listed from the registry so
  // a helper adding an option never edits this file.
  ...homeVariantEntries().map(([k, v]) => ({ ...pg(`pages/page/page-home#v-${k}`, 'view', 'redesign'), params: { pagesHome: `v-${k}` }, ...(v.sameAs ? { sameAs: v.sameAs } : {}) })),
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
