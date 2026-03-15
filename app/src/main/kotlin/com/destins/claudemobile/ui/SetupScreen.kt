package com.destins.claudemobile.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.destins.claudemobile.runtime.Bootstrap

@Composable
fun SetupScreen(progress: Bootstrap.Progress?) {
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
                Text("Setting up environment...")
                Spacer(modifier = Modifier.height(16.dp))
                LinearProgressIndicator(
                    progress = { progress.percent / 100f },
                    modifier = Modifier.fillMaxWidth()
                )
                Text("${progress.percent}%", style = MaterialTheme.typography.bodySmall)
            }
            is Bootstrap.Progress.Installing -> {
                Text("Installing ${progress.packageName}...")
                Spacer(modifier = Modifier.height(16.dp))
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            }
            is Bootstrap.Progress.Error -> {
                Text(
                    "Setup failed: ${progress.message}",
                    color = MaterialTheme.colorScheme.error
                )
                Spacer(modifier = Modifier.height(16.dp))
                Button(onClick = { /* retry handled by MainActivity */ }) {
                    Text("Retry")
                }
            }
            is Bootstrap.Progress.Complete -> {
                Text("Ready!", color = MaterialTheme.colorScheme.secondary)
            }
            null -> {
                CircularProgressIndicator()
                Text("Checking environment...")
            }
        }
    }
}
