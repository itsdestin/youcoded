package com.destins.claudemobile.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

object AppIcons {
    /**
     * Terminal icon — Claude-ified Windows Terminal style.
     * A rounded rectangle with ">_" prompt inside, with the ">"
     * rendered at a slightly playful angle.
     */
    val Terminal: ImageVector by lazy {
        ImageVector.Builder(
            name = "Terminal",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f
        ).apply {
            // Outer rounded rectangle
            path(
                fill = null,
                stroke = SolidColor(Color.White),
                strokeLineWidth = 1.8f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            ) {
                moveTo(4f, 4f)
                lineTo(20f, 4f)
                arcTo(2f, 2f, 0f, false, true, 22f, 6f)
                lineTo(22f, 18f)
                arcTo(2f, 2f, 0f, false, true, 20f, 20f)
                lineTo(4f, 20f)
                arcTo(2f, 2f, 0f, false, true, 2f, 18f)
                lineTo(2f, 6f)
                arcTo(2f, 2f, 0f, false, true, 4f, 4f)
                close()
            }
            // ">" chevron prompt
            path(
                fill = null,
                stroke = SolidColor(Color.White),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            ) {
                moveTo(6f, 9f)
                lineTo(10f, 12f)
                lineTo(6f, 15f)
            }
            // "_" cursor underscore
            path(
                fill = null,
                stroke = SolidColor(Color.White),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
            ) {
                moveTo(12f, 15f)
                lineTo(17f, 15f)
            }
        }.build()
    }

    /**
     * Chat icon — speech bubble with three dots.
     * Simple rounded bubble with tail and dots inside.
     */
    val Chat: ImageVector by lazy {
        ImageVector.Builder(
            name = "Chat",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f
        ).apply {
            // Speech bubble outline with tail
            path(
                fill = null,
                stroke = SolidColor(Color.White),
                strokeLineWidth = 1.8f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            ) {
                // Rounded rectangle bubble
                moveTo(4f, 5f)
                lineTo(20f, 5f)
                arcTo(2f, 2f, 0f, false, true, 22f, 7f)
                lineTo(22f, 15f)
                arcTo(2f, 2f, 0f, false, true, 20f, 17f)
                lineTo(10f, 17f)
                lineTo(6f, 20f)
                lineTo(7f, 17f)
                lineTo(4f, 17f)
                arcTo(2f, 2f, 0f, false, true, 2f, 15f)
                lineTo(2f, 7f)
                arcTo(2f, 2f, 0f, false, true, 4f, 5f)
                close()
            }
            // Three dots — drawn as short thick lines (more reliable than arcs)
            path(
                fill = null,
                stroke = SolidColor(Color.White),
                strokeLineWidth = 2.5f,
                strokeLineCap = StrokeCap.Round,
            ) {
                moveTo(8.5f, 11f)
                lineTo(8.5f, 11.01f)
            }
            path(
                fill = null,
                stroke = SolidColor(Color.White),
                strokeLineWidth = 2.5f,
                strokeLineCap = StrokeCap.Round,
            ) {
                moveTo(12f, 11f)
                lineTo(12f, 11.01f)
            }
            path(
                fill = null,
                stroke = SolidColor(Color.White),
                strokeLineWidth = 2.5f,
                strokeLineCap = StrokeCap.Round,
            ) {
                moveTo(15.5f, 11f)
                lineTo(15.5f, 11.01f)
            }
        }.build()
    }
}
