package com.destin.code.parser

/** A button in an interactive terminal prompt. */
data class PromptButton(val label: String, val input: String)

data class ParsedMenu(
    val id: String,
    val title: String,
    val options: List<String>,
    val selectedIndex: Int,  // which option is currently highlighted by ❯
)

object InkSelectParser {

    // Matches the selected line: optional leading whitespace + ❯, optionally followed by number
    private val SELECTED_LINE = Regex("""^\s*❯\s*(?:\d+\.\s+)?(.+)$""")
    // Strips ANSI escape sequences from terminal output
    private val ANSI_ESCAPE = Regex("""\u001B\[[0-9;]*[a-zA-Z]""")
    // Matches unselected lines: 2+ leading spaces (no ❯), optionally numbered
    private val UNSELECTED_LINE = Regex("""^\s{2,}(?:\d+\.\s+)?(.+)$""")
    // Detects a new option (has a number prefix like "1. " or "2. ")
    private val NUMBERED_PREFIX = Regex("""^\s*\d+\.\s+""")

    // Title overrides for known prompts — keyed by lowercase keyword found in context
    // Note: bypass permissions prompt is handled by a hardcoded handler in ManagedSession,
    // not by the generic InkSelectParser, because it uses Enter/Esc (not arrow navigation).
    private val TITLE_OVERRIDES = mapOf(
        "trust" to "Trust This Folder?",
        "dark mode" to "Choose a Theme for the Terminal",
        "login method" to "Select Login Method",
    )

    /**
     * Attempt to parse an Ink Select menu from combined screen+raw PTY output.
     * Returns null if no menu is detected.
     */
    /** Strip ANSI escape codes from a line for clean matching. */
    private fun stripAnsi(line: String): String = line.replace(ANSI_ESCAPE, "")

    fun parse(screenText: String): ParsedMenu? {
        val lines = screenText.lines()
        // Pre-strip ANSI codes for matching (terminal output is full of color codes)
        val cleanLines = lines.map { stripAnsi(it) }

        // Find the selected-item line (starts with ❯)
        val selectorIndex = cleanLines.indexOfLast { line ->
            SELECTED_LINE.matches(line.trimEnd())
        }
        if (selectorIndex < 0) return null

        // Gather contiguous option lines around the selector
        val options = mutableListOf<String>()
        val optionIndices = mutableListOf<Int>()

        // Detect whether this menu uses numbered options (e.g. "1. Yes")
        val isNumberedMenu = cleanLines.any { NUMBERED_PREFIX.containsMatchIn(it) }

        // Walk backward from selector to find earlier options
        // Collect raw lines first, then merge continuations
        val rawAbove = mutableListOf<Pair<Int, String>>() // (lineIndex, text)
        for (i in (selectorIndex - 1) downTo 0) {
            val clean = cleanLines[i].trimEnd()
            if ("❯" in clean) break
            val match = UNSELECTED_LINE.matchEntire(clean) ?: break
            rawAbove.add(0, i to match.groupValues[1].trim())
        }
        // Merge continuation lines into their parent option (backward pass)
        for ((idx, text) in rawAbove) {
            val isNewOption = !isNumberedMenu || NUMBERED_PREFIX.containsMatchIn(cleanLines[idx])
            if (isNewOption || options.isEmpty()) {
                options.add(text)
                optionIndices.add(idx)
            } else {
                // Continuation line — merge into the last option
                options[options.lastIndex] = options.last() + " " + text
            }
        }

        // Add the selected item
        val selectedMatch = SELECTED_LINE.matchEntire(cleanLines[selectorIndex].trimEnd()) ?: return null
        val selectedIndex = options.size
        options.add(selectedMatch.groupValues[1].trim())
        optionIndices.add(selectorIndex)

        // Walk forward from selector+1 to find later options, merging continuations
        for (i in (selectorIndex + 1) until cleanLines.size) {
            val clean = cleanLines[i].trimEnd()
            if ("❯" in clean) break
            val match = UNSELECTED_LINE.matchEntire(clean) ?: break
            val text = match.groupValues[1].trim()
            val isNewOption = !isNumberedMenu || NUMBERED_PREFIX.containsMatchIn(clean)
            if (isNewOption) {
                options.add(text)
                optionIndices.add(i)
            } else {
                // Continuation line — merge into the previous option
                if (options.isNotEmpty()) {
                    options[options.lastIndex] = options.last() + " " + text
                }
            }
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
    fun toPromptButtons(menu: ParsedMenu): List<PromptButton> {
        val up = "\u001b[A"
        val down = "\u001b[B"
        return menu.options.mapIndexed { index, label ->
            val offset = index - menu.selectedIndex
            val sequence = when {
                offset < 0 -> up.repeat(-offset) + "\r"
                offset > 0 -> down.repeat(offset) + "\r"
                else -> "\r"  // already selected
            }
            PromptButton(label = label, input = sequence)
        }
    }
}
