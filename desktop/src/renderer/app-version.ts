// The app's own version, for anything that shows it to the user.
//
// WHY a module and not a re-declared ambient: `__APP_VERSION__` is a Vite `define`
// (vite.config.ts), so every file that wants it otherwise repeats
// `declare const __APP_VERSION__` and its own `typeof … !== 'undefined'` guard —
// SettingsPanel already did, and the ticket screen was about to be the second.
//
// The guard is load-bearing, not defensive noise: under vitest and any non-Vite
// build the define does not exist, and a bare reference is a ReferenceError that
// takes the whole screen down.
//
// NOTE the ticket flow depends on: this is the RENDERER's idea of the version.
// `submitIssue` stamps the issue body with the main process's `app.getVersion()`.
// They agree in a built app and can differ in a dev instance, which is the correct
// place for that difference to show up.
declare const __APP_VERSION__: string;
declare const __BUILD_CHANNEL__: string;

export const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '';

export const BUILD_CHANNEL: string =
  typeof __BUILD_CHANNEL__ !== 'undefined' ? __BUILD_CHANNEL__ : '';

/** "YouCoded 1.2.4 · linux" — the one line a ticket shows for "what are you running". */
export function versionLine(platform?: string): string {
  const v = APP_VERSION ? `YouCoded ${APP_VERSION}` : 'YouCoded';
  const p = platform || (typeof navigator !== 'undefined' ? navigator.platform : '');
  return p ? `${v} · ${p}` : v;
}
