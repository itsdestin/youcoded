package com.destins.claudemobile.ui

import android.content.Intent
import android.graphics.Paint
import android.graphics.Typeface
import android.net.Uri
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.res.ResourcesCompat
import com.destins.claudemobile.R
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.sp
import com.destins.claudemobile.ui.theme.ClaudeMobileTheme
import com.termux.terminal.TerminalBuffer
import com.termux.terminal.TerminalRow
import com.termux.terminal.TerminalSession
import com.termux.terminal.TextStyle

// Standard 16-color terminal palette (colors 0–15)
private val TERMINAL_PALETTE = intArrayOf(
    // Normal (0–7)
    0xFF1C1C1C.toInt(), // 0 Black
    0xFFCC4444.toInt(), // 1 Red
    0xFF44AA44.toInt(), // 2 Green
    0xFFBBAA44.toInt(), // 3 Yellow
    0xFF4488CC.toInt(), // 4 Blue
    0xFFAA44AA.toInt(), // 5 Magenta
    0xFF44AAAA.toInt(), // 6 Cyan
    0xFFCCCCCC.toInt(), // 7 White
    // Bright (8–15)
    0xFF888888.toInt(), // 8 Bright Black (Dark Gray)
    0xFFFF6666.toInt(), // 9 Bright Red
    0xFF66CC66.toInt(), // 10 Bright Green
    0xFFFFDD66.toInt(), // 11 Bright Yellow
    0xFF66AAFF.toInt(), // 12 Bright Blue
    0xFFFF66FF.toInt(), // 13 Bright Magenta
    0xFF66DDDD.toInt(), // 14 Bright Cyan
    0xFFFFFFFF.toInt(), // 15 Bright White
)

private val DEFAULT_FG = Color(0xFFE8E0D8)
private val DEFAULT_BG = Color(0xFF0A0A0A)
private val LINK_COLOR = Color(0xFF66AAFF) // Bright blue for clickable URLs
private val URL_PATTERN = Regex("""https?://[^\s)>\]"'`]+""")

private data class UrlRegion(val url: String, val left: Float, val top: Float, val right: Float, val bottom: Float)

/** Extract visible text from a TerminalRow for URL pattern matching. */
private fun extractRowText(row: TerminalRow, cols: Int): String {
    val sb = StringBuilder(cols)
    var col = 0
    while (col < cols) {
        val charIndex = row.findStartOfColumn(col)
        val spaceUsed = row.getSpaceUsed()
        if (charIndex >= spaceUsed) { sb.append(' '); col++; continue }
        val ch = row.mText[charIndex]
        val cp = if (Character.isHighSurrogate(ch) && charIndex + 1 < spaceUsed) {
            val low = row.mText[charIndex + 1]
            if (Character.isLowSurrogate(low)) Character.toCodePoint(ch, low) else ch.code
        } else ch.code
        sb.append(if (cp == 0 || cp == ' '.code) ' ' else String(Character.toChars(cp)))
        col++
    }
    return sb.toString()
}

/**
 * Resolves a Termux color index to an ARGB int.
 *
 * Termux encodes colors as:
 *   - 0..255    → indexed palette (0–15 basic, 16–231 216-color cube, 232–255 grayscale ramp)
 *   - COLOR_INDEX_FOREGROUND (256) → default foreground
 *   - COLOR_INDEX_BACKGROUND (257) → default background
 *   - Truecolor → values > 255 that aren't special indices (handled via mColors if needed)
 */
private fun resolveColor(colorIndex: Int, defaultColor: Color): Int {
    return when {
        colorIndex == TextStyle.COLOR_INDEX_FOREGROUND -> defaultColor.toArgb()
        colorIndex == TextStyle.COLOR_INDEX_BACKGROUND -> DEFAULT_BG.toArgb()
        colorIndex in 0..15 -> TERMINAL_PALETTE[colorIndex]
        colorIndex in 16..231 -> {
            // 216-color cube: index 16 + 36r + 6g + b, each channel 0–5
            val idx = colorIndex - 16
            val b = idx % 6
            val g = (idx / 6) % 6
            val r = idx / 36
            val toChannel = { v: Int -> if (v == 0) 0 else 55 + v * 40 }
            android.graphics.Color.rgb(toChannel(r), toChannel(g), toChannel(b))
        }
        colorIndex in 232..255 -> {
            // Grayscale ramp: 8, 18, ..., 238
            val level = 8 + (colorIndex - 232) * 10
            android.graphics.Color.rgb(level, level, level)
        }
        else -> defaultColor.toArgb()
    }
}

