package com.destins.claudemobile

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import com.destins.claudemobile.runtime.Bootstrap
import com.destins.claudemobile.runtime.ServiceBinder
import com.destins.claudemobile.ui.ChatScreen
import com.destins.claudemobile.ui.SetupScreen
import com.destins.claudemobile.ui.theme.ClaudeMobileTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Draw behind system bars, then handle insets in Compose
        enableEdgeToEdge()

        val bootstrap = Bootstrap(applicationContext)

        setContent {
            ClaudeMobileTheme {
                // Respect status bar, nav bar, and IME (keyboard) insets
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background,
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .statusBarsPadding()
                            .navigationBarsPadding()
                            .imePadding()
                    ) {
                        var isReady by remember { mutableStateOf(bootstrap.isBootstrapped) }
                        var progress by remember { mutableStateOf<Bootstrap.Progress?>(null) }

                        if (!isReady) {
                            var setupAttempt by remember { mutableIntStateOf(0) }
                            SetupScreen(
                                progress = progress,
                                onRetry = {
                                    progress = null
                                    setupAttempt++
                                },
                            )
                            LaunchedEffect(setupAttempt) {
                                bootstrap.setup { p ->
                                    progress = p
                                    if (p is Bootstrap.Progress.Complete) {
                                        isReady = true
                                    }
                                }
                            }
                        } else {
                            val serviceBinder = remember { ServiceBinder(applicationContext) }
                            val serviceState by serviceBinder.state.collectAsState()
                            val coroutineScope = rememberCoroutineScope()

                            DisposableEffect(Unit) {
                                serviceBinder.bind()
                                onDispose { serviceBinder.unbind() }
                            }

                            when (serviceState) {
                                is ServiceBinder.SessionState.Connected -> {
                                    val svc = (serviceState as ServiceBinder.SessionState.Connected).service

                                    // Auto-create first session if none exist
                                    LaunchedEffect(svc) {
                                        if (svc.sessionRegistry.sessionCount == 0) {
                                            svc.initBootstrap(bootstrap)
                                            svc.createSession(bootstrap.homeDir, dangerousMode = false, apiKey = null)
                                        }
                                    }

                                    // Handle intent session_id from notification tap
                                    LaunchedEffect(Unit) {
                                        val targetSessionId = intent?.getStringExtra("session_id")
                                        if (targetSessionId != null) {
                                            svc.sessionRegistry.switchTo(targetSessionId)
                                            intent?.removeExtra("session_id")
                                        }
                                    }

                                    // Temporary: pass first session's bridge until Task 10 refactors ChatScreen
                                    val currentSession = svc.sessionRegistry.getCurrentSession()
                                    if (currentSession != null) {
                                        ChatScreen(currentSession.ptyBridge)
                                    }
                                }
                                is ServiceBinder.SessionState.Error -> {
                                    val error = (serviceState as ServiceBinder.SessionState.Error).message
                                    Column(
                                        modifier = Modifier
                                            .fillMaxSize()
                                            .padding(32.dp),
                                        verticalArrangement = Arrangement.Center,
                                        horizontalAlignment = Alignment.CenterHorizontally
                                    ) {
                                        Text("Error: $error", color = MaterialTheme.colorScheme.error)
                                        Spacer(modifier = Modifier.height(16.dp))
                                        Button(onClick = {
                                            coroutineScope.launch {
                                                serviceBinder.startService(bootstrap)
                                            }
                                        }) {
                                            Text("Retry")
                                        }
                                    }
                                }
                                else -> {
                                    LaunchedEffect(Unit) {
                                        serviceBinder.startService(bootstrap)
                                    }
                                    SetupScreen(Bootstrap.Progress.Installing("Claude Code session"))
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
    }
}
