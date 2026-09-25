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
// Guards: tests/shoot-screens.test.ts (every `useScreenOpen` name is listed
// here, every listed name is registered somewhere); `shoot --check` opens every
// entry in the photo-only build.
//
// Spec: docs/active/specs/2026-09-24-shoot-and-explore.md (workspace repo).

export type ScreenEntry = {
  /** Path-style name, e.g. `settings/assistant/cloud`. */
  name: string;
  /** Groups for `shoot --tag`. */
  tags: readonly string[];
  /** Workbench scenario the screen needs (default: `default`). */
  scenario?: 'default' | 'empty' | 'no-providers' | 'refused' | 'stress';
  /** Extra workbench URL switches, e.g. `{ fail: 'tags.list' }`. */
  params?: Readonly<Record<string, string>>;
  /** Another screen this one is EXPECTED to look identical to, and why. */
  sameAs?: { name: string; why: string };
};

const settings = (name: string, ...tags: string[]): ScreenEntry => ({ name, tags: ['settings', ...tags] });

export const SCREENS: readonly ScreenEntry[] = [
  settings('settings', 'drawer'),
  settings('settings/account', 'dialog'),
  { ...settings('settings/assistant', 'dialog'), sameAs: { name: 'settings/assistant/general', why: 'the panel opens on its General page' } },
  settings('settings/assistant/general', 'dialog'),
  settings('settings/assistant/cloud', 'dialog'),
  settings('settings/assistant/local', 'dialog'),
  settings('settings/assistant/permissions', 'dialog'),
  settings('settings/assistant/specialists', 'dialog'),
  settings('settings/appearance', 'dialog'),
  settings('settings/buddy', 'dialog'),
  settings('settings/sound', 'dialog'),
  // Only a two-graphics-chip computer shows this row; `gpus=2` makes the practice app one.
  { ...settings('settings/performance', 'dialog'), params: { gpus: '2' } },
  settings('settings/sync', 'dialog'),
  settings('settings/remote', 'dialog'),
  settings('settings/help', 'dialog'),
  settings('settings/development', 'dialog'),
  settings('settings/development/bug-report', 'dialog'),
  settings('settings/development/contribute', 'dialog'),
  settings('settings/shortcuts', 'dialog'),
  settings('settings/donate', 'dialog'),
  settings('settings/about', 'dialog'),
];