@Composable
fun TerminalPanel(
    session: TerminalSession?,
    screenVersion: Int = 0, // changes trigger Canvas redraw
    modifier: Modifier = Modifier,
) {
    val terminalBg = ClaudeMobileTheme.extended.terminalBg
    val context = LocalContext.current

    // Terminal keeps a minimum of 80 columns. Font size is calculated
    // dynamically to fit 80 columns in the available width.
    val minCols = 60
    var gridCols by remember { mutableIntStateOf(minCols) }
    var gridRows by remember { mutableIntStateOf(24) }

    // Vertical scroll offset (in rows) into scrollback history
    var scrollOffsetRows by remember { mutableFloatStateOf(0f) }
    var cellHeightPx by remember { mutableFloatStateOf(1f) }

    // Font size is calculated on layout to fit minCols columns
    var fontSizePx by remember { mutableFloatStateOf(30f) }

    // Clickable URL regions — populated during Canvas draw, read by tap handler.
    // Plain mutable list (not State) is safe because both draw and tap run on main thread.
    val urlRegions = remember { mutableListOf<UrlRegion>() }

    // Load Cascadia Mono from resources
    val cascadiaRegular = remember {
        ResourcesCompat.getFont(context, R.font.cascadia_mono_regular) ?: Typeface.MONOSPACE
    }
    val cascadiaBold = remember {
        ResourcesCompat.getFont(context, R.font.cascadia_mono_bold)
            ?: Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
    }

    // Paint objects — textSize updated when layout changes
    val normalPaint = remember(cascadiaRegular) {
        Paint().apply {
            typeface = cascadiaRegular
            textSize = 30f
            isAntiAlias = true
        }
    }
    val boldPaint = remember(cascadiaBold) {
        Paint().apply {
            typeface = cascadiaBold
            textSize = 30f
            isAntiAlias = true
        }
    }

    // onSizeChanged: calculate font size to fit 80 columns, then derive rows
    Canvas(
        modifier = modifier
            .onSizeChanged { size ->
                if (size.width > 0 && size.height > 0) {
                    // Binary search for the largest font size where 80 'M' chars fit
                    var lo = 8f
                    var hi = 60f
                    val probe = Paint().apply {
                        typeface = cascadiaRegular
                        isAntiAlias = true
                    }
                    while (hi - lo > 0.5f) {
                        val mid = (lo + hi) / 2f
                        probe.textSize = mid
                        val charW = probe.measureText("M")
                        if (charW * minCols <= size.width) {
                            lo = mid
                        } else {
                            hi = mid
                        }
                    }

                    fontSizePx = lo
                    normalPaint.textSize = lo
                    boldPaint.textSize = lo

                    val fm = normalPaint.fontMetrics
                    val cellH = fm.descent - fm.ascent
                    val cellW = normalPaint.measureText("M")
                    cellHeightPx = cellH

                    val cols = (size.width / cellW).toInt().coerceAtLeast(minCols)
                    val rows = (size.height / cellH).toInt().coerceAtLeast(1)

                    if (cols != gridCols || rows != gridRows) {
                        gridCols = cols
                        gridRows = rows
                        session?.updateSize(cols, rows)
                    }
                }
            }
            .pointerInput(Unit) {
                detectTapGestures { offset ->
                    val hit = urlRegions.firstOrNull { r ->
                        offset.x in r.left..r.right && offset.y in r.top..r.bottom
                    }
                    if (hit != null) {
                        val url = hit.url.trimEnd('.', ',', ';', ':', '!')
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                    }
                }
            }
            .pointerInput(Unit) {
                detectVerticalDragGestures { _, dragAmount ->
                    // Negative drag = scroll up (into history); positive = scroll down
                    scrollOffsetRows = (scrollOffsetRows - dragAmount / cellHeightPx)
                        .coerceAtLeast(0f)
                }
            }
    ) {
        // ── Force Canvas invalidation when screenVersion changes ──────
        // Without this, Compose may skip redrawing the Canvas even when
        // the composable recomposes, because the draw lambda captures no
        // State<T> objects directly.
        val ver = screenVersion // read to force Canvas invalidation

        // ── Draw background ─────────────────────────────────────────────
        drawRect(color = terminalBg)

        val emulator = session?.emulator ?: return@Canvas
        val screen: TerminalBuffer = emulator.screen ?: return@Canvas

        val fm = normalPaint.fontMetrics
        val cellH = fm.descent - fm.ascent
        val cellW = normalPaint.measureText("M")
        val baseline = -fm.ascent   // offset from top of cell to text baseline

        val totalRows = screen.getActiveRows()
        val scrollRows = scrollOffsetRows.toInt().coerceIn(0, (totalRows - gridRows).coerceAtLeast(0))

        // Clamp scroll now that we know actual buffer height
        // (we can't write state inside draw, so just use the clamped value for rendering)

        urlRegions.clear()
        val linkPaint = Paint().apply { color = LINK_COLOR.toArgb(); strokeWidth = 1.5f }

        for (rowIndex in 0 until gridRows) {
            val bufferRow = rowIndex + scrollRows
            if (bufferRow >= totalRows) break

            // allocateFullLineIfNecessary is public and returns the existing TerminalRow
            // (it only allocates if the slot is null). externalToInternalRow maps the
            // external (scroll-aware) row index to the internal circular-buffer index.
            //
            // Guard: after a resize, gridRows may exceed the buffer's mScreenRows
            // until the terminal processes the size update. Catch the resulting
            // IndexOutOfBoundsException to avoid crashing during the transient state.
            val internalRow = try {
                screen.externalToInternalRow(bufferRow)
            } catch (_: IndexOutOfBoundsException) { continue }
            val row: TerminalRow = try {
                screen.allocateFullLineIfNecessary(internalRow) ?: continue
            } catch (_: IndexOutOfBoundsException) { continue }

            val yTop = rowIndex * cellH

            // Detect URLs in this row for clickable links + visual styling
            val rowText = extractRowText(row, gridCols)
            val urlMatches = URL_PATTERN.findAll(rowText).toList()
            // Build a set of columns that are part of a URL for link coloring
            val urlCols = mutableSetOf<Int>()
            for (match in urlMatches) {
                for (c in match.range) urlCols.add(c)
                val url = match.value.trimEnd('.', ',', ';', ':', '!')
                urlRegions.add(UrlRegion(
                    url = url,
                    left = match.range.first * cellW + 4f,
                    top = yTop,
                    right = (match.range.last + 1) * cellW + 4f,
                    bottom = yTop + cellH,
                ))
            }

            var col = 0
            while (col < gridCols) {
                // findStartOfColumn gives us the char-array index for column `col`
                val charIndex = row.findStartOfColumn(col)
                val spaceUsed = row.getSpaceUsed()

                if (charIndex >= spaceUsed) {
                    col++
                    continue
                }

                val codePoint: Int
                val ch = row.mText[charIndex]
                codePoint = if (Character.isHighSurrogate(ch) && charIndex + 1 < spaceUsed) {
                    val low = row.mText[charIndex + 1]
                    if (Character.isLowSurrogate(low)) {
                        Character.toCodePoint(ch, low)
                    } else {
                        ch.code
                    }
                } else {
                    ch.code
                }

                val style: Long = row.getStyle(col)
                val fgIndex = TextStyle.decodeForeColor(style)
                val bgIndex = TextStyle.decodeBackColor(style)
                val effect = TextStyle.decodeEffect(style)

                val isBold = (effect and TextStyle.CHARACTER_ATTRIBUTE_BOLD) != 0
                val isUnderline = (effect and TextStyle.CHARACTER_ATTRIBUTE_UNDERLINE) != 0
                val isInverse = (effect and TextStyle.CHARACTER_ATTRIBUTE_INVERSE) != 0
                val isInvisible = (effect and TextStyle.CHARACTER_ATTRIBUTE_INVISIBLE) != 0

                val rawFg = resolveColor(fgIndex, DEFAULT_FG)
                val rawBg = resolveColor(bgIndex, DEFAULT_BG)

                val fgColor = if (isInverse) rawBg else rawFg
                val bgColor = if (isInverse) rawFg else rawBg

                val xLeft = col * cellW + 4f // small left margin to avoid edge clipping

                // Draw cell background only if it differs from the terminal background
                if (bgColor != terminalBg.toArgb()) {
                    val bgPaint = Paint().apply { color = bgColor }
                    drawContext.canvas.nativeCanvas.drawRect(
                        xLeft, yTop, xLeft + cellW, yTop + cellH, bgPaint
                    )
                }

                // Draw the glyph
                if (!isInvisible && codePoint != 0 && codePoint != ' '.code) {
                    val paint = if (isBold) boldPaint else normalPaint
                    paint.color = fgColor
                    val charStr = String(Character.toChars(codePoint))
                    drawContext.canvas.nativeCanvas.drawText(
                        charStr, xLeft, yTop + baseline, paint
                    )

                    // Underline: draw a line 1px below the baseline
                    if (isUnderline) {
                        val ulPaint = Paint().apply {
                            color = fgColor
                            strokeWidth = 1f
                        }
                        drawContext.canvas.nativeCanvas.drawLine(
                            xLeft, yTop + baseline + 2f,
                            xLeft + cellW, yTop + baseline + 2f,
                            ulPaint
                        )
                    }
                }

                col++
            }
        }
    }
}
