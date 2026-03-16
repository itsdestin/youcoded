package com.destins.claudemobile.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

data class ExtendedColors(
    val surfaceBorder: Color = Color(0xFF333333),
    val textSecondary: Color = Color(0xFF999999),
    val terminalBg: Color = Color(0xFF0A0A0A),
)

val LocalExtendedColors = staticCompositionLocalOf { ExtendedColors() }

private val DarkColorScheme = darkColorScheme(
    primary = Color(0xFFC96442),
    onPrimary = Color.White,
    secondary = Color(0xFFC96442),
    background = Color(0xFF111111),
    surface = Color(0xFF1C1C1C),
    onBackground = Color(0xFFE8E0D8),
    onSurface = Color(0xFFE8E0D8),
    error = Color(0xFFDD4444),
    onError = Color.White,
)

@Composable
fun ClaudeMobileTheme(content: @Composable () -> Unit) {
    androidx.compose.runtime.CompositionLocalProvider(
        LocalExtendedColors provides ExtendedColors()
    ) {
        MaterialTheme(
            colorScheme = DarkColorScheme,
            content = content
        )
    }
}

object ClaudeMobileTheme {
    val extended: ExtendedColors
        @Composable
        @ReadOnlyComposable
        get() = LocalExtendedColors.current
}
