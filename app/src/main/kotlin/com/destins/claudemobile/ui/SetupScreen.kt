package com.destins.claudemobile.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destins.claudemobile.runtime.Bootstrap
import com.destins.claudemobile.ui.theme.ClaudeMobileTheme
import kotlinx.coroutines.delay

// Braille spinner frames — same as Claude Code CLI
private val spinnerFrames = charArrayOf('⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏')

private val spinnerColors = listOf(
    Color(0xFFc96442),
    Color(0xFFe8a87c),
    Color(0xFF85c1e9),
    Color(0xFFa8d8a8),
    Color(0xFFd4a5d4),
)

@Composable
private fun SetupSpinner() {
    val spinnerIndex by produceState(initialValue = 0) {
        while (true) { delay(80); value = (value + 1) % spinnerFrames.size }
    }
    val colorIndex by produceState(initialValue = 0) {
        while (true) { delay(600); value = (value + 1) % spinnerColors.size }
    }
    Text(
        text = buildAnnotatedString {
            withStyle(SpanStyle(color = spinnerColors[colorIndex])) {
                append(spinnerFrames[spinnerIndex])
            }
        },
        fontSize = 18.sp,
    )
}

@Composable
fun SetupScreen(progress: Bootstrap.Progress?, onRetry: (() -> Unit)? = null) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(
            text = "Claude Mobile",
            style = MaterialTheme.typography.headlineLarge,
            color = MaterialTheme.colorScheme.primary
        )
        Spacer(modifier = Modifier.height(32.dp))

        when (progress) {
            is Bootstrap.Progress.Extracting -> {
                val targetProgress = progress.percent / 100f
                val animatedProgress by animateFloatAsState(
                    targetValue = targetProgress,
                    animationSpec = tween(durationMillis = 800),
                    label = "extractProgress",
                )
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    SetupSpinner()
                    Text(
                        "Setting up environment",
                        fontSize = 14.sp,
                        color = ClaudeMobileTheme.extended.textSecondary,
                    )
                }
                Spacer(modifier = Modifier.height(16.dp))
                LinearProgressIndicator(
                    progress = { animatedProgress },
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    "${progress.percent}%",
                    style = MaterialTheme.typography.bodySmall,
                    color = ClaudeMobileTheme.extended.textSecondary,
                )
            }
            is Bootstrap.Progress.Installing -> {
                val targetProgress = if (progress.overallPercent >= 0) progress.overallPercent / 100f else 0f
                val animatedProgress by animateFloatAsState(
                    targetValue = targetProgress,
                    animationSpec = tween(durationMillis = 1200),
                    label = "installProgress",
                )
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    SetupSpinner()
                    Text(
                        progress.packageName,
                        fontSize = 14.sp,
                        color = ClaudeMobileTheme.extended.textSecondary,
                    )
                }
                Spacer(modifier = Modifier.height(16.dp))
                if (progress.overallPercent >= 0) {
                    LinearProgressIndicator(
                        progress = { animatedProgress },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        "${progress.overallPercent}%",
                        style = MaterialTheme.typography.bodySmall,
                        color = ClaudeMobileTheme.extended.textSecondary,
                    )
                } else {
                    LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                }
            }
            is Bootstrap.Progress.Error -> {
                Text(
                    "Setup failed: ${progress.message}",
                    color = MaterialTheme.colorScheme.error
                )
                Spacer(modifier = Modifier.height(16.dp))
                Button(onClick = { onRetry?.invoke() }) {
                    Text("Retry")
                }
            }
            is Bootstrap.Progress.Complete -> {
                Text("Ready!", color = MaterialTheme.colorScheme.secondary)
            }
            null -> {
                SetupSpinner()
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    "Checking environment",
                    fontSize = 14.sp,
                    color = ClaudeMobileTheme.extended.textSecondary,
                )
            }
        }
    }
}
