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
] as const;

export const BUNDLED_REASON =
  'Bundled with YouCoded — required for theme customization and publishing.';

export function isBundledPlugin(id: string): boolean {
  return (BUNDLED_PLUGIN_IDS as readonly string[]).includes(id);
}
