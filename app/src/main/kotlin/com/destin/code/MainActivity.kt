package com.destin.code

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import com.destin.code.config.TierStore
import com.destin.code.runtime.Bootstrap
import com.destin.code.runtime.ServiceBinder
import com.destin.code.ui.ChatScreen
import com.destin.code.ui.FolderPickerDialog
import com.destin.code.ui.QrScannerOverlay
import com.destin.code.ui.SetupScreen
import com.destin.code.ui.TierPickerScreen
import com.destin.code.ui.theme.AppTheme
import android.net.Uri
import android.widget.Toast
import java.io.File

class MainActivity : ComponentActivity() {

    /** File picker launcher — copies selected files to ~/attachments/ and completes the service deferred. */
    private val filePickerLauncher = registerForActivityResult(
        ActivityResultContracts.GetMultipleContents()
    ) { uris ->
        val deferred = boundService?.pendingFilePicker ?: return@registerForActivityResult
        if (uris.isEmpty()) {
            deferred.complete(emptyList())
            return@registerForActivityResult
        }
        // Copy files to ~/attachments/ on a background thread
        kotlinx.coroutines.MainScope().launch {
            val paths = withContext(Dispatchers.IO) {
                val homeDir = boundService?.bootstrap?.homeDir ?: filesDir
                val attachDir = File(homeDir, "attachments").also { it.mkdirs() }
                uris.mapNotNull { uri ->
                    try {
                        val timestamp = System.currentTimeMillis()
                        val mime = contentResolver.getType(uri)
                        val ext = when {
                            mime?.startsWith("image/png") == true -> "png"
                            mime?.startsWith("image/jpeg") == true -> "jpg"
                            mime?.startsWith("image/") == true -> mime.substringAfter("/")
                            else -> uri.lastPathSegment?.substringAfterLast('.', "bin") ?: "bin"
                        }
                        val destFile = File(attachDir, "$timestamp.$ext")
                        contentResolver.openInputStream(uri)?.use { input ->
                            destFile.outputStream().use { output -> input.copyTo(output) }
                        }
                        destFile.absolutePath
                    } catch (_: Exception) { null }
                }
            }
            deferred.complete(paths)
        }
    }

    private var boundService: com.destin.code.runtime.SessionService? = null

    /** Compose-observable state for showing the QR scanner overlay. */
    private val _showQrScanner = mutableStateOf(false)

    /** Compose-observable state for showing the folder picker dialog. */
    private val _showFolderPicker = mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Catch Termux TerminalBuffer crashes (row/column out of bounds during resize race).
        // These are internal Termux bugs triggered when PTY output arrives during a resize.
        // The terminal recovers on the next screen update — crashing the app is worse.
        enableEdgeToEdge()

        val bootstrap = Bootstrap(applicationContext)
        val tierStore = TierStore(applicationContext)

        setContent {
            AppTheme {
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

                                    // Initialize bootstrap and wire file picker + QR scanner
                                    LaunchedEffect(svc) {
                                        svc.initBootstrap(bootstrap)
                                        boundService = svc
                                        svc.onFilePickerRequested = {
                                            filePickerLauncher.launch("*/*")
                                        }
                                        svc.onFolderPickerRequested = {
                                            _showFolderPicker.value = true
                                        }
                                        svc.onQrScanRequested = {
                                            _showQrScanner.value = true
                                        }
                                    }

                                    // Handle intent session_id from notification tap
                                    LaunchedEffect(Unit) {
                                        val targetSessionId = intent?.getStringExtra("session_id")
                                        if (targetSessionId != null) {
                                            svc.sessionRegistry.switchTo(targetSessionId)
                                            intent?.removeExtra("session_id")
                                        }
                                        handleDeepLink(intent)
                                    }

                                    Box(modifier = Modifier.fillMaxSize()) {
                                        ChatScreen(svc)

                                        // Folder picker dialog
                                        if (_showFolderPicker.value) {
                                            FolderPickerDialog(
                                                startDir = bootstrap.homeDir,
                                                onSelect = { path ->
                                                    _showFolderPicker.value = false
                                                    boundService?.pendingFolderPicker?.complete(path)
                                                },
                                                onDismiss = {
                                                    _showFolderPicker.value = false
                                                    boundService?.pendingFolderPicker?.complete(null)
                                                },
                                            )
                                        }

                                        // QR scanner overlay — rendered on top of ChatScreen
                                        if (_showQrScanner.value) {
                                            QrScannerOverlay(
                                                onScanned = { url ->
                                                    _showQrScanner.value = false
                                                    boundService?.pendingQrScanner?.complete(url)
                                                },
                                                onDismiss = {
                                                    _showQrScanner.value = false
                                                    boundService?.pendingQrScanner?.complete(null)
                                                },
                                            )
                                        }
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
        handleDeepLink(intent)
    }

    private fun handleDeepLink(intent: Intent?) {
        val uri = intent?.data ?: return
        if (intent.action != Intent.ACTION_VIEW) return
        if (uri.scheme != "destincode") return
        val host = uri.host ?: return
        if (host != "skill" && host != "plugin") return

        val svc = boundService ?: return
        val provider = svc.skillProvider ?: return

        kotlinx.coroutines.MainScope().launch {
            try {
                // Preview the skill data without saving — show confirmation first
                val preview = withContext(Dispatchers.IO) {
                    provider.importFromLink(uri.toString(), confirm = false)
                }
                val name = preview.optString("displayName", "Skill")
                val author = preview.optString("author", "Unknown")

                android.app.AlertDialog.Builder(this@MainActivity)
                    .setTitle("Import Skill?")
                    .setMessage("\"$name\" by $author\n\nDo you want to install this skill?")
                    .setPositiveButton("Install") { _, _ ->
                        kotlinx.coroutines.MainScope().launch {
                            try {
                                val imported = withContext(Dispatchers.IO) {
                                    provider.importFromLink(uri.toString(), confirm = true)
                                }
                                val importedName = imported.optString("displayName", "Skill")
                                Toast.makeText(this@MainActivity, "Imported: $importedName", Toast.LENGTH_SHORT).show()
                            } catch (e: Exception) {
                                Toast.makeText(this@MainActivity, "Import failed: ${e.message}", Toast.LENGTH_SHORT).show()
                            }
                        }
                    }
                    .setNegativeButton("Cancel", null)
                    .show()
            } catch (e: Exception) {
                Toast.makeText(this@MainActivity, "Import failed: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
        // Clear the intent data so re-creation doesn't re-import
        intent?.data = null
    }
}
