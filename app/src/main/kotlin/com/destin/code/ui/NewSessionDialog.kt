package com.destin.code.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.destin.code.config.WorkingDir
import java.io.File

data class NewSessionConfig(
    val cwd: File,
    val dangerousMode: Boolean,
)

@Composable
fun NewSessionDialog(
    knownDirs: List<Pair<String, File>>,
    homeDir: File,
    onDismiss: () -> Unit,
    onCreate: (NewSessionConfig) -> Unit,
    onAddDirectory: (File) -> Unit,
) {
    var selectedDir by remember { mutableStateOf(knownDirs.firstOrNull()?.second) }
    var dangerousMode by remember { mutableStateOf(false) }
    var showHomeBrowser by remember { mutableStateOf(false) }
    var showStorageBrowser by remember { mutableStateOf(false) }
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

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New Session", fontSize = 16.sp) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Working Directory:", fontSize = 13.sp)
                knownDirs.forEach { (label, dir) ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .selectable(
                                selected = selectedDir == dir,
                                onClick = { selectedDir = dir },
                                role = Role.RadioButton,
                            )
                            .padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = selectedDir == dir, onClick = null)
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(label, fontSize = 13.sp)
                    }
                }

                // Browse buttons
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    OutlinedButton(
                        onClick = { showHomeBrowser = true },
                        modifier = Modifier.weight(1f),
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
                    ) {
                        Text("Browse Storage", fontSize = 11.sp)
                    }
                }

                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.padding(top = 8.dp),
                ) {
                    Checkbox(checked = dangerousMode, onCheckedChange = { dangerousMode = it })
                    Spacer(modifier = Modifier.width(4.dp))
                    Text("Skip permissions", fontSize = 13.sp)
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    selectedDir?.let { dir ->
                        onCreate(NewSessionConfig(dir, dangerousMode))
                    }
                },
                shape = RoundedCornerShape(8.dp),
            ) { Text("Create") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}
