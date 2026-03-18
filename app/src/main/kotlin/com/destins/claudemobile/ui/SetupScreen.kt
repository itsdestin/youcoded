package com.destins.claudemobile.ui

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

/**
 * Smooth progress that creeps forward between real updates.
 * When a real update arrives, it jumps to the new value and resumes creeping.
 * Creep speed slows as it approaches the next expected milestone to avoid overshooting.
 */
@Composable
private fun SmoothProgress(targetPercent: Int): Float {
    var displayProgress by remember { mutableFloatStateOf(0f) }
    val target = targetPercent / 100f

    LaunchedEffect(target) {
        // Snap forward if real progress jumped ahead of our creep
        if (target > displayProgress) {
            displayProgress = target
        }
    }

    // Creep forward slowly between real updates
    LaunchedEffect(Unit) {
        while (true) {
            delay(200)
            val current = displayProgress
            // Creep toward 95% max (never reach 100% on our own)
            val ceiling = 0.95f
            if (current < ceiling) {
                // Slow down as we get further from last real update
                // This gives a nice deceleration curve
                val remaining = ceiling - current
                val increment = (remaining * 0.008f).coerceAtLeast(0.001f)
                displayProgress = (current + increment).coerceAtMost(ceiling)
            }
        }
    }

    return displayProgress
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
                val smoothProgress = SmoothProgress(progress.percent)
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
                    progress = { smoothProgress },
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    "${(smoothProgress * 100).toInt()}%",
                    style = MaterialTheme.typography.bodySmall,
                    color = ClaudeMobileTheme.extended.textSecondary,
                )
            }
            is Bootstrap.Progress.Installing -> {
                val smoothProgress = SmoothProgress(
                    if (progress.overallPercent >= 0) progress.overallPercent else 0
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
                        progress = { smoothProgress },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        "${(smoothProgress * 100).toInt()}%",
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
