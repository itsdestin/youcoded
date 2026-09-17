// Bundled plugins are marketplace plugins that ship with YouCoded and cannot
// be uninstalled through the UI. On every launch, if a bundled plugin is
// missing from ~/.claude/plugins/installed_plugins.json, the app reinstalls
// it silently.
//
// PARITY REQUIRED — keep this list in sync with:
//   youcoded/app/src/main/kotlin/com/youcoded/app/skills/BundledPlugins.kt
// If you change the list, also update docs/PITFALLS.md.

export const BUNDLED_PLUGIN_IDS = [
  'wecoded-themes-plugin',
  'wecoded-marketplace-publisher',
  'youcoded-chatsearch',
  // YouCoded Pages (Phase 1, 2026-09-17): the /page-builder skill behind Make a page and
  // Edit in chat. Bundled so a page can be built without a marketplace visit.
  'wecoded-pages-plugin',
] as const;

export const BUNDLED_REASON =
  'Bundled with YouCoded — required for theme customization, publishing, conversation search, and building pages.';

export function isBundledPlugin(id: string): boolean {
  return (BUNDLED_PLUGIN_IDS as readonly string[]).includes(id);
}
