// App-wide dialogs that belong to no one area: a quit (or the last window's close) refused for
// unsaved text edits (Task 6 fix rounds 9–11; components/UnsavedBeforeQuit.tsx).
import type { ScreenEntry } from './types';

const app = (name: string, ...tags: string[]): ScreenEntry => ({ name, tags: ['app', ...tags] });

export const APP: readonly ScreenEntry[] = [
  // An open editor, a parked draft that can be opened, one whose file is gone.
  app('app/unsaved-before-quit', 'dialog'),
  // A short window: the list scrolls and the buttons stay put (close-session-4, the footer slot).
  { ...app('app/unsaved-before-quit#short', 'dialog'), viewport: { width: 1440, height: 480 } },
  // Refused after teardown, when it was a restart: the chats have stopped; it will quit instead.
  app('app/unsaved-before-quit/after-restart', 'dialog'),
  // "Discard and quit" asks in place first.
  app('app/unsaved-before-quit/discard', 'dialog'),
  // No "all saved" state (final-review#CH-21): once nothing is unsaved the quit just goes on.
  // Not a screen of the app: every shared hand-drawn icon at 48px (dev/workbench/IconSheet.tsx),
  // so a malformed drawing is visible at a glance. Photo-only build only.
  { name: 'dev/icons', tags: ['dev'], viewport: { width: 1440, height: 1300 } },
  // Not a screen either: every status tag on a popup and in a card, at fixed positions, so its
  // tint can be measured per theme (dev/workbench/PillSheet.tsx). The stronger-tint variant
  // (dev/pills#strong) is gone: not adopted (final-review#TL-0).
  { name: 'dev/pills', tags: ['dev'] },
  // Open tasks with tasks in it — the real popup over practice tasks (dev/workbench/
  // OpenTasksPractice.tsx), since no practice conversation creates tasks. Both folded sections
  // start open (five or fewer in each), as in the app (submit-ticket-5#ST5-Q2).
  { name: 'dev/open-tasks', tags: ['dev'], mark: 'chat/open-tasks' },
  // The same popup over a native session's TodoWrite list (Open tasks rework, 2026-10-13: the
  // path that showed nothing before).
  { name: 'dev/open-tasks#native', tags: ['dev'], mark: 'chat/open-tasks', params: { tasks: 'native' } },
];
