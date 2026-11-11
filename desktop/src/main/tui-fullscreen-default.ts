// Seed `tui: "fullscreen"` into the PHONE's ~/.claude/settings.json when the key is ABSENT.
//
// WHY (card #213; Destin 2026-11-08: "okay" to fullscreen together with the swipe fix): in Claude
// Code's default display mode, every terminal resize reprints the visible screen, so a phone
// rotation or fold doubles lines in terminal view (measured 0 -> 12 -> 22 extra copies over
// repeated rotations; docs/active/investigations/2026-11-08-phone-fullscreen-mode.md in the
// workspace). Fullscreen redraws one screen and keeps its own history, so nothing can double.
//
// Only when absent, like retention-default.ts: a user who runs `/tui default` inside Claude Code
// gets `"tui": "default"` written, and that choice is kept on every later boot. Never the
// CLAUDE_CODE_NO_FLICKER env var or `--settings`: both were tested to override the user's choice.
// Phone only (runSettingsChores' `phone` flag, from headless-boot.ts): the desktop keeps Claude
// Code's own default and whatever the user set.
//
// Swipes in terminal view become wheel input while Claude Code shows its fullscreen screen
// (TerminalView.tsx, `isAlternateScreen`), since xterm itself has no history to scroll there.
//
// CC-coupled: `tui` is a Claude Code settings contract. See youcoded/docs/cc-dependencies.md →
// "Fullscreen display mode on the phone (tui)".

export interface SeedTuiResult {
  /** True iff the key was absent and has been set. */
  changed: boolean;
  /** The value now in effect (whatever the user had, or 'fullscreen'), or undefined if unwritable. */
  effective: unknown;
}

export function seedTuiFullscreenInto(settings: Record<string, unknown>): SeedTuiResult {
  if (settings.tui !== undefined) return { changed: false, effective: settings.tui };
  settings.tui = 'fullscreen';
  return { changed: true, effective: 'fullscreen' };
}
