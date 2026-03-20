package com.destin.code.parser

data class ParsedMenu(
    val id: String,
    val title: String,
    val options: List<String>,
    val selectedIndex: Int,  // which option is currently highlighted by ❯
)

object InkSelectParser {

    // Matches the selected line: starts with ❯ (U+276F), optionally followed by number
    private val SELECTED_LINE = Regex("""^❯\s*(?:\d+\.\s+)?(.+)$""")
    // Strips ANSI escape sequences from terminal output
    private val ANSI_ESCAPE = Regex("\u001b\\[[0-9;]*[a-zA-Z]")
    // Matches unselected lines: starts with exactly 2 spaces (Ink Select rendering), optionally numbered
    private val UNSELECTED_LINE = Regex("""^ {2}(?:\d+\.\s+)?(.+)$""")

    // Title overrides for known prompts — keyed by lowercase keyword found in context
    private val TITLE_OVERRIDES = mapOf(
        "trust" to "Trust This Folder?",
        "dark mode" to "Choose a Theme",
        "login method" to "Select Login Method",
        "dangerously-skip-permissions" to "Skip Permissions Warning",
        "skip all permission" to "Skip Permissions Warning",
    )

    /**
     * Attempt to parse an Ink Select menu from combined screen+raw PTY output.
     * Returns null if no menu is detected.
     */
    fun parse(screenText: String): ParsedMenu? {
        val lines = screenText.lines()

        // Find the selected-item line (starts with ❯)
        val selectorIndex = lines.indexOfLast { line ->
            SELECTED_LINE.matches(line.trimEnd())
        }
        if (selectorIndex < 0) return null

        // Gather contiguous option lines around the selector
        val options = mutableListOf<String>()
        val optionIndices = mutableListOf<Int>()

        // Walk backward from selector to find earlier options
        for (i in (selectorIndex - 1) downTo 0) {
            val match = UNSELECTED_LINE.matchEntire(lines[i].trimEnd()) ?: break
            options.add(0, match.groupValues[1].trim())
            optionIndices.add(0, i)
        }
        // Add the selected item
        val selectedMatch = SELECTED_LINE.matchEntire(lines[selectorIndex].trimEnd()) ?: return null
        val selectedIndex = options.size  // index within our collected options list
        options.add(selectedMatch.groupValues[1].trim())
        optionIndices.add(selectorIndex)
        // Walk forward from selector+1 to find later options
        for (i in (selectorIndex + 1) until lines.size) {
            val match = UNSELECTED_LINE.matchEntire(lines[i].trimEnd()) ?: break
            options.add(match.groupValues[1].trim())
            optionIndices.add(i)
        }

        // Need at least 2 options for a valid menu
        if (options.size < 2) return null

        // Filter out noise — each option should be relatively short (< 120 chars)
        if (options.any { it.length > 120 }) return null

        // Extract title from context above the menu
        val title = extractTitle(lines, optionIndices.first(), screenText)

        // Generate a stable ID from the options
        val id = "menu_" + options.joinToString("_") { it.take(10) }
            .lowercase().replace(Regex("[^a-z0-9_]"), "")

        return ParsedMenu(id = id, title = title, options = options, selectedIndex = selectedIndex)
    }

    /**
     * Look for a title/question in the lines above the menu.
     * First checks TITLE_OVERRIDES, then scans for the nearest question or heading.
     */
    private fun extractTitle(lines: List<String>, firstOptionLine: Int, fullText: String): String {
        val lower = fullText.lowercase()

        // Check title overrides first
        for ((keyword, title) in TITLE_OVERRIDES) {
            if (keyword in lower) return title
        }

        // Scan up to 10 lines above the menu for context
        val searchStart = maxOf(0, firstOptionLine - 10)
        for (i in (firstOptionLine - 1) downTo searchStart) {
            val line = lines[i].trim()
            if (line.isEmpty()) continue
            // Skip ANSI escape sequences for matching
            val clean = line.replace(ANSI_ESCAPE, "").trim()
            if (clean.isEmpty()) continue
            // Prefer lines ending with ? or : as titles
            if (clean.endsWith("?") || clean.endsWith(":")) {
                return clean.trimEnd(':', '?').trim() + if (clean.endsWith("?")) "?" else ""
            }
            // Otherwise use the first non-empty line above as the title
            if (clean.length in 3..80) return clean
        }

        return "Select an Option"
    }

    /**
     * Generate PromptButtons from a parsed menu.
     * Sends up-arrows for items above the selector and down-arrows for items below.
     */
    fun toPromptButtons(menu: ParsedMenu): List<com.destin.code.ui.PromptButton> {
        val up = "\u001b[A"
        val down = "\u001b[B"
        return menu.options.mapIndexed { index, label ->
            val offset = index - menu.selectedIndex
            val sequence = when {
                offset < 0 -> up.repeat(-offset) + "\r"
                offset > 0 -> down.repeat(offset) + "\r"
                else -> "\r"  // already selected
            }
            com.destin.code.ui.PromptButton(label = label, input = sequence)
        }
    }
}
