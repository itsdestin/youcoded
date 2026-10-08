// App-wide dialogs that belong to no one area: a quit (or the last window's close) refused for
// unsaved text edits (Task 6 fix rounds 9–11; components/UnsavedBeforeQuit.tsx).
import type { ScreenEntry } from './types';

const app = (name: string, ...tags: string[]): ScreenEntry => ({ name, tags: ['app', ...tags] });

export const APP: readonly ScreenEntry[] = [
  // An open editor, a parked draft that can be opened, one whose file is gone.
  app('app/unsaved-before-quit', 'dialog'),
  // Refused after teardown, when it was a restart: the chats have stopped; it will quit instead.
  app('app/unsaved-before-quit/after-restart', 'dialog'),
  // "Discard and quit" asks in place first.
  app('app/unsaved-before-quit/discard', 'dialog'),
  // Everything got saved while the prompt was open: "All saved." with Quit / Cancel.
  app('app/unsaved-before-quit/all-saved', 'dialog'),
  // Not a screen of the app: every shared hand-drawn icon at 48px (dev/workbench/IconSheet.tsx),
  // so a malformed drawing is visible at a glance. Photo-only build only.
  { name: 'dev/icons', tags: ['dev'], viewport: { width: 1440, height: 1300 } },
  // Not a screen either: every status tag on a popup and in a card, at fixed positions, so its
  // tint can be measured per theme (dev/workbench/PillSheet.tsx). `pillTint=strong` is the
  // proposed stronger tint (submit-ticket-5, waiting for Destin).
  { name: 'dev/pills', tags: ['dev'] },
  { name: 'dev/pills#strong', tags: ['dev'], params: { pillTint: 'strong' } },
];
