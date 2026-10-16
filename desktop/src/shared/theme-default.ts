// theme-default.ts — which theme an install shows when the user has never picked one.
//
// WHY this exists (final review F1, 2026-10-13 — a blocker): the YouCoded light/dark pair became the
// default theme, and Destin approved that for NEW installs only. Before this release nothing stored the
// implicit default, so a long-time user who never picked a theme has no saved theme at all and was
// indistinguishable from a brand-new install — the update would have switched them from Midnight to the
// lavender YouCoded theme. The host (the computer, or the Android app) now records ONCE, in the
// appearance file, which default this install is on:
//   - 'youcoded' — a new install (desktop: the setup wizard has never finished; Android: the app's home
//     folder did not exist yet when setup started);
//   - 'midnight' — an install that was already in use before this release.
// Every screen (each window, a phone over remote access, the Android app) reads that answer through
// appearance:get, so they all agree. Shared by main, the renderer and the tests; no Node or DOM imports.

/** The appearance-file field the host writes once. */
export const THEME_DEFAULT_FIELD = 'defaultTheme';

export type ThemeDefaultKind = 'midnight' | 'youcoded';

/** Anything other than the two known answers is "not known yet" — never a third kind. */
export function parseThemeDefault(raw: unknown): ThemeDefaultKind | null {
  return raw === 'midnight' || raw === 'youcoded' ? raw : null;
}

/** The theme a never-picked install shows. The YouCoded pair follows the computer's light/dark setting
 *  (theme questions deck T-1/T-5, Destin 2026-10-04); an existing install keeps the old Midnight. */
export function defaultThemeFor(kind: ThemeDefaultKind, prefersDark: boolean): string {
  if (kind === 'midnight') return 'midnight';
  return prefersDark ? 'youcoded-night' : 'youcoded';
}

/** The status-bar theme cycle a never-customised install uses — the old pair for an existing install. */
export function defaultCycleFor(kind: ThemeDefaultKind): string[] {
  return kind === 'midnight' ? ['midnight', 'dark'] : ['youcoded', 'youcoded-night'];
}

/** The decision the host records, given what it saw before this run wrote anything. */
export function decideThemeDefault(isNewInstall: boolean): ThemeDefaultKind {
  return isNewInstall ? 'youcoded' : 'midnight';
}

/** Renderer-side mirror of the host's answer, read before the host has answered (first paint). */
export const THEME_DEFAULT_MIRROR_KEY = 'youcoded-theme-default';

/**
 * The renderer's best guess before the host answers: the mirrored answer if there is one; otherwise an
 * install whose storage already holds any of the app's own keys is an existing one (Midnight), and an
 * empty storage is a new install. Only the first paint of the first launch after the update relies on
 * this — the host's answer replaces it a moment later and is mirrored for every launch after.
 */
export function guessThemeDefault(storage: Pick<Storage, 'getItem' | 'key' | 'length'> | null | undefined): ThemeDefaultKind {
  try {
    if (!storage) return 'youcoded';
    const mirrored = parseThemeDefault(storage.getItem(THEME_DEFAULT_MIRROR_KEY));
    if (mirrored) return mirrored;
    for (let i = 0; i < storage.length; i++) {
      if (storage.key(i)?.startsWith('youcoded-')) return 'midnight';
    }
  } catch { /* storage unavailable: treat as new */ }
  return 'youcoded';
}
