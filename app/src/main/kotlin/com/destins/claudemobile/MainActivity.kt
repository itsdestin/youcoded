package com.destins.claudemobile

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
import com.destins.claudemobile.runtime.SessionManager
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
                            SetupScreen(progress)
                            LaunchedEffect(Unit) {
                                bootstrap.setup { p ->
                                    progress = p
                                    if (p is Bootstrap.Progress.Complete) {
                                        isReady = true
                                    }
                                }
                            }
                        } else {
                            val sessionManager = remember { SessionManager(applicationContext) }
                            val sessionState by sessionManager.state.collectAsState()
                            val coroutineScope = rememberCoroutineScope()

                            DisposableEffect(Unit) {
                                sessionManager.bind()
                                onDispose { sessionManager.unbind() }
                            }

                            when {
                                sessionState is SessionManager.SessionState.Connected -> {
                                    val bridge = (sessionState as SessionManager.SessionState.Connected).bridge
                                    ChatScreen(bridge)
                                }
                                sessionState is SessionManager.SessionState.Error -> {
                                    val error = (sessionState as SessionManager.SessionState.Error).message
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
                                                sessionManager.startSession(bootstrap)
                                            }
                                        }) {
                                            Text("Retry")
                                        }
                                    }
                                }
                                else -> {
                                    LaunchedEffect(Unit) {
                                        sessionManager.startSession(bootstrap)
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
}
