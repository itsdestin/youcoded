package com.destins.claudemobile.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destins.claudemobile.ui.theme.ClaudeMobileTheme
import kotlinx.coroutines.delay

private val thinkingLines = listOf(
    "Thinking",
    "Cogitating",
    "Pondering",
    "Ruminating",
    "Noodling",
    "Percolating",
    "Brainstorming",
    "Deliberating",
    "Marinating",
    "Musing",
    "Contemplating",
    "Stewing",
    "Mulling it over",
    "Chewing on it",
    "Untangling",
    "Connecting dots",
    "Rearranging neurons",
    "Consulting the vibes",
    "Findangling",
    "Embellishing",
    "Simmering",
    "Calibrating",
)

// Braille spinner frames — same as Claude Code CLI
private val spinnerFrames = charArrayOf('⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏')

// Rotating accent colors for the spinner
private val spinnerColors = listOf(
    Color(0xFFc96442), // sienna (Claude accent)
    Color(0xFFe8a87c), // warm peach
    Color(0xFF85c1e9), // soft blue
    Color(0xFFa8d8a8), // soft green
    Color(0xFFd4a5d4), // soft purple
)

@Composable
fun ActivityIndicator(
    isActive: Boolean,
    modifier: Modifier = Modifier,
) {
    AnimatedVisibility(
        visible = isActive,
        enter = fadeIn(),
        exit = fadeOut(),
        modifier = modifier,
    ) {
        val line by produceState(initialValue = thinkingLines.random()) {
            while (true) {
                delay(2500)
                value = thinkingLines.random()
            }
        }
        val spinnerIndex by produceState(initialValue = 0) {
            while (true) {
                delay(80)
                value = (value + 1) % spinnerFrames.size
            }
        }
        val colorIndex by produceState(initialValue = 0) {
            while (true) {
                delay(600)
                value = (value + 1) % spinnerColors.size
            }
        }

        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
        ) {
            Text(
                text = buildAnnotatedString {
                    withStyle(SpanStyle(color = spinnerColors[colorIndex])) {
                        append(spinnerFrames[spinnerIndex])
                    }
                },
                fontSize = 15.sp,
            )
            Spacer(Modifier.width(8.dp))
            Text(
                text = line,
                fontSize = 13.sp,
                color = ClaudeMobileTheme.extended.textSecondary,
            )
        }
    }
}
