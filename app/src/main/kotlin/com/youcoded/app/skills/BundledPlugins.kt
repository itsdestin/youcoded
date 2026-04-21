// Bundled plugins are marketplace plugins that ship with YouCoded and cannot
// be uninstalled through the UI. On every launch, if a bundled plugin is
// missing, the app reinstalls it silently.
//
// PARITY REQUIRED — keep this list in sync with:
//   youcoded/desktop/src/shared/bundled-plugins.ts
// If you change the list, also update docs/PITFALLS.md.

package com.youcoded.app.skills

object BundledPlugins {
    val IDS = listOf(
        "wecoded-themes-plugin",
        "wecoded-marketplace-publisher",
    )

    const val REASON =
        "Bundled with YouCoded — required for theme customization and publishing."

    fun isBundled(id: String): Boolean = IDS.contains(id)
}
