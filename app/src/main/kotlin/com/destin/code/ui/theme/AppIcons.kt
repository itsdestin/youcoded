package com.destin.code.ui.theme

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
     * Terminal icon — Windows Terminal style.
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
                stroke = SolidColor(Color.Black),
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
                stroke = SolidColor(Color.Black),
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
                stroke = SolidColor(Color.Black),
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
                stroke = SolidColor(Color.Black),
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
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2.5f,
                strokeLineCap = StrokeCap.Round,
            ) {
                moveTo(8.5f, 11f)
                lineTo(8.5f, 11.01f)
            }
            path(
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2.5f,
                strokeLineCap = StrokeCap.Round,
            ) {
                moveTo(12f, 11f)
                lineTo(12f, 11.01f)
            }
            path(
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2.5f,
                strokeLineCap = StrokeCap.Round,
            ) {
                moveTo(15.5f, 11f)
                lineTo(15.5f, 11.01f)
            }
        }.build()
    }

    /**
     * App icon — squat rounded character with >< eyes, nub arms, stubby legs.
     * Body + eyes use EvenOdd so eyes are cutouts (works with Icon tint).
     * Arms and legs are separate filled paths.
     */
    val AppIcon: ImageVector by lazy {
        ImageVector.Builder(
            name = "AppIcon",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f
        ).apply {
            // Body with eye cutouts (EvenOdd)
            path(
                fill = SolidColor(Color.Black),
                stroke = null,
                pathFillType = PathFillType.EvenOdd,
            ) {
                // Rounded rect body: x=5, y=4, w=14, h=12, rx=4
                moveTo(9f, 4f)
                lineTo(15f, 4f)
                arcTo(4f, 4f, 0f, false, true, 19f, 8f)
                lineTo(19f, 12f)
                arcTo(4f, 4f, 0f, false, true, 15f, 16f)
                lineTo(9f, 16f)
                arcTo(4f, 4f, 0f, false, true, 5f, 12f)
                lineTo(5f, 8f)
                arcTo(4f, 4f, 0f, false, true, 9f, 4f)
                close()

                // Left eye > (cutout)
                moveTo(8.5f, 8f)
                lineTo(10.5f, 10f)
                lineTo(8.5f, 12f)
                lineTo(9.5f, 12f)
                lineTo(11.5f, 10f)
                lineTo(9.5f, 8f)
                close()

                // Right eye < (cutout)
                moveTo(15.5f, 8f)
                lineTo(13.5f, 10f)
                lineTo(15.5f, 12f)
                lineTo(14.5f, 12f)
                lineTo(12.5f, 10f)
                lineTo(14.5f, 8f)
                close()
            }
            // Left nub arm (air gap — 1 unit from body)
            path(fill = SolidColor(Color.Black)) {
                moveTo(1.8f, 9f)
                lineTo(3.2f, 9f)
                arcTo(0.8f, 0.8f, 0f, false, true, 4f, 9.8f)
                lineTo(4f, 12.2f)
                arcTo(0.8f, 0.8f, 0f, false, true, 3.2f, 13f)
                lineTo(1.8f, 13f)
                arcTo(0.8f, 0.8f, 0f, false, true, 1f, 12.2f)
                lineTo(1f, 9.8f)
                arcTo(0.8f, 0.8f, 0f, false, true, 1.8f, 9f)
                close()
            }
            // Right nub arm (air gap — 1 unit from body)
            path(fill = SolidColor(Color.Black)) {
                moveTo(20.8f, 9f)
                lineTo(22.2f, 9f)
                arcTo(0.8f, 0.8f, 0f, false, true, 23f, 9.8f)
                lineTo(23f, 12.2f)
                arcTo(0.8f, 0.8f, 0f, false, true, 22.2f, 13f)
                lineTo(20.8f, 13f)
                arcTo(0.8f, 0.8f, 0f, false, true, 20f, 12.2f)
                lineTo(20f, 9.8f)
                arcTo(0.8f, 0.8f, 0f, false, true, 20.8f, 9f)
                close()
            }
            // Left stubby leg (rx=1.75)
            path(fill = SolidColor(Color.Black)) {
                moveTo(8.75f, 16f)
                lineTo(10.5f, 16f)
                lineTo(10.5f, 18.25f)
                arcTo(1.75f, 1.75f, 0f, false, true, 8.75f, 20f)
                lineTo(8.75f, 20f)
                arcTo(1.75f, 1.75f, 0f, false, true, 7f, 18.25f)
                lineTo(7f, 16f)
                close()
            }
            // Right stubby leg (rx=1.75)
            path(fill = SolidColor(Color.Black)) {
                moveTo(15.25f, 16f)
                lineTo(17f, 16f)
                lineTo(17f, 18.25f)
                arcTo(1.75f, 1.75f, 0f, false, true, 15.25f, 20f)
                lineTo(15.25f, 20f)
                arcTo(1.75f, 1.75f, 0f, false, true, 13.5f, 18.25f)
                lineTo(13.5f, 16f)
                close()
            }
        }.build()
    }
}
