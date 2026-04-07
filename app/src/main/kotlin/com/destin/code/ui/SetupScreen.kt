package com.destin.code.ui

import android.view.WindowManager
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destin.code.runtime.Bootstrap
import kotlinx.coroutines.delay

private val spinnerFrames = charArrayOf('⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏')

private val spinnerColors = listOf(
    Color(0xFFB0B0B0),
    Color(0xFFD0D0D0),
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
    // Keep screen on during setup — release when composable leaves
    val view = LocalView.current
    DisposableEffect(Unit) {
        view.keepScreenOn = true
        onDispose { view.keepScreenOn = false }
    }

    // Smooth progress: targetProgress tracks the backend; displayProgress animates toward it.
    var targetProgress by remember { mutableFloatStateOf(0f) }
    var displayProgress by remember { mutableFloatStateOf(0f) }
    val realPercent = when (progress) {
        is Bootstrap.Progress.Extracting -> progress.percent
        is Bootstrap.Progress.Installing -> if (progress.overallPercent >= 0) progress.overallPercent else -1
        else -> -1
    }

    // Update target when backend reports higher progress
    LaunchedEffect(realPercent) {
        val t = if (realPercent >= 0) realPercent / 100f else -1f
        if (t >= 0 && t > targetProgress) {
            targetProgress = t
        }
    }

    // Smoothly animate displayProgress toward targetProgress at ~20fps.
    // Between real updates, creep forward slowly so the bar never looks frozen.
    LaunchedEffect(Unit) {
        while (true) {
            delay(50)
            val target = targetProgress
            val current = displayProgress
            if (current < target) {
                // Close 12% of the remaining gap per tick (smooth ease-out)
                val step = ((target - current) * 0.12f).coerceAtLeast(0.002f)
                displayProgress = (current + step).coerceAtMost(target)
            } else if (current in 0.001f..0.95f) {
                // Creep forward between backend updates so the bar stays alive
                val remaining = 0.95f - current
                val creep = (remaining * 0.001f).coerceAtLeast(0.0002f)
                displayProgress = (current + creep).coerceAtMost(0.95f)
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(
            text = "DestinCode",
            style = MaterialTheme.typography.headlineLarge,
            color = MaterialTheme.colorScheme.primary
        )
        Spacer(modifier = Modifier.height(32.dp))

        when (progress) {
            is Bootstrap.Progress.Extracting -> {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    SetupSpinner()
                    Text(
                        "Setting up environment",
                        fontSize = 14.sp,
                        color = Color(0xFF999999),
                    )
                }
                Spacer(modifier = Modifier.height(16.dp))
                LinearProgressIndicator(
                    progress = { displayProgress },
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    "${(displayProgress * 100).toInt()}%",
                    style = MaterialTheme.typography.bodySmall,
                    color = Color(0xFF999999),
                )
            }
            is Bootstrap.Progress.Installing -> {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    SetupSpinner()
                    Text(
                        progress.packageName,
                        fontSize = 14.sp,
                        color = Color(0xFF999999),
                    )
                }
                Spacer(modifier = Modifier.height(16.dp))
                if (progress.overallPercent >= 0) {
                    LinearProgressIndicator(
                        progress = { displayProgress },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        "${(displayProgress * 100).toInt()}%",
                        style = MaterialTheme.typography.bodySmall,
                        color = Color(0xFF999999),
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
            is Bootstrap.Progress.TierUpgradeComplete -> {
                Text(
                    "Packages installed",
                    fontSize = 16.sp,
                    fontWeight = androidx.compose.ui.text.font.FontWeight.Bold,
                    color = MaterialTheme.colorScheme.secondary,
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    "${progress.tierName} tier is ready",
                    fontSize = 14.sp,
                    color = Color(0xFF999999),
                )
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
                    color = Color(0xFF999999),
                )
            }
        }
    }
}
