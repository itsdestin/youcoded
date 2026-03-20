package com.destin.code.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.destin.code.R

data class ExtendedColors(
    val surfaceBorder: Color = Color(0xFF333333),
    val textSecondary: Color = Color(0xFF999999),
    val terminalBg: Color = Color(0xFF0A0A0A),
)

val LocalExtendedColors = staticCompositionLocalOf { ExtendedColors() }

/** Whether the app is currently using dark theme. */
val LocalIsDarkTheme = staticCompositionLocalOf { true }

/** Callback to toggle between dark and light theme. */
val LocalToggleTheme = staticCompositionLocalOf<() -> Unit> { {} }

val CascadiaMono = FontFamily(
    Font(R.font.cascadia_mono_regular, FontWeight.Normal),
    Font(R.font.cascadia_mono_bold, FontWeight.Bold),
)

private val DarkColorScheme = darkColorScheme(
    primary = Color(0xFFB0B0B0),
    onPrimary = Color.White,
    secondary = Color(0xFFB0B0B0),
    background = Color(0xFF111111),
    surface = Color(0xFF1C1C1C),
    onBackground = Color(0xFFE0E0E0),
    onSurface = Color(0xFFE0E0E0),
    error = Color(0xFFDD4444),
    onError = Color.White,
)

private val DarkExtendedColors = ExtendedColors(
    surfaceBorder = Color(0xFF333333),
    textSecondary = Color(0xFF999999),
    terminalBg = Color(0xFF0A0A0A),
)

private val LightColorScheme = lightColorScheme(
    primary = Color(0xFF555555),
    onPrimary = Color.White,
    secondary = Color(0xFF555555),
    background = Color(0xFFF5F5F5),
    surface = Color(0xFFFFFFFF),
    onBackground = Color(0xFF1A1A1A),
    onSurface = Color(0xFF1A1A1A),
    error = Color(0xFFCC3333),
    onError = Color.White,
)

private val LightExtendedColors = ExtendedColors(
    surfaceBorder = Color(0xFFD0D0D0),
    textSecondary = Color(0xFF777777),
    terminalBg = Color(0xFFF0F0F0),
)

// App-wide typography using Cascadia Mono
private val AppTypography = Typography(
    displayLarge = TextStyle(fontFamily = CascadiaMono),
    displayMedium = TextStyle(fontFamily = CascadiaMono),
    displaySmall = TextStyle(fontFamily = CascadiaMono),
    headlineLarge = TextStyle(fontFamily = CascadiaMono),
    headlineMedium = TextStyle(fontFamily = CascadiaMono),
    headlineSmall = TextStyle(fontFamily = CascadiaMono),
    titleLarge = TextStyle(fontFamily = CascadiaMono, fontSize = 20.sp, fontWeight = FontWeight.Bold),
    titleMedium = TextStyle(fontFamily = CascadiaMono, fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
    titleSmall = TextStyle(fontFamily = CascadiaMono, fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
    bodyLarge = TextStyle(fontFamily = CascadiaMono, fontSize = 16.sp),
    bodyMedium = TextStyle(fontFamily = CascadiaMono, fontSize = 14.sp),
    bodySmall = TextStyle(fontFamily = CascadiaMono, fontSize = 12.sp),
    labelLarge = TextStyle(fontFamily = CascadiaMono, fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
    labelMedium = TextStyle(fontFamily = CascadiaMono, fontSize = 12.sp),
    labelSmall = TextStyle(fontFamily = CascadiaMono, fontSize = 11.sp),
)

@Composable
fun DestinCodeTheme(
    darkTheme: Boolean = true,
    onToggleTheme: () -> Unit = {},
    content: @Composable () -> Unit,
) {
    val colorScheme = if (darkTheme) DarkColorScheme else LightColorScheme
    val extendedColors = if (darkTheme) DarkExtendedColors else LightExtendedColors

    androidx.compose.runtime.CompositionLocalProvider(
        LocalExtendedColors provides extendedColors,
        LocalIsDarkTheme provides darkTheme,
        LocalToggleTheme provides onToggleTheme,
    ) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = AppTypography,
            content = content
        )
    }
}

object DestinCodeTheme {
    val extended: ExtendedColors
        @Composable
        @ReadOnlyComposable
        get() = LocalExtendedColors.current
}
