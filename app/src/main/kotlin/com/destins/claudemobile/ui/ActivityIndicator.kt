package com.destins.claudemobile.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
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
        val dotCount by produceState(initialValue = 1) {
            while (true) {
                delay(400)
                value = (value % 3) + 1
            }
        }

        Text(
            text = "$line${".".repeat(dotCount)}",
            fontSize = 13.sp,
            color = ClaudeMobileTheme.extended.textSecondary,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
        )
    }
}
