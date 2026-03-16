package com.destins.claudemobile.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily

object SyntaxHighlighter {
    private val keywordColor = Color(0xFFCC7832)    // orange
    private val stringColor = Color(0xFF6A8759)      // green
    private val commentColor = Color(0xFF808080)     // gray
    private val numberColor = Color(0xFF6897BB)      // blue

    private val kotlinKeywords = setOf(
        "fun", "val", "var", "class", "object", "interface", "if", "else",
        "when", "for", "while", "return", "import", "package", "private",
        "public", "internal", "override", "data", "sealed", "suspend",
        "null", "true", "false", "is", "in", "as", "by", "lazy",
    )

    private val jsKeywords = setOf(
        "function", "const", "let", "var", "if", "else", "for", "while",
        "return", "import", "export", "class", "async", "await", "new",
        "null", "undefined", "true", "false", "this", "require", "module",
    )

    private val pythonKeywords = setOf(
        "def", "class", "if", "elif", "else", "for", "while", "return",
        "import", "from", "as", "with", "try", "except", "raise", "pass",
        "None", "True", "False", "self", "lambda", "yield", "async", "await",
    )

    fun highlight(code: String, language: String): AnnotatedString {
        val keywords = when (language.lowercase()) {
            "kotlin", "kt" -> kotlinKeywords
            "javascript", "js", "typescript", "ts" -> jsKeywords
            "python", "py" -> pythonKeywords
            else -> emptySet()
        }

        return buildAnnotatedString {
            append(code)
            // Apply monospace to entire string
            addStyle(SpanStyle(fontFamily = com.destins.claudemobile.ui.theme.CascadiaMono), 0, code.length)

            if (keywords.isEmpty()) return@buildAnnotatedString

            // Highlight strings
            val stringRegex = Regex("""("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)""")
            for (match in stringRegex.findAll(code)) {
                addStyle(SpanStyle(color = stringColor), match.range.first, match.range.last + 1)
            }

            // Highlight comments
            val commentRegex = Regex("""(//.*|#.*|/\*[\s\S]*?\*/)""")
            for (match in commentRegex.findAll(code)) {
                addStyle(SpanStyle(color = commentColor), match.range.first, match.range.last + 1)
            }

            // Highlight numbers
            val numberRegex = Regex("""\b\d+\.?\d*\b""")
            for (match in numberRegex.findAll(code)) {
                addStyle(SpanStyle(color = numberColor), match.range.first, match.range.last + 1)
            }

            // Highlight keywords (word boundaries)
            val wordRegex = Regex("""\b(${keywords.joinToString("|")})\b""")
            for (match in wordRegex.findAll(code)) {
                addStyle(SpanStyle(color = keywordColor), match.range.first, match.range.last + 1)
            }
        }
    }
}
