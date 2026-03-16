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

@Composable
fun ActivityIndicator(
    isActive: Boolean,
    toolName: String?,
    modifier: Modifier = Modifier,
) {
    AnimatedVisibility(
        visible = isActive,
        enter = fadeIn(),
        exit = fadeOut(),
        modifier = modifier,
    ) {
        val dotCount by produceState(initialValue = 1) {
            while (true) {
                delay(400)
                value = (value % 3) + 1
            }
        }
        val dots = ".".repeat(dotCount)
        val label = when {
            toolName != null -> "${friendlyToolName(toolName)}$dots"
            else -> "Working$dots"
        }

        Text(
            text = label,
            fontSize = 13.sp,
            color = ClaudeMobileTheme.extended.textSecondary,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
        )
    }
}

private fun friendlyToolName(tool: String): String = when (tool) {
    "Read" -> "Reading"
    "Write" -> "Writing"
    "Edit" -> "Editing"
    "Bash" -> "Running command"
    "Glob" -> "Searching files"
    "Grep" -> "Searching"
    "Agent" -> "Running agent"
    "WebSearch" -> "Searching web"
    "WebFetch" -> "Fetching"
    "Skill" -> "Using skill"
    else -> "Working"
}
