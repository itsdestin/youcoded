package com.destin.code.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import com.destin.code.ui.theme.CascadiaMono
import com.destin.code.ui.theme.DestinCodeTheme
import java.io.File

data class NewSessionConfig(
    val cwd: File,
    val dangerousMode: Boolean,
    val shellMode: Boolean = false,
)

@Composable
fun NewSessionDialog(
    knownDirs: List<Pair<String, File>>,
    homeDir: File,
    onDismiss: () -> Unit,
    onCreate: (NewSessionConfig) -> Unit,
    onAddDirectory: (File) -> Unit,
    centered: Boolean = false,
) {
    var selectedDir by remember { mutableStateOf(knownDirs.firstOrNull()?.second) }
    var dangerousMode by remember { mutableStateOf(false) }
    var shellMode by remember { mutableStateOf(false) }
    var showHomeBrowser by remember { mutableStateOf(false) }
    var showStorageBrowser by remember { mutableStateOf(false) }
    var showDirPicker by remember { mutableStateOf(false) }
    val context = LocalContext.current

    // Keep selectedDir in sync if knownDirs changes (after adding a directory)
    val latestDirs = knownDirs
    LaunchedEffect(latestDirs.size) {
        if (selectedDir == null || latestDirs.none { it.second == selectedDir }) {
            selectedDir = latestDirs.lastOrNull()?.second
        }
    }

    if (showHomeBrowser) {
        DirectoryBrowserDialog(
            root = homeDir,
            title = "Browse Home",
            onDismiss = { showHomeBrowser = false },
            onSelect = { dir ->
                showHomeBrowser = false
                onAddDirectory(dir)
                selectedDir = dir
            },
        )
    }

    if (showStorageBrowser) {
        DirectoryBrowserDialog(
            root = File("/storage/emulated/0"),
            title = "Browse Storage",
            pathPrefix = "/storage",
            onDismiss = { showStorageBrowser = false },
            onSelect = { dir ->
                showStorageBrowser = false
                onAddDirectory(dir)
                selectedDir = dir
            },
        )
    }

    val borderColor = DestinCodeTheme.extended.surfaceBorder

    val popupAlignment = if (centered) Alignment.Center else Alignment.TopCenter

    Popup(
        alignment = popupAlignment,
        onDismissRequest = onDismiss,
        properties = PopupProperties(focusable = true),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .clickable(
                    indication = null,
                    interactionSource = remember { MutableInteractionSource() },
                ) { onDismiss() },
            contentAlignment = popupAlignment,
        ) {
            Card(
                modifier = Modifier
                    .padding(top = 48.dp, start = 16.dp, end = 16.dp)
                    .widthIn(max = 340.dp)
                    .shadow(8.dp, RoundedCornerShape(12.dp))
                    .clickable(
                        indication = null,
                        interactionSource = remember { MutableInteractionSource() },
                    ) { /* consume clicks */ },
                shape = RoundedCornerShape(12.dp),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    // Title
                    Text(
                        "New Session",
                        fontSize = 16.sp,
                        fontFamily = CascadiaMono,
                        color = MaterialTheme.colorScheme.onSurface,
                        fontWeight = androidx.compose.ui.text.font.FontWeight.Bold,
                    )

                    // PROJECT FOLDER section (disabled in shell mode)
                    Column(
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                        modifier = Modifier.then(
                            if (shellMode) Modifier.alpha(0.4f) else Modifier
                        ),
                    ) {
                        Text(
                            "PROJECT FOLDER",
                            fontSize = 12.sp,
                            fontFamily = CascadiaMono,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
                            letterSpacing = 1.sp,
                        )
                        // Directory display pill — tap to pick
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(8.dp))
                                .background(MaterialTheme.colorScheme.surfaceVariant)
                                .border(
                                    0.5.dp,
                                    borderColor.copy(alpha = 0.5f),
                                    RoundedCornerShape(8.dp),
                                )
                                .then(if (!shellMode) Modifier.clickable { showDirPicker = !showDirPicker } else Modifier)
                                .padding(horizontal = 12.dp, vertical = 10.dp),
                        ) {
                            Text(
                                selectedDir?.absolutePath ?: "Select directory",
                                fontSize = 13.sp,
                                fontFamily = CascadiaMono,
                                color = MaterialTheme.colorScheme.onSurface,
                                maxLines = 1,
                            )
                        }

                        // Expandable directory picker
                        if (showDirPicker) {
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(8.dp))
                                    .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
                                    .padding(8.dp),
                                verticalArrangement = Arrangement.spacedBy(2.dp),
                            ) {
                                knownDirs.forEach { (label, dir) ->
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .clip(RoundedCornerShape(6.dp))
                                            .then(
                                                if (selectedDir == dir)
                                                    Modifier.background(
                                                        MaterialTheme.colorScheme.primary.copy(alpha = 0.15f)
                                                    )
                                                else Modifier
                                            )
                                            .clickable {
                                                selectedDir = dir
                                                showDirPicker = false
                                            }
                                            .padding(horizontal = 10.dp, vertical = 8.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Text(
                                            label,
                                            fontSize = 13.sp,
                                            fontFamily = CascadiaMono,
                                            color = MaterialTheme.colorScheme.onSurface,
                                        )
                                    }
                                }
                                // Browse buttons
                                Row(
                                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    OutlinedButton(
                                        onClick = { showHomeBrowser = true },
                                        modifier = Modifier.weight(1f),
                                        shape = RoundedCornerShape(6.dp),
                                    ) {
                                        Text("Browse Home", fontSize = 11.sp)
                                    }
                                    OutlinedButton(
                                        onClick = {
                                            val hasPermission = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
                                                android.os.Environment.isExternalStorageManager()
                                            } else {
                                                true
                                            }
                                            if (!hasPermission) {
                                                val intent = android.content.Intent(
                                                    android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION
                                                )
                                                context.startActivity(intent)
                                            } else {
                                                showStorageBrowser = true
                                            }
                                        },
                                        modifier = Modifier.weight(1f),
                                        shape = RoundedCornerShape(6.dp),
                                    ) {
                                        Text("Browse Storage", fontSize = 11.sp)
                                    }
                                }
                            }
                        }
                    }

                    // Toggle rows
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        // SKIP PERMISSIONS toggle (disabled in shell mode)
                        Row(
                            modifier = Modifier.fillMaxWidth().then(
                                if (shellMode) Modifier.alpha(0.4f) else Modifier
                            ),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(
                                "SKIP PERMISSIONS",
                                fontSize = 11.sp,
                                fontFamily = CascadiaMono,
                                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
                                letterSpacing = 1.sp,
                            )
                            Switch(
                                checked = dangerousMode && !shellMode,
                                onCheckedChange = { if (!shellMode) dangerousMode = it },
                                enabled = !shellMode,
                            )
                        }

                        // SHELL MODE toggle
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(
                                "SHELL MODE",
                                fontSize = 11.sp,
                                fontFamily = CascadiaMono,
                                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
                                letterSpacing = 1.sp,
                            )
                            Switch(
                                checked = shellMode,
                                onCheckedChange = { shellMode = it },
                            )
                        }
                    }

                    // Create Session button
                    Button(
                        onClick = {
                            selectedDir?.let { dir ->
                                onCreate(NewSessionConfig(dir, dangerousMode, shellMode))
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(8.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.surfaceVariant,
                            contentColor = MaterialTheme.colorScheme.onSurface,
                        ),
                    ) {
                        Text(
                            "Create Session",
                            fontSize = 14.sp,
                            fontFamily = CascadiaMono,
                            modifier = Modifier.padding(vertical = 4.dp),
                        )
                    }
                }
            }
        }
    }
}
