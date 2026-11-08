// Coverage batch C (2026-11-08): surfaces that could not be photographed until the component carried a screen mark
// (hidden, photo-only build) — the confirms that used to say "noScreen", hand-rolled popups, the buddy's own windows,
// the buddy's tips and the app's two crash screens. The release side of a comparison lacks these marks, so those
// pictures honestly fail there. newIn is set only where the UI itself is new since v1.3.3.
import type { ScreenEntry } from './types';

const PHONE = { width: 390, height: 844 };
const chat = (name: string, ...tags: string[]): ScreenEntry => ({ name, tags: ['chat', ...tags] });
const mp = (name: string, ...tags: string[]): ScreenEntry => ({ name, tags: ['marketplace', ...tags] });
const COMPOSER_LABEL = 'Write a comment';

// WHY: two confirms in the file drawer, shown over the file as it opens. (The real routes are Review changes → Revert, and
// Edit → type → Esc; a screen's mark has to show before any click, so these are raised directly, with the same state.)
const FILES: readonly ScreenEntry[] = [
  { ...chat('chat/files/revert/a-launch-brief', 'pane', 'viewer', 'dialog'), session: 'wb-1', mark: 'chat/files/revert' },
  { ...chat('chat/files/unsaved/a-chatview', 'pane', 'viewer', 'dialog'), session: 'wb-1', mark: 'chat/files/unsaved' },
];

// WHY: the Browser's three "this restarts / signs you out" confirms (fake backend: `?browser=working` has pages open in two chats).
const BROWSER: readonly ScreenEntry[] = [
  { name: 'settings/assistant/browser/window-confirm', tags: ['settings', 'dialog', 'browser'], params: { browser: 'working' } },
  { name: 'settings/assistant/browser/switch-confirm', tags: ['settings', 'dialog', 'browser'], params: { browser: 'working' } },
  { name: 'settings/assistant/browser/signout-confirm', tags: ['settings', 'dialog', 'browser'], params: { browser: 'working' } },
  { name: 'chat/browser/window-confirm', tags: ['chat', 'pane', 'browser', 'dialog'], params: { browser: 'working' } },
];

// WHY: GitHub's one-time code (`?github=code` answers with a sample code and never finishes).
const ACCOUNT: readonly ScreenEntry[] = [
  { name: 'settings/account/connections/connect-github', tags: ['settings', 'dialog'], params: { signedIn: '1', github: 'code' } },
];

// WHY: the Marketplace's small popups and states with no marks until now.
const MARKET: readonly ScreenEntry[] = [
  { ...mp('marketplace/skills/filters', 'dialog', 'narrow'), viewport: PHONE },
  // The comment box with a draft typed in (signed in, so the placeholder and the live Post button show).
  { ...mp('marketplace/detail#comment-draft', 'dialog'), params: { signedIn: '1' },
    open: [{ do: 'type', target: { role: 'textbox', label: COMPOSER_LABEL }, text: 'Does this work with Word files?' }] },
];

// WHY: a project import that had nothing to do (the same wording a real import uses).
const PROJECTS: readonly ScreenEntry[] = [
  { name: 'projects/files/import-result', tags: ['projects', 'dialog'] },
];

// WHY: the end-of-match card of a two-player game, over a finished Connect Four board.
const GAMES: readonly ScreenEntry[] = [
  { ...chat('chat/games/connect-four/game-over', 'pane', 'games'), params: { signedIn: '1' },
    escapeStepsBack: 'the end-of-match card is part of the board, not a popup: it has Rematch and Back to lobby, and Escape leaves it showing' },
];

// WHY: Office when it cannot start, and when this build has none (the multi-tab strip is already office/document: it opens three tabs).
const OFFICE: readonly ScreenEntry[] = [
  { name: 'office/home#failed', tags: ['office', 'error-state'], params: { office: 'failed-later' }, mark: 'office/home/failed' },
  { name: 'office/home#unavailable', tags: ['office', 'empty-state'], params: { office: 'unavailable-later' }, mark: 'office/home/unavailable' },
];

// WHY: the buddy's welcome panes (each is the shipping window framed at its real size, dev/workbench/BuddyPractice.tsx).
const buddy = (which: string, extra: Partial<ScreenEntry> = {}): ScreenEntry =>
  ({ name: `dev/buddy#${which}`, tags: ['dev', 'buddy', 'narrow'], viewport: { width: 320, height: 480 }, params: { buddy: which }, mark: 'dev/buddy', ...extra });
const BUDDY: readonly ScreenEntry[] = [
  buddy('welcome-new'),
  buddy('welcome-resume'),
  buddy('welcome-resume-error', { tags: ['dev', 'buddy', 'narrow', 'error-state'] }),
];

// WHY: the eight tips the buddy gives at their own moments (`tip/<id>` raises one the way its moment does). They wait while a conversation is answering, so they are photographed on the empty start screen (no conversation running). All in v1.3.3.
const TIPS: readonly ScreenEntry[] = ['tags', 'notes', 'projects', 'resume', 'local-models', 'floater', 'themes', 'help']
  .map((id) => ({ name: `tip/${id}`, tags: ['tour', 'tip'], scenario: 'empty' as const, escapeStepsBack: 'a tip is a note on the buddy, not a popup: Escape leaves it showing until Got it' }));

export const COVERAGE_C: readonly ScreenEntry[] = [
  ...FILES,
  ...BROWSER,
  ...ACCOUNT,
  ...MARKET,
  ...PROJECTS,
  ...GAMES,
  ...OFFICE,
  ...BUDDY,
  ...TIPS,
];
