package com.destin.code

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
import com.destin.code.config.TierStore
import com.destin.code.runtime.Bootstrap
import com.destin.code.runtime.ServiceBinder
import com.destin.code.ui.ChatScreen
import com.destin.code.ui.SetupScreen
import com.destin.code.ui.TierPickerScreen
import com.destin.code.ui.theme.DestinCodeTheme
import com.destin.code.ui.theme.ThemeMode

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        enableEdgeToEdge()

        val bootstrap = Bootstrap(applicationContext)
        val tierStore = TierStore(applicationContext)

        setContent {
            var themeMode by remember { mutableStateOf(ThemeMode.DARK) }
            DestinCodeTheme(
                themeMode = themeMode,
                onSetThemeMode = { themeMode = it },
            ) {
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
                        // Check both core bootstrap AND tier satisfaction —
                        // if user upgraded tiers, we need to re-enter setup to install packages
                        bootstrap.packageTier = tierStore.selectedTier
                        var isReady by remember {
                            mutableStateOf(bootstrap.isBootstrapped && bootstrap.isTierSatisfied())
                        }
                        var progress by remember { mutableStateOf<Bootstrap.Progress?>(null) }

                        if (!isReady) {
                            // Track tier selection in Compose state (SharedPreferences
                            // writes are NOT observable by Compose — need a bridge)
                            var tierSelected by remember { mutableStateOf(tierStore.hasSelected) }

                            if (!tierSelected) {
                                // First run — show tier picker
                                TierPickerScreen(
                                    onConfirm = { tier ->
                                        tierStore.selectedTier = tier
                                        bootstrap.packageTier = tier
                                        tierSelected = true  // triggers recomposition
                                    },
                                )
                            } else {
                                // Tier selected — run bootstrap
                                // Set tier SYNCHRONOUSLY before setup() launches —
                                // LaunchedEffect would race with the setup() coroutine
                                bootstrap.packageTier = tierStore.selectedTier
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
                            }
                        } else {
                            // Boot self-test
                            val selfTestResult = remember(isReady) {
                                if (isReady) bootstrap.selfTest() else null
                            }

                            if (selfTestResult != null && !selfTestResult.passed) {
                                Column(
                                    modifier = Modifier.fillMaxSize().padding(32.dp),
                                    verticalArrangement = Arrangement.Center,
                                    horizontalAlignment = Alignment.CenterHorizontally,
                                ) {
                                    Text("Bootstrap Self-Test Failed", style = MaterialTheme.typography.titleLarge)
                                    Spacer(modifier = Modifier.height(16.dp))
                                    Text(selfTestResult.failureMessage ?: "Unknown failure", color = MaterialTheme.colorScheme.error)
                                    Spacer(modifier = Modifier.height(24.dp))
                                    Button(onClick = {
                                        isReady = false
                                        progress = null
                                    }) { Text("Re-extract") }
                                }
                                return@Column
                            }

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

                                    // Initialize bootstrap but don't auto-create sessions
                                    LaunchedEffect(svc) {
                                        svc.initBootstrap(bootstrap)
                                    }

                                    // Handle intent session_id from notification tap
                                    LaunchedEffect(Unit) {
                                        val targetSessionId = intent?.getStringExtra("session_id")
                                        if (targetSessionId != null) {
                                            svc.sessionRegistry.switchTo(targetSessionId)
                                            intent?.removeExtra("session_id")
                                        }
                                    }

                                    ChatScreen(svc)
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
                                    SetupScreen(Bootstrap.Progress.Installing("DestinCode session"))
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
