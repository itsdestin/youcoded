// The screen list `shoot` photographs (scripts/shoot/). One entry per screen or
// screen state, named by the path a person takes to reach it.
//
// HOW A NAME OPENS: the photo-only build opens every prefix of the name that is
// itself in this list, in order — `settings/assistant/cloud` opens `settings`,
// then `settings/assistant`, then `settings/assistant/cloud`. Each name is
// registered by the component that owns it (`useScreenOpen` in
// shoot-mode.tsx) and proves it is showing with a `<ScreenMark>` inside its
// panel. Nothing here clicks, so renaming a button cannot break an entry.
//
// One file per area of the app (settings.ts, chat.ts, …); this file only joins them.
//
// Guards: tests/shoot-screens.test.ts (every `useScreenOpen` name is listed
// here, every listed name is registered somewhere); `shoot --check` opens every
// entry in the photo-only build.
//
// Spec: docs/active/specs/2026-09-24-shoot-and-explore.md (workspace repo).

import type { ScreenEntry } from './types';
import { SETTINGS } from './settings';
import { CHAT } from './chat';
import { MARKETPLACE } from './marketplace';
import { PROJECTS } from './projects';

export type { ScreenEntry } from './types';

export const SCREENS: readonly ScreenEntry[] = [
  ...SETTINGS,
  ...CHAT,
  ...MARKETPLACE,
  ...PROJECTS,
];
