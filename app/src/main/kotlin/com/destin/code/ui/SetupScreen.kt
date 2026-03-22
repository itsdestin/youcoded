package com.destin.code.ui

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
import com.destin.code.runtime.Bootstrap
import com.destin.code.ui.theme.DestinCodeTheme
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
    // Single smooth progress state that persists across Extracting → Installing transitions
    var displayProgress by remember { mutableFloatStateOf(0f) }
    val realPercent = when (progress) {
        is Bootstrap.Progress.Extracting -> progress.percent
        is Bootstrap.Progress.Installing -> if (progress.overallPercent >= 0) progress.overallPercent else -1
        else -> -1
    }
    val realTarget = if (realPercent >= 0) realPercent / 100f else -1f

    // Snap forward when real progress jumps ahead
    LaunchedEffect(realTarget) {
        if (realTarget >= 0 && realTarget > displayProgress) {
            displayProgress = realTarget
        }
    }

    // Creep forward slowly between real updates — never exceeds 95%
    LaunchedEffect(Unit) {
        while (true) {
            delay(500)
            val current = displayProgress
            val ceiling = 0.95f
            if (current in 0.001f..ceiling) {
                val remaining = ceiling - current
                val increment = (remaining * 0.003f).coerceAtLeast(0.0005f)
                displayProgress = (current + increment).coerceAtMost(ceiling)
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
                        color = DestinCodeTheme.extended.textSecondary,
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
                    color = DestinCodeTheme.extended.textSecondary,
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
                        color = DestinCodeTheme.extended.textSecondary,
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
                        color = DestinCodeTheme.extended.textSecondary,
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
                    color = DestinCodeTheme.extended.textSecondary,
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
                    color = DestinCodeTheme.extended.textSecondary,
                )
            }
        }
    }
}
