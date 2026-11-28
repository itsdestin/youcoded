package com.youcoded.app.ui

import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.youcoded.app.R
import kotlinx.coroutines.delay

/**
 * The phone's own loading screens ("Setting up YouCoded…", "Unpacking the assistant…", "Starting the assistant…"),
 * shown before the page exists.
 *
 * WHY (Destin, 2026-11-01: "make the starting/unpacking screens match brand styling, and use our braille spinners"):
 * they were a grey Material spinner on the dark default theme, the one surface of the app that looked like a different
 * product. This draws the setup screen's brand surface instead — the same colours, Outfit and wordmark as
 * desktop/src/renderer/styles/brand.css and components/brand/BrandLockup.tsx — with the app's own braille spinner
 * (components/BrailleSpinner.tsx: the same ten frames every 80 ms, the colour stepping every 600 ms). These are the
 * brand's fixed colours, not theme tokens: no theme is known yet at this point.
 */

private val Outfit = FontFamily(
    Font(R.font.outfit_medium, FontWeight.Medium),
    Font(R.font.outfit_semibold, FontWeight.SemiBold),
)

// brand.css: --canvas, the name's ink and gradient, the tagline, --fg-muted.
private val Canvas = Color(0xFFF4ECF8)
private val Ink = Color(0xFF21152C)
private val GradientFrom = Color(0xFF9D5BD0)
private val GradientTo = Color(0xFFD25AA0)
private val Tagline = Color(0xFF8A7B96)
private val Muted = Color(0xFF6B5D78)

private val FRAMES = listOf("⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏")
// The brand's own purples and pink in place of the theme colours the in-app spinner cycles.
private val SPINNER_COLORS = listOf(Color(0xFF8B47B8), GradientTo, GradientFrom, Muted)

@Composable
fun BrandLoadingScreen(message: String) {
    Box(
        Modifier
            .fillMaxSize()
            .background(Canvas)
            // brand.css .brand-surface: a pale glow at the top, a pink one bottom right, a purple one bottom left.
            .drawBehind {
                val w = size.width; val h = size.height
                drawRect(Brush.radialGradient(listOf(Color(0xFFFBF6FD), Color(0x00FBF6FD)), Offset(w * 0.5f, 0f), w * 0.75f))
                drawRect(Brush.radialGradient(listOf(Color(0x1AD25AA0), Color(0x00D25AA0)), Offset(w * 0.85f, h), w * 0.65f))
                drawRect(Brush.radialGradient(listOf(Color(0x1F9D5BD0), Color(0x009D5BD0)), Offset(w * 0.1f, h * 0.9f), w * 0.65f))
            },
        contentAlignment = Alignment.Center,
    ) {
        Column(Modifier.padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            Wordmark()
            Spacer(Modifier.height(40.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                BrailleSpinner()
                Spacer(Modifier.width(10.dp))
                Text(message, color = Muted, textAlign = TextAlign.Center,
                    style = TextStyle(fontFamily = Outfit, fontWeight = FontWeight.Medium, fontSize = 16.sp))
            }
        }
    }
}

/** BrandLockup.tsx's BrandWordmark with the tagline stacked: "youcoded", "you" in the purple-to-pink gradient. */
@Composable
private fun Wordmark() {
    Column(Modifier.semantics { contentDescription = "YouCoded" }, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(
            buildAnnotatedString {
                withStyle(SpanStyle(brush = Brush.linearGradient(listOf(GradientFrom, GradientTo)))) { append("you") }
                append("coded")
            },
            color = Ink,
            style = TextStyle(fontFamily = Outfit, fontWeight = FontWeight.SemiBold, fontSize = 44.sp, letterSpacing = (-0.035).em),
        )
        Text(
            "open source everything",
            color = Tagline,
            modifier = Modifier.offset(y = (-4).dp),
            style = TextStyle(fontFamily = Outfit, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, letterSpacing = (-0.005).em),
        )
    }
}

@Composable
private fun BrailleSpinner() {
    // Reduced motion: the phone's "Remove animations" sets the animator scale to 0; then one still frame.
    val context = LocalContext.current
    val still = remember {
        runCatching { Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) }.getOrDefault(1f) == 0f
    }
    var tick by remember { mutableIntStateOf(0) }
    LaunchedEffect(still) {
        if (still) return@LaunchedEffect
        while (true) { delay(80); tick++ }
    }
    Text(
        FRAMES[tick % FRAMES.size],
        color = SPINNER_COLORS[(tick * 80 / 600) % SPINNER_COLORS.size],
        style = TextStyle(fontWeight = FontWeight.Bold, fontSize = 20.sp),
    )
}
