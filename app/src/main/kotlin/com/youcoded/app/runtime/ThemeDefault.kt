package com.youcoded.app.runtime

import org.json.JSONObject
import java.io.File

/**
 * Which theme this install shows when the user has never picked one — the Android half of
 * desktop's `shared/theme-default.ts` (same field, same two answers).
 *
 * WHY (final review F1, 2026-10-13 — a blocker): the YouCoded light/dark pair is the default for
 * NEW installs only (Destin's approval). Nothing before this release stored the implicit Midnight
 * default, so an existing user who never chose a theme looked exactly like a new install. The
 * answer is recorded ONCE in the appearance file:
 *   - "youcoded" — written by [Bootstrap.setup] when the app's home folder did not exist yet, i.e. the
 *     very first setup on this phone;
 *   - "midnight" — written by `appearance:get`/`appearance:set` when the file still has no answer,
 *     which can only be an install that was set up before this release.
 * The shared React UI reads it through `appearance:get`.
 */
object ThemeDefault {
    const val FIELD = "defaultTheme"

    /** Writes `defaultTheme` into [file] only if it holds no answer yet; returns the answer now on disk. */
    @Synchronized
    fun ensure(file: File, isNewInstall: Boolean): String {
        val existing = try { JSONObject(file.readText()) } catch (_: Exception) { JSONObject() }
        val current = existing.optString(FIELD, "")
        if (current == "midnight" || current == "youcoded") return current
        val decided = if (isNewInstall) "youcoded" else "midnight"
        try {
            existing.put(FIELD, decided)
            file.parentFile?.mkdirs()
            file.writeText(existing.toString())
        } catch (_: Exception) { /* decided again on the next read; the UI keeps its own guess meanwhile */ }
        return decided
    }
}
